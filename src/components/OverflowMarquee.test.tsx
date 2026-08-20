// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverflowMarquee, armOverflowMarquee, disarmOverflowMarquee } from "./OverflowMarquee";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-motion");
});

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

describe("OverflowMarquee", () => {
  it("renders the full title text", () => {
    const { container } = render(
      <div>
        <OverflowMarquee>挪威的森林（村上春树）</OverflowMarquee>
      </div>,
    );
    expect(container.querySelector(".overflow-marquee__text")?.textContent).toBe(
      "挪威的森林（村上春树）",
    );
  });

  it("arms a marquee only when the title overflows", () => {
    const { container } = render(
      <button type="button">
        <OverflowMarquee>很长很长的文档标题需要滚动才能看完</OverflowMarquee>
      </button>,
    );
    const root = container.querySelector("button")!;
    const wrap = container.querySelector(".overflow-marquee") as HTMLElement;
    const text = container.querySelector(".overflow-marquee__text") as HTMLElement;
    Object.defineProperty(wrap, "clientWidth", { configurable: true, value: 80 });
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 240 });

    armOverflowMarquee(root);
    expect(wrap.classList.contains("is-overflowing")).toBe(true);
    expect(wrap.style.getPropertyValue("--marquee-shift")).toBe("-160px");
    expect(wrap.style.getPropertyValue("--marquee-duration")).toBe("13.33s");

    disarmOverflowMarquee(root);
    expect(wrap.classList.contains("is-overflowing")).toBe(false);
  });

  it("does not marquee when motion is off", () => {
    document.documentElement.dataset.motion = "off";
    const { container } = render(
      <button type="button">
        <OverflowMarquee>很长很长的文档标题</OverflowMarquee>
      </button>,
    );
    const root = container.querySelector("button")!;
    const wrap = container.querySelector(".overflow-marquee") as HTMLElement;
    const text = container.querySelector(".overflow-marquee__text") as HTMLElement;
    Object.defineProperty(wrap, "clientWidth", { configurable: true, value: 80 });
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 240 });

    armOverflowMarquee(root);
    expect(wrap.classList.contains("is-overflowing")).toBe(false);
  });

  it("does not marquee when the title fits", () => {
    const { container } = render(
      <button type="button">
        <OverflowMarquee>短标题</OverflowMarquee>
      </button>,
    );
    const root = container.querySelector("button")!;
    const wrap = container.querySelector(".overflow-marquee") as HTMLElement;
    const text = container.querySelector(".overflow-marquee__text") as HTMLElement;
    Object.defineProperty(wrap, "clientWidth", { configurable: true, value: 120 });
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 48 });

    armOverflowMarquee(root);
    expect(wrap.classList.contains("is-overflowing")).toBe(false);
  });

  it("keeps the same pixel speed for short and long overflow", () => {
    const { container, rerender } = render(
      <button type="button">
        <OverflowMarquee>短溢出标题</OverflowMarquee>
      </button>,
    );
    const root = container.querySelector("button")!;
    const wrap = () => container.querySelector(".overflow-marquee") as HTMLElement;
    const text = () => container.querySelector(".overflow-marquee__text") as HTMLElement;

    Object.defineProperty(wrap(), "clientWidth", { configurable: true, value: 80 });
    Object.defineProperty(text(), "scrollWidth", { configurable: true, value: 120 });
    armOverflowMarquee(root);
    const shortDuration = Number.parseFloat(wrap().style.getPropertyValue("--marquee-duration"));

    rerender(
      <button type="button">
        <OverflowMarquee>很长很长很长很长的文档标题需要滚动才能看完</OverflowMarquee>
      </button>,
    );
    Object.defineProperty(wrap(), "clientWidth", { configurable: true, value: 80 });
    Object.defineProperty(text(), "scrollWidth", { configurable: true, value: 200 });
    armOverflowMarquee(root);
    const longDuration = Number.parseFloat(wrap().style.getPropertyValue("--marquee-duration"));

    expect(shortDuration).toBeCloseTo(3.33, 1);
    expect(longDuration).toBeCloseTo(shortDuration * 3, 1);
  });
});
