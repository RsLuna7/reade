/** Reading-pane wheel scroll multiplier (reading-settings slider). */

export const WHEEL_SPEED_MIN = 0.3;
export const WHEEL_SPEED_MAX = 3;
export const WHEEL_SPEED_STEP = 0.1;
export const WHEEL_SPEED_DEFAULT = 1;

/**
 * Pixel deltas at/above this look like mouse-wheel notches and are eased.
 * Smaller deltas (trackpad / precision scroll) apply immediately so they stay responsive.
 */
export const WHEEL_EASE_THRESHOLD_PX = 48;

/** Per-frame blend toward the eased target (mouse notches). */
export const WHEEL_EASE_ALPHA = 0.34;

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

export function shouldEaseWheelDelta(deltaX: number, deltaY: number): boolean {
  return Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= WHEEL_EASE_THRESHOLD_PX;
}

/**
 * Apply a wheel delta without CSS `scroll-behavior: smooth`.
 *
 * `.reading-scroll` uses smooth scrolling for TOC/search jumps. Assigning
 * `scrollTop` under that rule turns each wheel tick into a cancelled smooth
 * animation. Prefer `behavior: "instant"`; fall back to a temporary inline override.
 */
export function applyInstantScrollDelta(
  scroller: HTMLElement,
  deltaX: number,
  deltaY: number,
): void {
  if (deltaX === 0 && deltaY === 0) return;
  if (typeof scroller.scrollBy === "function") {
    try {
      scroller.scrollBy({
        left: deltaX,
        top: deltaY,
        behavior: "instant" as ScrollBehavior,
      });
      return;
    } catch {
      // Older engines may reject "instant".
    }
  }
  const previous = scroller.style.scrollBehavior;
  scroller.style.scrollBehavior = "auto";
  if (deltaY !== 0) scroller.scrollTop += deltaY;
  if (deltaX !== 0) scroller.scrollLeft += deltaX;
  scroller.style.scrollBehavior = previous;
}

export type WheelSpeedController = {
  push(deltaX: number, deltaY: number): void;
  destroy(): void;
};

/**
 * Drives scaled wheel scrolling with better feel than raw scrollTop writes:
 * - fine deltas follow immediately (trackpad stays responsive)
 * - notch-sized deltas ease toward a moving target (mouse feels less abrupt)
 */
export function createWheelSpeedController(scroller: HTMLElement): WheelSpeedController {
  let targetTop = scroller.scrollTop;
  let targetLeft = scroller.scrollLeft;
  let raf: number | null = null;
  let writing = false;
  let destroyed = false;

  const maxTop = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const maxLeft = () => Math.max(0, scroller.scrollWidth - scroller.clientWidth);

  const onScroll = () => {
    if (writing || raf !== null) return;
    targetTop = scroller.scrollTop;
    targetLeft = scroller.scrollLeft;
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });

  const write = (deltaX: number, deltaY: number) => {
    if (deltaX === 0 && deltaY === 0) return;
    writing = true;
    applyInstantScrollDelta(scroller, deltaX, deltaY);
    writing = false;
  };

  const tick = () => {
    raf = null;
    if (destroyed) return;
    const dy = targetTop - scroller.scrollTop;
    const dx = targetLeft - scroller.scrollLeft;
    if (Math.abs(dy) <= 0.5 && Math.abs(dx) <= 0.5) {
      write(dx, dy);
      targetTop = scroller.scrollTop;
      targetLeft = scroller.scrollLeft;
      return;
    }
    write(dx * WHEEL_EASE_ALPHA, dy * WHEEL_EASE_ALPHA);
    raf = requestAnimationFrame(tick);
  };

  return {
    push(deltaX, deltaY) {
      if (destroyed || (deltaX === 0 && deltaY === 0)) return;

      if (raf === null) {
        targetTop = scroller.scrollTop;
        targetLeft = scroller.scrollLeft;
      }

      targetTop = Math.min(maxTop(), Math.max(0, targetTop + deltaY));
      targetLeft = Math.min(maxLeft(), Math.max(0, targetLeft + deltaX));

      if (!shouldEaseWheelDelta(deltaX, deltaY)) {
        write(deltaX, deltaY);
        targetTop = scroller.scrollTop;
        targetLeft = scroller.scrollLeft;
        return;
      }

      if (raf === null) raf = requestAnimationFrame(tick);
    },
    destroy() {
      destroyed = true;
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      scroller.removeEventListener("scroll", onScroll);
    },
  };
}
