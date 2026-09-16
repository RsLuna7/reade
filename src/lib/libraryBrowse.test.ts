import { describe, expect, it } from "vitest";
import type { CollectionItem, DocumentInfo } from "./backend";
import {
  ALL_LIBRARY_SCOPE,
  LIBRARY_COVER_SIZE_DEFAULT,
  LIBRARY_COVER_SIZE_MAX,
  LIBRARY_COVER_SIZE_MIN,
  clampLibraryCoverSize,
  collectScopedLibraryItems,
  filterLibraryBrowseItems,
  inferDocumentFormat,
  libraryCountLabel,
  libraryRangeTitle,
  libraryReadStatus,
  libraryStatusText,
  matchesLibraryTitleQuery,
  normalizeLibraryBrowseScope,
  sortLibraryBrowseItems,
  type LibraryBrowseItem,
} from "./libraryBrowse";
import type { ReadingPosition } from "./readingPositions";

function documentInfo(
  relativePath: string,
  overrides: Partial<DocumentInfo> = {},
): DocumentInfo {
  return {
    relativePath,
    title: "",
    size: 1,
    modified: 1,
    format: inferDocumentFormat(relativePath),
    indexStatus: "ready",
    indexError: null,
    ...overrides,
  };
}

function item(relativePath: string, present = true, position = 0): CollectionItem {
  return { relativePath, position, addedAt: 1, present };
}

describe("clampLibraryCoverSize", () => {
  it("clamps to the slider range and ignores non-numbers", () => {
    expect(clampLibraryCoverSize(170)).toBe(170);
    expect(clampLibraryCoverSize(LIBRARY_COVER_SIZE_MIN - 40)).toBe(LIBRARY_COVER_SIZE_MIN);
    expect(clampLibraryCoverSize(LIBRARY_COVER_SIZE_MAX + 80)).toBe(LIBRARY_COVER_SIZE_MAX);
    expect(clampLibraryCoverSize("wide")).toBe(LIBRARY_COVER_SIZE_DEFAULT);
    expect(clampLibraryCoverSize(Number.NaN, 150)).toBe(150);
  });
});

describe("libraryReadStatus", () => {
  const scroll = (ratio: number): ReadingPosition => ({
    kind: "scroll",
    scrollRatio: ratio,
    maxScrollRatio: ratio,
    updatedAt: 1,
  });

  it("treats a manual read mark as 已读 even without a position", () => {
    expect(libraryReadStatus(true, undefined, 10)).toBe("read");
    expect(libraryReadStatus(true, scroll(0.02), 10)).toBe("read");
  });

  it("does not treat end-of-document progress as 已读", () => {
    expect(libraryReadStatus(false, scroll(1), 10)).toBe("reading");
    expect(
      libraryReadStatus(false, { kind: "pdf", page: 10, offsetRatio: 0, maxPage: 10, updatedAt: 1 }, 10),
    ).toBe("reading");
  });

  it("keeps unread documents without a position as 未开始", () => {
    expect(libraryReadStatus(false, undefined)).toBe("new");
    expect(libraryReadStatus(false, scroll(0))).toBe("new");
  });

  it("does not invent a percentage when PDF page count is unknown", () => {
    const position: ReadingPosition = {
      kind: "pdf",
      page: 4,
      offsetRatio: 0,
      maxPage: 4,
      updatedAt: 1,
    };
    expect(libraryReadStatus(false, position, null)).toBe("reading");
    expect(libraryStatusText("reading", "第 4 页")).toBe("读到第 4 页");
  });
});

describe("collectScopedLibraryItems", () => {
  const docs = [
    documentInfo("认知/天性.epub", { title: "认知天性" }),
    documentInfo("技术/AI/手册.md", { title: "手册" }),
    documentInfo("技术/控制/笔记.md", { title: "笔记" }),
    documentInfo("设计/设计.md", { title: "设计" }),
  ];

  it("includes nested documents when the scope is a parent folder", () => {
    const items = collectScopedLibraryItems(docs, { kind: "folder", path: "技术" }, null);
    expect(items.map((entry) => entry.document.relativePath)).toEqual([
      "技术/AI/手册.md",
      "技术/控制/笔记.md",
    ]);
  });

  it("uses shelf membership order and keeps missing paths", () => {
    const shelf: CollectionItem[] = [
      item("设计/设计.md", true, 0),
      item("gone/lost.md", false, 1),
      item("认知/天性.epub", true, 2),
    ];
    const items = collectScopedLibraryItems(docs, { kind: "shelf", id: "s1" }, shelf);
    expect(items.map((entry) => entry.document.relativePath)).toEqual([
      "设计/设计.md",
      "gone/lost.md",
      "认知/天性.epub",
    ]);
    expect(items[1]?.present).toBe(false);
  });

  it("does not stack a leftover folder onto a shelf scope", () => {
    const shelf: CollectionItem[] = [item("设计/设计.md")];
    const items = collectScopedLibraryItems(docs, { kind: "shelf", id: "s1" }, shelf);
    expect(items).toHaveLength(1);
    expect(items[0]?.document.relativePath).toBe("设计/设计.md");
  });
});

