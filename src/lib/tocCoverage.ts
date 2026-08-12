import type { TocItem } from "./markdown";

/**
 * Read-coverage marks for the TOC (docs/plan-heatmap-toc.md §3.3, T2).
 *
 * Data source is the `readingPositions` high-water marks (`maxScrollRatio`
 * for markdown/epub, `maxPage` for pdf). PDF attribution is pure data; for
 * flowed formats the heading positions are measured once after render (in
 * an idle callback, never on the scroll path) and cached as
 * `Map<id, ratio>` — scrolling only compares the cached ratios against the
 * persisted mark. A missing cache simply renders everything as unreached.
 */

const PDF_TOC_ID = /^pdf-page-(\d+)$/;

/**
 * PDF coverage: outline entries whose start page is at or before the
 * furthest visited page count as reached. `maxPage` ≤ 0 or null (no
 * position recorded yet) yields an empty set.
 */
export function buildPdfTocCoverage(
  items: readonly TocItem[],
  maxPage: number | null,
): Set<string> {
  const reached = new Set<string>();
  if (maxPage === null || !Number.isFinite(maxPage) || maxPage < 1) return reached;
  for (const item of items) {
    const match = PDF_TOC_ID.exec(item.id);
    if (!match) continue;
    if (Number.parseInt(match[1], 10) <= maxPage) reached.add(item.id);
  }
  return reached;
}

/**
 * One-off measurement of heading positions inside the scroll container:
 * vertical offset within the scrolled content divided by `scrollHeight`,
 * clamped to 0..1. Uses bounding rects rather than `offsetTop` so nested
 * offset parents (epub chapter sections) cannot skew the result.
 *
 * Returns null while the container has no measurable content yet (e.g.
 * before layout); callers keep the previous cache or render "unreached".
 */
export function measureHeadingRatios(
  container: HTMLElement,
  ids: readonly string[],
): Map<string, number> | null {
  const scrollHeight = container.scrollHeight;
  if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) return null;
  const containerTop = container.getBoundingClientRect().top;
  const ratios = new Map<string, number>();
  for (const id of ids) {
    let element: Element | null;
    try {
      element = container.querySelector(`#${CSS.escape(id)}`);
    } catch {
      element = null;
    }
    if (!(element instanceof HTMLElement)) continue;
    const top = element.getBoundingClientRect().top - containerTop + container.scrollTop;
    ratios.set(id, Math.min(1, Math.max(0, top / scrollHeight)));
  }
  return ratios;
}

/**
 * Scroll-path comparison for markdown/epub: an entry is reached once its
 * cached ratio is at or below the monotonic `maxScrollRatio`. A null cache
 * (not measured yet) or mark yields an empty set — "cache not ready renders
 * everything as unreached" is the T2 contract.
 */
export function coverageFromRatios(
  ratios: ReadonlyMap<string, number> | null,
  maxScrollRatio: number | null,
): Set<string> {
  const reached = new Set<string>();
  if (!ratios || maxScrollRatio === null || !Number.isFinite(maxScrollRatio)) {
    return reached;
  }
  for (const [id, ratio] of ratios) {
    if (ratio <= maxScrollRatio) reached.add(id);
  }
  return reached;
}
