// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentInfo, DocumentPreview } from "./backend";
import {
  extractFootnoteText,
  FOCUS_PREVIEW_DELAY_MS,
  HOVER_PREVIEW_CLOSE_GRACE_MS,
  HOVER_PREVIEW_DELAY_MS,
  useHoverPreview,
  type UseHoverPreviewOptions,
} from "./useHoverPreview";

function documentInfo(relativePath: string): DocumentInfo {
  return {
    relativePath,
    title: `${relativePath} 标题`,
    size: 1,
    modified: 1,
    format: relativePath.endsWith(".pdf") ? "pdf" : "markdown",
    indexStatus: "ready",
    indexError: null,
  };
}

const READY_PREVIEW: DocumentPreview = {
  title: "目标文档",
  format: "markdown",
  excerpt: "预览摘录",
  pdfPages: null,
  indexStatus: "ready",
};

function setup(overrides: Partial<UseHoverPreviewOptions> = {}) {
  const article = document.createElement("article");
  document.body.appendChild(article);
  const anchor = document.createElement("a");
  document.body.appendChild(anchor);
  const loadPreview = vi.fn(() => Promise.resolve(READY_PREVIEW));
  const options: UseHoverPreviewOptions = {
    enabled: true,
    currentPath: "guides/source.md",
    documents: [documentInfo("guides/source.md"), documentInfo("notes/target.md")],
    articleRef: { current: article },
    loadPreview,
    ...overrides,
  };
  const hook = renderHook((props: UseHoverPreviewOptions) => useHoverPreview(props), {
    initialProps: options,
  });
  return { hook, anchor, article, loadPreview, options };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useHoverPreview", () => {
  it("opens a document preview after the 400ms hover intent", async () => {
    const { hook, anchor, loadPreview } = setup();
    act(() => {
      hook.result.current.previewLink("../notes/target.md#细节", anchor, "hover");
    });
    expect(loadPreview).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
    });
    expect(loadPreview).toHaveBeenCalledWith("notes/target.md", "细节");
    expect(hook.result.current.preview?.data).toMatchObject({
      kind: "document",
      status: "loading",
    });

    await flushAsync();
    expect(hook.result.current.preview?.data).toMatchObject({
      kind: "document",
      status: "ready",
      title: "目标文档",
      excerpt: "预览摘录",
    });
  });

  it("never requests when the pointer leaves before the delay", () => {
    const { hook, anchor, loadPreview } = setup();
    act(() => {
      hook.result.current.previewLink("../notes/target.md", anchor, "hover");
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS - 100);
      hook.result.current.cancelPreview();
      vi.advanceTimersByTime(1_000);
    });
    expect(loadPreview).not.toHaveBeenCalled();
    expect(hook.result.current.preview).toBeNull();
  });

  it("serves repeat hovers from the LRU without a second request", async () => {
    const { hook, anchor, loadPreview } = setup();
    act(() => {
      hook.result.current.previewLink("../notes/target.md", anchor, "hover");
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
    });
    await flushAsync();
    act(() => {
      hook.result.current.closePreview();
    });

    act(() => {
      hook.result.current.previewLink("../notes/target.md", anchor, "hover");
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
    });
    expect(loadPreview).toHaveBeenCalledTimes(1);
    expect(hook.result.current.preview?.data).toMatchObject({
      status: "ready",
      excerpt: "预览摘录",
    });
  });

  it("previews footnotes from the DOM without any request", () => {
    const { hook, anchor, article, loadPreview } = setup();
    const section = document.createElement("section");
    section.dataset.footnotes = "";
    const item = document.createElement("li");
    item.id = "user-content-fn-1";
    item.textContent = "脚注正文 ↩";
    section.appendChild(item);
    article.appendChild(section);

    act(() => {
      hook.result.current.previewLink("#user-content-fn-1", anchor, "hover");
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
    });
    expect(loadPreview).not.toHaveBeenCalled();
    expect(hook.result.current.preview?.data).toEqual({
      kind: "footnote",
      text: "脚注正文",
    });
  });

  it("ignores external links, plain anchors and out-of-library targets", () => {
    const { hook, anchor, loadPreview } = setup();
    act(() => {
      hook.result.current.previewLink("https://example.com/page", anchor, "hover");
      hook.result.current.previewLink("mailto:a@b.c", anchor, "hover");
      hook.result.current.previewLink("#some-heading", anchor, "hover");
      hook.result.current.previewLink("../../escape.md", anchor, "hover");
      hook.result.current.previewLink("./missing.md", anchor, "hover");
      vi.advanceTimersByTime(10_000);
    });
    expect(loadPreview).not.toHaveBeenCalled();
    expect(hook.result.current.preview).toBeNull();
  });

  it("uses the longer 600ms delay for keyboard focus", () => {
    const { hook, anchor, loadPreview } = setup();
    act(() => {
      hook.result.current.previewLink("../notes/target.md", anchor, "focus");
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
    });
    expect(loadPreview).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(FOCUS_PREVIEW_DELAY_MS - HOVER_PREVIEW_DELAY_MS);
    });
    expect(loadPreview).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and on any scroll", async () => {
    const { hook, anchor } = setup();
    act(() => {
      hook.result.current.previewLink("../notes/target.md", anchor, "hover");
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
    });
    await flushAsync();
    expect(hook.result.current.preview).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(hook.result.current.preview).toBeNull();

    act(() => {
      hook.result.current.previewLink("../notes/target.md", anchor, "hover");
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
    });
    await flushAsync();
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(hook.result.current.preview).toBeNull();
  });

  it("keeps the card open when the pointer moves into it within the grace", async () => {
    const { hook, anchor } = setup();
    act(() => {
      hook.result.current.previewLink("../notes/target.md", anchor, "hover");
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
    });
    await flushAsync();

    act(() => {
      hook.result.current.cancelPreview();
      vi.advanceTimersByTime(HOVER_PREVIEW_CLOSE_GRACE_MS - 50);
      hook.result.current.holdPreview();
      vi.advanceTimersByTime(1_000);
    });
    expect(hook.result.current.preview).not.toBeNull();

    act(() => {
      hook.result.current.cancelPreview();
      vi.advanceTimersByTime(HOVER_PREVIEW_CLOSE_GRACE_MS);
    });
    expect(hook.result.current.preview).toBeNull();
  });

  it("does nothing while disabled and closes when disabled flips on", async () => {
    const { hook, anchor, loadPreview, options } = setup();
    act(() => {
      hook.result.current.previewLink("../notes/target.md", anchor, "hover");
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
    });
    await flushAsync();
    expect(hook.result.current.preview).not.toBeNull();

    hook.rerender({ ...options, enabled: false });
    expect(hook.result.current.preview).toBeNull();

    act(() => {
      hook.result.current.previewLink("../notes/target.md", anchor, "hover");
      vi.advanceTimersByTime(10_000);
    });
    expect(loadPreview).toHaveBeenCalledTimes(1);
  });

  it("previews side-panel targets through the root-anchored href form", async () => {
    const { hook, anchor, loadPreview } = setup();
    act(() => {
      hook.result.current.previewTarget("notes/target.md", null, anchor, "hover");
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
    });
    await flushAsync();
    expect(loadPreview).toHaveBeenCalledWith("notes/target.md", null);
    expect(hook.result.current.preview?.data).toMatchObject({
      kind: "document",
      href: "/notes/target.md",
    });
  });
});

describe("extractFootnoteText", () => {
  it("strips back-reference arrows and collapses whitespace", () => {
    const article = document.createElement("article");
    const item = document.createElement("li");
    item.id = "user-content-fn-2";
    item.textContent = "  多行\n 脚注 ↩\uFE0E ";
    article.appendChild(item);
    expect(extractFootnoteText(article, "#user-content-fn-2")).toBe("多行 脚注");
  });

  it("returns null for missing targets and non-footnote hrefs", () => {
    const article = document.createElement("article");
    expect(extractFootnoteText(article, "#user-content-fn-9")).toBeNull();
    expect(extractFootnoteText(article, "#plain-heading")).toBeNull();
    expect(extractFootnoteText(null, "#user-content-fn-1")).toBeNull();
  });
});
