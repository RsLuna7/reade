// @vitest-environment jsdom

import "../test/setup";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMarkdownImageAssets } from "./useMarkdownImageAssets";

const { readAssetMock } = vi.hoisted(() => ({ readAssetMock: vi.fn() }));

vi.mock("./backend", () => ({
  readAsset: readAssetMock,
  assetDataUrl: (asset: { mimeType: string; data: string }) =>
    `data:${asset.mimeType};base64,${asset.data}`,
}));

const PNG = { mimeType: "image/png", data: "AAAA" };

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    // 多轮刷新：并行负载下单个 90ms 定时可能不够异步链（读取→消毒→
    // 批量写回）完成；轮询多轮避免偶发 undefined 断言失败。
    for (let round = 0; round < 8; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
}

describe("useMarkdownImageAssets", () => {
  it("dedupes concurrent loads and batches writes into one flush", async () => {
    readAssetMock.mockResolvedValue(PNG);
    const { result } = renderHook(() => useMarkdownImageAssets());

    act(() => {
      result.current.load("doc.md", "./a.png");
      result.current.load("doc.md", "./a.png");
      result.current.load("doc.md", "./b.png");
    });
    await flushAsyncWork();

    expect(readAssetMock).toHaveBeenCalledTimes(2);
    expect(result.current.assetUrls).toEqual({
      "./a.png": "data:image/png;base64,AAAA",
      "./b.png": "data:image/png;base64,AAAA",
    });
    expect(result.current.imageErrors).toEqual({});
  });

  it("records readable failure reasons instead of failing silently", async () => {
    readAssetMock.mockRejectedValue("Asset is too large (99999999 bytes; maximum is 26214400)");
    const { result } = renderHook(() => useMarkdownImageAssets());

    act(() => {
      result.current.load("doc.md", "./big.png");
    });
    await flushAsyncWork();

    expect(result.current.assetUrls).toEqual({});
    expect(result.current.imageErrors["./big.png"]).toBe("文件超过 25 MiB 上限");
  });

  it("drops in-flight writes when the generation resets (document switch)", async () => {
    let release!: (asset: { mimeType: string; data: string }) => void;
    readAssetMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { result } = renderHook(() => useMarkdownImageAssets());

    act(() => {
      result.current.load("old.md", "./a.png");
    });
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      release(PNG);
      await Promise.resolve();
    });
    await flushAsyncWork();

    expect(result.current.assetUrls).toEqual({});
  });

  it("sanitizes library SVG files and exposes them as inline markup, not data URLs", async () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><circle r="4"/></svg>`;
    readAssetMock.mockResolvedValue({ mimeType: "image/svg+xml", data: btoa(dirty) });
    const { result } = renderHook(() => useMarkdownImageAssets());

    act(() => {
      result.current.load("doc.md", "./vector.svg");
    });
    await flushAsyncWork();

    const markup = result.current.svgAssets["./vector.svg"];
    expect(markup).toContain("<circle");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("onload");
    expect(result.current.assetUrls).toEqual({});
    expect(result.current.imageErrors).toEqual({});
  });

  it("records a readable error when an SVG fails sanitization", async () => {
    readAssetMock.mockResolvedValue({ mimeType: "image/svg+xml", data: btoa("not an svg") });
    const { result } = renderHook(() => useMarkdownImageAssets());

    act(() => {
      result.current.load("doc.md", "./broken.svg");
    });
    await flushAsyncWork();

    expect(result.current.svgAssets).toEqual({});
    expect(result.current.imageErrors["./broken.svg"]).toBe("SVG 内容未通过安全检查");
  });
});

describe("image request generations and concurrency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readAssetMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("drops a failed read from the previous document", async () => {
    let reject!: (cause: unknown) => void;
    readAssetMock.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const { result } = renderHook(() => useMarkdownImageAssets());
    act(() => result.current.load("old.md", "./cover.png"));
    act(() => result.current.reset());
    await act(async () => reject(new Error("old image failed")));
    expect(result.current.imageErrors).toEqual({});
    expect(result.current.assetUrls).toEqual({});
  });

  it("does not schedule state writes after unmount or start queued reads", async () => {
    const releases: Array<() => void> = [];
    readAssetMock.mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve(PNG)); }));
    const { result, unmount } = renderHook(() => useMarkdownImageAssets());
    act(() => {
      for (let i = 0; i < 8; i += 1) result.current.load("old.md", `./${i}.png`);
    });
    expect(readAssetMock).toHaveBeenCalledTimes(4);
    unmount();
    await act(async () => releases.forEach((release) => release()));
    expect(readAssetMock).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits IPC reads to four, deduplicates queued images, and drains after failures", async () => {
    const releases: Array<(fail?: boolean) => void> = [];
    let active = 0;
    let maxActive = 0;
    readAssetMock.mockImplementation(() => new Promise((resolve, reject) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      releases.push((fail) => {
        active -= 1;
        if (fail) reject(new Error("unavailable"));
        else resolve(PNG);
      });
    }));
    const { result } = renderHook(() => useMarkdownImageAssets());
    act(() => {
      for (let i = 0; i < 10; i += 1) result.current.load("doc.md", `./${i}.png`);
      result.current.load("doc.md", "./9.png");
    });
    expect(readAssetMock).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 10; i += 1) {
      await act(async () => releases[i](i === 0));
    }
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(readAssetMock).toHaveBeenCalledTimes(10);
    expect(maxActive).toBe(4);
    expect(Object.keys(result.current.assetUrls)).toHaveLength(9);
    expect(result.current.imageErrors["./0.png"]).toBeTruthy();
  });

  it("discards an old queue but lets the new document use slots as old reads finish", async () => {
    const releases: Array<() => void> = [];
    readAssetMock.mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve(PNG)); }));
    const { result } = renderHook(() => useMarkdownImageAssets());
    act(() => {
      for (let i = 0; i < 8; i += 1) result.current.load("old/doc.md", `./${i}.png`);
      result.current.reset();
      result.current.load("new/doc.md", "./cover.png");
    });
    expect(readAssetMock).toHaveBeenCalledTimes(4);
    await act(async () => releases[0]());
    expect(readAssetMock).toHaveBeenLastCalledWith("new/cover.png");
    await act(async () => releases.slice(1).forEach((release) => release()));
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(readAssetMock).toHaveBeenCalledTimes(5);
    expect(result.current.assetUrls).toEqual({ "./cover.png": "data:image/png;base64,AAAA" });
  });
});
