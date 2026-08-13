import type { Annotation, AnnotationLocator } from "./backend";
import type { TocItem } from "./markdown";
import { calendarLevel } from "./readingStats";

/**
 * Annotation-density attribution for the TOC heat map (docs/plan-heatmap-toc.md §3.1).
 *
 * Pure data only — attribution relies exclusively on the locator hints
 * recorded at creation time (`headingId` / `page` / `chapterId`), never on
 * DOM measurement. Stale hints (e.g. a renamed heading) fall into
 * `unassignedCount`, matching the annotation list's "still shown even when
 * anchoring fails" semantics.
 */

export interface TocHeatEntry {
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface TocHeatResult {
  /** TOC item id → density; entries exist only for counts ≥ 1. */
  byId: Map<string, TocHeatEntry>;
  /** Annotations before the first section or pointing at an unknown/renamed one. */
  unassignedCount: number;
}

export interface TocHeatInput {
  items: TocItem[];
  /** Callers pass live annotations; tombstones are filtered again defensively. */
  annotations: Annotation[];
  format: "markdown" | "pdf" | "epub";
  /**
   * epub only: chapterId → chapter-level TocItem.id. TOC ids are domId
   * hashes, so callers build this map via `epubChapterTocId` from
   * EpubReader; this module stays a pure lib and never imports components.
   */
  epubChapterTocIds?: Map<string, string>;
}

function markdownHeadingId(locator: AnnotationLocator): string | null {
  if (locator.kind === "markdown") return locator.headingId;
  if (locator.kind === "bookmark" && locator.target.format === "markdown") {
    return locator.target.headingId;
  }
  return null;
}

function pdfPage(locator: AnnotationLocator): number | null {
  if (locator.kind === "pdf") return locator.page;
  if (locator.kind === "bookmark" && locator.target.format === "pdf") {
    return locator.target.page;
  }
  return null;
}

function epubChapterId(locator: AnnotationLocator): string | null {
  if (locator.kind === "epub") return locator.chapterId;
  if (locator.kind === "bookmark" && locator.target.format === "epub") {
    return locator.target.chapterId;
  }
  return null;
}

const PDF_TOC_ID = /^pdf-page-(\d+)$/;

interface PdfIntervals {
  /** Distinct interval start pages, ascending. */
  pages: number[];
  /** TOC id owning each interval (first outline entry on that page wins). */
  ids: string[];
}

/**
 * Outline entries in flat order form the page intervals
 * `[page_i, page_{i+1})`, the last one extending to infinity. Entries
 * sharing a page collapse into the first one; sorting the distinct start
 * pages keeps the floor lookup correct even for the rare outline whose flat
 * order is not monotonic in page.
 */
function buildPdfIntervals(items: TocItem[]): PdfIntervals {
  const firstIdByPage = new Map<number, string>();
  for (const item of items) {
    const match = PDF_TOC_ID.exec(item.id);
    if (!match) continue;
    const page = Number.parseInt(match[1], 10);
    if (!firstIdByPage.has(page)) firstIdByPage.set(page, item.id);
  }
  const pages = [...firstIdByPage.keys()].sort((a, b) => a - b);
  return { pages, ids: pages.map((page) => firstIdByPage.get(page) as string) };
}

/** Greatest index with pages[index] <= page, or -1 when page precedes them all. */
function floorIndex(pages: number[], page: number): number {
  let low = 0;
  let high = pages.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (pages[mid] <= page) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** buildTocAttributor 的输入：与 TocHeatInput 相同,只是不需要标注本身。 */
export type TocAttributorInput = Omit<TocHeatInput, "annotations">;

/**
 * 标注 locator → TOC 条目 id 的共享归因函数（plan-book-digest BD-D2）：
 * tocHeat 的密度计数与 bookDigest 的分组编纂共用同一真相源，防两处漂移。
 * markdown 按 headingId 直配、pdf 按 Outline 页区间 floor 查找、epub 经
 * chapterId → TOC id 映射；无法归属返回 null（调用方各自决定退化语义，
 * 例如 tocHeat 对"PDF 无 Outline"整层缺席，digest 则退化为平铺列表）。
 */
export function buildTocAttributor(
  input: TocAttributorInput,
): (locator: AnnotationLocator) => string | null {
  const { items, format, epubChapterTocIds } = input;
  if (format === "pdf") {
    const { pages, ids } = buildPdfIntervals(items);
    if (pages.length === 0) return () => null;
    return (locator) => {
      const page = pdfPage(locator);
      if (page === null || !Number.isFinite(page)) return null;
      const index = floorIndex(pages, page);
      return index === -1 ? null : ids[index];
    };
  }
  if (format === "epub") {
    const tocIds = new Set(items.map((item) => item.id));
    return (locator) => {
      const chapterId = epubChapterId(locator);
      if (chapterId === null) return null;
      const tocId = epubChapterTocIds?.get(chapterId);
      return tocId !== undefined && tocIds.has(tocId) ? tocId : null;
    };
  }
  const tocIds = new Set(items.map((item) => item.id));
  return (locator) => {
    const headingId = markdownHeadingId(locator);
    return headingId !== null && tocIds.has(headingId) ? headingId : null;
  };
}

/**
 * Buckets live annotations onto TOC entries and grades each bucket 0..4 with
 * `calendarLevel` (relative to the busiest section). Effectively O(A + T):
 * markdown/epub resolve through hash lookups; pdf adds a log(T) binary search
 * per annotation over at most a few hundred outline intervals.
 */
export function buildTocHeat(input: TocHeatInput): TocHeatResult {
  const { items, annotations, format } = input;

  // No outline → the document has no sections to attribute to; the heat
  // layer is absent entirely (plan §3.1), including the unassigned note.
  if (format === "pdf" && buildPdfIntervals(items).pages.length === 0) {
    return { byId: new Map(), unassignedCount: 0 };
  }
  const resolve = buildTocAttributor(input);

  const counts = new Map<string, number>();
  let unassignedCount = 0;
  for (const annotation of annotations) {
    if (annotation.deletedAt != null) continue;
    const tocId = resolve(annotation.locator);
    if (tocId === null) {
      unassignedCount += 1;
      continue;
    }
    counts.set(tocId, (counts.get(tocId) ?? 0) + 1);
  }

  let maxCount = 0;
  for (const count of counts.values()) if (count > maxCount) maxCount = count;

  const byId = new Map<string, TocHeatEntry>();
  for (const [id, count] of counts) {
    // count ≥ 1 and maxCount ≥ count keep calendarLevel inside 1..4.
    const level = calendarLevel(count, maxCount) as TocHeatEntry["level"];
    byId.set(id, { count, level });
  }
  return { byId, unassignedCount };
}
