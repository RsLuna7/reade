// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "../lib/backend";
import type { TocItem } from "../lib/markdown";

vi.mock("../lib/fileTransfer", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/fileTransfer")>();
  return { ...original, downloadBlobFile: vi.fn() };
});

import { downloadBlobFile } from "../lib/fileTransfer";
import { BookDigestView } from "./BookDigestView";

const downloadMock = vi.mocked(downloadBlobFile);

function mark(
  id: string,
  headingId: string | null,
  text: string,
  overrides: Partial<Annotation> = {},
): Annotation {
  return {
    id,
    relativePath: "docs/guide.md",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: text,
    title: null,
    locator: { kind: "markdown", quote: text, prefix: "", suffix: "", headingId },
    sortIndex: "M|00000|00000000",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

const TOC: TocItem[] = [
  { id: "intro", title: "一、导论", level: 1 },
  { id: "usage", title: "二、用法", level: 1 },
];

beforeEach(() => {
  downloadMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("BookDigestView", () => {
  it("renders sections in TOC order with excerpts, notes and the stats line", () => {
    render(
      <BookDigestView
        docTitle="长文指南"
        format="markdown"
        toc={TOC}
        annotations={[
          mark("u1", "usage", "用法里的摘录"),
          mark("i1", "intro", "导论里的摘录", { note: "开篇立论", color: "blue" }),
          {
            ...mark("bm", null, ""),
            kind: "bookmark",
            color: null,
            selectedText: null,
            locator: {
              kind: "bookmark",
              target: { format: "markdown", headingId: null, scrollRatio: 0 },
            },
          },
        ]}
        onClose={() => undefined}
        onJump={() => undefined}
      />,
    );
    expect(screen.getByRole("dialog", { name: "读书报告" })).toBeInTheDocument();
    expect(screen.getByText("2 条摘录 · 1 条感悟 · 已略过 1 条书签")).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 3 });
    expect(headings.map((node) => node.textContent)).toEqual(["一、导论", "二、用法"]);
    expect(screen.getByText("导论里的摘录")).toBeInTheDocument();
    expect(screen.getByText("开篇立论")).toBeInTheDocument();
  });

  it("shows the empty state when nothing can be compiled", () => {
    render(
      <BookDigestView
        docTitle="空文档"
        format="markdown"
        toc={TOC}
        annotations={[]}
        onClose={() => undefined}
        onJump={() => undefined}
      />,
    );
    expect(screen.getByText(/还没有可编纂的摘录/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /导出 Markdown/ })).toBeDisabled();
  });

  it("jumps back to the annotation when an item is clicked", () => {
    const onJump = vi.fn();
    render(
      <BookDigestView
        docTitle="长文指南"
        format="markdown"
        toc={TOC}
        annotations={[mark("i1", "intro", "导论里的摘录")]}
        onClose={() => undefined}
        onJump={onJump}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /导论里的摘录/ }));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump.mock.calls[0][0].id).toBe("i1");
  });

  it("exports the digest markdown through the download channel", async () => {
    const onNotice = vi.fn();
    render(
      <BookDigestView
        docTitle="长文指南"
        format="markdown"
        toc={TOC}
        annotations={[mark("i1", "intro", "导论里的摘录")]}
        onClose={() => undefined}
        onJump={() => undefined}
        onNotice={onNotice}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /导出 Markdown/ }));
    expect(downloadMock).toHaveBeenCalledTimes(1);
    const [fileName, blob] = downloadMock.mock.calls[0];
    expect(fileName).toBe("reade-读书报告-长文指南.md");
    const text = await (blob as Blob).text();
    expect(text).toContain("# 长文指南 · 读书报告");
    expect(text).toContain("## 一、导论");
    expect(text).toContain("> 导论里的摘录");
    expect(onNotice).toHaveBeenCalledWith("已开始下载读书报告 Markdown。");
  });

  it("closes on Escape and claims the event (capture phase)", () => {
    const onClose = vi.fn();
    render(
      <BookDigestView
        docTitle="长文指南"
        format="markdown"
        toc={TOC}
        annotations={[mark("i1", "intro", "导论里的摘录")]}
        onClose={onClose}
        onJump={() => undefined}
      />,
    );
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(event);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("omits headings for documents without a TOC (flat degrade)", () => {
    render(
      <BookDigestView
        docTitle="无标题长文"
        format="markdown"
        toc={[]}
        annotations={[mark("a", null, "平铺摘录")]}
        onClose={() => undefined}
        onJump={() => undefined}
      />,
    );
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    expect(screen.getByText("平铺摘录")).toBeInTheDocument();
  });
});
