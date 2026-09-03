/** Reading-pane wheel scroll multiplier (reading-settings slider). */

export const WHEEL_SPEED_MIN = 0.3;
export const WHEEL_SPEED_MAX = 3;
export const WHEEL_SPEED_STEP = 0.1;
export const WHEEL_SPEED_DEFAULT = 1;

/** DOM_DELTA_* without depending on WheelEvent in non-DOM test hosts. */
const DELTA_LINE = 1;
const DELTA_PAGE = 2;

export function clampWheelSpeed(value: number): number {
  if (!Number.isFinite(value)) return WHEEL_SPEED_DEFAULT;
  const clamped = Math.min(WHEEL_SPEED_MAX, Math.max(WHEEL_SPEED_MIN, value));
  return Math.round(clamped * 10) / 10;
}

export function isDefaultWheelSpeed(speed: number): boolean {
  return Math.abs(clampWheelSpeed(speed) - WHEEL_SPEED_DEFAULT) < 0.001;
}

/**
 * Convert a wheel event's deltas into CSS pixels for a given scroller.
 * LINE/PAGE modes are scaled by the caller's line and page heights.
 */
export function wheelDeltaPixels(
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">,
  lineHeightPx: number,
  pageHeightPx: number,
): { x: number; y: number } {
  let { deltaX, deltaY } = event;
  if (event.deltaMode === DELTA_LINE) {
    const line = Math.max(1, lineHeightPx);
    deltaX *= line;
    deltaY *= line;
  } else if (event.deltaMode === DELTA_PAGE) {
    const page = Math.max(1, pageHeightPx);
    deltaX *= page;
    deltaY *= page;
  }
  return { x: deltaX, y: deltaY };
}

export function scaleWheelDelta(pixels: number, speed: number): number {
  return pixels * clampWheelSpeed(speed);
}
