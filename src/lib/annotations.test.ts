// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { AnnotationLocator } from "./backend";
import {
  BROKEN_SORT_INDEX,
  DEFAULT_ANNOTATION_COLOR_NAMES,
  annotationKindLabel,
  buildTextIndex,
  colorAccessibleLabel,
  colorDisplayName,
  normalizeAnnotationColorName,
  normalizeAnnotationColorNames,
  clampSelectionText,
  collectElementText,
  createBookmarkAnnotation,
  createHighlightAnnotation,
  createMarkAnnotation,
  deriveAnnotationSortIndex,
  elementTextOffsetInIndex,
  findTextQuote,
  isValidSortIndex,
  normalizePdfRects,
  paintTextQuoteMarks,
  pdfHighlightPaintDecision,
  rangeFromTextIndex,
  resolveTextQuote,
  serializeTextQuote,
  GEOMETRIC_FALLBACK_LABEL,
  type TextQuoteMarkInput,
} from "./annotations";

describe("annotation color names (plan-annotation-color-names)", () => {
  it("falls back to the default name for empty or non-string input", () => {
    expect(normalizeAnnotationColorName("yellow", "")).toBe("暖砂");
    expect(normalizeAnnotationColorName("green", "   ")).toBe("青灰");
    expect(normalizeAnnotationColorName("blue", 42)).toBe("墨蓝");
    expect(normalizeAnnotationColorName("pink", undefined)).toBe("旧粉");
  });

  it("trims and truncates custom names to six characters", () => {
    expect(normalizeAnnotationColorName("yellow", "  灵感  ")).toBe("灵感");
    expect(normalizeAnnotationColorName("yellow", "一二三四五六七八")).toBe("一二三四五六");
  });

  it("normalizes untrusted maps into a complete four-key table", () => {
    expect(normalizeAnnotationColorNames(null)).toEqual(DEFAULT_ANNOTATION_COLOR_NAMES);
    expect(normalizeAnnotationColorNames({ yellow: "灵感", blue: 42, extra: "x" })).toEqual({
      yellow: "灵感",
      green: "青灰",
      blue: "墨蓝",
      pink: "旧粉",
    });
  });

  it("keeps the base color word in the accessible label", () => {
    expect(colorDisplayName("yellow")).toBe("暖砂");
    expect(colorDisplayName("yellow", { yellow: "灵感" })).toBe("灵感");
    expect(colorAccessibleLabel("yellow")).toBe("暖砂（黄色）");
    expect(colorAccessibleLabel("pink", { pink: "生词" })).toBe("生词（粉色）");
  });
});

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
    const painted = paintTextQuoteMarks(root, [
      mark({ id: "left", quote: "alpha ", suffix: "beta" }),
      mark({ id: "right", quote: "beta", prefix: "alpha " }),
      mark({ id: "outer", quote: "gamma delta", markKind: "underline", color: "blue" }),
      mark({ id: "inner", quote: "delta", prefix: "gamma " }),
      mark({ id: "missing", quote: "not in the text" }),
    ]);
    expect(painted.broken).toEqual(["missing"]);
    expect(painted.approximate.size).toBe(0);
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
    const painted = paintTextQuoteMarks(root, [
      mark({ id: "second", quote: "A. yes", suffix: "; ", hintStart: 13 }),
      mark({ id: "first", quote: "A. yes", suffix: "; ", hintStart: 0 }),
    ]);
    expect(painted.broken).toEqual([]);
    const paragraphs = root.querySelectorAll("p");
    expect(paragraphs[0]?.querySelector('[data-annotation-id="first"]')?.textContent).toBe("A. yes");
    expect(paragraphs[1]?.querySelector('[data-annotation-id="second"]')?.textContent).toBe("A. yes");
    expect(paragraphs[0]?.querySelector('[data-annotation-id="second"]')).toBeNull();
    expect(paragraphs[1]?.querySelector('[data-annotation-id="first"]')).toBeNull();
  });

  it("recovers whitespace-divergent quotes only when the option is on", () => {
    const build = () => {
      const root = document.createElement("div");
      const paragraph = document.createElement("p");
      paragraph.textContent = "say hello  world today";
      root.append(paragraph);
      return root;
    };
    const input = [mark({ id: "ws", quote: "hello world", prefix: "say ", suffix: " today" })];
    expect(paintTextQuoteMarks(build(), input).broken).toEqual(["ws"]);
    const root = build();
    expect(
      paintTextQuoteMarks(root, input, undefined, { normalizeWhitespace: true }).broken,
    ).toEqual([]);
    expect(markText(root, "ws")).toBe("hello  world");
  });

  it("reports non-exact hits as approximate and badges the trailing mark segment", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>exact quote here</p><p>say hello  world today</p>";
    const painted = paintTextQuoteMarks(
      root,
      [
        mark({ id: "plain", quote: "exact quote" }),
        mark({ id: "ws", quote: "hello world", prefix: "say ", suffix: " today" }),
      ],
      undefined,
      { normalizeWhitespace: true },
    );
    expect(painted.broken).toEqual([]);
    expect(Array.from(painted.approximate.entries())).toEqual([["ws", "normalized"]]);
    // §5.6 weak hint: title copy on every segment, dot class on the last one.
    const segments = Array.from(
      root.querySelectorAll<HTMLElement>('[data-annotation-id="ws"]'),
    );
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.classList.contains("annotation-mark--approx")).toBe(true);
      expect(segment.title).toBe("非精确定位");
    }
    expect(
      segments[segments.length - 1]?.classList.contains("annotation-mark--approx-tail"),
    ).toBe(true);
    // Exact hits carry no badge.
    const exactSegments = Array.from(
      root.querySelectorAll<HTMLElement>('[data-annotation-id="plain"]'),
    );
    for (const segment of exactSegments) {
      expect(segment.classList.contains("annotation-mark--approx")).toBe(false);
      expect(segment.title).toBe("");
    }
  });
});

