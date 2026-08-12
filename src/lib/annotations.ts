import type {
  Annotation,
  AnnotationColor,
  AnnotationKind,
  AnnotationLocator,
  AnnotationRect,
  BookmarkTarget,
} from "./backend";

export const ANNOTATION_COLORS: AnnotationColor[] = ["yellow", "green", "blue", "pink"];
export const MAX_SELECTION_CHARS = 2000;
export const TEXT_QUOTE_CONTEXT = 32;

export type AnnotationMarkKind = "highlight" | "underline";

export function isAnnotationMarkKind(kind: AnnotationKind): kind is AnnotationMarkKind {
  return kind === "highlight" || kind === "underline";
}

export interface TextQuoteMatch {
  start: number;
  end: number;
}

export interface SerializedTextQuote {
  quote: string;
  prefix: string;
  suffix: string;
}

export function createAnnotationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clampSelectionText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_SELECTION_CHARS) return normalized;
  return normalized.slice(0, MAX_SELECTION_CHARS);
}

export function serializeTextQuote(
  fullText: string,
  start: number,
  end: number,
): SerializedTextQuote | null {
  if (start < 0 || end <= start || end > fullText.length) return null;
  const quote = fullText.slice(start, end);
  if (!quote.trim()) return null;
  const prefix = fullText.slice(Math.max(0, start - TEXT_QUOTE_CONTEXT), start);
  const suffix = fullText.slice(end, Math.min(fullText.length, end + TEXT_QUOTE_CONTEXT));
  return { quote, prefix, suffix };
}

export interface FindTextQuoteOptions {
  /**
   * Expected start offset of the quote. When the same quote (with similar
   * context) occurs several times, the candidate closest to the hint wins.
   */
  hintStart?: number;
}

/**
 * Locates a serialized text quote in `fullText`.
 *
 * All occurrences passing the loose context check are considered; candidates
 * whose full stored context matches strictly are preferred over truncated
 * (loose) matches. With `hintStart` the nearest candidate by start offset is
 * chosen; without a hint the first candidate wins, as before.
 */
export function findTextQuote(
  fullText: string,
  quote: string,
  prefix: string,
  suffix: string,
  options?: FindTextQuoteOptions,
): TextQuoteMatch | null {
  if (!quote) return null;
  const hintStart = options?.hintStart;
  const hasHint = typeof hintStart === "number" && Number.isFinite(hintStart);
  let best: { start: number; end: number; strict: boolean } | null = null;
  let searchFrom = 0;
  while (searchFrom <= fullText.length) {
    const index = fullText.indexOf(quote, searchFrom);
    if (index < 0) break;
    const end = index + quote.length;
    const actualPrefix = fullText.slice(Math.max(0, index - prefix.length), index);
    const actualSuffix = fullText.slice(end, end + suffix.length);
    const strictPrefix = actualPrefix.endsWith(prefix);
    const strictSuffix = actualSuffix.startsWith(suffix);
    const prefixOk = !prefix || strictPrefix || prefix.endsWith(actualPrefix);
    const suffixOk = !suffix || strictSuffix || suffix.startsWith(actualSuffix);
    if (prefixOk && suffixOk) {
      const strict = strictPrefix && strictSuffix;
      // Without a hint nothing can beat the first strict candidate.
      if (strict && !hasHint) return { start: index, end };
      const beatsBest =
        !best ||
        (strict && !best.strict) ||
        (strict === best.strict &&
          hasHint &&
          Math.abs(index - hintStart) < Math.abs(best.start - hintStart));
      if (beatsBest) best = { start: index, end, strict };
    }
    searchFrom = index + 1;
  }
  return best ? { start: best.start, end: best.end } : null;
}

export function collectElementText(root: ParentNode): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  let node = walker.nextNode();
  while (node) {
    text += node.textContent ?? "";
    node = walker.nextNode();
  }
  return text;
}

export interface TextIndexEntry {
  node: Text;
  start: number;
}

export interface TextIndex {
  text: string;
  entries: TextIndexEntry[];
}

/**
 * Walks `root` once and records every text node with its flattened start
 * offset, so repeated quote searches and range construction no longer need
 * one full tree traversal per annotation.
 */
