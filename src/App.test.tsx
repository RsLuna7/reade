// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { MotionNotice, ReadingSettingsPanel, TocNavigation } from "./App";
import {
  chooseLibraryDirectory,
  deleteAnnotation,
  detectMovedDocuments,
  findRelatedPassages,
  listAnnotations,
  listCollections,
  listDocumentExtents,
  listDocumentLinks,
  listReadingSessions,
  listReviewQueue,
  openLibrary,
  probeLibraryPath,
  readDocument,
  rebindDocumentAnnotations,
  reviewSummary,
  searchAnnotations,
  upsertAnnotation,
  type Annotation,
  type ReadingSession,
} from "./lib/backend";
import { buildAnnotationsMarkdown } from "./lib/annotationExport";
import { readHomeBaseline } from "./lib/homeData";
import { readReadingPosition, writeReadingPosition } from "./lib/readingPositions";
import { readVerticalPreference } from "./lib/verticalWriting";
import {
  DEFAULT_READING_SETTINGS,
  READER_PREFERENCES_STORAGE_KEY,
  useReaderStore,
} from "./store/useReaderStore";

vi.mock("./lib/backend", async () => {
  const actual = await vi.importActual<typeof import("./lib/backend")>("./lib/backend");
  return {
    ...actual,
    listAnnotations: vi.fn(async () => []),
    upsertAnnotation: vi.fn(async (annotation) => annotation),
    deleteAnnotation: vi.fn(async () => undefined),
    clearDocumentAnnotations: vi.fn(async () => undefined),
    detectMovedDocuments: vi.fn(async () => []),
    rebindDocumentAnnotations: vi.fn(async () => 0),
    searchAnnotations: vi.fn(async () => []),
    findRelatedPassages: vi.fn(async () => []),
    listDocumentLinks: vi.fn(async () => ({ backlinks: [], outgoing: [], brokenCount: 0 })),
    // 命令面板打开时拉合集;jsdom 无 Tauri 后端,默认空列表。
    listCollections: vi.fn(async () => []),
    // 回顾探测与队列在 jsdom 中没有 Tauri 后端;默认零数据。
    reviewSummary: vi.fn(async () => ({ dueCount: 0, reviewedToday: 0 })),
    listReviewQueue: vi.fn(async () => []),
    recordReviewOutcome: vi.fn(async () => undefined),
    readDocument: vi.fn(async () => {
      throw new Error("readDocument not mocked");
    }),
    // 最近书库 MRU(plan-library-mru):打开/探测/目录对话框都走 mock。
    openLibrary: vi.fn(async (rootPath: string) => ({ rootPath, documents: [] })),
    probeLibraryPath: vi.fn(async () => true),
    chooseLibraryDirectory: vi.fn(async () => null),
    // 阅读时间预估(plan-reading-time-estimate):extents 聚合走 mock。
    listDocumentExtents: vi.fn(async () => []),
    // 阅读会话在 jsdom 里没有 Tauri sqlite 后端;主页与冷启动判定用它。
    listReadingSessions: vi.fn(async () => []),
    // 设置 snapshot 的用例会挂载库监听 effect;jsdom 里没有 Tauri 事件桥。
    onLibraryChanged: vi.fn(async () => () => undefined),
    onLibraryIndexProgress: vi.fn(async () => () => undefined),
    onDocumentIndexStatus: vi.fn(async () => () => undefined),
  };
});

class TestIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// jsdom 的 Range 没有 getBoundingClientRect;选区捕获逻辑依赖它。
if (typeof Range.prototype.getBoundingClientRect !== "function") {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

function mockMatchMedia(matches = false): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  localStorage.clear();
  mockMatchMedia();
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.mocked(listAnnotations).mockReset().mockImplementation(async () => []);
  vi.mocked(upsertAnnotation).mockReset().mockImplementation(async (annotation) => annotation);
  vi.mocked(deleteAnnotation).mockReset().mockImplementation(async () => undefined);
  vi.mocked(detectMovedDocuments).mockReset().mockImplementation(async () => []);
  vi.mocked(rebindDocumentAnnotations).mockReset().mockImplementation(async () => 0);
  vi.mocked(searchAnnotations).mockReset().mockImplementation(async () => []);
  vi.mocked(findRelatedPassages).mockReset().mockImplementation(async () => []);
  vi.mocked(listDocumentLinks)
    .mockReset()
    .mockImplementation(async () => ({ backlinks: [], outgoing: [], brokenCount: 0 }));
  vi.mocked(listCollections).mockReset().mockImplementation(async () => []);
  vi.mocked(reviewSummary)
    .mockReset()
    .mockImplementation(async () => ({ dueCount: 0, reviewedToday: 0 }));
  vi.mocked(listReviewQueue).mockReset().mockImplementation(async () => []);
  vi.mocked(readDocument).mockReset().mockImplementation(async () => {
    throw new Error("readDocument not mocked");
  });
  vi.mocked(openLibrary)
    .mockReset()
    .mockImplementation(async (rootPath: string) => ({ rootPath, documents: [] }));
  vi.mocked(probeLibraryPath).mockReset().mockImplementation(async () => true);
  vi.mocked(chooseLibraryDirectory).mockReset().mockImplementation(async () => null);
  vi.mocked(listDocumentExtents).mockReset().mockImplementation(async () => []);
  vi.mocked(listReadingSessions).mockReset().mockImplementation(async () => []);
  useReaderStore.setState({
    snapshot: null,
    documents: [],
    currentPath: null,
    currentContent: null,
    currentLocator: null,
    indexProgress: null,
    searchQuery: "",
    searchResults: [],
    theme: "paper-light",
    readingSettings: { ...DEFAULT_READING_SETTINGS },
    motionLevel: "subtle",
    annotationColorNames: { yellow: "金句", green: "疑问", blue: "行动", pink: "术语" },
    fuzzyAnnotationAnchoring: false,
    expandedPaths: [],
    activeView: "reader",
    verticalWriting: false,
    loading: false,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

describe("motion integration", () => {
  it("keeps the settings panel mounted and inert while closed", () => {
    const view = render(<ReadingSettingsPanel open={false} onClose={() => undefined} onNotice={() => undefined} />);
    const panel = view.container.querySelector<HTMLElement>(".settings-popover");
    expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(panel).toHaveAttribute("inert");

    view.rerender(<ReadingSettingsPanel open onClose={() => undefined} onNotice={() => undefined} />);
    expect(panel).toHaveAttribute("aria-hidden", "false");
    expect(panel).not.toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("button", { name: "完整" }));
    expect(useReaderStore.getState().motionLevel).toBe("full");
  });

  it("replays an identical notice when its id changes", () => {
    const cancel = vi.fn();
    const animate = vi.fn(() => ({
      addEventListener: vi.fn(),
      cancel,
      finished: new Promise<void>(() => undefined),
    }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });

    const view = render(<MotionNotice id={1} message="已完成" motionLevel="subtle" onClose={() => undefined} />);
    expect(animate).toHaveBeenCalledTimes(1);
    view.rerender(<MotionNotice id={2} message="已完成" motionLevel="subtle" onClose={() => undefined} />);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(2);
  });
});

describe("theme style picker (M1)", () => {
  it("switches the series from the sidebar popover and persists the choice", async () => {
    render(<App />);

    // While closed the popover is aria-hidden + inert: no reachable tiles.
    expect(screen.queryByRole("radio", { name: /墨韵系列/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /界面风格/ }));
    const inkTile = await screen.findByRole("radio", { name: /墨韵系列/ });
    fireEvent.click(inkTile);

    expect(useReaderStore.getState().theme).toBe("ink-light");
    // D4: the ink series carries the serif preset and surfaces a hint line.
    expect(useReaderStore.getState().readingSettings.fontFamily).toBe("serif");
    expect(
      screen.getByText("已切换为书刊衬线，可在阅读设置中调整"),
    ).toBeInTheDocument();
    expect(inkTile).toHaveAttribute("aria-checked", "true");

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("ink-light");
    });
    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: Record<string, unknown> };
    expect(stored.state).toMatchObject({ theme: "ink-light" });

    // Mode toggling stays orthogonal: the sun/moon button keeps the series.
    fireEvent.click(screen.getByRole("button", { name: "切换到深色主题" }));
    expect(useReaderStore.getState().theme).toBe("ink-dark");
  });

  it("cycles and selects series with arrow keys inside the radiogroup (M2)", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /界面风格/ }));
    const group = await screen.findByRole("radiogroup", { name: "界面风格系列" });

    screen.getByRole("radio", { name: /纸感系列/ }).focus();
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(useReaderStore.getState().theme).toBe("ink-light");
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(useReaderStore.getState().theme).toBe("mist-light");
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(useReaderStore.getState().theme).toBe("celadon-light");
    // Cycling wraps from the last tile back to the first.
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(useReaderStore.getState().theme).toBe("paper-light");
    fireEvent.keyDown(group, { key: "ArrowUp" });
    expect(useReaderStore.getState().theme).toBe("celadon-light");
    fireEvent.keyDown(group, { key: "Home" });
    expect(useReaderStore.getState().theme).toBe("paper-light");
    fireEvent.keyDown(group, { key: "End" });
    expect(useReaderStore.getState().theme).toBe("celadon-light");

    // Roving tabindex follows the selection.
    expect(screen.getByRole("radio", { name: /青瓷系列/ })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: /纸感系列/ })).toHaveAttribute("tabindex", "-1");
  });
});

