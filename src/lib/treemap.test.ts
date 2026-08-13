import { describe, expect, it } from "vitest";
import type { DocumentExtent, DocumentInfo } from "./backend";
import type { ReadingPosition } from "./readingPositions";
import {
  buildCoverageTree,
  coverageLevel,
  limitTiles,
  squarify,
  worstAspectRatio,
  type CoverageNode,
  type PlacedTile,
  type TreemapRect,
} from "./treemap";

function documentInfo(relativePath: string, overrides: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    relativePath,
    title: "",
    size: 1000,
    modified: 1,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
    ...overrides,
  };
}

function extent(relativePath: string, charCount: number, segmentCount = 1): DocumentExtent {
  return { relativePath, charCount, segmentCount, needsOcrSegments: 0 };
}

function scrollPosition(maxScrollRatio: number): ReadingPosition {
  return { kind: "scroll", scrollRatio: maxScrollRatio, maxScrollRatio, updatedAt: 1 };
}

const items = (values: number[]) => values.map((chars, index) => ({ chars, id: index }));
const area = (tile: PlacedTile<unknown>) => tile.rect.width * tile.rect.height;

/** 对照基线:朴素 slice-and-dice(全部沿一个方向切条)。 */
function sliceAndDice<T extends { chars: number }>(
  input: readonly T[],
  rect: TreemapRect,
): PlacedTile<T>[] {
  const total = input.reduce((sum, item) => sum + item.chars, 0);
  if (total <= 0) return [];
  let offset = rect.x;
  return input.map((item) => {
    const width = (item.chars / total) * rect.width;
    const placed = { item, rect: { x: offset, y: rect.y, width, height: rect.height } };
    offset += width;
    return placed;
  });
}

describe("squarify (plan-coverage-treemap §3.2)", () => {
  const rect: TreemapRect = { x: 0, y: 0, width: 600, height: 400 };

  it("conserves total area and covers every positive item", () => {
    const input = items([6, 6, 4, 3, 2, 2, 1]);
    const tiles = squarify(input, rect);
    expect(tiles).toHaveLength(input.length);
    const totalArea = tiles.reduce((sum, tile) => sum + area(tile), 0);
    expect(totalArea).toBeCloseTo(rect.width * rect.height, 6);
    // 每块面积 ∝ 输入值。
    const unit = (rect.width * rect.height) / 24;
    for (const tile of tiles) {
      expect(area(tile)).toBeCloseTo((tile.item as { chars: number }).chars * unit, 6);
    }
  });

  it("is deterministic and keeps tiles inside the rect", () => {
    const input = items([9, 8, 7, 5, 4, 2, 1, 1]);
    const first = squarify(input, rect);
    const second = squarify(input, rect);
    expect(second).toEqual(first);
    for (const tile of first) {
      expect(tile.rect.x).toBeGreaterThanOrEqual(rect.x - 1e-6);
      expect(tile.rect.y).toBeGreaterThanOrEqual(rect.y - 1e-6);
      expect(tile.rect.x + tile.rect.width).toBeLessThanOrEqual(rect.x + rect.width + 1e-6);
      expect(tile.rect.y + tile.rect.height).toBeLessThanOrEqual(rect.y + rect.height + 1e-6);
    }
  });

  it("beats naive slice-and-dice on the classic Bruls dataset", () => {
    // Bruls 论文示例数据:6,6,4,3,2,2,1 in 6:4 矩形。
    const input = items([6, 6, 4, 3, 2, 2, 1]);
    const squarified = worstAspectRatio(squarify(input, rect));
    const naive = worstAspectRatio(sliceAndDice(input, rect));
    // 数值记录:squarified ~2.5,slice-and-dice ~16.3。
    expect(squarified).toBeLessThan(3);
    expect(naive).toBeGreaterThan(10);
    expect(squarified).toBeLessThan(naive);
  });

  it("handles single, empty and non-positive inputs", () => {
    const single = squarify(items([5]), rect);
    expect(single).toHaveLength(1);
    expect(single[0].rect).toEqual({ x: 0, y: 0, width: 600, height: 400 });
    expect(squarify([], rect)).toEqual([]);
    expect(squarify(items([0, -3, Number.NaN]), rect)).toEqual([]);
    expect(squarify(items([1, 2]), { x: 0, y: 0, width: 0, height: 100 })).toEqual([]);
  });

  it("keeps extreme value ratios inside the rect without degenerate tiles", () => {
    const tiles = squarify(items([100_000, 1]), rect);
    expect(tiles).toHaveLength(2);
    for (const tile of tiles) {
      expect(tile.rect.width).toBeGreaterThan(0);
      expect(tile.rect.height).toBeGreaterThan(0);
    }
  });
});

