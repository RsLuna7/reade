import { describe, expect, it } from "vitest";
import {
  clampWheelSpeed,
  isDefaultWheelSpeed,
  scaleWheelDelta,
  WHEEL_SPEED_DEFAULT,
  WHEEL_SPEED_MAX,
  WHEEL_SPEED_MIN,
  wheelDeltaPixels,
} from "./readerWheelSpeed";

describe("clampWheelSpeed", () => {
  it("defaults non-finite values and clamps to the slider range", () => {
    expect(clampWheelSpeed(Number.NaN)).toBe(WHEEL_SPEED_DEFAULT);
    expect(clampWheelSpeed(0)).toBe(WHEEL_SPEED_MIN);
    expect(clampWheelSpeed(10)).toBe(WHEEL_SPEED_MAX);
    expect(clampWheelSpeed(1.24)).toBe(1.2);
    expect(clampWheelSpeed(1.26)).toBe(1.3);
  });
});

describe("isDefaultWheelSpeed", () => {
  it("treats 1x as the native passthrough speed", () => {
    expect(isDefaultWheelSpeed(1)).toBe(true);
    expect(isDefaultWheelSpeed(1.0)).toBe(true);
    expect(isDefaultWheelSpeed(1.5)).toBe(false);
    expect(isDefaultWheelSpeed(0.5)).toBe(false);
  });
});

describe("wheelDeltaPixels", () => {
  it("passes through pixel deltas", () => {
    expect(wheelDeltaPixels({ deltaX: 10, deltaY: -40, deltaMode: 0 }, 20, 400)).toEqual({
      x: 10,
      y: -40,
    });
  });

  it("scales line and page modes", () => {
    expect(wheelDeltaPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 20, 400)).toEqual({
      x: 0,
      y: 60,
    });
    expect(wheelDeltaPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 20, 400)).toEqual({
      x: 0,
      y: 400,
    });
  });
});

describe("scaleWheelDelta", () => {
  it("multiplies pixel deltas by the clamped speed", () => {
    expect(scaleWheelDelta(100, 2)).toBe(200);
    expect(scaleWheelDelta(100, 0.5)).toBe(50);
    expect(scaleWheelDelta(-80, 1.5)).toBe(-120);
  });
});
