import type { ReaderMotionLevel } from "./motion";

export type GazeState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

export const GAZE_TRAVEL_X = 3.05;
export const GAZE_TRAVEL_Y = 2.15;
export const BLINK_SCALE = 0.12;
export const BLINK_DURATION_MS = 260;
export const IDLE_REST_MS = 1800;
export const DEFAULT_REST_GAZE = { x: 0.68, y: 0.16 };

const CLOSE_END = 0.22;
const HOLD_END = 0.34;

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function createGazeState(): GazeState {
  return { x: 0, y: 0, vx: 0, vy: 0 };
}

export function gazeTargetFromPointer(
  pointerX: number,
  pointerY: number,
  originX: number,
  originY: number,
): { x: number; y: number } {
  return {
    x: clamp((pointerX - originX) / 220, -1, 1),
    y: clamp((pointerY - originY) / 180, -1, 1),
  };
}

export function restFocusPoint(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): { x: number; y: number } {
  return {
    x: rect.left + rect.width * 0.28,
    y: rect.top + Math.min(Math.max(rect.height * 0.18, 48), 180),
  };
}

export function stepGaze(
  state: GazeState,
  targetX: number,
  targetY: number,
  dtSeconds: number,
  level: ReaderMotionLevel,
): void {
  if (level === "off") {
    state.x = 0;
    state.y = 0;
    state.vx = 0;
    state.vy = 0;
    return;
  }

  const dt = Math.min(0.032, Math.max(0, dtSeconds));
  const stiffness = level === "full" ? 56 : 38;
  const damping = level === "full" ? 12 : 16;
  state.vx += (targetX - state.x) * stiffness * dt;
  state.vy += (targetY - state.y) * stiffness * dt;
  const decay = Math.exp(-damping * dt);
  state.vx *= decay;
  state.vy *= decay;
  state.x += state.vx * dt;
  state.y += state.vy * dt;
}

export function gazePixels(state: GazeState): { x: number; y: number } {
  return {
    x: state.x * GAZE_TRAVEL_X,
    y: state.y * GAZE_TRAVEL_Y,
  };
}

export function blinkScaleAt(now: number, startedAt: number): number {
  if (startedAt <= 0) return 1;
  const t = (now - startedAt) / BLINK_DURATION_MS;
  if (t <= 0 || t >= 1) return 1;
  if (t < CLOSE_END) {
    const u = t / CLOSE_END;
    const eased = 1 - (1 - u) ** 3;
    return 1 - (1 - BLINK_SCALE) * eased;
  }
  if (t < HOLD_END) return BLINK_SCALE;
  const u = (t - HOLD_END) / (1 - HOLD_END);
  return BLINK_SCALE + (1 - BLINK_SCALE) * (u * u);
}

export function isBlinking(now: number, startedAt: number): boolean {
  return startedAt > 0 && now - startedAt < BLINK_DURATION_MS;
}

export function nextBlinkAt(
  now: number,
  level: ReaderMotionLevel,
  random: () => number = Math.random,
): number {
  if (level === "off") return Number.POSITIVE_INFINITY;
  const minimum = level === "full" ? 2400 : 3600;
  const span = level === "full" ? 4200 : 5600;
  return now + minimum + random() * span;
}

export function followUpBlinkAt(
  startedAt: number,
  level: ReaderMotionLevel,
  random: () => number = Math.random,
): number | null {
  if (level === "off") return null;
  const chance = level === "full" ? 0.2 : 0.12;
  if (random() >= chance) return null;
  return startedAt + BLINK_DURATION_MS + 80 + random() * 50;
}

export function isGazeSettled(
  state: GazeState,
  targetX: number,
  targetY: number,
  scaleY: number,
): boolean {
  return (
    Math.abs(state.x - targetX) < 0.02 &&
    Math.abs(state.y - targetY) < 0.02 &&
    Math.abs(state.vx) < 0.08 &&
    Math.abs(state.vy) < 0.08 &&
    scaleY > 0.98
  );
}

export function needsAnimationFrame(input: {
  hidden: boolean;
  blinking: boolean;
  settled: boolean;
}): boolean {
  if (input.hidden) return false;
  if (input.blinking) return true;
  return !input.settled;
}

export function eyesTransform(state: GazeState, scaleY: number): string {
  const { x, y } = gazePixels(state);
  return `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(1, ${scaleY})`;
}
