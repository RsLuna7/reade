import { describe, expect, it } from "vitest";
import type { EpubAsset } from "./backend";
import {
  COVER_PALETTES,
  fnv1aHash,
  generatedCover,
  pickEpubCoverAsset,
  pngBase64FromDataUrl,
  shelfProgressLabel,
  THUMBNAIL_MAX_DIMENSION,
  THUMBNAIL_MAX_PNG_BYTES,
  thumbnailDimensions,
} from "./coverArt";

describe("generatedCover (plan-bookshelf-covers §3.3)", () => {
  it("is deterministic: the same title always yields the same cover", () => {
    const first = generatedCover("深入理解计算机系统");
    const second = generatedCover("深入理解计算机系统");
    expect(second).toEqual(first);
  });

  it("normalizes whitespace and derives the initial from the first character", () => {
    expect(generatedCover("  设计模式  ")).toEqual(generatedCover("设计模式"));
    expect(generatedCover("设计模式").initial).toBe("设");
    expect(generatedCover("clean code").initial).toBe("C");
    expect(generatedCover("").initial).toBe("□");
  });

  it("only emits palette entries and theme-token colors", () => {
    const titles = ["a", "b", "第三篇", "guide", "第五章", "附录", "读书笔记", "🦀 rust"];
    for (const title of titles) {
      const cover = generatedCover(title);
      expect(cover.paletteIndex).toBeGreaterThanOrEqual(0);
      expect(cover.paletteIndex).toBeLessThan(COVER_PALETTES.length);
      expect(cover.from).toContain("var(--");
      expect(cover.to).toContain("var(--");
    }
  });

  it("spreads different titles across more than one palette", () => {
    const indices = new Set(
      Array.from({ length: 40 }, (_, index) => generatedCover(`标题-${index}`).paletteIndex),
    );
    expect(indices.size).toBeGreaterThan(3);
  });

  it("fnv1a matches the reference vectors", () => {
    // 参考向量:FNV-1a 32 位标准测试值。
    expect(fnv1aHash("")).toBe(0x811c9dc5);
    expect(fnv1aHash("a")).toBe(0xe40c292c);
  });
});

describe("pickEpubCoverAsset (BC-D3)", () => {
  const asset = (id: number, alt: string, allowed = true): EpubAsset => ({
    id,
    mediaType: "image/jpeg",
    allowed,
    alt,
  });

  it("prefers an allowed asset whose path mentions cover", () => {
    const picked = pickEpubCoverAsset([
      asset(0, "OPS/images/logo.jpg"),
      asset(1, "OPS/images/Cover-front.jpg"),
    ]);
    expect(picked?.id).toBe(1);
  });

  it("falls back to the first allowed asset, skipping blocked ones", () => {
    const picked = pickEpubCoverAsset([
      asset(0, "OPS/evil.svg", false),
      asset(1, "OPS/plate-1.jpg"),
    ]);
    expect(picked?.id).toBe(1);
  });

  it("returns null when no allowed raster exists", () => {
    expect(pickEpubCoverAsset([])).toBeNull();
    expect(pickEpubCoverAsset([asset(0, "cover.svg", false)])).toBeNull();
  });
});

describe("thumbnailDimensions", () => {
  it("fits a portrait page into the 2x target box, keeping aspect", () => {
    const dims = thumbnailDimensions(595, 842, 2);
    expect(dims).not.toBeNull();
    expect(dims!.width).toBeLessThanOrEqual(480);
    expect(dims!.height).toBeLessThanOrEqual(640);
    expect(dims!.width / dims!.height).toBeCloseTo(595 / 842, 1);
  });

  it("never upscales small sources and clamps to the hard limit", () => {
    expect(thumbnailDimensions(100, 150, 2)).toEqual({ width: 100, height: 150 });
    const wide = thumbnailDimensions(4000, 100, 2);
    expect(wide!.width).toBeLessThanOrEqual(THUMBNAIL_MAX_DIMENSION);
  });

  it("rejects degenerate sizes", () => {
    expect(thumbnailDimensions(0, 100)).toBeNull();
    expect(thumbnailDimensions(100, Number.NaN)).toBeNull();
  });
});

describe("pngBase64FromDataUrl", () => {
  it("strips the PNG data-url prefix", () => {
    expect(pngBase64FromDataUrl("data:image/png;base64,QUJD")).toBe("QUJD");
  });

  it("rejects non-PNG payloads and oversized data", () => {
    expect(pngBase64FromDataUrl("data:image/jpeg;base64,QUJD")).toBeNull();
    expect(pngBase64FromDataUrl("data:image/png;base64,")).toBeNull();
    const oversized = "A".repeat(Math.ceil((THUMBNAIL_MAX_PNG_BYTES * 4) / 3) + 8);
    expect(pngBase64FromDataUrl(`data:image/png;base64,${oversized}`)).toBeNull();
  });
});

describe("shelfProgressLabel", () => {
  it("shows the scroll high-water percentage, hiding <1%", () => {
    expect(
      shelfProgressLabel({ kind: "scroll", scrollRatio: 0.2, maxScrollRatio: 0.42, updatedAt: 1 }),
    ).toBe("42%");
    expect(
      shelfProgressLabel({ kind: "scroll", scrollRatio: 0, maxScrollRatio: 0.004, updatedAt: 1 }),
    ).toBeNull();
  });

  it("converts pdf pages via segmentCount, falling back to the raw page", () => {
    const position = { kind: "pdf" as const, page: 3, offsetRatio: 0, maxPage: 5, updatedAt: 1 };
    expect(shelfProgressLabel(position, 10)).toBe("50%");
    expect(shelfProgressLabel(position, null)).toBe("第 5 页");
    expect(shelfProgressLabel(position, 4)).toBe("100%");
  });

  it("returns 已阅 when the document was marked read", () => {
    expect(
      shelfProgressLabel(
        { kind: "scroll", scrollRatio: 0.2, maxScrollRatio: 0.42, updatedAt: 1 },
        null,
        true,
      ),
    ).toBe("已阅");
    expect(shelfProgressLabel(null, null, true)).toBe("已阅");
  });

  it("returns null without a position", () => {
    expect(shelfProgressLabel(null)).toBeNull();
    expect(shelfProgressLabel(undefined, 12)).toBeNull();
  });
});
