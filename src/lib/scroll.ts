/**
 * 竖排模式（plan-vertical-writing VW-D5）：滚动容器带
 * `data-writing="vertical"` 时坐标系是 RTL 横向（writing-mode:
 * vertical-rl 加在容器上），纵向 scrollTop 计算不再适用。
 */
function isVerticalContainer(container: HTMLElement): boolean {
  return container.dataset.writing === "vertical";
}

export function scrollElementWithinContainer(
  container: HTMLElement | null,
  target: HTMLElement | null,
  behavior: ScrollBehavior = "auto",
): boolean {
  if (!container || !target || !container.contains(target)) return false;

  if (isVerticalContainer(container)) {
    // block: "start" 在 vertical-rl 滚动盒里即右缘阅读起点;交给浏览器
    // 处理 RTL scrollLeft 的符号差异。
    target.scrollIntoView({ block: "start", inline: "nearest", behavior });
    return true;
  }

  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const scrollMarginTop = Number.parseFloat(
    window.getComputedStyle(target).scrollMarginTop,
  );
  const targetTop = Math.max(
    0,
    container.scrollTop + targetRect.top - containerRect.top -
      (Number.isFinite(scrollMarginTop) ? scrollMarginTop : 0),
  );

  if (behavior === "smooth" && typeof container.scrollTo === "function") {
    container.scrollTo({ top: targetTop, behavior });
  } else {
    container.scrollTop = targetTop;
  }
  return true;
}

/** Scroll so that `offsetRatio` within `target` aligns near the top of `container`. */
export function scrollToOffsetWithinElement(
  container: HTMLElement | null,
  target: HTMLElement | null,
  offsetRatio: number,
  behavior: ScrollBehavior = "auto",
): boolean {
  if (!container || !target || !container.contains(target)) return false;
  const ratio = Math.min(1, Math.max(0, Number.isFinite(offsetRatio) ? offsetRatio : 0));
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetTop =
    container.scrollTop + targetRect.top - containerRect.top + target.offsetHeight * ratio;
  const top = Math.max(0, targetTop);
  if (behavior === "smooth" && typeof container.scrollTo === "function") {
    container.scrollTo({ top, behavior });
  } else {
    container.scrollTop = top;
  }
  return true;
}

/** Scroll a Range into view within a reading container (horizontal or vertical). */
export function scrollRangeIntoContainer(
  container: HTMLElement | null,
  range: Range | null,
  behavior: ScrollBehavior = "auto",
): boolean {
  if (!container || !range) return false;
  if (isVerticalContainer(container)) {
    const node = range.startContainer;
    const element =
      node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: "start", inline: "nearest", behavior });
    return true;
  }
  let rangeRect: DOMRect | { top: number; left: number } | null = null;
  if (typeof range.getBoundingClientRect === "function") {
    rangeRect = range.getBoundingClientRect();
  } else {
    const node = range.startContainer;
    const element =
      node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
    if (element instanceof HTMLElement) {
      rangeRect = element.getBoundingClientRect();
    }
  }
  if (!rangeRect) return false;
  const containerRect = container.getBoundingClientRect();
  const top = Math.max(
    0,
    container.scrollTop + rangeRect.top - containerRect.top - container.clientHeight / 3,
  );
  if (behavior === "smooth" && typeof container.scrollTo === "function") {
    container.scrollTo({ top, behavior });
  } else {
    container.scrollTop = top;
  }
  return true;
}

export function scrollContainerByRatio(
  container: HTMLElement | null,
  scrollRatio: number,
  behavior: ScrollBehavior = "auto",
): boolean {
  if (!container) return false;
  const ratio = Math.min(1, Math.max(0, Number.isFinite(scrollRatio) ? scrollRatio : 0));
  if (isVerticalContainer(container)) {
    // vertical-rl 容器的规范 scrollLeft 范围是 [-max, 0](0 = 右缘起点)。
    const maxLeft = container.scrollWidth - container.clientWidth;
    const left = -Math.max(0, maxLeft * ratio);
    if (behavior === "smooth" && typeof container.scrollTo === "function") {
      container.scrollTo({ left, behavior });
    } else {
      container.scrollLeft = left;
    }
    return true;
  }
  const max = container.scrollHeight - container.clientHeight;
  const top = Math.max(0, max * ratio);
  if (behavior === "smooth" && typeof container.scrollTo === "function") {
    container.scrollTo({ top, behavior });
  } else {
    container.scrollTop = top;
  }
  return true;
}
