import { useEffect, useRef, useState } from "react";
import type { ReaderMotionLevel } from "./motion";

/**
 * Motion helpers for the reading statistics view. Every effect honors the
 * app-wide motion level: "off" renders final states instantly, "subtle"
 * keeps animations short and single-shot, "full" adds staggering.
 */

export interface ChartMotionProps {
  isAnimationActive: boolean;
  animationDuration: number;
  animationBegin: number;
  animationEasing: "ease-out";
}

const SUBTLE_DURATION_MS = 300;
const FULL_DURATION_MS = 650;
const FULL_STAGGER_MS = 80;

/** Props spread onto recharts series (Bar/Line/Area) to gate their animations. */
export function chartMotionProps(level: ReaderMotionLevel, index = 0): ChartMotionProps {
  if (level === "off") {
    return {
      isAnimationActive: false,
      animationDuration: 0,
      animationBegin: 0,
      animationEasing: "ease-out",
    };
  }
  if (level === "subtle") {
    return {
      isAnimationActive: true,
      animationDuration: SUBTLE_DURATION_MS,
      animationBegin: 0,
      animationEasing: "ease-out",
    };
  }
  return {
    isAnimationActive: true,
    animationDuration: FULL_DURATION_MS,
    animationBegin: index * FULL_STAGGER_MS,
    animationEasing: "ease-out",
  };
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Animates a number towards `value` with requestAnimationFrame.
 * With motion off the target value is returned immediately.
 */
export function useCountUp(
  value: number,
  level: ReaderMotionLevel,
  durationMs = 700,
): number {
  const [display, setDisplay] = useState(() => (level === "off" ? value : 0));
  const displayRef = useRef(display);
  displayRef.current = display;

  useEffect(() => {
    if (level === "off") {
      setDisplay(value);
      return;
    }
    const from = displayRef.current;
    if (from === value) return;
    const duration = level === "subtle" ? Math.min(durationMs, 400) : durationMs;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      setDisplay(from + (value - from) * easeOutCubic(progress));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, level, durationMs]);

  return display;
}

/**
 * False on the first render, true one frame later, so CSS transitions can
 * animate widths and offsets from their initial state. Immediately true when
 * motion is off.
 */
export function useEntranceFlag(level: ReaderMotionLevel): boolean {
  const [entered, setEntered] = useState(level === "off");
  useEffect(() => {
    if (entered) return;
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [entered]);
  return level === "off" ? true : entered;
}
