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

/** Lowercasing can expand a character (İ → i + combining dot). */
function originalOffsetMapper(original: string, normalized: string) {
  if (original.length === normalized.length) return (offset: number) => offset;
  const changes: Array<{ start: number; end: number; source: number; sourceEnd: number }> = [];
  let source = 0;
  let target = 0;
  for (const character of original) {
    const length = character.toLowerCase().length;
    if (length !== character.length) {
      changes.push({ start: target, end: target + length, source, sourceEnd: source + character.length });
    }
    source += character.length;
    target += length;
  }
  return (offset: number, endBoundary = false): number => {
    let low = 0;
    let high = changes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (changes[middle].start <= offset) low = middle + 1;
      else high = middle;
    }
    const change = changes[low - 1];
    if (!change) return offset;
    if (offset === change.start) return change.source;
    if (offset < change.end) return endBoundary ? change.sourceEnd : change.source;
    return offset - (change.end - change.sourceEnd);
  };
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
  const originalOffset = originalOffsetMapper(haystack, searchHaystack);

  const matches: DocumentFindMatch[] = [];
  let searchFrom = 0;
  while (searchFrom <= searchHaystack.length && matches.length < maxMatches) {
    const index = searchHaystack.indexOf(searchNeedle, searchFrom);
    if (index < 0) break;
    const start = originalOffset(index);
    const end = originalOffset(index + searchNeedle.length, true);
    matches.push({ id: `${start}:${end}`, start, end });
    searchFrom = index + 1;
  }

  let truncated = false;
  if (matches.length >= maxMatches) {
    const next = searchHaystack.indexOf(searchNeedle, searchFrom);
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
