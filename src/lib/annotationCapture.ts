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

  if (input.kind === "pdf") {
    const page = range.startContainer instanceof Element
      ? range.startContainer.closest<HTMLElement>("[data-page-number]")
      : range.startContainer.parentElement?.closest<HTMLElement>("[data-page-number]");
    if (!page) return null;
    const pageNumber = Number(page.dataset.pageNumber);
    if (!Number.isFinite(pageNumber)) return null;
    const view = input.pdfMode === "reading" ? "reading" : "original";
    const textRoot =
      (view === "reading"
        ? page.querySelector<HTMLElement>(".markdown-body")
        : page.querySelector<HTMLElement>(".pdf-text-layer, .textLayer")) ?? page;
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
