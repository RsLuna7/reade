// @vitest-environment jsdom

import "../test/setup";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandCompanion } from "./BrandCompanion";

describe("BrandCompanion", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 16) as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      window.clearTimeout(id);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("draws two eyes inside the brand mark svg", () => {
    const { container } = render(<BrandCompanion motionLevel="off" />);
    const svg = container.querySelector("svg.brand-companion");
    const eyes = container.querySelectorAll("ellipse.brand-companion-eye");

    expect(svg).toBeTruthy();
    expect(eyes).toHaveLength(2);
    expect(svg).toHaveAttribute("data-gaze", "rest");
  });

  it("looks at the pointer, then rests after idle", () => {
    vi.useFakeTimers();
    const { container } = render(<BrandCompanion motionLevel="subtle" />);
    const svg = container.querySelector("svg.brand-companion")!;

    act(() => {
      window.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 40, clientY: 40, bubbles: true }),
      );
    });
    expect(svg).toHaveAttribute("data-gaze", "pointer");

    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(svg).toHaveAttribute("data-gaze", "rest");
  });

  it("unmounts while the gaze loop is armed", () => {
    const { unmount } = render(<BrandCompanion motionLevel="subtle" />);
    expect(() => unmount()).not.toThrow();
  });
});
