import type { EpubAsset } from "./backend";
import type { ReadingPosition } from "./readingPositions";

/**
 * 书架自动封面的纯函数层（docs/plan-bookshelf-covers.md §3.3）。
 *
 * - `generatedCover(title)`：FNV-1a 哈希 → 8 组主题 token 渐变预设中确定性
 *   取一组（同标题恒同色；色值全部引用 CSS 变量，随四系列 × 明暗自动变化）。
 * - `pickEpubCoverAsset(assets)`：从 EPUB 资产清单挑封面候选——优先路径含
 *   "cover" 的合法 raster，其次首个合法 raster，否则 null（回落生成式）。
 * - 缩略图尺寸/字节约束与 Rust 侧 `store_document_thumbnail` 的校验同源。
 */

/** 与 Rust `THUMBNAIL_MAX_PNG_BYTES` 同源：解码后 PNG 字节上限。 */
export const THUMBNAIL_MAX_PNG_BYTES = 512 * 1024;
/** 与 Rust `THUMBNAIL_MAX_DIMENSION` 同源：单边像素上限。 */
export const THUMBNAIL_MAX_DIMENSION = 640;
/** 封面目标逻辑尺寸（3:4 书形）；物理尺寸 = 逻辑 × min(DPR, 2)。 */
export const THUMBNAIL_TARGET_WIDTH = 240;
export const THUMBNAIL_TARGET_HEIGHT = 320;

export interface GeneratedCover {
  /** CSS 渐变起止色（color-mix over 主题 token，主题切换自动跟随）。 */
  from: string;
  to: string;
  /** 渐变角度（度）。 */
  angle: number;
  /** 封面大字：标题首个非空白字符（无则 "□"）。 */
  initial: string;
  /** 命中的预设序号（测试锚定分布用）。 */
  paletteIndex: number;
}

/**
 * 8 组渐变预设：均由主题 token 派生（AGENTS 17-token 契约内），不引入
 * 新 token。顺序即 paletteIndex。
 */
export const COVER_PALETTES: ReadonlyArray<readonly [string, string]> = [
  ["color-mix(in srgb, var(--accent) 72%, var(--paper))", "color-mix(in srgb, var(--accent) 28%, var(--paper))"],
  ["color-mix(in srgb, var(--teal) 78%, var(--paper))", "color-mix(in srgb, var(--teal) 30%, var(--paper))"],
  ["color-mix(in srgb, var(--accent-ink) 66%, var(--paper))", "color-mix(in srgb, var(--accent) 34%, var(--paper))"],
  ["color-mix(in srgb, var(--ink-soft) 62%, var(--paper))", "color-mix(in srgb, var(--chrome-strong) 80%, var(--paper))"],
  ["color-mix(in srgb, var(--teal) 55%, var(--accent))", "color-mix(in srgb, var(--teal) 22%, var(--paper))"],
  ["color-mix(in srgb, var(--accent) 46%, var(--teal))", "color-mix(in srgb, var(--accent) 18%, var(--paper))"],
  ["color-mix(in srgb, var(--muted) 70%, var(--paper))", "color-mix(in srgb, var(--accent-soft) 85%, var(--paper))"],
  ["color-mix(in srgb, var(--accent-ink) 58%, var(--ink))", "color-mix(in srgb, var(--teal-soft) 88%, var(--paper))"],
];

const COVER_ANGLES = [135, 150, 120, 160] as const;

/** FNV-1a 32 位哈希（确定性、零依赖；>>> 0 保持无符号）。 */
export function fnv1aHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 标题哈希 → 确定性生成式封面（Markdown 与一切回落场景）。 */
export function generatedCover(title: string): GeneratedCover {
  const normalized = title.trim();
  const hash = fnv1aHash(normalized || "untitled");
  const paletteIndex = hash % COVER_PALETTES.length;
  const [from, to] = COVER_PALETTES[paletteIndex];
  const angle = COVER_ANGLES[(hash >>> 3) % COVER_ANGLES.length];
  const initial = normalized ? Array.from(normalized)[0].toUpperCase() : "□";
  return { from, to, angle, initial, paletteIndex };
}

/**
 * EPUB 封面候选（BC-D3 定稿）：只在合法（allowed=true 的 raster）资产中挑，
 * 优先 alt（资产在书内的路径）含 "cover" 的条目，否则第一个合法资产；
 * 没有合法资产返回 null，由调用方回落生成式封面。
 */
export function pickEpubCoverAsset(assets: ReadonlyArray<EpubAsset>): EpubAsset | null {
  const allowed = assets.filter((asset) => asset.allowed);
  if (allowed.length === 0) return null;
  const named = allowed.find((asset) => asset.alt.toLowerCase().includes("cover"));
  return named ?? allowed[0];
}

/**
 * 缩略图物理尺寸：目标 240×320 逻辑像素 × min(DPR, 2)，等比缩放源图并
 * clamp 到单边 ≤ 640（与 Rust 校验同源）。返回整数像素。
 */
export function thumbnailDimensions(
  sourceWidth: number,
  sourceHeight: number,
  devicePixelRatio = 1,
): { width: number; height: number } | null {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) return null;
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;
  const scaleCap = Math.max(1, Math.min(devicePixelRatio, 2));
  const targetWidth = THUMBNAIL_TARGET_WIDTH * scaleCap;
  const targetHeight = THUMBNAIL_TARGET_HEIGHT * scaleCap;
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight, 1);
  const width = Math.min(THUMBNAIL_MAX_DIMENSION, Math.max(1, Math.round(sourceWidth * scale)));
  const height = Math.min(THUMBNAIL_MAX_DIMENSION, Math.max(1, Math.round(sourceHeight * scale)));
  return { width, height };
}

/**
 * 书架进度角标文案：scroll 类取高水位百分比（<1% 视为未读不显示），
 * PDF 有页数（extents.segmentCount）折算百分比，无页数退化为"第 N 页"。
 */
export function shelfProgressLabel(
  position: ReadingPosition | null | undefined,
  segmentCount?: number | null,
): string | null {
  if (!position) return null;
  if (position.kind === "scroll") {
    const percent = Math.round(Math.min(1, Math.max(0, position.maxScrollRatio)) * 100);
    return percent >= 1 ? `${percent}%` : null;
  }
  if (typeof segmentCount === "number" && Number.isFinite(segmentCount) && segmentCount > 0) {
    const percent = Math.round(Math.min(1, position.maxPage / segmentCount) * 100);
    return percent >= 1 ? `${percent}%` : null;
  }
  return `第 ${position.maxPage} 页`;
}

/**
 * data URL → 存储用 base64（去掉 `data:image/png;base64,` 前缀）；
 * 非 PNG data URL 返回 null。字节数估算 = base64 长度 × 3/4。
 */
export function pngBase64FromDataUrl(dataUrl: string): string | null {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) return null;
  const base64 = dataUrl.slice(prefix.length);
  if (!base64) return null;
  if ((base64.length * 3) / 4 > THUMBNAIL_MAX_PNG_BYTES) return null;
  return base64;
}
