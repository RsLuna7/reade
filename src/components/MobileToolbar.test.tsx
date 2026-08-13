// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileToolbar } from "./MobileToolbar";

afterEach(cleanup);

function renderToolbar(overrides: Partial<Parameters<typeof MobileToolbar>[0]> = {}) {
  const props = {
    hidden: false,
    themeMode: "light" as const,
    hasDocument: true,
    onOpenLibrary: vi.fn(),
    onOpenToc: vi.fn(),
    onFocusSearch: vi.fn(),
    onToggleTheme: vi.fn(),
    onOpenMore: vi.fn(),
    ...overrides,
  };
  render(<MobileToolbar {...props} />);
  return props;
}

describe("MobileToolbar", () => {
  it("offers the five core actions and forwards clicks", () => {
    const props = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "文档" }));
    fireEvent.click(screen.getByRole("button", { name: "目录" }));
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.click(screen.getByRole("button", { name: "切换到深色主题" }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作（命令面板）" }));
    expect(props.onOpenLibrary).toHaveBeenCalledTimes(1);
    expect(props.onOpenToc).toHaveBeenCalledTimes(1);
    expect(props.onFocusSearch).toHaveBeenCalledTimes(1);
    expect(props.onToggleTheme).toHaveBeenCalledTimes(1);
    expect(props.onOpenMore).toHaveBeenCalledTimes(1);
  });

  it("disables the toc entry without a document and reflects scroll hiding", () => {
    renderToolbar({ hasDocument: false, hidden: true, themeMode: "dark" });
    expect(screen.getByRole("button", { name: "目录" })).toBeDisabled();
    expect(screen.getByRole("navigation", { name: "移动端快捷工具条" })).toHaveAttribute(
      "data-hidden",
      "true",
    );
    expect(screen.getByRole("button", { name: "切换到浅色主题" })).toBeInTheDocument();
  });
});
