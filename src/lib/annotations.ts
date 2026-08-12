import approxSearch from "approx-string-match";
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

/** How a resolved anchor was found; carried for future UI badges. */
export type TextQuoteResolutionMethod = "hint" | "exact" | "normalized" | "fuzzy";

export interface ResolvedTextQuote extends TextQuoteMatch {
  method: TextQuoteResolutionMethod;
}

export interface ResolveTextQuoteOptions extends FindTextQuoteOptions {
  /**
   * Retry with all whitespace stripped when the exact match fails (PDF/EPUB
   * text layers differ mostly in whitespace); matched offsets are mapped back
   * to the original text.
   */
  normalizeWhitespace?: boolean;
  /**
   * Last-resort approximate matching (Hypothesis parameters:
   * `maxErrors = min(256, quote.length / 2)`, candidates ranked by
   * quote:prefix:suffix:position = 50:20:20:2). Off by default; enabling it
   * is an explicit caller decision because a fuzzy hit may land on the wrong
   * passage.
   */
  fuzzy?: boolean;
}

/**
 * Resolution chain for a serialized text quote (research report §5.4):
 * 1. position hint: jump to `hintStart` and verify the quote byte-for-byte;
 * 2. exact quote search (current behaviour, hint disambiguates repeats);
 * 3. whitespace-normalized retry (opt-in, for PDF/EPUB);
 * 4. fuzzy match (opt-in, default off);
 * 5. null → broken.
 * The returned `method` records which step matched.
 */
export function resolveTextQuote(
  fullText: string,
  quote: string,
  prefix: string,
  suffix: string,
  options?: ResolveTextQuoteOptions,
): ResolvedTextQuote | null {
  if (!quote) return null;
  const hintStart = options?.hintStart;
  const hasHint = typeof hintStart === "number" && Number.isFinite(hintStart);
  if (hasHint && hintStart >= 0 && fullText.startsWith(quote, hintStart)) {
    return { start: hintStart, end: hintStart + quote.length, method: "hint" };
  }
  const exact = findTextQuote(fullText, quote, prefix, suffix, hasHint ? { hintStart } : undefined);
  if (exact) return { ...exact, method: "exact" };
  if (options?.normalizeWhitespace) {
    const normalized = findWhitespaceNormalizedQuote(fullText, quote, prefix, suffix, hasHint ? hintStart : undefined);
    if (normalized) return { ...normalized, method: "normalized" };
  }
  if (options?.fuzzy) {
    const fuzzy = findFuzzyQuote(fullText, quote, prefix, suffix, hasHint ? hintStart : undefined);
    if (fuzzy) return { ...fuzzy, method: "fuzzy" };
  }
  return null;
}

interface StrippedText {
  text: string;
  /** offsets[i] = index of stripped character i in the original string. */
  offsets: number[];
}

function stripWhitespace(value: string): StrippedText {
  let text = "";
  const offsets: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (/\s/.test(character)) continue;
    text += character;
    offsets.push(index);
  }
  return { text, offsets };
}