describe("theme switch crossfade (M3/D5)", () => {
  // Untyped optional view: jsdom lacks the API while the DOM lib types it as
  // a required Document method, which would reject the mock and the delete.
  const mutableDocument = document as unknown as { startViewTransition?: unknown };

  afterEach(() => {
    delete mutableDocument.startViewTransition;
  });

  it("wraps only real theme switches at full motion in a view transition", async () => {
    const startViewTransition = vi.fn((update: () => void) => {
      update();
      return {};
    });
    mutableDocument.startViewTransition = startViewTransition;
    useReaderStore.setState({ motionLevel: "full" });
    // In production theme-boot.ts has written data-theme before React mounts.
    document.documentElement.dataset.theme = "paper-light";

    render(<App />);

    // Mount re-applies the booted value instantly — no cold-start crossfade.
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("paper-light");
    });
    expect(startViewTransition).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "切换到深色主题" }));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("paper-dark");
    });
    expect(startViewTransition).toHaveBeenCalledTimes(1);

    // subtle (and off) keep the instant switch even with the API present.
    useReaderStore.setState({ motionLevel: "subtle" });
    fireEvent.click(screen.getByRole("button", { name: "切换到浅色主题" }));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("paper-light");
    });
    expect(startViewTransition).toHaveBeenCalledTimes(1);
  });

  it("lands the switch without error when the API is unavailable", async () => {
    useReaderStore.setState({ motionLevel: "full" });
    document.documentElement.dataset.theme = "paper-light";

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "切换到深色主题" }));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("paper-dark");
    });
  });
});

describe("format-owned navigation", () => {
  it("keeps EPUB navigation after App effects settle", async () => {
    useReaderStore.setState({
      documents: [{
        relativePath: "book.epub",
        title: "Book",
        size: 1024,
        modified: 1,
        format: "epub",
        indexStatus: "ready",
        indexError: null,
      }],
      currentPath: "book.epub",
      currentContent: {
        kind: "epub",
        relativePath: "book.epub",
        document: {
          title: "Book",
          assets: [],
          notes: [],
          chapters: [{ id: "one", title: "第一章", level: 1, blocks: [] }],
        },
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByRole("link", { name: "第一章" }).length).toBeGreaterThan(0);
    });
  });
});

describe("bounded document navigation", () => {
  it("scrolls Markdown TOC inside the reading pane without moving the page viewport", async () => {
    useReaderStore.setState({
      documents: [{
        relativePath: "guide.md",
        title: "Guide",
        size: 256,
        modified: 1,
        format: "markdown",
        indexStatus: "ready",
        indexError: null,
      }],
      currentPath: "guide.md",
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Target section\n\nBody",
      },
      motionLevel: "off",
    });

    const view = render(<App />);
    await waitFor(() => {
      expect(screen.getAllByRole("link", { name: "Target section" }).length).toBeGreaterThan(0);
    });

    const reader = view.container.querySelector<HTMLElement>(".reading-scroll");
    const heading = view.container.querySelector<HTMLElement>("#target-section");
    expect(reader).not.toBeNull();
    expect(heading).not.toBeNull();
    if (!reader || !heading) return;

    reader.scrollTop = 40;
    vi.spyOn(reader, "getBoundingClientRect").mockReturnValue({ top: 58 } as DOMRect);
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({ top: 358 } as DOMRect);

    fireEvent.click(screen.getAllByRole("link", { name: "Target section" })[0]);

    expect(reader.scrollTop).toBe(340);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});

function markdownDocument(relativePath: string, title: string) {
  return {
    relativePath,
    title,
    size: 256,
    modified: 1,
    format: "markdown" as const,
    indexStatus: "ready" as const,
    indexError: null,
  };
}

function markdownAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann-body",
    relativePath: "guide.md",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "Body",
    title: "Body",
    locator: { kind: "markdown", quote: "Body", prefix: "", suffix: "", headingId: null },
    sortIndex: "M|00000|00000000",
    createdAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function setMarkdownState() {
  useReaderStore.setState({
    documents: [markdownDocument("guide.md", "Guide")],
    currentPath: "guide.md",
    currentContent: {
      kind: "markdown",
      relativePath: "guide.md",
      markdown: "## Target section\n\nBody",
    },
    motionLevel: "off",
  });
}

describe("annotation mark editing (B1)", () => {
  it("opens an edit bubble when an existing mark is clicked and deletes through it", async () => {
    vi.mocked(listAnnotations).mockImplementation(async (relativePath?: string | null) =>
      relativePath === "guide.md" ? [markdownAnnotation()] : [],
    );
    setMarkdownState();

    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector("mark.annotation-mark")).not.toBeNull();
    });

    const mark = view.container.querySelector<HTMLElement>("mark.annotation-mark");
    expect(mark).not.toBeNull();
    fireEvent.click(mark!, { clientX: 40, clientY: 60 });

    const bubble = await screen.findByRole("dialog", { name: "编辑标注" });
    expect(bubble).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "改为行动（蓝色）" }));
    await waitFor(() => {
      expect(upsertAnnotation).toHaveBeenCalledWith(
        expect.objectContaining({ id: "ann-body", color: "blue" }),
      );
    });

    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);
    await waitFor(() => {
      expect(deleteAnnotation).toHaveBeenCalledWith("ann-body");
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "编辑标注" })).not.toBeInTheDocument();
    });
  });

  it("does not open the bubble right after a non-collapsed selection", async () => {
    vi.mocked(listAnnotations).mockImplementation(async (relativePath?: string | null) =>
      relativePath === "guide.md" ? [markdownAnnotation()] : [],
    );
    setMarkdownState();

    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector("mark.annotation-mark")).not.toBeNull();
    });
    const mark = view.container.querySelector<HTMLElement>("mark.annotation-mark")!;

    const range = document.createRange();
    range.selectNodeContents(mark);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.click(mark, { clientX: 40, clientY: 60 });
    expect(screen.queryByRole("dialog", { name: "编辑标注" })).not.toBeInTheDocument();
    selection.removeAllRanges();
  });
});

describe("selection capture upgrade (B2/B3)", () => {
  it("captures pointerup selections and saves an underline from the toolbar", async () => {
    setMarkdownState();
    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    const reader = view.container.querySelector<HTMLElement>(".reading-scroll")!;
    const paragraph = view.container.querySelector<HTMLElement>(".markdown-body p")!;
    const textNode = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.pointerDown(reader);
    fireEvent.pointerUp(document);

    const toolbar = await screen.findByRole("toolbar", { name: "标注工具条" });
    expect(toolbar).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下划线" }));
    await waitFor(() => {
      expect(upsertAnnotation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "underline", selectedText: "Body" }),
      );
    });
    expect(await screen.findByText("已保存下划线")).toBeInTheDocument();
  });

  it("applies a highlight in one step when a toolbar color swatch is clicked", async () => {
    setMarkdownState();
    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    const reader = view.container.querySelector<HTMLElement>(".reading-scroll")!;
    const paragraph = view.container.querySelector<HTMLElement>(".markdown-body p")!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(paragraph.firstChild!, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.pointerDown(reader);
    fireEvent.pointerUp(document);
    await screen.findByRole("toolbar", { name: "标注工具条" });

    fireEvent.click(screen.getByRole("button", { name: "以疑问（绿色）高亮" }));
    await waitFor(() => {
      expect(upsertAnnotation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "highlight", color: "green" }),
      );
    });
    expect(useReaderStore.getState().highlightColor).toBe("green");
  });
});

describe("links tab (BL-D3)", () => {
  it("loads the links lazily, shows the backlink badge and jumps to a source", async () => {
    vi.mocked(listDocumentLinks).mockResolvedValue({
      backlinks: [
        { sourcePath: "other.md", sourceTitle: "Other", linkText: "参考指南", count: 2 },
      ],
      outgoing: [],
      brokenCount: 0,
    });
    vi.mocked(readDocument).mockImplementation(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# Other\n\nSecond body",
    }));
    useReaderStore.setState({
      documents: [markdownDocument("guide.md", "Guide"), markdownDocument("other.md", "Other")],
      currentPath: "guide.md",
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Target section\n\nBody",
      },
      motionLevel: "off",
    });

    render(<App />);
    // tab 未打开前不发请求(idle 惰性加载)。
    expect(listDocumentLinks).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("tab", { name: /链接/ })[0]);
    await waitFor(() => {
      expect(listDocumentLinks).toHaveBeenCalledWith("guide.md");
    });
    const region = await screen.findByRole("region", { name: "反向链接" });
    expect(within(region).getByText("Other")).toBeInTheDocument();
    // tab 徽标 = 反链总次数。
    expect(screen.getAllByRole("tab", { name: /链接\s*2/ }).length).toBeGreaterThan(0);

    fireEvent.click(within(region).getByText("Other"));
    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("other.md");
    });
  });

  it("presents the web degradation message as panel text", async () => {
    vi.mocked(listDocumentLinks).mockRejectedValue(new Error("库过大，链接视图未启用"));
    setMarkdownState();

    render(<App />);
    fireEvent.click(screen.getAllByRole("tab", { name: /链接/ })[0]);
    expect(
      (await screen.findAllByText("库过大，链接视图未启用")).length,
    ).toBeGreaterThan(0);
  });
});

