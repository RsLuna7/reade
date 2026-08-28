import { dayKeyToDate } from "./readingStats";

/**
 * Size the year heatmap so the 53-week grid fills its card, instead of
 * sitting as a fixed GitHub-sized stamp with empty side gutters.
 *
 * Geometry matches `react-activity-calendar` v3: weekday labels sit in a
 * left gutter (`fontSize` + 8px), then `weekCount` cells with trailing-gap
 * omitted on the last column.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Same weekday index as `<ActivityCalendar weekStart={1} />` (Monday). */
export const HEATMAP_WEEK_START = 1;

/** Same as the calendar's `LABEL_MARGIN`. */
export const HEATMAP_LABEL_MARGIN = 8;

export const HEATMAP_FONT_SIZE = 12;

/**
 * CJK weekday glyphs are ~1em. Plus the library's label margin. A 2px
 * underestimate is preferable to overflow: leftover is absorbed by gaps.
 */
export const HEATMAP_WEEKDAY_GUTTER = HEATMAP_FONT_SIZE + HEATMAP_LABEL_MARGIN;

/** Keep the 11/3 GitHub-like ratio as cells grow. */
const MARGIN_RATIO = 3 / 11;

const MIN_BLOCK_SIZE = 10;
const MIN_BLOCK_MARGIN = 2;
/** Cap so a maximized pane does not turn into 30px tiles. */
const MAX_BLOCK_SIZE = 26;

export type HeatmapBlockMetrics = {
  blockSize: number;
  blockMargin: number;
  blockRadius: number;
};

export const DEFAULT_HEATMAP_BLOCKS: HeatmapBlockMetrics = {
  blockSize: 11,
  blockMargin: 3,
  blockRadius: 2,
};

export function heatmapWeekCount(
  startDate: string,
  endDate: string,
  weekStart = HEATMAP_WEEK_START,
): number {
  const start = dayKeyToDate(startDate);
  const end = dayKeyToDate(endDate);
  const pad = (start.getDay() - weekStart + 7) % 7;
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (days < 1) return 1;
  return Math.ceil((days + pad) / 7);
}

export function heatmapGridWidth(
  weekCount: number,
  blockSize: number,
  blockMargin: number,
  gutter = HEATMAP_WEEKDAY_GUTTER,
): number {
  const gaps = Math.max(0, weekCount - 1);
  return gutter + weekCount * blockSize + gaps * blockMargin;
}

export function heatmapBlockMetrics(
  containerWidth: number,
  weekCount: number,
): HeatmapBlockMetrics {
  if (weekCount < 2 || containerWidth <= 0) return DEFAULT_HEATMAP_BLOCKS;

  const inner = containerWidth - HEATMAP_WEEKDAY_GUTTER;
  const minWidth = heatmapGridWidth(
    weekCount,
    MIN_BLOCK_SIZE,
    MIN_BLOCK_MARGIN,
    0,
  );
  if (inner < minWidth) {
    return {
      blockSize: MIN_BLOCK_SIZE,
      blockMargin: MIN_BLOCK_MARGIN,
      blockRadius: radiusFor(MIN_BLOCK_SIZE),
    };
  }

  const rawSize = inner / (weekCount + (weekCount - 1) * MARGIN_RATIO);
  if (rawSize >= MAX_BLOCK_SIZE) {
    const blockSize = MAX_BLOCK_SIZE;
    const blockMargin = round2(blockSize * MARGIN_RATIO);
    return { blockSize, blockMargin, blockRadius: radiusFor(blockSize) };
  }

  const blockSize = Math.max(MIN_BLOCK_SIZE, Math.floor(rawSize));
  const blockMargin = round2((inner - weekCount * blockSize) / (weekCount - 1));

  return {
    blockSize,
    blockMargin: Math.max(MIN_BLOCK_MARGIN, blockMargin),
    blockRadius: radiusFor(blockSize),
  };
}

export function heatmapBlocksEqual(
  left: HeatmapBlockMetrics,
  right: HeatmapBlockMetrics,
): boolean {
  return (
    left.blockSize === right.blockSize &&
    left.blockMargin === right.blockMargin &&
    left.blockRadius === right.blockRadius
  );
}

function radiusFor(size: number): number {
  return Math.max(2, Math.round((size * 2) / 11));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
