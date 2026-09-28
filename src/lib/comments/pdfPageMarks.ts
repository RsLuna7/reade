import type { Annotation } from "../backend";
import { isAnnotationMarkKind } from "../annotations";
import { normalizedAnnotationTop } from "./commentAnchor";
import type { PdfCommentThread } from "./commentModel";

export interface PdfCommentBubble {
  annotationId: string;
  /** Top of the commented passage, 0 at the page top and 1 at the bottom. */
  top: number;
  active: boolean;
}

/**
 * Shared empty list for pages without marks. Page props must keep their
 * identity across reader renders: the highlight paint effect depends on them,
 * and a fresh `[]` repaints every rendered page on each reader render.
 */
export const NO_PAGE_ITEMS: readonly never[] = Object.freeze([]);

/** Original-view highlights and underlines of a PDF, grouped by page. */
export function pdfMarksByPage(annotations: readonly Annotation[]): Map<number, Annotation[]> {
  const byPage = new Map<number, Annotation[]>();
  for (const annotation of annotations) {
    if (!isAnnotationMarkKind(annotation.kind)) continue;
    if (annotation.locator.kind !== "pdf" || annotation.locator.view !== "original") continue;
    const page = annotation.locator.page;
    const list = byPage.get(page);
    if (list) list.push(annotation);
    else byPage.set(page, [annotation]);
  }
  return byPage;
}

/** Margin bubbles for annotations that carry a live comment thread, grouped by page. */
export function pdfCommentBubblesByPage(
  annotations: readonly Annotation[],
  threads: readonly PdfCommentThread[],
  activeAnnotationId: string | null,
): Map<number, PdfCommentBubble[]> {
  const commented = new Set<string>();
  for (const thread of threads) {
    if (thread.deletedAt == null) commented.add(thread.annotationId);
  }
  const byPage = new Map<number, PdfCommentBubble[]>();
  if (commented.size === 0) return byPage;
  for (const annotation of annotations) {
    if (annotation.locator.kind !== "pdf" || !commented.has(annotation.id)) continue;
    const bubble = {
      annotationId: annotation.id,
      top: normalizedAnnotationTop(annotation.locator.rects),
      active: annotation.id === activeAnnotationId,
    };
    const list = byPage.get(annotation.locator.page);
    if (list) list.push(bubble);
    else byPage.set(annotation.locator.page, [bubble]);
  }
  return byPage;
}
