/**
 * In-document find highlights via the CSS Custom Highlight API — same
 * non-mutating approach as read-aloud and deeplink (sentenceHighlight.ts).
 */

type HighlightLike = object;

type HighlightConstructorLike = new (...ranges: Range[]) => HighlightLike;

interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): unknown;
  delete(name: string): boolean;
}

function highlightRegistry(): HighlightRegistryLike | null {
  const cssNamespace = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  return cssNamespace?.highlights ?? null;
}

function highlightConstructor(): HighlightConstructorLike | null {
  const constructor = (globalThis as { Highlight?: unknown }).Highlight;
  return typeof constructor === "function"
    ? (constructor as HighlightConstructorLike)
    : null;
}

export const FIND_MATCH_HIGHLIGHT_NAME = "reade-find-match";
export const FIND_ACTIVE_HIGHLIGHT_NAME = "reade-find-active";

export function isFindHighlightSupported(): boolean {
  return highlightRegistry() !== null && highlightConstructor() !== null;
}

export function applyFindHighlights(ranges: readonly Range[], activeIndex: number): boolean {
  const registry = highlightRegistry();
  const HighlightImpl = highlightConstructor();
  if (!registry || !HighlightImpl) return false;

  const inactive = ranges.filter((_, index) => index !== activeIndex);
  const active = activeIndex >= 0 ? ranges[activeIndex] ?? null : null;

  if (inactive.length > 0) {
    registry.set(FIND_MATCH_HIGHLIGHT_NAME, new HighlightImpl(...inactive));
  } else {
    registry.delete(FIND_MATCH_HIGHLIGHT_NAME);
  }

  if (active) {
    registry.set(FIND_ACTIVE_HIGHLIGHT_NAME, new HighlightImpl(active));
  } else {
    registry.delete(FIND_ACTIVE_HIGHLIGHT_NAME);
  }

  return true;
}

export function clearFindHighlights(): void {
  const registry = highlightRegistry();
  if (!registry) return;
  registry.delete(FIND_MATCH_HIGHLIGHT_NAME);
  registry.delete(FIND_ACTIVE_HIGHLIGHT_NAME);
}