describe("pdf highlight paint honesty", () => {
  it("does not paint detached overlays and labels geometric fallback distinctly from approximate", () => {
    expect(pdfHighlightPaintDecision({ status: "detached", fallback: "page" })).toEqual({
      paint: false,
      className: null,
      title: null,
    });
    expect(pdfHighlightPaintDecision({ status: "geometricFallback", page: 4 })).toEqual({
      paint: true,
      className: "pdf-user-highlight--geometric",
      title: GEOMETRIC_FALLBACK_LABEL,
    });
    expect(pdfHighlightPaintDecision({ status: "approximate", method: "fuzzy" }).className).toBe(
      "pdf-user-highlight--approx",
    );
    expect(pdfHighlightPaintDecision({ status: "exact", method: "hint" }).className).toBeNull();
    expect(pdfHighlightPaintDecision({ status: "unchecked" }).className).toBeNull();
  });
});

describe("resolveTextQuote chain (report §5.4)", () => {
  it("resolves a verified position hint before any search", () => {
    // The quote occurs twice; the hint points at the second occurrence even
    // though the first would win an exact search.
    const text = "hello world ... hello world";
    const match = resolveTextQuote(text, "hello world", "", "", { hintStart: 16 });
    expect(match).toEqual({ start: 16, end: 27, method: "hint" });
  });

  it("accepts the hint even when the surrounding context changed", () => {
    // Hint verification is quote-only: context edits around the quote do not
    // push the annotation to another occurrence.
    const text = "EDITED hello world EDITED tail hello world tail";
    const match = resolveTextQuote(text, "hello world", "tail ", " tail", { hintStart: 7 });
    expect(match).toEqual({ start: 7, end: 18, method: "hint" });
  });

  it("falls back to the exact search when the hinted text no longer matches", () => {
    const text = "alpha say hello world today omega";
    const stale = resolveTextQuote(text, "hello world", "say ", " today", { hintStart: 3 });
    expect(stale).toEqual({ start: 10, end: 21, method: "exact" });
    const outOfRange = resolveTextQuote(text, "hello world", "say ", " today", { hintStart: 999 });
    expect(outOfRange).toEqual({ start: 10, end: 21, method: "exact" });
  });

  it("retries with whitespace stripped only when enabled, mapping offsets back", () => {
    const text = "say hello  world today";
    expect(resolveTextQuote(text, "hello world", "say ", " today")).toBeNull();
    const match = resolveTextQuote(text, "hello world", "say ", " today", {
      normalizeWhitespace: true,
    });
    expect(match?.method).toBe("normalized");
    expect(text.slice(match!.start, match!.end)).toBe("hello  world");
  });

  it("uses fuzzy matching only when enabled", () => {
    const text = "say helo world today";
    expect(resolveTextQuote(text, "hello world", "say ", " today")).toBeNull();
    expect(
      resolveTextQuote(text, "hello world", "say ", " today", { normalizeWhitespace: true }),
    ).toBeNull();
    const match = resolveTextQuote(text, "hello world", "say ", " today", {
      normalizeWhitespace: true,
      fuzzy: true,
    });
    expect(match?.method).toBe("fuzzy");
    expect(text.slice(match!.start, match!.end)).toContain("helo world");
  });

  it("ranks fuzzy candidates by quote, then context", () => {
    // Two 1-error candidates; the stored prefix/suffix pick the second.
    const text = "aaa helo world bbb ... say helo world today";
    const match = resolveTextQuote(text, "hello world", "say ", " today", { fuzzy: true });
    expect(match?.method).toBe("fuzzy");
    expect(match!.start).toBe(text.indexOf("helo world", 10));
  });

  it("returns null when every step fails", () => {
    // No shared letters with the quote, so even fuzzy runs out of budget.
    expect(
      resolveTextQuote("1234567890 1234567890", "hello world", "say ", " today", {
        hintStart: 3,
        normalizeWhitespace: true,
        fuzzy: true,
      }),
    ).toBeNull();
    expect(resolveTextQuote("", "hello world", "", "", { fuzzy: true })).toBeNull();
    expect(resolveTextQuote("text", "", "", "")).toBeNull();
  });
});

