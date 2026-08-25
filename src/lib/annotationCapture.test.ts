// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { captureReaderSelection, buildExcerptDraftFromPending } from "./annotationCapture";
import { MAX_EXCERPT_CHARS } from "./annotationValidation";
import { resolvePdfHighlightRects } from "./annotations";

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

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top } as DOMRect;
}

function buildPdfPage(): { root: HTMLElement; page: HTMLElement; textLayer: HTMLElement } {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  const page = document.createElement("section");
  page.className = "pdf-page";
  page.dataset.pageNumber = "3";
  const textLayer = document.createElement("div");
  textLayer.className = "textLayer pdf-text-layer";
  const first = document.createElement("span");
  first.textContent = "The quick brown fox ";
  const second = document.createElement("span");
  second.textContent = "jumps over the lazy dog";
  textLayer.append(first, second);
  page.append(textLayer);
  root.append(page);
  document.body.append(root);
  page.getBoundingClientRect = () => rect(0, 0, 800, 1000);
  return { root, page, textLayer };
}

describe("pdf original-view selection capture", () => {
  it("captures the quote and page-normalized rects from a text layer selection", () => {
    const { root, textLayer } = buildPdfPage();
    const range = document.createRange();
    range.setStart(textLayer.children[0].firstChild as Text, 4);
    range.setEnd(textLayer.children[1].firstChild as Text, 5);
    range.getClientRects = () => [rect(80, 100, 400, 20)] as unknown as DOMRectList;
    range.getBoundingClientRect = () => rect(80, 100, 400, 20);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const pending = captureReaderSelection({ root, kind: "pdf", pdfMode: "original" });
    expect(pending).not.toBeNull();
    expect(pending!.text).toBe("quick brown fox jumps");
    expect(pending!.locator).toMatchObject({
      kind: "pdf",
      page: 3,
      view: "original",
      quote: "quick brown fox jumps",
      prefix: "The ",
      suffix: " over the lazy dog",
    });
    if (pending!.locator.kind !== "pdf") throw new Error("expected pdf locator");
    expect(pending!.locator.rects).toEqual([{ x: 0.1, y: 0.1, w: 0.5, h: 0.02 }]);
  });
});

describe("quote-first pdf highlight replay", () => {
  const storedRects = [{ x: 0.7, y: 0.9, w: 0.2, h: 0.02 }];

  it("re-anchors rects from the quote against the live text layer", () => {
    const { textLayer } = buildPdfPage();
    const resolved = resolvePdfHighlightRects({
      textLayer,
      pageRect: rect(0, 0, 800, 1000),
      locator: { quote: "quick brown fox", prefix: "The ", suffix: " jumps", rects: storedRects },
      rectsForRange: () => [rect(80, 100, 160, 20)],
    });
    expect(resolved.rects).toEqual([{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }]);
    expect(resolved.method).toBe("exact");
    expect(resolved.resolution).toEqual({ status: "exact", method: "exact" });
  });

  it("falls back to stored rects when the quote no longer matches", () => {
    const { textLayer } = buildPdfPage();
    const resolved = resolvePdfHighlightRects({
      textLayer,
      pageRect: rect(0, 0, 800, 1000),
      locator: { quote: "missing text", prefix: "", suffix: "", rects: storedRects },
      rectsForRange: () => [rect(80, 100, 160, 20)],
      page: 3,
    });
    expect(resolved.rects).toEqual(storedRects);
    expect(resolved.method).toBeNull();
    expect(resolved.resolution).toEqual({ status: "geometricFallback", page: 3 });
  });

  it("falls back to stored rects while the text layer is not rendered yet", () => {
    const resolved = resolvePdfHighlightRects({
      textLayer: null,
      pageRect: rect(0, 0, 800, 1000),
      locator: { quote: "quick brown fox", prefix: "", suffix: "", rects: storedRects },
    });
    expect(resolved.rects).toEqual(storedRects);
    expect(resolved.method).toBeNull();
    expect(resolved.resolution).toEqual({ status: "unchecked" });
  });

  it("falls back when the re-anchored range measures no visible rects", () => {
    const { textLayer } = buildPdfPage();
    const resolved = resolvePdfHighlightRects({
      textLayer,
      pageRect: rect(0, 0, 800, 1000),
      locator: { quote: "quick brown fox", prefix: "The ", suffix: " jumps", rects: storedRects },
      rectsForRange: () => [],
      page: 1,
    });
    expect(resolved.rects).toEqual(storedRects);
    expect(resolved.method).toBeNull();
    expect(resolved.resolution).toEqual({ status: "geometricFallback", page: 1 });
  });

  it("reports detached when the quote and stored rects are both gone", () => {
    const { textLayer } = buildPdfPage();
    const resolved = resolvePdfHighlightRects({
      textLayer,
      pageRect: rect(0, 0, 800, 1000),
      locator: { quote: "missing text", prefix: "", suffix: "", rects: [] },
      page: 2,
    });
    expect(resolved.rects).toEqual([]);
    expect(resolved.resolution).toEqual({ status: "detached", fallback: "page" });
  });

  it("reports a whitespace-normalized re-anchor so callers can badge it", () => {
    const { textLayer } = buildPdfPage();
    // The stored quote has collapsed whitespace relative to the live layer.
    const resolved = resolvePdfHighlightRects({
      textLayer,
      pageRect: rect(0, 0, 800, 1000),
      locator: { quote: "fox  jumps", prefix: "brown ", suffix: " over", rects: storedRects },
      rectsForRange: () => [rect(80, 100, 160, 20)],
    });
    expect(resolved.rects).toEqual([{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }]);
    expect(resolved.method).toBe("normalized");
    expect(resolved.resolution).toEqual({ status: "approximate", method: "normalized" });
  });
});

