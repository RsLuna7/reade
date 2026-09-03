/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
  findTocScrollParent,
  measureTocIndicator,
  scrollTocLinkIntoView,
  tocScrollBehaviorFromMotion,
} from "./tocActiveIndicator";

function box(partial: Partial<DOMRect>): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    toJSON() {
      return {};
    },
    ...partial,
  };
}

describe("tocActiveIndicator", () => {
  it("measures link position relative to the wrap", () => {
    const wrap = document.createElement("div");
    const link = document.createElement("a");
    vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue(
      box({ top: 100, height: 400, bottom: 500, width: 200, right: 200 }),
    );
    vi.spyOn(link, "getBoundingClientRect").mockReturnValue(
      box({ top: 164, height: 28, bottom: 192, width: 180, right: 180 }),
    );
    expect(measureTocIndicator(wrap, link)).toEqual({ top: 64, height: 28 });
  });

  it("returns null when the link has no layout height", () => {
    const wrap = document.createElement("div");
    const link = document.createElement("a");
    vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue(box({ top: 0 }));
    vi.spyOn(link, "getBoundingClientRect").mockReturnValue(box({ top: 0, height: 0 }));
    expect(measureTocIndicator(wrap, link)).toBeNull();
  });

  it("maps motion levels to scroll behavior", () => {
    expect(tocScrollBehaviorFromMotion("off")).toBe("auto");
    expect(tocScrollBehaviorFromMotion(undefined)).toBe("auto");
    expect(tocScrollBehaviorFromMotion("subtle")).toBe("smooth");
    expect(tocScrollBehaviorFromMotion("full")).toBe("smooth");
  });

  it("scrolls only when the link leaves the padded viewport", () => {
    const parent = document.createElement("div");
    const link = document.createElement("a");
    const scrollBy = vi.fn();
    parent.scrollBy = scrollBy;

    vi.spyOn(parent, "getBoundingClientRect").mockReturnValue(
      box({ top: 100, height: 200, bottom: 300 }),
    );
    vi.spyOn(link, "getBoundingClientRect").mockReturnValue(
      box({ top: 150, height: 28, bottom: 178 }),
    );
    scrollTocLinkIntoView(parent, link, "auto");
    expect(scrollBy).not.toHaveBeenCalled();

    vi.spyOn(link, "getBoundingClientRect").mockReturnValue(
      box({ top: 80, height: 28, bottom: 108 }),
    );
    scrollTocLinkIntoView(parent, link, "smooth");
    expect(scrollBy).toHaveBeenCalledWith({ top: expect.any(Number), behavior: "smooth" });
  });

  it("finds the nearest toc scrollport", () => {
    const panel = document.createElement("aside");
    panel.className = "toc-panel";
    const wrap = document.createElement("div");
    panel.append(wrap);
    document.body.append(panel);
    expect(findTocScrollParent(wrap)).toBe(panel);
    panel.remove();
  });
});
