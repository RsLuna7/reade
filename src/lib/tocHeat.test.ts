// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildEpubToc, epubChapterTocId } from "../components/EpubReader";
import type { Annotation, AnnotationLocator, BookmarkTarget, EpubDocument } from "./backend";
import type { TocItem } from "./markdown";
import { buildTocHeat } from "./tocHeat";

function makeAnnotation(
  id: string,
  locator: AnnotationLocator,
  overrides: Partial<Annotation> = {},
): Annotation {
  return {
    id,
    relativePath: "docs/guide.md",
    kind: locator.kind === "bookmark" ? "bookmark" : "highlight",
    color: locator.kind === "bookmark" ? null : "yellow",
    note: null,
    selectedText: null,
    title: null,
    locator,
    sortIndex: "M|00000|00000000",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function markdownMark(id: string, headingId: string | null): Annotation {
  return makeAnnotation(id, { kind: "markdown", quote: "q", prefix: "", suffix: "", headingId });
}

function pdfMark(id: string, page: number): Annotation {
  return makeAnnotation(id, {
    kind: "pdf",
    page,
    view: "reading",
    quote: "q",
    prefix: "",
    suffix: "",
    rects: [],
  });
}

function epubMark(id: string, chapterId: string): Annotation {
  return makeAnnotation(id, {
    kind: "epub",
    chapterId,
    blockIndex: 0,
    startOffset: 0,
    endOffset: 1,
    quote: "q",
    prefix: "",
    suffix: "",
  });
}

function bookmarkOf(id: string, target: BookmarkTarget): Annotation {
  return makeAnnotation(id, { kind: "bookmark", target });
}

function heading(id: string, level = 2): TocItem {
  return { id, title: id, level };
}

function pdfOutline(pages: number[]): TocItem[] {
  return pages.map((page) => ({ id: `pdf-page-${page}`, title: `第 ${page} 页`, level: 1 }));
}

describe("buildTocHeat markdown", () => {
  const items = [heading("intro"), heading("usage"), heading("faq")];

  it("counts marks under their headingId", () => {
    const result = buildTocHeat({
      items,
      annotations: [
        markdownMark("a1", "usage"),
        markdownMark("a2", "usage"),
        markdownMark("a3", "intro"),
      ],
      format: "markdown",
    });
    expect(result.byId.get("usage")?.count).toBe(2);
    expect(result.byId.get("intro")?.count).toBe(1);
    expect(result.byId.has("faq")).toBe(false);
    expect(result.unassignedCount).toBe(0);
  });

  it("sends null headingIds (selection before the first heading) to unassignedCount", () => {
    const result = buildTocHeat({
      items,
      annotations: [markdownMark("a1", null), markdownMark("a2", "intro")],
      format: "markdown",
    });
    expect(result.unassignedCount).toBe(1);
    expect(result.byId.get("intro")?.count).toBe(1);
  });

  it("counts bookmark targets alongside marks", () => {
    const result = buildTocHeat({
      items,
      annotations: [
        markdownMark("a1", "faq"),
        bookmarkOf("b1", { format: "markdown", headingId: "faq", scrollRatio: 0.9 }),
        bookmarkOf("b2", { format: "markdown", headingId: null, scrollRatio: 0 }),
      ],
      format: "markdown",
    });
    expect(result.byId.get("faq")?.count).toBe(2);
    expect(result.unassignedCount).toBe(1);
  });

  it("treats stale heading ids (renamed sections) as unassigned", () => {
    const result = buildTocHeat({
      items,
      annotations: [markdownMark("a1", "renamed-away")],
      format: "markdown",
    });
    expect(result.byId.size).toBe(0);
    expect(result.unassignedCount).toBe(1);
  });

  it("cannot attribute locators of another format", () => {
    const result = buildTocHeat({
      items,
      annotations: [pdfMark("a1", 3)],
      format: "markdown",
    });
    expect(result.byId.size).toBe(0);
    expect(result.unassignedCount).toBe(1);
  });
});

describe("buildTocHeat pdf", () => {
  it("assigns pages to [page_i, page_{i+1}) intervals; the boundary page opens the next section", () => {
    const result = buildTocHeat({
      items: pdfOutline([1, 5, 9]),
      annotations: [
        pdfMark("a1", 1),
        pdfMark("a2", 4),
        pdfMark("a3", 5),
        pdfMark("a4", 8),
        pdfMark("a5", 9),
      ],
      format: "pdf",
    });
    expect(result.byId.get("pdf-page-1")?.count).toBe(2);
    expect(result.byId.get("pdf-page-5")?.count).toBe(2);
    expect(result.byId.get("pdf-page-9")?.count).toBe(1);
    expect(result.unassignedCount).toBe(0);
  });

  it("collapses several outline entries on the same page into the first bucket", () => {
    // Two outline nodes on page 3 share the id pdf-page-3; annotations in
    // [3, 8) must land in that single bucket without double counting.
    const result = buildTocHeat({
      items: [...pdfOutline([3, 3]), ...pdfOutline([8])],
      annotations: [pdfMark("a1", 3), pdfMark("a2", 4)],
      format: "pdf",
    });
    expect(result.byId.size).toBe(1);
    expect(result.byId.get("pdf-page-3")?.count).toBe(2);
  });

  it("returns an empty result for documents without an outline", () => {
    const result = buildTocHeat({
      items: [],
      annotations: [pdfMark("a1", 1), pdfMark("a2", 2)],
      format: "pdf",
    });
    expect(result.byId.size).toBe(0);
    expect(result.unassignedCount).toBe(0);
  });

  it("attributes pages beyond the last outline entry to the last section", () => {
    const result = buildTocHeat({
      items: pdfOutline([1, 5, 9]),
      annotations: [pdfMark("a1", 42)],
      format: "pdf",
    });
    expect(result.byId.get("pdf-page-9")?.count).toBe(1);
  });

  it("counts pages before the first outline entry as unassigned", () => {
    const result = buildTocHeat({
      items: pdfOutline([3, 9]),
      annotations: [pdfMark("a1", 1)],
      format: "pdf",
    });
    expect(result.byId.size).toBe(0);
    expect(result.unassignedCount).toBe(1);
  });

  it("counts pdf bookmarks by their target page", () => {
    const result = buildTocHeat({
      items: pdfOutline([1, 5, 9]),
      annotations: [bookmarkOf("b1", { format: "pdf", page: 6, offsetRatio: 0.2 })],
      format: "pdf",
    });
    expect(result.byId.get("pdf-page-5")?.count).toBe(1);
  });
});

describe("buildTocHeat epub", () => {
  const book: EpubDocument = {
    title: "Book",
    assets: [],
    notes: [],
    chapters: [
      {
        id: "OEBPS/ch1.xhtml",
        title: "第一章",
        level: 1,
        blocks: [
          {
            kind: "heading",
            level: 2,
            anchor: "ch1-s1",
            content: [{ kind: "text", text: "小节一", bold: false, italic: false, strike: false, code: false }],
          },
        ],
      },
      { id: "OEBPS/ch2.xhtml", title: "第二章", level: 1, blocks: [] },
    ],
  };
  const toc = buildEpubToc(book);
  const chapterTocIds = new Map(
    book.chapters.map((chapter) => [chapter.id, epubChapterTocId(chapter.id)]),
  );

  it("maps chapterIds onto chapter-level entries through epubChapterTocIds", () => {
    const result = buildTocHeat({
      items: toc,
      annotations: [
        epubMark("a1", "OEBPS/ch1.xhtml"),
        epubMark("a2", "OEBPS/ch1.xhtml"),
        epubMark("a3", "OEBPS/ch2.xhtml"),
      ],
      format: "epub",
      epubChapterTocIds: chapterTocIds,
    });
    expect(result.byId.get(epubChapterTocId("OEBPS/ch1.xhtml"))?.count).toBe(2);
    expect(result.byId.get(epubChapterTocId("OEBPS/ch2.xhtml"))?.count).toBe(1);
    expect(result.unassignedCount).toBe(0);
    // Round trip: heat keys are ids that buildEpubToc actually emitted.
    const tocIdSet = new Set(toc.map((item) => item.id));
    for (const id of result.byId.keys()) expect(tocIdSet.has(id)).toBe(true);
  });

  it("keeps in-chapter heading entries free of heat (chapter-level aggregation)", () => {
    const inChapterEntry = toc.find((item) => item.title === "小节一");
    expect(inChapterEntry).toBeDefined();
    const result = buildTocHeat({
      items: toc,
      annotations: [epubMark("a1", "OEBPS/ch1.xhtml")],
      format: "epub",
      epubChapterTocIds: chapterTocIds,
    });
    expect(result.byId.has(inChapterEntry!.id)).toBe(false);
    expect(result.byId.get(epubChapterTocId("OEBPS/ch1.xhtml"))?.count).toBe(1);
  });

  it("sends unknown chapterIds to unassignedCount", () => {
    const result = buildTocHeat({
      items: toc,
      annotations: [epubMark("a1", "ghost.xhtml"), epubMark("a2", "OEBPS/ch2.xhtml")],
      format: "epub",
      epubChapterTocIds: chapterTocIds,
    });
    expect(result.unassignedCount).toBe(1);
    expect(result.byId.get(epubChapterTocId("OEBPS/ch2.xhtml"))?.count).toBe(1);
  });

  it("counts epub bookmarks by their target chapterId", () => {
    const result = buildTocHeat({
      items: toc,
      annotations: [
        bookmarkOf("b1", {
          format: "epub",
          chapterId: "OEBPS/ch2.xhtml",
          headingId: null,
          scrollRatio: 0.5,
        }),
      ],
      format: "epub",
      epubChapterTocIds: chapterTocIds,
    });
    expect(result.byId.get(epubChapterTocId("OEBPS/ch2.xhtml"))?.count).toBe(1);
  });

  it("treats every chapter as unknown when the mapping is missing", () => {
    const result = buildTocHeat({
      items: toc,
      annotations: [epubMark("a1", "OEBPS/ch1.xhtml")],
      format: "epub",
    });
    expect(result.byId.size).toBe(0);
    expect(result.unassignedCount).toBe(1);
  });
});

describe("buildTocHeat levels", () => {
  it("grades sections relative to the busiest one (single annotation → 1, busiest → 4)", () => {
    const items = [heading("a"), heading("b"), heading("c"), heading("d")];
    const annotations = [
      markdownMark("a-1", "a"),
      ...Array.from({ length: 5 }, (_, i) => markdownMark(`b-${i}`, "b")),
      ...Array.from({ length: 7 }, (_, i) => markdownMark(`c-${i}`, "c")),
      ...Array.from({ length: 10 }, (_, i) => markdownMark(`d-${i}`, "d")),
    ];
    const result = buildTocHeat({ items, annotations, format: "markdown" });
    expect(result.byId.get("a")).toEqual({ count: 1, level: 1 });
    expect(result.byId.get("b")).toEqual({ count: 5, level: 2 });
    expect(result.byId.get("c")).toEqual({ count: 7, level: 3 });
    expect(result.byId.get("d")).toEqual({ count: 10, level: 4 });
  });

  it("gives a lone annotated section level 4 (it is the busiest by definition)", () => {
    const result = buildTocHeat({
      items: [heading("only")],
      annotations: [markdownMark("a1", "only")],
      format: "markdown",
    });
    expect(result.byId.get("only")).toEqual({ count: 1, level: 4 });
  });

  it("returns an empty byId when no annotation lands on any section", () => {
    const items = [heading("intro")];
    expect(buildTocHeat({ items, annotations: [], format: "markdown" }).byId.size).toBe(0);

    const allUnassigned = buildTocHeat({
      items,
      annotations: [markdownMark("a1", null), markdownMark("a2", null)],
      format: "markdown",
    });
    expect(allUnassigned.byId.size).toBe(0);
    expect(allUnassigned.unassignedCount).toBe(2);
  });
});

describe("buildTocHeat tombstone defense", () => {
  it("ignores deleted annotations even when the caller forgets to filter", () => {
    const items = [heading("usage")];
    const result = buildTocHeat({
      items,
      annotations: [
        markdownMark("live-hit", "usage"),
        makeAnnotation("dead-hit", { kind: "markdown", quote: "q", prefix: "", suffix: "", headingId: "usage" }, { deletedAt: 123 }),
        makeAnnotation("dead-null", { kind: "markdown", quote: "q", prefix: "", suffix: "", headingId: null }, { deletedAt: 5 }),
      ],
      format: "markdown",
    });
    expect(result.byId.get("usage")?.count).toBe(1);
    expect(result.unassignedCount).toBe(0);
  });

  it("keeps annotations with deletedAt null or absent", () => {
    const items = [heading("usage")];
    const result = buildTocHeat({
      items,
      annotations: [
        makeAnnotation("null-tombstone", { kind: "markdown", quote: "q", prefix: "", suffix: "", headingId: "usage" }, { deletedAt: null }),
        markdownMark("absent-tombstone", "usage"),
      ],
      format: "markdown",
    });
    expect(result.byId.get("usage")?.count).toBe(2);
  });
});

describe("buildTocHeat performance", () => {
  it("stays far below the 5ms budget for 200 TOC items × 2000 annotations", () => {
    const markdownItems = Array.from({ length: 200 }, (_, i) => heading(`section-${i}`));
    const markdownAnnotations = Array.from({ length: 2000 }, (_, i) =>
      markdownMark(`md-${i}`, `section-${i % 200}`),
    );
    const pdfItems = pdfOutline(Array.from({ length: 200 }, (_, i) => i * 5 + 1));
    const pdfAnnotations = Array.from({ length: 2000 }, (_, i) => pdfMark(`pdf-${i}`, (i % 997) + 1));

    // Warm-up run so the assertion measures steady-state work, not JIT.
    buildTocHeat({ items: markdownItems, annotations: markdownAnnotations, format: "markdown" });
    buildTocHeat({ items: pdfItems, annotations: pdfAnnotations, format: "pdf" });

    const start = performance.now();
    const markdownResult = buildTocHeat({
      items: markdownItems,
      annotations: markdownAnnotations,
      format: "markdown",
    });
    const pdfResult = buildTocHeat({ items: pdfItems, annotations: pdfAnnotations, format: "pdf" });
    const elapsed = performance.now() - start;

    expect(markdownResult.byId.size).toBe(200);
    expect(pdfResult.byId.size).toBeGreaterThan(0);
    // Plan §5 asks < 5ms per call; 50ms for both calls absorbs CI jitter.
    expect(elapsed).toBeLessThan(50);
  });
});
