// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../lib/backend";
import { RelatedPassagesPopover } from "./RelatedPassages";

afterEach(cleanup);

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    resultId: "notes/other.md::",
    relativePath: "notes/other.md",
    title: "另一篇笔记",
    snippet: "……同一主题的片段……",
    score: 3.2,
    format: "markdown",
    locator: null,
    ...overrides,
  };
}

describe("RelatedPassagesPopover", () => {
  it("shows the loading state", () => {
    render(
      <RelatedPassagesPopover
        state={{ status: "loading" }}
        x={40}
        y={60}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "相关段落" })).toBeInTheDocument();
    expect(screen.getByText("正在检索相关段落…")).toBeInTheDocument();
  });

  it("lists hits with locator labels and hands clicks to onSelect", () => {
    const onSelect = vi.fn();
    const pdfHit = result({
      resultId: "paper.pdf:pdfPage:12",
      relativePath: "paper.pdf",
      title: "论文",
      format: "pdf",
      locator: { kind: "pdfPage", page: 12 },
    });
    render(
      <RelatedPassagesPopover
        state={{ status: "ready", results: [result(), pdfHit] }}
        x={40}
        y={60}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("另一篇笔记")).toBeInTheDocument();
    expect(screen.getByText("第 12 页")).toBeInTheDocument();

    fireEvent.click(screen.getByText("论文"));
    // PDF locator 原样透传给跳转链(selectDocument(path, locator))。
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: "paper.pdf",
        locator: { kind: "pdfPage", page: 12 },
      }),
    );
  });

  it("shows the empty and error states", () => {
    const view = render(
      <RelatedPassagesPopover
        state={{ status: "ready", results: [] }}
        x={0}
        y={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("没有找到相关段落。")).toBeInTheDocument();
    view.unmount();

    render(
      <RelatedPassagesPopover
        state={{ status: "error", message: "库过大，链接视图未启用" }}
        x={0}
        y={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("库过大，链接视图未启用");
  });

  it("closes on Escape and on outside pointerdown", () => {
    const onClose = vi.fn();
    render(
      <RelatedPassagesPopover
        state={{ status: "loading" }}
        x={0}
        y={0}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
