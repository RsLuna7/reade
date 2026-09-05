import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyInstantScrollDelta,
  clampWheelSpeed,
  createWheelSpeedController,
  isDefaultWheelSpeed,
  scaleWheelDelta,
  shouldEaseWheelDelta,
  WHEEL_EASE_THRESHOLD_PX,
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

describe("shouldEaseWheelDelta", () => {
  it("eases notch-sized deltas and keeps fine deltas immediate", () => {
    expect(shouldEaseWheelDelta(0, WHEEL_EASE_THRESHOLD_PX)).toBe(true);
    expect(shouldEaseWheelDelta(0, WHEEL_EASE_THRESHOLD_PX - 1)).toBe(false);
    expect(shouldEaseWheelDelta(12, 8)).toBe(false);
  });
});

function makeScroller(scrollTop = 0, scrollLeft = 0) {
  const scroller = {
    style: { scrollBehavior: "smooth" },
    scrollTop,
    scrollLeft,
    scrollHeight: 5000,
    clientHeight: 500,
    scrollWidth: 2000,
    clientWidth: 400,
    listeners: new Map<string, EventListener>(),
    scrollBy(opts: { left?: number; top?: number }) {
      this.scrollTop += opts.top ?? 0;
      this.scrollLeft += opts.left ?? 0;
    },
    addEventListener(type: string, listener: EventListener) {
      this.listeners.set(type, listener);
    },
    removeEventListener(type: string) {
      this.listeners.delete(type);
    },
  };
  return scroller;
}

describe("applyInstantScrollDelta", () => {
  it("prefers scrollBy with instant behavior", () => {
    const scroller = makeScroller(40, 10);
    const calls: unknown[] = [];
    scroller.scrollBy = function scrollBy(opts: { left?: number; top?: number; behavior?: string }) {
      calls.push(opts);
      this.scrollTop += opts.top ?? 0;
      this.scrollLeft += opts.left ?? 0;
    };

    applyInstantScrollDelta(scroller as unknown as HTMLElement, 5, 80);

    expect(calls[0]).toEqual({ left: 5, top: 80, behavior: "instant" });
    expect(scroller.scrollTop).toBe(120);
    expect(scroller.scrollLeft).toBe(15);
  });
});

describe("createWheelSpeedController", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies fine-grained deltas immediately", () => {
    const scroller = makeScroller();
    const controller = createWheelSpeedController(scroller as unknown as HTMLElement);
    controller.push(0, 12);
    expect(scroller.scrollTop).toBe(12);
    controller.destroy();
  });

  it("eases large deltas across animation frames", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    const scroller = makeScroller();
    const controller = createWheelSpeedController(scroller as unknown as HTMLElement);
    controller.push(0, 120);
    expect(scroller.scrollTop).toBe(0);
    expect(frames).toHaveLength(1);

    frames.shift()!(16);
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(scroller.scrollTop).toBeLessThan(120);

    controller.destroy();
  });
});
