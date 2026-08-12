export function scrollElementWithinContainer(
  container: HTMLElement | null,
  target: HTMLElement | null,
  behavior: ScrollBehavior = "auto",
): boolean {
  if (!container || !target || !container.contains(target)) return false;

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

export function scrollContainerByRatio(
  container: HTMLElement | null,
  scrollRatio: number,
  behavior: ScrollBehavior = "auto",
): boolean {
  if (!container) return false;
  const ratio = Math.min(1, Math.max(0, Number.isFinite(scrollRatio) ? scrollRatio : 0));
  const max = container.scrollHeight - container.clientHeight;
  const top = Math.max(0, max * ratio);
  if (behavior === "smooth" && typeof container.scrollTo === "function") {
    container.scrollTo({ top, behavior });
  } else {
    container.scrollTop = top;
  }
  return true;
}
