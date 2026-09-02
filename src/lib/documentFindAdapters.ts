/**
 * Format-specific find adapters: flat-text collection, Range resolution,
 * and scroll-into-view for Markdown, EPUB, and PDF (reading + original).
 */

import type { PdfPageContent } from "./backend";
import {
  buildTextIndex,
  rangeFromTextIndex,
  type TextIndex,
} from "./annotations";
import {
  findAllMatches,
  findMatchesInPdfPages,
  type DocumentFindMatch,
  type FindAllMatchesResult,
} from "./documentFind";
import type { ReaderMotionLevel } from "./motion";
import { scrollElementWithinContainer, scrollRangeIntoContainer } from "./scroll";

export type DocumentFindFormat =
  | "markdown"
  | "epub"
  | "pdf-reading"
  | "pdf-original";

export function resolveDocumentFindFormat(
  contentKind: "markdown" | "pdf" | "epub" | null | undefined,
  pdfMode: "original" | "reading" | null | undefined,
): DocumentFindFormat | null {
  if (!contentKind) return null;
  if (contentKind === "markdown") return "markdown";
  if (contentKind === "epub") return "epub";
  if (contentKind === "pdf") {
    return pdfMode === "reading" ? "pdf-reading" : "pdf-original";
  }
  return null;
}

function findableRoot(article: HTMLElement, format: DocumentFindFormat): HTMLElement {
  if (format === "markdown") {
    return article.querySelector<HTMLElement>(".markdown-body") ?? article;
  }
  if (format === "pdf-reading") {
    return article.querySelector<HTMLElement>(".pdf-reading-mode") ?? article;
  }
  return article;
}

export function searchDomSurface(
  article: HTMLElement,
  format: DocumentFindFormat,
  query: string,
): FindAllMatchesResult {
  const root = findableRoot(article, format);
  const index = buildTextIndex(root);
  return findAllMatches(index.text, query);
}

export function searchPdfOriginalSurface(
  pages: readonly PdfPageContent[],
  query: string,
): FindAllMatchesResult {
  return findMatchesInPdfPages(
    pages.map((page) => ({
      page: page.page,
      markdown: page.markdown,
      needsOcr: page.needsOcr,
    })),
    query,
  );
}

function pdfPageTextLayer(article: HTMLElement, page: number): HTMLElement | null {
  return article.querySelector<HTMLElement>(`#pdf-page-${page} .textLayer`);
}

function pdfReadingPageRoot(article: HTMLElement, page: number): HTMLElement | null {
  return article.querySelector<HTMLElement>(`#pdf-page-${page}.pdf-reading-page`);
}

function firstMatchInIndex(index: TextIndex, quote: string): DocumentFindMatch | null {
  const { matches } = findAllMatches(index.text, quote);
  return matches[0] ?? null;
}

export function rangeForFindMatch(
  article: HTMLElement | null,
  format: DocumentFindFormat | null,
  match: DocumentFindMatch | null,
): Range | null {
  if (!article || !format || !match) return null;

  if (format === "pdf-original" && match.pdfPage != null) {
    if (match.needsOcr || !match.quote) return null;
    const layer = pdfPageTextLayer(article, match.pdfPage);
    if (!layer) return null;
    const index = buildTextIndex(layer);
    const located = firstMatchInIndex(index, match.quote);
    if (!located) return null;
    return rangeFromTextIndex(index, located.start, located.end);
  }

  if (format === "pdf-reading" && match.pdfPage != null) {
    const pageRoot = pdfReadingPageRoot(article, match.pdfPage);
    if (!pageRoot) return null;
    const index = buildTextIndex(pageRoot);
    return rangeFromTextIndex(index, match.start, match.end);
  }

  const root = findableRoot(article, format);
  const index = buildTextIndex(root);
  return rangeFromTextIndex(index, match.start, match.end);
}

export function scrollRangeIntoReader(
  reader: HTMLElement | null,
  range: Range | null,
  motionLevel: ReaderMotionLevel,
): boolean {
  const behavior: ScrollBehavior = motionLevel === "off" ? "auto" : "smooth";
  return scrollRangeIntoContainer(reader, range, behavior);
}

export function scrollToFindMatch(
  reader: HTMLElement | null,
  article: HTMLElement | null,
  format: DocumentFindFormat | null,
  match: DocumentFindMatch | null,
  motionLevel: ReaderMotionLevel,
  jumpToPage?: (page: number) => void,
): boolean {
  if (!reader || !article || !format || !match) return false;

  if (format === "pdf-original" && match.pdfPage != null) {
    jumpToPage?.(match.pdfPage);
    const pageElement = article.querySelector<HTMLElement>(`#pdf-page-${match.pdfPage}`);
    if (!pageElement) return false;
    if (match.needsOcr) {
      return scrollElementWithinContainer(reader, pageElement, motionLevel === "off" ? "auto" : "smooth");
    }
    const range = rangeForFindMatch(article, format, match);
    if (range) return scrollRangeIntoReader(reader, range, motionLevel);
    return scrollElementWithinContainer(reader, pageElement, motionLevel === "off" ? "auto" : "smooth");
  }

  const range = rangeForFindMatch(article, format, match);
  if (range) return scrollRangeIntoReader(reader, range, motionLevel);

  if (format === "pdf-reading" && match.pdfPage != null) {
    const pageElement = pdfReadingPageRoot(article, match.pdfPage);
    return scrollElementWithinContainer(
      reader,
      pageElement,
      motionLevel === "off" ? "auto" : "smooth",
    );
  }

  return false;
}

export function attachPdfReadingPageNumbers(
  article: HTMLElement,
  matches: DocumentFindMatch[],
): DocumentFindMatch[] {
  const pages = Array.from(
    article.querySelectorAll<HTMLElement>(".pdf-reading-page[data-page-number]"),
  );
  if (!pages.length) return matches;

  const boundaries: Array<{ page: number; start: number; end: number }> = [];
  let offset = 0;
  for (const pageElement of pages) {
    const page = Number.parseInt(pageElement.dataset.pageNumber ?? "", 10);
    if (!Number.isFinite(page)) continue;
    const length = buildTextIndex(pageElement).text.length;
    boundaries.push({ page, start: offset, end: offset + length });
    offset += length;
  }

  return matches.map((match) => {
    const boundary = boundaries.find(
      (item) => match.start >= item.start && match.start < item.end,
    );
    if (!boundary) return match;
    return {
      ...match,
      pdfPage: boundary.page,
      start: match.start - boundary.start,
      end: match.end - boundary.start,
    };
  });
}
