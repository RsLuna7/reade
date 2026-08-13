// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HoverPreviewState } from "../lib/useHoverPreview";
import { HoverPreviewCard } from "./HoverPreviewCard";

afterEach(cleanup);

function documentPreview(
  overrides: Partial<Extract<HoverPreviewState["data"], { kind: "document" }>> = {},
  position: Partial<Pick<HoverPreviewState, "x" | "y" | "placement">> = {},
): HoverPreviewState {
  return {
    data: {
      kind: "document",
      status: "ready",
      targetPath: "notes/target.md",
      fragment: null,
      href: "./target.md",
      title: "目标文档",
      format: "markdown",
      excerpt: "第一段内容。\n第二段内容。",
      pdfPages: null,
      indexStatus: "ready",
      error: null,
      ...overrides,
    },
    x: 40,
    y: 80,
    placement: "below",
    ...position,
  };
}

describe("HoverPreviewCard", () => {
  it("renders a ready document preview as plain text with an open action", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <HoverPreviewCard
        preview={documentPreview({
          excerpt: "**加粗**与<b>标签</b>都按字面显示",
        })}
        onOpen={onOpen}
        onHold={vi.fn()}
        onRelease={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "链接预览" })).toBeInTheDocument();
    expect(screen.getByText("目标文档")).toBeInTheDocument();
    // 纯文本红线:摘录中的 HTML 字面量绝不进入标签结构。
    expect(container.querySelector(".hover-preview-excerpt b")).toBeNull();
    expect(screen.getByText(/加粗.*标签.*字面显示/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开 →" }));
    expect(onOpen).toHaveBeenCalledWith("./target.md");
  });

  it("shows the PDF page badge and the fragment line", () => {
    render(
      <HoverPreviewCard
        preview={documentPreview({
          format: "pdf",
          pdfPages: 42,
          fragment: "5",
          excerpt: "第五页文本",
        })}
        onOpen={vi.fn()}
        onHold={vi.fn()}
        onRelease={vi.fn()}
      />,
    );
    expect(screen.getByText("共 42 页")).toBeInTheDocument();
    expect(screen.getByText("# 5")).toBeInTheDocument();
    expect(screen.getByText("PDF")).toBeInTheDocument();
  });

  it("explains empty excerpts by index status", () => {
    render(
      <HoverPreviewCard
        preview={documentPreview({ excerpt: "", indexStatus: "indexing" })}
        onOpen={vi.fn()}
        onHold={vi.fn()}
        onRelease={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("索引尚未就绪，暂无预览。");
  });

  it("shows loading and error states", () => {
    const view = render(
      <HoverPreviewCard
        preview={documentPreview({ status: "loading", excerpt: "" })}
        onOpen={vi.fn()}
        onHold={vi.fn()}
        onRelease={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在加载预览…");
    view.unmount();

    render(
      <HoverPreviewCard
        preview={documentPreview({ status: "error", error: "预览加载失败", excerpt: "" })}
        onOpen={vi.fn()}
        onHold={vi.fn()}
        onRelease={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("预览加载失败");
  });

  it("renders footnote previews without an open action", () => {
    render(
      <HoverPreviewCard
        preview={{
          data: { kind: "footnote", text: "脚注正文内容" },
          x: 0,
          y: 0,
          placement: "below",
        }}
        onOpen={vi.fn()}
        onHold={vi.fn()}
        onRelease={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "脚注预览" })).toBeInTheDocument();
    expect(screen.getByText("脚注正文内容")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the card open while hovered and releases on leave", () => {
    const onHold = vi.fn();
    const onRelease = vi.fn();
    render(
      <HoverPreviewCard
        preview={documentPreview()}
        onOpen={vi.fn()}
        onHold={onHold}
        onRelease={onRelease}
      />,
    );
    const card = screen.getByRole("dialog", { name: "链接预览" });
    fireEvent.pointerEnter(card);
    expect(onHold).toHaveBeenCalledTimes(1);
    fireEvent.pointerLeave(card);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });
});
