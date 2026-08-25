import type { AnnotationLocator, DocumentFormat } from "./backend";
import {
  readingPlaceTargetToLegacyTarget,
  sourceAnchorToLegacyLocator,
  type Excerpt,
  type ReadingPlace,
  type Reflection,
} from "./annotationModel";
import type { TocItem } from "./markdown";
import { buildTocAttributor } from "./tocHeat";

export type AnnotationOutlineView = "outline" | "reflections";

export type AnnotationOutlineEntry =
  | { kind: "excerpt"; entry: Excerpt }
  | { kind: "place"; entry: ReadingPlace };

export interface AnnotationOutlineSection {
  id: string;
  title: string;
  level: number;
  entries: AnnotationOutlineEntry[];
  excerptCount: number;
  reflectionCount: number;
  current: boolean;
}

export interface AnnotationOutlineInput {
  format: DocumentFormat;
  toc: TocItem[];
  excerpts: Excerpt[];
  places: ReadingPlace[];
  reflectionsByEntryId: ReadonlyMap<string, Reflection>;
  currentTocId: string | null;
  currentPage?: number | null;
  epubChapterTocIds?: Map<string, string>;
  view?: AnnotationOutlineView;
}

export interface AnnotationOutlineResult {
  sections: AnnotationOutlineSection[];
  excerptCount: number;
  reflectionCount: number;
  unassignedCount: number;
}

const UNASSIGNED_ID = "@annotation-unassigned";
const WHOLE_DOCUMENT_ID = "@annotation-whole-document";
const PDF_BAND_PREFIX = "@annotation-pdf-band-";
const PDF_BAND_PAGES = 20;

function entryId(item: AnnotationOutlineEntry): string {
  return item.entry.id;
}

function entrySortIndex(item: AnnotationOutlineEntry): string {
  return item.entry.sortIndex;
}

function compareEntries(a: AnnotationOutlineEntry, b: AnnotationOutlineEntry): number {
  return (
    (entrySortIndex(a) < entrySortIndex(b) ? -1 : entrySortIndex(a) > entrySortIndex(b) ? 1 : 0) ||
    a.entry.createdAt - b.entry.createdAt ||
    (entryId(a) < entryId(b) ? -1 : entryId(a) > entryId(b) ? 1 : 0)
  );
}

function locatorForEntry(item: AnnotationOutlineEntry): AnnotationLocator {
  if (item.kind === "excerpt") return sourceAnchorToLegacyLocator(item.entry.anchor);
  return {
    kind: "bookmark",
    target: readingPlaceTargetToLegacyTarget(item.entry.target),
  };
}

function pageForEntry(item: AnnotationOutlineEntry): number | null {
  if (item.kind === "excerpt") {
    return item.entry.anchor.format === "pdfText" ? item.entry.anchor.page : null;
  }
  return item.entry.target.format === "pdf" ? item.entry.target.page : null;
}

function liveReflection(
  reflectionsByEntryId: ReadonlyMap<string, Reflection>,
  id: string,
): Reflection | null {
  const reflection = reflectionsByEntryId.get(id);
  return reflection && reflection.deletedAt == null ? reflection : null;
}

function liveEntries(input: AnnotationOutlineInput): AnnotationOutlineEntry[] {
  const entries: AnnotationOutlineEntry[] = [
    ...input.excerpts
      .filter((entry) => entry.deletedAt == null)
      .map((entry): AnnotationOutlineEntry => ({ kind: "excerpt", entry })),
    ...input.places
      .filter((entry) => entry.deletedAt == null)
      .map((entry): AnnotationOutlineEntry => ({ kind: "place", entry })),
  ];
  if ((input.view ?? "outline") === "reflections") {
    return entries.filter((item) => liveReflection(input.reflectionsByEntryId, entryId(item)));
  }
  return entries;
}

function sectionStats(
  entries: AnnotationOutlineEntry[],
  reflectionsByEntryId: ReadonlyMap<string, Reflection>,
): Pick<AnnotationOutlineSection, "excerptCount" | "reflectionCount"> {
  let excerptCount = 0;
  let reflectionCount = 0;
  for (const item of entries) {
    if (item.kind === "excerpt") excerptCount += 1;
    if (liveReflection(reflectionsByEntryId, entryId(item))) reflectionCount += 1;
  }
  return { excerptCount, reflectionCount };
}

