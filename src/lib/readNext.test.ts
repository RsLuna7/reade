import { describe, expect, it, vi } from "vitest";
import type {
  CollectionItem,
  CollectionSummary,
  DocumentExtent,
  DocumentInfo,
  DocumentLinks,
} from "./backend";
import type { ReadingPosition } from "./readingPositions";
import {
  pickByBacklinks,
  pickNextInCollection,
  pickNextInFolder,
  resolveReadNextSuggestion,
  shouldTriggerReadNext,
} from "./readNext";

function doc(relativePath: string, title = ""): DocumentInfo {
  return {
    relativePath,
    title,
    size: 100,
    modified: 1,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
  };
}

function item(relativePath: string, present = true, position = 0): CollectionItem {
  return { relativePath, position, addedAt: 1, present };
}

function scrollPosition(maxScrollRatio: number): ReadingPosition {
  return { kind: "scroll", scrollRatio: maxScrollRatio, maxScrollRatio, updatedAt: 1 };
}

function emptyLinks(): DocumentLinks {
  return { backlinks: [], outgoing: [], brokenCount: 0 };
}

describe("shouldTriggerReadNext (RN-D2)", () => {
  it("requires both the sentinel and the 0.98 high-water ratio", () => {
    expect(shouldTriggerReadNext(true, 0.99)).toBe(true);
    expect(shouldTriggerReadNext(true, 0.5)).toBe(false);
    expect(shouldTriggerReadNext(false, 1)).toBe(false);
  });
});

describe("pickNextInCollection", () => {
  it("returns the next present item and skips missing ones", () => {
    const items = [item("a.md"), item("b.md", false), item("c.md")];
    expect(pickNextInCollection(items, "a.md")).toBe("c.md");
  });

  it("does not wrap at the end of the collection", () => {
    const items = [item("a.md"), item("b.md")];
    expect(pickNextInCollection(items, "b.md")).toBeNull();
    expect(pickNextInCollection(items, "a.md")).toBe("b.md");
  });

  it("returns null when the current document is not in the list", () => {
    expect(pickNextInCollection([item("a.md")], "x.md")).toBeNull();
  });
});

describe("pickNextInFolder", () => {
  it("uses tree-order (numeric collator on display names) within the folder", () => {
    const documents = [
      doc("notes/第10章.md", "第10章"),
      doc("notes/第2章.md", "第2章"),
      doc("notes/第1章.md", "第1章"),
      doc("other/独立.md", "独立"),
    ];
    expect(pickNextInFolder(documents, "notes/第1章.md")).toBe("notes/第2章.md");
    expect(pickNextInFolder(documents, "notes/第2章.md")).toBe("notes/第10章.md");
  });

  it("stops at the last sibling instead of jumping across folders", () => {
    const documents = [
      doc("notes/a.md", "a"),
      doc("notes/b.md", "b"),
      doc("zother/c.md", "c"),
    ];
    expect(pickNextInFolder(documents, "notes/b.md")).toBeNull();
  });

  it("treats root-level documents as one folder", () => {
    const documents = [doc("a.md", "甲"), doc("b.md", "乙"), doc("sub/c.md", "丙")];
    expect(pickNextInFolder(documents, "a.md")).toBe("b.md");
    expect(pickNextInFolder(documents, "b.md")).toBeNull();
  });

  it("returns null for an unknown current document", () => {
    expect(pickNextInFolder([doc("a.md")], "gone.md")).toBeNull();
  });
});

describe("pickByBacklinks", () => {
  const documents = [doc("cur.md"), doc("a.md"), doc("b.md"), doc("c.md")];

  it("prefers the neighbour with the highest link weight", () => {
    const links: DocumentLinks = {
      backlinks: [
        { sourcePath: "a.md", sourceTitle: "a", linkText: "x", count: 3 },
        { sourcePath: "b.md", sourceTitle: "b", linkText: "x", count: 1 },
      ],
      outgoing: [],
      brokenCount: 0,
    };
    expect(
      pickByBacklinks(links, "cur.md", { documents, positions: {}, extents: null }),
    ).toBe("a.md");
  });

  it("adds outgoing document targets and breaks ties by path collation", () => {
    const links: DocumentLinks = {
      backlinks: [{ sourcePath: "b.md", sourceTitle: "b", linkText: "x", count: 1 }],
      outgoing: [
        {
          kind: "document",
          targetPath: "a.md",
          rawTarget: "a.md",
          linkText: "x",
          present: true,
          ambiguousCount: 0,
        },
      ],
      brokenCount: 0,
    };
    expect(
      pickByBacklinks(links, "cur.md", { documents, positions: {}, extents: null }),
    ).toBe("a.md");
  });

  it("skips finished neighbours (coverage ≥ 0.98) and asset links", () => {
    const links: DocumentLinks = {
      backlinks: [
        { sourcePath: "a.md", sourceTitle: "a", linkText: "x", count: 5 },
        { sourcePath: "b.md", sourceTitle: "b", linkText: "x", count: 2 },
      ],
      outgoing: [
        {
          kind: "asset",
          targetPath: "c.md",
          rawTarget: "c.md",
          linkText: "img",
          present: true,
          ambiguousCount: 0,
        },
      ],
      brokenCount: 0,
    };
    expect(
      pickByBacklinks(links, "cur.md", {
        documents,
        positions: { "a.md": scrollPosition(1) },
        extents: null,
      }),
    ).toBe("b.md");
  });

  it("ignores neighbours that are no longer in the library and the current doc", () => {
    const links: DocumentLinks = {
      backlinks: [
        { sourcePath: "gone.md", sourceTitle: "gone", linkText: "x", count: 9 },
        { sourcePath: "cur.md", sourceTitle: "self", linkText: "x", count: 9 },
      ],
      outgoing: [],
      brokenCount: 0,
    };
    expect(
      pickByBacklinks(links, "cur.md", { documents, positions: {}, extents: null }),
    ).toBeNull();
  });

  it("uses page-based coverage for pdf neighbours via extents", () => {
    const pdfDocuments = [doc("cur.md"), doc("book.pdf")];
    const extents = new Map<string, DocumentExtent>([
      [
        "book.pdf",
        { relativePath: "book.pdf", charCount: 100, segmentCount: 10, needsOcrSegments: 0 },
      ],
    ]);
    const links: DocumentLinks = {
      backlinks: [{ sourcePath: "book.pdf", sourceTitle: "b", linkText: "x", count: 1 }],
      outgoing: [],
      brokenCount: 0,
    };
    const position: ReadingPosition = {
      kind: "pdf",
      page: 10,
      offsetRatio: 0,
      maxPage: 10,
      updatedAt: 1,
    };
    expect(
      pickByBacklinks(links, "cur.md", {
        documents: pdfDocuments,
        positions: { "book.pdf": position },
        extents,
      }),
    ).toBeNull();
  });
});