describe("deriveAnnotationSortIndex (report §5.2)", () => {
  const markdown = (start?: number): AnnotationLocator => ({
    kind: "markdown",
    quote: "q",
    prefix: "",
    suffix: "",
    headingId: null,
    ...(start === undefined ? {} : { start, end: start + 1 }),
  });
  const pdf = (page: number, y: number): AnnotationLocator => ({
    kind: "pdf",
    page,
    view: "original",
    quote: "q",
    prefix: "",
    suffix: "",
    rects: [{ x: 0, y, w: 0.1, h: 0.1 }],
  });
  const epub = (start: number | undefined, block: number, offset: number): AnnotationLocator => ({
    kind: "epub",
    chapterId: "OEBPS/ch1.xhtml",
    blockIndex: block,
    startOffset: offset,
    endOffset: offset + 1,
    quote: "q",
    prefix: "",
    suffix: "",
    ...(start === undefined ? {} : { start, end: start + 1 }),
  });

  it("matches the Rust encodings byte for byte", () => {
    // Values mirrored from the user_store.rs tests to keep both sides in sync.
    expect(deriveAnnotationSortIndex(markdown())).toBe("M|00000|00000000");
    expect(deriveAnnotationSortIndex(markdown(1024))).toBe("M|00000|00001024");
    expect(deriveAnnotationSortIndex(pdf(3, 0.25))).toBe("P|00003|00002500");
    expect(deriveAnnotationSortIndex(epub(7, 2, 15))).toBe("E|00000|00000007");
    expect(deriveAnnotationSortIndex(epub(undefined, 2, 15))).toBe("E|00000|00020015");
    expect(
      deriveAnnotationSortIndex({
        kind: "bookmark",
        target: { format: "pdf", page: 7, offsetRatio: 0.25 },
      }),
    ).toBe("P|00007|25000000");
    expect(
      deriveAnnotationSortIndex({
        kind: "bookmark",
        target: { format: "markdown", headingId: null, scrollRatio: 0.5 },
      }),
    ).toBe("M|00000|50000000");
  });

  it("orders keys as document positions within each format", () => {
    const markdownKeys = [markdown(0), markdown(42), markdown(430), markdown(99_999)].map(
      (locator) => deriveAnnotationSortIndex(locator),
    );
    expect([...markdownKeys].sort()).toEqual(markdownKeys);

    // The page slot dominates the offset slot.
    expect(deriveAnnotationSortIndex(pdf(2, 0.99)) < deriveAnnotationSortIndex(pdf(10, 0.01))).toBe(
      true,
    );
    // Slots clamp instead of overflowing their fixed width.
    expect(deriveAnnotationSortIndex(pdf(200_000, 2))).toBe("P|99999|00020000");
    expect(deriveAnnotationSortIndex(markdown(1_000_000_000))).toBe("M|00000|99999999");

    expect(
      deriveAnnotationSortIndex(epub(undefined, 2, 15)) <
        deriveAnnotationSortIndex(epub(undefined, 3, 0)),
    ).toBe(true);
    const bookmarkAt = (ratio: number) =>
      deriveAnnotationSortIndex({
        kind: "bookmark",
        target: { format: "epub", chapterId: "c1", headingId: null, scrollRatio: ratio },
      });
    expect(bookmarkAt(0.25) < bookmarkAt(0.75)).toBe(true);
  });

  it("uses the chapter order context for epub when provided", () => {
    expect(
      deriveAnnotationSortIndex(epub(undefined, 2, 15), { epubChapterIndex: () => 4 }),
    ).toBe("E|00004|00020015");
    expect(
      deriveAnnotationSortIndex(
        { kind: "bookmark", target: { format: "epub", chapterId: "c9", headingId: null, scrollRatio: 0.5 } },
        { epubChapterIndex: () => 9 },
      ),
    ).toBe("E|00009|50000000");
  });

  it("falls back to the broken key for uninterpretable locators", () => {
    expect(deriveAnnotationSortIndex(null as unknown as AnnotationLocator)).toBe(
      BROKEN_SORT_INDEX,
    );
    expect(
      deriveAnnotationSortIndex({ kind: "mystery" } as unknown as AnnotationLocator),
    ).toBe(BROKEN_SORT_INDEX);
  });

  it("validates the fixed-width format", () => {
    for (const value of [
      deriveAnnotationSortIndex(markdown(1)),
      deriveAnnotationSortIndex(pdf(1, 0.1)),
      deriveAnnotationSortIndex(epub(undefined, 0, 0)),
      BROKEN_SORT_INDEX,
    ]) {
      expect(isValidSortIndex(value)).toBe(true);
    }
    expect(isValidSortIndex("M|0|0")).toBe(false);
    expect(isValidSortIndex("A|00000|00000000")).toBe(false);
    expect(isValidSortIndex("M|00000|0000000a")).toBe(false);
    expect(isValidSortIndex("M|00000|000000000")).toBe(false);
  });
});