describe("related passages entry (RP)", () => {
  it("queries with the current document excluded and jumps through the hit", async () => {
    vi.mocked(findRelatedPassages).mockResolvedValue([
      {
        resultId: "other.md::",
        relativePath: "other.md",
        title: "Other",
        snippet: "……相同主题……",
        score: 2.5,
        format: "markdown",
        locator: null,
      },
    ]);
    vi.mocked(readDocument).mockImplementation(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# Other\n\nSecond body",
    }));
    useReaderStore.setState({
      documents: [markdownDocument("guide.md", "Guide"), markdownDocument("other.md", "Other")],
      currentPath: "guide.md",
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Target section\n\n这是一段足够长的正文内容。",
      },
      motionLevel: "off",
    });

    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    const reader = view.container.querySelector<HTMLElement>(".reading-scroll")!;
    const paragraph = view.container.querySelector<HTMLElement>(".markdown-body p")!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(paragraph.firstChild!, 12);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.pointerDown(reader);
    fireEvent.pointerUp(document);
    await screen.findByRole("toolbar", { name: "标注工具条" });

    fireEvent.click(screen.getByRole("button", { name: "相关" }));
    const dialog = await screen.findByRole("dialog", { name: "相关段落" });
    // 工具条随选区释放而关闭;请求排除当前文档(RP-D3)。
    expect(findRelatedPassages).toHaveBeenCalledWith("这是一段足够长的正文内容", "guide.md");

    fireEvent.click(await within(dialog).findByText("Other"));
    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("other.md");
    });
    expect(screen.queryByRole("dialog", { name: "相关段落" })).not.toBeInTheDocument();
  });

  it("disables the related action for selections below 8 characters", async () => {
    setMarkdownState();
    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    const reader = view.container.querySelector<HTMLElement>(".reading-scroll")!;
    const paragraph = view.container.querySelector<HTMLElement>(".markdown-body p")!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(paragraph.firstChild!, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.pointerDown(reader);
    fireEvent.pointerUp(document);
    await screen.findByRole("toolbar", { name: "标注工具条" });
    expect(screen.getByRole("button", { name: "相关" })).toBeDisabled();
    expect(findRelatedPassages).not.toHaveBeenCalled();
  });
});

describe("notice with undo action (B5)", () => {
  it("runs the action and closes when the action button is clicked", () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(
      <MotionNotice
        id={1}
        message="已保存高亮"
        motionLevel="off"
        actionLabel="撤销"
        onAction={onAction}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("annotation list sorting (B6)", () => {
  it("orders annotations by document position when toggled", async () => {
    const bodyAnnotation = markdownAnnotation({
      id: "ann-late",
      createdAt: 2_000,
      updatedAt: 2_000,
    });
    const headingAnnotation = markdownAnnotation({
      id: "ann-early",
      selectedText: "Target section",
      title: "Target section",
      locator: {
        kind: "markdown",
        quote: "Target section",
        prefix: "",
        suffix: "",
        headingId: "target-section",
      },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    vi.mocked(listAnnotations).mockImplementation(async (relativePath?: string | null) =>
      relativePath === "guide.md" ? [bodyAnnotation, headingAnnotation] : [],
    );
    setMarkdownState();

    const view = render(<App />);
    fireEvent.click(screen.getAllByRole("tab", { name: /标注/ })[0]);
    await waitFor(() => {
      expect(view.container.querySelectorAll(".annotation-list-title").length).toBeGreaterThan(0);
    });

    const titlesBefore = Array.from(
      view.container.querySelectorAll(".annotation-list-title"),
    ).map((node) => node.textContent);
    expect(titlesBefore[0]).toBe("Body");

    fireEvent.click(screen.getAllByRole("button", { name: "按位置" })[0]);
    await waitFor(() => {
      const titles = Array.from(
        view.container.querySelectorAll(".annotation-list-title"),
      ).map((node) => node.textContent);
      expect(titles[0]).toBe("Target section");
    });
  });
});

describe("library-wide annotations (B7)", () => {
  it("lists annotations across documents and jumps into another document", async () => {
    const currentDocAnnotation = markdownAnnotation();
    const otherDocAnnotation = markdownAnnotation({
      id: "ann-other",
      relativePath: "other.md",
      selectedText: "Second body",
      title: "Second body",
      locator: { kind: "markdown", quote: "Second body", prefix: "", suffix: "", headingId: null },
    });
    vi.mocked(listAnnotations).mockImplementation(async (relativePath?: string | null) => {
      const all = [currentDocAnnotation, otherDocAnnotation];
      return relativePath ? all.filter((item) => item.relativePath === relativePath) : all;
    });
    vi.mocked(readDocument).mockImplementation(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# Other\n\nSecond body",
    }));
    useReaderStore.setState({
      documents: [markdownDocument("guide.md", "Guide"), markdownDocument("other.md", "Other")],
      currentPath: "guide.md",
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Target section\n\nBody",
      },
      motionLevel: "off",
    });

    render(<App />);
    fireEvent.click(screen.getAllByRole("tab", { name: "全库" })[0]);

    await waitFor(() => {
      expect(listAnnotations).toHaveBeenCalledWith();
    });

    // 全库缓存失效会触发一次重取,列表节点可能被替换;
    // 在 waitFor 内重查并点击,避免点到已卸载的节点。
    await waitFor(() => {
      const [libraryItem] = screen.getAllByText("Second body");
      fireEvent.click(libraryItem);
      expect(useReaderStore.getState().currentPath).toBe("other.md");
    });
  });
});

describe("library annotation search and filters (方案四 A1)", () => {
  function setTwoDocumentState() {
    useReaderStore.setState({
      documents: [markdownDocument("guide.md", "Guide"), markdownDocument("other.md", "Other")],
      currentPath: "guide.md",
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Target section\n\nBody",
      },
      motionLevel: "off",
    });
  }

  it("debounces the query into one searchAnnotations call and intersects with kind chips", async () => {
    const guideAnnotation = markdownAnnotation();
    const hitHighlight = markdownAnnotation({
      id: "hit-1",
      relativePath: "other.md",
      selectedText: "术语甲",
      title: "术语甲",
      locator: { kind: "markdown", quote: "术语甲", prefix: "", suffix: "", headingId: null },
    });
    const hitBookmark = markdownAnnotation({
      id: "hit-2",
      relativePath: "other.md",
      kind: "bookmark",
      color: null,
      selectedText: null,
      title: "术语乙",
      locator: {
        kind: "bookmark",
        target: { format: "markdown", headingId: null, scrollRatio: 0 },
      },
    });
    vi.mocked(listAnnotations).mockImplementation(async (relativePath?: string | null) => {
      const all = [guideAnnotation, hitHighlight, hitBookmark];
      return relativePath ? all.filter((item) => item.relativePath === relativePath) : all;
    });
    vi.mocked(searchAnnotations).mockResolvedValue([hitHighlight, hitBookmark]);
    setTwoDocumentState();

    render(<App />);
    // 等当前文档标注装载完成(其变更会使全库缓存失效并重建面板),
    // 再打开全库,检索框才不会在输入中途被替换。
    await screen.findAllByRole("tab", { name: /标注\s*1/ });
    fireEvent.click(screen.getAllByRole("tab", { name: "全库" })[0]);
    await waitFor(() => {
      expect(screen.getAllByRole("searchbox", { name: "搜索全库标注" }).length).toBeGreaterThan(0);
    });

    fireEvent.change(screen.getAllByRole("searchbox", { name: "搜索全库标注" })[0], {
      target: { value: "术" },
    });
    fireEvent.change(screen.getAllByRole("searchbox", { name: "搜索全库标注" })[0], {
      target: { value: "术语" },
    });

    // 240ms 防抖:连续输入只触发一次检索调用。
    await waitFor(() => {
      expect(searchAnnotations).toHaveBeenCalledTimes(1);
    });
    expect(searchAnnotations).toHaveBeenCalledWith("术语");
    await waitFor(() => {
      expect(screen.getAllByText("命中 2 条，来自 1 个文档").length).toBeGreaterThan(0);
    });

    // 类型筛选是纯前端过滤,与检索结果求交:书签命中被滤掉。
    fireEvent.click(screen.getAllByRole("button", { name: "高亮" })[0]);
    await waitFor(() => {
      expect(screen.getAllByText("命中 1 条，来自 1 个文档").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("术语乙")).not.toBeInTheDocument();
    expect(searchAnnotations).toHaveBeenCalledTimes(1);
  });

  it("copies a single document group through 导出该文档", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const guideAnnotation = markdownAnnotation();
    vi.mocked(listAnnotations).mockImplementation(async (relativePath?: string | null) =>
      relativePath && relativePath !== "guide.md" ? [] : [guideAnnotation],
    );
    setTwoDocumentState();

    try {
      render(<App />);
      await screen.findAllByRole("tab", { name: /标注\s*1/ });
      fireEvent.click(screen.getAllByRole("tab", { name: "全库" })[0]);
      await waitFor(() => {
        expect(
          screen.getAllByRole("button", { name: "导出 Guide 的标注" }).length,
        ).toBeGreaterThan(0);
      });

      fireEvent.click(screen.getAllByRole("button", { name: "导出 Guide 的标注" })[0]);
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledTimes(1);
      });
      const expected = buildAnnotationsMarkdown([guideAnnotation], {
        documentTitles: new Map([["guide.md", "Guide"]]),
      });
      expect(writeText).toHaveBeenCalledWith(expected);
      expect(await screen.findByText("已复制 1 条标注")).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});

describe("annotation hub view (方案四 A2)", () => {
  it("opens the hub from the library tab link and jumps back to the reader on entry click", async () => {
    const guideAnnotation = markdownAnnotation();
    vi.mocked(listAnnotations).mockImplementation(async (relativePath?: string | null) =>
      relativePath && relativePath !== "guide.md" ? [] : [guideAnnotation],
    );
    setMarkdownState();

    const view = render(<App />);
    await screen.findAllByRole("tab", { name: /标注\s*1/ });
    fireEvent.click(screen.getAllByRole("tab", { name: "全库" })[0]);

    fireEvent.click((await screen.findAllByRole("button", { name: "在中枢中打开" }))[0]);
    expect(useReaderStore.getState().activeView).toBe("annotations");

    await waitFor(() => {
      expect(view.container.querySelector(".annotation-hub-view")).not.toBeNull();
    });
    // 阅读面保持挂载、仅隐藏(stats/home 的挂载模式)。
    expect(view.container.querySelector(".content-grid")).toHaveAttribute("hidden");

    // 中枢与侧栏共享同一套分组/条目组件:同一数据在第二容器完整渲染。
    const hub = view.container.querySelector<HTMLElement>(".annotation-hub-view")!;
    await waitFor(() => {
      expect(within(hub).getByRole("button", { name: "Guide" })).toBeInTheDocument();
    });
    expect(within(hub).getByRole("searchbox", { name: "搜索全库标注" })).toBeInTheDocument();
    expect(
      within(hub).getByRole("navigation", { name: "文档快捷定位" }),
    ).toHaveTextContent("Guide");

    // 中枢内点击条目跳原文:当前文档时切回阅读面再定位。
    fireEvent.click(within(hub).getByText("Body"));
    expect(useReaderStore.getState().activeView).toBe("reader");
  });
});

describe("annotation relocate flow (§5.6 B)", () => {
  function setBrokenAnnotationState(quote: string) {
    const broken = markdownAnnotation({
      id: "ann-lost",
      selectedText: quote,
      title: quote,
      locator: { kind: "markdown", quote, prefix: "", suffix: "", headingId: null },
    });
    vi.mocked(listAnnotations).mockImplementation(async (relativePath?: string | null) =>
      relativePath === "guide.md" ? [broken] : [],
    );
    setMarkdownState();
    return broken;
  }

  async function openUnanchoredGroup() {
    fireEvent.click(screen.getAllByRole("tab", { name: /标注/ })[0]);
    return await screen.findByRole("region", { name: "未锚定标注" });
  }

  it("previews the nearest match and rewrites the locator only after confirmation", async () => {
    // One edit away from the live "Body" text: only the loose pass finds it.
    setBrokenAnnotationState("Bodyy");
    const view = render(<App />);
    await openUnanchoredGroup();

    fireEvent.click(screen.getByRole("button", { name: "在文档中定位此文本" }));

    // The preview mark exists, but nothing has been persisted yet.
    const bar = await screen.findByRole("dialog", { name: "确认重新定位标注" });
    expect(bar).toHaveTextContent("非精确匹配");
    expect(
      view.container.querySelector('[data-annotation-id="reade-relocate-preview"]'),
    ).not.toBeNull();
    expect(upsertAnnotation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "移动标注" }));
    await waitFor(() => {
      expect(upsertAnnotation).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "ann-lost",
          selectedText: "Body",
          locator: expect.objectContaining({ kind: "markdown", quote: "Body" }),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "确认重新定位标注" })).not.toBeInTheDocument();
    });
  });

  it("keeps the locator untouched when the preview is cancelled", async () => {
    setBrokenAnnotationState("Bodyy");
    const view = render(<App />);
    await openUnanchoredGroup();

    fireEvent.click(screen.getByRole("button", { name: "在文档中定位此文本" }));
    await screen.findByRole("dialog", { name: "确认重新定位标注" });

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "确认重新定位标注" })).not.toBeInTheDocument();
    expect(
      view.container.querySelector('[data-annotation-id="reade-relocate-preview"]'),
    ).toBeNull();
    // Zotero "Don't discard": no write happened on any non-confirm path.
    expect(upsertAnnotation).not.toHaveBeenCalled();
  });

  it("reports honestly when nothing similar exists and keeps the annotation", async () => {
    // Longer than the whole document text even under the fuzzy error budget.
    setBrokenAnnotationState("zq wv xk totally absent quote body text passage");
    render(<App />);
    await openUnanchoredGroup();

    fireEvent.click(screen.getByRole("button", { name: "在文档中定位此文本" }));
    expect(
      await screen.findByText("未在当前文档中找到近似文本，标注保持原样。"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "确认重新定位标注" })).not.toBeInTheDocument();
    expect(upsertAnnotation).not.toHaveBeenCalled();
  });
});

