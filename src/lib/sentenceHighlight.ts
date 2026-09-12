/**
 * Transient range highlight for Web paragraph deeplinks, built on the CSS
 * Custom Highlight API (zero DOM wrapping).
 *
 * The original TTS follow used `wrapRangeWithMark` + `clearAnnotationMarks`,
 * which mutated the React-owned reading DOM and could throw `NotFoundError`
 * on remount. Registering a `Highlight` paints the range without touching
 * a single DOM node. Styling lives in `::highlight(reade-deeplink)` (App.css);
 * only text-level properties apply there. Unsupported runtimes skip the
 * visual flash; scroll-to-range still works.
 */

// ---------------------------------------------------------------------------
// CSS Custom Highlight API access without widening the global type surface.
//
// The Highlight/HighlightRegistry types live in TS DOM libs newer than the
// repository's ES2020 baseline, so the API is reached through module-local
// structural types. Delete these once the TS lib target catches up.
// ---------------------------------------------------------------------------

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

/** The runtime offers `CSS.highlights` plus the `Highlight` constructor. */
export function isSentenceHighlightSupported(): boolean {
  return highlightRegistry() !== null && highlightConstructor() !== null;
}

/**
 * Registers `range` as the sole highlight under `name`, replacing any
 * previous registration. Returns false when the runtime lacks the API
 * (callers keep scroll-follow and simply lose the visual highlight).
 */
export function applySentenceHighlight(name: string, range: Range): boolean {
  const registry = highlightRegistry();
  const HighlightImpl = highlightConstructor();
  if (!registry || !HighlightImpl) return false;
  registry.set(name, new HighlightImpl(range));
  return true;
}

/** Removes the named highlight; safe to call when nothing is registered. */
export function clearSentenceHighlight(name: string): void {
  highlightRegistry()?.delete(name);
}
