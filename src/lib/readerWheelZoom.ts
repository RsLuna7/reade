/** Wheel-zoom step sizes aligned with the reading-settings slider and PDF toolbar. */

export const FONT_SIZE_MIN = 13;
export const FONT_SIZE_MAX = 26;
export const FONT_SIZE_STEP = 1;

export const PDF_SCALE_MIN = 0.5;
export const PDF_SCALE_MAX = 3;
export const PDF_SCALE_STEP = 0.1;

export type WheelZoomDirection = -1 | 0 | 1;

export function wheelZoomDirection(deltaY: number): WheelZoomDirection {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  return deltaY < 0 ? 1 : -1;
}

export function adjustFontSize(current: number, direction: WheelZoomDirection): number {
  if (direction === 0) return current;
  const next = current + direction * FONT_SIZE_STEP;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, next));
}

export function adjustPdfScale(current: number, direction: WheelZoomDirection): number {
  if (direction === 0) return current;
  const next = Math.round((current + direction * PDF_SCALE_STEP) * 10) / 10;
  return Math.min(PDF_SCALE_MAX, Math.max(PDF_SCALE_MIN, next));
}
