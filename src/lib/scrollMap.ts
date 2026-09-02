/**
 * Scroll-map tick model for the rich scrollbar
 * (docs/plan-rich-scrollbar.md §3.1): pure offset→ratio mapping with
 * dedup/cap on one side, DOM measurement collectors on the other. The
 * collectors take elements as arguments (the `tocCoverage` discipline) so
 * jsdom tests can stub `getBoundingClientRect`.
 *
 * Position sources (RS-D2/RS-D9): painted `[data-annotation-id]` marks
 * first; PDF annotations without a rendered mark fall back to the page
 * skeleton plus the stored normalized rects; bookmarks mirror the
 * `performAnnotationJump` chain (heading element → page offset → scroll
 * ratio). Library-wide Ctrl+K search hits still lack intra-doc offsets
 * (RS-D3); in-document Ctrl+F matches are measured separately via
 * {@link collectFindScrollPoints}.
 */

import type { Annotation, AnnotationColor, SearchResult } from "./backend";

export const SCROLL_MAP_MAX_MARKS = 200;
export const SCROLL_MAP_MERGE_EPSILON = 0.002;
export const SCROLL_MAP_LABEL_MAX_CHARS = 24;

export type ScrollMapMarkKind = "annotation" | "bookmark" | "search" | "tts";

/** One measured input point in document space (px within the scroller). */
export interface ScrollMapPoint {
  kind: ScrollMapMarkKind;
  color: AnnotationColor | null;
  offset: number;
  label: string;
  /** annotationId (annotation/bookmark) or resultId (search). */
  targetId: string | null;
}

/** One rendered tick: `ratio` ∈ [0,1] relative to the scroll height. */
export interface ScrollMapMark {
  kind: ScrollMapMarkKind;
  color: AnnotationColor | null;
  ratio: number;
  label: string;
  targetId: string | null;
}

/** Tooltip excerpt: whitespace collapsed, capped at 24 code points. */
export function truncateScrollMapLabel(
  text: string,
  maxChars = SCROLL_MAP_LABEL_MAX_CHARS,
): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : collapsed;
}

/**
 * Offsets → sorted, merged, capped marks. Same-kind/same-color ticks
 * within ±{@link SCROLL_MAP_MERGE_EPSILON} collapse into the first one;
 * beyond {@link SCROLL_MAP_MAX_MARKS} the list is thinned uniformly
 * (RS-D6) so the document-wide distribution survives.
 */
export function buildScrollMapMarks(
  points: readonly ScrollMapPoint[],
  scrollHeight: number,
): ScrollMapMark[] {
  if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) return [];
  const marks: ScrollMapMark[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.offset)) continue;
    marks.push({
      kind: point.kind,
      color: point.color,
      ratio: Math.min(1, Math.max(0, point.offset / scrollHeight)),
      label: point.label,
      targetId: point.targetId,
    });
  }
  marks.sort((a, b) => a.ratio - b.ratio);

  const merged: ScrollMapMark[] = [];
  for (const mark of marks) {
    const kept = merged.some(
      (existing) =>
        existing.kind === mark.kind &&
        existing.color === mark.color &&
        Math.abs(existing.ratio - mark.ratio) <= SCROLL_MAP_MERGE_EPSILON,
    );
    if (!kept) merged.push(mark);
  }

  if (merged.length <= SCROLL_MAP_MAX_MARKS) return merged;
  const thinned: ScrollMapMark[] = [];
  for (let slot = 0; slot < SCROLL_MAP_MAX_MARKS; slot += 1) {
    thinned.push(merged[Math.floor((slot * merged.length) / SCROLL_MAP_MAX_MARKS)]);
  }
  return thinned;
}

// ---------------------------------------------------------------------------
// DOM measurement collectors
// ---------------------------------------------------------------------------

/** Document-space offset of a client rect within the scroll container. */
function offsetInScroller(scroller: HTMLElement, top: number): number {
  return scroller.scrollTop + top - scroller.getBoundingClientRect().top;
}

function safeQuery(root: HTMLElement, selector: string): HTMLElement | null {
  try {
    return root.querySelector<HTMLElement>(selector);
  } catch {
    return null;
  }
}

const KIND_WORDS: Record<Exclude<ScrollMapMarkKind, "tts">, string> = {
  annotation: "标注",
  bookmark: "书签",
  search: "命中",
};

function pointLabel(kind: Exclude<ScrollMapMarkKind, "tts">, excerpt: string): string {
  const text = truncateScrollMapLabel(excerpt);
  return text ? `${KIND_WORDS[kind]} · ${text}` : KIND_WORDS[kind];
}

function pdfPageElement(article: HTMLElement, page: number): HTMLElement | null {
  return Number.isFinite(page) ? safeQuery(article, `#pdf-page-${page}`) : null;
}

/**
 * Highlight/underline and bookmark positions (RS-D2/RS-D9). One DOM query
 * for all painted marks; per-annotation fallbacks mirror the jump chain.
 */
