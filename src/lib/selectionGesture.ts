/** Pointer travel beyond this between mousedown and click is a drag, not a click. */
export const DRAG_SELECT_THRESHOLD_PX = 4;

/**
 * True when a click belongs to the gesture that made the selection: the click
 * the browser fires after a drag-select (it lands where the mouse was
 * released, often just past the last selected glyph) or a Shift+click that
 * extends it. Such clicks must not collapse the selection.
 */
export function isSelectionGestureClick(
  down: { x: number; y: number } | null,
  click: { clientX: number; clientY: number; shiftKey: boolean },
): boolean {
  if (click.shiftKey) return true;
  if (!down) return false;
  return (
    Math.hypot(click.clientX - down.x, click.clientY - down.y) > DRAG_SELECT_THRESHOLD_PX
  );
}