describe("lost documents rebind (§5.6 C)", () => {
  it("verifies anchorability against the target body before migrating", async () => {
    const ghostAnnotation = markdownAnnotation({
      id: "ann-ghost",
      relativePath: "ghost.md",
      selectedText: "stable quote",
      title: "stable quote",
      locator: { kind: "markdown", quote: "stable quote", prefix: "", suffix: "", headingId: null },
    });
    vi.mocked(listAnnotations).mockImplementation(async (relativePath?: string | null) => {
      const all = [markdownAnnotation(), ghostAnnotation];
      return relativePath ? all.filter((item) => item.relativePath === relativePath) : all;
    });
    // Ambiguous fingerprint move: two identical candidates, never auto-applied.
    vi.mocked(detectMovedDocuments).mockImplementation(async () => [
      { oldPath: "ghost.md", newPath: "copy-a.md", annotationCount: 1, ambiguous: true },
      { oldPath: "ghost.md", newPath: "copy-b.md", annotationCount: 1, ambiguous: true },
    ]);
    vi.mocked(readDocument).mockImplementation(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# Copy\n\nThe stable quote lives here now.",
    }));
    vi.mocked(rebindDocumentAnnotations).mockImplementation(async () => 1);
    useReaderStore.setState({
      snapshot: { rootPath: "D:/library", documents: [] },
      documents: [
        markdownDocument("guide.md", "Guide"),
        markdownDocument("copy-a.md", "Copy A"),
        markdownDocument("copy-b.md", "Copy B"),
      ],
      currentPath: "guide.md",
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Target section\n\nBody",
      },
      motionLevel: "off",
    });

    render(<App />);
    // 等当前文档的标注装载完成(其变更会使全库缓存失效并重建面板),
    // 再打开全库,失联文档区块才不会在交互中途被重建。
    await screen.findAllByRole("tab", { name: /标注\s*1/ });
    fireEvent.click(screen.getAllByRole("tab", { name: "全库" })[0]);

    const section = await screen.findByRole("region", { name: "失联文档" });
    expect(section).toHaveTextContent("ghost.md");
    // 指纹候选来自异步的 detectMovedDocuments。
    await screen.findByRole("group", { name: "内容指纹相同的候选" });

    fireEvent.change(screen.getByRole("combobox", { name: /ghost\.md/ }), {
      target: { value: "copy-a.md" },
    });
    // The migration stays locked until a dry run has reported.
    expect(screen.getByRole("button", { name: "迁移标注" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "验证锚定" }));
    expect(await screen.findByText(/1 条标注中 1 条可重新锚定/)).toBeInTheDocument();
    expect(rebindDocumentAnnotations).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "迁移标注" }));
    await waitFor(() => {
      expect(rebindDocumentAnnotations).toHaveBeenCalledWith("ghost.md", "copy-a.md");
    });
    expect(await screen.findByText("已迁移 1 条标注记录")).toBeInTheDocument();
  });
});