/** Number of non-whitespace characters before `offset` in the original text. */
function strippedOffsetFor(stripped: StrippedText, offset: number): number {
  let low = 0;
  let high = stripped.offsets.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (stripped.offsets[mid] < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

function findWhitespaceNormalizedQuote(
  fullText: string,
  quote: string,
  prefix: string,
  suffix: string,
  hintStart?: number,
): TextQuoteMatch | null {
  const haystack = stripWhitespace(fullText);
  const needle = stripWhitespace(quote).text;
  if (!needle || !haystack.text) return null;
  const match = findTextQuote(
    haystack.text,
    needle,
    stripWhitespace(prefix).text,
    stripWhitespace(suffix).text,
    hintStart === undefined ? undefined : { hintStart: strippedOffsetFor(haystack, hintStart) },
  );
  if (!match) return null;
  const start = haystack.offsets[match.start];
  const end = haystack.offsets[match.end - 1] + 1;
  return { start, end };
}

/** Similarity of `actual` context against the stored `expected` context, 0..1. */
function contextScore(actual: string, expected: string): number {
  if (!expected) return 1;
  if (!actual) return 0;
  if (actual === expected) return 1;
  const maxErrors = Math.max(1, Math.ceil(expected.length / 2));
  const matches = approxSearch(actual, expected, maxErrors);
  if (!matches.length) return 0;
  const errors = Math.min(...matches.map((match) => match.errors));
  return 1 - errors / (maxErrors + 1);
}

function findFuzzyQuote(
  fullText: string,
  quote: string,
  prefix: string,
  suffix: string,
  hintStart?: number,
): TextQuoteMatch | null {
  const maxErrors = Math.min(256, Math.floor(quote.length / 2));
  if (maxErrors <= 0 || !fullText) return null;
  const candidates = approxSearch(fullText, quote, maxErrors);
  let best: { start: number; end: number; score: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.end <= candidate.start) continue;
    const quoteScore = 1 - candidate.errors / (maxErrors + 1);
    const prefixScore = contextScore(
      fullText.slice(Math.max(0, candidate.start - prefix.length), candidate.start),
      prefix,
    );
    const suffixScore = contextScore(
      fullText.slice(candidate.end, candidate.end + suffix.length),
      suffix,
    );
    const positionScore =
      hintStart === undefined
        ? 0
        : 1 - Math.min(1, Math.abs(candidate.start - hintStart) / Math.max(1, fullText.length));
    // Hypothesis weights; the score only ranks candidates, there is no floor.
    const score = 50 * quoteScore + 20 * prefixScore + 20 * suffixScore + 2 * positionScore;
    if (!best || score > best.score || (score === best.score && candidate.start < best.start)) {
      best = { start: candidate.start, end: candidate.end, score };
    }
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

export interface PaintTextQuoteOptions {
  /** Retry failed quotes with whitespace stripped (PDF/EPUB text layers). */
  normalizeWhitespace?: boolean;
  /** Enable the fuzzy last-resort step of the resolution chain (default off). */
  fuzzy?: boolean;
}

export interface PaintTextQuoteResult {
  /** Ids that could not be anchored. */
  broken: string[];
  /**
   * Ids that anchored through a non-exact step (§5.6 weak hint), with the
   * resolution method that matched. Recomputed on every paint, never stored.
   */
  approximate: Map<string, TextQuoteResolutionMethod>;
}

/** Hover/badge copy for non-exact anchor hits (list dot + in-document mark). */
export const APPROXIMATE_ANCHOR_LABEL = "非精确定位";

function markMarkAsApproximate(elements: HTMLElement[]): void {
  for (const element of elements) {
    element.classList.add("annotation-mark--approx");
    element.title = APPROXIMATE_ANCHOR_LABEL;
  }
  // The trailing segment carries the visible dot so a mark split across
  // several text nodes shows a single badge.
  elements[elements.length - 1]?.classList.add("annotation-mark--approx-tail");
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
 * Anchoring runs the `resolveTextQuote` chain: a mark's `hintStart` is first
 * tried as a verified direct hit, then disambiguates the exact search, then
 * the optional normalized/fuzzy retries apply.
 *
 * Callers must clear previous marks *before* building `index` (unwrapping
 * normalizes text nodes) and must not reuse the index after this returns.
 * Returns the ids that could not be anchored plus the non-exact hits.
 */
export function paintTextQuoteMarks(
  root: HTMLElement,
  marks: TextQuoteMarkInput[],
  index?: TextIndex,
  options?: PaintTextQuoteOptions,
): PaintTextQuoteResult {
  const broken: string[] = [];
  const approximate = new Map<string, TextQuoteResolutionMethod>();
  if (!marks.length) return { broken, approximate };
  const textIndex = index ?? buildTextIndex(root);
  const resolved: Array<{
    mark: TextQuoteMarkInput;
    start: number;
    end: number;
    method: TextQuoteResolutionMethod;
  }> = [];
  for (const mark of marks) {
    const match = resolveTextQuote(textIndex.text, mark.quote, mark.prefix, mark.suffix, {
      hintStart: mark.hintStart,
      normalizeWhitespace: options?.normalizeWhitespace,
      fuzzy: options?.fuzzy,
    });
    if (match) resolved.push({ mark, start: match.start, end: match.end, method: match.method });
    else broken.push(mark.id);
  }
  resolved.sort((a, b) => b.start - a.start || b.end - a.end);
  for (const { mark, start, end, method } of resolved) {
    const range = rangeFromTextIndex(textIndex, start, end) ?? rangeFromOffsets(root, start, end);
    if (!range) {
      broken.push(mark.id);
      continue;
    }
    const elements = wrapRangeWithMark(range, mark.id, mark.color, mark.markKind);
    if (method === "normalized" || method === "fuzzy") {
      approximate.set(mark.id, method);
      markMarkAsApproximate(elements);
    }
  }
  return { broken, approximate };
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

/** Sort key for annotations whose locator cannot be interpreted; sorts last. */
export const BROKEN_SORT_INDEX = "Z|99999|00000000";
const SORT_INDEX_PATTERN = /^[EMPZ]\|\d{5}\|\d{8}$/;
const MAX_SORT_PAGE_SLOT = 99_999;
const MAX_SORT_OFFSET_SLOT = 99_999_999;

export function isValidSortIndex(value: string): boolean {
  return SORT_INDEX_PATTERN.test(value);
}

function sortSlot(value: number, width: number, max: number): string {
  const rounded = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  return String(Math.min(rounded, max)).padStart(width, "0");
}

function sortSlots(prefix: "M" | "P" | "E", high: number, low: number): string {
  return `${prefix}|${sortSlot(high, 5, MAX_SORT_PAGE_SLOT)}|${sortSlot(low, 8, MAX_SORT_OFFSET_SLOT)}`;
}

export interface SortIndexContext {
  /**
   * Spine-order index of an EPUB chapter id. Without it the chapter slot is
   * encoded as 0 (chapter ids are content paths and carry no reliable order).
   */
  epubChapterIndex?: (chapterId: string) => number | null | undefined;
}

/**
 * Precomputed position sort key (report §5.2): fixed-width numeric slots so
 * plain string order equals document order. Must stay in sync with
 * `derive_sort_index` in `src-tauri/src/user_store.rs`:
 * - markdown: `M|00000|<start hint, 0 when absent>`
 * - pdf: `P|<page>|<first rect y × 10⁴>`; bookmarks use ratio × 10⁸
 * - epub: `E|<chapter slot>|<chapter-level start hint, else
 *   blockIndex × 10⁴ + min(startOffset, 9999)>`
 * Unknown shapes fall back to `BROKEN_SORT_INDEX`.
 */
export function deriveAnnotationSortIndex(
  locator: AnnotationLocator,
  context?: SortIndexContext,
): string {
  if (!locator || typeof locator !== "object") return BROKEN_SORT_INDEX;
  if (locator.kind === "markdown") {
    return sortSlots("M", 0, locator.start ?? 0);
  }
  if (locator.kind === "pdf") {
    const firstRect = locator.rects?.[0];
    const offset = firstRect ? firstRect.y * 10_000 : 0;
    return sortSlots("P", locator.page, offset);
  }
  if (locator.kind === "epub") {
    const chapter = context?.epubChapterIndex?.(locator.chapterId) ?? 0;
    const offset =
      locator.start ?? locator.blockIndex * 10_000 + Math.min(locator.startOffset, 9_999);
    return sortSlots("E", chapter, offset);
  }
  if (locator.kind === "bookmark") {
    const target = locator.target;
    if (target.format === "pdf") {
      return sortSlots("P", target.page, target.offsetRatio * 100_000_000);
    }
    if (target.format === "epub") {
      const chapter = context?.epubChapterIndex?.(target.chapterId) ?? 0;
      return sortSlots("E", chapter, target.scrollRatio * 100_000_000);
    }
    return sortSlots("M", 0, target.scrollRatio * 100_000_000);
  }
  return BROKEN_SORT_INDEX;
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
    sortIndex: deriveAnnotationSortIndex(input.locator),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
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
  const locator: AnnotationLocator = { kind: "bookmark", target: input.target };
  return {
    id: createAnnotationId(),
    relativePath: input.relativePath,
    kind: "bookmark",
    color: null,
    note: input.note ?? null,
    selectedText: null,
    title: input.title ?? null,
    locator,
    sortIndex: deriveAnnotationSortIndex(locator),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
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

export interface ResolvedPdfHighlight {
  rects: AnnotationRect[];
  /**
   * How the quote anchored in the live text layer; null when the stored
   * rects served as the fallback (text layer missing or quote unmatched).
   */
  method: TextQuoteResolutionMethod | null;
}

/**
 * Resolves the display rects for a PDF original-view mark annotation.
 *
 * Text-quote anchoring comes first: the stored quote is located in the live
 * text layer and measured with `getClientRects`, so annotations created
 * against a differently laid-out text layer (or an older, buggy one) self-heal
 * to the current glyph positions. A whitespace-normalized retry absorbs the
 * layout differences between pdf.js text-layer versions. The stored rects
 * only serve as a fallback while the text layer is not rendered yet or the
 * quote no longer matches.
 */
export function resolvePdfHighlightRects(input: {
  textLayer: HTMLElement | null;
  pageRect: RectLike | null;
  locator: { quote: string; prefix: string; suffix: string; rects: AnnotationRect[] };
  rectsForRange?: (range: Range) => ArrayLike<RectLike>;
  /** Prebuilt text-layer index so per-page highlight loops walk the DOM once. */
  index?: TextIndex;
  /** Enable the fuzzy last-resort step of the resolution chain (default off). */
  fuzzy?: boolean;
}): ResolvedPdfHighlight {
  const { textLayer, pageRect, locator } = input;
  if (textLayer && pageRect) {
    const index = input.index ?? buildTextIndex(textLayer);
    const match = resolveTextQuote(index.text, locator.quote, locator.prefix, locator.suffix, {
      normalizeWhitespace: true,
      fuzzy: input.fuzzy,
    });
    if (match) {
      const range = rangeFromTextIndex(index, match.start, match.end);
      if (range) {
        const measure = input.rectsForRange ?? ((target: Range) => target.getClientRects());
        const rects = normalizePdfRects(measure(range), pageRect);
        if (rects.length) return { rects, method: match.method };
      }
    }
  }
  return { rects: locator.rects, method: null };
}

export function resolveAnnotationAnchor(
  root: HTMLElement,
  locator: Extract<AnnotationLocator, { kind: "markdown" } | { kind: "pdf" } | { kind: "epub" }>,
  options?: { fuzzy?: boolean },
): ResolvedTextQuote | null {
  const fullText = collectElementText(root);
  const hintStart =
    locator.kind === "markdown"
      ? locator.start
      : locator.kind === "epub"
        ? (locator.start ?? locator.startOffset)
        : undefined;
  return resolveTextQuote(fullText, locator.quote, locator.prefix, locator.suffix, {
    hintStart,
    normalizeWhitespace: locator.kind !== "markdown",
    fuzzy: options?.fuzzy,
  });
}
