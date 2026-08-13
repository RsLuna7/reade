// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EDGE_SWIPE_THRESHOLD_PX,
  EDGE_SWIPE_ZONE_PX,
  attachEdgeSwipe,
  mobileGesturesEnabled,
  resolveSwipe,
  resolveSwipeEdge,
} from "./edgeSwipe";

describe("resolveSwipeEdge", () => {
  it("detects the left and right edge zones", () => {
    expect(resolveSwipeEdge(0, 390)).toBe("left");
    expect(resolveSwipeEdge(EDGE_SWIPE_ZONE_PX, 390)).toBe("left");
    expect(resolveSwipeEdge(390, 390)).toBe("right");
    expect(resolveSwipeEdge(390 - EDGE_SWIPE_ZONE_PX, 390)).toBe("right");
  });

  it("ignores starts outside the zones or in a degenerate viewport", () => {
    expect(resolveSwipeEdge(EDGE_SWIPE_ZONE_PX + 1, 390)).toBeNull();
    expect(resolveSwipeEdge(195, 390)).toBeNull();
    expect(resolveSwipeEdge(10, 0)).toBeNull();
  });

  it("honours a custom edge width", () => {
    expect(resolveSwipeEdge(30, 390, 32)).toBe("left");
    expect(resolveSwipeEdge(30, 390, 24)).toBeNull();
  });
});

describe("resolveSwipe", () => {
  it("opens once the displacement toward the center passes the threshold", () => {
    expect(resolveSwipe({ edge: "left", dx: EDGE_SWIPE_THRESHOLD_PX, dy: 4 })).toBe("open");
    expect(resolveSwipe({ edge: "right", dx: -EDGE_SWIPE_THRESHOLD_PX, dy: -6 })).toBe("open");
  });

  it("keeps pending below the threshold", () => {
    expect(resolveSwipe({ edge: "left", dx: 40, dy: 2 })).toBe("pending");
    expect(resolveSwipe({ edge: "right", dx: -40, dy: 0 })).toBe("pending");
  });

  it("requires a horizontally dominant motion (|dx| > 2|dy|)", () => {
    expect(resolveSwipe({ edge: "left", dx: 70, dy: 36 })).toBe("pending");
    expect(resolveSwipe({ edge: "left", dx: 70, dy: 30 })).toBe("open");
  });

  it("cancels when the motion is a vertical scroll", () => {
    expect(resolveSwipe({ edge: "left", dx: 8, dy: 60 })).toBe("cancel");
    expect(resolveSwipe({ edge: "right", dx: -8, dy: -60 })).toBe("cancel");
    // 纵向未超取消阈值时仍继续观察。
    expect(resolveSwipe({ edge: "left", dx: 8, dy: 30 })).toBe("pending");
  });

  it("cancels when the finger backtracks away from the center", () => {
    expect(resolveSwipe({ edge: "left", dx: -30, dy: 0 })).toBe("cancel");
    expect(resolveSwipe({ edge: "right", dx: 30, dy: 0 })).toBe("cancel");
  });

  it("honours a custom threshold", () => {
    expect(resolveSwipe({ edge: "left", dx: 50, dy: 0, threshold: 48 })).toBe("open");
    expect(resolveSwipe({ edge: "left", dx: 50, dy: 0, threshold: 64 })).toBe("pending");
  });
});

describe("mobileGesturesEnabled", () => {
  it("requires the web runtime plus the coarse narrow viewport", () => {
    expect(mobileGesturesEnabled("web", true)).toBe(true);
    expect(mobileGesturesEnabled("web", false)).toBe(false);
    // 桌面运行时恒不挂手势监听(MG-D1 桌面零回归)。
    expect(mobileGesturesEnabled("desktop", true)).toBe(false);
    expect(mobileGesturesEnabled("desktop", false)).toBe(false);
  });
});

describe("attachEdgeSwipe", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function pointerEvent(
    type: string,
    init: { pointerId?: number; pointerType?: string; isPrimary?: boolean; clientX: number; clientY: number },
  ): Event {
    // jsdom 没有 PointerEvent 构造器:用 MouseEvent 附加 pointer 字段。
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: init.clientX,
      clientY: init.clientY,
    });
    Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
    Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "touch" });
    Object.defineProperty(event, "isPrimary", { value: init.isPrimary ?? true });
    return event;
  }

  it("fires the edge callbacks for touch swipes and stops after detach", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    const onLeftEdgeSwipe = vi.fn();
    const onRightEdgeSwipe = vi.fn();
    const detach = attachEdgeSwipe(host, { onLeftEdgeSwipe, onRightEdgeSwipe });

    host.dispatchEvent(pointerEvent("pointerdown", { clientX: 8, clientY: 200 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 90, clientY: 204 }));
    expect(onLeftEdgeSwipe).toHaveBeenCalledTimes(1);

    host.dispatchEvent(pointerEvent("pointerdown", { clientX: 384, clientY: 200 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 300, clientY: 196 }));
    expect(onRightEdgeSwipe).toHaveBeenCalledTimes(1);

    detach();
    host.dispatchEvent(pointerEvent("pointerdown", { clientX: 8, clientY: 200 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 90, clientY: 204 }));
    expect(onLeftEdgeSwipe).toHaveBeenCalledTimes(1);
  });

  it("ignores mouse pointers and starts outside the edge zones", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    const onLeftEdgeSwipe = vi.fn();
    const detach = attachEdgeSwipe(host, { onLeftEdgeSwipe });

    host.dispatchEvent(
      pointerEvent("pointerdown", { clientX: 8, clientY: 200, pointerType: "mouse" }),
    );
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 120, clientY: 200 }));
    expect(onLeftEdgeSwipe).not.toHaveBeenCalled();

    host.dispatchEvent(pointerEvent("pointerdown", { clientX: 120, clientY: 200 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 260, clientY: 200 }));
    expect(onLeftEdgeSwipe).not.toHaveBeenCalled();
    detach();
  });

  it("cancels a swipe that turns into a vertical scroll", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    const onLeftEdgeSwipe = vi.fn();
    const detach = attachEdgeSwipe(host, { onLeftEdgeSwipe });

    host.dispatchEvent(pointerEvent("pointerdown", { clientX: 8, clientY: 100 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 16, clientY: 220 }));
    // 已取消:随后的横向位移不再触发。
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 200, clientY: 220 }));
    expect(onLeftEdgeSwipe).not.toHaveBeenCalled();
    detach();
  });
});
