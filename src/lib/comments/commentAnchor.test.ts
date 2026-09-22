// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  commentAnchorY,
  commentAnchorYFromPageBox,
  findPdfCommentLead,
  isCollapsedCommentRect,
  measurePdfCommentAnchor,
  normalizedAnnotationTop,
} from "./commentAnchor";
import { commentAuthorColor, commentAuthorInitials } from "./commentModel";

describe("PDF comment anchors", () => {
  it("prefers the lead rect for a multiline annotation", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <span class="pdf-user-highlight" data-annotation-id="a"></span>
      <span class="pdf-user-highlight pdf-user-highlight--lead" data-annotation-id="a"></span>
      <span class="pdf-user-highlight" data-annotation-id="a"></span>`;
    expect(findPdfCommentLead(root, "a")).toBe(root.children[1]);
  });

  it("falls back to the first rect and returns null when missing", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <span class="pdf-user-highlight" data-annotation-id="a"></span>
      <span class="pdf-user-highlight" data-annotation-id="a"></span>`;
    expect(findPdfCommentLead(root, "a")).toBe(root.children[0]);
    expect(findPdfCommentLead(root, "missing")).toBeNull();
  });

  it("maps viewport positions into a scroll-stable shared coordinate", () => {
    expect(commentAnchorY({ top: 425 }, { top: 125 })).toBe(300);
    expect(commentAnchorY({ top: 225 }, { top: -75 })).toBe(300);
  });

  it("measures one anchor without throwing when other annotations are absent", () => {
    const root = document.createElement("div");
    const layout = document.createElement("div");
    const mark = document.createElement("span");
    mark.className = "pdf-user-highlight pdf-user-highlight--lead";
    mark.dataset.annotationId = "a";
    root.append(mark);
    vi.spyOn(mark, "getBoundingClientRect").mockReturnValue({ top: 210 } as DOMRect);
    vi.spyOn(layout, "getBoundingClientRect").mockReturnValue({ top: 50 } as DOMRect);
    expect(measurePdfCommentAnchor(root, layout, "a")).toEqual({
      annotationId: "a",
      desiredY: 160,
    });
    expect(measurePdfCommentAnchor(root, layout, "missing")).toBeNull();
  });

  it("falls back to the page box when the highlight is not painted", () => {
    expect(normalizedAnnotationTop([])).toBe(0.08);
    expect(normalizedAnnotationTop([{ y: 0.4 }, { y: 0.2 }])).toBe(0.2);
    expect(commentAnchorYFromPageBox({ top: 100, height: 800 }, { top: 40 }, 0.25)).toBe(260);
    expect(commentAnchorYFromPageBox({ top: 100, height: 0 }, { top: 40 }, 0.25)).toBeNull();
  });

  it("builds a personal avatar mark from the display name", () => {
    expect(commentAuthorInitials("我")).toBe("我");
    expect(commentAuthorInitials("Dld ones Grear")).toBe("DG");
    expect(commentAuthorInitials("")).toBe("我");
    expect(commentAuthorColor("我")).toBe(commentAuthorColor("我"));
    expect(commentAuthorColor("研究者")).not.toBe(commentAuthorColor("我"));
  });

  it("ignores a highlight collapsed to a zero box during zoom preview", () => {
    expect(isCollapsedCommentRect({ width: 0, height: 0 })).toBe(true);
    expect(isCollapsedCommentRect({ width: 12, height: 0 })).toBe(false);
    const root = document.createElement("div");
    const layout = document.createElement("div");
    const mark = document.createElement("span");
    mark.className = "pdf-user-highlight pdf-user-highlight--lead";
    mark.dataset.annotationId = "a";
    root.append(mark);
    vi.spyOn(mark, "getBoundingClientRect").mockReturnValue({
      top: 0,
      width: 0,
      height: 0,
    } as DOMRect);
    expect(measurePdfCommentAnchor(root, layout, "a")).toBeNull();
  });
});
