import type { Annotation, AnnotationColor, AnnotationLocator } from "./backend";
import {
  createAnnotationId,
  createBookmarkAnnotation,
  createMarkAnnotation,
  deriveAnnotationSortIndex,
  isSelectionInsideForbidden,
  nearestHeadingId,
  normalizePdfRects,
  normalizeSelectionText,
  rangeOffsetsWithinRoot,
  serializeTextQuote,
  collectElementText,
  type AnnotationMarkKind,
} from "./annotations";
import {
  legacyLocatorToSourceAnchor,
  type ExcerptAppearance,
  type ExcerptDraft,
} from "./annotationModel";
import { validateExcerptDraft } from "./annotationValidation";

export interface PendingSelection {
  text: string;
  locator: Exclude<AnnotationLocator, { kind: "bookmark" }>;
  rect: { left: number; top: number; width: number; height: number };
  /**
   * Selection that crosses PDF page boundaries: `text`/`locator` describe the
   * first page, `continuation` holds one entry per following page and
   * `fullText` the whole selection for copy / lookup actions.
   */
  continuation?: PendingSelection[];
  fullText?: string;
}

/** Whole-selection text; a cross-page PDF selection's `text` is only its first page. */
export function pendingSelectionText(pending: PendingSelection): string {
  return pending.fullText ?? pending.text;
}

export function captureReaderSelection(input: {
  root: HTMLElement;
  kind: "markdown" | "pdf" | "epub";
  pdfMode?: "original" | "reading";
}): PendingSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (isSelectionInsideForbidden(selection, input.root)) return null;
  const range = selection.getRangeAt(0);
  return captureRangeLocator({ ...input, range });
}

/** A selection spanning more pages than this keeps only its first pages. */
const MAX_PDF_SELECTION_PAGES = 10;

/**
 * PDF locators hold one page, so a selection dragged across pages is split
 * per page. The first page with text becomes the primary selection and the
 * remaining pages ride along in `continuation`, each with its own locator.
 */
function capturePdfRangeLocator(input: {
  root: HTMLElement;
  range: Range;
  pdfMode?: "original" | "reading";
}): PendingSelection | null {
  const { range } = input;
  const view = input.pdfMode === "reading" ? "reading" : "original";
  const { startContainer } = range;
  const startPage = startContainer instanceof Element
    ? startContainer.closest<HTMLElement>("[data-page-number]")
    : startContainer.parentElement?.closest<HTMLElement>("[data-page-number]");
  if (!startPage) return null;
  const pages = Array.from(input.root.querySelectorAll<HTMLElement>("[data-page-number]")).filter(
    (page) => page === startPage || range.intersectsNode(page),
  );
  const segments: PendingSelection[] = [];
  for (const page of pages.slice(0, MAX_PDF_SELECTION_PAGES)) {
    const segment = capturePdfPageSegment(page, range, view);
    if (segment) segments.push(segment);
  }
  const [primary, ...continuation] = segments;
  if (!primary) return null;
  if (!continuation.length) return primary;
  return {
    ...primary,
    fullText: normalizeSelectionText(range.toString()),
    continuation,
  };
}

/** The part of `source` that lies on `page`, captured as a single-page selection. */
function capturePdfPageSegment(
  page: HTMLElement,
  source: Range,
  view: "original" | "reading",
): PendingSelection | null {
  const pageNumber = Number(page.dataset.pageNumber);
  if (!Number.isFinite(pageNumber)) return null;
  const textRoot =
    (view === "reading"
      ? page.querySelector<HTMLElement>(".markdown-body")
      : page.querySelector<HTMLElement>(".pdf-text-layer, .textLayer")) ?? page;
  let range = source;
  const startsHere = textRoot.contains(source.startContainer);
  const endsHere = textRoot.contains(source.endContainer);
  if (!startsHere || !endsHere) {
    range = source.cloneRange();
    if (!startsHere) range.setStart(textRoot, 0);
    if (!endsHere) range.setEnd(textRoot, textRoot.childNodes.length);
  }
  const text = normalizeSelectionText(range.toString());
  if (!text) return null;
  const offsets = rangeOffsetsWithinRoot(textRoot, range);
  if (!offsets) return null;
  const quote = serializeTextQuote(collectElementText(textRoot), offsets.start, offsets.end);
  if (!quote) return null;
  const pageRect = page.getBoundingClientRect();
  const rects = view === "original" ? normalizePdfRects(range.getClientRects(), pageRect) : [];
  const rect = range.getBoundingClientRect();
  // Page size in PDF points, published by PdfReader on the page element;
  // snapshotting it keeps the normalized rects convertible offline.
  const pageWidth = Number(page.dataset.pageWidth);
  const pageHeight = Number(page.dataset.pageHeight);
  const pageSize =
    Number.isFinite(pageWidth) && pageWidth > 0 && Number.isFinite(pageHeight) && pageHeight > 0
      ? { pageWidth, pageHeight }
      : null;
  return {
    text,
    locator: {
      kind: "pdf",
      page: pageNumber,
      view,
      quote: quote.quote,
      prefix: quote.prefix,
      suffix: quote.suffix,
      rects,
      ...(pageSize ?? {}),
    },
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  };
}

/**
 * Serializes a DOM Range into the full locator set (quote/prefix/suffix plus
 * per-format hints). Shared by live selection capture and the §5.6 relocate
 * flow, which re-collects a locator from a programmatically resolved range.
 */
