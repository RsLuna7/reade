import { describe, expect, it } from "vitest";
import {
  cropRegionFromSource,
  normalizeRegionRect,
  planRegionUpscale,
  regionCardFileName,
  regionSourceRect,
  REGION_MAX_RERENDER_SIDE_PX,
  REGION_MIN_LOGICAL_PX,
  type RegionCanvas,
  type RegionCanvasContext,
} from "./pdfRegion";

describe("normalizeRegionRect", () => {
  it("normalizes any drag direction into a [0..1] rect", () => {
    const rect = normalizeRegionRect({ x: 300, y: 400 }, { x: 100, y: 100 }, 800, 1000);
    expect(rect).toEqual({ x: 0.125, y: 0.1, w: 0.25, h: 0.3 });
  });

  it("clamps out-of-page points to the page bounds", () => {
    const rect = normalizeRegionRect({ x: -50, y: -20 }, { x: 900, y: 1200 }, 800, 1000);
    expect(rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("rejects drags below the misfire threshold (either axis)", () => {
    expect(normalizeRegionRect({ x: 0, y: 0 }, { x: 23, y: 500 }, 800, 1000)).toBeNull();
    expect(normalizeRegionRect({ x: 0, y: 0 }, { x: 500, y: 23 }, 800, 1000)).toBeNull();
    expect(
      normalizeRegionRect(
        { x: 0, y: 0 },
        { x: REGION_MIN_LOGICAL_PX, y: REGION_MIN_LOGICAL_PX },
        800,
        1000,
      ),
    ).not.toBeNull();
  });

  it("rejects degenerate page sizes", () => {
    expect(normalizeRegionRect({ x: 0, y: 0 }, { x: 50, y: 50 }, 0, 1000)).toBeNull();
  });
});

describe("regionSourceRect (DPR 语义:对位图归一,不乘 ratio)", () => {
  const rect = { x: 0.25, y: 0.1, w: 0.5, h: 0.2 };

  it.each([
    [1, 800, 1000],
    [1.5, 1200, 1500],
    [2, 1600, 2000],
  ])("maps the same normalized rect onto a ratio-%s bitmap", (_ratio, width, height) => {
    const source = regionSourceRect(rect, width, height);
    expect(source).toEqual({
      sx: Math.round(width * 0.25),
      sy: Math.round(height * 0.1),
      sw: Math.round(width * 0.5),
      sh: Math.round(height * 0.2),
    });
  });

  it("clamps rounding overflow at the bitmap edges and keeps at least 1px", () => {
    const edge = regionSourceRect({ x: 0.999, y: 0.999, w: 0.01, h: 0.01 }, 100, 100);
    expect(edge.sx).toBeLessThanOrEqual(99);
    expect(edge.sy).toBeLessThanOrEqual(99);
    expect(edge.sx + edge.sw).toBeLessThanOrEqual(100);
    expect(edge.sy + edge.sh).toBeLessThanOrEqual(100);
    expect(edge.sw).toBeGreaterThanOrEqual(1);
    expect(edge.sh).toBeGreaterThanOrEqual(1);
  });
});

describe("planRegionUpscale", () => {
  it("skips crops that are already sharp (short side ≥ 480px)", () => {
    expect(
      planRegionUpscale({ cropWidth: 480, cropHeight: 900, bitmapWidth: 1600, bitmapHeight: 2000 }),
    ).toBeNull();
  });

  it("scales small crops toward the 960px target", () => {
    const multiplier = planRegionUpscale({
      cropWidth: 240,
      cropHeight: 600,
      bitmapWidth: 1000,
      bitmapHeight: 1000,
    });
    expect(multiplier).toBeCloseTo(960 / 240, 5);
  });

  it("caps the rerender by the 4096px page long side", () => {
    const multiplier = planRegionUpscale({
      cropWidth: 100,
      cropHeight: 100,
      bitmapWidth: 1600,
      bitmapHeight: 2048,
    });
    expect(multiplier).toBeCloseTo(REGION_MAX_RERENDER_SIDE_PX / 2048, 5);
  });

  it("returns null when the cap makes the rerender pointless", () => {
    expect(
      planRegionUpscale({ cropWidth: 100, cropHeight: 100, bitmapWidth: 4000, bitmapHeight: 4096 }),
    ).toBeNull();
    expect(
      planRegionUpscale({ cropWidth: 0, cropHeight: 100, bitmapWidth: 1000, bitmapHeight: 1000 }),
    ).toBeNull();
  });
});

describe("cropRegionFromSource", () => {
  class FakeRegionContext implements RegionCanvasContext {
    calls: number[][] = [];
    drawImage(_source: CanvasImageSource, ...args: number[]): void {
      this.calls.push(args);
    }
  }

  class FakeRegionCanvas implements RegionCanvas {
    readonly ctx = new FakeRegionContext();
    constructor(
      public width: number,
      public height: number,
      private readonly hasContext = true,
    ) {}
    getContext(): RegionCanvasContext | null {
      return this.hasContext ? this.ctx : null;
    }
  }

  const source = {} as CanvasImageSource;

  it("copies the bitmap crop 1:1 into a canvas of the crop size", () => {
    let created: FakeRegionCanvas | null = null;
    const crop = cropRegionFromSource(
      source,
      1600,
      2000,
      { x: 0.25, y: 0.1, w: 0.5, h: 0.2 },
      (width, height) => {
        created = new FakeRegionCanvas(width, height);
        return created;
      },
    );
    expect(crop).toBe(created);
    expect(crop!.width).toBe(800);
    expect(crop!.height).toBe(400);
    expect(crop!.ctx.calls).toEqual([[400, 200, 800, 400, 0, 0, 800, 400]]);
  });

  it("returns null when the 2d context is unavailable or the source is empty", () => {
    expect(
      cropRegionFromSource(source, 100, 100, { x: 0, y: 0, w: 1, h: 1 }, (w, h) =>
        new FakeRegionCanvas(w, h, false),
      ),
    ).toBeNull();
    expect(
      cropRegionFromSource(source, 0, 100, { x: 0, y: 0, w: 1, h: 1 }, (w, h) =>
        new FakeRegionCanvas(w, h),
      ),
    ).toBeNull();
  });
});

describe("regionCardFileName", () => {
  it("stamps the title and page, sanitizing illegal characters", () => {
    expect(regionCardFileName("矩阵分析", 12)).toBe("reade-引用-矩阵分析-p12.png");
    expect(regionCardFileName('a/b:c*d?"<>|', 3)).toBe("reade-引用-a-b-c-d------p3.png");
    expect(regionCardFileName("  ", 1)).toBe("reade-引用-文档-p1.png");
  });
});
