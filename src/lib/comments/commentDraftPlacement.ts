export interface CommentDraftPlacement {
  left: number;
  top?: number;
  bottom?: number;
}

const DRAFT_WIDTH = 320;
const DRAFT_HEIGHT = 190;
const DRAFT_GAP = 8;
const VIEWPORT_PADDING = 12;

/**
 * Places the new-comment draft next to the selection without covering it:
 * below the selected lines, or above them when the window has no room below.
 */
export function commentDraftPlacement(
  selection: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
): CommentDraftPlacement {
  const maxLeft = Math.max(VIEWPORT_PADDING, viewport.width - DRAFT_WIDTH - VIEWPORT_PADDING);
  const left = Math.min(maxLeft, Math.max(VIEWPORT_PADDING, selection.left));
  const below = selection.top + selection.height + DRAFT_GAP;
  if (below + DRAFT_HEIGHT <= viewport.height - VIEWPORT_PADDING) return { left, top: below };
  const above = selection.top - DRAFT_GAP;
  if (above - DRAFT_HEIGHT >= VIEWPORT_PADDING) {
    return { left, bottom: viewport.height - above };
  }
  // A selection taller than the window: pin the draft to the bottom edge.
  return { left, bottom: VIEWPORT_PADDING };
}
