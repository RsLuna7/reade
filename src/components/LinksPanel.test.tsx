// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEB_LINKS_DISABLED_MESSAGE, type DocumentLinks } from "../lib/documentLinks";
import { LinksPanel } from "./LinksPanel";

afterEach(cleanup);

function linksData(overrides: Partial<DocumentLinks> = {}): DocumentLinks {
  return {
    backlinks: [
      { sourcePath: "notes/a.md", sourceTitle: "笔记 A", linkText: "见这篇", count: 2 },
      { sourcePath: "notes/b.md", sourceTitle: "笔记 B", linkText: "", count: 1 },
    ],
    outgoing: [
      {
        kind: "document",
        targetPath: "notes/c.md",
        rawTarget: "notes/c.md",
        linkText: "参考 C",
        present: true,
        ambiguousCount: 0,
      },
      {
        kind: "document",
        targetPath: "gone/d.md",
        rawTarget: "gone/d.md",
        linkText: "已删除的 D",
        present: false,
        ambiguousCount: 0,
      },
      {
        kind: "wiki",
        targetPath: null,
        rawTarget: "readme",
        linkText: "readme",
        present: false,
        ambiguousCount: 3,
      },
      {
        kind: "asset",
        targetPath: "img/pic.png",
        rawTarget: "img/pic.png",
        linkText: "图",
        present: false,
        ambiguousCount: 0,
      },
    ],
    brokenCount: 1,
    ...overrides,
  };
}

describe("LinksPanel", () => {
  it("renders loading, error and empty states", () => {
    const view = render(<LinksPanel state={{ status: "loading" }} onSelectDocument={vi.fn()} />);
    expect(screen.getByText("正在读取链接…")).toBeInTheDocument();
    view.unmount();

    render(
      <LinksPanel
        state={{ status: "error", message: WEB_LINKS_DISABLED_MESSAGE }}
        onSelectDocument={vi.fn()}
      />,
    );
    // Web >500 篇的降级文案原样呈现(BL-D4)。
    expect(screen.getByText(WEB_LINKS_DISABLED_MESSAGE)).toBeInTheDocument();
    cleanup();

    render(
      <LinksPanel
        state={{ status: "ready", data: { backlinks: [], outgoing: [], brokenCount: 0 } }}
        onSelectDocument={vi.fn()}
      />,
    );
    expect(screen.getByText("本文档没有库内链接。")).toBeInTheDocument();
  });

  it("groups backlinks per source and jumps through onSelectDocument", () => {
    const onSelectDocument = vi.fn();
    render(
      <LinksPanel state={{ status: "ready", data: linksData() }} onSelectDocument={onSelectDocument} />,
    );

    const backlinkSection = screen.getByRole("region", { name: "反向链接" });
    expect(within(backlinkSection).getByText("笔记 A")).toBeInTheDocument();
    expect(within(backlinkSection).getByText("见这篇")).toBeInTheDocument();
    // 计数徽标:2 次引用。
    expect(within(backlinkSection).getByText("2")).toBeInTheDocument();

    fireEvent.click(within(backlinkSection).getByText("笔记 A"));
    expect(onSelectDocument).toHaveBeenCalledWith("notes/a.md");
  });

  it("keeps missing, ambiguous and asset outgoing rows non-clickable", () => {
    const onSelectDocument = vi.fn();
    render(
      <LinksPanel state={{ status: "ready", data: linksData() }} onSelectDocument={onSelectDocument} />,
    );

    expect(screen.getByText("1 条出链目标缺失（仅统计文档链接）")).toBeInTheDocument();

    const outgoingSection = screen.getByRole("region", { name: "出链" });
    // 在场目标可点击跳转。
    fireEvent.click(within(outgoingSection).getByText("参考 C"));
    expect(onSelectDocument).toHaveBeenCalledWith("notes/c.md");
    onSelectDocument.mockClear();

    // 失效/歧义/资产:静态行,点击不触发任何跳转。
    expect(within(outgoingSection).getByText("目标不在库中")).toBeInTheDocument();
    expect(within(outgoingSection).getByText("3 个候选")).toBeInTheDocument();
    expect(within(outgoingSection).getByText("资产")).toBeInTheDocument();
    fireEvent.click(within(outgoingSection).getByText("已删除的 D"));
    fireEvent.click(within(outgoingSection).getAllByText("readme")[0]);
    fireEvent.click(within(outgoingSection).getByText("图"));
    expect(onSelectDocument).not.toHaveBeenCalled();
    // 静态行不是按钮:出链区域只有一个可点击按钮(参考 C)。
    expect(within(outgoingSection).getAllByRole("button")).toHaveLength(1);
  });
});
