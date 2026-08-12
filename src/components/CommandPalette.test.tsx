// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaletteEntry } from "../lib/commandPalette";
import { CommandPalette } from "./CommandPalette";

afterEach(cleanup);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

const entries: PaletteEntry[] = [
  {
    kind: "document",
    id: "doc:guides/长文阅读.md",
    title: "长文阅读",
    subtitle: "guides/长文阅读.md",
    badge: "MD",
  },
  {
    kind: "document",
    id: "doc:papers/thesis.pdf",
    title: "毕业论文",
    subtitle: "papers/thesis.pdf",
    badge: "PDF",
  },
  { kind: "collection", id: "col:1", title: "考研数学", badge: "合集" },
  {
    kind: "command",
    id: "cmd:theme",
    title: "切换浅色/深色主题",
    keywords: "theme dark light",
    badge: "命令",
  },
];

function setup(open = true) {
  const onExecute = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <CommandPalette open={open} entries={entries} onExecute={onExecute} onClose={onClose} />,
  );
  return { onExecute, onClose, view };
}

describe("CommandPalette", () => {
  it("renders nothing while closed", () => {
    setup(false);
    expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument();
  });

  it("opens with a focused input and the full entry list", () => {
    setup();
    const input = screen.getByRole("combobox", { name: "搜索文档、合集与命令" });
    expect(input).toHaveFocus();
    expect(screen.getAllByRole("option")).toHaveLength(entries.length);
    expect(screen.getByText("合集")).toBeInTheDocument();
    expect(screen.getByText("命令")).toBeInTheDocument();
  });

  it("filters entries as the query changes and shows the empty state", () => {
    setup();
    const input = screen.getByRole("combobox", { name: "搜索文档、合集与命令" });
    fireEvent.change(input, { target: { value: "数学" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /考研数学/ })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "没有这个条目" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("没有匹配的条目")).toBeInTheDocument();
  });

  it("cycles the active option with arrow keys and tracks aria-activedescendant", () => {
    setup();
    const input = screen.getByRole("combobox", { name: "搜索文档、合集与命令" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      "palette-option-doc:guides/长文阅读.md",
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      "palette-option-doc:papers/thesis.pdf",
    );

    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    // 从第 0 项再向上循环到最后一项。
    expect(input).toHaveAttribute("aria-activedescendant", "palette-option-cmd:theme");
  });

  it("executes the active entry on Enter", () => {
    const { onExecute } = setup();
    const input = screen.getByRole("combobox", { name: "搜索文档、合集与命令" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onExecute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "doc:papers/thesis.pdf" }),
    );
  });

  it("executes entries on click", () => {
    const { onExecute } = setup();
    fireEvent.click(screen.getByRole("option", { name: /切换浅色\/深色主题/ }));
    expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ id: "cmd:theme" }));
  });

  it("closes on Escape without letting the event bubble to window", () => {
    const { onClose } = setup();
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);
    const input = screen.getByRole("combobox", { name: "搜索文档、合集与命令" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(windowEscape).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowEscape);
  });

  it("closes when the backdrop is clicked", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "关闭命令面板" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
