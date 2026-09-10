/** A bounded, disposable bitmap for one wheel gesture. No PDF/IPC work here. */
export const PDF_PREVIEW_MAX_PIXELS = 4 * 1024 * 1024;
export const PDF_PREVIEW_MAX_PAGES = 16;

export interface PreviewRect { left: number; top: number; right: number; bottom: number }

/** Inverse-project the viewport: shrinking must never expose uncaptured pixels. */
export function previewCoversViewport(
  capture: PreviewRect, viewport: PreviewRect, origin: { x: number; y: number }, factor: number,
): boolean {
  if (!Number.isFinite(factor) || factor <= 0) return false;
  return origin.x + (viewport.left - origin.x) / factor >= capture.left - 0.5 &&
    origin.x + (viewport.right - origin.x) / factor <= capture.right + 0.5 &&
    origin.y + (viewport.top - origin.y) / factor >= capture.top - 0.5 &&
    origin.y + (viewport.bottom - origin.y) / factor <= capture.bottom + 0.5;
}

export function previewPixelRatio(width: number, height: number, dpr: number): number {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width * height)) return 0;
  return Math.min(Math.max(1, Number.isFinite(dpr) ? dpr : 1), 1.5,
    Math.sqrt(PDF_PREVIEW_MAX_PIXELS / (width * height)));
}

export interface PdfZoomPreview {
  paint: (factor: number) => boolean;
  dispose: () => void;
}

export function createPdfZoomPreview(
  pages: HTMLElement, scroller: HTMLElement, toolbar: HTMLElement | null, referenceY?: number,
): PdfZoomPreview | null {
  const view = scroller.getBoundingClientRect();
  const viewport = {
    left: view.left + scroller.clientLeft,
    right: view.left + scroller.clientLeft + scroller.clientWidth,
    top: Math.max(view.top + scroller.clientTop, toolbar?.getBoundingClientRect().bottom ?? view.top),
    bottom: view.top + scroller.clientTop + scroller.clientHeight,
  };
  const width = viewport.right - viewport.left;
  const height = viewport.bottom - viewport.top;
  if (!(width > 0) || !(height > 0)) return null;
  const origin = {
    x: (viewport.left + viewport.right) / 2,
    y: Math.max(viewport.top, Math.min(viewport.bottom, referenceY ?? viewport.top + 8)),
  };
  const stack = pages.getBoundingClientRect();
  const scroll = { top: scroller.scrollTop, left: scroller.scrollLeft,
    maxTop: scroller.scrollHeight - scroller.clientHeight,
    maxLeft: scroller.scrollWidth - scroller.clientWidth };
  // One viewport of vertical overscan and half a viewport horizontally.
  const capture = { left: viewport.left - width / 2, right: viewport.right + width / 2,
    top: viewport.top - height, bottom: viewport.bottom + height };
  const candidates: Array<{ rect: DOMRect; canvas: HTMLCanvasElement }> = [];
  const pageNodes = pages.querySelectorAll<HTMLElement>(".pdf-page");
  // Page rows are ordered vertically in both single and spread layouts. Locate
  // the first row in logarithmic time; include both pages of the preceding row.
  let low = 0, high = pageNodes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (pageNodes[middle].getBoundingClientRect().top < capture.top) low = middle + 1;
    else high = middle;
  }
  for (let index = Math.max(0, low - 2); index < pageNodes.length; index++) {
    const page = pageNodes[index];
    const rect = page.getBoundingClientRect();
    if (rect.top >= capture.bottom) break;
    if (rect.bottom <= capture.top ||
        rect.right <= capture.left || rect.left >= capture.right) continue;
    const canvas = page.querySelector<HTMLCanvasElement>("canvas[data-pdf-rendered]");
    // Trim unavailable neighbors out of the coverage, but reject missing visible pages.
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      if (rect.bottom <= viewport.top) capture.top = Math.max(capture.top, rect.bottom);
      else if (rect.top >= viewport.bottom) capture.bottom = Math.min(capture.bottom, rect.top);
      else return null;
      continue;
    }
    candidates.push({ rect, canvas });
    if (candidates.length > PDF_PREVIEW_MAX_PAGES) return null;
  }
  if (!candidates.length) return null;
  const captureWidth = capture.right - capture.left;
  const captureHeight = capture.bottom - capture.top;
  const ratio = previewPixelRatio(captureWidth, captureHeight, window.devicePixelRatio);
  if (!ratio) return null;
  const bitmap = document.createElement("canvas");
  bitmap.width = Math.floor(captureWidth * ratio);
  bitmap.height = Math.floor(captureHeight * ratio);
  const context = bitmap.getContext("2d");
  if (!context) return null;
  context.scale(ratio, ratio);
  context.fillStyle = getComputedStyle(scroller).getPropertyValue("--paper").trim() || "#ffffff";
  context.fillRect(0, 0, captureWidth, captureHeight);
  try {
    for (const { rect, canvas } of candidates) {
      context.drawImage(canvas, rect.left - capture.left, rect.top - capture.top, rect.width, rect.height);
    }
  } catch {
    bitmap.width = bitmap.height = 0;
    return null;
  }
  const overlay = document.createElement("div");
  overlay.className = "pdf-zoom-bitmap-overlay";
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, { left: `${viewport.left}px`, top: `${viewport.top}px`,
    width: `${width}px`, height: `${height}px` });
  Object.assign(bitmap.style, { position: "absolute", left: `${capture.left - viewport.left}px`,
    top: `${capture.top - viewport.top}px`, width: `${captureWidth}px`, height: `${captureHeight}px`,
    transformOrigin: `${origin.x - capture.left}px ${origin.y - capture.top}px`, willChange: "transform" });
  overlay.append(bitmap);
  document.body.append(overlay);
  pages.dataset.bitmapPreview = "true";
  pages.dataset.zoomPreview = "true";
  let disposed = false;
  return {
    paint(factor) {
      if (disposed || !Number.isFinite(factor) || factor <= 0) return false;
      // Match scroll clamping at the first/last page rather than snapping on commit.
      const wantedTop = scroll.top + (origin.y - stack.top) * (factor - 1);
      const maxTop = Math.max(0, scroll.maxTop + stack.height * (factor - 1));
      const dy = wantedTop - Math.max(0, Math.min(maxTop, wantedTop));
      const wantedLeft = scroll.left + (origin.x - stack.left) * (factor - 1);
      const maxLeft = Math.max(0, scroll.maxLeft + stack.width * (factor - 1));
      const dx = stack.width * factor <= width
        ? origin.x - (origin.x + (stack.left + stack.width / 2 - origin.x) * factor)
        : wantedLeft - Math.max(0, Math.min(maxLeft, wantedLeft));
      if (!previewCoversViewport(capture, {left:viewport.left-dx,right:viewport.right-dx,
        top:viewport.top-dy,bottom:viewport.bottom-dy}, origin, factor)) return false;
      bitmap.style.transform = `translate(${dx}px, ${dy}px) scale(${factor})`;
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      overlay.remove();
      bitmap.width = bitmap.height = 0;
      delete pages.dataset.bitmapPreview;
      delete pages.dataset.zoomPreview;
    },
  };
}
