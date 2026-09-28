import { describe, expect, it } from "vitest";
import { DRAG_SELECT_THRESHOLD_PX, isSelectionGestureClick } from "./selectionGesture";

describe("isSelectionGestureClick", () => {
  it("treats the click after a drag as part of the selection", () => {
    expect(
      isSelectionGestureClick({ x: 10, y: 10 }, { clientX: 200, clientY: 14, shiftKey: false }),
    ).toBe(true);
  });

  it("treats a click that barely moved as a plain click", () => {
    expect(
      isSelectionGestureClick(
        { x: 10, y: 10 },
        { clientX: 10 + DRAG_SELECT_THRESHOLD_PX, clientY: 10, shiftKey: false },
      ),
    ).toBe(false);
  });

  it("treats Shift+click as extending the selection", () => {
    expect(isSelectionGestureClick(null, { clientX: 0, clientY: 0, shiftKey: true })).toBe(true);
  });

  it("treats a click without a recorded press as a plain click", () => {
    expect(isSelectionGestureClick(null, { clientX: 50, clientY: 50, shiftKey: false })).toBe(
      false,
    );
  });
});
