// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  scrollContainerByRatio,
  scrollElementWithinContainer,
  scrollRangeIntoContainer,
  scrollToOffsetWithinElement,
} from "./scroll";

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

describe("vertical writing axis branch (plan-vertical-writing VW-D5)", () => {
  it("maps the ratio onto a negative scrollLeft for vertical containers", () => {
    const container = document.createElement("div");
    container.dataset.writing = "vertical";
    Object.defineProperty(container, "scrollWidth", { value: 1200 });
    Object.defineProperty(container, "clientWidth", { value: 200 });
    let scrollLeft = 0;
    Object.defineProperty(container, "scrollLeft", {
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });
    // vertical-rl 容器的规范 scrollLeft 范围是 [-max, 0]。
    expect(scrollContainerByRatio(container, 0.5)).toBe(true);
    expect(scrollLeft).toBe(-500);
    expect(scrollContainerByRatio(container, 0)).toBe(true);
    expect(scrollLeft).toBe(-0);
  });

  it("delegates element jumps to scrollIntoView in vertical containers", () => {
    const container = document.createElement("div");
    container.dataset.writing = "vertical";
    const target = document.createElement("h2");
    container.append(target);
    document.body.append(container);
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    expect(scrollElementWithinContainer(container, target, "smooth")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      inline: "nearest",
      behavior: "smooth",
    });
    container.remove();
  });

  it("keeps the scrollTop path for horizontal containers", () => {
    const container = document.createElement("div");
    const target = document.createElement("h2");
    container.append(target);
    document.body.append(container);
    Object.defineProperty(container, "scrollTop", { value: 40, writable: true });
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    container.getBoundingClientRect = () =>
      ({ top: 58 }) as DOMRect;
    target.getBoundingClientRect = () =>
      ({ top: 358 }) as DOMRect;
    expect(scrollElementWithinContainer(container, target)).toBe(true);
    expect(container.scrollTop).toBe(340);
    expect(scrollIntoView).not.toHaveBeenCalled();
    container.remove();
  });

  it("delegates range jumps to scrollIntoView in vertical containers", () => {
    const container = document.createElement("div");
    container.dataset.writing = "vertical";
    const target = document.createElement("span");
    target.textContent = "命中";
    container.append(target);
    document.body.append(container);
    const range = document.createRange();
    range.selectNodeContents(target);
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    expect(scrollRangeIntoContainer(container, range, "auto")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      inline: "nearest",
      behavior: "auto",
    });
    container.remove();
  });
});
