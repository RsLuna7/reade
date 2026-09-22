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
