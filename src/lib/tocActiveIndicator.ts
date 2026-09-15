/** TOC 活动光标：测量与侧栏跟随（对齐 Claude docs 滑动指示器，色值走 --accent）。 */

import type { TocItem } from "./markdown";
import { resolvePdfTocId } from "./tocHeat";

export type TocIndicatorBox = {
  top: number;
  height: number;
};

const PDF_TOC_ID = /^pdf-page-(\d+)$/;

/**
 * 侧栏高亮 id：Markdown/EPUB 直配；PDF 按 Outline 页区间 floor，
 * 这样当前页不必恰好等于某个目录目标页，指示条才不会在章内或双页对上消失。
 */
export function resolveTocActiveId(
  items: TocItem[],
  activeId: string | null,
): string | null {
  if (!activeId) return null;
  const match = PDF_TOC_ID.exec(activeId);
  if (!match) return activeId;
  return resolvePdfTocId(items, Number.parseInt(match[1], 10));
}

/** 相对 wrap 的 top/height；无有效几何时返回 null（如 jsdom 零尺寸）。 */
export function measureTocIndicator(
  wrap: HTMLElement,
  link: HTMLElement,
): TocIndicatorBox | null {
  const wrapBox = wrap.getBoundingClientRect();
  const linkBox = link.getBoundingClientRect();
  if (linkBox.height <= 0) return null;
  return {
    top: linkBox.top - wrapBox.top,
    height: linkBox.height,
  };
}

const TOC_SCROLL_PAD = 32;

/**
 * 激活项贴近滚动容器上下边缘时，滚到中部。
 * behavior: off → auto；subtle/full → smooth。
 */
export function scrollTocLinkIntoView(
  scrollParent: HTMLElement,
  link: HTMLElement,
  behavior: ScrollBehavior = "auto",
): void {
  const parentBox = scrollParent.getBoundingClientRect();
  const linkBox = link.getBoundingClientRect();
  const above = linkBox.top < parentBox.top + TOC_SCROLL_PAD;
  const below = linkBox.bottom > parentBox.bottom - TOC_SCROLL_PAD;
  if (!above && !below) return;

  const delta =
    linkBox.top - parentBox.top - parentBox.height / 2 + linkBox.height / 2;
  if (typeof scrollParent.scrollBy === "function") {
    scrollParent.scrollBy({ top: delta, behavior });
    return;
  }
  scrollParent.scrollTop += delta;
}

export function tocScrollBehaviorFromMotion(
  motion: string | null | undefined,
): ScrollBehavior {
  return motion === "subtle" || motion === "full" ? "smooth" : "auto";
}

export function findTocScrollParent(from: HTMLElement): HTMLElement | null {
  return from.closest<HTMLElement>(".toc-panel, .toc-drawer");
}
