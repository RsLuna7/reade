import type { Annotation } from "../backend";
import type { PendingSelection } from "../annotationCapture";
import type { PdfCommentThread } from "./commentModel";

interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlapArea(left: NormRect, right: NormRect): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y),
  );
  return width * height;
}

export interface CommentPlacement {
  annotationId: string;
  threadId: string | null;
}

/** Attach a selection to the mark it overlaps most, or null when it needs a new highlight. */
export function commentTargetForSelection(
  pending: PendingSelection,
  annotations: readonly Annotation[],
  threads: readonly PdfCommentThread[],
): CommentPlacement | null {
  if (pending.locator.kind !== "pdf") return null;
  const locator = pending.locator;
  if (locator.view !== "original") return null;
  const page = locator.page;
  let bestId = "";
  let bestArea = 0;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (let index = 0; index < annotations.length; index += 1) {
    const annotation = annotations[index];
    if (!annotation) continue;
    if (annotation.kind !== "highlight" && annotation.kind !== "underline") continue;
    if (annotation.locator.kind !== "pdf") continue;
    if (annotation.locator.view !== "original" || annotation.locator.page !== page) continue;
    let area = 0;
    for (const left of locator.rects) {
      for (const right of annotation.locator.rects) area += overlapArea(left, right);
    }
    if (area <= 0) continue;
    if (area > bestArea || (area === bestArea && index < bestIndex)) {
      bestId = annotation.id;
      bestArea = area;
      bestIndex = index;
    }
  }
  if (!bestId) return null;
  const thread = threads.find(
    (item) => item.annotationId === bestId && item.deletedAt == null,
  );
  return { annotationId: bestId, threadId: thread?.id ?? null };
}

export function pdfCommentSortKey(annotation: Annotation | undefined): [number, number, string] {
  if (!annotation || annotation.locator.kind !== "pdf") return [Number.MAX_SAFE_INTEGER, 0, ""];
  const top = annotation.locator.rects.reduce(
    (min, rect) => Math.min(min, rect.y),
    Number.POSITIVE_INFINITY,
  );
  return [annotation.locator.page, Number.isFinite(top) ? top : 0, annotation.id];
}