describe("resolveReadNextSuggestion (三级回落)", () => {
  const documents = [
    doc("notes/a.md", "a"),
    doc("notes/b.md", "b"),
    doc("solo/only.md", "only"),
  ];

  function summary(id: string, updatedAt: number): CollectionSummary {
    return { id, name: id, createdAt: 1, updatedAt, itemCount: 2, presentCount: 2 };
  }

  it("prefers the collection order and picks the most recently updated collection", async () => {
    const listCollectionItems = vi.fn(async (id: string) =>
      id === "new"
        ? [item("notes/a.md"), item("solo/only.md")]
        : [item("notes/a.md"), item("notes/b.md")],
    );
    const suggestion = await resolveReadNextSuggestion({
      currentPath: "notes/a.md",
      documents,
      positions: {},
      extents: null,
      listCollections: async () => [summary("old", 10), summary("new", 20)],
      listCollectionItems,
      listDocumentLinks: async () => emptyLinks(),
    });
    expect(suggestion).toEqual({ relativePath: "solo/only.md", reason: "collection" });
    // updatedAt 最新的合集先查;命中归属后不再查更旧的。
    expect(listCollectionItems).toHaveBeenCalledTimes(1);
    expect(listCollectionItems).toHaveBeenCalledWith("new");
  });

  it("falls back to the folder when the collection ends at the current item", async () => {
    const suggestion = await resolveReadNextSuggestion({
      currentPath: "notes/a.md",
      documents,
      positions: {},
      extents: null,
      listCollections: async () => [summary("c", 5)],
      // 当前是该合集末条 → 回落②,而不是看别的合集。
      listCollectionItems: async () => [item("notes/b.md"), item("notes/a.md")],
      listDocumentLinks: async () => emptyLinks(),
    });
    expect(suggestion).toEqual({ relativePath: "notes/b.md", reason: "folder" });
  });

  it("only calls the links IPC after both earlier tiers miss", async () => {
    const listDocumentLinks = vi.fn(async (): Promise<DocumentLinks> => ({
      backlinks: [
        { sourcePath: "notes/a.md", sourceTitle: "a", linkText: "x", count: 2 },
      ],
      outgoing: [],
      brokenCount: 0,
    }));
    const suggestion = await resolveReadNextSuggestion({
      currentPath: "solo/only.md",
      documents,
      positions: {},
      extents: null,
      listCollections: async () => [],
      listCollectionItems: async () => [],
      listDocumentLinks,
    });
    expect(suggestion).toEqual({ relativePath: "notes/a.md", reason: "backlinks" });
    expect(listDocumentLinks).toHaveBeenCalledTimes(1);

    listDocumentLinks.mockClear();
    const folderHit = await resolveReadNextSuggestion({
      currentPath: "notes/a.md",
      documents,
      positions: {},
      extents: null,
      listCollections: async () => [],
      listCollectionItems: async () => [],
      listDocumentLinks,
    });
    expect(folderHit).toEqual({ relativePath: "notes/b.md", reason: "folder" });
    expect(listDocumentLinks).not.toHaveBeenCalled();
  });

  it("returns null when every tier is empty and swallows tier failures", async () => {
    const suggestion = await resolveReadNextSuggestion({
      currentPath: "solo/only.md",
      documents,
      positions: {},
      extents: null,
      listCollections: async () => {
        throw new Error("collections offline");
      },
      listCollectionItems: async () => [],
      listDocumentLinks: async () => {
        throw new Error("库过大，链接视图未启用");
      },
    });
    expect(suggestion).toBeNull();
  });
});