export function collectAnnotationScrollPoints(
  scroller: HTMLElement,
  article: HTMLElement,
  annotations: readonly Annotation[],
): ScrollMapPoint[] {
  const markById = new Map<string, HTMLElement>();
  for (const element of Array.from(
    article.querySelectorAll<HTMLElement>("[data-annotation-id]"),
  )) {
    const id = element.dataset.annotationId;
    if (id && !markById.has(id)) markById.set(id, element);
  }
  const scrollHeight = scroller.scrollHeight;
  const points: ScrollMapPoint[] = [];

  for (const annotation of annotations) {
    if (annotation.kind === "bookmark") {
      if (annotation.locator.kind !== "bookmark") continue;
      const target = annotation.locator.target;
      const label = pointLabel("bookmark", annotation.title ?? "");
      if (target.format === "pdf") {
        const page = pdfPageElement(article, target.page);
        if (!page) continue;
        const rect = page.getBoundingClientRect();
        points.push({
          kind: "bookmark",
          color: null,
          offset: offsetInScroller(scroller, rect.top) + rect.height * target.offsetRatio,
          label,
          targetId: annotation.id,
        });
        continue;
      }
      const heading = target.headingId
        ? safeQuery(article, `#${CSS.escape(target.headingId)}`)
        : null;
      points.push({
        kind: "bookmark",
        color: null,
        offset: heading
          ? offsetInScroller(scroller, heading.getBoundingClientRect().top)
          : target.scrollRatio * scrollHeight,
        label,
        targetId: annotation.id,
      });
      continue;
    }

    const excerpt = annotation.selectedText ?? annotation.note ?? "";
    const mark = markById.get(annotation.id);
    if (mark) {
      points.push({
        kind: "annotation",
        color: annotation.color,
        offset: offsetInScroller(scroller, mark.getBoundingClientRect().top),
        label: pointLabel("annotation", excerpt),
        targetId: annotation.id,
      });
      continue;
    }
    if (annotation.locator.kind === "pdf") {
      const page = pdfPageElement(article, annotation.locator.page);
      if (!page) continue;
      const rect = page.getBoundingClientRect();
      const withinPage = annotation.locator.rects[0]?.y ?? 0;
      points.push({
        kind: "annotation",
        color: annotation.color,
        offset: offsetInScroller(scroller, rect.top) + rect.height * withinPage,
        label: pointLabel("annotation", excerpt),
        targetId: annotation.id,
      });
    }
    // Markdown/EPUB annotations without a painted mark are unanchored
    // (失联态) — no honest position exists, so no tick (RS-D3 spirit).
  }
  return points;
}

/**
 * Current-session search hits for the open document. Only PDF pages and
 * EPUB chapters carry reliable positions; markdown hits stay absent
 * (RS-D3).
 */
export function collectSearchScrollPoints(
  scroller: HTMLElement,
  article: HTMLElement,
  results: readonly SearchResult[],
): ScrollMapPoint[] {
  const points: ScrollMapPoint[] = [];
  for (const result of results) {
    const locator = result.locator;
    if (!locator) continue;
    const element =
      locator.kind === "pdfPage"
        ? pdfPageElement(article, locator.page)
        : safeQuery(article, `.epub-chapter[data-chapter-id="${CSS.escape(locator.chapterId)}"]`);
    if (!element) continue;
    points.push({
      kind: "search",
      color: null,
      offset: offsetInScroller(scroller, element.getBoundingClientRect().top),
      label: pointLabel("search", result.snippet),
      targetId: result.resultId,
    });
  }
  return points;
}

export interface FindScrollPointInput {
  targetId: string;
  label: string;
  range: Range | null;
}

/** In-document find hits measured from resolved DOM ranges (Ctrl+F). */
export function collectFindScrollPoints(
  scroller: HTMLElement,
  entries: readonly FindScrollPointInput[],
): ScrollMapPoint[] {
  const points: ScrollMapPoint[] = [];
  for (const entry of entries) {
    if (!entry.range) continue;
    let top: number | null = null;
    if (typeof entry.range.getBoundingClientRect === "function") {
      const rect = entry.range.getBoundingClientRect();
      if (Number.isFinite(rect.top)) top = rect.top;
    }
    if (top === null) {
      const node = entry.range.startContainer;
      const element =
        node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
      if (element instanceof HTMLElement) {
        const rect = element.getBoundingClientRect();
        if (Number.isFinite(rect.top)) top = rect.top;
      }
    }
    if (top === null) continue;
    points.push({
      kind: "search",
      color: null,
      offset: offsetInScroller(scroller, top),
      label: pointLabel("search", entry.label),
      targetId: entry.targetId,
    });
  }
  return points;
}

/** TTS 当前句刻度的 ratio(单枚,随 sentenceIndex 更新)。 */
export function ttsRatioFromRect(
  scroller: HTMLElement,
  rect: { top: number } | null,
): number | null {
  if (!rect) return null;
  const scrollHeight = scroller.scrollHeight;
  if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) return null;
  return Math.min(1, Math.max(0, offsetInScroller(scroller, rect.top) / scrollHeight));
}
