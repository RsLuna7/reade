import { describe, expect, it } from "vitest";
import { PDF_COMMENT_MARGIN_PX, commentFitNativeWidth, layoutCommentCards } from "./commentRailLayout";

describe("comment margin fit", () => {
  it("reserves the card track and the gap that sit beside the page", () => {
    expect(PDF_COMMENT_MARGIN_PX).toBe(312);
  });

  it("widens the fit target by the margin and leaves a zero margin unchanged", () => {
    expect(commentFitNativeWidth(600, false, 0)).toBe(600);
    expect(commentFitNativeWidth(600, true, 0)).toBe(600);
    expect(commentFitNativeWidth(600, false, 300)).toBe(900);
    expect(commentFitNativeWidth(600, true, 300)).toBe(750);
  });
});

describe("layoutCommentCards", () => {
  it("keeps separated cards at their anchors", () => {
    expect(layoutCommentCards([
      { id: "a", desiredY: 10, height: 40 },
      { id: "b", desiredY: 80, height: 30 },
    ])).toEqual([
      { id: "a", desiredY: 10, renderY: 10, height: 40 },
      { id: "b", desiredY: 80, renderY: 80, height: 30 },
    ]);
  });

  it("pushes two colliding cards apart", () => {
    expect(layoutCommentCards([
      { id: "a", desiredY: 100, height: 80 },
      { id: "b", desiredY: 140, height: 100 },
    ])[1]?.renderY).toBe(192);
  });

  it("stacks three consecutive collisions with different heights", () => {
    expect(layoutCommentCards([
      { id: "a", desiredY: 20, height: 30 },
      { id: "b", desiredY: 25, height: 70 },
      { id: "c", desiredY: 30, height: 15 },
    ]).map((item) => item.renderY)).toEqual([20, 62, 144]);
  });

  it("sorts unordered input and keeps equal-anchor order stable", () => {
    expect(layoutCommentCards([
      { id: "c", desiredY: 40, height: 10 },
      { id: "a", desiredY: 10, height: 10 },
      { id: "b", desiredY: 10, height: 10 },
    ]).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("handles empty, single, and very distant cards", () => {
    expect(layoutCommentCards([])).toEqual([]);
    expect(layoutCommentCards([{ id: "a", desiredY: 8, height: 22 }])).toEqual([
      { id: "a", desiredY: 8, renderY: 8, height: 22 },
    ]);
    expect(layoutCommentCards([
      { id: "a", desiredY: 0, height: 10 },
      { id: "b", desiredY: 10_000, height: 10 },
    ])[1]?.renderY).toBe(10_000);
  });
});
