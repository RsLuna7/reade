// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { TocItem } from "./markdown";
import {
  buildPdfTocCoverage,
  coverageFromRatios,
  measureHeadingRatios,
} from "./tocCoverage";

function pdfToc(pages: number[]): TocItem[] {
  return pages.map((page) => ({ id: `pdf-page-${page}`, title: `第 ${page} 页`, level: 1 }));
}

describe("buildPdfTocCoverage", () => {
  it("marks outline entries at or before maxPage as reached", () => {
    const reached = buildPdfTocCoverage(pdfToc([1, 4, 9]), 4);
    expect(reached).toEqual(new Set(["pdf-page-1", "pdf-page-4"]));
  });

  it("treats the boundary page itself as reached (page_i ≤ maxPage)", () => {
    expect(buildPdfTocCoverage(pdfToc([3]), 3).has("pdf-page-3")).toBe(true);
    expect(buildPdfTocCoverage(pdfToc([3]), 2).has("pdf-page-3")).toBe(false);
  });

  it("returns an empty set without a recorded position", () => {
    expect(buildPdfTocCoverage(pdfToc([1, 2]), null).size).toBe(0);
    expect(buildPdfTocCoverage(pdfToc([1, 2]), 0).size).toBe(0);
    expect(buildPdfTocCoverage(pdfToc([1, 2]), Number.NaN).size).toBe(0);
  });

  it("ignores ids that are not pdf outline entries", () => {
    const items: TocItem[] = [
      { id: "pdf-page-1", title: "One", level: 1 },
      { id: "intro", title: "Intro", level: 1 },
    ];
    expect(buildPdfTocCoverage(items, 10)).toEqual(new Set(["pdf-page-1"]));
  });
});

describe("measureHeadingRatios", () => {
  function fakeContainer(scrollHeight: number, headings: Record<string, number>) {
    const container = document.createElement("div");
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: scrollHeight,
    });
    container.scrollTop = 0;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    for (const [id, top] of Object.entries(headings)) {
      const heading = document.createElement("h2");
      heading.id = id;
      vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({ top } as DOMRect);
      container.appendChild(heading);
    }
    return container;
  }

  it("caches offset ratios for every found heading", () => {
    const container = fakeContainer(1000, { early: 100, late: 900 });
    const ratios = measureHeadingRatios(container, ["early", "late", "gone"]);
    expect(ratios).not.toBeNull();
    expect(ratios?.get("early")).toBeCloseTo(0.1);
    expect(ratios?.get("late")).toBeCloseTo(0.9);
    expect(ratios?.has("gone")).toBe(false);
  });

  it("accounts for the current scroll offset of the container", () => {
    const container = fakeContainer(1000, { early: 100 });
    container.scrollTop = 400;
    expect(measureHeadingRatios(container, ["early"])?.get("early")).toBeCloseTo(0.5);
  });

  it("reports not-ready (null) while the container has no layout", () => {
    const container = fakeContainer(0, { early: 0 });
    expect(measureHeadingRatios(container, ["early"])).toBeNull();
  });

  it("clamps ratios into 0..1 for content above or below the range", () => {
    const container = fakeContainer(1000, { above: -50, below: 1500 });
    const ratios = measureHeadingRatios(container, ["above", "below"]);
    expect(ratios?.get("above")).toBe(0);
    expect(ratios?.get("below")).toBe(1);
  });
});

describe("coverageFromRatios", () => {
  const ratios = new Map([
    ["early", 0.1],
    ["middle", 0.6],
    ["late", 0.9],
  ]);

  it("marks entries at or below the high-water mark as reached", () => {
    expect(coverageFromRatios(ratios, 0.6)).toEqual(new Set(["early", "middle"]));
  });

  it("renders everything as unreached while the cache is missing", () => {
    expect(coverageFromRatios(null, 0.6).size).toBe(0);
  });

  it("renders everything as unreached without a recorded mark", () => {
    expect(coverageFromRatios(ratios, null).size).toBe(0);
    expect(coverageFromRatios(ratios, Number.NaN).size).toBe(0);
  });

  it("covers the whole list once the mark hits the end", () => {
    expect(coverageFromRatios(ratios, 1).size).toBe(3);
  });
});
