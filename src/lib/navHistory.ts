/**
 * 阅读回退栈的归约纯函数（docs/plan-nav-history.md §3.1）。
 *
 * 双栈浏览器语义：跳转前 push 出发点并清空 forward；后退把当前位置放入
 * forward、弹出 back 顶作为恢复目标，前进对称。位置表示与两条既有恢复
 * 通道一一对应（NH-D2）：markdown/EPUB 记容器 scrollTop（px），PDF 记
 * 页码 + 页内偏移。栈上限 50（NAV_HISTORY_LIMIT）丢最旧，近似栈顶去重。
 */

export type NavPosition =
  | { kind: "scroll"; scrollTop: number }
  | { kind: "pdf"; page: number; offsetRatio: number };

export interface NavLocation {
  /** 库内相对路径；仅作 selectDocument 入参，永不直接触文件系统。 */
  path: string;
  position: NavPosition;
}

/** 后退/前进双栈，栈顶在数组末尾。 */
export interface NavHistory {
  back: readonly NavLocation[];
  forward: readonly NavLocation[];
}

export const NAV_HISTORY_LIMIT = 50;

export const EMPTY_NAV_HISTORY: NavHistory = { back: [], forward: [] };

/** scroll 位置在 ±24px 内视为同一处（防同点堆叠）。 */
const SCROLL_EPSILON_PX = 24;
/** PDF 同页且页内偏移差 ≤0.02 视为同一处。 */
const PDF_OFFSET_EPSILON = 0.02;

export function sameNavLocation(a: NavLocation, b: NavLocation): boolean {
  if (a.path !== b.path) return false;
  if (a.position.kind === "scroll" && b.position.kind === "scroll") {
    return Math.abs(a.position.scrollTop - b.position.scrollTop) <= SCROLL_EPSILON_PX;
  }
  if (a.position.kind === "pdf" && b.position.kind === "pdf") {
    return (
      a.position.page === b.position.page &&
      Math.abs(a.position.offsetRatio - b.position.offsetRatio) <= PDF_OFFSET_EPSILON
    );
  }
  return false;
}

/**
 * 跳转前记录出发点。与 back 栈顶近似相同时原样返回（去重）；
 * 任何新跳转都会清空 forward 栈（浏览器语义）。
 */
export function pushNavLocation(
  history: NavHistory,
  location: NavLocation,
  limit = NAV_HISTORY_LIMIT,
): NavHistory {
  const top = history.back[history.back.length - 1];
  if (top && sameNavLocation(top, location)) {
    return history.forward.length === 0 ? history : { back: history.back, forward: [] };
  }
  const back = [...history.back, location];
  return { back: back.length > limit ? back.slice(back.length - limit) : back, forward: [] };
}

export interface NavPopResult {
  history: NavHistory;
  /** 应当恢复到的位置。 */
  target: NavLocation;
}

/**
 * 后退：弹出 back 顶作为目标，当前位置（若有）压入 forward。
 * back 空时返回 null（调用方保持禁用态）。
 */
export function popNavBack(
  history: NavHistory,
  current: NavLocation | null,
  limit = NAV_HISTORY_LIMIT,
): NavPopResult | null {
  if (history.back.length === 0) return null;
  const target = history.back[history.back.length - 1];
  const forward = current ? [...history.forward, current] : [...history.forward];
  return {
    history: {
      back: history.back.slice(0, -1),
      forward: forward.length > limit ? forward.slice(forward.length - limit) : forward,
    },
    target,
  };
}

/** 前进：与 popNavBack 完全对称。 */
export function popNavForward(
  history: NavHistory,
  current: NavLocation | null,
  limit = NAV_HISTORY_LIMIT,
): NavPopResult | null {
  if (history.forward.length === 0) return null;
  const target = history.forward[history.forward.length - 1];
  const back = current ? [...history.back, current] : [...history.back];
  return {
    history: {
      back: back.length > limit ? back.slice(back.length - limit) : back,
      forward: history.forward.slice(0, -1),
    },
    target,
  };
}

export function canNavBack(history: NavHistory): boolean {
  return history.back.length > 0;
}

export function canNavForward(history: NavHistory): boolean {
  return history.forward.length > 0;
}
