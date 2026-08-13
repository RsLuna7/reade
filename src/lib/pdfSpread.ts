/**
 * PDF 双页对开纯逻辑（plan-pdf-spread）：页配对、翻页步长、适宽缩放
 * 与可用性判定。布局与状态接线在 PdfReader.tsx，这里只做可单测的数学。
 */

/** 宽窗断点（PS-D1 定稿）：与 CSS 全局断点体系对齐的窗口宽度门槛。 */
export const SPREAD_MIN_WINDOW_WIDTH = 1180;
/** 单页可读下限：并排后每页 CSS 宽低于此值时自动回单页。 */
export const SPREAD_MIN_PAGE_WIDTH = 320;
/** 双列间距，与单页纵向 22px 的节奏一致。 */
export const SPREAD_COLUMN_GAP = 22;
/** 适宽计算的滚动条/边距余量，与既有单页适宽的 18px 同源。 */
export const SPREAD_FIT_GUTTER = 18;
/** spread 下懒渲染窗口收紧（§3.3 性能预算：同屏渲染页 ≤6）。 */
export const SPREAD_RENDER_MARGIN = "800px 0px";

/**
 * 页所在"对"的起始页：第 1 页独立成对（封面右页语义，PS-D2），
 * 此后 (2k, 2k+1) 配对——偶数页是对首（左页）。
 */
export function spreadPairStart(page: number): number {
  const normalized = Math.max(1, Math.floor(Number.isFinite(page) ? page : 1));
  if (normalized <= 1) return 1;
  return normalized % 2 === 0 ? normalized : normalized - 1;
}

/** 页所在行的页号集合（首页单独一行；末页可能落单）。 */
export function spreadRowPages(page: number, pageCount: number): number[] {
  const start = spreadPairStart(page);
  if (start === 1) return [1];
  return start + 1 <= pageCount ? [start, start + 1] : [start];
}

/** 下一对的对首页（PS-D4：±2，封面边界 ±1）；钳在 [1, pageCount]。 */
export function nextSpreadPage(current: number, pageCount: number): number {
  const start = spreadPairStart(current);
  const next = start === 1 ? 2 : start + 2;
  const limit = Math.max(1, Math.floor(pageCount) || 1);
  return Math.min(limit, next);
}

/** 上一对的对首页；(2,3) 的上一对是封面页 1。 */
export function previousSpreadPage(current: number): number {
  const start = spreadPairStart(current);
  return Math.max(1, start - 2);
}

/** 单页适宽：与既有 `(clientWidth - 18) / nativeWidth` 完全同源。 */
export function singleFitScale(containerWidth: number, nativeWidth: number): number {
  return (containerWidth - SPREAD_FIT_GUTTER) / nativeWidth;
}

/** 双页适宽：两页 + 列距恰好填满容器（§2 目标 2）。 */
export function spreadFitScale(containerWidth: number, nativeWidth: number): number {
  return (containerWidth - SPREAD_FIT_GUTTER - SPREAD_COLUMN_GAP) / 2 / nativeWidth;
}

/**
 * 双页可用性（PS-D1 定稿）：窗口 ≥1180 且容器能放下两个 ≥320px 的页。
 * 两个条件都不满足时工具栏钮禁用、已开启的意图自动回落单页。
 */
export function canSpread(windowWidth: number, containerWidth: number): boolean {
  if (!Number.isFinite(windowWidth) || windowWidth < SPREAD_MIN_WINDOW_WIDTH) {
    return false;
  }
  if (!Number.isFinite(containerWidth)) return false;
  return (
    containerWidth - SPREAD_FIT_GUTTER - SPREAD_COLUMN_GAP >=
    SPREAD_MIN_PAGE_WIDTH * 2
  );
}
