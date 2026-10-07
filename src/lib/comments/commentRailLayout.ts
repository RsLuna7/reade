export const COMMENT_CARD_GAP = 12;

/**
 * Card track plus the gap beside the page. A fixed UI size: it does not follow
 * the page zoom. Mirrors `--pdf-comment-card-width` + `--pdf-comment-gap`.
 */
export const PDF_COMMENT_MARGIN_PX = 276;

/**
 * Container width to feed the existing fit-width helpers so the pages fill
 * what the comment margin leaves. A zero margin leaves it unchanged.
 */
export function commentFitContainerWidth(containerWidth: number, marginPx = 0): number {
  const margin = Number.isFinite(marginPx) ? Math.max(0, marginPx) : 0;
  return Math.max(0, containerWidth - margin);
}

export interface CommentCardInput {
  id: string;
  desiredY: number;
  height: number;
}

export interface CommentCardLayout extends CommentCardInput {
  renderY: number;
}

/**
 * Places cards in anchor order while preserving a minimum vertical gap.
 * The input is never mutated and equal anchors retain their input order.
 */
export function layoutCommentCards(
  inputs: readonly CommentCardInput[],
  gap = COMMENT_CARD_GAP,
): CommentCardLayout[] {
  const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : COMMENT_CARD_GAP;
  const ordered = inputs
    .map((input, index) => ({
      ...input,
      desiredY: Number.isFinite(input.desiredY) ? input.desiredY : 0,
      height: Number.isFinite(input.height) ? Math.max(0, input.height) : 0,
      index,
    }))
    .sort((left, right) => left.desiredY - right.desiredY || left.index - right.index);

  const layouts: CommentCardLayout[] = [];
  for (const input of ordered) {
    const previous = layouts[layouts.length - 1];
    const renderY = previous
      ? Math.max(input.desiredY, previous.renderY + previous.height + safeGap)
      : input.desiredY;
    layouts.push({
      id: input.id,
      desiredY: input.desiredY,
      renderY,
      height: input.height,
    });
  }
  return layouts;
}
