// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEATMAP_TOOLTIP_RESET_MS,
  HEATMAP_TOOLTIP_REST_MS,
  useHeatmapTooltipSession,
} from "./heatmapTooltipSession";

function svgRect(): SVGRectElement {
  return document.createElementNS("http://www.w3.org/2000/svg", "rect");
}

function pointerEvent(
  target: EventTarget,
  relatedTarget: EventTarget | null = null,
  currentTarget: EventTarget = target,
): ReactPointerEvent<Element> {
  return {
    target,
    relatedTarget,
    currentTarget,
  } as ReactPointerEvent<Element>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useHeatmapTooltipSession", () => {
  it("keeps the rest delay until a cell is actually hovered for the rest window", () => {
    const { result } = renderHook(() => useHeatmapTooltipSession());
    const cell = svgRect();

    act(() => {
      result.current.onPointerOver(pointerEvent(cell));
      vi.advanceTimersByTime(HEATMAP_TOOLTIP_REST_MS - 1);
    });
    expect(result.current.instant).toBe(false);
    expect(result.current.hoverRestMs).toBe(HEATMAP_TOOLTIP_REST_MS);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.instant).toBe(true);
    expect(result.current.hoverRestMs).toBe(0);
    expect(result.current.transitionStyles.duration).toBe(0);
  });

  it("restarts the first rest when skimming to another cell before the chip opens", () => {
    const { result } = renderHook(() => useHeatmapTooltipSession());
    const first = svgRect();
    const second = svgRect();
    const host = document.createElement("div");
    host.append(first, second);

    act(() => {
      result.current.onPointerOver(pointerEvent(first, null, host));
      vi.advanceTimersByTime(HEATMAP_TOOLTIP_REST_MS - 10);
      result.current.onPointerOut(pointerEvent(first, second, host));
      result.current.onPointerOver(pointerEvent(second, first, host));
      vi.advanceTimersByTime(HEATMAP_TOOLTIP_REST_MS - 10);
    });
    expect(result.current.instant).toBe(false);

    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(result.current.instant).toBe(true);
  });

  it("cancels the first rest when the pointer leaves a cell for the grid gap", () => {
    const { result } = renderHook(() => useHeatmapTooltipSession());
    const cell = svgRect();
    const host = document.createElement("div");
    const gap = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    host.append(cell, gap);

    act(() => {
      result.current.onPointerOver(pointerEvent(cell, null, host));
      vi.advanceTimersByTime(HEATMAP_TOOLTIP_REST_MS - 10);
      result.current.onPointerOut(pointerEvent(cell, gap, host));
      vi.advanceTimersByTime(HEATMAP_TOOLTIP_REST_MS);
    });
    expect(result.current.instant).toBe(false);
  });

  it("stays instant while moving between cells, then resets after leaving the host", () => {
    const { result } = renderHook(() => useHeatmapTooltipSession());
    const first = svgRect();
    const second = svgRect();
    const host = document.createElement("div");
    host.append(first, second);

    act(() => {
      result.current.onPointerOver(pointerEvent(first, null, host));
      vi.advanceTimersByTime(HEATMAP_TOOLTIP_REST_MS);
      result.current.onPointerOut(pointerEvent(first, second, host));
      result.current.onPointerOver(pointerEvent(second, first, host));
    });
    expect(result.current.instant).toBe(true);
    expect(result.current.hoverRestMs).toBe(0);

    act(() => {
      result.current.onPointerOut(pointerEvent(second, document.body, host));
      vi.advanceTimersByTime(HEATMAP_TOOLTIP_RESET_MS - 1);
    });
    expect(result.current.instant).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.instant).toBe(false);
    expect(result.current.hoverRestMs).toBe(HEATMAP_TOOLTIP_REST_MS);
  });

  it("keeps the instant pass if the pointer returns before the reset window", () => {
    const { result } = renderHook(() => useHeatmapTooltipSession());
    const cell = svgRect();
    const host = document.createElement("div");
    host.append(cell);

    act(() => {
      result.current.onPointerOver(pointerEvent(cell, null, host));
      vi.advanceTimersByTime(HEATMAP_TOOLTIP_REST_MS);
      result.current.onPointerOut(pointerEvent(cell, document.body, host));
      vi.advanceTimersByTime(HEATMAP_TOOLTIP_RESET_MS - 20);
      result.current.onPointerOver(pointerEvent(cell, document.body, host));
      vi.advanceTimersByTime(HEATMAP_TOOLTIP_RESET_MS);
    });
    expect(result.current.instant).toBe(true);
  });

  it("does not leak timers after unmount", () => {
    const { result, unmount } = renderHook(() => useHeatmapTooltipSession());
    const cell = svgRect();
    act(() => {
      result.current.onPointerOver(pointerEvent(cell));
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(HEATMAP_TOOLTIP_REST_MS + HEATMAP_TOOLTIP_RESET_MS);
    });
  });
});
