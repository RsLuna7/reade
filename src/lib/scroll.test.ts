// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { scrollContainerByRatio, scrollToOffsetWithinElement } from "./scroll";

describe("scroll annotation helpers", () => {
  it("scrolls a container by ratio", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "scrollHeight", { value: 1000 });
    Object.defineProperty(container, "clientHeight", { value: 200 });
    let scrollTop = 0;
    Object.defineProperty(container, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    expect(scrollContainerByRatio(container, 0.5)).toBe(true);
    expect(scrollTop).toBe(400);
  });

  it("scrolls to an offset within a child element", () => {
    const container = document.createElement("div");
    const target = document.createElement("div");
    container.append(target);
    document.body.append(container);
    Object.defineProperty(container, "scrollTop", {
      value: 0,
      writable: true,
    });
    Object.defineProperty(target, "offsetHeight", { value: 400 });
    const containerRect = { top: 0, left: 0, width: 100, height: 200, bottom: 200, right: 100, x: 0, y: 0, toJSON() {} };
    const targetRect = { top: 100, left: 0, width: 100, height: 400, bottom: 500, right: 100, x: 0, y: 100, toJSON() {} };
    container.getBoundingClientRect = () => containerRect as DOMRect;
    target.getBoundingClientRect = () => targetRect as DOMRect;
    expect(scrollToOffsetWithinElement(container, target, 0.25)).toBe(true);
    expect(container.scrollTop).toBe(200);
    container.remove();
  });
});