export function captureRangeLocator(input: {
  root: HTMLElement;
  kind: "markdown" | "pdf" | "epub";
  range: Range;
  pdfMode?: "original" | "reading";
}): PendingSelection | null {
  if (input.kind === "pdf") return capturePdfRangeLocator(input);
  const { range } = input;
  const text = normalizeSelectionText(range.toString());
  if (!text) return null;

  if (input.kind === "markdown") {
    const markdownRoot =
      input.root.querySelector<HTMLElement>(".markdown-body") ?? input.root;
    const offsets = rangeOffsetsWithinRoot(markdownRoot, range);
    if (!offsets) return null;
    const quote = serializeTextQuote(collectElementText(markdownRoot), offsets.start, offsets.end);
    if (!quote) return null;
    const rect = range.getBoundingClientRect();
    return {
      text,
      locator: {
        kind: "markdown",
        quote: quote.quote,
        prefix: quote.prefix,
        suffix: quote.suffix,
        headingId: nearestHeadingId(range.startContainer, markdownRoot),
        // Persisted position hint: the anchoring chain jumps here first and
        // verifies against the quote.
        start: offsets.start,
        end: offsets.end,
      },
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  }

  const chapter = range.startContainer instanceof Element
    ? range.startContainer.closest<HTMLElement>("[data-chapter-id]")
    : range.startContainer.parentElement?.closest<HTMLElement>("[data-chapter-id]");
  if (!chapter?.dataset.chapterId) return null;
  const block = range.startContainer instanceof Element
    ? range.startContainer.closest<HTMLElement>("[data-block-index]")
    : range.startContainer.parentElement?.closest<HTMLElement>("[data-block-index]");
  const target = block ?? chapter;
  const offsets = rangeOffsetsWithinRoot(target, range);
  if (!offsets) return null;
  const quote = serializeTextQuote(collectElementText(target), offsets.start, offsets.end);
  if (!quote) return null;
  // Chapter-level offsets complement the block-scoped startOffset/endOffset:
  // they stay meaningful when block indices shift and feed the chapter-order
  // sort key.
  const chapterOffsets = target === chapter ? offsets : rangeOffsetsWithinRoot(chapter, range);
  const rect = range.getBoundingClientRect();
  return {
    text,
    locator: {
      kind: "epub",
      chapterId: chapter.dataset.chapterId,
      blockIndex: Number(block?.dataset.blockIndex ?? 0),
      startOffset: offsets.start,
      endOffset: offsets.end,
      quote: quote.quote,
      prefix: quote.prefix,
      suffix: quote.suffix,
      ...(chapterOffsets ? { start: chapterOffsets.start, end: chapterOffsets.end } : {}),
    },
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  };
}

export function buildExcerptDraftFromPending(
  relativePath: string,
  pending: PendingSelection,
  appearance: ExcerptAppearance,
): ExcerptDraft {
  return validateExcerptDraft({
    id: createAnnotationId(),
    relativePath,
    sourceText: pending.text.trim() || pending.locator.quote,
    anchor: legacyLocatorToSourceAnchor(pending.locator),
    appearance: { ...appearance },
    sortIndex: deriveAnnotationSortIndex(pending.locator),
  });
}

/** Drafts for the pages after the first of a cross-page PDF selection. */
export function buildContinuationDrafts(
  relativePath: string,
  pending: PendingSelection,
  appearance: ExcerptAppearance,
): ExcerptDraft[] {
  return (pending.continuation ?? []).map((segment) =>
    buildExcerptDraftFromPending(relativePath, segment, appearance),
  );
}

export function buildMarkFromPending(
  relativePath: string,
  pending: PendingSelection,
  color: AnnotationColor,
  kind: AnnotationMarkKind = "highlight",
  note?: string | null,
): Annotation {
  return createMarkAnnotation({
    relativePath,
    kind,
    color,
    selectedText: pending.text,
    locator: pending.locator,
    note,
  });
}

/** @deprecated Prefer buildMarkFromPending */
export function buildHighlightFromPending(
  relativePath: string,
  pending: PendingSelection,
  color: AnnotationColor,
  note?: string | null,
): Annotation {
  return buildMarkFromPending(relativePath, pending, color, "highlight", note);
}

export function buildBookmarkForContext(input: {
  relativePath: string;
  kind: "markdown" | "pdf" | "epub";
  activeHeading: string | null;
  scrollRatio: number;
  pdfPosition?: { page: number; offsetRatio: number } | null;
  epubChapterId?: string | null;
}): Annotation {
  if (input.kind === "pdf" && input.pdfPosition) {
    return createBookmarkAnnotation({
      relativePath: input.relativePath,
      target: {
        format: "pdf",
        page: input.pdfPosition.page,
        offsetRatio: input.pdfPosition.offsetRatio,
      },
      title: `第 ${input.pdfPosition.page} 页`,
    });
  }
  if (input.kind === "epub") {
    return createBookmarkAnnotation({
      relativePath: input.relativePath,
      target: {
        format: "epub",
        chapterId: input.epubChapterId ?? "unknown",
        headingId: input.activeHeading,
        scrollRatio: input.scrollRatio,
      },
      title: input.activeHeading ?? "书签",
    });
  }
  return createBookmarkAnnotation({
    relativePath: input.relativePath,
    target: {
      format: "markdown",
      headingId: input.activeHeading,
      scrollRatio: input.scrollRatio,
    },
    title: input.activeHeading ?? "书签",
  });
}
