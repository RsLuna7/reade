// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScrollMapMark } from "../lib/scrollMap";
import { ScrollMap } from "./ScrollMap";

afterEach(cleanup);

function mark(overrides: Partial<ScrollMapMark> = {}): ScrollMapMark {
  return {
    kind: "annotation",
    color: "yellow",
    ratio: 0.25,
    label: "标注 · 选中的句子",
    targetId: "a1",
    ...overrides,
  };
}

describe("ScrollMap", () => {
  it("renders one tick per mark with kind/color classes and tooltips", () => {
    const { container } = render(
      <ScrollMap
        marks={[
          mark(),
          mark({ kind: "bookmark", color: null, ratio: 0.5, label: "书签 · 第二章", targetId: "b1" }),
          mark({ kind: "search", color: null, ratio: 0.75, label: "命中 · 片段", targetId: "r1" }),
        ]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("navigation", { name: "文档地图" })).toBeInTheDocument();
    const annotationTick = screen.getByRole("button", { name: "标注 · 选中的句子" });
    expect(annotationTick).toHaveClass("scroll-map-tick--annotation", "scroll-map-tick--yellow");
    expect(annotationTick).toHaveAttribute("title", "标注 · 选中的句子");
    expect(annotationTick.style.top).toBe("25%");
    expect(container.querySelector(".scroll-map-tick--bookmark")).toBeInTheDocument();
    expect(container.querySelector(".scroll-map-tick--search")).toBeInTheDocument();
  });

  it("hands tick clicks to onSelect with the full mark", () => {
    const onSelect = vi.fn();
    const bookmark = mark({ kind: "bookmark" as const, color: null, label: "书签", targetId: "b1" });
    render(<ScrollMap marks={[bookmark]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "书签" }));
    expect(onSelect).toHaveBeenCalledWith(bookmark);
  });

  it("renders nothing when there is no mark", () => {
    const { container } = render(<ScrollMap marks={[]} onSelect={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
