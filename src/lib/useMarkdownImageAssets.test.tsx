// @vitest-environment jsdom

import "../test/setup";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