describe("filter and sort library items", () => {
  const items: LibraryBrowseItem[] = [
    { document: documentInfo("a.md", { title: "阿尔法" }), present: true },
    { document: documentInfo("b.pdf", { title: "贝塔", format: "pdf" }), present: true },
    { document: documentInfo("c.epub", { title: "伽马", format: "epub" }), present: true },
  ];
  const positions: Record<string, ReadingPosition> = {
    "a.md": { kind: "scroll", scrollRatio: 0.2, maxScrollRatio: 0.2, updatedAt: 30 },
    "c.epub": { kind: "scroll", scrollRatio: 0.9, maxScrollRatio: 0.9, updatedAt: 10 },
  };

  it("searches titles without requiring body text", () => {
    expect(matchesLibraryTitleQuery("DeepSeek Harness 橙皮书", "harness")).toBe(true);
    expect(matchesLibraryTitleQuery("DeepSeek Harness 橙皮书", "正文里没有的词")).toBe(false);
    const filtered = filterLibraryBrowseItems(items, {
      titleQuery: "贝",
      format: "",
      status: "",
      readMarks: {},
      positions,
      segmentCount: () => 10,
    });
    expect(filtered.map((entry) => entry.document.title)).toEqual(["贝塔"]);
  });

  it("stacks format and reading-status on the current scope", () => {
    const filtered = filterLibraryBrowseItems(items, {
      titleQuery: "",
      format: "epub",
      status: "reading",
      readMarks: {},
      positions,
      segmentCount: () => 10,
    });
    expect(filtered.map((entry) => entry.document.relativePath)).toEqual(["c.epub"]);
  });

  it("keeps title/format/status independent of returning to the full catalog", () => {
    const scoped = collectScopedLibraryItems(
      items.map((entry) => entry.document),
      ALL_LIBRARY_SCOPE,
      null,
    );
    const filtered = filterLibraryBrowseItems(scoped, {
      titleQuery: "贝",
      format: "pdf",
      status: "new",
      readMarks: {},
      positions: {},
      segmentCount: () => null,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.document.relativePath).toBe("b.pdf");
  });

  it("sorts by recency, title, and reliable coverage without fabricating percents", () => {
    const recent = sortLibraryBrowseItems(items, {
      sort: "recent",
      positions,
      segmentCount: () => 10,
    });
    expect(recent.map((entry) => entry.document.relativePath)).toEqual(["a.md", "c.epub", "b.pdf"]);

    const titles = sortLibraryBrowseItems(items, {
      sort: "title",
      positions,
      segmentCount: () => 10,
    });
    expect(titles.map((entry) => entry.document.title)).toEqual(["阿尔法", "贝塔", "伽马"]);

    const progress = sortLibraryBrowseItems(items, {
      sort: "progress",
      positions,
      segmentCount: (path) => (path.endsWith(".pdf") ? null : 10),
    });
    expect(progress.map((entry) => entry.document.relativePath)).toEqual([
      "c.epub",
      "a.md",
      "b.pdf",
    ]);
  });
});

describe("library range copy", () => {
  it("names the current folder or shelf and reports filtered counts", () => {
    expect(libraryRangeTitle(ALL_LIBRARY_SCOPE, null, null)).toBe("全部图书");
    expect(
      libraryRangeTitle({ kind: "folder", path: "技术/AI" }, "技术 / AI", null),
    ).toBe("文件夹 / 技术 / AI");
    expect(libraryRangeTitle({ kind: "shelf", id: "s1" }, null, "最近想读")).toBe("最近想读");
    expect(libraryCountLabel(12, 12)).toBe("共 12 篇文档");
    expect(libraryCountLabel(8, 28)).toBe("显示 8 / 28 篇文档");
  });

  it("drops invalid persisted scopes instead of keeping a mixed folder+shelf", () => {
    expect(normalizeLibraryBrowseScope({ kind: "folder", path: "notes" })).toEqual({
      kind: "folder",
      path: "notes",
    });
    expect(normalizeLibraryBrowseScope({ kind: "shelf", id: "" })).toEqual(ALL_LIBRARY_SCOPE);
    expect(normalizeLibraryBrowseScope({ kind: "folder", path: "a", id: "s1" })).toEqual({
      kind: "folder",
      path: "a",
    });
  });
});
