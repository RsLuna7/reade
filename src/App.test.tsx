// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { MotionNotice, ReadingSettingsPanel } from "./App";
import {
  deleteAnnotation,
  listAnnotations,
  readDocument,
  upsertAnnotation,
  type Annotation,
} from "./lib/backend";
import { DEFAULT_READING_SETTINGS, useReaderStore } from "./store/useReaderStore";

vi.mock("./lib/backend", async () => {
  const actual = await vi.importActual<typeof import("./lib/backend")>("./lib/backend");
  return {
    ...actual,
    listAnnotations: vi.fn(async () => []),
    upsertAnnotation: vi.fn(async (annotation) => annotation),
    deleteAnnotation: vi.fn(async () => undefined),
    clearDocumentAnnotations: vi.fn(async () => undefined),
    readDocument: vi.fn(async () => {
      throw new Error("readDocument not mocked");
    }),
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
  vi.mocked(readDocument).mockReset().mockImplementation(async () => {
    throw new Error("readDocument not mocked");
  });
  useReaderStore.setState({
    snapshot: null,
    documents: [],
    currentPath: null,
    currentContent: null,
    currentLocator: null,
    indexProgress: null,
    searchQuery: "",
    searchResults: [],
    theme: "light",
    readingSettings: { ...DEFAULT_READING_SETTINGS },
    motionLevel: "subtle",
    expandedPaths: [],
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

    fireEvent.click(screen.getByRole("button", { name: "改为蓝色" }));
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

    fireEvent.click(screen.getByRole("button", { name: "以绿色高亮" }));
    await waitFor(() => {
      expect(upsertAnnotation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "highlight", color: "green" }),
      );
    });
    expect(useReaderStore.getState().highlightColor).toBe("green");
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
