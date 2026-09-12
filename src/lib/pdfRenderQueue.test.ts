import { describe, expect, it } from "vitest";
import { PdfRenderQueue, pdfRasterPixelRatio } from "./pdfRenderQueue";

describe("PDF render scheduling", () => {
  it("chooses visible priority first and serializes page work", async () => {
    const queue = new PdfRenderQueue();
    const signal = new AbortController().signal;
    const order: string[] = [];
    let finish!: () => void;
    const far = queue.run(async () => { order.push("far"); }, () => 100, signal);
    const near = queue.run(async () => {
      order.push("visible");
      await new Promise<void>(resolve => { finish = resolve; });
    }, () => -100, signal);
    await new Promise(resolve => setTimeout(resolve,0));
    expect(order).toEqual(["visible"]);
    finish();
    await Promise.all([near,far]);
    expect(order).toEqual(["visible","far"]);
  });

  it("drops stale jobs and unblocks the queue even while an old getPage is pending", async () => {
    const queue = new PdfRenderQueue();
    const old = new AbortController();
    const queued = new AbortController();
    let calls = 0;
    const first = queue.run(() => new Promise<void>(() => {}), () => 0, old.signal).catch(e => e.name);
    await new Promise(resolve => setTimeout(resolve,0));
    const stale = queue.run(async () => { calls++; }, () => 1, queued.signal).catch(e => e.name);
    queued.abort(); old.abort();
    await queue.run(async () => { calls++; }, () => 2, new AbortController().signal);
    expect(await first).toBe("AbortError");
    expect(await stale).toBe("AbortError");
    expect(calls).toBe(1);
  });

  it("caps large page bitmaps without changing normal page density", () => {
    expect(pdfRasterPixelRatio(600,800,2)).toBe(2);
    for (const [w,h] of [[4000,6000],[100000,100]]) {
      const ratio = pdfRasterPixelRatio(w,h,3);
      expect(Math.floor(w*ratio)*Math.floor(h*ratio)).toBeLessThanOrEqual(8*1024*1024);
      expect(Math.max(w,h)*ratio).toBeLessThanOrEqual(8192);
    }
  });
});
