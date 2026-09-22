export interface CommentAnchor {
  annotationId: string;
  desiredY: number;
}

function annotationSelector(annotationId: string, lead: boolean): string {
  const escaped = CSS.escape(annotationId);
  return lead
    ? `.pdf-user-highlight--lead[data-annotation-id="${escaped}"]`
    : `.pdf-user-highlight[data-annotation-id="${escaped}"]`;
}

/** Lead highlight when available, otherwise the first rect for the annotation. */
export function findPdfCommentLead(
  root: ParentNode,
  annotationId: string,
): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>(annotationSelector(annotationId, true)) ??
    root.querySelector<HTMLElement>(annotationSelector(annotationId, false))
  );
}

/**
 * Maps a viewport rect into the stable coordinate space shared by the PDF
 * pages and rail. The shared scroll offset cancels out in this subtraction.
 */
export function commentAnchorY(
  anchorRect: Pick<DOMRect, "top">,
  layoutRect: Pick<DOMRect, "top">,
): number {
  return anchorRect.top - layoutRect.top;
}

/**
 * A highlight hidden for live zoom (`display: none`) reports a zero box.
 * That is not a real anchor; callers should keep the last laid-out cards.
 */
export function isCollapsedCommentRect(
  rect: Pick<DOMRect, "width" | "height">,
): boolean {
  return rect.width === 0 && rect.height === 0;
}

/** Top of the anchor rect, normalized to the page box. Empty rects sit near the page top. */
export function normalizedAnnotationTop(rects: readonly { y: number }[]): number {
  let top = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    if (Number.isFinite(rect.y)) top = Math.min(top, rect.y);
  }
  return Number.isFinite(top) ? top : 0.08;
}

/**
 * Fallback when the highlight has not been painted yet (lazy pages).
 * `normalizedTop` is 0 at the page top and 1 at the page bottom.
 */
export function commentAnchorYFromPageBox(
  pageRect: Pick<DOMRect, "top" | "height">,
  layoutRect: Pick<DOMRect, "top">,
  normalizedTop: number,
): number | null {
  if (!(pageRect.height > 0)) return null;
  const y = Number.isFinite(normalizedTop)
    ? Math.min(1, Math.max(0, normalizedTop))
    : 0.08;
  return commentAnchorY({ top: pageRect.top + y * pageRect.height }, layoutRect);
}

export function measurePdfCommentAnchor(
  root: ParentNode,
  layoutRoot: Element,
  annotationId: string,
): CommentAnchor | null {
  const lead = findPdfCommentLead(root, annotationId);
  if (!lead) return null;
  const anchorRect = lead.getBoundingClientRect();
  if (isCollapsedCommentRect(anchorRect)) return null;
  return {
    annotationId,
    desiredY: commentAnchorY(anchorRect, layoutRoot.getBoundingClientRect()),
  };
}
