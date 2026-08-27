import { describe, expect, it } from "vitest";
import {
  blinkScale,
  createGazeState,
  eyesTransform,
  gazePixels,
  gazeTargetFromPointer,
  nextBlinkAt,
  stepGaze,
} from "./brandCompanion";

describe("gazeTargetFromPointer", () => {
  it("normalizes and clamps pointer offset around the face", () => {
    expect(gazeTargetFromPointer(220, 180, 0, 0)).toEqual({ x: 1, y: 1 });
    expect(gazeTargetFromPointer(-400, 0, 0, 0).x).toBe(-1);
    expect(gazeTargetFromPointer(110, 90, 0, 0)).toEqual({ x: 0.5, y: 0.5 });
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

describe("blink", () => {
  it("squeezes eyes only while a blink is active", () => {
    expect(blinkScale(100, 90)).toBe(1);
    expect(blinkScale(80, 90)).toBe(0.12);
  });

  it("never schedules a blink when motion is off", () => {
    expect(nextBlinkAt(0, "off")).toBe(Number.POSITIVE_INFINITY);
  });

  it("uses the injected rng so blink cadence is testable", () => {
    expect(nextBlinkAt(1000, "full", () => 0)).toBe(3400);
    expect(nextBlinkAt(1000, "subtle", () => 1)).toBe(10200);
  });
});

describe("eyesTransform", () => {
  it("writes a CSS transform from gaze and blink", () => {
    expect(eyesTransform({ x: 1, y: 0, vx: 0, vy: 0 }, 0.12)).toBe(
      "translate(3.05px, 0.00px) scale(1, 0.12)",
    );
  });
});
