// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  commentAnchorY,
  findPdfCommentLead,
  isCollapsedCommentRect,
  measurePdfCommentAnchor,
} from "./commentAnchor";

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
