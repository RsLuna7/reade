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
  return rangesForFindMatches(article, format, [match])[0] ?? null;
}

/** Reuse each surface's text index for one paint; never retain stale DOM nodes. */
export function rangesForFindMatches(
  article: HTMLElement,
  format: DocumentFindFormat,
  matches: readonly DocumentFindMatch[],
): Array<Range | null> {
  const indexes = new Map<HTMLElement, TextIndex>();
  const pageRoots = new Map<number, HTMLElement | null>();
  const root = findableRoot(article, format);
  const indexFor = (surface: HTMLElement): TextIndex => {
    let index = indexes.get(surface);
    if (!index) {
      index = buildTextIndex(surface);
      indexes.set(surface, index);
    }
    return index;
  };
  return matches.map((match) => {
    if ((format === "pdf-original" || format === "pdf-reading") && match.pdfPage != null) {
      if (!pageRoots.has(match.pdfPage)) {
        pageRoots.set(match.pdfPage, format === "pdf-original"
          ? pdfPageTextLayer(article, match.pdfPage)
          : pdfReadingPageRoot(article, match.pdfPage));
      }
      const pageRoot = pageRoots.get(match.pdfPage);
      if (!pageRoot) return null;
      if (format === "pdf-original") {
        if (match.needsOcr || !match.quote) return null;
        const index = indexFor(pageRoot);
        const located = firstMatchInIndex(index, match.quote);
        return located ? rangeFromTextIndex(index, located.start, located.end) : null;
      }
      return rangeFromTextIndex(indexFor(pageRoot), match.start, match.end);
    }

    return rangeFromTextIndex(indexFor(root), match.start, match.end);
  });
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
