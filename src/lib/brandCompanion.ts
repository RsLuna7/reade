import type { ReaderMotionLevel } from "./motion";

export type GazeState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

export const GAZE_TRAVEL_X = 3.05;
export const GAZE_TRAVEL_Y = 2.15;
export const BLINK_MS = 90;
export const BLINK_SCALE = 0.12;

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

export function blinkScale(now: number, blinkUntil: number): number {
  return now < blinkUntil ? BLINK_SCALE : 1;
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

export function eyesTransform(state: GazeState, scaleY: number): string {
  const { x, y } = gazePixels(state);
  return `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(1, ${scaleY})`;
}
