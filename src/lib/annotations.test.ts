// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  annotationKindLabel,
  buildTextIndex,
  clampSelectionText,
  collectElementText,
  createBookmarkAnnotation,
  createHighlightAnnotation,
  createMarkAnnotation,
  elementTextOffsetInIndex,
  findTextQuote,
  normalizePdfRects,
  paintTextQuoteMarks,
  rangeFromTextIndex,
  serializeTextQuote,
  type TextQuoteMarkInput,
} from "./annotations";

describe("annotations helpers", () => {
  it("serializes and finds text quotes with surrounding context", () => {
    const text = "alpha say hello world today omega";
    const quote = serializeTextQuote(text, 10, 21);
    expect(quote).toEqual({
      quote: "hello world",
      prefix: "alpha say ",
      suffix: " today omega",
    });
    expect(findTextQuote(text, quote!.quote, quote!.prefix, quote!.suffix)).toEqual({
      start: 10,
      end: 21,
    });
  });

  it("clamps oversized selections and builds highlight payloads", () => {
    const selected = "x".repeat(2500);
    expect(clampSelectionText(selected).length).toBe(2000);
    const annotation = createHighlightAnnotation({
      relativePath: "notes/a.md",
      color: "green",
      selectedText: selected,
      locator: {
        kind: "markdown",
        quote: "hello",
        prefix: "",
        suffix: "",
        headingId: null,
      },
    });
    expect(annotation.kind).toBe("highlight");
    expect(annotation.color).toBe("green");
    expect(annotation.selectedText?.length).toBe(2000);
  });

  it("builds underline mark annotations", () => {
    const annotation = createMarkAnnotation({
      relativePath: "notes/a.md",
      kind: "underline",
      color: "blue",
      selectedText: "underlined phrase",
      locator: {
        kind: "markdown",
        quote: "underlined phrase",
        prefix: "",
        suffix: "",
        headingId: null,
      },
    });
    expect(annotation.kind).toBe("underline");
    expect(annotation.color).toBe("blue");
    expect(annotationKindLabel("underline")).toBe("下划线");
  });

  it("builds bookmark payloads and normalizes pdf rects", () => {
    const bookmark = createBookmarkAnnotation({
      relativePath: "book.pdf",
      target: { format: "pdf", page: 3, offsetRatio: 0.25 },
      title: "Page 3",
    });
    expect(bookmark.locator).toEqual({
      kind: "bookmark",
      target: { format: "pdf", page: 3, offsetRatio: 0.25 },
    });
    const page = { left: 100, top: 50, width: 200, height: 400 } as DOMRect;
    const rects = normalizePdfRects([{ left: 120, top: 90, width: 40, height: 20 } as DOMRect], page);
    expect(rects).toEqual([{ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }]);
  });

  it("produces scale-invariant fractions for the same logical pdf selection", () => {
    const atScale1 = normalizePdfRects(
      [{ left: 150, top: 250, width: 100, height: 20 }],
      { left: 100, top: 200, width: 500, height: 700 },
    );
    const atScale2 = normalizePdfRects(
      [{ left: 200, top: 300, width: 200, height: 40 }],
      { left: 100, top: 200, width: 1000, height: 1400 },
    );
    expect(atScale1).toEqual(atScale2);
    expect(atScale1).toEqual([{ x: 0.1, y: 50 / 700, w: 0.2, h: 20 / 700 }]);
  });
});

describe("findTextQuote disambiguation", () => {
  // The quote occurs three times with identical context, like repeated
  // option lines in exam papers.
  const segment = "Q answer: A. yes; ";
  const text = segment.repeat(3);
  const quote = "A. yes";
  const prefix = "answer: ";
  const suffix = "; ";

  it("keeps returning the first occurrence without a hint", () => {
    expect(findTextQuote(text, quote, prefix, suffix)).toEqual({ start: 10, end: 16 });
    expect(findTextQuote(text, quote, prefix, suffix, {})).toEqual({ start: 10, end: 16 });
  });

  it("resolves repeated quotes to the occurrence nearest the hint", () => {
    expect(findTextQuote(text, quote, prefix, suffix, { hintStart: 0 })).toEqual({ start: 10, end: 16 });
    expect(findTextQuote(text, quote, prefix, suffix, { hintStart: 27 })).toEqual({ start: 28, end: 34 });
    expect(findTextQuote(text, quote, prefix, suffix, { hintStart: 44 })).toEqual({ start: 46, end: 52 });
    expect(findTextQuote(text, quote, prefix, suffix, { hintStart: 999 })).toEqual({ start: 46, end: 52 });
  });

  it("prefers occurrences whose full stored context matches strictly", () => {
    // The first occurrence sits at the start of the text, so its truncated
    // prefix only passes the loose check; the second has the full context.
    const doc = "A. yes; tail Q answer: A. yes; tail";
    expect(findTextQuote(doc, "A. yes", "answer: ", "; tail")).toEqual({ start: 23, end: 29 });
    // Strict context wins even when the hint points at the loose match.
    expect(findTextQuote(doc, "A. yes", "answer: ", "; tail", { hintStart: 0 })).toEqual({ start: 23, end: 29 });
  });
});

