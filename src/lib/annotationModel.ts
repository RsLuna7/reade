import type {
  Annotation,
  AnnotationColor,
  AnnotationLocator,
  AnnotationRect,
  BookmarkTarget,
} from "./backend";

export const ANNOTATION_TONES = ["sand", "sage", "slate"] as const;
export type AnnotationTone = (typeof ANNOTATION_TONES)[number];

export const EXCERPT_STYLES = ["highlight", "underline"] as const;
export type ExcerptStyle = (typeof EXCERPT_STYLES)[number];
export type AnnotationEntryKind = "excerpt" | "place";

export interface AnnotationToneMeta {
  label: string;
  legacyColor: AnnotationColor;
}

export const ANNOTATION_TONE_META: Record<AnnotationTone, AnnotationToneMeta> = {
  sand: { label: "暖砂", legacyColor: "yellow" },
  sage: { label: "青灰", legacyColor: "green" },
  slate: { label: "墨蓝", legacyColor: "blue" },
};

export interface TextQuoteSelector {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface SourceRevision {
  contentHash: string;
  observedAt: number;
  basis: "capture" | "migrationSnapshot";
}

export type SourceAnchor =
  | {
      format: "markdown";
      quote: TextQuoteSelector;
      headingId: string | null;
      start?: number;
      end?: number;
    }
  | {
      format: "pdfText";
      page: number;
      view: "original" | "reading";
      quote: TextQuoteSelector;
      rects: AnnotationRect[];
      pageWidth?: number;
      pageHeight?: number;
    }
  | {
      format: "epub";
      chapterId: string;
      blockIndex: number;
      startOffset: number;
      endOffset: number;
      quote: TextQuoteSelector;
      start?: number;
      end?: number;
    };

export interface ExcerptAppearance {
  style: ExcerptStyle;
  tone: AnnotationTone;
}

export interface Excerpt {
  id: string;
  relativePath: string;
  sourceText: string;
  anchor: SourceAnchor;
  sourceRevision: SourceRevision | null;
  appearance: ExcerptAppearance;
  sortIndex: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  legacyKind: ExcerptStyle | null;
  legacyColor: AnnotationColor | null;
  /** Compatibility-only: v5 imports may carry a user-preserved title. */
  legacyTitle: string | null;
  /** Compatibility-only: v5 mark rows may legally carry null selectedText. */
  legacySelectedText: string | null;
}

export type ReadingPlaceTarget =
  | { format: "markdown"; headingId: string | null; scrollRatio: number }
  | { format: "pdf"; page: number; offsetRatio: number }
  | {
      format: "epub";
      chapterId: string;
      headingId: string | null;
      scrollRatio: number;
    };

export interface ReadingPlace {
  id: string;
  relativePath: string;
  title: string | null;
  target: ReadingPlaceTarget;
  sourceRevision: SourceRevision | null;
  sortIndex: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  legacyColor: AnnotationColor | null;
  legacySelectedText: string | null;
}

export interface Reflection {
  entryId: string;
  entryKind: AnnotationEntryKind;
  body: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface ReviewEnrollment {
  excerptId: string;
  enrolledAt: number;
  box: number;
  dueAt: number;
  lastReviewedAt: number | null;
  totalReviews: number;
  suspended: boolean;
  updatedAt: number;
  deletedAt: number | null;
}

export type AnchorResolution =
  | { status: "unchecked" }
  | { status: "exact"; method: "hint" | "exact" }
  | { status: "approximate"; method: "normalized" | "fuzzy" }
  | { status: "geometricFallback"; page: number }
  | {
      status: "detached";
      fallback: "heading" | "page" | "chapter" | null;
    }
  | { status: "sourceMissing" };

export interface DocumentAnnotationBundle {
  excerpts: Excerpt[];
  places: ReadingPlace[];
  reflections: Reflection[];
  reviewEnrollments: ReviewEnrollment[];
}

export interface ExcerptDraft {
  id: string;
  relativePath: string;
  sourceText: string;
  anchor: SourceAnchor;
  appearance: ExcerptAppearance;
  sortIndex: string;
}

export interface ReadingPlaceDraft {
  id: string;
  relativePath: string;
  title: string | null;
  target: ReadingPlaceTarget;
  sortIndex: string;
}

export interface MigratedAnnotationEntry {
  entryKind: AnnotationEntryKind;
  excerpt: Excerpt | null;
  place: ReadingPlace | null;
  reflection: Reflection | null;
}

export function isAnnotationTone(value: unknown): value is AnnotationTone {
  return typeof value === "string" && ANNOTATION_TONES.includes(value as AnnotationTone);
}

export function normalizeAnnotationTone(
  value: unknown,
  fallback: AnnotationTone = "sand",
): AnnotationTone {
  return isAnnotationTone(value) ? value : fallback;
}

export function legacyColorToTone(color: AnnotationColor | null): AnnotationTone {
  if (color === "green") return "sage";
  if (color === "blue") return "slate";
  return "sand";
}

export function toneToLegacyColor(tone: AnnotationTone): AnnotationColor {
  return ANNOTATION_TONE_META[tone].legacyColor;
}

/** Preserve pink while its mapped tone stays sand; a deliberate recolor spends it. */
export function projectedLegacyColor(excerpt: Excerpt): AnnotationColor {
  if (
    excerpt.legacyColor &&
    legacyColorToTone(excerpt.legacyColor) === excerpt.appearance.tone
  ) {
    return excerpt.legacyColor;
  }
  return toneToLegacyColor(excerpt.appearance.tone);
}

function quoteSelector(
  quote: string,
  prefix: string,
  suffix: string,
): TextQuoteSelector {
  return { exact: quote, prefix, suffix };
}

export function legacyLocatorToSourceAnchor(
  locator: Exclude<AnnotationLocator, { kind: "bookmark" }>,
): SourceAnchor {
  if (locator.kind === "markdown") {
    return {
      format: "markdown",
      quote: quoteSelector(locator.quote, locator.prefix, locator.suffix),
      headingId: locator.headingId,
      ...(locator.start === undefined ? {} : { start: locator.start }),
      ...(locator.end === undefined ? {} : { end: locator.end }),
    };
  }
  if (locator.kind === "pdf") {
    return {
      format: "pdfText",
      page: locator.page,
      view: locator.view,
      quote: quoteSelector(locator.quote, locator.prefix, locator.suffix),
      rects: locator.rects.map((rect) => ({ ...rect })),
      ...(locator.pageWidth === undefined ? {} : { pageWidth: locator.pageWidth }),
      ...(locator.pageHeight === undefined ? {} : { pageHeight: locator.pageHeight }),
    };
  }
  return {
    format: "epub",
    chapterId: locator.chapterId,
    blockIndex: locator.blockIndex,
    startOffset: locator.startOffset,
    endOffset: locator.endOffset,
    quote: quoteSelector(locator.quote, locator.prefix, locator.suffix),
    ...(locator.start === undefined ? {} : { start: locator.start }),
    ...(locator.end === undefined ? {} : { end: locator.end }),
  };
}

export function sourceAnchorToLegacyLocator(anchor: SourceAnchor): Exclude<
  AnnotationLocator,
  { kind: "bookmark" }
> {
  if (anchor.format === "markdown") {
    return {
      kind: "markdown",
      quote: anchor.quote.exact,
      prefix: anchor.quote.prefix,
      suffix: anchor.quote.suffix,
      headingId: anchor.headingId,
      ...(anchor.start === undefined ? {} : { start: anchor.start }),
      ...(anchor.end === undefined ? {} : { end: anchor.end }),
    };
  }
  if (anchor.format === "pdfText") {
    return {
      kind: "pdf",
      page: anchor.page,
      view: anchor.view,
      quote: anchor.quote.exact,
      prefix: anchor.quote.prefix,
      suffix: anchor.quote.suffix,
      rects: anchor.rects.map((rect) => ({ ...rect })),
      ...(anchor.pageWidth === undefined ? {} : { pageWidth: anchor.pageWidth }),
      ...(anchor.pageHeight === undefined ? {} : { pageHeight: anchor.pageHeight }),
    };
  }
  return {
    kind: "epub",
    chapterId: anchor.chapterId,
    blockIndex: anchor.blockIndex,
    startOffset: anchor.startOffset,
    endOffset: anchor.endOffset,
    quote: anchor.quote.exact,
    prefix: anchor.quote.prefix,
    suffix: anchor.quote.suffix,
    ...(anchor.start === undefined ? {} : { start: anchor.start }),
    ...(anchor.end === undefined ? {} : { end: anchor.end }),
  };
}

export function legacyBookmarkTargetToReadingPlaceTarget(
  target: BookmarkTarget,
): ReadingPlaceTarget {
  if (target.format === "markdown") return { ...target };
  if (target.format === "pdf") return { ...target };
  return { ...target };
}

export function readingPlaceTargetToLegacyTarget(
  target: ReadingPlaceTarget,
): BookmarkTarget {
  if (target.format === "markdown") return { ...target };
  if (target.format === "pdf") return { ...target };
  return { ...target };
}

function reflectionFromLegacy(
  annotation: Annotation,
  entryKind: AnnotationEntryKind,
): Reflection | null {
  const body = annotation.note?.trim();
  if (!body) return null;
  return {
    entryId: annotation.id,
    entryKind,
    body,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
    deletedAt: annotation.deletedAt ?? null,
  };
}

export function migrateLegacyAnnotation(
  annotation: Annotation,
  sourceRevision: SourceRevision | null = null,
): MigratedAnnotationEntry {
  if (annotation.kind === "bookmark") {
    if (annotation.locator.kind !== "bookmark") {
      throw new Error("Bookmark annotation requires a bookmark locator");
    }
    const place: ReadingPlace = {
      id: annotation.id,
      relativePath: annotation.relativePath,
      title: annotation.title,
      target: legacyBookmarkTargetToReadingPlaceTarget(annotation.locator.target),
      sourceRevision,
      sortIndex: annotation.sortIndex,
      createdAt: annotation.createdAt,
      updatedAt: annotation.updatedAt,
      deletedAt: annotation.deletedAt ?? null,
      legacyColor: annotation.color,
      legacySelectedText: annotation.selectedText,
    };
    return {
      entryKind: "place",
      excerpt: null,
      place,
      reflection: reflectionFromLegacy(annotation, "place"),
    };
  }
  if (annotation.locator.kind === "bookmark") {
    throw new Error("Excerpt annotation cannot use a bookmark locator");
  }
  const excerpt: Excerpt = {
    id: annotation.id,
    relativePath: annotation.relativePath,
    sourceText: annotation.selectedText ?? annotation.locator.quote,
    anchor: legacyLocatorToSourceAnchor(annotation.locator),
    sourceRevision,
    appearance: {
      style: annotation.kind,
      tone: legacyColorToTone(annotation.color),
    },
    sortIndex: annotation.sortIndex,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
    deletedAt: annotation.deletedAt ?? null,
    legacyKind: annotation.kind,
    legacyColor: annotation.color,
    legacyTitle: annotation.title,
    legacySelectedText: annotation.selectedText,
  };
  return {
    entryKind: "excerpt",
    excerpt,
    place: null,
    reflection: reflectionFromLegacy(annotation, "excerpt"),
  };
}

export function excerptToLegacyAnnotation(
  excerpt: Excerpt,
  reflection: Reflection | null = null,
): Annotation {
  return {
    id: excerpt.id,
    relativePath: excerpt.relativePath,
    kind: excerpt.appearance.style,
    color: projectedLegacyColor(excerpt),
    note: projectedReflectionBody(excerpt.deletedAt, reflection),
    selectedText: excerpt.legacySelectedText,
    title: excerpt.legacyTitle,
    locator: sourceAnchorToLegacyLocator(excerpt.anchor),
    sortIndex: excerpt.sortIndex,
    createdAt: excerpt.createdAt,
    updatedAt: Math.max(excerpt.updatedAt, reflection?.updatedAt ?? 0),
    deletedAt: excerpt.deletedAt,
  };
}

export function readingPlaceToLegacyAnnotation(
  place: ReadingPlace,
  reflection: Reflection | null = null,
): Annotation {
  return {
    id: place.id,
    relativePath: place.relativePath,
    kind: "bookmark",
    color: place.legacyColor,
    note: projectedReflectionBody(place.deletedAt, reflection),
    selectedText: place.legacySelectedText,
    title: place.title,
    locator: { kind: "bookmark", target: readingPlaceTargetToLegacyTarget(place.target) },
    sortIndex: place.sortIndex,
    createdAt: place.createdAt,
    updatedAt: Math.max(place.updatedAt, reflection?.updatedAt ?? 0),
    deletedAt: place.deletedAt,
  };
}

function projectedReflectionBody(
  entryDeletedAt: number | null,
  reflection: Reflection | null,
): string | null {
  if (!reflection) return null;
  if (reflection.deletedAt == null) return reflection.body;
  // A v5 tombstone retains its note. Migration mirrors the entry tombstone
  // onto the Reflection; include it in the legacy projection for parity.
  if (entryDeletedAt != null && reflection.deletedAt === entryDeletedAt) {
    return reflection.body;
  }
  return null;
}