describe("annotation color naming (plan-annotation-color-names)", () => {
  it("commits a rename on blur, truncates it and resets from the panel", () => {
    render(<ReadingSettingsPanel open onClose={() => undefined} onNotice={() => undefined} />);

    const input = screen.getByRole("textbox", { name: "黄色的语义名" });
    fireEvent.change(input, { target: { value: "灵感摘录" } });
    // 输入过程不提交:store 仍是默认名。
    expect(useReaderStore.getState().annotationColorNames.yellow).toBe("金句");
    fireEvent.blur(input);
    expect(useReaderStore.getState().annotationColorNames.yellow).toBe("灵感摘录");

    // 清空后失焦回落默认名,输入框同步显示回落结果。
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(useReaderStore.getState().annotationColorNames.yellow).toBe("金句");
    expect(input).toHaveValue("金句");

    fireEvent.change(input, { target: { value: "临时名" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "恢复默认命名" }));
    expect(useReaderStore.getState().annotationColorNames).toMatchObject({
      yellow: "金句",
      green: "疑问",
    });
    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: { annotationColorNames?: Record<string, string> } };
    expect(stored.state.annotationColorNames).toMatchObject({ yellow: "金句" });
  });
});

describe("fuzzy anchoring preference (§5.6 D)", () => {
  it("toggles the persisted switch from the reading settings panel", () => {
    render(<ReadingSettingsPanel open onClose={() => undefined} onNotice={() => undefined} />);
    const group = screen.getByRole("group", { name: "标注模糊定位开关" });
    expect(group).toBeInTheDocument();
    expect(
      screen.getByText("文档修改后按相似度匹配失锚标注；可能把标注定位到相似但不同的文本。"),
    ).toBeInTheDocument();

    // 「文档地图」开关加入后,面板里有两组「开启/关闭」;按分组名限定。
    fireEvent.click(
      within(screen.getByRole("group", { name: "标注模糊定位开关" })).getByRole("button", {
        name: "开启",
      }),
    );
    expect(useReaderStore.getState().fuzzyAnnotationAnchoring).toBe(true);
    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: Record<string, unknown> };
    expect(stored.state).toMatchObject({ fuzzyAnnotationAnchoring: true });
  });

  it("feeds the switch into the markdown replay so fuzzy hits stop being broken", async () => {
    const nearMiss = markdownAnnotation({
      id: "ann-near",
      selectedText: "Bodyy",
      title: "Bodyy",
      locator: { kind: "markdown", quote: "Bodyy", prefix: "", suffix: "", headingId: null },
    });
    vi.mocked(listAnnotations).mockImplementation(async (relativePath?: string | null) =>
      relativePath === "guide.md" ? [nearMiss] : [],
    );
    setMarkdownState();
    useReaderStore.setState({ fuzzyAnnotationAnchoring: true });

    const view = render(<App />);
    // The fuzzy step anchors the near-miss quote: a real mark appears and the
    // weak-hint badge marks it as non-exact.
    await waitFor(() => {
      expect(
        view.container.querySelector('mark.annotation-mark[data-annotation-id="ann-near"]'),
      ).not.toBeNull();
    });
    const mark = view.container.querySelector<HTMLElement>(
      'mark.annotation-mark[data-annotation-id="ann-near"]',
    )!;
    expect(mark.classList.contains("annotation-mark--approx")).toBe(true);
    expect(mark.title).toBe("非精确定位");

    fireEvent.click(screen.getAllByRole("tab", { name: /标注/ })[0]);
    expect(screen.queryByRole("region", { name: "未锚定标注" })).not.toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "非精确定位" })).toBeInTheDocument();
  });
});

/* --------------------- TOC heat & coverage (方案三) --------------------- */

describe("TOC heat wiring (T1)", () => {
  const tocItems = [
    { id: "alpha", title: "Alpha", level: 1 },
    { id: "beta", title: "Beta", level: 2 },
  ];

  it("renders the legacy TOC DOM byte-for-byte without a heat prop", () => {
    const { container } = render(
      <TocNavigation items={tocItems} activeId="alpha" onSelect={() => undefined} />,
    );
    // 向后兼容契约:无 heat/coverage 数据时不得出现任何附加 DOM 或属性。
    expect(container.querySelector(".toc-heat")).toBeNull();
    expect(container.querySelector(".toc-unassigned")).toBeNull();
    expect(container.querySelector(".is-reached")).toBeNull();
    expect(container.innerHTML).toBe(
      '<div class="toc-section"><ol class="toc-list">' +
        '<li><a class="toc-link active" style="--toc-depth: 1;" href="#alpha" aria-current="location" title="Alpha">Alpha</a></li>' +
        '<li><a class="toc-link" style="--toc-depth: 2;" href="#beta" title="Beta">Beta</a></li>' +
        "</ol></div>",
    );
  });

  it("renders the estimate line only when provided (TE §3.3)", () => {
    const { container, rerender } = render(
      <TocNavigation items={tocItems} activeId={null} onSelect={() => undefined} />,
    );
    expect(container.querySelector(".toc-estimate")).toBeNull();

    rerender(
      <TocNavigation
        items={tocItems}
        activeId={null}
        onSelect={() => undefined}
        estimateLine="全文约 12 分钟"
      />,
    );
    expect(container.querySelector(".toc-estimate")).toHaveTextContent("全文约 12 分钟");
  });

  it("shows density dots with a11y labels and an unassigned note line", async () => {
    const sectionAnnotation = markdownAnnotation({
      id: "ann-heat",
      selectedText: "Target section",
      title: "Target section",
      locator: {
        kind: "markdown",
        quote: "Target section",
        prefix: "",
        suffix: "",
        headingId: "target-section",
      },
    });
    // headingId null(文首选区)计入 unassignedCount。
    const unassignedAnnotation = markdownAnnotation({ id: "ann-top" });
    vi.mocked(listAnnotations).mockImplementation(async (relativePath?: string | null) =>
      relativePath === "guide.md" ? [sectionAnnotation, unassignedAnnotation] : [],
    );
    useReaderStore.setState({
      documents: [markdownDocument("guide.md", "Guide")],
      currentPath: "guide.md",
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Target section\n\nBody\n\n## Quiet section\n\nMore",
      },
      motionLevel: "off",
    });

    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".toc-heat")).not.toBeNull();
    });

    const hotLink = screen.getAllByRole("link", {
      name: "Target section，本节 1 条标注",
    })[0];
    expect(hotLink).toHaveAttribute("title", "Target section（本节 1 条标注）");
    expect(hotLink.querySelector(".toc-heat")).toHaveAttribute("data-level");

    // 零批注条目不携带任何热力 DOM。
    const quietLink = screen.getAllByRole("link", { name: "Quiet section" })[0];
    expect(quietLink.querySelector(".toc-heat")).toBeNull();
    expect(quietLink).not.toHaveAttribute("aria-label");
    expect(quietLink).toHaveAttribute("title", "Quiet section");

    // 说明行:点击滚回文档顶部。
    const reader = view.container.querySelector<HTMLElement>(".reading-scroll")!;
    reader.scrollTop = 300;
    fireEvent.click(
      screen.getAllByRole("button", { name: "文首或已变更章节另有 1 条标注" })[0],
    );
    expect(reader.scrollTop).toBe(0);
  });
});

