// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentExtent, DocumentInfo } from "../lib/backend";
import { readDocumentThumbnail } from "../lib/backend";
import {
  READING_POSITIONS_STORAGE_KEY,
  READING_POSITIONS_VERSION,
} from "../lib/readingPositions";
import { useReaderStore } from "../store/useReaderStore";
import { BookshelfView } from "./BookshelfView";

vi.mock("../lib/backend", async () => {
  const actual = await vi.importActual<typeof import("../lib/backend")>("../lib/backend");
  return {
    ...actual,
    // 桌面缓存缩略图在 jsdom 里没有 Tauri 后端;逐用例覆写。
    readDocumentThumbnail: vi.fn(async () => null),
    storeDocumentThumbnail: vi.fn(async () => undefined),
    readDocument: vi.fn(async () => ({
      kind: "markdown" as const,
      relativePath: "guide.md",
      markdown: "# Guide",
    })),
  };
});

// PDF 懒渲染链路走 pdf.js;组件测只验证书架本身,渲染管线以桌面真机验收。
vi.mock("../lib/coverCapture", async () => {
  const actual = await vi.importActual<typeof import("../lib/coverCapture")>(
    "../lib/coverCapture",
  );
  return {
    ...actual,
    capturePdfCoverThumbnail: vi.fn(async () => false),
  };
});

function documentInfo(relativePath: string, overrides: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    relativePath,
    title: "",
    size: 100,
    modified: 1,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
    ...overrides,
  };
}

function setLibrary(documents: DocumentInfo[]) {
  useReaderStore.setState({
    snapshot: { rootPath: "D:/library", documents },
    documents,
    currentPath: null,
    loading: false,
    readMarks: {},
  });
}

function seedPosition(path: string, maxScrollRatio: number) {
  localStorage.setItem(
    READING_POSITIONS_STORAGE_KEY,
    JSON.stringify({
      version: READING_POSITIONS_VERSION,
      libraries: {
        "D:/library": {
          [path]: {
            kind: "scroll",
            scrollRatio: maxScrollRatio,
            maxScrollRatio,
            updatedAt: Date.now(),
          },
        },
      },
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(readDocumentThumbnail).mockReset().mockResolvedValue(null);
  useReaderStore.setState({ readMarks: {} });
});

afterEach(cleanup);

describe("BookshelfView (plan-bookshelf-covers §3.3)", () => {
  it("renders one card per document in tree order with format badges", () => {
    setLibrary([
      documentInfo("b-note.md", { title: "笔记" }),
      documentInfo("a-book.pdf", { title: "论文集", format: "pdf" }),
      documentInfo("novel.epub", { title: "小说", format: "epub" }),
    ]);
    const view = render(<BookshelfView />);

    const cards = view.getAllByRole("button");
    expect(cards).toHaveLength(3);
    // 树序 = Collator 排序(按拼音:笔记 < 论文集 < 小说)。
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "笔记",
      "论文集",
      "小说",
    ]);
    expect(view.getByText("PDF")).toBeInTheDocument();
    expect(view.getByText("EPUB")).toBeInTheDocument();
    expect(view.getByText("MD")).toBeInTheDocument();
  });

  it("shows a generated gradient cover with the title initial for markdown", () => {
    setLibrary([documentInfo("guide.md", { title: "设计模式" })]);
    const view = render(<BookshelfView />);
    expect(view.getByText("设")).toBeInTheDocument();
    const art = view.container.querySelector<HTMLElement>(".bookshelf__cover-art");
    expect(art?.style.background).toContain("linear-gradient");
    expect(art?.style.background).toContain("var(--");
  });

  it("shows 已阅 on a marked document even without a reading position", () => {
    setLibrary([documentInfo("guide.md", { title: "指南" })]);
    useReaderStore.setState({ readMarks: { "guide.md": Date.now() } });
    const view = render(<BookshelfView />);
    expect(view.getByText("已阅")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "指南，已阅" })).toBeInTheDocument();
  });

  it("shows the reading-progress badge from the position high-water mark", () => {
    seedPosition("guide.md", 0.62);
    setLibrary([documentInfo("guide.md", { title: "指南" })]);
    const view = render(<BookshelfView />);
    expect(view.getByText("62%")).toBeInTheDocument();
    expect(view.getByRole("button", { name: /已读 62%/ })).toBeInTheDocument();
  });

  it("converts pdf progress with the extents page count", () => {
    localStorage.setItem(
      READING_POSITIONS_STORAGE_KEY,
      JSON.stringify({
        version: READING_POSITIONS_VERSION,
        libraries: {
          "D:/library": {
            "book.pdf": { kind: "pdf", page: 4, offsetRatio: 0, maxPage: 5, updatedAt: Date.now() },
          },
        },
      }),
    );
    setLibrary([documentInfo("book.pdf", { title: "书", format: "pdf" })]);
    const extents = new Map<string, DocumentExtent>([
      ["book.pdf", { relativePath: "book.pdf", charCount: 100, segmentCount: 10, needsOcrSegments: 0 }],
    ]);
    const view = render(<BookshelfView extents={extents} />);
    expect(view.getByText("50%")).toBeInTheDocument();
  });

  it("opens the document on click and records the nav departure first", () => {
    setLibrary([documentInfo("guide.md", { title: "指南" })]);
    const selectDocument = vi.fn(async () => undefined);
    const onBeforeSelect = vi.fn();
    useReaderStore.setState({ selectDocument });
    const view = render(<BookshelfView onBeforeSelect={onBeforeSelect} />);

    fireEvent.click(view.getByRole("button", { name: "指南" }));
    expect(onBeforeSelect).toHaveBeenCalledTimes(1);
    expect(selectDocument).toHaveBeenCalledWith("guide.md");
  });

  it("opens in the secondary pane on Alt+click when supported", () => {
    setLibrary([documentInfo("guide.md", { title: "指南" })]);
    const selectDocument = vi.fn(async () => undefined);
    const onOpenSecondary = vi.fn();
    useReaderStore.setState({ selectDocument });
    const view = render(<BookshelfView onOpenSecondary={onOpenSecondary} />);

    fireEvent.click(view.getByRole("button", { name: "指南" }), { altKey: true });
    expect(onOpenSecondary).toHaveBeenCalledWith("guide.md");
    expect(selectDocument).not.toHaveBeenCalled();
  });

  it("swaps in the cached thumbnail image when the backend has one", async () => {
    vi.mocked(readDocumentThumbnail).mockResolvedValue({ png: "QUJD", width: 240, height: 320 });
    setLibrary([documentInfo("book.pdf", { title: "书", format: "pdf" })]);
    const view = render(<BookshelfView />);

    await waitFor(() => {
      const image = view.container.querySelector<HTMLImageElement>(".bookshelf__cover-image");
      expect(image).not.toBeNull();
      expect(image!.src).toBe("data:image/png;base64,QUJD");
    });
  });

  it("keeps the generated fallback for epubs without a cached cover", async () => {
    setLibrary([documentInfo("novel.epub", { title: "小说", format: "epub" })]);
    const view = render(<BookshelfView />);
    await waitFor(() => expect(readDocumentThumbnail).toHaveBeenCalledWith("novel.epub"));
    expect(view.container.querySelector(".bookshelf__cover-art")).not.toBeNull();
    expect(view.container.querySelector(".bookshelf__cover-image")).toBeNull();
  });

  it("shows the empty state without documents", () => {
    setLibrary([]);
    const view = render(<BookshelfView />);
    expect(view.getByRole("status")).toHaveTextContent("选择一个文件夹开始阅读");
  });
});
