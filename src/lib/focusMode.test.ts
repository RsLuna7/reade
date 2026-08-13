import { describe, expect, it } from "vitest";
import {
  FOCUS_ANCHOR_RATIO,
  focusReferenceLine,
  rulerBandHeight,
  selectFocusIndex,
  typewriterScrollTop,
} from "./focusMode";

describe("focusReferenceLine (FM-D2)", () => {
  it("sits at 45% of the viewport height", () => {
    expect(FOCUS_ANCHOR_RATIO).toBe(0.45);
    expect(focusReferenceLine(100, 400)).toBe(280);
    expect(focusReferenceLine(0, 1000)).toBe(450);
  });
});

describe("selectFocusIndex", () => {
  it("prefers the block containing the reference line", () => {
    const blocks = [
      { top: 0, bottom: 100 },
      { top: 120, bottom: 400 },
      { top: 420, bottom: 600 },
    ];
    expect(selectFocusIndex(blocks, 260)).toBe(1);
  });

  it("falls back to the nearest edge inside a gap", () => {
    const blocks = [
      { top: 0, bottom: 100 },
      { top: 130, bottom: 300 },
    ];
    // 参考线 110:距块 0 的 bottom 10px,距块 1 的 top 20px。
    expect(selectFocusIndex(blocks, 110)).toBe(0);
    expect(selectFocusIndex(blocks, 121)).toBe(1);
  });

  it("keeps the earlier block on an exact tie (reading order)", () => {
    const blocks = [
      { top: 0, bottom: 100 },
      { top: 120, bottom: 220 },
    ];
    // 参考线 110:两块各距 10px,取阅读顺序在前的块 0。
    expect(selectFocusIndex(blocks, 110)).toBe(0);
  });

  it("skips degenerate rects and returns null for an empty set", () => {
    expect(selectFocusIndex([], 100)).toBeNull();
    expect(selectFocusIndex([{ top: 50, bottom: 50 }], 100)).toBeNull();
    expect(
      selectFocusIndex(
        [
          { top: 10, bottom: 10 },
          { top: 20, bottom: 80 },
        ],
        100,
      ),
    ).toBe(1);
  });
});

describe("typewriterScrollTop", () => {
  it("aligns the block center to the 45% reference line", () => {
    // 视口 top 0 高 400 → 参考线 180;块中心 300 → 需要再滚 120。
    expect(
      typewriterScrollTop({
        scrollTop: 500,
        blockTop: 250,
        blockHeight: 100,
        viewportTop: 0,
        viewportHeight: 400,
      }),
    ).toBe(620);
  });

  it("scrolls up when the block center is above the reference line", () => {
    expect(
      typewriterScrollTop({
        scrollTop: 500,
        blockTop: 40,
        blockHeight: 80,
        viewportTop: 0,
        viewportHeight: 400,
      }),
    ).toBe(400);
  });

  it("clamps the target at zero near the document top", () => {
    expect(
      typewriterScrollTop({
        scrollTop: 10,
        blockTop: 20,
        blockHeight: 40,
        viewportTop: 0,
        viewportHeight: 800,
      }),
    ).toBe(0);
  });
});

describe("rulerBandHeight", () => {
  it("multiplies font size by line height and rounds", () => {
    expect(rulerBandHeight(17, 1.9)).toBe(32);
    expect(rulerBandHeight(13, 1.4)).toBe(18);
  });

  it("clamps degenerate and extreme inputs", () => {
    expect(rulerBandHeight(0, 0)).toBe(12);
    expect(rulerBandHeight(Number.NaN, 2)).toBe(12);
    expect(rulerBandHeight(200, 3)).toBe(120);
  });
});