describe("TOC read coverage (T2)", () => {
  const COVERAGE_ROOT = "D:\\coverage-lib";

  function setCoverageState() {
    const guide = markdownDocument("guide.md", "Guide");
    useReaderStore.setState({
      snapshot: { rootPath: COVERAGE_ROOT, documents: [guide] },
      documents: [guide],
      currentPath: "guide.md",
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Early section\n\nBody\n\n## Late section\n\nMore",
      },
      motionLevel: "off",
    });
  }

  it("marks sections up to the persisted high-water mark and remeasures on layout changes", async () => {
    writeReadingPosition(COVERAGE_ROOT, "guide.md", { kind: "scroll", scrollRatio: 0.62 });
    setCoverageState();

    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    // jsdom 无布局:给滚动容器与标题手工布置几何(空闲测量将读取它们)。
    const reader = view.container.querySelector<HTMLElement>(".reading-scroll")!;
    Object.defineProperty(reader, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(reader, "clientHeight", { configurable: true, value: 200 });
    vi.spyOn(reader, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    const early = view.container.querySelector<HTMLElement>("#early-section")!;
    const late = view.container.querySelector<HTMLElement>("#late-section")!;
    vi.spyOn(early, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
    const lateRect = vi
      .spyOn(late, "getBoundingClientRect")
      .mockReturnValue({ top: 900 } as DOMRect);

    await waitFor(() => {
      expect(screen.getAllByRole("link", { name: "Early section" })[0]).toHaveClass(
        "is-reached",
      );
    });
    expect(screen.getAllByRole("link", { name: "Late section" })[0]).not.toHaveClass(
      "is-reached",
    );

    // 排版参数变化 → 缓存失效并重测:Late 上移到 40% 处后进入已达区。
    lateRect.mockReturnValue({ top: 400 } as DOMRect);
    useReaderStore.getState().updateReadingSettings({ fontSize: 20 });
    await waitFor(() => {
      expect(screen.getAllByRole("link", { name: "Late section" })[0]).toHaveClass(
        "is-reached",
      );
    });
  });

  it("renders everything as unreached without errors while the cache is not ready", async () => {
    // 无持久化位置、jsdom 布局全零 → 测量返回 null,全部按未达渲染。
    setCoverageState();
    const view = render(<App />);
    await waitFor(() => {
      expect(screen.getAllByRole("link", { name: "Early section" }).length).toBeGreaterThan(0);
    });
    expect(view.container.querySelector(".toc-link.is-reached")).toBeNull();
  });
});

/* ------------------------- Home view (今日视图) ------------------------- */

const HOME_ROOT = "D:\\library";

function homeSession(relativePath: string, endedAt: number): ReadingSession {
  return {
    id: `${relativePath}:${endedAt}`,
    relativePath,
    format: "markdown",
    title: null,
    startedAt: endedAt - 10 * 60 * 1000,
    endedAt,
    activeSeconds: 300,
  };
}

function setLibraryReadingState() {
  const guide = markdownDocument("guide.md", "Guide");
  useReaderStore.setState({
    snapshot: { rootPath: HOME_ROOT, documents: [guide] },
    documents: [guide],
    currentPath: "guide.md",
    currentContent: {
      kind: "markdown",
      relativePath: "guide.md",
      markdown: "## Target section\n\nBody",
    },
    motionLevel: "off",
  });
}

describe("home view mounting (H1)", () => {
  it("disables the home entry until a library is open", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "打开主页" })).toBeDisabled();
  });

  it("toggles home from the sidebar footer and hides the reading grid", async () => {
    setLibraryReadingState();
    const view = render(<App />);

    const homeButton = screen.getByRole("button", { name: "打开主页" });
    expect(homeButton).toHaveAttribute("aria-pressed", "false");
    expect(homeButton).toBeEnabled();
    fireEvent.click(homeButton);

    expect(useReaderStore.getState().activeView).toBe("home");
    await waitFor(() => {
      expect(view.container.querySelector(".home-view")).not.toBeNull();
    });
    // 阅读面保持挂载、仅隐藏(照抄 stats 的挂载模式)。
    expect(view.container.querySelector(".content-grid")).toHaveAttribute("hidden");

    fireEvent.click(screen.getByRole("button", { name: "返回阅读" }));
    expect(useReaderStore.getState().activeView).toBe("reader");
    await waitFor(() => {
      expect(view.container.querySelector(".content-grid")).not.toHaveAttribute("hidden");
    });
    expect(view.container.querySelector(".home-view")).toBeNull();
  });

  it("advances the fresh-documents baseline only when leaving home", async () => {
    setLibraryReadingState();
    render(<App />);

    expect(readHomeBaseline(HOME_ROOT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开主页" }));
    await waitFor(() => {
      expect(useReaderStore.getState().activeView).toBe("home");
    });
    // 停留期间 baseline 不动,列表保持稳定。
    expect(readHomeBaseline(HOME_ROOT)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "返回阅读" }));
    await waitFor(() => {
      expect(readHomeBaseline(HOME_ROOT)).not.toBeNull();
    });
  });
});

describe("review view mounting (方案二 R1)", () => {
  it("enters review from the home card and hides the reading grid", async () => {
    vi.mocked(reviewSummary).mockResolvedValue({ dueCount: 2, reviewedToday: 0 });
    vi.mocked(listReviewQueue).mockResolvedValue([]);
    setLibraryReadingState();

    const view = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "打开主页" }));

    // ④卡由 reviewSummary 探测点亮(本地日界由前端计算)。
    const start = await screen.findByRole("button", { name: "开始回顾" });
    fireEvent.click(start);

    expect(useReaderStore.getState().activeView).toBe("review");
    await waitFor(() => {
      expect(view.container.querySelector(".review-view")).not.toBeNull();
    });
    // 阅读面保持挂载、仅隐藏(stats/home 的挂载模式)。
    expect(view.container.querySelector(".content-grid")).toHaveAttribute("hidden");

    // 空队列态 + 退出回到主页。
    expect(await screen.findByText("今天没有待回顾的标注。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "退出回顾" }));
    expect(useReaderStore.getState().activeView).toBe("home");
  });

  it("keeps the home review card hidden when the probe reports no data", async () => {
    setLibraryReadingState();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "打开主页" }));
    await waitFor(() => {
      expect(useReaderStore.getState().activeView).toBe("home");
    });
    await screen.findByRole("region", { name: "继续阅读" });
    expect(screen.queryByRole("region", { name: "今日回顾" })).not.toBeInTheDocument();
  });
});

describe("cold-start landing (H-D1 option A)", () => {
  function setColdStartState() {
    const guide = markdownDocument("guide.md", "Guide");
    useReaderStore.setState({
      snapshot: { rootPath: HOME_ROOT, documents: [guide] },
      documents: [guide],
      currentPath: null,
      currentContent: null,
      motionLevel: "off",
    });
  }

  it("lands on home when a persisted position exists and skips the auto-open", async () => {
    writeReadingPosition(HOME_ROOT, "guide.md", { kind: "scroll", scrollRatio: 0.4 });
    setColdStartState();

    render(<App />);

    await waitFor(() => {
      expect(useReaderStore.getState().activeView).toBe("home");
    });
    expect(readDocument).not.toHaveBeenCalled();
    expect(useReaderStore.getState().currentPath).toBeNull();
  });

  it("lands on home when 30-day sessions exist without persisted positions", async () => {
    vi.mocked(listReadingSessions).mockResolvedValue([
      homeSession("guide.md", Date.now() - 60_000),
    ]);
    setColdStartState();

    render(<App />);

    await waitFor(() => {
      expect(useReaderStore.getState().activeView).toBe("home");
    });
    expect(readDocument).not.toHaveBeenCalled();
  });

  it("keeps auto-opening the first document when there is no history", async () => {
    vi.mocked(readDocument).mockImplementation(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# Guide\n\nBody",
    }));
    setColdStartState();

    render(<App />);

    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("guide.md");
    });
    expect(useReaderStore.getState().activeView).toBe("reader");
  });

  it("ignores history that only points at documents outside the library", async () => {
    writeReadingPosition(HOME_ROOT, "removed.md", { kind: "scroll", scrollRatio: 0.4 });
    vi.mocked(listReadingSessions).mockResolvedValue([
      homeSession("removed.md", Date.now() - 60_000),
    ]);
    vi.mocked(readDocument).mockImplementation(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# Guide\n\nBody",
    }));
    setColdStartState();

    render(<App />);

    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("guide.md");
    });
    expect(useReaderStore.getState().activeView).toBe("reader");
  });
});

describe("split view (SP)", () => {
  /** ≥1080px 的宽窗环境:分栏媒体查询命中,其余查询保持 false。 */
  function mockWideMatchMedia(): void {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === "(min-width: 1080px)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  it("splits with the current document, keeps selection capture main-only and exits", async () => {
    mockWideMatchMedia();
    vi.mocked(readDocument).mockImplementation(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "## Pane\n\n副栏正文段落。",
    }));
    setMarkdownState();
    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    // 单栏基线:content-grid 上没有任何分栏痕迹。
    const grid = view.container.querySelector(".content-grid")!;
    expect(grid).not.toHaveAttribute("data-split");
    expect(view.container.querySelector(".split-divider")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "开启分栏对照" }));
    expect(grid).toHaveAttribute("data-split", "true");
    // 默认加载当前文档(SP-D4);lazy 副栏挂载后自行 readDocument。
    await waitFor(() => {
      expect(view.container.querySelector(".secondary-pane .markdown-body")).not.toBeNull();
    });
    expect(readDocument).toHaveBeenCalledWith("guide.md");
    const divider = view.container.querySelector(".split-divider");
    expect(divider).toHaveAttribute("aria-valuenow", "50");

    // 副栏内的划选不得触发主栏的选区工具条(批注只属主栏)。
    const paneParagraph = view.container.querySelector<HTMLElement>(
      ".secondary-pane .markdown-body p",
    )!;
    const range = document.createRange();
    range.setStart(paneParagraph.firstChild!, 0);
    range.setEnd(paneParagraph.firstChild!, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    // 主栏滚动根现在包在 reading-frame 里(plan-rich-scrollbar RS-D5)。
    fireEvent.pointerDown(
      view.container.querySelector(".content-grid > .reading-frame > .reading-scroll")!,
    );
    fireEvent.pointerUp(document);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.queryByRole("toolbar", { name: "标注工具条" })).not.toBeInTheDocument();
    selection.removeAllRanges();

    // 副栏 header 的关闭按钮退出分栏,content-grid 回到单栏形态。
    fireEvent.click(screen.getByRole("button", { name: "关闭副栏" }));
    expect(grid).not.toHaveAttribute("data-split");
    expect(view.container.querySelector(".secondary-pane")).toBeNull();
  });

  it("opens tree entries in the pane with Alt+click without touching the main document", async () => {
    mockWideMatchMedia();
    vi.mocked(readDocument).mockImplementation(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# Other\n\n副栏正文。",
    }));
    useReaderStore.setState({
      documents: [markdownDocument("guide.md", "Guide"), markdownDocument("other.md", "Other")],
      currentPath: "guide.md",
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Target section\n\nBody",
      },
      motionLevel: "off",
    });
    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Other" }), { altKey: true });
    await waitFor(() => {
      expect(view.container.querySelector(".secondary-pane")).not.toBeNull();
    });
    expect(readDocument).toHaveBeenCalledWith("other.md");
    // 普通点击链(selectDocument)未被触发:主栏文档不变。
    expect(useReaderStore.getState().currentPath).toBe("guide.md");
  });

  it("disables the split entry while the window is too narrow (SP-D6)", async () => {
    setMarkdownState();
    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });
    expect(screen.getByRole("button", { name: "开启分栏对照" })).toBeDisabled();
  });
});

