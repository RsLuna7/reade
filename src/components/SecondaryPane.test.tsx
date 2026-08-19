// @vitest-environment jsdom
import "../test/setup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/backend", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/backend")>();
  return {
    ...original,
    readDocument: vi.fn(),
    readAsset: vi.fn(),
    openExternalLink: vi.fn(),
  };
});

const panePdf = vi.hoisted(() => ({
  jumpToPage: vi.fn(),
  restorePosition: vi.fn(() => true),
}));

vi.mock("./PdfReader", () => ({
  PdfReader: function MockPdfReader(props: {
    readerRef?: { current: {
      getPosition: () => { page: number; offsetRatio: number };
      getMode: () => "original";
      setMode: () => void;
      restorePosition: (position: unknown) => boolean;
      jumpToPage: (page: number) => void;
      openPageCalibration: () => void;
    } | null };
    relativePath: string;
  }) {
    if (props.readerRef) {
      props.readerRef.current = {
        getPosition: () => ({ page: 1, offsetRatio: 0 }),
        getMode: () => "original",
        setMode: () => undefined,
        restorePosition: panePdf.restorePosition,
        jumpToPage: panePdf.jumpToPage,
        openPageCalibration: () => undefined,
      };
    }
    return <div data-testid="pane-pdf">{props.relativePath}</div>;
  },
}));

import { readAsset, readDocument, type DocumentContent, type DocumentInfo } from "../lib/backend";
import { useReaderStore } from "../store/useReaderStore";
import { SecondaryPane } from "./SecondaryPane";

const readDocumentMock = vi.mocked(readDocument);
const readAssetMock = vi.mocked(readAsset);

function documentInfo(relativePath: string, overrides: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    relativePath,
    title: relativePath.split("/").pop() ?? relativePath,
    size: 1024,
    modified: 1_700_000_000,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
    ...overrides,
  };
}

function markdownContent(relativePath: string, markdown: string): DocumentContent {
  return { kind: "markdown", relativePath, markdown };
}

const libraryDocuments = [
  documentInfo("notes/alpha.md", { title: "Alpha 笔记" }),
  documentInfo("notes/beta.md", { title: "Beta 笔记" }),
];

beforeEach(() => {
  readDocumentMock.mockReset();
  readAssetMock.mockReset();
  readAssetMock.mockRejectedValue(new Error("no assets in tests"));
  panePdf.jumpToPage.mockReset();
  panePdf.restorePosition.mockReset();
  panePdf.restorePosition.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
});

