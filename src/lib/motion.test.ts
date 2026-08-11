// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { cancelMotion, runMotion } from "./motion";

interface AnimationFixture {
  animation: Animation;
  cancel: ReturnType<typeof vi.fn>;
  dispatch: (type: "finish" | "cancel") => void;
}

function animationFixture(): AnimationFixture {
  const listeners = new Map<string, EventListener>();
  const dispatch = (type: "finish" | "cancel") => {
    listeners.get(type)?.(new Event(type));
  };
  const cancel = vi.fn(() => dispatch("cancel"));
  const animation = {
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      const callback = typeof listener === "function"
        ? listener
        : (event: Event) => listener.handleEvent(event);
      listeners.set(type, callback);
    }),
    cancel,
  } as unknown as Animation;

  return { animation, cancel, dispatch };
}

function elementWithAnimations(...fixtures: AnimationFixture[]): {
  element: HTMLElement;
  animate: ReturnType<typeof vi.fn>;
} {
  const element = document.createElement("div");
  const animate = vi.fn();
  for (const fixture of fixtures) animate.mockReturnValueOnce(fixture.animation);
  Object.defineProperty(element, "animate", { configurable: true, value: animate });
  return { element, animate };
}

describe("runMotion", () => {
  it("does not start WAAPI animations when motion is off", () => {
    const fixture = animationFixture();
    const { element, animate } = elementWithAnimations(fixture);

    const animation = runMotion(element, "notice", [{ opacity: 0 }, { opacity: 1 }], 120, "off");

    expect(animation).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it("cancels and replays only the same element slot", () => {
    const first = animationFixture();
    const second = animationFixture();
    const third = animationFixture();
    const { element, animate } = elementWithAnimations(first, second, third);

    runMotion(element, "notice", [{ opacity: 0 }, { opacity: 1 }], 120, "subtle");
    runMotion(element, "highlight", [{ opacity: 0.5 }, { opacity: 1 }], 120, "subtle");
    runMotion(element, "notice", [{ opacity: 0 }, { opacity: 1 }], 180, "full");

    expect(animate).toHaveBeenCalledTimes(3);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.cancel).not.toHaveBeenCalled();
    expect(third.cancel).not.toHaveBeenCalled();
  });

  it("returns the active animation and exposes per-slot manual cancellation", () => {
    const fixture = animationFixture();
    const { element } = elementWithAnimations(fixture);
    const animation = runMotion(element, "notice", [{ opacity: 0 }, { opacity: 1 }], 120, "subtle");

    expect(animation).toBe(fixture.animation);
    cancelMotion(element, "notice");
    cancelMotion(element, "notice");

    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("cancels every active slot for component cleanup", () => {
    const first = animationFixture();
    const second = animationFixture();
    const { element } = elementWithAnimations(first, second);
    runMotion(element, "notice", [{ opacity: 0 }, { opacity: 1 }], 120, "subtle");
    runMotion(element, "highlight", [{ opacity: 0 }, { opacity: 1 }], 120, "subtle");

    cancelMotion(element);
    cancelMotion(element);

    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.cancel).toHaveBeenCalledOnce();
  });

  it("forgets completed animations instead of cancelling them on the next run", () => {
    const first = animationFixture();
    const second = animationFixture();
    const { element } = elementWithAnimations(first, second);
    runMotion(element, "notice", [{ opacity: 0 }, { opacity: 1 }], 120, "subtle");

    first.dispatch("finish");
    runMotion(element, "notice", [{ opacity: 0 }, { opacity: 1 }], 120, "subtle");

    expect(first.cancel).not.toHaveBeenCalled();
  });

  it("stops an already-running slot when the level changes to off", () => {
    const fixture = animationFixture();
    const { element, animate } = elementWithAnimations(fixture);
    runMotion(element, "notice", [{ opacity: 0 }, { opacity: 1 }], 120, "full");

    runMotion(element, "notice", [{ opacity: 0 }, { opacity: 1 }], 120, "off");

    expect(animate).toHaveBeenCalledOnce();
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });
});