describe("vertical writing mode (plan-vertical-writing)", () => {
  it("toggles per-document vertical writing from the settings panel and persists it", () => {
    setLibraryReadingState();
    render(
      <ReadingSettingsPanel
        open
        onClose={() => undefined}
        onNotice={() => undefined}
        verticalUnavailableReason={null}
      />,
    );

    const group = screen.getByRole("group", { name: "竖排模式开关" });
    fireEvent.click(within(group).getByRole("button", { name: "开启" }));
    expect(useReaderStore.getState().verticalWriting).toBe(true);
    // 每文档记忆走独立 localStorage 键(VW-D1)。
    expect(readVerticalPreference(HOME_ROOT, "guide.md")).toBe(true);

    fireEvent.click(within(group).getByRole("button", { name: "关闭" }));
    expect(useReaderStore.getState().verticalWriting).toBe(false);
    expect(readVerticalPreference(HOME_ROOT, "guide.md")).toBe(false);
  });

  it("greys the switch out with a reason for out-of-scope formats", () => {
    render(
      <ReadingSettingsPanel
        open
        onClose={() => undefined}
        onNotice={() => undefined}
        verticalUnavailableReason="MDX 文档不在竖排实验范围内。"
      />,
    );
    const group = screen.getByRole("group", { name: "竖排模式开关" });
    expect(within(group).getByRole("button", { name: "开启" })).toBeDisabled();
    expect(within(group).getByRole("button", { name: "关闭" })).toBeDisabled();
    expect(screen.getByText("MDX 文档不在竖排实验范围内。")).toBeInTheDocument();
  });

  it("flips the reading axis, disables vertical-hostile features and recovers on exit", async () => {
    setLibraryReadingState();
    useReaderStore.setState({ verticalWriting: true, showScrollMap: true });

    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    const reader = view.container.querySelector<HTMLElement>(".reading-scroll")!;
    expect(reader).toHaveAttribute("data-writing", "vertical");
    // 文档地图刻度层在竖排下不渲染(定稿矩阵 ⛔;jsdom 零几何下横排
    // 基线本就无刻度,恢复断言以聚焦提示与轴属性为准)。
    expect(view.container.querySelector(".scroll-map")).toBeNull();
    // 聚焦模式置灰并提示原因。
    expect(screen.getByText(/竖排模式下聚焦功能暂停/)).toBeInTheDocument();

    // 退出竖排:轴属性移除、聚焦提示回默认文案。
    useReaderStore.getState().setVerticalWriting(false);
    await waitFor(() => {
      expect(reader).not.toHaveAttribute("data-writing");
    });
    expect(screen.queryByText(/竖排模式下聚焦功能暂停/)).not.toBeInTheDocument();
    expect(screen.getByText(/段落聚焦淡化当前段落以外的内容/)).toBeInTheDocument();
  });

  it("delegates TOC jumps to scrollIntoView while vertical", async () => {
    setMarkdownState();
    useReaderStore.setState({ verticalWriting: true });

    const view = render(<App />);
    await waitFor(() => {
      expect(screen.getAllByRole("link", { name: "Target section" }).length).toBeGreaterThan(0);
    });
    expect(view.container.querySelector(".reading-scroll")).toHaveAttribute(
      "data-writing",
      "vertical",
    );

    fireEvent.click(screen.getAllByRole("link", { name: "Target section" })[0]);
    // 竖排容器的跳转走 scrollIntoView 轴分支(VW-D5)。
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: "start", inline: "nearest" }),
    );
  });
});

describe("reading position persistence (H0)", () => {
  it("persists the scroll ratio through the rAF + trailing debounce pipeline", async () => {
    setLibraryReadingState();
    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    const reader = view.container.querySelector<HTMLElement>(".reading-scroll")!;
    // jsdom 没有布局:手工给出可滚动范围,ratio = 400 / (1000 - 200)。
    Object.defineProperty(reader, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(reader, "clientHeight", { configurable: true, value: 200 });
    reader.scrollTop = 400;
    fireEvent.scroll(reader);

    await waitFor(
      () => {
        expect(readReadingPosition(HOME_ROOT, "guide.md")).toMatchObject({
          kind: "scroll",
          scrollRatio: 0.5,
          maxScrollRatio: 0.5,
        });
      },
      { timeout: 2500 },
    );
  });

  it("restores a persisted ratio when the session map has no entry", async () => {
    writeReadingPosition(HOME_ROOT, "guide.md", { kind: "scroll", scrollRatio: 0.5 });
    setLibraryReadingState();
    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    const reader = view.container.querySelector<HTMLElement>(".reading-scroll")!;
    Object.defineProperty(reader, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(reader, "clientHeight", { configurable: true, value: 200 });
    expect(reader.scrollTop).toBe(0);

    // 触发恢复 effect 重跑(内容对象更新、路径不变、会话 Map 仍为空)。
    useReaderStore.setState({
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Target section\n\nBody",
      },
    });
    await waitFor(() => {
      expect(reader.scrollTop).toBe(400);
    });
  });

  it("prefers the in-session scroll map over the persisted entry", async () => {
    writeReadingPosition(HOME_ROOT, "guide.md", { kind: "scroll", scrollRatio: 0.9 });
    setLibraryReadingState();
    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    const reader = view.container.querySelector<HTMLElement>(".reading-scroll")!;
    Object.defineProperty(reader, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(reader, "clientHeight", { configurable: true, value: 200 });
    // 会话内滚动会写入 Map(rAF 管道)。
    reader.scrollTop = 120;
    fireEvent.scroll(reader);
    await waitFor(() => {
      expect(readReadingPosition(HOME_ROOT, "guide.md")?.kind).toBe("scroll");
    }, { timeout: 2500 });

    // 内容重载时,会话 Map 的精确 scrollTop 优先于持久化 ratio。
    useReaderStore.setState({
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Target section\n\nBody",
      },
    });
    await waitFor(() => {
      expect(reader.scrollTop).toBe(120);
    });
  });
});

describe("command palette (CP)", () => {
  function setPaletteState() {
    useReaderStore.setState({
      snapshot: { rootPath: "D:/palette-lib", documents: [] },
      documents: [
        markdownDocument("guide.md", "Guide"),
        markdownDocument("notes/palette.md", "命令面板笔记"),
      ],
      currentPath: "guide.md",
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Target section\n\nBody",
      },
      motionLevel: "off",
    });
  }

  it("opens on Ctrl+P with preventDefault and closes on Escape", async () => {
    setPaletteState();
    render(<App />);

    // preventDefault 拦掉 WebView2/浏览器的默认打印(fireEvent 返回 false)。
    expect(fireEvent.keyDown(window, { key: "p", ctrlKey: true })).toBe(false);
    const dialog = await screen.findByRole("dialog", { name: "命令面板" });
    expect(within(dialog).getByRole("combobox")).toHaveFocus();

    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument();
  });

  it("switches documents from a filtered entry via Enter", async () => {
    vi.mocked(readDocument).mockImplementation(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# 命令面板\n\n正文",
    }));
    setPaletteState();
    render(<App />);

    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    const input = await screen.findByRole("combobox", { name: "搜索文档、合集与命令" });
    fireEvent.change(input, { target: { value: "命令面板笔记" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("notes/palette.md");
    });
    expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument();
  });

  it("lists collections and executes commands (theme toggle)", async () => {
    vi.mocked(listCollections).mockResolvedValue([
      {
        id: "col-1",
        name: "考研数学",
        createdAt: 1,
        updatedAt: 1,
        itemCount: 3,
        presentCount: 2,
      },
    ]);
    setPaletteState();
    render(<App />);

    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    const input = await screen.findByRole("combobox", { name: "搜索文档、合集与命令" });
    await screen.findByRole("option", { name: /考研数学/ });

    fireEvent.change(input, { target: { value: "深色" } });
    fireEvent.click(screen.getByRole("option", { name: /切换到深色主题/ }));
    expect(useReaderStore.getState().theme).toBe("paper-dark");
  });

  it("toggles closed on a second Ctrl+P", async () => {
    setPaletteState();
    render(<App />);

    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    await screen.findByRole("dialog", { name: "命令面板" });
    expect(fireEvent.keyDown(window, { key: "p", ctrlKey: true })).toBe(false);
    expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument();
  });
});