export function buildTextIndex(root: ParentNode): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const entries: TextIndexEntry[] = [];
  let text = "";
  let node = walker.nextNode() as Text | null;
  while (node) {
    entries.push({ node, start: text.length });
    text += node.data;
    node = walker.nextNode() as Text | null;
  }
  return { text, entries };
}

/** First entry whose end offset reaches `offset` (same rule as rangeFromOffsets). */
function locateTextIndexEntry(index: TextIndex, offset: number): TextIndexEntry | null {
  const { entries, text } = index;
  if (!entries.length) return null;
  let low = 0;
  let high = entries.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    const end = mid + 1 < entries.length ? entries[mid + 1].start : text.length;
    if (end >= offset) high = mid;
    else low = mid + 1;
  }
  return entries[low];
}

/**
 * Builds a Range from flattened offsets using a prebuilt index instead of
 * re-walking the tree. Returns null when the offsets are invalid or when the
 * indexed node no longer covers the local offset (e.g. a previous
 * `wrapRangeWithMark` split it); callers may then fall back to
 * `rangeFromOffsets` against the live DOM.
 */
export function rangeFromTextIndex(index: TextIndex, start: number, end: number): Range | null {
  if (start < 0 || end <= start || end > index.text.length) return null;
  const startEntry = locateTextIndexEntry(index, start);
  const endEntry = locateTextIndexEntry(index, end);
  if (!startEntry || !endEntry) return null;
  const startOffset = start - startEntry.start;
  const endOffset = end - endEntry.start;
  if (startOffset < 0 || startOffset > startEntry.node.data.length) return null;
  if (endOffset < 0 || endOffset > endEntry.node.data.length) return null;
  const range = document.createRange();
  range.setStart(startEntry.node, startOffset);
  range.setEnd(endEntry.node, endOffset);
  return range;
}

/**
 * Flattened text offset of `element` inside an indexed root: the start of the
 * first text node that is not before the element in document order. Used to
 * derive `hintStart` for heading-scoped annotations.
 */
export function elementTextOffsetInIndex(index: TextIndex, element: Element): number | null {
  const { entries } = index;
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (element.compareDocumentPosition(entries[mid].node) & Node.DOCUMENT_POSITION_PRECEDING) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low < entries.length ? entries[low].start : null;
}

