// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "../lib/backend";
import {
  AnnotationEditBubble,
  AnnotationLibraryPanel,
  AnnotationList,
  SelectionToolbar,
} from "./AnnotationUi";

afterEach(cleanup);

function highlight(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann-1",
    relativePath: "guide.md",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "选中的文本",
    title: "选中的文本",
    locator: { kind: "markdown", quote: "选中的文本", prefix: "", suffix: "", headingId: null },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("SelectionToolbar", () => {
  const baseProps = {
    open: true,
    x: 10,
    y: 10,
    color: "yellow" as const,
    onPickColor: vi.fn(),
    onHighlight: vi.fn(),
    onUnderline: vi.fn(),
    onAddNote: vi.fn(),
    onBookmark: vi.fn(),
    onClose: vi.fn(),
    canHighlight: true,
  };

  it("offers highlight, underline, note and bookmark actions", () => {
    const onUnderline = vi.fn();
    render(<SelectionToolbar {...baseProps} onUnderline={onUnderline} />);
    expect(screen.getByRole("button", { name: "高亮" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "笔记" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "书签" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下划线" }));
    expect(onUnderline).toHaveBeenCalledTimes(1);
  });

  it("applies a highlight directly when a color swatch is clicked", () => {
    const onPickColor = vi.fn();
    render(<SelectionToolbar {...baseProps} onPickColor={onPickColor} />);
    fireEvent.click(screen.getByRole("button", { name: "以绿色高亮" }));
    expect(onPickColor).toHaveBeenCalledWith("green");
  });

  it("uses Chinese color names for every swatch", () => {
    render(<SelectionToolbar {...baseProps} />);
    for (const name of ["以黄色高亮", "以绿色高亮", "以蓝色高亮", "以粉色高亮"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });
});

describe("AnnotationEditBubble", () => {
  const baseProps = {
    annotation: highlight(),
    x: 20,
    y: 20,
    onChangeColor: vi.fn(),
    onEditNote: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  };

  it("renders as a Chinese-labelled dialog with color, note and delete actions", () => {
    const onChangeColor = vi.fn();
    const onDelete = vi.fn();
    render(<AnnotationEditBubble {...baseProps} onChangeColor={onChangeColor} onDelete={onDelete} />);
    expect(screen.getByRole("dialog", { name: "编辑标注" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "改为蓝色" }));
    expect(onChangeColor).toHaveBeenCalledWith(baseProps.annotation, "blue");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onDelete).toHaveBeenCalledWith(baseProps.annotation);
  });

  it("hides color swatches for bookmarks", () => {
    render(
      <AnnotationEditBubble
        {...baseProps}
        annotation={highlight({
          kind: "bookmark",
          color: null,
          locator: {
            kind: "bookmark",
            target: { format: "markdown", headingId: null, scrollRatio: 0 },
          },
        })}
      />,
    );
    expect(screen.queryByRole("group", { name: "更改颜色" })).not.toBeInTheDocument();
  });

  it("closes on Escape and on outside pointerdown", () => {
    const onClose = vi.fn();
    render(<AnnotationEditBubble {...baseProps} onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.pointerDown(screen.getByRole("dialog", { name: "编辑标注" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("AnnotationList", () => {
  const baseProps = {
    annotations: [highlight()],
    brokenIds: new Set<string>(),
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onEditNote: vi.fn(),
    onChangeColor: vi.fn(),
    onClearAll: vi.fn(),
  };

  it("switches between time and position sorting", () => {
    const onSortChange = vi.fn();
    render(<AnnotationList {...baseProps} sort="time" onSortChange={onSortChange} />);
    const timeButton = screen.getByRole("button", { name: "按时间" });
    expect(timeButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "按位置" }));
    expect(onSortChange).toHaveBeenCalledWith("position");
  });

  it("exposes an export action and Chinese recolor labels", () => {
    const onExport = vi.fn();
    render(<AnnotationList {...baseProps} onExport={onExport} />);
    fireEvent.click(screen.getByRole("button", { name: "导出本文档" }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "改为粉色" })).toBeInTheDocument();
  });
});

describe("AnnotationLibraryPanel", () => {
  const groups = [
    {
      path: "a/guide.md",
      title: "使用指南",
      annotations: [highlight({ id: "lib-1", relativePath: "a/guide.md" })],
    },
    {
      path: "b/paper.pdf",
      title: "论文",
      annotations: [
        highlight({
          id: "lib-2",
          relativePath: "b/paper.pdf",
          selectedText: "论文摘录",
          title: "论文摘录",
          locator: {
            kind: "pdf",
            page: 2,
            view: "original",
            quote: "论文摘录",
            prefix: "",
            suffix: "",
            rects: [],
          },
        }),
      ],
    },
  ];

  const baseProps = {
    status: "ready" as const,
    groups,
    onRefresh: vi.fn(),
    onExport: vi.fn(),
    onSelect: vi.fn(),
  };

  it("groups annotations by document with counts and total", () => {
    render(<AnnotationLibraryPanel {...baseProps} currentPath="a/guide.md" />);
    expect(screen.getByText("使用指南")).toBeInTheDocument();
    expect(screen.getByText("论文")).toBeInTheDocument();
    expect(screen.getByText("共 2 条")).toBeInTheDocument();
    expect(screen.getByText("当前")).toBeInTheDocument();
  });

  it("selects an annotation and exposes refresh and export", () => {
    const onSelect = vi.fn();
    const onExport = vi.fn();
    render(<AnnotationLibraryPanel {...baseProps} onSelect={onSelect} onExport={onExport} />);
    fireEvent.click(screen.getByText("论文摘录"));
    expect(onSelect).toHaveBeenCalledWith(groups[1].annotations[0]);
    fireEvent.click(screen.getByRole("button", { name: "导出全库" }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
  });

  it("shows loading and empty states", () => {
    const { rerender } = render(<AnnotationLibraryPanel {...baseProps} status="loading" groups={[]} />);
    expect(screen.getByText("正在汇总全库标注…")).toBeInTheDocument();
    rerender(<AnnotationLibraryPanel {...baseProps} status="ready" groups={[]} />);
    expect(screen.getByText("整个文档库还没有标注。")).toBeInTheDocument();
  });
});