describe("buildCoverageTree", () => {
  it("aggregates folder chars as sums and coverage as char-weighted means", () => {
    const documents = [
      documentInfo("正文/a.md"),
      documentInfo("正文/b.md"),
      documentInfo("root.md"),
    ];
    const extents = new Map([
      ["正文/a.md", extent("正文/a.md", 3000)],
      ["正文/b.md", extent("正文/b.md", 1000)],
      ["root.md", extent("root.md", 2000)],
    ]);
    const positions: Record<string, ReadingPosition> = {
      "正文/a.md": scrollPosition(1),
      "正文/b.md": scrollPosition(0.2),
    };
    const root = buildCoverageTree(documents, extents, positions);

    expect(root.chars).toBe(6000);
    expect(root.documentCount).toBe(3);
    const folder = root.children.find((child) => child.kind === "directory");
    expect(folder).toMatchObject({ label: "正文", chars: 4000, documentCount: 2 });
    // (1×3000 + 0.2×1000) / 4000 = 0.8
    expect(folder!.coverage).toBeCloseTo(0.8, 6);
    // root.md 无 position → 覆盖率 0;全库 = 3200/6000。
    expect(root.coverage).toBeCloseTo(3200 / 6000, 6);
  });

  it("converts pdf coverage via page count and falls back to size without extents", () => {
    const documents = [
      documentInfo("book.pdf", { format: "pdf", size: 5000 }),
      documentInfo("pending.md", { size: 700, indexStatus: "pending" }),
    ];
    const extents = new Map([["book.pdf", extent("book.pdf", 10_000, 20)]]);
    const positions: Record<string, ReadingPosition> = {
      "book.pdf": { kind: "pdf", page: 5, offsetRatio: 0, maxPage: 10, updatedAt: 1 },
    };
    const root = buildCoverageTree(documents, extents, positions);

    const pdf = root.children.find((child) => child.path === "book.pdf");
    expect(pdf).toMatchObject({ chars: 10_000 });
    expect(pdf!.coverage).toBeCloseTo(0.5, 6);
    // 索引未就绪的文档按 size 字节兜底(CT-D1)。
    const pending = root.children.find((child) => child.path === "pending.md");
    expect(pending).toMatchObject({ chars: 700, coverage: 0 });
  });

  it("handles an empty library", () => {
    const root = buildCoverageTree([], null, {});
    expect(root.children).toEqual([]);
    expect(root.chars).toBe(0);
    expect(root.coverage).toBe(0);
  });
});

describe("limitTiles", () => {
  const node = (key: string, chars: number, coverage = 0): CoverageNode => ({
    kind: "document",
    key,
    label: key,
    path: key,
    chars,
    coverage,
    documentCount: 1,
    children: [],
  });

  it("keeps small levels untouched", () => {
    const children = [node("a", 3), node("b", 2)];
    expect(limitTiles(children, 400)).toBe(children);
  });

  it("aggregates the tail into an inert other bucket", () => {
    const children = Array.from({ length: 10 }, (_, index) =>
      node(`n${index}`, 10 - index, index % 2),
    );
    const limited = limitTiles(children, 4);
    expect(limited).toHaveLength(4);
    const other = limited[limited.length - 1];
    expect(other.kind).toBe("other");
    expect(other.label).toBe("其他 7 项");
    expect(other.documentCount).toBe(7);
    // 面积守恒:保留块 + 其他 = 全量。
    const total = children.reduce((sum, child) => sum + child.chars, 0);
    expect(limited.reduce((sum, child) => sum + child.chars, 0)).toBe(total);
  });
});

describe("coverageLevel (CT-D4)", () => {
  it("maps coverage onto the five heatmap steps", () => {
    expect(coverageLevel(0)).toBe(0);
    expect(coverageLevel(-1)).toBe(0);
    expect(coverageLevel(0.01)).toBe(1);
    expect(coverageLevel(0.25)).toBe(1);
    expect(coverageLevel(0.3)).toBe(2);
    expect(coverageLevel(0.6)).toBe(3);
    expect(coverageLevel(0.8)).toBe(4);
    expect(coverageLevel(1)).toBe(4);
    expect(coverageLevel(1.5)).toBe(4);
  });
});