describe("text index", () => {
  function buildRoot(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html;
    return root;
  }

  it("matches collectElementText and resolves offsets without re-walking", () => {
    const root = buildRoot("<p>hello <strong>brave</strong> world</p><p>again</p>");
    const index = buildTextIndex(root);
    expect(index.text).toBe(collectElementText(root));
    expect(index.text).toBe("hello brave worldagain");
    expect(rangeFromTextIndex(index, 6, 11)?.toString()).toBe("brave");
    expect(rangeFromTextIndex(index, 3, 14)?.toString()).toBe("lo brave wo");
    expect(rangeFromTextIndex(index, 0, index.text.length)?.toString()).toBe(index.text);
  });

  it("rejects empty and out-of-bounds offsets", () => {
    const index = buildTextIndex(buildRoot("<p>abc</p>"));
    expect(rangeFromTextIndex(index, 1, 1)).toBeNull();
    expect(rangeFromTextIndex(index, 2, 1)).toBeNull();
    expect(rangeFromTextIndex(index, -1, 2)).toBeNull();
    expect(rangeFromTextIndex(index, 0, 4)).toBeNull();
  });

  it("returns the text offset of an element for heading hints", () => {
    const root = buildRoot('<h2 id="a">First</h2><p>alpha</p><h2 id="b">Second</h2><p>beta</p>');
    const index = buildTextIndex(root);
    expect(elementTextOffsetInIndex(index, root.querySelector("#a")!)).toBe(0);
    expect(elementTextOffsetInIndex(index, root.querySelector("#b")!)).toBe("Firstalpha".length);
  });
});

describe("paintTextQuoteMarks", () => {
  function markText(root: HTMLElement, id: string): string {
    return Array.from(root.querySelectorAll(`[data-annotation-id="${id}"]`))
      .map((mark) => mark.textContent ?? "")
      .join("");
  }

  function mark(overrides: Partial<TextQuoteMarkInput> & { id: string; quote: string }): TextQuoteMarkInput {
    return { color: "yellow", markKind: "highlight", prefix: "", suffix: "", ...overrides };
  }

  it("paints adjacent, overlapping and nested marks from one shared index", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>alpha beta gamma delta</p><p>omega</p>";
    const broken = paintTextQuoteMarks(root, [
      mark({ id: "left", quote: "alpha ", suffix: "beta" }),
      mark({ id: "right", quote: "beta", prefix: "alpha " }),
      mark({ id: "outer", quote: "gamma delta", markKind: "underline", color: "blue" }),
      mark({ id: "inner", quote: "delta", prefix: "gamma " }),
      mark({ id: "missing", quote: "not in the text" }),
    ]);
    expect(broken).toEqual(["missing"]);
    // Wrapping must not lose or reorder any document text.
    expect(root.textContent).toBe("alpha beta gamma deltaomega");
    expect(markText(root, "left")).toBe("alpha ");
    expect(markText(root, "right")).toBe("beta");
    expect(markText(root, "outer")).toBe("gamma delta");
    expect(markText(root, "inner")).toBe("delta");
  });

  it("disambiguates repeated quotes with per-mark hints", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>A. yes; first</p><p>A. yes; second</p>";
    const broken = paintTextQuoteMarks(root, [
      mark({ id: "second", quote: "A. yes", suffix: "; ", hintStart: 13 }),
      mark({ id: "first", quote: "A. yes", suffix: "; ", hintStart: 0 }),
    ]);
    expect(broken).toEqual([]);
    const paragraphs = root.querySelectorAll("p");
    expect(paragraphs[0]?.querySelector('[data-annotation-id="first"]')?.textContent).toBe("A. yes");
    expect(paragraphs[1]?.querySelector('[data-annotation-id="second"]')?.textContent).toBe("A. yes");
    expect(paragraphs[0]?.querySelector('[data-annotation-id="second"]')).toBeNull();
    expect(paragraphs[1]?.querySelector('[data-annotation-id="first"]')).toBeNull();
  });
});
