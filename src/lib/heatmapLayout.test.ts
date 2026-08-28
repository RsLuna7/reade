import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEATMAP_BLOCKS,
  HEATMAP_WEEK_START,
  HEATMAP_WEEKDAY_GUTTER,
  heatmapBlockMetrics,
  heatmapGridWidth,
  heatmapWeekCount,
} from "./heatmapLayout";

describe("heatmapWeekCount", () => {
  it("counts a Monday-aligned week as one column", () => {
    expect(heatmapWeekCount("2026-08-24", "2026-08-30", 1)).toBe(1);
  });

  it("pads back to week start like react-activity-calendar", () => {
    expect(heatmapWeekCount("2026-08-25", "2026-08-31", 1)).toBe(2);
  });

  it("keeps a 365-day window at 53 or 54 weeks", () => {
    const weeks = heatmapWeekCount("2025-08-28", "2026-08-27", HEATMAP_WEEK_START);
    expect(weeks).toBeGreaterThanOrEqual(53);
    expect(weeks).toBeLessThanOrEqual(54);
  });
});

describe("heatmapBlockMetrics", () => {
  it("returns defaults when the host has not been measured", () => {
    expect(heatmapBlockMetrics(0, 53)).toEqual(DEFAULT_HEATMAP_BLOCKS);
  });

  it("fills a typical stats card without overflowing", () => {
    const weeks = 53;
    const width = 960;
    const metrics = heatmapBlockMetrics(width, weeks);
    const used = heatmapGridWidth(weeks, metrics.blockSize, metrics.blockMargin);
    expect(Number.isInteger(metrics.blockSize)).toBe(true);
    expect(metrics.blockSize).toBeGreaterThan(11);
    expect(used).toBeLessThanOrEqual(width + 0.5);
    expect(width - used).toBeLessThan(1);
  });

  it("grows cells on a wide pane so leftover stays sub-column", () => {
    const weeks = 53;
    const compact = heatmapBlockMetrics(760, weeks);
    const wide = heatmapBlockMetrics(1400, weeks);
    expect(wide.blockSize).toBeGreaterThan(compact.blockSize);
    expect(heatmapGridWidth(weeks, wide.blockSize, wide.blockMargin)).toBeLessThanOrEqual(
      1400 + 0.5,
    );
  });

  it("keeps a readable minimum and lets narrow hosts scroll", () => {
    const weeks = 53;
    const width = 420;
    const metrics = heatmapBlockMetrics(width, weeks);
    expect(metrics.blockSize).toBe(10);
    expect(heatmapGridWidth(weeks, metrics.blockSize, metrics.blockMargin)).toBeGreaterThan(
      width,
    );
  });

  it("does not grow past the density cap on an ultrawide pane", () => {
    const metrics = heatmapBlockMetrics(2400, 53);
    expect(metrics.blockSize).toBeLessThanOrEqual(26);
    expect(heatmapGridWidth(53, metrics.blockSize, metrics.blockMargin)).toBeLessThan(2400);
  });

  it("accounts for the weekday gutter in the fill budget", () => {
    const weeks = 53;
    const width = 1100;
    const metrics = heatmapBlockMetrics(width, weeks);
    const grid = weeks * metrics.blockSize + (weeks - 1) * metrics.blockMargin;
    expect(grid + HEATMAP_WEEKDAY_GUTTER).toBeCloseTo(
      heatmapGridWidth(weeks, metrics.blockSize, metrics.blockMargin),
      5,
    );
  });
});
