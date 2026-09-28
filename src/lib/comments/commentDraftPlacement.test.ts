import { describe, expect, it } from "vitest";
import { commentDraftPlacement } from "./commentDraftPlacement";

const viewport = { width: 1440, height: 900 };

describe("commentDraftPlacement", () => {
  it("opens below the selected lines so they stay visible", () => {
    const placement = commentDraftPlacement({ left: 360, top: 300, width: 400, height: 40 }, viewport);
    expect(placement).toEqual({ left: 360, top: 348 });
  });

  it("opens above the selection near the bottom of the window", () => {
    const placement = commentDraftPlacement({ left: 360, top: 780, width: 400, height: 20 }, viewport);
    expect(placement.top).toBeUndefined();
    expect(placement.bottom).toBe(900 - 772);
  });

  it("keeps the draft inside the window horizontally", () => {
    expect(commentDraftPlacement({ left: 1400, top: 100, width: 30, height: 20 }, viewport).left).toBe(1108);
    expect(commentDraftPlacement({ left: -40, top: 100, width: 30, height: 20 }, viewport).left).toBe(12);
  });

  it("pins to the bottom edge when the selection fills the window", () => {
    const placement = commentDraftPlacement({ left: 360, top: 20, width: 400, height: 860 }, viewport);
    expect(placement).toEqual({ left: 360, bottom: 12 });
  });

  // While writing, the passage can scroll out of view; the draft stays reachable.
  it("stays at the top edge when the selection scrolled above the window", () => {
    const placement = commentDraftPlacement({ left: 360, top: -400, width: 400, height: 40 }, viewport);
    expect(placement).toEqual({ left: 360, top: 12 });
  });

  it("stays at the bottom edge when the selection scrolled below the window", () => {
    const placement = commentDraftPlacement({ left: 360, top: 1400, width: 400, height: 40 }, viewport);
    expect(placement).toEqual({ left: 360, bottom: 12 });
  });
});
