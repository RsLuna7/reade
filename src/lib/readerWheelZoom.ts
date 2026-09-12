/** Wheel-zoom step sizes aligned with the reading-settings slider and PDF toolbar. */

export const FONT_SIZE_MIN = 13;
export const FONT_SIZE_MAX = 26;
export const FONT_SIZE_STEP = 1;

export const PDF_SCALE_MIN = 1;
export const PDF_SCALE_MAX = 3;
export const PDF_SCALE_STEP = 0.1;
/** One mouse-wheel notch (pixel deltaY=120, or 3 LINE units) equals one toolbar step. */
export const PDF_SCALE_WHEEL_PIXELS_PER_STEP = 120;
/** Delay before pdf.js re-rasterizes after a CSS preview zoom burst.
 * Matches pdf.js `drawingDelay` so the canvas is not redrawn mid-gesture. */
export const PDF_SCALE_COMMIT_DELAY_MS = 400;

const DELTA_LINE = 1;
const DELTA_PAGE = 2;

export type WheelZoomDirection = -1 | 0 | 1;

export function wheelZoomDirection(deltaY: number): WheelZoomDirection {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  return deltaY < 0 ? 1 : -1;
}

export function adjustFontSize(current: number, direction: WheelZoomDirection): number {
  if (direction === 0) return current;
  const next = current + direction * FONT_SIZE_STEP;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, next));
}

export function adjustPdfScale(current: number, direction: WheelZoomDirection): number {
  if (direction === 0) return current;
  const next = Math.round((current + direction * PDF_SCALE_STEP) * 10) / 10;
  return Math.min(PDF_SCALE_MAX, Math.max(PDF_SCALE_MIN, next));
}

/** Normalize a Ctrl+wheel event to CSS pixels so trackpads and mice share one mapping. */
export function wheelZoomDeltaPixels(
  event: Pick<WheelEvent, "deltaY" | "deltaMode">,
): number {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return 0;
  if (event.deltaMode === DELTA_LINE) {
    return event.deltaY * (PDF_SCALE_WHEEL_PIXELS_PER_STEP / 3);
  }
  if (event.deltaMode === DELTA_PAGE) {
    return event.deltaY * PDF_SCALE_WHEEL_PIXELS_PER_STEP;
  }
  return event.deltaY;
}

/**
 * Multiplicative zoom like pdf.js `updateScale({ scaleFactor })`.
 * One 120px notch ≈ ×1.1 (the toolbar step), and smaller trackpad deltas stay continuous.
 */
export function adjustPdfScaleByDelta(current: number, deltaYPixels: number): number {
  if (!Number.isFinite(deltaYPixels) || deltaYPixels === 0) return clampPdfScale(current);
  const factor = Math.exp(
    (-deltaYPixels * Math.log(1 + PDF_SCALE_STEP)) / PDF_SCALE_WHEEL_PIXELS_PER_STEP,
  );
  return clampPdfScale(current * factor);
}

export function clampPdfScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(PDF_SCALE_MAX, Math.max(PDF_SCALE_MIN, value));
}

/** CSS zoom factor: layout scale over the last committed pdf.js render scale. */
export function pdfZoomPreviewFactor(layoutScale: number, renderScale: number): number {
  if (!(renderScale > 0) || !Number.isFinite(layoutScale) || !Number.isFinite(renderScale)) return 1;
  return layoutScale / renderScale;
}

export function isPdfZoomPreviewing(layoutScale: number, renderScale: number): boolean {
  return Math.abs(layoutScale - renderScale) > 0.0005;
}

export type PdfZoomOrigin = { x: number; y: number };

/** Layout width for a live CSS preview, matching pdf.js `--scale-factor`. */
export function pdfZoomLivePageWidth(nativePageWidth: number, layoutScale: number): number {
  const width = (Number.isFinite(nativePageWidth) && nativePageWidth > 0 ? nativePageWidth : 820) * layoutScale;
  if (!Number.isFinite(width) || width <= 0) return 820;
  return Math.round(width);
}

/**
 * pdf.js-style live zoom: write `--scale-factor` (here `--pdf-live-page-width`)
 * so page boxes grow and existing canvases CSS-stretch. Do not `transform` the
 * page stack — that promotes a document-tall compositor layer and janks.
 */
export function applyPdfZoomPreview(host: HTMLElement, factor: number, pageWidthPx: number): void {
  host.style.removeProperty("transform");
  host.style.removeProperty("transform-origin");
  if (!Number.isFinite(factor) || Math.abs(factor - 1) <= 0.0005) {
    host.style.removeProperty("--pdf-live-page-width");
    host.style.removeProperty("--pdf-preview-factor");
    delete host.dataset.zoomPreview;
    return;
  }
  const width = Number.isFinite(pageWidthPx) && pageWidthPx > 0 ? Math.round(pageWidthPx) : 820;
  host.style.setProperty("--pdf-live-page-width", `${width}px`);
  host.style.setProperty("--pdf-preview-factor", String(factor));
  host.dataset.zoomPreview = "true";
}

/**
 * Extra scroll to keep a client-space origin fixed after a uniform scale,
 * matching pdf.js `#setScaleUpdatePages` + `panBy` (scroll += offset * scaleDiff).
 */
export function pdfZoomKeepOriginScroll(
  previousScale: number,
  nextScale: number,
  originClientX: number,
  originClientY: number,
  containerLeft: number,
  containerTop: number,
): { left: number; top: number } {
  if (!(previousScale > 0) || !Number.isFinite(nextScale) || previousScale === nextScale) {
    return { left: 0, top: 0 };
  }
  const scaleDiff = nextScale / previousScale - 1;
  return {
    left: (originClientX - containerLeft) * scaleDiff,
    top: (originClientY - containerTop) * scaleDiff,
  };
}

export function pdfZoomOriginFromClient(
  host: HTMLElement,
  clientX: number | undefined,
  clientY: number | undefined,
): PdfZoomOrigin {
  const rect = host.getBoundingClientRect();
  const x = Number.isFinite(clientX) ? (clientX as number) - rect.left : rect.width / 2;
  const y = Number.isFinite(clientY) ? (clientY as number) - rect.top : Math.min(rect.height, 240);
  return { x, y };
}
