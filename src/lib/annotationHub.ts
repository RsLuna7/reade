import type { Annotation } from "./backend";

/**
 * Pure grouping helpers for the annotation hub
 * (`docs/plan-annotation-hub.md` §3.2). No IO and no UI state here: the
 * sidebar tab / hub view feed `listAnnotations` or `searchAnnotations`
 * results through these and keep collapse state locally.
 */

/** Annotations shown per group before the "展开全部" affordance (§3.2). */
export const ANNOTATION_GROUP_PREVIEW_COUNT = 20;

export interface AnnotationGroup {
  relativePath: string;
  /**
   * true when the path is absent from the current document set: the
   * document moved or was deleted while its annotations remain ("失联"
   * group, rendered last and not clickable).
   */
  missing: boolean;
  /** Position order (`sortIndex`), matching the desktop search ordering. */
  annotations: Annotation[];
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePosition(a: Annotation, b: Annotation): number {
  return (
    compareStrings(a.sortIndex, b.sortIndex) ||
    a.createdAt - b.createdAt ||
    compareStrings(a.id, b.id)
  );
}

/**
 * Groups live annotations by document. Groups whose path exists in
 * `presentPaths` come first in path order; missing-document groups sort
 * last, also in path order (decision A-D4: read-only display, rebinding
 * stays with move detection). Tombstones are dropped defensively, mirroring
 * the desktop `deleted_at IS NULL` scope.
 */
export function groupAnnotationsByDocument(
  annotations: readonly Annotation[],
  presentPaths: ReadonlySet<string>,
): AnnotationGroup[] {
  const byPath = new Map<string, Annotation[]>();
  for (const annotation of annotations) {
    if (annotation.deletedAt != null) continue;
    const group = byPath.get(annotation.relativePath);
    if (group) group.push(annotation);
    else byPath.set(annotation.relativePath, [annotation]);
  }
  const groups: AnnotationGroup[] = [...byPath.entries()].map(([relativePath, items]) => ({
    relativePath,
    missing: !presentPaths.has(relativePath),
    annotations: items.sort(comparePosition),
  }));
  groups.sort(
    (a, b) =>
      Number(a.missing) - Number(b.missing) || compareStrings(a.relativePath, b.relativePath),
  );
  return groups;
}

export interface AnnotationGroupPreview {
  visible: Annotation[];
  /** How many more entries the "展开全部 N 条" control would reveal. */
  hiddenCount: number;
}

/** First `limit` entries plus the remainder count for the collapse control. */
export function previewGroupAnnotations(
  annotations: readonly Annotation[],
  limit: number = ANNOTATION_GROUP_PREVIEW_COUNT,
): AnnotationGroupPreview {
  if (annotations.length <= limit) {
    return { visible: [...annotations], hiddenCount: 0 };
  }
  return {
    visible: annotations.slice(0, limit),
    hiddenCount: annotations.length - limit,
  };
}
