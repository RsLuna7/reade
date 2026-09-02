// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FindBar } from "./FindBar";

describe("FindBar", () => {
  it("navigates with Enter and closes on Escape", () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onClose = vi.fn();
    render(
      <FindBar
        query="term"
        activeIndex={1}
        matchCount={4}
        status="ready"
        inputRef={{ current: null }}
        onQueryChange={() => undefined}
        onPrevious={onPrevious}
        onNext={onNext}
        onClose={onClose}
      />,
    );

    const input = screen.getByRole("searchbox", { name: "查找内容" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onPrevious).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
