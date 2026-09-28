import { describe, expect, it } from "vitest";
import type { Annotation } from "../backend";
import type { PdfCommentThread } from "./commentModel";
import { NO_PAGE_ITEMS, pdfCommentBubblesByPage, pdfMarksByPage } from "./pdfPageMarks";

function pdfMark(
  id: string,
  page: number,
  options: { kind?: Annotation["kind"]; view?: "original" | "reading"; y?: number[] } = {},
): Annotation {
  return {
    id,
    relativePath: "paper.pdf",
    kind: options.kind ?? "highlight",
    color: "yellow",
    note: null,
    selectedText: id,
    title: null,
    locator: {
      kind: "pdf",
      page,
      view: options.view ?? "original",
      quote: id,
      prefix: "",
      suffix: "",
      rects: (options.y ?? []).map((y) => ({ x: 0.1, y, w: 0.2, h: 0.02 })),
    },
    sortIndex: `P|${String(page).padStart(5, "0")}|00000000`,
    createdAt: 1,
    updatedAt: 1,
  };
}

function thread(annotationId: string, deletedAt: number | null = null): PdfCommentThread {
  return { id: `t-${annotationId}`, annotationId, createdAt: 1, updatedAt: 1, deletedAt };
}

describe("pdfMarksByPage", () => {
  it("groups original-view marks by page in input order", () => {
    const byPage = pdfMarksByPage([
      pdfMark("a", 2),
      pdfMark("b", 1, { kind: "underline" }),
      pdfMark("c", 2),
    ]);
    expect(byPage.get(2)?.map((item) => item.id)).toEqual(["a", "c"]);
    expect(byPage.get(1)?.map((item) => item.id)).toEqual(["b"]);
  });

  it("skips reading-view marks and non-mark kinds", () => {
    const byPage = pdfMarksByPage([
      pdfMark("reading", 1, { view: "reading" }),
      pdfMark("bookmark", 1, { kind: "bookmark" }),
    ]);
    expect(byPage.size).toBe(0);
  });

  it("offers one frozen empty list for pages without marks", () => {
    expect(NO_PAGE_ITEMS).toHaveLength(0);
    expect(Object.isFrozen(NO_PAGE_ITEMS)).toBe(true);
  });
});

describe("pdfCommentBubblesByPage", () => {
  it("places one bubble per live thread at the passage top", () => {
    const byPage = pdfCommentBubblesByPage(
      [pdfMark("a", 3, { y: [0.5, 0.3] }), pdfMark("b", 3, { y: [0.7] }), pdfMark("c", 4)],
      [thread("a"), thread("b", 9), thread("c")],
      "c",
    );
    expect(byPage.get(3)).toEqual([{ annotationId: "a", top: 0.3, active: false }]);
    // No rects: the bubble sits near the page top instead of disappearing.
    expect(byPage.get(4)).toEqual([{ annotationId: "c", top: 0.08, active: true }]);
  });

  it("returns no bubbles when nothing is commented", () => {
    expect(pdfCommentBubblesByPage([pdfMark("a", 1)], [], null).size).toBe(0);
  });
});
