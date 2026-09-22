import { describe, expect, it } from "vitest";
import type { Annotation } from "../backend";
import type { PendingSelection } from "../annotationCapture";
import { commentTargetForSelection, pdfCommentSortKey } from "./commentPlacement";

function mark(
  id: string,
  kind: "highlight" | "underline",
  rects: Array<{ x: number; y: number; w: number; h: number }>,
): Annotation {
  return {
    id,
    relativePath: "paper.pdf",
    kind,
    color: "yellow",
    note: null,
    selectedText: id,
    title: null,
    locator: {
      kind: "pdf",
      page: 2,
      view: "original",
      quote: id,
      prefix: "",
      suffix: "",
      rects,
    },
    sortIndex: id,
    createdAt: 1,
    updatedAt: 1,
  };
}

function pending(
  rects: Array<{ x: number; y: number; w: number; h: number }>,
): PendingSelection {
  return {
    text: "选区",
    rect: { left: 0, top: 0, width: 10, height: 10 },
    locator: {
      kind: "pdf",
      page: 2,
      view: "original",
      quote: "选区",
      prefix: "",
      suffix: "",
      rects,
    },
  };
}

describe("commentTargetForSelection", () => {
  const highlight = mark("h", "highlight", [{ x: 0, y: 0, w: 0.4, h: 0.1 }]);
  const underline = mark("u", "underline", [{ x: 0.5, y: 0.2, w: 0.4, h: 0.1 }]);

  it("attaches to the mark with the greater overlap and keeps an earlier tie", () => {
    const target = commentTargetForSelection(
      pending([{ x: 0.1, y: 0, w: 0.2, h: 0.1 }]),
      [underline, highlight],
      [{ id: "thread", annotationId: "h", createdAt: 1, updatedAt: 1, deletedAt: null }],
    );
    expect(target).toEqual({ annotationId: "h", threadId: "thread" });
  });

  it("returns null when the selection misses every mark", () => {
    expect(
      commentTargetForSelection(
        pending([{ x: 0.9, y: 0.9, w: 0.05, h: 0.05 }]),
        [highlight],
        [],
      ),
    ).toBeNull();
  });
});

describe("pdfCommentSortKey", () => {
  it("orders by page then the top of the selection", () => {
    const later = mark("b", "highlight", [{ x: 0, y: 0.8, w: 0.1, h: 0.1 }]);
    const earlier = mark("a", "highlight", [{ x: 0, y: 0.1, w: 0.1, h: 0.1 }]);
    expect(pdfCommentSortKey(earlier)[1]).toBeLessThan(pdfCommentSortKey(later)[1]);
  });
});
