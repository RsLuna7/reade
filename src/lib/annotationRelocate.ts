/**
 * Single-annotation re-anchoring (§5.6 "在文档中定位此文本").
 *
 * The loose pass runs the existing resolution chain with whitespace
 * normalization and fuzzy matching temporarily enabled, regardless of the
 * global fuzzy preference: the user explicitly asked for a best-effort
 * match. Nothing here writes storage — the caller previews the candidate
 * range and only rewrites the locator after an explicit confirmation
 * (Zotero "Don't discard" rule); cancelling keeps the original locator
 * byte-for-byte.
 */

import type { Annotation, AnnotationLocator } from "./backend";
import {
  buildTextIndex,
  clampSelectionText,
  deriveAnnotationSortIndex,
  rangeFromOffsets,
  rangeFromTextIndex,
  resolveTextQuote,
  type TextQuoteResolutionMethod,
} from "./annotations";
import { captureRangeLocator, type PendingSelection } from "./annotationCapture";

export type QuoteBearingLocator = Extract<
  AnnotationLocator,
  { kind: "markdown" } | { kind: "pdf" } | { kind: "epub" }
>;

/** Whether an annotation carries a text quote and therefore can be relocated. */
export function isRelocatableAnnotation(annotation: Annotation): boolean {
  const kind = annotation.locator.kind;
  return (
    (kind === "markdown" || kind === "pdf" || kind === "epub") &&
    Boolean(annotation.locator.quote)
  );
}

export interface RelocationMatch {
  root: HTMLElement;
  range: Range;
  method: TextQuoteResolutionMethod;
}

/**
 * Finds the closest occurrence of the annotation's quote across the given
 * search roots (first root that resolves wins; PDF callers order roots by
 * page proximity). Returns null when no root yields a match even with the
 * loose chain.
 */
export function findRelocationRange(
  roots: HTMLElement[],
  locator: QuoteBearingLocator,
): RelocationMatch | null {
  const hintStart = locator.kind === "markdown" ? locator.start : undefined;
  for (const root of roots) {
    const index = buildTextIndex(root);
    const match = resolveTextQuote(index.text, locator.quote, locator.prefix, locator.suffix, {
      hintStart,
      normalizeWhitespace: true,
      fuzzy: true,
    });
    if (!match) continue;
    const range =
      rangeFromTextIndex(index, match.start, match.end) ??
      rangeFromOffsets(root, match.start, match.end);
    if (range) return { root, range, method: match.method };
  }
  return null;
}

/**
 * Re-collects the full locator (quote/prefix/suffix/hints) for the confirmed
 * range. `readerRoot` is the same container selection capture works against,
 * so chapter/block/page ancestry resolves identically to a live selection.
 */
export function captureRelocatedSelection(input: {
  readerRoot: HTMLElement;
  kind: "markdown" | "pdf" | "epub";
  range: Range;
  pdfMode?: "original" | "reading";
}): PendingSelection | null {
  return captureRangeLocator({
    root: input.readerRoot,
    kind: input.kind,
    range: input.range,
    pdfMode: input.pdfMode,
  });
}

/**
 * Applies a confirmed relocation: locator rewritten with the freshly
 * captured set, sortIndex recomputed, selectedText refreshed to the new
 * quote. The title follows only when it was auto-derived from the old
 * selection (a user-edited title is user data and stays). Pure — the caller
 * persists via upsert.
 */
/**
 * Rewrites the legacy locator after the user confirms the preview. v6
 * `sourceRevision` lives on Excerpt/ReadingPlace and is refreshed by the
 * storage dual-write on confirm, not by this helper.
 */
export function applyRelocatedAnnotation(
  annotation: Annotation,
  captured: PendingSelection,
  now = Date.now(),
): Annotation {
  const selectedText = clampSelectionText(captured.text);
  const previousAutoTitle = annotation.selectedText
    ? clampSelectionText(annotation.selectedText).slice(0, 80)
    : null;
  const title =
    annotation.title && previousAutoTitle && annotation.title === previousAutoTitle
      ? selectedText.slice(0, 80)
      : annotation.title;
  return {
    ...annotation,
    locator: captured.locator,
    selectedText,
    title,
    sortIndex: deriveAnnotationSortIndex(captured.locator),
    updatedAt: now,
  };
}
