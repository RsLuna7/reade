import { describe, expect, it } from "vitest";
import {
  adjustFontSize,
  adjustPdfScale,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  PDF_SCALE_MAX,
  PDF_SCALE_MIN,
  wheelZoomDirection,
} from "./readerWheelZoom";

describe("wheelZoomDirection", () => {
  it("maps negative deltaY to zoom in", () => {
    expect(wheelZoomDirection(-120)).toBe(1);
  });

  it("maps positive deltaY to zoom out", () => {
    expect(wheelZoomDirection(120)).toBe(-1);
  });

  it("returns 0 for zero or non-finite delta", () => {
    expect(wheelZoomDirection(0)).toBe(0);
    expect(wheelZoomDirection(Number.NaN)).toBe(0);
  });
});

describe("adjustFontSize", () => {
  it("steps by one pixel and clamps to the reading-settings range", () => {
    expect(adjustFontSize(17, 1)).toBe(18);
    expect(adjustFontSize(17, -1)).toBe(16);
    expect(adjustFontSize(FONT_SIZE_MIN, -1)).toBe(FONT_SIZE_MIN);
    expect(adjustFontSize(FONT_SIZE_MAX, 1)).toBe(FONT_SIZE_MAX);
  });
});

describe("adjustPdfScale", () => {
  it("steps by 0.1 and clamps to the toolbar range", () => {
    expect(adjustPdfScale(1, 1)).toBe(1.1);
    expect(adjustPdfScale(1, -1)).toBe(0.9);
    expect(adjustPdfScale(PDF_SCALE_MIN, -1)).toBe(PDF_SCALE_MIN);
    expect(adjustPdfScale(PDF_SCALE_MAX, 1)).toBe(PDF_SCALE_MAX);
  });
});
