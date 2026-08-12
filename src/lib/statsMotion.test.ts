// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chartMotionProps, useCountUp, useEntranceFlag } from "./statsMotion";

describe("chartMotionProps", () => {
  it("disables recharts animation when motion is off", () => {
    expect(chartMotionProps("off")).toMatchObject({
      isAnimationActive: false,
      animationDuration: 0,
    });
  });

  it("keeps subtle animations short without stagger", () => {
    const props = chartMotionProps("subtle", 3);
    expect(props.isAnimationActive).toBe(true);
    expect(props.animationDuration).toBeLessThanOrEqual(300);
    expect(props.animationBegin).toBe(0);
  });

  it("staggers full-motion series by index", () => {
    expect(chartMotionProps("full", 0).animationBegin).toBe(0);
    expect(chartMotionProps("full", 2).animationBegin).toBe(160);
    expect(chartMotionProps("full", 2).animationDuration).toBeGreaterThan(300);
  });
});

describe("useCountUp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the target immediately when motion is off", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useCountUp(value, "off"),
      { initialProps: { value: 120 } },
    );
    expect(result.current).toBe(120);
    rerender({ value: 300 });
    expect(result.current).toBe(300);
  });

  it("animates towards the target and settles on it", () => {
    const { result } = renderHook(() => useCountUp(600, "full", 700));
    expect(result.current).toBe(0);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBe(600);
  });

  it("passes through intermediate values while animating", () => {
    const { result } = renderHook(() => useCountUp(1_000, "full", 700));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(1_000);
  });
});

describe("useEntranceFlag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is true immediately with motion off", () => {
    const { result } = renderHook(() => useEntranceFlag("off"));
    expect(result.current).toBe(true);
  });

  it("flips to true a frame after mount otherwise", () => {
    const { result } = renderHook(() => useEntranceFlag("full"));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toBe(true);
  });
});
