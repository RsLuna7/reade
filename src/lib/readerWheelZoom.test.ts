// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  adjustFontSize,
  adjustPdfScale,
  adjustPdfScaleByDelta,
  applyPdfZoomPreview,
  clampPdfScale,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  isPdfZoomPreviewing,
  PDF_SCALE_MAX,
  PDF_SCALE_MIN,
  pdfZoomKeepOriginScroll,
  pdfZoomLivePageWidth,
  pdfZoomPreviewFactor,
  wheelZoomDeltaPixels,
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
    expect(adjustPdfScale(1, -1)).toBe(PDF_SCALE_MIN);
    expect(adjustPdfScale(PDF_SCALE_MIN, -1)).toBe(PDF_SCALE_MIN);
    expect(adjustPdfScale(PDF_SCALE_MAX, 1)).toBe(PDF_SCALE_MAX);
  });
});

describe("wheelZoomDeltaPixels", () => {
  it("passes through pixel deltas", () => {
    expect(wheelZoomDeltaPixels({ deltaY: -40, deltaMode: 0 })).toBe(-40);
  });

  it("treats three LINE units as one mouse notch", () => {
    expect(wheelZoomDeltaPixels({ deltaY: -3, deltaMode: 1 })).toBe(-120);
  });

  it("treats one PAGE unit as one mouse notch", () => {
    expect(wheelZoomDeltaPixels({ deltaY: 1, deltaMode: 2 })).toBe(120);
  });
});

describe("adjustPdfScaleByDelta", () => {
  it("maps one 120px notch to a 1.1× step without snapping smaller moves", () => {
    expect(adjustPdfScaleByDelta(1, -120)).toBeCloseTo(1.1);
    expect(adjustPdfScaleByDelta(1, 120)).toBe(PDF_SCALE_MIN);
    expect(adjustPdfScaleByDelta(1, -12)).toBeCloseTo(1.1 ** 0.1);
  });

  it("clamps to the toolbar range", () => {
    expect(adjustPdfScaleByDelta(PDF_SCALE_MIN, 120)).toBe(PDF_SCALE_MIN);
    expect(adjustPdfScaleByDelta(PDF_SCALE_MAX, -120)).toBe(PDF_SCALE_MAX);
  });
});

describe("clampPdfScale", () => {
  it("clamps to the toolbar range and rejects non-finite values", () => {
    expect(clampPdfScale(1.7)).toBe(1.7);
    expect(clampPdfScale(0.1)).toBe(PDF_SCALE_MIN);
    expect(clampPdfScale(9)).toBe(PDF_SCALE_MAX);
    expect(clampPdfScale(Number.NaN)).toBe(1);
  });
});

describe("pdf zoom preview", () => {
  it("is the layout/render ratio and idle when the two scales match", () => {
    expect(pdfZoomPreviewFactor(1.2, 1)).toBeCloseTo(1.2);
    expect(pdfZoomPreviewFactor(1, 0)).toBe(1);
    expect(isPdfZoomPreviewing(1.1, 1)).toBe(true);
    expect(isPdfZoomPreviewing(1, 1)).toBe(false);
  });

  it("writes a live page-width variable and clears it when idle", () => {
    const host = document.createElement("div");
    applyPdfZoomPreview(host, 1.25, 1025);
    expect(host.dataset.zoomPreview).toBe("true");
    expect(host.style.getPropertyValue("--pdf-live-page-width")).toBe("1025px");
    expect(host.style.transform).toBe("");
    applyPdfZoomPreview(host, 1, 820);
    expect(host.dataset.zoomPreview).toBeUndefined();
    expect(host.style.getPropertyValue("--pdf-live-page-width")).toBe("");
  });

  it("rounds live page width from native size and layout scale", () => {
    expect(pdfZoomLivePageWidth(820, 1.2)).toBe(984);
  });

  it("keeps a viewport origin fixed the way pdf.js panBy does", () => {
    expect(pdfZoomKeepOriginScroll(1, 1.1, 200, 140, 100, 40).left).toBeCloseTo(10);
    expect(pdfZoomKeepOriginScroll(1, 1.1, 200, 140, 100, 40).top).toBeCloseTo(10);
    expect(pdfZoomKeepOriginScroll(1, 1, 200, 140, 100, 40)).toEqual({ left: 0, top: 0 });
  });
});
