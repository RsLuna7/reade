// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { captureReaderSelection } from "./annotationCapture";
import { resolvePdfHighlightRects } from "./annotations";

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
    const rects = resolvePdfHighlightRects({
      textLayer,
      pageRect: rect(0, 0, 800, 1000),
      locator: { quote: "quick brown fox", prefix: "The ", suffix: " jumps", rects: storedRects },
      rectsForRange: () => [rect(80, 100, 160, 20)],
    });
    expect(rects).toEqual([{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }]);
  });

  it("falls back to stored rects when the quote no longer matches", () => {
    const { textLayer } = buildPdfPage();
    const rects = resolvePdfHighlightRects({
      textLayer,
      pageRect: rect(0, 0, 800, 1000),
      locator: { quote: "missing text", prefix: "", suffix: "", rects: storedRects },
      rectsForRange: () => [rect(80, 100, 160, 20)],
    });
    expect(rects).toEqual(storedRects);
  });

  it("falls back to stored rects while the text layer is not rendered yet", () => {
    const rects = resolvePdfHighlightRects({
      textLayer: null,
      pageRect: rect(0, 0, 800, 1000),
      locator: { quote: "quick brown fox", prefix: "", suffix: "", rects: storedRects },
    });
    expect(rects).toEqual(storedRects);
  });

  it("falls back when the re-anchored range measures no visible rects", () => {
    const { textLayer } = buildPdfPage();
    const rects = resolvePdfHighlightRects({
      textLayer,
      pageRect: rect(0, 0, 800, 1000),
      locator: { quote: "quick brown fox", prefix: "The ", suffix: " jumps", rects: storedRects },
      rectsForRange: () => [],
    });
    expect(rects).toEqual(storedRects);
  });
});