function createSection(
  id: string,
  title: string,
  level: number,
  entries: AnnotationOutlineEntry[],
  current: boolean,
  reflectionsByEntryId: ReadonlyMap<string, Reflection>,
): AnnotationOutlineSection {
  const sorted = [...entries].sort(compareEntries);
  return {
    id,
    title,
    level,
    entries: sorted,
    ...sectionStats(sorted, reflectionsByEntryId),
    current,
  };
}

function buildPdfBandOutline(
  entries: AnnotationOutlineEntry[],
  input: AnnotationOutlineInput,
): AnnotationOutlineSection[] {
  const bands = new Map<number, AnnotationOutlineEntry[]>();
  const unassigned: AnnotationOutlineEntry[] = [];
  for (const item of entries) {
    const page = pageForEntry(item);
    if (page === null || !Number.isFinite(page) || page < 1) {
      unassigned.push(item);
      continue;
    }
    const band = Math.floor((page - 1) / PDF_BAND_PAGES);
    const list = bands.get(band);
    if (list) list.push(item);
    else bands.set(band, [item]);
  }
  const currentBand =
    input.currentPage && input.currentPage > 0
      ? Math.floor((input.currentPage - 1) / PDF_BAND_PAGES)
      : null;
  const sections = [...bands.entries()]
    .sort(([a], [b]) => a - b)
    .map(([band, bandEntries]) => {
      const start = band * PDF_BAND_PAGES + 1;
      const end = start + PDF_BAND_PAGES - 1;
      return createSection(
        `${PDF_BAND_PREFIX}${band}`,
        `第 ${start}–${end} 页`,
        1,
        bandEntries,
        currentBand === band,
        input.reflectionsByEntryId,
      );
    });
  if (unassigned.length) {
    sections.push(
      createSection(
        UNASSIGNED_ID,
        "未归属",
        1,
        unassigned,
        false,
        input.reflectionsByEntryId,
      ),
    );
  }
  return sections;
}

export function buildAnnotationOutline(
  input: AnnotationOutlineInput,
): AnnotationOutlineResult {
  const entries = liveEntries(input);
  const excerptCount = entries.filter((item) => item.kind === "excerpt").length;
  const reflectionCount = entries.filter((item) =>
    liveReflection(input.reflectionsByEntryId, entryId(item)),
  ).length;

  if (!entries.length) {
    return { sections: [], excerptCount, reflectionCount, unassignedCount: 0 };
  }

  if (input.format === "pdf" && input.toc.length === 0) {
    const sections = buildPdfBandOutline(entries, input);
    const unassigned = sections.find((section) => section.id === UNASSIGNED_ID);
    return {
      sections,
      excerptCount,
      reflectionCount,
      unassignedCount: unassigned?.entries.length ?? 0,
    };
  }

  const format = input.format === "mdx" ? "markdown" : input.format;
  if (input.toc.length === 0) {
    const section = createSection(
      WHOLE_DOCUMENT_ID,
      "全文",
      1,
      entries,
      true,
      input.reflectionsByEntryId,
    );
    return { sections: [section], excerptCount, reflectionCount, unassignedCount: 0 };
  }

  const resolve = buildTocAttributor({
    items: input.toc,
    format,
    epubChapterTocIds: input.epubChapterTocIds,
  });
  const byTocId = new Map<string, AnnotationOutlineEntry[]>();
  const unassigned: AnnotationOutlineEntry[] = [];
  for (const item of entries) {
    const tocId = resolve(locatorForEntry(item));
    if (tocId === null) {
      unassigned.push(item);
      continue;
    }
    const list = byTocId.get(tocId);
    if (list) list.push(item);
    else byTocId.set(tocId, [item]);
  }

  const sections: AnnotationOutlineSection[] = [];
  for (const toc of input.toc) {
    const sectionEntries = byTocId.get(toc.id);
    if (!sectionEntries?.length) continue;
    sections.push(
      createSection(
        toc.id,
        toc.title,
        toc.level,
        sectionEntries,
        input.currentTocId === toc.id,
        input.reflectionsByEntryId,
      ),
    );
  }
  if (unassigned.length) {
    sections.push(
      createSection(
        UNASSIGNED_ID,
        "未归属",
        1,
        unassigned,
        false,
        input.reflectionsByEntryId,
      ),
    );
  }
  return {
    sections,
    excerptCount,
    reflectionCount,
    unassignedCount: unassigned.length,
  };
}
