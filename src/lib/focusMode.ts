/**
 * 聚焦模式纯逻辑（plan-focus-mode）：当前块判定、打字机吸附目标与
 * 标尺带高。DOM 测量与事件接线在 useFocusMode.ts / ReadingRuler.tsx；
 * 块收集与 auto-pace 共用。
 */

/** 可读内容形态；PDF 原版式无段落 DOM，调用方传 null。 */
export type FocusContentKind = "markdown" | "epub" | "pdf-reading";

/**
 * 顶层块容器选择器（plan-focus-mode 定稿 §6.1）：容器的元素子级即
 * 聚焦 / 自动推进候选块。
 */
export const FOCUS_CONTAINER_SELECTORS: Record<FocusContentKind, string> = {
  markdown: ".annotated-markdown > .markdown-body",
  epub: ".epub-chapter",
  "pdf-reading": ".pdf-reading-page > .markdown-body",
};

/** 容器标记：spotlight CSS 用；auto-pace 收集时可一并写入。 */
export const FOCUS_CONTAINER_ATTR = "data-focus-container";

/**
 * 收集 article 内给定形态的顶层块。可选写入容器 attr（spotlight 样式依赖）。
 */
export function collectFocusBlocks(
  article: HTMLElement,
  kind: FocusContentKind,
  options?: { markContainers?: boolean },
): HTMLElement[] {
  const selector = FOCUS_CONTAINER_SELECTORS[kind];
  const blocks: HTMLElement[] = [];
  for (const container of Array.from(article.querySelectorAll<HTMLElement>(selector))) {
    if (options?.markContainers) {
      container.setAttribute(FOCUS_CONTAINER_ATTR, "true");
    }
    for (const child of Array.from(container.children)) {
      if (!(child instanceof HTMLElement)) continue;
      blocks.push(child);
    }
  }
  return blocks;
}

/** 参考线位置：视口高的 45%（FM-D2，聚焦要居中偏上）。 */
export const FOCUS_ANCHOR_RATIO = 0.45;
/** 打字机滚动静止判定：最后一次滚动事件后 160ms 吸附。 */
export const TYPEWRITER_SETTLE_MS = 160;
/**
 * 武装窗口：滚动事件距最近一次 wheel/导航键 ≤500ms 才算“用户导航滚动”。
 * 吸附自身触发的 scroll、以及位置恢复等程序化滚动都落在窗口外。
 */
export const TYPEWRITER_ARM_WINDOW_MS = 500;
/** 吸附距离小于该值时不动，避免像素级拉扯感。 */
export const TYPEWRITER_MIN_DELTA_PX = 4;

export interface FocusBlockRect {
  top: number;
  bottom: number;
}

/** 视口坐标系里的参考线（视口 top + 45% 高）。 */
export function focusReferenceLine(viewportTop: number, viewportHeight: number): number {
  return viewportTop + viewportHeight * FOCUS_ANCHOR_RATIO;
}

/**
 * 距参考线最近的块索引：包含参考线者距离为 0；并列取更靠前的块
 * （阅读顺序在前）；退化矩形（bottom ≤ top）跳过；空集返回 null。
 */
export function selectFocusIndex(
  blocks: readonly FocusBlockRect[],
  referenceLine: number,
): number | null {
  let selected: { index: number; distance: number } | null = null;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!Number.isFinite(block.top) || !Number.isFinite(block.bottom)) continue;
    if (block.bottom <= block.top) continue;
    const distance =
      block.top <= referenceLine && block.bottom >= referenceLine
        ? 0
        : Math.min(
            Math.abs(block.top - referenceLine),
            Math.abs(block.bottom - referenceLine),
          );
    if (!selected || distance < selected.distance) {
      selected = { index, distance };
    }
  }
  return selected?.index ?? null;
}

/**
 * 打字机吸附目标 scrollTop：把块的中线对到参考线上。只钳下界 0，
 * 上界由滚动容器自身钳制（scrollTo 超出范围会被浏览器收敛）。
 */
export function typewriterScrollTop(input: {
  scrollTop: number;
  /** 块在视口坐标系的 top。 */
  blockTop: number;
  blockHeight: number;
  viewportTop: number;
  viewportHeight: number;
}): number {
  const blockCenter = input.blockTop + input.blockHeight / 2;
  const reference = focusReferenceLine(input.viewportTop, input.viewportHeight);
  return Math.max(0, input.scrollTop + blockCenter - reference);
}

/** 标尺带高 = 字号 × 行高，四舍五入并钳在 [12, 120]px。 */
export function rulerBandHeight(fontSize: number, lineHeight: number): number {
  const raw = fontSize * lineHeight;
  if (!Number.isFinite(raw) || raw <= 0) return 12;
  return Math.min(120, Math.max(12, Math.round(raw)));
}
