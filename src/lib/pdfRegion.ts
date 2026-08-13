/**
 * PDF 区域引用的几何与裁剪纯函数（docs/plan-pdf-region-card.md §3.1–§3.2）。
 * 归一化语义与 PDF 标注 rects 一致（页内 [0..1]）；裁剪坐标一律按
 * "归一化 × 实际位图尺寸"换算——对位图本身归一,不读 devicePixelRatio,
 * 天然免疫"渲染时 DPR 与当前 DPR 不一致"的坑（RG-D1）。
 */

export interface RegionPoint {
  x: number;
  y: number;
}

export interface NormalizedRegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 最小选区门槛（页内逻辑 px）：更小视为误触忽略。 */
export const REGION_MIN_LOGICAL_PX = 24;
/** 裁剪位图短边低于该值时尝试离屏重渲提质。 */
export const REGION_UPSCALE_TRIGGER_PX = 480;
/** 重渲后的目标裁剪短边。 */
export const REGION_UPSCALE_TARGET_PX = 960;
/** 重渲页位图长边封顶（超大页内存保护）。 */
export const REGION_MAX_RERENDER_SIDE_PX = 4096;

/**
 * 把拖拽起止点（页内逻辑坐标）规范为页内 [0..1] 矩形：任意方向拖拽、
 * 越界钳制；低于最小门槛（宽或高 < minSizePx）返回 null（视为误触）。
 */
export function normalizeRegionRect(
  start: RegionPoint,
  end: RegionPoint,
  pageWidth: number,
  pageHeight: number,
  minSizePx: number = REGION_MIN_LOGICAL_PX,
): NormalizedRegionRect | null {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return null;
  const clampX = (value: number) => Math.min(pageWidth, Math.max(0, value));
  const clampY = (value: number) => Math.min(pageHeight, Math.max(0, value));
  const left = clampX(Math.min(start.x, end.x));
  const right = clampX(Math.max(start.x, end.x));
  const top = clampY(Math.min(start.y, end.y));
  const bottom = clampY(Math.max(start.y, end.y));
  if (right - left < minSizePx || bottom - top < minSizePx) return null;
  return {
    x: left / pageWidth,
    y: top / pageHeight,
    w: (right - left) / pageWidth,
    h: (bottom - top) / pageHeight,
  };
}

export interface RegionSourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * 归一化矩形 → 位图整数裁剪参数。位图已含渲染像素比,不再乘任何 ratio；
 * 四边取整后钳回位图边界,宽高至少 1px。
 */
export function regionSourceRect(
  rect: NormalizedRegionRect,
  bitmapWidth: number,
  bitmapHeight: number,
): RegionSourceRect {
  const sx = Math.min(Math.max(0, Math.round(rect.x * bitmapWidth)), Math.max(0, bitmapWidth - 1));
  const sy = Math.min(Math.max(0, Math.round(rect.y * bitmapHeight)), Math.max(0, bitmapHeight - 1));
  const sw = Math.max(1, Math.min(bitmapWidth - sx, Math.round(rect.w * bitmapWidth)));
  const sh = Math.max(1, Math.min(bitmapHeight - sy, Math.round(rect.h * bitmapHeight)));
  return { sx, sy, sw, sh };
}

/**
 * 提质重渲计划（RG-D1）：裁剪短边 ≥480px 时不重渲（返回 null）；否则
 * 返回相对当前位图的放大倍数,使裁剪短边≈960px,并以"页位图长边 ≤4096px"
 * 封顶;封顶后不足 1 的倍数同样返回 null（重渲无收益,直接裁）。
 */
export function planRegionUpscale(input: {
  cropWidth: number;
  cropHeight: number;
  bitmapWidth: number;
  bitmapHeight: number;
}): number | null {
  const shortSide = Math.min(input.cropWidth, input.cropHeight);
  if (!(shortSide > 0)) return null;
  if (shortSide >= REGION_UPSCALE_TRIGGER_PX) return null;
  const longPageSide = Math.max(input.bitmapWidth, input.bitmapHeight);
  if (!(longPageSide > 0)) return null;
  const wanted = REGION_UPSCALE_TARGET_PX / shortSide;
  const cap = REGION_MAX_RERENDER_SIDE_PX / longPageSide;
  const multiplier = Math.min(wanted, cap);
  return multiplier > 1 ? multiplier : null;
}

// ---------------------------------------------------------------------------
// 裁剪（结构化 canvas 类型,测试注入记录型替身;真实 HTMLCanvasElement 满足）
// ---------------------------------------------------------------------------

export interface RegionCanvasContext {
  drawImage(
    source: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

export interface RegionCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): RegionCanvasContext | null;
}

/**
 * 从已渲染位图裁出选区（1:1 像素拷贝,不缩放）。canvas 工厂可注入
 * （jsdom 无真实 canvas）;无法取得 2d 上下文时返回 null,调用方放弃本次。
 */
export function cropRegionFromSource<T extends RegionCanvas>(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  rect: NormalizedRegionRect,
  createCanvas: (width: number, height: number) => T,
): T | null {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;
  const { sx, sy, sw, sh } = regionSourceRect(rect, sourceWidth, sourceHeight);
  const canvas = createCanvas(sw, sh);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

/** 下载文件名：`reade-引用-<标题>-p<N>.png`,非法文件名字符替换为 -。 */
export function regionCardFileName(title: string, page: number): string {
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || "文档";
  return `reade-引用-${safe}-p${page}.png`;
}
