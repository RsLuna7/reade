/**
 * 屏缘轻扫手势（docs/plan-web-mobile-gestures.md §3.1）。
 *
 * 判定纯函数与事件接线分离：`resolveSwipeEdge`/`resolveSwipe` 可单测；
 * `attachEdgeSwipe`/`attachSwipeDismiss` 只做 pointer 事件编排。判定
 * 成功前绝不 preventDefault，纵向滚动与浏览器自身手势不受损；判定为
 * 纵向占优或反向移动即取消，冲突时的逃生门是既有按钮入口。
 * 仅响应 `pointerType === "touch"`（触控笔/鼠标不算轻扫）。
 */

/** 屏缘热区宽度（MG-D4）。 */
export const EDGE_SWIPE_ZONE_PX = 24;
/** 判定成功所需的横向位移（MG 一句话）。 */
export const EDGE_SWIPE_THRESHOLD_PX = 64;
/** 反向回撤超过该值即取消（用户改主意）。 */
export const EDGE_SWIPE_BACKTRACK_PX = 24;
/** 纵向位移超过该值且纵向占优时判定为滚动、取消手势。 */
export const EDGE_SWIPE_VERTICAL_CANCEL_PX = 48;

export type SwipeEdge = "left" | "right";

/** 起点是否落在屏缘热区；不在热区返回 null（不跟踪）。 */
export function resolveSwipeEdge(
  startX: number,
  viewportWidth: number,
  edgeWidth = EDGE_SWIPE_ZONE_PX,
): SwipeEdge | null {
  if (viewportWidth <= 0) return null;
  if (startX <= edgeWidth) return "left";
  if (startX >= viewportWidth - edgeWidth) return "right";
  return null;
}

export type SwipeVerdict = "open" | "pending" | "cancel";

export interface SwipeProgress {
  /** 手势起点所在屏缘（决定期望的滑动方向）。 */
  edge: SwipeEdge;
  /** 相对起点的位移（CSS px）。 */
  dx: number;
  dy: number;
  threshold?: number;
}

/**
 * 单步判定：
 * - 纵向位移占优且超过取消阈值 → cancel（用户在滚动）；
 * - 朝屏心方向位移达到阈值且横向明显占优（|dx| > 2|dy|）→ open；
 * - 反向回撤超过容差 → cancel；
 * - 其余 → pending（继续跟踪）。
 */
export function resolveSwipe(progress: SwipeProgress): SwipeVerdict {
  const threshold = progress.threshold ?? EDGE_SWIPE_THRESHOLD_PX;
  const absDx = Math.abs(progress.dx);
  const absDy = Math.abs(progress.dy);
  if (absDy > absDx && absDy > EDGE_SWIPE_VERTICAL_CANCEL_PX) return "cancel";
  const towardCenter = progress.edge === "left" ? progress.dx : -progress.dx;
  if (towardCenter >= threshold && absDx > 2 * absDy) return "open";
  if (towardCenter < -EDGE_SWIPE_BACKTRACK_PX) return "cancel";
  return "pending";
}

/**
 * 手势生效守卫（MG-D1 三重守卫的可单测部分）：Web 运行时 + 窄屏粗指针
 * 语境同时成立才挂手势监听；桌面运行时恒为 false（零回归）。
 */
export function mobileGesturesEnabled(runtime: string, coarseNarrowViewport: boolean): boolean {
  return runtime === "web" && coarseNarrowViewport;
}

export interface EdgeSwipeOptions {
  edgeWidth?: number;
  threshold?: number;
  onLeftEdgeSwipe?: () => void;
  onRightEdgeSwipe?: () => void;
}

interface TrackedSwipe {
  pointerId: number;
  edge: SwipeEdge;
  startX: number;
  startY: number;
}

/**
 * 在 `target` 上跟踪屏缘轻扫：左缘右扫触发 onLeftEdgeSwipe，右缘左扫
 * 触发 onRightEdgeSwipe。返回解除函数。
 */
export function attachEdgeSwipe(target: HTMLElement, options: EdgeSwipeOptions): () => void {
  let tracked: TrackedSwipe | null = null;

  const stop = () => {
    tracked = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    const edge = resolveSwipeEdge(event.clientX, window.innerWidth, options.edgeWidth);
    if (!edge) return;
    tracked = {
      pointerId: event.pointerId,
      edge,
      startX: event.clientX,
      startY: event.clientY,
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!tracked || event.pointerId !== tracked.pointerId) return;
    const verdict = resolveSwipe({
      edge: tracked.edge,
      dx: event.clientX - tracked.startX,
      dy: event.clientY - tracked.startY,
      threshold: options.threshold,
    });
    if (verdict === "pending") return;
    const edge = tracked.edge;
    stop();
    if (verdict === "open") {
      if (edge === "left") options.onLeftEdgeSwipe?.();
      else options.onRightEdgeSwipe?.();
    }
  };

  target.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerup", stop, { passive: true });
  window.addEventListener("pointercancel", stop, { passive: true });
  return () => {
    stop();
    target.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };
}

export interface SwipeDismissOptions {
  /** 关闭方向："left" 表示向左扫关闭（左侧抽屉），"right" 反之。 */
  direction: SwipeEdge;
  threshold?: number;
  onDismiss: () => void;
}

/**
 * 抽屉开启时的反向轻扫关闭：在抽屉元素内任意位置起手，朝 `direction`
 * 方向的横向占优位移达到阈值即触发 onDismiss。
 */
export function attachSwipeDismiss(
  target: HTMLElement,
  options: SwipeDismissOptions,
): () => void {
  let tracked: { pointerId: number; startX: number; startY: number } | null = null;

  const stop = () => {
    tracked = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    tracked = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!tracked || event.pointerId !== tracked.pointerId) return;
    // 复用 resolveSwipe:向左关闭等价于"右缘朝屏心扫"的方向判定。
    const verdict = resolveSwipe({
      edge: options.direction === "left" ? "right" : "left",
      dx: event.clientX - tracked.startX,
      dy: event.clientY - tracked.startY,
      threshold: options.threshold,
    });
    if (verdict === "pending") return;
    stop();
    if (verdict === "open") options.onDismiss();
  };

  target.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerup", stop, { passive: true });
  window.addEventListener("pointercancel", stop, { passive: true });
  return () => {
    stop();
    target.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };
}
