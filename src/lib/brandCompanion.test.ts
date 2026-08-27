import { describe, expect, it } from "vitest";
import {
  BLINK_DURATION_MS,
  BLINK_SCALE,
  DEFAULT_REST_GAZE,
  blinkScaleAt,
  createGazeState,
  eyesTransform,
  followUpBlinkAt,
  gazePixels,
  gazeTargetFromPointer,
  isBlinking,
  isGazeSettled,
  needsAnimationFrame,
  nextBlinkAt,
  restFocusPoint,
  stepGaze,
} from "./brandCompanion";

describe("gazeTargetFromPointer", () => {
  it("normalizes and clamps pointer offset around the face", () => {
    expect(gazeTargetFromPointer(220, 180, 0, 0)).toEqual({ x: 1, y: 1 });
    expect(gazeTargetFromPointer(-400, 0, 0, 0).x).toBe(-1);
    expect(gazeTargetFromPointer(110, 90, 0, 0)).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("restFocusPoint", () => {
  it("aims at the upper reading column, not the rectangle center", () => {
    const focus = restFocusPoint({ left: 300, top: 40, width: 700, height: 800 });
    expect(focus.x).toBeCloseTo(496);
    expect(focus.y).toBeLessThan(40 + 800 * 0.5);
    expect(gazeTargetFromPointer(focus.x, focus.y, 40, 40).x).toBeGreaterThan(0.5);
  });
});

describe("stepGaze", () => {
  it("snaps to rest when motion is off", () => {
    const state = createGazeState();
    state.x = 0.8;
    state.vx = 2;
    stepGaze(state, 1, 1, 0.016, "off");
    expect(state).toEqual(createGazeState());
  });

  it("moves toward the target instead of snapping", () => {
    const state = createGazeState();
    stepGaze(state, 1, 0, 0.016, "subtle");
    expect(state.x).toBeGreaterThan(0);
    expect(state.x).toBeLessThan(0.2);
    for (let i = 0; i < 80; i += 1) {
      stepGaze(state, 1, 0, 0.016, "subtle");
    }
    expect(state.x).toBeGreaterThan(0.85);
  });
});

describe("gazePixels", () => {
  it("maps normalized gaze into a small pixel travel", () => {
    const pixels = gazePixels({ x: 1, y: -1, vx: 0, vy: 0 });
    expect(pixels.x).toBeCloseTo(3.05);
    expect(pixels.y).toBeCloseTo(-2.15);
  });
});

describe("blinkScaleAt", () => {
  it("stays open outside a blink", () => {
    expect(blinkScaleAt(100, 0)).toBe(1);
    expect(blinkScaleAt(100, 100 - BLINK_DURATION_MS)).toBe(1);
  });

  it("closes faster than it opens", () => {
    const startedAt = 1000;
    const closeEnd = BLINK_DURATION_MS * 0.22;
    const halfClose = blinkScaleAt(startedAt + closeEnd * 0.5, startedAt);
    expect(halfClose).toBeLessThan(0.12 + (1 - 0.12) * 0.5);
    expect(halfClose).toBeGreaterThan(BLINK_SCALE);

    const openStart = BLINK_DURATION_MS * 0.34;
    const halfOpen = blinkScaleAt(
      startedAt + openStart + (BLINK_DURATION_MS - openStart) * 0.5,
      startedAt,
    );
    expect(halfOpen).toBeLessThan(BLINK_SCALE + (1 - BLINK_SCALE) * 0.5);
  });

  it("is fully closed through the hold", () => {
    expect(blinkScaleAt(1000 + BLINK_DURATION_MS * 0.28, 1000)).toBe(BLINK_SCALE);
  });
});

describe("blink cadence", () => {
  it("never schedules a blink when motion is off", () => {
    expect(nextBlinkAt(0, "off")).toBe(Number.POSITIVE_INFINITY);
    expect(followUpBlinkAt(0, "off", () => 0)).toBeNull();
  });

  it("uses the injected rng so blink cadence is testable", () => {
    expect(nextBlinkAt(1000, "full", () => 0)).toBe(3400);
    expect(nextBlinkAt(1000, "subtle", () => 1)).toBe(10200);
  });

  it("sometimes chains a second blink after the first finishes", () => {
    expect(followUpBlinkAt(1000, "full", () => 0)).toBe(1000 + BLINK_DURATION_MS + 80);
    expect(followUpBlinkAt(1000, "full", () => 1)).toBeNull();
  });

  it("reports an active blink only while the envelope runs", () => {
    expect(isBlinking(1000, 0)).toBe(false);
    expect(isBlinking(1100, 1000)).toBe(true);
    expect(isBlinking(1000 + BLINK_DURATION_MS, 1000)).toBe(false);
  });
});

describe("settling and loop", () => {
  it("treats a still gaze at the rest target as settled", () => {
    const state = { ...DEFAULT_REST_GAZE, vx: 0, vy: 0 };
    expect(isGazeSettled(state, DEFAULT_REST_GAZE.x, DEFAULT_REST_GAZE.y, 1)).toBe(true);
    expect(isGazeSettled(state, DEFAULT_REST_GAZE.x, DEFAULT_REST_GAZE.y, 0.5)).toBe(false);
  });

  it("keeps the frame loop only while hidden is false and something is moving", () => {
    expect(needsAnimationFrame({ hidden: true, blinking: true, settled: false })).toBe(false);
    expect(needsAnimationFrame({ hidden: false, blinking: true, settled: true })).toBe(true);
    expect(needsAnimationFrame({ hidden: false, blinking: false, settled: true })).toBe(false);
    expect(needsAnimationFrame({ hidden: false, blinking: false, settled: false })).toBe(true);
  });
});

describe("eyesTransform", () => {
  it("writes a CSS transform from gaze and blink", () => {
    expect(eyesTransform({ x: 1, y: 0, vx: 0, vy: 0 }, 0.12)).toBe(
      "translate(3.05px, 0.00px) scale(1, 0.12)",
    );
  });
});
