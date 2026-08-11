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