describe("reading time estimate (plan-reading-time-estimate)", () => {
  it("shows default-speed estimates on tree rows and the TOC head", async () => {
    vi.mocked(listDocumentExtents).mockResolvedValue([
      { relativePath: "guide.md", charCount: 1000, segmentCount: 1, needsOcrSegments: 0 },
    ]);
    setLibraryReadingState();

    const view = render(<App />);
    // 1000 字 ÷ 默认 500 字/分钟 = 约 2 分钟。
    await waitFor(() => {
      expect(view.container.querySelector(".document-tree__estimate")).toHaveTextContent(
        "约 2 分钟",
      );
    });
    await waitFor(() => {
      expect(screen.getAllByText("全文约 2 分钟").length).toBeGreaterThan(0);
    });
    // 冷启动默认速度不带"已校准"后缀。
    expect(screen.queryByText(/个人速度已校准/)).not.toBeInTheDocument();
  });

  it("calibrates the personal speed from sessions and flags the TOC line", async () => {
    const now = Date.now();
    vi.mocked(listDocumentExtents).mockResolvedValue([
      { relativePath: "guide.md", charCount: 900, segmentCount: 1, needsOcrSegments: 0 },
      ...[1, 2, 3, 4, 5].map((index) => ({
        relativePath: `read-${index}.md`,
        charCount: 3000,
        segmentCount: 1,
        needsOcrSegments: 0,
      })),
    ]);
    // 每篇 3000 字读完(coverage 1)用时 300 秒 → 个人速度 600 字/分钟。
    vi.mocked(listReadingSessions).mockImplementation(async () =>
      [1, 2, 3, 4, 5].map((index) => homeSession(`read-${index}.md`, now - 60_000)),
    );
    for (const index of [1, 2, 3, 4, 5]) {
      writeReadingPosition(HOME_ROOT, `read-${index}.md`, { kind: "scroll", scrollRatio: 1 });
    }
    setLibraryReadingState();

    render(<App />);
    // guide 900 字 ÷ 600 字/分钟 → 约 2 分钟,带校准后缀。
    await waitFor(() => {
      expect(screen.getAllByText("全文约 2 分钟 · 个人速度已校准").length).toBeGreaterThan(0);
    });
  });
});

describe("library MRU (plan-library-mru)", () => {
  function seedMru(entries: unknown[]): void {
    localStorage.setItem(
      "reade-library-mru",
      JSON.stringify({ version: 1, entries }),
    );
  }

  it("lists recent libraries on the welcome page, greys out missing paths and opens one", async () => {
    vi.mocked(probeLibraryPath).mockImplementation(async (path: string) => !path.includes("gone"));
    seedMru([
      { path: "D:\\books", title: "books", documentCount: 12, lastOpenedAt: Date.now() },
      { path: "E:\\gone-library", title: "gone-library", documentCount: 3, lastOpenedAt: Date.now() },
    ]);

    render(<App />);
    const list = await screen.findByRole("list", { name: "最近打开" });
    // 失效项由异步探测灰显,title 提示原因;移除钮保持可用。
    await waitFor(() => {
      expect(within(list).getByRole("button", { name: /^gone-library/ })).toBeDisabled();
    });
    expect(within(list).getByRole("button", { name: /^gone-library/ })).toHaveAttribute(
      "title",
      "路径不可访问",
    );

    // 有效项点击直达:完全走 store.openLibrary 的既有校验链。
    fireEvent.click(within(list).getByRole("button", { name: /^books/ }));
    await waitFor(() => {
      expect(openLibrary).toHaveBeenCalledWith("D:\\books");
    });
    expect(useReaderStore.getState().snapshot?.rootPath).toBe("D:\\books");
  });

  it("removes an entry from the welcome list and persists the removal", async () => {
    seedMru([
      { path: "D:\\books", title: "books", documentCount: 12, lastOpenedAt: Date.now() },
      { path: "E:\\notes", title: "notes", documentCount: 4, lastOpenedAt: Date.now() },
    ]);

    render(<App />);
    const list = await screen.findByRole("list", { name: "最近打开" });
    fireEvent.click(
      within(list).getByRole("button", { name: "从最近书库中移除 notes" }),
    );

    expect(within(list).queryByRole("button", { name: /^notes/ })).not.toBeInTheDocument();
    const raw = JSON.parse(localStorage.getItem("reade-library-mru") ?? "{}") as {
      entries: Array<{ path: string }>;
    };
    expect(raw.entries.map((entry) => entry.path)).toEqual(["D:\\books"]);
  });

  it("opens the sidebar switcher, marks the current library and reaches the folder picker", async () => {
    seedMru([
      { path: HOME_ROOT, title: "library", documentCount: 2, lastOpenedAt: Date.now() },
      { path: "E:\\notes", title: "notes", documentCount: 5, lastOpenedAt: Date.now() },
    ]);
    setLibraryReadingState();

    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "library" }));
    const dialog = await screen.findByRole("dialog", { name: "最近书库" });

    // 当前库带"当前"徽标与 aria-current;点它只收起菜单,不重扫。
    const current = within(dialog).getByRole("button", { name: /当前/ });
    expect(current).toHaveAttribute("aria-current", "true");
    fireEvent.click(current);
    expect(openLibrary).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "最近书库" })).not.toBeInTheDocument();

    // 重新打开,走"选择新文件夹…"直达原目录对话框。
    fireEvent.click(screen.getByRole("button", { name: "library" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "最近书库" })).getByRole("button", {
        name: /选择新文件夹/,
      }),
    );
    await waitFor(() => {
      expect(chooseLibraryDirectory).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("dialog", { name: "最近书库" })).not.toBeInTheDocument();
  });

  it("keeps the plain folder dialog when no recent libraries exist", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "选择文档库" }));
    await waitFor(() => {
      expect(chooseLibraryDirectory).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("dialog", { name: "最近书库" })).not.toBeInTheDocument();
  });

  it("upserts the opened library into the MRU store", async () => {
    setLibraryReadingState();
    render(<App />);

    await waitFor(() => {
      const raw = JSON.parse(localStorage.getItem("reade-library-mru") ?? "{}") as {
        entries?: Array<{ path: string; documentCount: number | null }>;
      };
      expect(raw.entries?.[0]).toMatchObject({ path: HOME_ROOT, documentCount: 1 });
    });
  });
});

describe("navigation history (NH)", () => {
  function setNavState() {
    useReaderStore.setState({
      snapshot: { rootPath: "D:/nav-lib", documents: [] },
      documents: [
        markdownDocument("guide.md", "Guide"),
        markdownDocument("notes/other.md", "另一篇笔记"),
      ],
      currentPath: "guide.md",
      currentContent: {
        kind: "markdown",
        relativePath: "guide.md",
        markdown: "## Target section\n\nBody",
      },
      searchQuery: "另一篇",
      searchResults: [
        {
          resultId: "notes/other.md::",
          relativePath: "notes/other.md",
          title: "另一篇笔记",
          snippet: "……",
          score: 1,
          format: "markdown",
          locator: null,
        },
      ],
      navHistory: { back: [], forward: [] },
      motionLevel: "off",
    });
    vi.mocked(readDocument).mockImplementation(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# 目标\n\n正文",
    }));
  }

  it("returns to the departure position after a search jump via Alt+Left, then forward", async () => {
    setNavState();
    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    const backButton = screen.getByRole("button", { name: "后退" });
    const forwardButton = screen.getByRole("button", { name: "前进" });
    expect(backButton).toBeDisabled();
    expect(forwardButton).toBeDisabled();

    // 在 guide.md 里读到 400px 处,点搜索结果跳走。
    const reader = view.container.querySelector<HTMLElement>(".reading-scroll")!;
    reader.scrollTop = 400;
    fireEvent.click(screen.getByRole("button", { name: /另一篇笔记/ }));
    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("notes/other.md");
    });
    expect(backButton).toBeEnabled();

    // Alt+← 回到出发文档与出发位置(事件被 preventDefault,拦掉整页后退)。
    expect(fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true })).toBe(false);
    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("guide.md");
    });
    await waitFor(() => {
      expect(reader.scrollTop).toBe(400);
    });
    expect(forwardButton).toBeEnabled();

    // Alt+→ 原路前进回搜索命中文档。
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("notes/other.md");
    });
    expect(useReaderStore.getState().navHistory.forward).toHaveLength(0);
  });

  it("walks back through the topbar button as well", async () => {
    setNavState();
    const view = render(<App />);
    await waitFor(() => {
      expect(view.container.querySelector(".markdown-body")).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: /另一篇笔记/ }));
    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("notes/other.md");
    });

    fireEvent.click(screen.getByRole("button", { name: "后退" }));
    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("guide.md");
    });
    expect(screen.getByRole("button", { name: "前进" })).toBeEnabled();
  });
});
