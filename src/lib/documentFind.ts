/**
 * In-document find (Ctrl+F): pure match enumeration over flat text.
 * DOM mapping and scrolling live in documentFindAdapters.ts.
 */

export const DOCUMENT_FIND_MAX_MATCHES = 5000;
export const DOCUMENT_FIND_DEBOUNCE_MS = 200;

export interface DocumentFindMatch {
  id: string;
  /** Offset in the flat search surface (DOM index or page-local for PDF original). */
  start: number;
  end: number;
  pdfPage?: number;
  /** PDF original: substring slice source in extracted page markdown. */
  quote?: string;
  needsOcr?: boolean;
}

export interface FindAllMatchesResult {
  matches: DocumentFindMatch[];
  truncated: boolean;
}

export interface FindAllMatchesOptions {
  maxMatches?: number;
  caseSensitive?: boolean;
}

function normalizeNeedle(query: string): string {
  return query.trim();
}

/**
 * Case-insensitive substring search (browser find default). Returns UTF-16
 * offsets compatible with buildTextIndex / rangeFromTextIndex.
 */
export function findAllMatches(
  haystack: string,
  query: string,
  options?: FindAllMatchesOptions,
): FindAllMatchesResult {
  const needle = normalizeNeedle(query);
  if (!needle || !haystack) return { matches: [], truncated: false };

  const maxMatches = options?.maxMatches ?? DOCUMENT_FIND_MAX_MATCHES;
  const caseSensitive = options?.caseSensitive ?? false;
  const searchHaystack = caseSensitive ? haystack : haystack.toLowerCase();
  const searchNeedle = caseSensitive ? needle : needle.toLowerCase();

  const matches: DocumentFindMatch[] = [];
  let searchFrom = 0;
  while (searchFrom <= searchHaystack.length && matches.length < maxMatches) {
    const index = searchHaystack.indexOf(searchNeedle, searchFrom);
    if (index < 0) break;
    const end = index + needle.length;
    matches.push({ id: `${index}:${end}`, start: index, end });
    searchFrom = index + 1;
  }

  let truncated = false;
  if (matches.length >= maxMatches) {
    const next = searchHaystack.indexOf(searchNeedle, matches[maxMatches - 1].start + 1);
    truncated = next >= 0;
  }

  return { matches, truncated };
}

export interface PdfPageSearchInput {
  page: number;
  markdown: string;
  needsOcr: boolean;
}

/** PDF original: search each extracted page separately. */
export function findMatchesInPdfPages(
  pages: readonly PdfPageSearchInput[],
  query: string,
  options?: FindAllMatchesOptions,
): FindAllMatchesResult {
  const needle = normalizeNeedle(query);
  if (!needle) return { matches: [], truncated: false };

  const maxMatches = options?.maxMatches ?? DOCUMENT_FIND_MAX_MATCHES;
  const matches: DocumentFindMatch[] = [];
  let truncated = false;

  for (const page of pages) {
    if (matches.length >= maxMatches) break;
    if (page.needsOcr || !page.markdown.trim()) continue;
    const remaining = maxMatches - matches.length;
    const pageResult = findAllMatches(page.markdown, needle, {
      ...options,
      maxMatches: remaining,
    });
    for (const hit of pageResult.matches) {
      matches.push({
        id: `${page.page}:${hit.start}:${hit.end}`,
        start: hit.start,
        end: hit.end,
        pdfPage: page.page,
        quote: page.markdown.slice(hit.start, hit.end),
      });
    }
    if (pageResult.truncated) truncated = true;
  }

  return { matches, truncated };
}

export function nextFindIndex(current: number, total: number): number {
  if (total <= 0) return -1;
  if (current < 0) return 0;
  return (current + 1) % total;
}

export function previousFindIndex(current: number, total: number): number {
  if (total <= 0) return -1;
  if (current < 0) return total - 1;
  return (current - 1 + total) % total;
}
