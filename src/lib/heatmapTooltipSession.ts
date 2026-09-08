import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** First cell in a pass waits this long so a skim does not pop a chip. */
export const HEATMAP_TOOLTIP_REST_MS = 60;
/** After leaving the calendar, wait before the next pass pays the rest again. */
export const HEATMAP_TOOLTIP_RESET_MS = 200;
/** Open/close motion; skipped once the pass is already showing chips. */
export const HEATMAP_TOOLTIP_MOTION_MS = 125;

function isCalendarCell(target: EventTarget | null): boolean {
  return target instanceof Element && target.tagName.toLowerCase() === "rect";
}

function isInside(host: EventTarget | null, node: EventTarget | null): boolean {
  return host instanceof Element && node instanceof Node && host.contains(node);
}

/**
 * GitHub-style heatmap tooltip session: delay the first chip, then move
 * between cells with no rest and no motion until the pointer leaves the grid.
 */
export function useHeatmapTooltipSession() {
  const [instant, setInstant] = useState(false);
  const instantRef = useRef(false);
  const armRef = useRef<number | null>(null);
  const resetRef = useRef<number | null>(null);

  const clearArm = useCallback(() => {
    if (armRef.current === null) return;
    window.clearTimeout(armRef.current);
    armRef.current = null;
  }, []);

  const clearReset = useCallback(() => {
    if (resetRef.current === null) return;
    window.clearTimeout(resetRef.current);
    resetRef.current = null;
  }, []);

  const onPointerOver = useCallback(
    (event: ReactPointerEvent<Element>) => {
      if (!isCalendarCell(event.target)) return;
      clearReset();
      if (instantRef.current) return;
      clearArm();
      armRef.current = window.setTimeout(() => {
        armRef.current = null;
        instantRef.current = true;
        setInstant(true);
      }, HEATMAP_TOOLTIP_REST_MS);
    },
    [clearArm, clearReset],
  );

  const onPointerOut = useCallback(
    (event: ReactPointerEvent<Element>) => {
      if (!isInside(event.currentTarget, event.relatedTarget)) {
        clearArm();
        clearReset();
        resetRef.current = window.setTimeout(() => {
          resetRef.current = null;
          instantRef.current = false;
          setInstant(false);
        }, HEATMAP_TOOLTIP_RESET_MS);
        return;
      }
      if (instantRef.current) return;
      if (isCalendarCell(event.target) && !isCalendarCell(event.relatedTarget)) {
        clearArm();
      }
    },
    [clearArm, clearReset],
  );

  useEffect(
    () => () => {
      clearArm();
      clearReset();
    },
    [clearArm, clearReset],
  );

  const transitionStyles = useMemo(
    () => ({ duration: instant ? 0 : HEATMAP_TOOLTIP_MOTION_MS }),
    [instant],
  );

  return {
    instant,
    hoverRestMs: instant ? 0 : HEATMAP_TOOLTIP_REST_MS,
    transitionStyles,
    onPointerOver,
    onPointerOut,
  };
}
