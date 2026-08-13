import { describe, expect, it } from "vitest";
import {
  SPREAD_COLUMN_GAP,
  SPREAD_FIT_GUTTER,
  SPREAD_MIN_WINDOW_WIDTH,
  canSpread,
  nextSpreadPage,
  previousSpreadPage,
  singleFitScale,
  spreadFitScale,
  spreadPairStart,
  spreadRowPages,
} from "./pdfSpread";

describe("spread pairing (PS-D2: 封面独立, (2k,2k+1) 配对)", () => {
  it("keeps page one alone and anchors pairs on even pages", () => {
    expect(spreadPairStart(1)).toBe(1);
    expect(spreadPairStart(2)).toBe(2);
    expect(spreadPairStart(3)).toBe(2);
    expect(spreadPairStart(4)).toBe(4);
    expect(spreadPairStart(5)).toBe(4);
  });

  it("normalizes degenerate input to the cover", () => {
    expect(spreadPairStart(0)).toBe(1);
    expect(spreadPairStart(Number.NaN)).toBe(1);
  });

  it("builds row page sets with a lone trailing page", () => {
    expect(spreadRowPages(1, 5)).toEqual([1]);
    expect(spreadRowPages(3, 5)).toEqual([2, 3]);
    expect(spreadRowPages(4, 5)).toEqual([4, 5]);
    // 6 页文档:末对是 (6) 落单。
    expect(spreadRowPages(6, 6)).toEqual([6]);
  });
});

describe("spread paging steps (PS-D4: ±2, 边界 ±1)", () => {
  it("moves by pair with the cover boundary", () => {
    expect(nextSpreadPage(1, 10)).toBe(2);
    expect(nextSpreadPage(2, 10)).toBe(4);
    expect(nextSpreadPage(3, 10)).toBe(4);
    expect(nextSpreadPage(9, 10)).toBe(10);
    expect(nextSpreadPage(10, 10)).toBe(10);
  });

  it("clamps the next step at the document end", () => {
    expect(nextSpreadPage(2, 3)).toBe(3);
    expect(nextSpreadPage(1, 1)).toBe(1);
  });

  it("steps back to the previous pair and lands on the cover", () => {
    expect(previousSpreadPage(1)).toBe(1);
    expect(previousSpreadPage(2)).toBe(1);
    expect(previousSpreadPage(3)).toBe(1);
    expect(previousSpreadPage(4)).toBe(2);
    expect(previousSpreadPage(7)).toBe(4);
  });
});

describe("fit-width scales", () => {
  it("keeps the single-page formula identical to the legacy fitWidth", () => {
    // 既有实现:(clientWidth - 18) / nativeWidth。
    expect(singleFitScale(618, 600)).toBe(1);
    expect(singleFitScale(918, 600)).toBe(1.5);
  });

  it("fits two pages plus the column gap into the container", () => {
    // 容器 1240:去掉 18 滚道 + 22 列距 = 1200,每页 600 → scale 1。
    expect(spreadFitScale(1240, 600)).toBe(1);
    expect(spreadFitScale(640, 600)).toBe(0.5);
  });
});

describe("canSpread (PS-D1 定稿: 窗口 ≥1180 且容器可放两个可读页)", () => {
  it("requires the window breakpoint", () => {
    expect(canSpread(SPREAD_MIN_WINDOW_WIDTH - 1, 2000)).toBe(false);
    expect(canSpread(SPREAD_MIN_WINDOW_WIDTH, 2000)).toBe(true);
  });

  it("requires room for two readable pages in the container", () => {
    const minContainer = 320 * 2 + SPREAD_FIT_GUTTER + SPREAD_COLUMN_GAP;
    expect(canSpread(1440, minContainer)).toBe(true);
    expect(canSpread(1440, minContainer - 1)).toBe(false);
  });

  it("rejects non-finite measurements", () => {
    expect(canSpread(Number.NaN, 900)).toBe(false);
    expect(canSpread(1440, Number.NaN)).toBe(false);
  });
});
