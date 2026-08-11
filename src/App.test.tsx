// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { MotionNotice, ReadingSettingsPanel } from "./App";
import { DEFAULT_READING_SETTINGS, useReaderStore } from "./store/useReaderStore";

class TestIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
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
          chapters: [{ id: "one", title: "第一章", blocks: [] }],
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