describe("SecondaryPane", () => {
  it("loads its document itself and renders markdown inside a .reading-scroll root", async () => {
    readDocumentMock.mockResolvedValue(
      markdownContent("notes/alpha.md", "# Alpha\n\n对照阅读正文段落。"),
    );
    const view = render(
      <SecondaryPane
        path="notes/alpha.md"
        documents={libraryDocuments}
        motionLevel="off"
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("正在加载文档…")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("对照阅读正文段落。")).toBeInTheDocument();
    });
    expect(readDocumentMock).toHaveBeenCalledWith("notes/alpha.md");

    // Renderer self-rooting contract: the pane provides the .reading-scroll
    // scroll container and an article-shell body of its own.
    const scrollRoot = view.container.querySelector(".secondary-pane .reading-scroll");
    expect(scrollRoot).not.toBeNull();
    expect(scrollRoot?.querySelector(".article-shell .markdown-body")).not.toBeNull();
    // The pane header shows the library title of the document.
    expect(screen.getByText("Alpha 笔记")).toBeInTheDocument();
    // The pane strips the leading H1 (the header already names the document).
    expect(view.container.querySelector(".markdown-body h1")).toBeNull();
  });

  it("shows the error state when readDocument rejects", async () => {
    readDocumentMock.mockRejectedValue(new Error("读取超时"));
    render(
      <SecondaryPane
        path="notes/alpha.md"
        documents={libraryDocuments}
        motionLevel="off"
        onClose={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("文档读取失败：读取超时");
    });
  });

  it("switches documents when the requested path changes", async () => {
    readDocumentMock.mockImplementation(async (relativePath: string) =>
      markdownContent(
        relativePath,
        relativePath.endsWith("alpha.md") ? "Alpha 段落。" : "Beta 段落。",
      ),
    );
    const view = render(
      <SecondaryPane
        path="notes/alpha.md"
        documents={libraryDocuments}
        motionLevel="off"
        onClose={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Alpha 段落。")).toBeInTheDocument();
    });

    view.rerender(
      <SecondaryPane
        path="notes/beta.md"
        documents={libraryDocuments}
        motionLevel="off"
        onClose={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Beta 段落。")).toBeInTheDocument();
    });
    expect(screen.queryByText("Alpha 段落。")).not.toBeInTheDocument();
    expect(screen.getByText("Beta 笔记")).toBeInTheDocument();
  });

  it("self-navigates on in-library links without touching the store", async () => {
    readDocumentMock.mockImplementation(async (relativePath: string) =>
      markdownContent(
        relativePath,
        relativePath.endsWith("alpha.md")
          ? "先看 [Beta](./beta.md) 一眼。"
          : "Beta 段落。",
      ),
    );
    const onPathChange = vi.fn();
    render(
      <SecondaryPane
        path="notes/alpha.md"
        documents={libraryDocuments}
        motionLevel="off"
        onClose={() => undefined}
        onPathChange={onPathChange}
      />,
    );
    await screen.findByRole("link", { name: "Beta" });
    expect(useReaderStore.getState().currentPath).toBeNull();

    // Re-query at click time: markdown re-renders remount their DOM subtree
    // (inline component map), so an earlier node handle may be detached.
    fireEvent.click(screen.getByRole("link", { name: "Beta" }));
    await waitFor(() => {
      expect(screen.getByText("Beta 段落。")).toBeInTheDocument();
    });
    expect(readDocumentMock).toHaveBeenCalledWith("notes/beta.md");
    expect(onPathChange).toHaveBeenCalledWith("notes/beta.md");
    // The main pane's store state stays untouched (no selectDocument call).
    expect(useReaderStore.getState().currentPath).toBeNull();
  });

  it("shows a notice instead of navigating for out-of-library links", async () => {
    readDocumentMock.mockResolvedValue(
      markdownContent("notes/alpha.md", "跳去 [外部](./missing.md)。"),
    );
    render(
      <SecondaryPane
        path="notes/alpha.md"
        documents={libraryDocuments}
        motionLevel="off"
        onClose={() => undefined}
      />,
    );
    await screen.findByRole("link", { name: "外部" });
    const callsBefore = readDocumentMock.mock.calls.length;
    fireEvent.click(screen.getByRole("link", { name: "外部" }));
    await waitFor(() => {
      expect(
        screen.getByText("目标不在当前 Markdown 文档库中，已阻止打开。"),
      ).toBeInTheDocument();
    });
    expect(readDocumentMock.mock.calls.length).toBe(callsBefore);
  });

  it("shows the disconnected state when the document leaves the library", async () => {
    readDocumentMock.mockResolvedValue(markdownContent("notes/alpha.md", "正文。"));
    const onClose = vi.fn();
    const view = render(
      <SecondaryPane
        path="notes/alpha.md"
        documents={libraryDocuments}
        motionLevel="off"
        onClose={onClose}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("正文。")).toBeInTheDocument();
    });

    // Library refresh drops the document — the pane flips to 失联态.
    view.rerender(
      <SecondaryPane
        path="notes/alpha.md"
        documents={[documentInfo("notes/beta.md")]}
        motionLevel="off"
        onClose={onClose}
      />,
    );
    expect(
      screen.getByText("文档已不在当前文档库中，可能被移动、重命名或删除。"),
    ).toBeInTheDocument();
    // Header icon and the disconnected-state button both offer the close.
    const closeButtons = screen.getAllByRole("button", { name: "关闭副栏" });
    expect(closeButtons).toHaveLength(2);
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from the pane header button", async () => {
    readDocumentMock.mockResolvedValue(markdownContent("notes/alpha.md", "正文。"));
    const onClose = vi.fn();
    render(
      <SecondaryPane
        path="notes/alpha.md"
        documents={libraryDocuments}
        motionLevel="off"
        onClose={onClose}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("正文。")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭副栏" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("remembers session scroll positions per document while switching", async () => {
    readDocumentMock.mockImplementation(async (relativePath: string) =>
      markdownContent(
        relativePath,
        relativePath.endsWith("alpha.md") ? "Alpha 段落。" : "Beta 段落。",
      ),
    );
    const view = render(
      <SecondaryPane
        path="notes/alpha.md"
        documents={libraryDocuments}
        motionLevel="off"
        onClose={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Alpha 段落。")).toBeInTheDocument();
    });
    const scroller = view.container.querySelector<HTMLElement>(".secondary-pane .reading-scroll");
    expect(scroller).not.toBeNull();
    if (!scroller) return;

    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event("scroll"));

    view.rerender(
      <SecondaryPane
        path="notes/beta.md"
        documents={libraryDocuments}
        motionLevel="off"
        onClose={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Beta 段落。")).toBeInTheDocument();
    });
    expect(scroller.scrollTop).toBe(0);

    view.rerender(
      <SecondaryPane
        path="notes/alpha.md"
        documents={libraryDocuments}
        motionLevel="off"
        onClose={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Alpha 段落。")).toBeInTheDocument();
    });
    // Session-only memory restores the previous position for the same path.
    expect(scroller.scrollTop).toBe(120);
  });

  it("jumps an already-open PDF when pinSeq changes without reloading", async () => {
    readDocumentMock.mockResolvedValue({
      kind: "pdf",
      relativePath: "scan.pdf",
      size: 2048,
      indexStatus: "ready",
      indexError: null,
    });
    const memory = new Map();
    const view = render(
      <SecondaryPane
        path="scan.pdf"
        documents={[documentInfo("scan.pdf", { format: "pdf", title: "扫描教材" })]}
        motionLevel="off"
        onClose={() => undefined}
        pdfPositionMemory={memory}
        pinPage={12}
        pinSeq={1}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("pane-pdf")).toHaveTextContent("scan.pdf");
    });
    await waitFor(() => {
      expect(panePdf.jumpToPage).toHaveBeenCalledWith(12);
    });
    expect(memory.get("scan.pdf")).toEqual({ page: 12, offsetRatio: 0 });
    const loads = readDocumentMock.mock.calls.length;

    view.rerender(
      <SecondaryPane
        path="scan.pdf"
        documents={[documentInfo("scan.pdf", { format: "pdf", title: "扫描教材" })]}
        motionLevel="off"
        onClose={() => undefined}
        pdfPositionMemory={memory}
        pinPage={40}
        pinSeq={2}
      />,
    );
    await waitFor(() => {
      expect(panePdf.jumpToPage).toHaveBeenCalledWith(40);
    });
    expect(readDocumentMock.mock.calls.length).toBe(loads);
    expect(memory.get("scan.pdf")).toEqual({ page: 40, offsetRatio: 0 });
  });
});
