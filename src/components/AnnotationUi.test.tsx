// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "../lib/backend";
import {
  AnnotationEditBubble,
  AnnotationImportConfirm,
  AnnotationLibraryPanel,
  AnnotationList,
  LostDocumentsSection,
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
    sortIndex: "M|00000|00000000",
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

  it("renders the quote-card action only when a handler is wired (QC)", () => {
    const view = render(<SelectionToolbar {...baseProps} />);
    expect(screen.queryByRole("button", { name: "卡片" })).not.toBeInTheDocument();
    view.unmount();

    const onMakeCard = vi.fn();
    render(<SelectionToolbar {...baseProps} onMakeCard={onMakeCard} />);
    fireEvent.click(screen.getByRole("button", { name: "卡片" }));
    expect(onMakeCard).toHaveBeenCalledTimes(1);
  });

  it("disables the quote-card action together with the mark actions", () => {
    render(<SelectionToolbar {...baseProps} onMakeCard={vi.fn()} canHighlight={false} />);
    expect(screen.getByRole("button", { name: "卡片" })).toBeDisabled();
  });

  it("gates the related-passages action on the selection length (RP)", () => {
    const onFindRelated = vi.fn();
    const view = render(
      <SelectionToolbar {...baseProps} onFindRelated={onFindRelated} canFindRelated={false} />,
    );
    const related = screen.getByRole("button", { name: "相关" });
    expect(related).toBeDisabled();
    expect(related).toHaveAttribute("title", "至少选中 8 个字符");
    view.unmount();

    render(<SelectionToolbar {...baseProps} onFindRelated={onFindRelated} canFindRelated />);
    fireEvent.click(screen.getByRole("button", { name: "相关" }));
    expect(onFindRelated).toHaveBeenCalledTimes(1);
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

  it("offers the quote-card action only for marks with an excerpt (QC-D3 M2)", () => {
    const bookmark = highlight({
      id: "ann-bookmark",
      kind: "bookmark",
      color: null,
      selectedText: null,
      title: "某个书签",
      locator: {
        kind: "bookmark",
        target: { format: "markdown", headingId: null, scrollRatio: 0 },
      },
    });
    const onGenerateCard = vi.fn();
    render(
      <AnnotationList
        {...baseProps}
        annotations={[highlight(), bookmark]}
        onGenerateCard={onGenerateCard}
      />,
    );

    // 书签无摘录:唯一的「卡片」按钮属于高亮条目。
    const cardButtons = screen.getAllByRole("button", { name: "卡片" });
    expect(cardButtons).toHaveLength(1);
    fireEvent.click(cardButtons[0]);
    expect(onGenerateCard).toHaveBeenCalledWith(expect.objectContaining({ id: "ann-1" }));
  });
});

describe("AnnotationList unanchored group (§5.6 A)", () => {
  const baseProps = {
    annotations: [highlight()],
    brokenIds: new Set<string>(),
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onEditNote: vi.fn(),
    onChangeColor: vi.fn(),
    onRelocate: vi.fn(),
  };

  it("hides the group entirely while every annotation anchors", () => {
    render(<AnnotationList {...baseProps} />);
    expect(screen.queryByText("未锚定")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在文档中定位此文本" })).not.toBeInTheDocument();
  });

  it("groups broken annotations with a reason line and keeps every action", () => {
    const anchored = highlight();
    const broken = highlight({ id: "ann-broken", selectedText: "消失的文字", title: "消失的文字" });
    const onRelocate = vi.fn();
    const view = render(
      <AnnotationList
        {...baseProps}
        annotations={[anchored, broken]}
        brokenIds={new Set(["ann-broken"])}
        onRelocate={onRelocate}
      />,
    );

    const group = screen.getByRole("region", { name: "未锚定标注" });
    expect(group).toHaveTextContent("未锚定");
    expect(group).toHaveTextContent("文档内容可能已被修改");
    // The struck-through card keeps note/color/delete — a downgrade, not an error.
    const item = view.container.querySelector(".annotation-list-item.is-broken");
    expect(item).not.toBeNull();
    expect(item!.querySelector(".annotation-list-title")).toHaveTextContent("消失的文字");
    expect(item!.querySelectorAll("button.annotation-color-swatch").length).toBe(4);
    expect(item!.textContent).toContain("笔记");
    expect(item!.textContent).toContain("删除");

    fireEvent.click(screen.getByRole("button", { name: "在文档中定位此文本" }));
    expect(onRelocate).toHaveBeenCalledWith(broken);
    // The anchored card never renders inside the group.
    expect(group.textContent).not.toContain("选中的文本");
  });

  it("offers no relocate action for bookmarks (no quote to search)", () => {
    const bookmark = highlight({
      id: "ann-bookmark",
      kind: "bookmark",
      color: null,
      locator: {
        kind: "bookmark",
        target: { format: "markdown", headingId: "gone", scrollRatio: 0.2 },
      },
    });
    render(
      <AnnotationList
        {...baseProps}
        annotations={[bookmark]}
        brokenIds={new Set(["ann-bookmark"])}
      />,
    );
    expect(screen.getByRole("region", { name: "未锚定标注" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在文档中定位此文本" })).not.toBeInTheDocument();
  });

  it("marks non-exact anchors with the weak-hint dot", () => {
    render(
      <AnnotationList
        {...baseProps}
        annotations={[highlight()]}
        approximateIds={new Set(["ann-1"])}
      />,
    );
    expect(screen.getByRole("img", { name: "非精确定位" })).toBeInTheDocument();
  });

  it("never dots broken entries even when both sets contain the id", () => {
    render(
      <AnnotationList
        {...baseProps}
        annotations={[highlight()]}
        brokenIds={new Set(["ann-1"])}
        approximateIds={new Set(["ann-1"])}
      />,
    );
    expect(screen.queryByRole("img", { name: "非精确定位" })).not.toBeInTheDocument();
  });
});

describe("LostDocumentsSection (§5.6 C)", () => {
  const entry = {
    path: "old/ghost.md",
    annotationCount: 3,
    candidates: ["moved/copy-a.md", "moved/copy-b.md"],
  };
  const documents = [
    { relativePath: "moved/copy-a.md", title: "Copy A" },
    { relativePath: "moved/copy-b.md", title: "Copy B" },
    { relativePath: "other.md", title: "Other" },
  ];

  it("renders nothing without entries", () => {
    const { container } = render(
      <LostDocumentsSection
        entries={[]}
        documents={documents}
        onDryRun={vi.fn()}
        onRebind={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("requires a dry run before the migration unlocks and reports the rate", async () => {
    const onDryRun = vi.fn(async () => ({ total: 3, anchorable: 2, skipped: 1 }));
    const onRebind = vi.fn(async () => undefined);
    render(
      <LostDocumentsSection
        entries={[entry]}
        documents={documents}
        onDryRun={onDryRun}
        onRebind={onRebind}
      />,
    );

    expect(screen.getByText("失联文档")).toBeInTheDocument();
    expect(screen.getByText("old/ghost.md")).toBeInTheDocument();
    // Fingerprint candidates group ahead of the manual full-document list.
    expect(screen.getByRole("group", { name: "内容指纹相同的候选" })).toBeInTheDocument();

    const verify = screen.getByRole("button", { name: "验证锚定" });
    const migrate = screen.getByRole("button", { name: "迁移标注" });
    expect(verify).toBeDisabled();
    expect(migrate).toBeDisabled();

    fireEvent.change(screen.getByRole("combobox", { name: /old\/ghost\.md/ }), {
      target: { value: "moved/copy-a.md" },
    });
    expect(verify).toBeEnabled();
    expect(migrate).toBeDisabled();

    fireEvent.click(verify);
    expect(onDryRun).toHaveBeenCalledWith("old/ghost.md", "moved/copy-a.md");
    expect(
      await screen.findByText(/3 条标注中 2 条可重新锚定，另有 1 条书签不参与文本验证/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "迁移标注" }));
    await waitFor(() => {
      expect(onRebind).toHaveBeenCalledWith("old/ghost.md", "moved/copy-a.md");
    });
  });

  it("invalidates the report when the target changes", async () => {
    const onDryRun = vi.fn(async () => ({ total: 1, anchorable: 1, skipped: 0 }));
    render(
      <LostDocumentsSection
        entries={[entry]}
        documents={documents}
        onDryRun={onDryRun}
        onRebind={vi.fn()}
      />,
    );
    const select = screen.getByRole("combobox", { name: /old\/ghost\.md/ });
    fireEvent.change(select, { target: { value: "moved/copy-a.md" } });
    fireEvent.click(screen.getByRole("button", { name: "验证锚定" }));
    expect(await screen.findByText(/1 条标注中 1 条可重新锚定/)).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "moved/copy-b.md" } });
    expect(screen.queryByText(/可重新锚定/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "迁移标注" })).toBeDisabled();
  });

  it("surfaces dry-run failures inline without touching storage", async () => {
    const onDryRun = vi.fn(async () => {
      throw new Error("无法读取目标文档");
    });
    const onRebind = vi.fn();
    render(
      <LostDocumentsSection
        entries={[entry]}
        documents={documents}
        onDryRun={onDryRun}
        onRebind={onRebind}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: /old\/ghost\.md/ }), {
      target: { value: "other.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验证锚定" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取目标文档");
    expect(onRebind).not.toHaveBeenCalled();
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

describe("AnnotationLibraryPanel search, filters and groups (方案四 A1/A2)", () => {
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

  const emptyFilters = { query: "", kinds: [], colors: [] };

  it("forwards search input and chip toggles through onFiltersChange", () => {
    const onFiltersChange = vi.fn();
    render(
      <AnnotationLibraryPanel
        {...baseProps}
        filters={emptyFilters}
        onFiltersChange={onFiltersChange}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索全库标注" }), {
      target: { value: "术语" },
    });
    expect(onFiltersChange).toHaveBeenCalledWith({ query: "术语", kinds: [], colors: [] });

    fireEvent.click(screen.getByRole("button", { name: "高亮" }));
    expect(onFiltersChange).toHaveBeenCalledWith({
      query: "",
      kinds: ["highlight"],
      colors: [],
    });

    fireEvent.click(screen.getByRole("button", { name: "筛选蓝色标注" }));
    expect(onFiltersChange).toHaveBeenCalledWith({ query: "", kinds: [], colors: ["blue"] });
  });

  it("switches the count line and export label while filtering", () => {
    const onExport = vi.fn();
    render(<AnnotationLibraryPanel {...baseProps} filterActive onExport={onExport} />);
    expect(screen.getByText("命中 2 条，来自 2 个文档")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导出全库" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出当前结果" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("keeps the search box visible in the filtered empty state", () => {
    render(
      <AnnotationLibraryPanel
        {...baseProps}
        groups={[]}
        filterActive
        filters={{ query: "找不到", kinds: [], colors: [] }}
        onFiltersChange={vi.fn()}
      />,
    );
    expect(screen.getByText("没有命中的标注。")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索全库标注" })).toBeInTheDocument();
  });

  it("collapses and re-expands a document group", () => {
    render(<AnnotationLibraryPanel {...baseProps} />);
    expect(screen.getByText("选中的文本")).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "使用指南" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("选中的文本")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByText("选中的文本")).toBeInTheDocument();
  });

  it("previews the first 20 entries and reveals the rest on demand", () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      highlight({ id: `many-${index}`, selectedText: `摘录 ${index}`, title: `摘录 ${index}` }),
    );
    render(
      <AnnotationLibraryPanel
        {...baseProps}
        groups={[{ path: "a.md", title: "长文", annotations: many }]}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(20);

    fireEvent.click(screen.getByRole("button", { name: "展开全部 25 条" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(25);
    expect(screen.queryByRole("button", { name: "展开全部 25 条" })).not.toBeInTheDocument();
  });

  it("renders missing-document groups read-only but still exportable", () => {
    const missingGroup = {
      path: "gone.md",
      title: "gone.md",
      missing: true,
      annotations: [
        highlight({
          id: "ghost-1",
          relativePath: "gone.md",
          selectedText: "失联摘录",
          title: "失联摘录",
        }),
      ],
    };
    const onSelect = vi.fn();
    const onExportGroup = vi.fn();
    const view = render(
      <AnnotationLibraryPanel
        {...baseProps}
        groups={[...groups, missingGroup]}
        onSelect={onSelect}
        onExportGroup={onExportGroup}
      />,
    );

    const section = view.container.querySelector(".annotation-library-group.is-missing");
    expect(section).not.toBeNull();
    expect(section).toHaveTextContent("文档已移动或删除，标注仍保留");
    expect(section).toHaveTextContent("刷新后会提示迁移");
    // 条目只读:不渲染跳转按钮,点击不触发 onSelect。
    expect(section!.querySelector("button.annotation-list-main")).toBeNull();
    fireEvent.click(screen.getByText("失联摘录"));
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "导出 gone.md 的标注" }));
    expect(onExportGroup).toHaveBeenCalledWith(missingGroup);
  });

  it("offers the hub entry link when a handler is provided", () => {
    const onOpenHub = vi.fn();
    render(<AnnotationLibraryPanel {...baseProps} onOpenHub={onOpenHub} />);
    fireEvent.click(screen.getByRole("button", { name: "在中枢中打开" }));
    expect(onOpenHub).toHaveBeenCalledTimes(1);
  });
});

describe("AnnotationLibraryPanel transfer entries (§5.7)", () => {
  const groups = [
    {
      path: "a/guide.md",
      title: "使用指南",
      annotations: [highlight({ id: "lib-1", relativePath: "a/guide.md" })],
    },
  ];

  const baseProps = {
    status: "ready" as const,
    groups,
    onRefresh: vi.fn(),
    onExport: vi.fn(),
    onSelect: vi.fn(),
    onExportJson: vi.fn(),
    onExportCsv: vi.fn(),
    onImport: vi.fn(),
  };

  it("reveals the JSON/CSV choice behind 导出标注… and collapses after picking", () => {
    const onExportJson = vi.fn();
    const onExportCsv = vi.fn();
    render(
      <AnnotationLibraryPanel
        {...baseProps}
        onExportJson={onExportJson}
        onExportCsv={onExportCsv}
      />,
    );
    expect(screen.queryByRole("button", { name: "JSON 数据文件" })).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "导出标注…" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "JSON 数据文件" }));
    expect(onExportJson).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Readwise CSV" })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Readwise CSV" }));
    expect(onExportCsv).toHaveBeenCalledTimes(1);
  });

  it("exposes the import entry, also on an empty library", () => {
    const onImport = vi.fn();
    const { rerender } = render(<AnnotationLibraryPanel {...baseProps} onImport={onImport} />);
    fireEvent.click(screen.getByRole("button", { name: "导入标注…" }));
    expect(onImport).toHaveBeenCalledTimes(1);

    rerender(<AnnotationLibraryPanel {...baseProps} groups={[]} onImport={onImport} />);
    fireEvent.click(screen.getByRole("button", { name: "导入标注…" }));
    expect(onImport).toHaveBeenCalledTimes(2);
  });

  it("hides the file-level entries while filtering", () => {
    render(<AnnotationLibraryPanel {...baseProps} filterActive />);
    expect(screen.queryByRole("button", { name: "导出标注…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导入标注…" })).not.toBeInTheDocument();
  });
});

describe("AnnotationImportConfirm (dry-run summary)", () => {
  const summary = {
    fileName: "reade-annotations-20260813.json",
    added: 3,
    skipped: 2,
    updated: 1,
    deletions: 4,
    rebindDocuments: 1,
    totalWrites: 8,
  };

  it("lists the five counters, the file name and the rebind hint", () => {
    const onConfirm = vi.fn();
    render(
      <AnnotationImportConfirm summary={summary} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    const dialog = screen.getByRole("dialog", { name: "确认导入标注" });
    expect(dialog).toHaveTextContent("reade-annotations-20260813.json");
    expect(dialog).toHaveTextContent("新增");
    expect(dialog).toHaveTextContent("跳过（已存在）");
    expect(dialog).toHaveTextContent("更新（较新版本）");
    expect(dialog).toHaveTextContent("删除传播");
    expect(dialog).toHaveTextContent("失联文档");
    fireEvent.click(screen.getByRole("button", { name: "导入 8 条更改" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancels without confirming", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <AnnotationImportConfirm summary={summary} onConfirm={onConfirm} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows a close-only state when there is nothing to write", () => {
    render(
      <AnnotationImportConfirm
        summary={{
          fileName: null,
          added: 0,
          skipped: 5,
          updated: 0,
          deletions: 0,
          rebindDocuments: 0,
          totalWrites: 0,
        }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("文件中的标注均已存在，无需导入。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /导入 \d+ 条更改/ })).not.toBeInTheDocument();
  });

  it("disables actions while the import is running", () => {
    render(
      <AnnotationImportConfirm summary={summary} busy onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "导入中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  });
});
