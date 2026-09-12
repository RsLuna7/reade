// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPdfZoomPreview, PDF_PREVIEW_MAX_PIXELS, previewCoversViewport, previewPixelRatio } from "./pdfZoomPreview";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("bounded PDF bitmap preview", () => {
  it("rejects shrinking beyond coverage, including an off-center origin", () => {
    const capture = { left: -100, right: 200, top: -100, bottom: 200 };
    const viewport = { left: 0, right: 100, top: 0, bottom: 100 };
    expect(previewCoversViewport(capture, viewport, { x: 50, y: 50 }, 0.5)).toBe(true);
    expect(previewCoversViewport(capture, viewport, { x: 0, y: 0 }, 0.4)).toBe(false);
    expect(previewCoversViewport(capture, viewport, { x: 50, y: 50 }, 3)).toBe(true);
    expect(previewCoversViewport(capture, viewport, { x: 50, y: 50 }, NaN)).toBe(false);
  });

  it("caps snapshot allocation even on very large high-DPI windows", () => {
    for (const [w,h,dpr] of [[1000,2000,1], [7680,12960,3], [2000,3000,2]]) {
      const ratio = previewPixelRatio(w,h,dpr);
      expect(Math.floor(w*ratio)*Math.floor(h*ratio)).toBeLessThanOrEqual(PDF_PREVIEW_MAX_PIXELS);
      expect(ratio).toBeLessThanOrEqual(1.5);
    }
    expect(previewPixelRatio(0,500,2)).toBe(0);
    expect(previewPixelRatio(Infinity,500,2)).toBe(0);
  });

  function fixture(rendered = true) {
    const scroller = document.createElement("div");
    const pages = document.createElement("div");
    const page = document.createElement("section");
    const canvas = document.createElement("canvas");
    page.className = "pdf-page";
    if (rendered) canvas.dataset.pdfRendered = "true";
    page.append(canvas); pages.append(page); scroller.append(pages); document.body.append(scroller);
    Object.defineProperties(scroller, { clientWidth: { value: 600 }, clientHeight: { value: 800 },
      scrollHeight: { value: 800 }, scrollWidth: { value: 600 } });
    vi.spyOn(scroller,"getBoundingClientRect").mockReturnValue(new DOMRect(0,0,600,800));
    vi.spyOn(pages,"getBoundingClientRect").mockReturnValue(new DOMRect(0,0,600,800));
    vi.spyOn(page,"getBoundingClientRect").mockReturnValue(new DOMRect(0,0,600,800));
    vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({
      scale: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    return {scroller,pages,page};
  }

  it("transforms only the snapshot, leaves layout untouched and releases it idempotently", () => {
    const {scroller,pages} = fixture();
    const preview = createPdfZoomPreview(pages,scroller,null,300)!;
    expect(preview).not.toBeNull();
    const bitmap = document.querySelector<HTMLCanvasElement>(".pdf-zoom-bitmap-overlay canvas")!;
    expect(preview.paint(1.2)).toBe(true);
    expect(bitmap.style.transform).toContain("scale(1.2)");
    expect(pages.style.getPropertyValue("--pdf-live-page-width")).toBe("");
    expect(pages.dataset.bitmapPreview).toBe("true");
    expect(preview.paint(0.1)).toBe(false);
    preview.dispose(); preview.dispose();
    expect(document.querySelector(".pdf-zoom-bitmap-overlay")).toBeNull();
    expect(pages.dataset.bitmapPreview).toBeUndefined();
    expect(pages.dataset.zoomPreview).toBeUndefined();
    expect(bitmap.width * bitmap.height).toBe(0);
    expect(preview.paint(1)).toBe(false);
  });

  it("falls back if a visible page has not rendered, without hiding the document", () => {
    const {scroller,pages} = fixture(false);
    expect(createPdfZoomPreview(pages,scroller,null)).toBeNull();
    expect(pages.dataset.bitmapPreview).toBeUndefined();
  });

  it("keeps the document top fixed when shrinking at scrollTop zero", () => {
    const {scroller,pages} = fixture();
    const preview = createPdfZoomPreview(pages,scroller,null,300)!;
    expect(preview.paint(0.9)).toBe(true);
    const transform = document.querySelector<HTMLCanvasElement>(".pdf-zoom-bitmap-overlay canvas")!.style.transform;
    const dy = Number(/translate\([^,]+, ([^)]+)px\)/.exec(transform)![1]);
    expect(300 + (0 - 300) * 0.9 + dy).toBeCloseTo(0);
    preview.dispose();
  });

  it("replaces a previous snapshot for the same page stack without leaving a stuck overlay", () => {
    const {scroller,pages} = fixture();
    const first = createPdfZoomPreview(pages,scroller,null,300)!;
    const second = createPdfZoomPreview(pages,scroller,null,300)!;
    expect(document.querySelectorAll(".pdf-zoom-bitmap-overlay")).toHaveLength(1);
    first.dispose();
    expect(document.querySelectorAll(".pdf-zoom-bitmap-overlay")).toHaveLength(1);
    expect(pages.dataset.bitmapPreview).toBe("true");
    expect(second.paint(1.1)).toBe(true);
    second.dispose();
    expect(document.querySelectorAll(".pdf-zoom-bitmap-overlay")).toHaveLength(0);
    expect(pages.dataset.bitmapPreview).toBeUndefined();
  });
});
