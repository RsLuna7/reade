/**
 * Transient sentence highlight for read-aloud follow, built on the CSS
 * Custom Highlight API (docs/plan-read-aloud.md RA-D3, revised).
 *
 * The original mechanism (`wrapRangeWithMark` + `clearAnnotationMarks`)
 * mutated the React-owned reading DOM: fully covered text nodes were moved
 * inside `<mark>` elements and `Node.normalize()` merged React-held text
 * nodes away. The sentence-progress state update that follows every
 * sentence re-renders the app, and `MarkdownRenderer` rebuilds its
 * `components` map per render, so React remounts customized elements
 * (`<a>`, `<code>`, …) via `removeChild` + `insertBefore`. When the
 * insertion reference was one of the text nodes the mark had displaced,
 * `insertBefore` threw `NotFoundError` and React unmounted the whole tree
 * (P1 white-screen crash). Registering a `Highlight` paints the sentence
 * without touching a single DOM node, so React reconciliation cannot
 * conflict with the follow highlight by construction.
 *
 * Feature detection: Chromium/WebView2 ≥ 105 ship the API, covering both
 * Reade runtimes. Where it is missing (older Firefox, jsdom) the caller
 * degrades to scroll-follow without visual highlight — never back to DOM
 * wrapping. Styling lives in `::highlight(reade-tts-active)` (App.css);
 * only text-level properties (background/text color etc.) apply there.
 */

// ---------------------------------------------------------------------------
// CSS Custom Highlight API access without widening the global type surface.
//
// The Highlight/HighlightRegistry types live in TS DOM libs newer than the
// repository's ES2020 baseline, so the API is reached through module-local
// structural types (same pattern as the Intl.Segmenter declaration in
// ttsSegments.ts). Delete these once the TS lib target catches up.
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