describe("markdown selection to excerpt draft", () => {
  function buildMarkdownRoot(text: string): HTMLElement {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    const body = document.createElement("div");
    body.className = "markdown-body";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    body.append(paragraph);
    root.append(body);
    document.body.append(root);
    return root;
  }

  function selectIn(root: HTMLElement, start: number, end: number): void {
    const textNode = root.querySelector("p")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  it("captures a markdown quote and builds a validated excerpt draft", () => {
    const root = buildMarkdownRoot("The quick brown fox jumps");
    selectIn(root, 4, 15);
    const pending = captureReaderSelection({ root, kind: "markdown" });
    expect(pending).not.toBeNull();
    expect(pending!.text).toBe("quick brown");
    expect(pending!.locator).toMatchObject({
      kind: "markdown",
      quote: "quick brown",
    });
    const draft = buildExcerptDraftFromPending("notes/a.md", pending!, {
      style: "highlight",
      tone: "sand",
    });
    expect(draft.relativePath).toBe("notes/a.md");
    expect(draft.sourceText).toBe("quick brown");
    expect(draft.appearance).toEqual({ style: "highlight", tone: "sand" });
    expect(draft.anchor.format).toBe("markdown");
  });

  it("builds a pdfText excerpt draft from an original-view selection", () => {
    const { root, textLayer } = buildPdfPage();
    const range = document.createRange();
    range.setStart(textLayer.children[0].firstChild as Text, 4);
    range.setEnd(textLayer.children[1].firstChild as Text, 5);
    range.getClientRects = () => [rect(80, 100, 400, 20)] as unknown as DOMRectList;
    range.getBoundingClientRect = () => rect(80, 100, 400, 20);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const pending = captureReaderSelection({ root, kind: "pdf", pdfMode: "original" });
    expect(pending).not.toBeNull();
    const draft = buildExcerptDraftFromPending("papers/a.pdf", pending!, {
      style: "highlight",
      tone: "sage",
    });
    expect(draft.relativePath).toBe("papers/a.pdf");
    expect(draft.sourceText).toBe("quick brown fox jumps");
    expect(draft.appearance).toEqual({ style: "highlight", tone: "sage" });
    expect(draft.anchor).toMatchObject({
      format: "pdfText",
      page: 3,
      view: "original",
      quote: { exact: "quick brown fox jumps" },
    });
  });

  it("builds a pdfText excerpt draft from a reading-view selection without rects", () => {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    const page = document.createElement("section");
    page.className = "pdf-reading-page";
    page.dataset.pageNumber = "2";
    const body = document.createElement("div");
    body.className = "markdown-body";
    const paragraph = document.createElement("p");
    paragraph.textContent = "The quick brown fox jumps";
    body.append(paragraph);
    page.append(body);
    root.append(page);
    document.body.append(root);
    const textNode = paragraph.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 4);
    range.setEnd(textNode, 15);
    range.getBoundingClientRect = () => rect(10, 20, 120, 16);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const pending = captureReaderSelection({ root, kind: "pdf", pdfMode: "reading" });
    expect(pending).not.toBeNull();
    expect(pending!.locator).toMatchObject({
      kind: "pdf",
      page: 2,
      view: "reading",
      quote: "quick brown",
      rects: [],
    });
    const draft = buildExcerptDraftFromPending("papers/a.pdf", pending!, {
      style: "underline",
      tone: "sand",
    });
    expect(draft.anchor).toMatchObject({
      format: "pdfText",
      page: 2,
      view: "reading",
      quote: { exact: "quick brown" },
      rects: [],
    });
  });

  it("builds an epub excerpt draft from a chapter/block selection", () => {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    const chapter = document.createElement("section");
    chapter.className = "epub-chapter";
    chapter.dataset.chapterId = "ch1";
    const block = document.createElement("div");
    block.className = "epub-block";
    block.dataset.blockIndex = "0";
    block.textContent = "The quick brown fox jumps";
    chapter.append(block);
    root.append(chapter);
    document.body.append(root);
    const textNode = block.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 4);
    range.setEnd(textNode, 15);
    range.getBoundingClientRect = () => rect(10, 20, 100, 16);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const pending = captureReaderSelection({ root, kind: "epub" });
    expect(pending).not.toBeNull();
    const draft = buildExcerptDraftFromPending("book.epub", pending!, {
      style: "underline",
      tone: "slate",
    });
    expect(draft.relativePath).toBe("book.epub");
    expect(draft.sourceText).toBe("quick brown");
    expect(draft.appearance).toEqual({ style: "underline", tone: "slate" });
    expect(draft.anchor).toMatchObject({
      format: "epub",
      chapterId: "ch1",
      blockIndex: 0,
      quote: { exact: "quick brown" },
    });
  });

  it("rejects an overlong selection instead of truncating it", () => {
    const text = `start ${"汉".repeat(MAX_EXCERPT_CHARS)} end`;
    const root = buildMarkdownRoot(text);
    const paragraph = root.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const pending = captureReaderSelection({ root, kind: "markdown" });
    expect(pending).not.toBeNull();
    expect(Array.from(pending!.text).length).toBeGreaterThan(MAX_EXCERPT_CHARS);
    expect(() =>
      buildExcerptDraftFromPending("notes/a.md", pending!, { style: "highlight", tone: "sand" }),
    ).toThrow(/不能超过/);
  });
});