describe("locator shape compatibility (old ↔ new)", () => {
  it("accepts legacy locators that lack the v2 optional fields", () => {
    // A locator persisted by an older build: no start/end position hint.
    const legacy = JSON.parse(
      '{"kind":"markdown","quote":"hello world","prefix":"say ","suffix":" today","headingId":"intro"}',
    ) as Extract<AnnotationLocator, { kind: "markdown" }>;
    expect(legacy.start).toBeUndefined();
    expect(deriveAnnotationSortIndex(legacy)).toBe("M|00000|00000000");
    // The chain simply skips the hint step and lands on the exact search.
    const match = resolveTextQuote(
      "alpha say hello world today omega",
      legacy.quote,
      legacy.prefix,
      legacy.suffix,
      { hintStart: legacy.start },
    );
    expect(match).toEqual({ start: 10, end: 21, method: "exact" });

    const legacyPdf = JSON.parse(
      '{"kind":"pdf","page":3,"view":"original","quote":"q","prefix":"","suffix":"","rects":[]}',
    ) as Extract<AnnotationLocator, { kind: "pdf" }>;
    expect(legacyPdf.pageWidth).toBeUndefined();
    expect(deriveAnnotationSortIndex(legacyPdf)).toBe("P|00003|00000000");
  });

  it("round-trips v2 locators with hints and page-size snapshots through JSON", () => {
    const modern: AnnotationLocator = {
      kind: "pdf",
      page: 2,
      view: "original",
      quote: "q",
      prefix: "",
      suffix: "",
      rects: [{ x: 0.1, y: 0.5, w: 0.2, h: 0.02 }],
      pageWidth: 595,
      pageHeight: 842,
    };
    expect(JSON.parse(JSON.stringify(modern))).toEqual(modern);

    const epub: AnnotationLocator = {
      kind: "epub",
      chapterId: "c1",
      blockIndex: 2,
      startOffset: 15,
      endOffset: 25,
      quote: "hello world",
      prefix: "say ",
      suffix: " today",
      start: 16,
      end: 27,
    };
    const parsed = JSON.parse(JSON.stringify(epub)) as Extract<AnnotationLocator, { kind: "epub" }>;
    expect(parsed).toEqual(epub);
    // The persisted hint drives the chain's first step.
    const match = resolveTextQuote("hello world ... hello world", parsed.quote, "", "", {
      hintStart: parsed.start,
    });
    expect(match).toEqual({ start: 16, end: 27, method: "hint" });
  });
});