export function rangeOffsetsWithinRoot(root: HTMLElement, range: Range): { start: number; end: number } | null {
  if (!root.contains(range.commonAncestorContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const selected = range.toString().length;
  if (selected <= 0) return null;
  return { start, end: start + selected };
}

export function rangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
  if (end <= start) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remainingStart = start;
  let remainingEnd = end;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const length = node.data.length;
    if (!startNode && remainingStart <= length) {
      startNode = node;
      startOffset = remainingStart;
    } else if (!startNode) {
      remainingStart -= length;
    }
    if (!endNode) {
      if (remainingEnd <= length) {
        endNode = node;
        endOffset = remainingEnd;
        break;
      }
      remainingEnd -= length;
      if (startNode && node !== startNode) remainingStart = 0;
    }
    node = walker.nextNode() as Text | null;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

export function wrapRangeWithMark(
  range: Range,
  annotationId: string,
  color: AnnotationColor,
  markKind: AnnotationMarkKind = "highlight",
): HTMLElement[] {
  const marks: HTMLElement[] = [];
  const fragment = range.cloneContents();
  if (!fragment.textContent?.trim()) return marks;

  // Split to text-node sized ranges for safe wrapping.
  const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? (range.commonAncestorContainer as Element)
    : range.commonAncestorContainer.parentElement;
  if (!root) return marks;

  const textRanges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (!range.intersectsNode(node)) {
      node = walker.nextNode() as Text | null;
      continue;
    }
    const piece = document.createRange();
    piece.selectNodeContents(node);
    if (node === range.startContainer) piece.setStart(node, range.startOffset);
    if (node === range.endContainer) piece.setEnd(node, range.endOffset);
    if (piece.toString().length > 0) textRanges.push(piece);
    node = walker.nextNode() as Text | null;
  }

  for (const piece of textRanges) {
    const mark = document.createElement("mark");
    const styleClass =
      markKind === "underline" ? " annotation-mark--underline" : " annotation-mark--highlight";
    mark.className = `annotation-mark${styleClass} annotation-mark--${color}`;
    mark.dataset.annotationId = annotationId;
    mark.dataset.annotationKind = markKind;
    try {
      piece.surroundContents(mark);
      marks.push(mark);
    } catch {
      // Cross-boundary edge cases: skip this piece rather than corrupt DOM.
    }
  }
  return marks;
}

export function clearAnnotationMarks(root: ParentNode, annotationId?: string): void {
  const selector = annotationId
    ? `mark.annotation-mark[data-annotation-id="${CSS.escape(annotationId)}"]`
    : "mark.annotation-mark";
  const marks = Array.from((root as Element).querySelectorAll?.(selector) ?? []);
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

export interface TextQuoteMarkInput {
  id: string;
  color: AnnotationColor;
  markKind: AnnotationMarkKind;
  quote: string;
  prefix: string;
  suffix: string;
  /** Expected start offset in the root text, forwarded to findTextQuote. */
  hintStart?: number;
}

/**
 * Paints a batch of text-quote marks against `root` with a single tree walk.
 *
 * Every quote is first resolved to flattened offsets against one shared
 * index, then wrapped back-to-front: `wrapRangeWithMark` splits text nodes,
 * but a split only truncates the tail of the affected node, so index entries
 * at smaller offsets stay valid. Overlapping marks that still hit a stale
 * entry fall back to a fresh walk via `rangeFromOffsets`.
 *
 * Callers must clear previous marks *before* building `index` (unwrapping
 * normalizes text nodes) and must not reuse the index after this returns.
 * Returns the ids that could not be anchored.
 */
export function paintTextQuoteMarks(
  root: HTMLElement,
  marks: TextQuoteMarkInput[],
  index?: TextIndex,
): string[] {
  const broken: string[] = [];
  if (!marks.length) return broken;
  const textIndex = index ?? buildTextIndex(root);
  const resolved: Array<{ mark: TextQuoteMarkInput; start: number; end: number }> = [];
  for (const mark of marks) {
    const match = findTextQuote(
      textIndex.text,
      mark.quote,
      mark.prefix,
      mark.suffix,
      mark.hintStart === undefined ? undefined : { hintStart: mark.hintStart },
    );
    if (match) resolved.push({ mark, start: match.start, end: match.end });
    else broken.push(mark.id);
  }
  resolved.sort((a, b) => b.start - a.start || b.end - a.end);
  for (const { mark, start, end } of resolved) {
    const range = rangeFromTextIndex(textIndex, start, end) ?? rangeFromOffsets(root, start, end);
    if (range) wrapRangeWithMark(range, mark.id, mark.color, mark.markKind);
    else broken.push(mark.id);
  }
  return broken;
}

export function nearestHeadingId(node: Node | null, root: HTMLElement): string | null {
  let current: Node | null = node;
  while (current && current !== root) {
    if (current instanceof HTMLElement) {
      if (/^H[1-6]$/.test(current.tagName) && current.id) return current.id;
      const heading = current.closest?.("h1,h2,h3,h4,h5,h6");
      if (heading?.id) return heading.id;
    }
    current = current.parentNode;
  }
  const start = node instanceof Element ? node : node?.parentElement;
  if (!start || !root.contains(start)) return null;
  const headings = Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"));
  let nearest: string | null = null;
  for (const heading of headings) {
    if (!heading.id) continue;
    const position = heading.compareDocumentPosition(start);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING || heading.contains(start)) {
      nearest = heading.id;
    } else {
      break;
    }
  }
  return nearest;
}

export function isSelectionInsideForbidden(selection: Selection, root: HTMLElement): boolean {
  if (!selection.rangeCount) return true;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return true;
  const anchor = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (!anchor) return true;
  return Boolean(
    anchor.closest(
      "pre, code, .mermaid, .katex, .pdf-toolbar, .annotation-toolbar, .annotation-tools-popover, .annotation-note-editor, .markdown-code-copy, input, textarea",
    ),
  );
}

export function annotationListTitle(annotation: Annotation): string {
  if (annotation.title?.trim()) return annotation.title.trim();
  if (annotation.selectedText?.trim()) return annotation.selectedText.trim();
  if (annotation.kind === "bookmark") {
    const target = annotation.locator.kind === "bookmark" ? annotation.locator.target : null;
    if (target?.format === "pdf") return `第 ${target.page} 页书签`;
    if (target?.format === "epub") return target.headingId ?? target.chapterId;
    if (target?.format === "markdown") return target.headingId ?? "书签";
    return "书签";
  }
  if (annotation.kind === "underline") return "下划线";
  if (annotation.kind === "highlight") return "高亮";
  return "标注";
}

export function annotationKindLabel(kind: AnnotationKind): string {
  if (kind === "bookmark") return "书签";
  if (kind === "underline") return "下划线";
  return "高亮";
}

export function createMarkAnnotation(input: {
  relativePath: string;
  kind: AnnotationMarkKind;
  color: AnnotationColor;
  selectedText: string;
  locator: Exclude<AnnotationLocator, { kind: "bookmark" }>;
  note?: string | null;
  title?: string | null;
}): Annotation {
  const now = Date.now();
  return {
    id: createAnnotationId(),
    relativePath: input.relativePath,
    kind: input.kind,
    color: input.color,
    note: input.note ?? null,
    selectedText: clampSelectionText(input.selectedText),
    title: input.title ?? clampSelectionText(input.selectedText).slice(0, 80),
    locator: input.locator,
    createdAt: now,
    updatedAt: now,
  };
}

export function createHighlightAnnotation(input: {
  relativePath: string;
  color: AnnotationColor;
  selectedText: string;
  locator: Exclude<AnnotationLocator, { kind: "bookmark" }>;
  note?: string | null;
  title?: string | null;
}): Annotation {
  return createMarkAnnotation({ ...input, kind: "highlight" });
}

export function createBookmarkAnnotation(input: {
  relativePath: string;
  target: BookmarkTarget;
  title?: string | null;
  note?: string | null;
}): Annotation {
  const now = Date.now();
  return {
    id: createAnnotationId(),
    relativePath: input.relativePath,
    kind: "bookmark",
    color: null,
    note: input.note ?? null,
    selectedText: null,
    title: input.title ?? null,
    locator: { kind: "bookmark", target: input.target },
    createdAt: now,
    updatedAt: now,
  };
}

export type RectLike = Pick<DOMRect, "left" | "top" | "width" | "height">;

export function normalizePdfRects(
  clientRects: ArrayLike<RectLike>,
  pageRect: RectLike,
): AnnotationRect[] {
  const width = pageRect.width || 1;
  const height = pageRect.height || 1;
  const rects: AnnotationRect[] = [];
  for (let index = 0; index < clientRects.length; index += 1) {
    const rect = clientRects[index];
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    rects.push({
      x: (rect.left - pageRect.left) / width,
      y: (rect.top - pageRect.top) / height,
      w: rect.width / width,
      h: rect.height / height,
    });
  }
  return rects.slice(0, 64);
}

/**
 * Resolves the display rects for a PDF original-view mark annotation.
 *
 * Text-quote anchoring comes first: the stored quote is located in the live
 * text layer and measured with `getClientRects`, so annotations created
 * against a differently laid-out text layer (or an older, buggy one) self-heal
 * to the current glyph positions. The stored rects only serve as a fallback
 * while the text layer is not rendered yet or the quote no longer matches.
 */
export function resolvePdfHighlightRects(input: {
  textLayer: HTMLElement | null;
  pageRect: RectLike | null;
  locator: { quote: string; prefix: string; suffix: string; rects: AnnotationRect[] };
  rectsForRange?: (range: Range) => ArrayLike<RectLike>;
  /** Prebuilt text-layer index so per-page highlight loops walk the DOM once. */
  index?: TextIndex;
}): AnnotationRect[] {
  const { textLayer, pageRect, locator } = input;
  if (textLayer && pageRect) {
    const index = input.index ?? buildTextIndex(textLayer);
    const match = findTextQuote(index.text, locator.quote, locator.prefix, locator.suffix);
    if (match) {
      const range = rangeFromTextIndex(index, match.start, match.end);
      if (range) {
        const measure = input.rectsForRange ?? ((target: Range) => target.getClientRects());
        const rects = normalizePdfRects(measure(range), pageRect);
        if (rects.length) return rects;
      }
    }
  }
  return locator.rects;
}

export function resolveAnnotationAnchor(
  root: HTMLElement,
  locator: Extract<AnnotationLocator, { kind: "markdown" } | { kind: "pdf" } | { kind: "epub" }>,
): { start: number; end: number } | null {
  const fullText = collectElementText(root);
  return findTextQuote(fullText, locator.quote, locator.prefix, locator.suffix);
}
