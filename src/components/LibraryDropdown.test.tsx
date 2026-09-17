// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryDropdown } from "./LibraryDropdown";

afterEach(cleanup);

const options = [
  { value: "", label: "全部格式" },
  { value: "pdf", label: "PDF" },
  { value: "epub", label: "EPUB" },
];

describe("LibraryDropdown", () => {
  it("focuses the current choice, navigates without selecting, and restores focus on Escape", () => {
    const onChange = vi.fn();
    render(<LibraryDropdown label="格式" value="pdf" options={options} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "格式：PDF" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: "PDF" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: "EPUB" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(screen.getByRole("menuitemradio", { name: "全部格式" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "e" });
    expect(screen.getByRole("menuitemradio", { name: "EPUB" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("selects a choice and exposes the checked state on reopening", () => {
    const onChange = vi.fn();
    const view = render(<LibraryDropdown label="格式" value="" options={options} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "PDF" }));
    expect(onChange).toHaveBeenCalledWith("pdf");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveFocus();
    view.rerender(<LibraryDropdown label="格式" value="pdf" options={options} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("menuitemradio", { name: "PDF" })).toHaveAttribute("aria-checked", "true");
  });

  it("closes on outside pointer, focus departure and Tab without trapping focus", () => {
    render(<><LibraryDropdown label="格式" value="" options={options} onChange={vi.fn()} /><input aria-label="搜索" /></>);
    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.focusIn(screen.getByRole("textbox"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(fireEvent.keyDown(document.activeElement!, { key: "Tab" })).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("offers a separate footer action and closes before invoking it", () => {
    const onClick = vi.fn();
    const onChange = vi.fn();
    render(<LibraryDropdown label="书库范围" value="" options={options} onChange={onChange} action={{ label: "管理书架…", onClick }} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    const action = screen.getByRole("menuitem", { name: "管理书架…" });
    expect(action).toHaveFocus();
    fireEvent.click(action);
    expect(onClick).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
