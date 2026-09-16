// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentExtent, DocumentInfo } from "../lib/backend";
import { listCollections, listCollectionItems, readDocumentThumbnail } from "../lib/backend";
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
    readDocumentThumbnail: vi.fn(async () => null),
    storeDocumentThumbnail: vi.fn(async () => undefined),
    listCollections: vi.fn(async () => []),
    listCollectionItems: vi.fn(async () => []),
    addCollectionItem: vi.fn(async () => ({
      relativePath: "x",
      position: 0,
      addedAt: 1,
      present: true,
    })),
    removeCollectionItem: vi.fn(async () => undefined),
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

function setLibrary(documents: DocumentInfo[], rootPath = "D:/library") {
  useReaderStore.setState({
    snapshot: { rootPath, rootKey: rootPath, documents },
    documents,
    currentPath: null,
    loading: false,
    readMarks: {},
    libraryBrowseScope: { kind: "all" },
    libraryTitleQuery: "",
    libraryFormatFilter: "",
    libraryStatusFilter: "",
    librarySort: "recent",
    libraryScrollTop: 0,
    homeSurface: "library",
    libraryCoverSize: 170,
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
  vi.mocked(listCollections).mockReset().mockResolvedValue([]);
  vi.mocked(listCollectionItems).mockReset().mockResolvedValue([]);
  useReaderStore.setState({ readMarks: {} });
});

afterEach(cleanup);

describe("BookshelfView (library browser)", () => {
  it("renders one card per document in tree order with format badges", () => {
    setLibrary([
      documentInfo("b-note.md", { title: "笔记" }),
      documentInfo("a-book.pdf", { title: "论文集", format: "pdf" }),
      documentInfo("novel.epub", { title: "小说", format: "epub" }),
    ]);
    const view = render(<BookshelfView />);

    const cards = [...view.container.querySelectorAll(".library-card__open")];
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "笔记",
      "论文集",
      "小说",
    ]);
    expect(view.container.querySelector(".library-card__format--pdf")).toHaveTextContent("PDF");
    expect(view.container.querySelector(".library-card__format--epub")).toHaveTextContent("EPUB");
    expect(view.container.querySelector(".library-card__format--markdown")).toHaveTextContent("MD");
  });

  it("shows a generated gradient cover with several title characters for markdown", () => {
    setLibrary([documentInfo("guide.md", { title: "设计模式" })]);
    const view = render(<BookshelfView />);
    expect(view.container.querySelector(".library-card__cover-title")).toHaveTextContent("设计模式");
    const art = view.container.querySelector<HTMLElement>(".library-card__cover-art");
    expect(art?.closest(".library-card__cover-face")).not.toBeNull();
    expect(art).toHaveClass("library-card__cover-art--phrase");
    expect(art?.style.background).toContain("linear-gradient");
    expect(art?.style.background).toContain("var(--");
  });

  it("wraps a long generated cover title instead of keeping a single glyph", () => {
    setLibrary([
      documentInfo("guide.md", { title: "使用 CLAUDE.MD 文件：根据您的代码库需求定制 Claude 代码" }),
    ]);
    const view = render(<BookshelfView />);
    const title = view.container.querySelector(".library-card__cover-title");
    expect(title).toHaveTextContent("使用 CLAUDE.MD 文件：根据您的代码库需求定制 Claude 代码");
    expect(view.container.querySelector(".library-card__cover-art")).toHaveClass(
      "library-card__cover-art--block",
    );
  });

  it("shows 已读 on a marked document even without a reading position", () => {
    setLibrary([documentInfo("guide.md", { title: "指南" })]);
    useReaderStore.setState({ readMarks: { "guide.md": Date.now() } });
    const view = render(<BookshelfView />);
    expect(view.container.querySelector(".library-card__status")).toHaveTextContent("已读");
    expect(view.getByRole("button", { name: "指南，已读" })).toBeInTheDocument();
  });

  it("shows the reading-progress badge from the position high-water mark", () => {
    seedPosition("guide.md", 0.62);
    setLibrary([documentInfo("guide.md", { title: "指南" })]);
    const view = render(<BookshelfView />);
    expect(view.getByText("读到 62%")).toBeInTheDocument();
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
    expect(view.getByText("读到 50%")).toBeInTheDocument();
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
      const image = view.container.querySelector<HTMLImageElement>(".library-card__cover-image");
      expect(image).not.toBeNull();
      expect(image!.src).toBe("data:image/png;base64,QUJD");
    });
  });

  it("drops a stale same-path thumbnail and starts a new request after a library switch", async () => {
    let releaseOld!: (value: { png: string; width: number; height: number } | null) => void;
    const oldThumbnail = new Promise<{ png: string; width: number; height: number } | null>((resolve) => {
      releaseOld = resolve;
    });
    vi.mocked(readDocumentThumbnail)
      .mockImplementationOnce(() => oldThumbnail)
      .mockResolvedValueOnce({ png: "TkVX", width: 240, height: 320 });

    setLibrary([documentInfo("book.pdf", { title: "旧书", format: "pdf" })], "D:/library-a");
    const view = render(<BookshelfView />);
    await waitFor(() => expect(readDocumentThumbnail).toHaveBeenCalledTimes(1));

    act(() => {
      setLibrary([documentInfo("book.pdf", { title: "新书", format: "pdf" })], "D:/library-b");
    });
    await waitFor(() => expect(readDocumentThumbnail).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const image = view.container.querySelector<HTMLImageElement>(".library-card__cover-image");
      expect(image?.src).toBe("data:image/png;base64,TkVX");
    });

    await act(async () => {
      releaseOld({ png: "T0xE", width: 240, height: 320 });
      await Promise.resolve();
    });
    expect(view.container.querySelector<HTMLImageElement>(".library-card__cover-image")?.src).toBe(
      "data:image/png;base64,TkVX",
    );
  });

  it("keeps the generated fallback for epubs without a cached cover", async () => {
    setLibrary([documentInfo("novel.epub", { title: "小说", format: "epub" })]);
    const view = render(<BookshelfView />);
    await waitFor(() => expect(readDocumentThumbnail).toHaveBeenCalledWith("novel.epub"));
    expect(view.container.querySelector(".library-card__cover-art")).not.toBeNull();
    expect(view.container.querySelector(".library-card__cover-image")).toBeNull();
  });

  it("shows the empty state without documents", () => {
    setLibrary([]);
    const view = render(<BookshelfView />);
    expect(view.getByRole("status")).toHaveTextContent("文档库为空。");
  });

  it("filters nested folder documents from the current library scope", () => {
    setLibrary([
      documentInfo("技术/AI/手册.md", { title: "手册" }),
      documentInfo("设计/设计.md", { title: "设计" }),
    ]);
    useReaderStore.getState().setLibraryBrowseScope({ kind: "folder", path: "技术" });
    const view = render(<BookshelfView />);
    expect(view.getByRole("heading", { name: "文件夹 / 技术" })).toBeInTheDocument();
    expect(view.getByRole("button", { name: "手册" })).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "设计" })).not.toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "返回全部" }));
    expect(useReaderStore.getState().libraryBrowseScope).toEqual({ kind: "all" });
    expect(view.getByRole("button", { name: "设计" })).toBeInTheDocument();
  });

  it("clears folder scope without dropping title search", () => {
    setLibrary([
      documentInfo("技术/手册.md", { title: "手册" }),
      documentInfo("设计/设计.md", { title: "设计" }),
    ]);
    useReaderStore.setState({
      libraryBrowseScope: { kind: "folder", path: "技术" },
      libraryTitleQuery: "手册",
    });
    const view = render(<BookshelfView />);
    expect(view.getByDisplayValue("手册")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "返回全部" }));
    expect(useReaderStore.getState().libraryBrowseScope).toEqual({ kind: "all" });
    expect(useReaderStore.getState().libraryTitleQuery).toBe("手册");
    expect(view.getByRole("button", { name: "手册" })).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "设计" })).not.toBeInTheDocument();
  });

  it("shows the folder empty state when the scope has no documents", () => {
    setLibrary([documentInfo("设计/设计.md", { title: "设计" })]);
    useReaderStore.getState().setLibraryBrowseScope({ kind: "folder", path: "技术" });
    const view = render(<BookshelfView />);
    expect(view.getByRole("status")).toHaveTextContent("此文件夹下没有文档");
  });

  it("changes cover size without touching reader font size", () => {
    setLibrary([documentInfo("guide.md", { title: "指南" })]);
    const fontSize = useReaderStore.getState().readingSettings.fontSize;
    const view = render(<BookshelfView />);
    fireEvent.change(view.getByLabelText("封面大小"), { target: { value: "200" } });
    expect(useReaderStore.getState().libraryCoverSize).toBe(200);
    expect(useReaderStore.getState().readingSettings.fontSize).toBe(fontSize);
  });

  it("marks a document read without rewriting its reading position", () => {
    seedPosition("guide.md", 0.4);
    setLibrary([documentInfo("guide.md", { title: "指南" })]);
    const before = localStorage.getItem(READING_POSITIONS_STORAGE_KEY);
    useReaderStore.getState().markDocumentRead("guide.md");
    expect(useReaderStore.getState().readMarks["guide.md"]).toEqual(expect.any(Number));
    expect(localStorage.getItem(READING_POSITIONS_STORAGE_KEY)).toBe(before);
  });
});
