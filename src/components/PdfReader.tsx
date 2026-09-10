import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { BookOpen, ChevronLeft, ChevronRight, Columns3, Crop, FileText, Minus, Plus, ScanSearch } from "lucide-react";
import { AnnotationMode, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer, getDocument, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import { openExternalLink, readDocumentRange, readPdfReadingMode, type Annotation, type IndexStatus, type PdfReadingMode, type SearchLocator } from "../lib/backend";
import {
  buildTextIndex,
  clearAnnotationMarks,
  isAnnotationMarkKind,
  paintTextQuoteMarks,
  pdfHighlightPaintDecision,
  resolvePdfHighlightRects,
  type TextIndex,
  type TextQuoteMarkInput,
} from "../lib/annotations";
import type { AnchorResolution } from "../lib/annotationModel";
import type { TocItem } from "../lib/markdown";
import {
  adjustPdfScale,
  adjustPdfScaleByDelta,
  applyPdfZoomPreview,
  clampPdfScale,
  isPdfZoomPreviewing,
  PDF_SCALE_COMMIT_DELAY_MS,
  pdfZoomLivePageWidth,
  pdfZoomPreviewFactor,
  wheelZoomDeltaPixels,
  type WheelZoomDirection,
} from "../lib/readerWheelZoom";
import { setScrollInstant } from "../lib/scroll";
import { createPdfZoomPreview, type PdfZoomPreview } from "../lib/pdfZoomPreview";
import { PdfRenderQueue, pdfRasterPixelRatio } from "../lib/pdfRenderQueue";
import { cancelMotion, runMotion, type ReaderMotionLevel } from "../lib/motion";
import {
  cropRegionFromSource,
  normalizeRegionRect,
  planRegionUpscale,
  regionSourceRect,
  type NormalizedRegionRect,
  type RegionPoint,
} from "../lib/pdfRegion";
// 双页对开(plan-pdf-spread):配对/步长/适宽/可用性纯函数在 lib。
import {
  SPREAD_RENDER_MARGIN,
  canSpread,
  nextSpreadPage,
  previousSpreadPage,
  singleFitScale,
  spreadFitScale,
} from "../lib/pdfSpread";
import {
  deletePdfPageOffset,
  displayPageNumber,
  effectiveOffset,
  isValidCalibration,
  offsetFromCalibration,
  pageInputAriaLabel,
  physicalFromPrinted,
  printedFromPhysical,
  readPdfPageOffset,
  subscribePdfPageOffsets,
  writePdfPageOffset,
} from "../lib/pdfPageOffset";
import {
  PDF_PAGE_PIN_SLOTS,
  clearPinSlot,
  digitSlotIndex,
  emptyPdfPagePins,
  pinChipLabel,
  pinChipTitle,
  readPdfPagePins,
  subscribePdfPagePins,
  togglePinSlot,
  writePdfPagePins,
  type PdfPagePinSlots,
} from "../lib/pdfPagePins";
import { MarkdownRenderer } from "./MarkdownRenderer";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();
const RANGE_CHUNK = 256 * 1024;
const MAX_RANGE_CHUNK = 4 * 1024 * 1024;
/** D06 内部常量（计划 §4 D06.5）：Range 并发上限与单请求超时，可测。 */
const RANGE_CONCURRENCY_LIMIT = 4;
const RANGE_REQUEST_TIMEOUT_MS = 15_000;
const PAGE_RENDER_MARGIN = "1200px 0px";
const PAGE_REFERENCE_GAP = 8;
/** 双页意图的会话级记忆(PS-D3):同 SecondaryPane scrollMemory 模式。 */
const spreadMemory = new Map<string, boolean>();
/** A2 快翻步长:会话级,不写 reader preferences。 */
const STRIDE_OPTIONS = [5, 10, 20] as const;
type PdfStride = (typeof STRIDE_OPTIONS)[number];
const DEFAULT_STRIDE: PdfStride = 10;

function cyclePdfStride(current: number): PdfStride {
  const index = STRIDE_OPTIONS.indexOf(current as PdfStride);
  return STRIDE_OPTIONS[(index < 0 ? 0 : index + 1) % STRIDE_OPTIONS.length];
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable)
  );
}

class ReadeRangeTransport extends PDFDataRangeTransport {
  private aborted = false;
  private readonly queue: Array<{ begin: number; end: number }> = [];
  private inFlight = 0;

  constructor(
    private readonly path: string,
    length: number,
    private readonly onError: (cause: unknown) => void,
  ) {
    super(length, null, false);
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.aborted) return;
    this.queue.push({ begin, end });
    this.pump();
  }

  override abort(): void {
    this.aborted = true;
    this.queue.length = 0;
  }

  /**
   * Bounded-concurrency range pump (D06): at most RANGE_CONCURRENCY_LIMIT
   * IPC reads run at once, each with a hard timeout, so a stalled backend
   * read can never hang the viewer silently. A failure aborts the transport
   * and surfaces a retryable error through `onError` — PDF.js has no public
   * error channel on PDFDataRangeTransport, so the reader tears the session
   * down via loadingTask.destroy() when it fires.
   */
  private pump(): void {
    while (!this.aborted && this.inFlight < RANGE_CONCURRENCY_LIMIT && this.queue.length > 0) {
      const request = this.queue.shift();
      if (!request) return;
      this.inFlight += 1;
      const { begin, end } = request;
      const length = Math.min(end - begin, MAX_RANGE_CHUNK);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`PDF range request timed out after ${RANGE_REQUEST_TIMEOUT_MS} ms`)),
          RANGE_REQUEST_TIMEOUT_MS,
        );
      });
      void Promise.race([readDocumentRange(this.path, begin, length), timeout])
        .then((bytes) => {
          if (!this.aborted) this.onDataRange(begin, bytes);
        })
        .catch((cause: unknown) => {
          if (this.aborted) return;
          // Stop new requests first, then fail the session: the component
          // destroys the loading task and shows a retryable error.
          this.abort();
          this.onError(cause);
        })
        .finally(() => {
          if (timer !== undefined) clearTimeout(timer);
          this.inFlight -= 1;
          this.pump();
        });
    }
  }
}

export interface PdfPagePosition {
  page: number;
  offsetRatio: number;
}

export type PdfOutlineNode = {
  title?: string;
  page: number;
  items?: PdfOutlineNode[];
};

/** Flattens a nested PDF outline into TOC items with Markdown-like indentation levels. */
export function flattenPdfOutline(items: PdfOutlineNode[], level = 1): TocItem[] {
  const result: TocItem[] = [];
  const visit = (nodes: PdfOutlineNode[], depth: number) => {
    for (const node of nodes) {
      const page = Math.max(1, Math.round(Number.isFinite(node.page) ? node.page : 1));
      result.push({
        id: `pdf-page-${page}`,
        title: node.title?.trim() || `第 ${page} 页`,
        level: Math.min(6, Math.max(1, depth)),
      });
      if (node.items?.length) visit(node.items, Math.min(6, depth + 1));
    }
  };
  visit(items, level);
  return result;
}

export interface PdfPageMeasurement {
  page: number;
  top: number;
  bottom: number;
}

/**
 * pdf.js text layer CSS contract: the page element must define
 * `--total-scale-factor` such that `factor × rawDims.pageWidth/Height` equals
 * the text layer's CSS size. Span positions are percentages, but every span's
 * `font-size` is `calc(--total-scale-factor × --font-height)`; without the
 * variable the calc is invalid and all spans silently inherit ~16px.
 *
 * The factor derives from the measured page-box width rather than
 * `viewport.width` so a page that is not at its render-viewport CSS size
 * (window resize, ancestor zoom preview) still paints the text layer on
 * the glyphs. Dividing by `scale × userUnit` recovers the rotated page
 * width in PDF units, so the same formula holds for `/Rotate 90/270` pages.
 */
export function computePdfTotalScaleFactor(
  measuredCssWidth: number,
  viewport: { width: number; scale: number; userUnit: number },
): number | null {
  const nativeRotatedWidth = viewport.width / (viewport.scale * viewport.userUnit);
  if (!Number.isFinite(measuredCssWidth) || measuredCssWidth <= 0) return null;
  if (!Number.isFinite(nativeRotatedWidth) || nativeRotatedWidth <= 0) return null;
  return measuredCssWidth / nativeRotatedWidth;
}

/**
 * Session-local cancellation registry. Deactivation is synchronous so every
 * page render/text task is stopped before PDF.js destroys its document proxy.
 */
export class PdfSessionLifecycle {
  readonly renderQueue = new PdfRenderQueue();
  private active = true;
  private readonly pageTaskCancellations = new Set<() => void>();

  constructor(
    readonly generation: number,
    readonly sourceKey: string,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  registerPageTask(cancel: () => void): () => void {
    if (!this.active) {
      cancel();
      return () => undefined;
    }
    this.pageTaskCancellations.add(cancel);
    return () => this.pageTaskCancellations.delete(cancel);
  }

  deactivateAndCancelPages(): boolean {
    if (!this.active) return false;
    this.active = false;
    const cancellations = Array.from(this.pageTaskCancellations);
    this.pageTaskCancellations.clear();
    for (const cancel of cancellations) {
      try {
        cancel();
      } catch {
        // One malformed task must not prevent the remaining tasks or the
        // document loading task from being disposed.
      }
    }
    return true;
  }
}

export async function disposePdfSession(
  lifecycle: PdfSessionLifecycle,
  abortTransport: () => void,
  destroyDocument: () => void | Promise<void>,
): Promise<void> {
  if (!lifecycle.deactivateAndCancelPages()) return;
  abortTransport();
  await destroyDocument();
}

export function selectCurrentPdfPage(
  pages: PdfPageMeasurement[],
  referenceLine: number,
  viewportTop: number,
  viewportBottom: number,
): number | null {
  let selected: { page: number; distance: number } | null = null;
  for (const page of pages) {
    if (page.bottom <= viewportTop || page.top >= viewportBottom || page.bottom <= page.top) continue;
    const distance = page.top <= referenceLine && page.bottom >= referenceLine
      ? 0
      : Math.min(Math.abs(page.top - referenceLine), Math.abs(page.bottom - referenceLine));
    if (!selected || distance < selected.distance || (distance === selected.distance && page.page < selected.page)) {
      selected = { page: page.page, distance };
    }
  }
  return selected?.page ?? null;
}

export function capturePdfPagePosition(
  page: number,
  pageTop: number,
  pageHeight: number,
  referenceLine: number,
): PdfPagePosition {
  const offsetRatio = pageHeight <= 0
    ? 0
    : Math.min(1, Math.max(0, (referenceLine - pageTop) / pageHeight));
  return { page, offsetRatio };
}

export function calculatePdfRestoreScrollTop(
  currentScrollTop: number,
  pageTop: number,
  pageHeight: number,
  referenceLine: number,
  offsetRatio: number,
): number {
  const ratio = Math.min(1, Math.max(0, offsetRatio));
  return Math.max(0, currentScrollTop + pageTop + pageHeight * ratio - referenceLine);
}

export interface PdfReaderHandle {
  getPosition: () => PdfPagePosition | null;
  getMode: () => "original" | "reading";
  setMode: (mode: "original" | "reading") => void;
  restorePosition: (position: PdfPagePosition) => boolean;
  jumpToPage: (physicalPage: number) => void;
  openPageCalibration: () => void;
  adjustScale: (direction: WheelZoomDirection) => void;
  zoomByWheel: (deltaY: number, deltaMode?: number, clientX?: number, clientY?: number) => void;
}

interface PdfReaderProps {
  relativePath: string;
  size: number;
  modified: number;
  indexStatus: IndexStatus;
  indexError: string | null;
  locator: SearchLocator | null;
  motionLevel: ReaderMotionLevel;
  annotations?: Annotation[];
  /** Enables the fuzzy last-resort anchoring step (global preference). */
  fuzzyAnchoring?: boolean;
  readerRef?: React.MutableRefObject<PdfReaderHandle | null>;
  /** 区域引用出卡回调(plan-pdf-region-card):不传则不渲染"截取引用"钮。 */
  onRegionCard?: (capture: PdfRegionCapture) => void;
  /** 视图模式外报(plan-focus-mode FM-D4):原版式禁用聚焦模式。 */
  onModeChange?: (mode: "original" | "reading") => void;
  /** A1: 书库根路径,用于读写印刷页校正;副栏同样传入以共享 offset。 */
  libraryRoot?: string;
  /** A2: 仅主栏在无 dialog 时为 true;副栏不传(默认 false)。 */
  keyboardActive?: boolean;
  /** A3: 已记录的最远文件页;有传才渲染「主线」钮。 */
  frontierPage?: number | null;
  /** A3: 主线跳转前记录回退栈;页码框/标定/A/D 不调用。 */
  onIntentionalJump?: () => void;
  /** A3: 将高水位重设为当前文件页。 */
  onResetFrontier?: (physicalPage: number) => void;
  /** B2: 把当前文件页钉到副栏；不传则不渲染「锁页」钮。 */
  onPinToSecondary?: (physicalPage: number) => void;
  onBrokenAnnotationsChange?: (ids: string[]) => void;
  onApproximateAnnotationsChange?: (ids: string[]) => void;
  onGeometricFallbackChange?: (ids: string[]) => void;
  onTocChange: (items: TocItem[]) => void;
  onActiveChange: (id: string | null) => void;
}

interface LoadedPdfSession {
  sourceKey: string;
  pdf: PDFDocumentProxy;
  lifecycle: PdfSessionLifecycle;
}

interface BoundReadingMode {
  sourceKey: string;
  document: PdfReadingMode;
}

interface BoundError {
  sourceKey: string;
  message: string;
  /** D06: 数据读取失败可以重建会话重试；密码等硬错误不可。 */
  retryable?: boolean;
}

/** 框选结果:裁剪位图 + 页号(出处行"第 N 页"),即用即走不落库(RG-D2)。 */
export interface PdfRegionCapture {
  canvas: HTMLCanvasElement;
  page: number;
}

interface PageProps {
  session: LoadedPdfSession;
  pageNumber: number;
  scale: number;
  initialRatio: number;
  highlights: Annotation[];
  fuzzyAnchoring: boolean;
  /** "截取引用"模式(plan-pdf-region-card):已渲染页挂框选层。 */
  regionActive?: boolean;
  /** 懒渲染窗口(plan-pdf-spread §3.3):双页时收紧到 800px。 */
  renderMargin?: string;
  onRegionCapture?: (capture: PdfRegionCapture) => void;
  onRatioChange: (page: number, ratio: number) => void;
  onJump: (page: number) => void;
  /** Corner badge / aria page number (printed when calibrated). */
  badgePage?: number;
  onHighlightResolutions?: (pageNumber: number, items: Array<{ id: string; resolution: AnchorResolution }>) => void;
}

function sourceIdentity(relativePath: string, size: number, modified: number): string {
  return `${relativePath}\u0000${size}\u0000${modified}`;
}

function findReadingRoot(host: HTMLElement | null): HTMLElement | null {
  return host?.closest<HTMLElement>(".reading-scroll") ?? null;
}

function pdfReferenceLine(scrollRoot: HTMLElement, toolbar: HTMLElement | null): number {
  const viewport = scrollRoot.getBoundingClientRect();
  const toolbarBottom = toolbar?.getBoundingClientRect().bottom ?? viewport.top;
  return Math.min(viewport.bottom, Math.max(viewport.top, toolbarBottom + PAGE_REFERENCE_GAP));
}

function pageMeasurements(reader: HTMLElement, selector: string): PdfPageMeasurement[] {
  return Array.from(reader.querySelectorAll<HTMLElement>(selector)).flatMap((page) => {
    const pageNumber = Number(page.dataset.pageNumber);
    if (!Number.isFinite(pageNumber)) return [];
    const rect = page.getBoundingClientRect();
    return [{ page: pageNumber, top: rect.top, bottom: rect.bottom }];
  });
}

function captureCurrentPosition(
  reader: HTMLElement,
  toolbar: HTMLElement | null,
  fallbackPage: number,
  selector: string,
  referenceY?: number,
): PdfPagePosition {
  const scrollRoot = findReadingRoot(reader);
  if (!scrollRoot) return { page: fallbackPage, offsetRatio: 0 };
  const viewport = scrollRoot.getBoundingClientRect();
  const referenceLine = Number.isFinite(referenceY) ? (referenceY as number) : pdfReferenceLine(scrollRoot, toolbar);
  const selected = selectCurrentPdfPage(pageMeasurements(reader, selector), referenceLine, viewport.top, viewport.bottom) ?? fallbackPage;
  const page = reader.querySelector<HTMLElement>(`#pdf-page-${selected}`);
  if (!page) return { page: selected, offsetRatio: 0 };
  const rect = page.getBoundingClientRect();
  return capturePdfPagePosition(selected, rect.top, rect.height, referenceLine);
}

function restorePositionInstantly(
  reader: HTMLElement,
  toolbar: HTMLElement | null,
  position: PdfPagePosition,
  xRatio?: number,
  referenceY?: number,
): boolean {
  const scrollRoot = findReadingRoot(reader);
  const page = reader.querySelector<HTMLElement>(`#pdf-page-${position.page}`);
  if (!scrollRoot || !page) return false;
  const rect = page.getBoundingClientRect();
  const view = xRatio !== undefined ? scrollRoot.getBoundingClientRect() : null;
  const next = {
    top: calculatePdfRestoreScrollTop(
      scrollRoot.scrollTop,
      rect.top,
      rect.height,
      Number.isFinite(referenceY) ? (referenceY as number) : pdfReferenceLine(scrollRoot, toolbar),
      position.offsetRatio,
    ),
  } as { top: number; left?: number };
  if (view && xRatio !== undefined && Number.isFinite(xRatio)) {
    const ratio = Math.min(1, Math.max(0, xRatio));
    const target = rect.left + rect.width * ratio;
    const center = view.left + view.width / 2;
    next.left = scrollRoot.scrollLeft + target - center;
  }
  // One native instant scroll avoids toggling scroll-behavior on the ancestor
  // (and invalidating the whole PDF subtree) twice per preview frame.
  if (typeof scrollRoot.scrollTo === "function") scrollRoot.scrollTo({ ...next, behavior: "instant" });
  else setScrollInstant(scrollRoot, next);
  return true;
}

function capturePageCenterXRatio(reader: HTMLElement, pageNumber: number): number {
  const scrollRoot = findReadingRoot(reader);
  const page = reader.querySelector<HTMLElement>(`#pdf-page-${pageNumber}`);
  if (!scrollRoot || !page) return 0.5;
  const view = scrollRoot.getBoundingClientRect();
  const rect = page.getBoundingClientRect();
  if (!(rect.width > 0)) return 0.5;
  return Math.min(1, Math.max(0, (view.left + view.width / 2 - rect.left) / rect.width));
}

function PdfPage({ session, pageNumber, scale, initialRatio, highlights, fuzzyAnchoring, regionActive = false, renderMargin = PAGE_RENDER_MARGIN, onRegionCapture, onRatioChange, onJump, badgePage, onHighlightResolutions }: PageProps) {
  const shownPage = badgePage ?? pageNumber;
  const hostRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const annotationRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const [renderNearby, setRenderNearby] = useState(pageNumber <= 2);
  const [ratio, setRatio] = useState(initialRatio);
  const [pageWidth, setPageWidth] = useState<number | null>(null);
  const [textLayerRevision, setTextLayerRevision] = useState(0);
  const viewportMetricsRef = useRef<{ width: number; scale: number; userUnit: number } | null>(null);

  const applyTotalScaleFactor = useCallback(() => {
    const host = hostRef.current;
    const metrics = viewportMetricsRef.current;
    if (!host || !metrics) return;
    // Preview only stretches the bitmap. Recomputing hidden text geometry here
    // invalidates thousands of glyph styles on every ResizeObserver delivery.
    if (host.closest("[data-zoom-preview]")) return;
    const factor = computePdfTotalScaleFactor(host.getBoundingClientRect().width, metrics);
    if (factor !== null) host.style.setProperty("--total-scale-factor", String(factor));
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = findReadingRoot(host);
    const observer = new IntersectionObserver(([entry]) => {
      setRenderNearby(Boolean(entry?.isIntersecting));
    }, { root, rootMargin: renderMargin });
    observer.observe(host);
    return () => observer.disconnect();
  }, [renderMargin]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !renderNearby) return;
    const observer = new ResizeObserver(applyTotalScaleFactor);
    observer.observe(host);
    return () => observer.disconnect();
  }, [applyTotalScaleFactor, renderNearby]);

  useEffect(() => {
    if (!renderNearby || !session.lifecycle.isActive()) return;
    let cancelled = false;
    const controller = new AbortController();
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    let textLayer: TextLayer | null = null;

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
      if (resumeTimer !== undefined) clearTimeout(resumeTimer);
      renderTask?.cancel();
      textLayer?.cancel();
    };
    const unregister = session.lifecycle.registerPageTask(cancel);

    const priority = () => {
      const host = hostRef.current;
      const root = findReadingRoot(host);
      if (!host || !root) return pageNumber;
      const rect = host.getBoundingClientRect();
      const view = root.getBoundingClientRect();
      return rect.bottom > view.top && rect.top < view.bottom
        ? -1_000_000 + Math.abs(rect.top - view.top)
        : Math.min(Math.abs(rect.top - view.bottom), Math.abs(rect.bottom - view.top));
    };
    void session.lifecycle.renderQueue.run(() => session.pdf.getPage(pageNumber).then(async (page: PDFPageProxy) => {
      if (cancelled || !session.lifecycle.isActive()) return;
      const viewport = page.getViewport({ scale });
      const nextRatio = viewport.height / viewport.width;
      setRatio(nextRatio);
      onRatioChange(pageNumber, nextRatio);
      viewportMetricsRef.current = { width: viewport.width, scale: viewport.scale, userUnit: viewport.userUnit };
      const pageHost = hostRef.current;
      if (pageHost) {
        // Page size in PDF points (rotation-aware, scale 1) for annotation
        // capture: stored locators snapshot it so normalized rects remain
        // convertible to PDF user-space coordinates offline.
        const baseViewport = page.getViewport({ scale: 1 });
        setPageWidth(baseViewport.width);
        pageHost.dataset.pageWidth = String(baseViewport.width);
        pageHost.dataset.pageHeight = String(baseViewport.height);
      }
      applyTotalScaleFactor();
      const visibleCanvas = canvasRef.current;
      // Keep the previous bitmap visible while PDF.js prepares the next scale.
      const canvas = globalThis.document.createElement("canvas");
      const textHost = textRef.current;
      const annotationHost = annotationRef.current;
      if (!visibleCanvas || !textHost || !annotationHost) return;
      const pixelRatio = pdfRasterPixelRatio(viewport.width, viewport.height, window.devicePixelRatio);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext("2d");
      if (!context || cancelled || !session.lifecycle.isActive()) return;
      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        annotationMode: AnnotationMode.DISABLE,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      renderTask.onContinue = (resume: () => void) => {
        const continueWhenIdle = () => {
          if (cancelled) return;
          if (pageHost?.closest("[data-zoom-preview]")) {
            resumeTimer = setTimeout(continueWhenIdle, 50);
          } else resume();
        };
        continueWhenIdle();
      };
      await renderTask.promise;
      if (cancelled || !session.lifecycle.isActive()) return;
      visibleCanvas.width = canvas.width;
      visibleCanvas.height = canvas.height;
      visibleCanvas.getContext("2d")?.drawImage(canvas, 0, 0);
      visibleCanvas.dataset.pdfRendered = "true";
      // Release the temporary bitmap before constructing the text layer.
      canvas.width = 0;
      canvas.height = 0;
      textHost.replaceChildren();
      // Sizing (and rotation via data-main-rotation) is written by pdf.js
      // setLayerDimensions in terms of --total-scale-factor; no inline size.
      textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: textHost, viewport });
      await textLayer.render();
      if (cancelled || !session.lifecycle.isActive()) return;
      setTextLayerRevision((revision) => revision + 1);
      const annotations = await page.getAnnotations({ intent: "display" });
      if (cancelled || !session.lifecycle.isActive()) return;
      annotationHost.replaceChildren();
      for (const annotation of annotations) {
        if (!annotation.rect || (!annotation.url && !annotation.dest)) continue;
        let url: URL | null = null;
        if (annotation.url) {
          try {
            url = new URL(annotation.url);
          } catch {
            continue;
          }
          if (!new Set(["http:", "https:", "mailto:"]).has(url.protocol)) continue;
        }
        const [x1, y1] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
        const [x2, y2] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
        const link = globalThis.document.createElement("a");
        link.href = url?.toString() ?? "#";
        link.rel = "noopener noreferrer";
        link.title = url?.toString() ?? "跳转到 PDF 内部位置";
        // Percentages of the viewport keep links glued to the page box even
        // when `.pdf-page` is clamped narrower than the render viewport.
        link.style.left = `${(Math.min(x1, x2) / viewport.width) * 100}%`;
        link.style.top = `${(Math.min(y1, y2) / viewport.height) * 100}%`;
        link.style.width = `${(Math.abs(x2 - x1) / viewport.width) * 100}%`;
        link.style.height = `${(Math.abs(y2 - y1) / viewport.height) * 100}%`;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          if (url) {
            if (window.confirm(`将在系统应用中打开外部链接：\n\n${url}\n\n是否继续？`)) void openExternalLink(url.toString());
            return;
          }
          void (async () => {
            if (!session.lifecycle.isActive()) return;
            const destination = typeof annotation.dest === "string" ? await session.pdf.getDestination(annotation.dest) : annotation.dest;
            if (!session.lifecycle.isActive()) return;
            const reference = destination?.[0];
            if (!reference || typeof reference !== "object") return;
            const targetPage = (await session.pdf.getPageIndex(reference as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1;
            if (session.lifecycle.isActive()) onJump(targetPage);
          })();
        });
        annotationHost.append(link);
      }
    }), priority, controller.signal).catch(() => undefined);

    return () => {
      cancel();
      unregister();
    };
  }, [applyTotalScaleFactor, onJump, onRatioChange, pageNumber, renderNearby, scale, session]);

  useEffect(() => {
    const host = highlightRef.current;
    if (!host) return;
    host.replaceChildren();
    const textLayer = textRef.current;
    const pageRect = hostRef.current?.getBoundingClientRect() ?? null;
    // Highlights never mutate the text layer, so one index serves them all.
    let textIndex: TextIndex | null = null;
    const reported: Array<{ id: string; resolution: AnchorResolution }> = [];
    for (const annotation of highlights) {
      if (annotation.locator.kind !== "pdf" || annotation.locator.page !== pageNumber) continue;
      if (annotation.locator.view !== "original") continue;
      const markKind = isAnnotationMarkKind(annotation.kind) ? annotation.kind : "highlight";
      if (textLayer && !textIndex) textIndex = buildTextIndex(textLayer);
      const resolved = resolvePdfHighlightRects({
        textLayer,
        pageRect,
        locator: annotation.locator,
        index: textIndex ?? undefined,
        fuzzy: fuzzyAnchoring,
        page: pageNumber,
      });
      reported.push({ id: annotation.id, resolution: resolved.resolution });
      const paint = pdfHighlightPaintDecision(resolved.resolution);
      if (!paint.paint) continue;
      let isLead = markKind === "highlight";
      for (const rect of resolved.rects) {
        const mark = globalThis.document.createElement("span");
        mark.className = `pdf-user-highlight pdf-user-highlight--${markKind} pdf-user-highlight--${annotation.color ?? "yellow"}`;
        if (paint.className) mark.classList.add(paint.className);
        if (isLead) {
          mark.classList.add("pdf-user-highlight--lead");
          isLead = false;
        }
        if (paint.title) mark.title = paint.title;
        mark.dataset.annotationId = annotation.id;
        mark.dataset.annotationKind = markKind;
        mark.style.left = `${rect.x * 100}%`;
        mark.style.top = `${rect.y * 100}%`;
        mark.style.width = `${rect.w * 100}%`;
        mark.style.height = `${rect.h * 100}%`;
        host.append(mark);
      }
    }
    onHighlightResolutions?.(pageNumber, reported);
  }, [fuzzyAnchoring, highlights, onHighlightResolutions, pageNumber, renderNearby, textLayerRevision]);

  // ---- "截取引用"框选层(plan-pdf-region-card §3.1–§3.2) ----
  // 页内逻辑坐标 → 归一化矩形 → 位图整数裁剪;位图坐标一律按
  // "归一化 × canvas 实际尺寸"换算,不读 devicePixelRatio(RG-D1)。
  const [regionDrag, setRegionDrag] = useState<{ start: RegionPoint; end: RegionPoint } | null>(null);
  const regionBusyRef = useRef(false);

  useEffect(() => {
    if (!regionActive) setRegionDrag(null);
  }, [regionActive]);

  const layerPoint = (event: React.PointerEvent<HTMLDivElement>): RegionPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const finishRegionCapture = useCallback(
    async (normRect: NormalizedRegionRect) => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width <= 0 || canvas.height <= 0 || regionBusyRef.current) return;
      regionBusyRef.current = true;
      try {
        let source: HTMLCanvasElement = canvas;
        const { sw, sh } = regionSourceRect(normRect, canvas.width, canvas.height);
        const multiplier = planRegionUpscale({
          cropWidth: sw,
          cropHeight: sh,
          bitmapWidth: canvas.width,
          bitmapHeight: canvas.height,
        });
        if (multiplier !== null && session.lifecycle.isActive()) {
          // 低清提质:对该页离屏重渲一次(一次性、按需);失败回落直接裁。
          try {
            const page = await session.pdf.getPage(pageNumber);
            if (!session.lifecycle.isActive()) return;
            const baseWidth = page.getViewport({ scale: 1 }).width;
            const totalScale = baseWidth > 0 ? (canvas.width / baseWidth) * multiplier : 0;
            if (totalScale > 0) {
              const viewport = page.getViewport({ scale: totalScale });
              const offscreen = globalThis.document.createElement("canvas");
              offscreen.width = Math.floor(viewport.width);
              offscreen.height = Math.floor(viewport.height);
              const context = offscreen.getContext("2d");
              if (context) {
                await page.render({
                  canvas: offscreen,
                  canvasContext: context,
                  viewport,
                  annotationMode: AnnotationMode.DISABLE,
                }).promise;
                if (!session.lifecycle.isActive()) return;
                source = offscreen;
              }
            }
          } catch {
            source = canvas;
          }
        }
        const crop = cropRegionFromSource(source, source.width, source.height, normRect, (width, height) => {
          const target = globalThis.document.createElement("canvas");
          target.width = width;
          target.height = height;
          return target;
        });
        if (crop) onRegionCapture?.({ canvas: crop, page: pageNumber });
      } finally {
        regionBusyRef.current = false;
      }
    },
    [onRegionCapture, pageNumber, session],
  );

  const handleRegionPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = layerPoint(event);
    setRegionDrag({ start: point, end: point });
  };

  const handleRegionPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!regionDrag) return;
    const point = layerPoint(event);
    setRegionDrag({ start: regionDrag.start, end: point });
  };

  const handleRegionPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!regionDrag) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const normRect = normalizeRegionRect(
      regionDrag.start,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      rect.width,
      rect.height,
    );
    setRegionDrag(null);
    // 过小视为误触(§2 目标 4);位图裁剪异步进行,不阻塞指针交互。
    if (normRect) void finishRegionCapture(normRect);
  };

  const regionRectStyle = (drag: { start: RegionPoint; end: RegionPoint }) => {
    const left = Math.min(drag.start.x, drag.end.x);
    const top = Math.min(drag.start.y, drag.end.y);
    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.abs(drag.end.x - drag.start.x)}px`,
      height: `${Math.abs(drag.end.y - drag.start.y)}px`,
    };
  };

  return <section
    className="pdf-page"
    id={`pdf-page-${pageNumber}`}
    data-page-number={pageNumber}
    ref={hostRef}
    aria-label={
      shownPage === pageNumber
        ? `第 ${pageNumber} 页`
        : `印刷第 ${shownPage} 页，文件第 ${pageNumber} 页`
    }
    style={{
      aspectRatio: `1 / ${ratio}`,
      // Commit geometry with React, before the asynchronous bitmap render.
      ...(pageWidth === null ? {} : { "--pdf-page-width": `${pageWidth * scale}px` }),
    } as React.CSSProperties}
  >
    {renderNearby && <>
      <canvas ref={canvasRef} />
      <div className="textLayer pdf-text-layer" ref={textRef} />
      <div className="pdf-user-highlight-layer" ref={highlightRef} />
      <div className="pdf-annotation-layer" ref={annotationRef} />
      {regionActive && (
        <div
          className="pdf-region-layer"
          data-testid={`pdf-region-layer-${pageNumber}`}
          onPointerDown={handleRegionPointerDown}
          onPointerMove={handleRegionPointerMove}
          onPointerUp={handleRegionPointerUp}
          onPointerCancel={() => setRegionDrag(null)}
        >
          {regionDrag && <div className="pdf-region-rect" style={regionRectStyle(regionDrag)} />}
        </div>
      )}
    </>}
    <span className="reade-motion-locator-highlight" aria-hidden="true" />
    <span className="pdf-page-number">{shownPage}</span>
  </section>;
}

function ranges(numbers: number[]): string {
  if (!numbers.length) return "";
  const output: string[] = [];
  let start = numbers[0];
  let previous = start;
  for (const value of numbers.slice(1)) {
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    output.push(start === previous ? `${start}` : `${start}–${previous}`);
    start = previous = value;
  }
  output.push(start === previous ? `${start}` : `${start}–${previous}`);
  return output.join("、");
}

export function PdfReader({
  relativePath,
  size,
  modified,
  indexStatus,
  indexError,
  locator,
  motionLevel,
  annotations = [],
  fuzzyAnchoring = false,
  readerRef,
  onRegionCard,
  onModeChange,
  libraryRoot,
  keyboardActive = false,
  frontierPage = null,
  onIntentionalJump,
  onResetFrontier,
  onPinToSecondary,
  onBrokenAnnotationsChange,
  onApproximateAnnotationsChange,
  onGeometricFallbackChange,
  onTocChange,
  onActiveChange,
}: PdfReaderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const calibrateInputRef = useRef<HTMLInputElement>(null);
  const generationRef = useRef(0);
  const readingRequestRef = useRef(0);
  const currentPageRef = useRef(1);
  const reportedPageRef = useRef<number | null>(null);
  const pendingPositionRef = useRef<PdfPagePosition | null>(null);
  const pageRatiosRef = useRef(new Map<number, number>());
  const [loadedSession, setLoadedSession] = useState<LoadedPdfSession | null>(null);
  const [boundError, setBoundError] = useState<BoundError | null>(null);
  const [mode, setMode] = useState<"original" | "reading">("original");
  const [scale, setScale] = useState(1);
  const [layoutScale, setLayoutScale] = useState(1);
  const layoutScaleRef = useRef(1);
  const scaleRef = useRef(1);
  const zoomAnchorXRef = useRef<number | null>(null);
  const zoomReferenceYRef = useRef<number | null>(null);
  const commitTimerRef = useRef<number | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const bitmapPreviewRef = useRef<PdfZoomPreview | null>(null);
  const [zoomCommitRevision, setZoomCommitRevision] = useState(0);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const zoomPercentRef = useRef<HTMLButtonElement | null>(null);
  const nativePageWidthRef = useRef<number | null>(null);
  scaleRef.current = scale;
  const [nativePageWidth, setNativePageWidth] = useState<number | null>(null);
  nativePageWidthRef.current = nativePageWidth;
  const [currentPage, setCurrentPage] = useState(1);
  // 双页对开(plan-pdf-spread):intent 是用户意图(会话级记忆),
  // capable 是宽窗判定;两者都成立且在原版式才真正并排。
  const [spreadIntent, setSpreadIntent] = useState(() => spreadMemory.get(relativePath) ?? false);
  const [spreadCapable, setSpreadCapable] = useState(false);
  // "截取引用"模式(plan-pdf-region-card):仅原版式;Esc 退出,换文档/
  // 切阅读模式自动退出;激活期间文本层 pointer-events 由 CSS 关闭。
  const [regionSelect, setRegionSelect] = useState(false);
  const [pageOffset, setPageOffset] = useState(() =>
    libraryRoot ? (readPdfPageOffset(libraryRoot, relativePath)?.offset ?? 0) : 0,
  );
  const [calibrateOpen, setCalibrateOpen] = useState(false);
  const [calibrateDraft, setCalibrateDraft] = useState("");
  const [calibrateError, setCalibrateError] = useState<string | null>(null);
  const [stride, setStride] = useState<PdfStride>(DEFAULT_STRIDE);
  const [pagePins, setPagePins] = useState<PdfPagePinSlots>(() =>
    libraryRoot ? readPdfPagePins(libraryRoot, relativePath) : emptyPdfPagePins(),
  );
  const [boundReading, setBoundReading] = useState<BoundReadingMode | null>(null);
  const [readingLoadingKey, setReadingLoadingKey] = useState<string | null>(null);
  /** D06: Range 读取失败后重建会话重试的计数器。 */
  const [loadNonce, setLoadNonce] = useState(0);
  const sourceKey = sourceIdentity(relativePath, size, modified);
  const sourceKeyRef = useRef(sourceKey);
  sourceKeyRef.current = sourceKey;

  const session = loadedSession?.sourceKey === sourceKey && loadedSession.lifecycle.isActive()
    ? loadedSession
    : null;
  const reading = boundReading?.sourceKey === sourceKey ? boundReading.document : null;
  const error = boundError?.sourceKey === sourceKey ? boundError.message : null;
  const readingLoading = readingLoadingKey === sourceKey;

  const setActivePage = useCallback((page: number) => {
    if (currentPageRef.current !== page) {
      currentPageRef.current = page;
      setCurrentPage(page);
    }
    if (reportedPageRef.current !== page) {
      reportedPageRef.current = page;
      onActiveChange(`pdf-page-${page}`);
    }
  }, [onActiveChange]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const lifecycle = new PdfSessionLifecycle(generation, sourceKey);
    const transport = new ReadeRangeTransport(relativePath, size, (cause: unknown) => {
      // Range 读取失败/超时（D06）：终止会话并给出可重试错误，不再静默吞掉。
      if (lifecycle.isActive() && generationRef.current === generation && sourceKeyRef.current === sourceKey) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        setBoundError({ sourceKey, message: `PDF 数据读取失败：${detail}`, retryable: true });
        void dispose().catch(() => undefined);
      }
    });
    const task = getDocument({
      range: transport,
      rangeChunkSize: RANGE_CHUNK,
      disableAutoFetch: true,
      disableStream: true,
      enableXfa: false,
    });
    const dispose = () => disposePdfSession(lifecycle, () => transport.abort(), () => task.destroy());

    setLoadedSession(null);
    setBoundError(null);
    task.onPassword = () => {
      if (lifecycle.isActive() && generationRef.current === generation) {
        setBoundError({ sourceKey, message: "不支持受保护文件" });
      }
      void dispose().catch(() => undefined);
    };
    void task.promise.then((pdf) => {
      if (!lifecycle.isActive() || generationRef.current !== generation || sourceKeyRef.current !== sourceKey) return;
      setLoadedSession({ sourceKey, pdf, lifecycle });
    }).catch((cause: unknown) => {
      if (!lifecycle.isActive() || generationRef.current !== generation || sourceKeyRef.current !== sourceKey) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setBoundError({ sourceKey, message: /password/i.test(message) ? "不支持受保护文件" : `PDF 打开失败：${message}` });
    });

    return () => {
      void dispose().catch(() => undefined);
    };
  }, [loadNonce, relativePath, size, sourceKey]);

  useEffect(() => {
    readingRequestRef.current += 1;
    currentPageRef.current = 1;
    reportedPageRef.current = null;
    pendingPositionRef.current = null;
    pageRatiosRef.current.clear();
    setCurrentPage(1);
    setMode("original");
    setNativePageWidth(null);
    setBoundReading(null);
    setReadingLoadingKey(null);
    setRegionSelect(false);
    setCalibrateOpen(false);
    setCalibrateError(null);
    // 换文档恢复该文档的双页意图(PS-D3 会话级记忆)。
    setSpreadIntent(spreadMemory.get(relativePath) ?? false);
  }, [relativePath, sourceKey]);

  // 双页可用性监测(PS-D1 定稿):窗口断点 + 容器可读宽,ResizeObserver
  // 与 window resize 双通道;越界自动回单页,意图保留、恢复自动回来。
  useEffect(() => {
    const reader = rootRef.current;
    if (!reader) return;
    const measure = () => {
      setSpreadCapable(canSpread(window.innerWidth, reader.clientWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(reader);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const spreadActive = spreadIntent && spreadCapable && mode === "original";

  // 阅读模式没有页位图可裁;Esc 只在模式激活时消费(不 preventDefault,
  // App 全局 Esc 链的收尾行为保持不变)。
  useEffect(() => {
    if (mode !== "original") {
      setRegionSelect(false);
      setCalibrateOpen(false);
    }
  }, [mode]);

  useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  useEffect(() => {
    if (!regionSelect) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRegionSelect(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [regionSelect]);

  useEffect(() => {
    const syncOffset = () => {
      if (!libraryRoot) {
        setPageOffset(0);
        return;
      }
      setPageOffset(readPdfPageOffset(libraryRoot, relativePath)?.offset ?? 0);
    };
    syncOffset();
    return subscribePdfPageOffsets(syncOffset);
  }, [libraryRoot, relativePath]);

  useEffect(() => {
    const syncPins = () => {
      setPagePins(libraryRoot ? readPdfPagePins(libraryRoot, relativePath) : emptyPdfPagePins());
    };
    syncPins();
    return subscribePdfPagePins(syncPins);
  }, [libraryRoot, relativePath]);

  useEffect(() => {
    if (!calibrateOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCalibrateOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [calibrateOpen]);

  useEffect(() => {
    onTocChange([]);
    onActiveChange(null);
  }, [onActiveChange, onTocChange, sourceKey]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    type OutlineItem = { title?: string; dest?: string | unknown[]; items?: OutlineItem[] };
    void session.pdf.getOutline().then(async (outline) => {
      const resolveTree = async (items: OutlineItem[]): Promise<PdfOutlineNode[]> => {
        const nodes: PdfOutlineNode[] = [];
        for (const item of items) {
          if (cancelled || !session.lifecycle.isActive()) return nodes;
          let page = 1;
          try {
            const destination = typeof item.dest === "string" ? await session.pdf.getDestination(item.dest) : item.dest;
            const reference = destination?.[0];
            if (reference && typeof reference === "object") {
              page = (await session.pdf.getPageIndex(reference as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1;
            }
          } catch {
            // Malformed outline destinations stay on page one.
          }
          if (cancelled || !session.lifecycle.isActive()) return nodes;
          nodes.push({
            title: item.title,
            page,
            items: item.items?.length ? await resolveTree(item.items) : undefined,
          });
        }
        return nodes;
      };
      const tree = await resolveTree((outline ?? []) as OutlineItem[]);
      if (!cancelled && session.lifecycle.isActive()) onTocChange(flattenPdfOutline(tree));
    }).catch(() => {
      if (!cancelled && session.lifecycle.isActive()) onTocChange([]);
    });
    return () => {
      cancelled = true;
    };
  }, [onTocChange, session]);

  const cancelZoomGesture = useCallback(() => {
    if (commitTimerRef.current != null) window.clearTimeout(commitTimerRef.current);
    if (zoomFrameRef.current != null) window.cancelAnimationFrame(zoomFrameRef.current);
    commitTimerRef.current = null;
    zoomFrameRef.current = null;
    bitmapPreviewRef.current?.dispose();
    bitmapPreviewRef.current = null;
    if (pagesRef.current) applyPdfZoomPreview(pagesRef.current, 1, 0);
    layoutScaleRef.current = scaleRef.current;
    zoomAnchorXRef.current = null;
    zoomReferenceYRef.current = null;
    if (zoomPercentRef.current) zoomPercentRef.current.textContent = `${Math.round(scaleRef.current * 100)}%`;
  }, []);

  const jump = useCallback((page: number) => {
    cancelZoomGesture();
    const readingLastPage = reading?.pages.reduce((last, item) => Math.max(last, item.page), 0) ?? 0;
    const pageCount = session?.pdf.numPages ?? readingLastPage;
    const requested = Math.max(1, Math.round(Number.isFinite(page) ? page : 1));
    const next = pageCount > 0 ? Math.min(pageCount, requested) : requested;
    const position = { page: next, offsetRatio: 0 };
    pendingPositionRef.current = position;
    setActivePage(next);
    window.requestAnimationFrame(() => {
      const reader = rootRef.current;
      if (reader && restorePositionInstantly(reader, toolbarRef.current, position)) {
        if (mode === "reading" || pageRatiosRef.current.has(position.page)) {
          pendingPositionRef.current = null;
        }
      }
    });
  }, [cancelZoomGesture, mode, reading?.pages, session?.pdf.numPages, setActivePage]);

  const numPages = session?.pdf.numPages ?? 0;
  const activeOffset = effectiveOffset(pageOffset, numPages);
  const displayPage = displayPageNumber(currentPage, activeOffset);
  const pageAria = pageInputAriaLabel(currentPage, activeOffset, numPages);

  const openPageCalibration = useCallback(() => {
    const printed = printedFromPhysical(currentPageRef.current, activeOffset);
    setCalibrateDraft(printed >= 1 ? String(printed) : "");
    setCalibrateError(null);
    setCalibrateOpen(true);
    window.requestAnimationFrame(() => calibrateInputRef.current?.focus());
  }, [activeOffset]);

  const confirmPageCalibration = useCallback(() => {
    if (!libraryRoot || numPages < 1) return;
    const printed = Number(calibrateDraft);
    const physical = currentPageRef.current;
    if (!isValidCalibration(physical, printed, numPages)) {
      setCalibrateError("无法使用该印刷页码：请输入 ≥1 的整数，且校正后至少有一页印刷号落在文件范围内。");
      return;
    }
    const nextOffset = offsetFromCalibration(physical, printed);
    if (nextOffset === 0) {
      deletePdfPageOffset(libraryRoot, relativePath);
    } else {
      writePdfPageOffset(libraryRoot, relativePath, { offset: nextOffset, atPhysical: physical });
    }
    setCalibrateOpen(false);
    setCalibrateError(null);
  }, [calibrateDraft, libraryRoot, numPages, relativePath]);

  const clearPageCalibration = useCallback(() => {
    if (libraryRoot) deletePdfPageOffset(libraryRoot, relativePath);
    setCalibrateOpen(false);
    setCalibrateError(null);
  }, [libraryRoot, relativePath]);

  const focusPageInput = useCallback(() => {
    const input = pageInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const jumpToFrontier = useCallback(() => {
    if (frontierPage == null) return;
    const target = Math.max(1, Math.round(frontierPage));
    if (currentPageRef.current >= target) return;
    onIntentionalJump?.();
    jump(target);
  }, [frontierPage, jump, onIntentionalJump]);

  const persistPins = useCallback(
    (next: PdfPagePinSlots) => {
      setPagePins(next);
      if (libraryRoot) writePdfPagePins(libraryRoot, relativePath, next);
    },
    [libraryRoot, relativePath],
  );

  const handlePinChipClick = useCallback(
    (index: number, event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.ctrlKey || event.metaKey) {
        persistPins(clearPinSlot(pagePins, index));
        return;
      }
      const filled = pagePins[index];
      if (filled == null) {
        persistPins(togglePinSlot(pagePins, index, currentPageRef.current));
        return;
      }
      onIntentionalJump?.();
      jump(filled);
    },
    [jump, onIntentionalJump, pagePins, persistPins],
  );

  useEffect(() => {
    if (!keyboardActive || mode !== "original" || !session) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const code = event.code;
      const ctrl = event.ctrlKey || event.metaKey;
      const typing = isTypingTarget(event.target);
      const inCalibrateInput = event.target === calibrateInputRef.current;

      if (ctrl && event.shiftKey && !event.altKey && code === "KeyG") {
        if (typing && !inCalibrateInput && event.target !== pageInputRef.current) return;
        event.preventDefault();
        openPageCalibration();
        return;
      }
      if (ctrl && event.shiftKey && !event.altKey && code === "KeyH") {
        if (typing) return;
        event.preventDefault();
        onResetFrontier?.(currentPageRef.current);
        return;
      }
      const slot = digitSlotIndex(code);
      if (ctrl && !event.shiftKey && !event.altKey && slot !== null) {
        if (typing || calibrateOpen) return;
        event.preventDefault();
        persistPins(togglePinSlot(pagePins, slot, currentPageRef.current));
        return;
      }
      if (ctrl || event.metaKey || event.altKey) return;

      if (code === "KeyL" && event.shiftKey) {
        if (typing || calibrateOpen) return;
        if (!onPinToSecondary) return;
        event.preventDefault();
        onPinToSecondary(currentPageRef.current);
        return;
      }
      if (slot !== null && !event.shiftKey) {
        if (typing || calibrateOpen) return;
        const target = pagePins[slot];
        if (target == null) return;
        event.preventDefault();
        onIntentionalJump?.();
        jump(target);
        return;
      }

      if (code === "KeyG" && !event.shiftKey) {
        if (typing && !inCalibrateInput && event.target !== pageInputRef.current) return;
        event.preventDefault();
        focusPageInput();
        return;
      }
      if (code === "KeyH" && event.shiftKey) {
        if (typing) return;
        if (frontierPage == null) return;
        event.preventDefault();
        jumpToFrontier();
        return;
      }
      if (code !== "KeyA" && code !== "KeyD") return;
      if (typing || calibrateOpen) return;
      const pageCount = session.pdf.numPages;
      let next: number;
      if (event.shiftKey) {
        const delta = code === "KeyD" ? stride : -stride;
        next = Math.min(pageCount, Math.max(1, currentPageRef.current + delta));
      } else if (spreadActive) {
        next = code === "KeyD"
          ? nextSpreadPage(currentPageRef.current, pageCount)
          : previousSpreadPage(currentPageRef.current);
      } else {
        next = Math.min(pageCount, Math.max(1, currentPageRef.current + (code === "KeyD" ? 1 : -1)));
      }
      if (next === currentPageRef.current) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      jump(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    calibrateOpen,
    focusPageInput,
    frontierPage,
    jump,
    jumpToFrontier,
    keyboardActive,
    mode,
    onIntentionalJump,
    onPinToSecondary,
    onResetFrontier,
    openPageCalibration,
    pagePins,
    persistPins,
    session,
    spreadActive,
    stride,
  ]);

  const handlePageRatioChange = useCallback((page: number, ratio: number) => {
    pageRatiosRef.current.set(page, ratio);
    const pending = pendingPositionRef.current;
    if (!pending || pending.page !== page) return;
    window.requestAnimationFrame(() => {
      const reader = rootRef.current;
      if (commitTimerRef.current !== null) return;
      if (reader && pendingPositionRef.current === pending && restorePositionInstantly(reader, toolbarRef.current, pending)) {
        pendingPositionRef.current = null;
      }
    });
  }, []);

  const commitPdfScale = useCallback((next: number) => {
    if (zoomFrameRef.current !== null) {
      window.cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = null;
    }
    const clamped = clampPdfScale(next);
    if (commitTimerRef.current != null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    layoutScaleRef.current = clamped;
    setLayoutScale(clamped);
    setScale(clamped);
    setZoomCommitRevision((revision) => revision + 1);
  }, []);

  const paintLiveZoom = useCallback(() => {
    zoomFrameRef.current = null;
    const pages = pagesRef.current;
    const reader = rootRef.current;
    if (!pages) return;
    const nextScale = layoutScaleRef.current;
    const factor = pdfZoomPreviewFactor(nextScale, scaleRef.current);
    const percent = zoomPercentRef.current;
    if (percent) percent.textContent = `${Math.round(nextScale * 100)}%`;
    if (bitmapPreviewRef.current?.paint(factor)) return;
    // Coverage exhausted: return to live layout for the rest of this gesture.
    bitmapPreviewRef.current?.dispose();
    bitmapPreviewRef.current = null;
    const pageWidthPx = pdfZoomLivePageWidth(nativePageWidthRef.current ?? 820, nextScale);
    applyPdfZoomPreview(pages, factor, pageWidthPx);
    const position = pendingPositionRef.current;
    if (reader && position) {
      restorePositionInstantly(
        reader,
        toolbarRef.current,
        position,
        zoomAnchorXRef.current ?? undefined,
        zoomReferenceYRef.current ?? undefined,
      );
    }
  }, []);

  const scheduleScaleCommit = useCallback(() => {
    if (commitTimerRef.current != null) window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null;
      commitPdfScale(layoutScaleRef.current);
    }, PDF_SCALE_COMMIT_DELAY_MS);
  }, [commitPdfScale]);

  const beginZoomGesture = useCallback((_clientX?: number, clientY?: number) => {
    const reader = rootRef.current;
    if (!reader || commitTimerRef.current !== null) return;
    zoomReferenceYRef.current = Number.isFinite(clientY) ? (clientY as number) : null;
    pendingPositionRef.current = captureCurrentPosition(
      reader,
      toolbarRef.current,
      currentPageRef.current,
      ".pdf-page",
      zoomReferenceYRef.current ?? undefined,
    );
    zoomAnchorXRef.current = capturePageCenterXRatio(
      reader,
      pendingPositionRef.current.page,
    );
    const pages = pagesRef.current;
    const scroller = findReadingRoot(reader);
    if (pages && scroller) {
      bitmapPreviewRef.current = createPdfZoomPreview(pages, scroller, toolbarRef.current,
        zoomReferenceYRef.current ?? undefined);
    }
  }, []);

  const previewPdfScale = useCallback((next: number, clientX?: number, clientY?: number) => {
    const clamped = clampPdfScale(next);
    if (clamped === layoutScaleRef.current) return;
    beginZoomGesture(clientX, clientY);
    layoutScaleRef.current = clamped;
    if (zoomFrameRef.current === null) {
      zoomFrameRef.current = window.requestAnimationFrame(paintLiveZoom);
    }
    scheduleScaleCommit();
  }, [beginZoomGesture, paintLiveZoom, scheduleScaleCommit]);

  const fitWidth = useCallback(async () => {
    const activeSession = session;
    const reader = rootRef.current;
    if (!activeSession || !reader) return;
    try {
      const firstPage = await activeSession.pdf.getPage(1);
      if (!activeSession.lifecycle.isActive() || sourceKeyRef.current !== activeSession.sourceKey) return;
      const nativeWidth = firstPage.getViewport({ scale: 1 }).width;
      setNativePageWidth(nativeWidth);
      // 适宽语义(plan-pdf-spread §2):双页 = 两页 + 列距填满容器。
      const fitted = spreadActive
        ? spreadFitScale(reader.clientWidth, nativeWidth)
        : singleFitScale(reader.clientWidth, nativeWidth);
      commitPdfScale(fitted);
    } catch {
      // Session replacement can reject getPage; the new session will fit itself.
    }
  }, [commitPdfScale, session, spreadActive]);

  const adjustScale = useCallback((direction: WheelZoomDirection) => {
    if (direction === 0) return;
    previewPdfScale(adjustPdfScale(layoutScaleRef.current, direction));
  }, [previewPdfScale]);

  const zoomByWheel = useCallback((deltaY: number, deltaMode = 0, clientX?: number, clientY?: number) => {
    const pixels = wheelZoomDeltaPixels({ deltaY, deltaMode });
    if (pixels === 0) return;
    previewPdfScale(adjustPdfScaleByDelta(layoutScaleRef.current, pixels), clientX, clientY);
  }, [previewPdfScale]);

  useLayoutEffect(() => cancelZoomGesture, [cancelZoomGesture, sourceKey, mode, spreadActive]);

  useEffect(() => {
    const finish = () => {
      if (commitTimerRef.current !== null || bitmapPreviewRef.current) commitPdfScale(layoutScaleRef.current);
    };
    window.addEventListener("blur", finish);
    window.addEventListener("resize", finish);
    const scroller = findReadingRoot(rootRef.current);
    const finishOnScroll = () => { if (bitmapPreviewRef.current) finish(); };
    scroller?.addEventListener("scroll", finishOnScroll, { passive: true });
    let previousSize = scroller ? `${scroller.clientWidth}:${scroller.clientHeight}` : "";
    const observer = new ResizeObserver(() => {
      if (!scroller) return;
      const size = `${scroller.clientWidth}:${scroller.clientHeight}`;
      if (size !== previousSize) finish();
      previousSize = size;
    });
    if (scroller) observer.observe(scroller);
    return () => {
      window.removeEventListener("blur", finish);
      window.removeEventListener("resize", finish);
      scroller?.removeEventListener("scroll", finishOnScroll);
      observer.disconnect();
    };
  }, [commitPdfScale]);

  useEffect(() => {
    // 加载即适宽;spreadActive 改变 fitWidth 身份,切换双页/单页时
    // 顺带重新适宽(定稿 §6.1 的已知取舍:手动缩放不跨切换保留)。
    if (session) void fitWidth();
  }, [fitWidth, session]);


  const pageSelector = mode === "original" ? ".pdf-page" : ".pdf-reading-page";

  const capturePosition = useCallback((): PdfPagePosition => {
    const reader = rootRef.current;
    if (!reader) return { page: currentPageRef.current, offsetRatio: 0 };
    return captureCurrentPosition(reader, toolbarRef.current, currentPageRef.current, pageSelector);
  }, [pageSelector]);

  /** 双页切换(plan-pdf-spread):先捕获位置,布局落定后由既有恢复 effect 回位。 */
  const toggleSpread = useCallback(() => {
    const position = capturePosition();
    pendingPositionRef.current = position;
    currentPageRef.current = position.page;
    setCurrentPage(position.page);
    setSpreadIntent((value) => {
      const next = !value;
      spreadMemory.set(relativePath, next);
      return next;
    });
  }, [capturePosition, relativePath]);

  const lastReadingBrokenRef = useRef<string[]>([]);
  const lastReadingApproximateRef = useRef<string[]>([]);
  const originalPageReportsRef = useRef(
    new Map<number, Array<{ id: string; resolution: AnchorResolution }>>(),
  );
  const lastOriginalBrokenRef = useRef<string[]>([]);
  const lastOriginalApproximateRef = useRef<string[]>([]);
  const lastOriginalGeometricRef = useRef<string[]>([]);

  const emitOriginalHonesty = useCallback(
    (pageCount: number) => {
      const geometric: string[] = [];
      const detached: string[] = [];
      const approximate: string[] = [];
      for (const items of originalPageReportsRef.current.values()) {
        for (const item of items) {
          if (item.resolution.status === "geometricFallback") geometric.push(item.id);
          else if (item.resolution.status === "detached") detached.push(item.id);
          else if (item.resolution.status === "approximate") approximate.push(item.id);
        }
      }
      const broken: string[] = [...detached];
      for (const annotation of annotations) {
        if (!isAnnotationMarkKind(annotation.kind)) continue;
        const locator = annotation.locator;
        if (locator.kind !== "pdf" || locator.view !== "original") continue;
        if (locator.page < 1 || (pageCount > 0 && locator.page > pageCount)) {
          broken.push(annotation.id);
        }
      }
      for (const annotation of annotations) {
        if (annotation.kind !== "bookmark" || annotation.locator.kind !== "bookmark") continue;
        if (annotation.locator.target.format !== "pdf") continue;
        const page = annotation.locator.target.page;
        if (page < 1 || (pageCount > 0 && page > pageCount)) broken.push(annotation.id);
      }
      const nextBroken = Array.from(new Set(broken));
      const nextApproximate = Array.from(new Set(approximate));
      const nextGeometric = Array.from(new Set(geometric));
      if (
        nextBroken.length !== lastOriginalBrokenRef.current.length ||
        nextBroken.some((id, index) => id !== lastOriginalBrokenRef.current[index])
      ) {
        lastOriginalBrokenRef.current = nextBroken;
        onBrokenAnnotationsChange?.(nextBroken);
      }
      if (
        nextApproximate.length !== lastOriginalApproximateRef.current.length ||
        nextApproximate.some((id, index) => id !== lastOriginalApproximateRef.current[index])
      ) {
        lastOriginalApproximateRef.current = nextApproximate;
        onApproximateAnnotationsChange?.(nextApproximate);
      }
      if (
        nextGeometric.length !== lastOriginalGeometricRef.current.length ||
        nextGeometric.some((id, index) => id !== lastOriginalGeometricRef.current[index])
      ) {
        lastOriginalGeometricRef.current = nextGeometric;
        onGeometricFallbackChange?.(nextGeometric);
      }
    },
    [annotations, onApproximateAnnotationsChange, onBrokenAnnotationsChange, onGeometricFallbackChange],
  );

  const handleHighlightResolutions = useCallback(
    (pageNumber: number, items: Array<{ id: string; resolution: AnchorResolution }>) => {
      originalPageReportsRef.current.set(pageNumber, items);
      emitOriginalHonesty(session?.pdf.numPages ?? 0);
    },
    [emitOriginalHonesty, session?.pdf.numPages],
  );

  useLayoutEffect(() => {
    if (mode !== "reading") return;
    if (lastOriginalGeometricRef.current.length) {
      lastOriginalGeometricRef.current = [];
      onGeometricFallbackChange?.([]);
    }
    const root = rootRef.current;
    if (!root) return;
    const pages = Array.from(root.querySelectorAll<HTMLElement>(".pdf-reading-page"));
    const broken: string[] = [];
    const approximate: string[] = [];
    for (const page of pages) {
      const pageNumber = Number(page.dataset.pageNumber);
      clearAnnotationMarks(page);
      const textRoot = page.querySelector<HTMLElement>(".markdown-body") ?? page;
      const marks: TextQuoteMarkInput[] = [];
      for (const annotation of annotations) {
        if (!isAnnotationMarkKind(annotation.kind) || annotation.locator.kind !== "pdf") continue;
        if (annotation.locator.page !== pageNumber || annotation.locator.view !== "reading") continue;
        if (!annotation.color) continue;
        marks.push({
          id: annotation.id,
          color: annotation.color,
          markKind: annotation.kind,
          quote: annotation.locator.quote,
          prefix: annotation.locator.prefix,
          suffix: annotation.locator.suffix,
        });
      }
      // One page-level walk per paint instead of one per annotation.
      if (marks.length) {
        const painted = paintTextQuoteMarks(textRoot, marks, undefined, { fuzzy: fuzzyAnchoring });
        broken.push(...painted.broken);
        approximate.push(...painted.approximate.keys());
      }
    }
    for (const annotation of annotations) {
      if (!isAnnotationMarkKind(annotation.kind)) continue;
      const locator = annotation.locator;
      if (locator.kind !== "pdf" || locator.view !== "reading") continue;
      const pageExists = pages.some((page) => Number(page.dataset.pageNumber) === locator.page);
      if (!pageExists) broken.push(annotation.id);
    }
    const nextBroken = Array.from(new Set(broken));
    if (
      nextBroken.length !== lastReadingBrokenRef.current.length ||
      nextBroken.some((id, index) => id !== lastReadingBrokenRef.current[index])
    ) {
      lastReadingBrokenRef.current = nextBroken;
      onBrokenAnnotationsChange?.(nextBroken);
    }
    const nextApproximate = Array.from(new Set(approximate));
    if (
      nextApproximate.length !== lastReadingApproximateRef.current.length ||
      nextApproximate.some((id, index) => id !== lastReadingApproximateRef.current[index])
    ) {
      lastReadingApproximateRef.current = nextApproximate;
      onApproximateAnnotationsChange?.(nextApproximate);
    }
  });

  useEffect(() => {
    if (mode !== "original") return;
    emitOriginalHonesty(session?.pdf.numPages ?? 0);
  }, [annotations, emitOriginalHonesty, mode, session?.pdf.numPages]);

  const switchMode = useCallback((nextMode: "original" | "reading") => {
    if (nextMode === mode) return;
    const position = capturePosition();
    pendingPositionRef.current = position;
    currentPageRef.current = position.page;
    setCurrentPage(position.page);
    setMode(nextMode);
  }, [capturePosition, mode]);

  const openReadingMode = useCallback(async () => {
    switchMode("reading");
    if (reading) return;
    const request = ++readingRequestRef.current;
    const requestedSource = sourceKey;
    setReadingLoadingKey(requestedSource);
    try {
      const document = await readPdfReadingMode(relativePath);
      if (readingRequestRef.current === request && sourceKeyRef.current === requestedSource) {
        setBoundReading({ sourceKey: requestedSource, document });
      }
    } catch (cause) {
      if (readingRequestRef.current === request && sourceKeyRef.current === requestedSource) {
        setBoundError({ sourceKey: requestedSource, message: cause instanceof Error ? cause.message : String(cause) });
      }
    } finally {
      if (readingRequestRef.current === request && sourceKeyRef.current === requestedSource) {
        setReadingLoadingKey(null);
      }
    }
  }, [reading, relativePath, sourceKey, switchMode]);

  useEffect(() => {
    if (!readerRef) return;
    readerRef.current = {
      getPosition: capturePosition,
      getMode: () => mode,
      setMode: (nextMode) => {
        if (nextMode === mode) return;
        // Reading mode goes through the async loading path, exactly like the
        // toolbar toggle button.
        if (nextMode === "reading") void openReadingMode();
        else switchMode("original");
      },
      restorePosition: (position) => {
        const reader = rootRef.current;
        if (!reader) return false;
        return restorePositionInstantly(reader, toolbarRef.current, position);
      },
      jumpToPage: (physicalPage) => jump(physicalPage),
      openPageCalibration,
      adjustScale,
      zoomByWheel,
    };
    return () => {
      readerRef.current = null;
    };
  }, [adjustScale, capturePosition, jump, mode, openPageCalibration, openReadingMode, readerRef, switchMode, zoomByWheel]);

  useEffect(() => {
    if (locator?.kind !== "pdfPage") return;
    jump(locator.page);
    let highlighted: HTMLElement | null = null;
    const frame = window.requestAnimationFrame(() => {
      const page = rootRef.current?.querySelector<HTMLElement>(`#pdf-page-${locator.page}`);
      highlighted = page?.querySelector<HTMLElement>(".reade-motion-locator-highlight") ?? null;
      if (!highlighted) return;
      runMotion(
        highlighted,
        "locator-highlight",
        [
          { opacity: 0 },
          { opacity: motionLevel === "full" ? 0.32 : 0.22, offset: 0.18 },
          { opacity: 0 },
        ],
        { duration: motionLevel === "full" ? 880 : 720, easing: "ease-out" },
        motionLevel,
      );
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (highlighted) cancelMotion(highlighted, "locator-highlight");
    };
  }, [jump, locator, mode, motionLevel, reading, session]);

  useLayoutEffect(() => {
    bitmapPreviewRef.current?.dispose();
    bitmapPreviewRef.current = null;
    const pages = pagesRef.current;
    if (pages && !isPdfZoomPreviewing(layoutScale, scale)) {
      applyPdfZoomPreview(pages, 1, 0);
    }
    const position = pendingPositionRef.current;
    if (!position || (mode === "original" && !session) || (mode === "reading" && !reading)) return;
    const reader = rootRef.current;
    if (!reader) return;
    const xRatio = zoomAnchorXRef.current ?? undefined;
    if (restorePositionInstantly(reader, toolbarRef.current, position, xRatio, zoomReferenceYRef.current ?? undefined)) {
      const previewing = isPdfZoomPreviewing(layoutScale, scale);
      if (!previewing && (mode === "reading" || pageRatiosRef.current.has(position.page))) {
        pendingPositionRef.current = null;
        zoomAnchorXRef.current = null;
        zoomReferenceYRef.current = null;
      }
      setActivePage(position.page);
    }
    // spreadActive:双页/单页切换是一次布局重排,同样要回位(§3.2)。
    // scale:预览提交后页框换成新的 --pdf-page-width,清掉 live width 再回位。
  }, [layoutScale, mode, reading, scale, session, setActivePage, spreadActive, zoomCommitRevision]);

  useEffect(() => {
    if ((mode === "original" && !session) || (mode === "reading" && !reading)) return;
    const reader = rootRef.current;
    const scrollRoot = findReadingRoot(reader);
    if (!reader || !scrollRoot) return;
    let frame: number | null = null;
    const updateCurrentPage = () => {
      frame = null;
      // The gesture has its own stable anchor. Avoid measuring every page in
      // long documents again for the scroll events generated by that gesture.
      if (commitTimerRef.current !== null || zoomFrameRef.current !== null) return;
      const viewport = scrollRoot.getBoundingClientRect();
      const selected = selectCurrentPdfPage(
        pageMeasurements(reader, pageSelector),
        pdfReferenceLine(scrollRoot, toolbarRef.current),
        viewport.top,
        viewport.bottom,
      );
      if (selected !== null) setActivePage(selected);
    };
    const scheduleUpdate = () => {
      if (frame === null) frame = window.requestAnimationFrame(updateCurrentPage);
    };
    const observer = new IntersectionObserver(scheduleUpdate, {
      root: scrollRoot,
      threshold: [0, .01, .25, .5, .75, 1],
    });
    reader.querySelectorAll<HTMLElement>(pageSelector).forEach((page) => observer.observe(page));
    scrollRoot.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    scheduleUpdate();
    return () => {
      observer.disconnect();
      scrollRoot.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [mode, pageSelector, reading, scale, session, setActivePage]);

  return <div className={`pdf-reader${regionSelect ? " pdf-region-select-active" : ""}`} ref={rootRef}>
    <div className="pdf-toolbar" role="toolbar" aria-label="PDF 阅读工具" ref={toolbarRef}>
      <div className="pdf-toolbar-group pdf-mode-toggle" data-mode={mode}>
        <span className="pdf-mode-indicator" aria-hidden="true" />
        <button className={mode === "original" ? "active" : ""} type="button" onClick={() => switchMode("original")}><Columns3 size={14} />原版式</button>
        <button className={mode === "reading" ? "active" : ""} type="button" disabled={size > 128 * 1024 * 1024 || indexStatus === "unsupported"} onClick={() => void openReadingMode()}><FileText size={14} />阅读模式</button>
      </div>
      {mode === "original" && <>
        <div className="pdf-toolbar-group">
          <button type="button" aria-label="上一页" onClick={() => jump(spreadActive ? previousSpreadPage(currentPage) : currentPage - 1)}><ChevronLeft size={14} /></button>
          <label>
            <input
              ref={pageInputRef}
              value={displayPage}
              onChange={(event) => {
                const typed = Number(event.target.value);
                jump(activeOffset === 0 ? typed : physicalFromPrinted(typed, activeOffset));
              }}
              aria-label={pageAria}
              title={activeOffset === 0 ? undefined : pageAria}
            /> / {session?.pdf.numPages ?? "…"}
          </label>
          <button type="button" aria-label="下一页" onClick={() => jump(spreadActive ? nextSpreadPage(currentPage, session?.pdf.numPages ?? currentPage + 2) : currentPage + 1)}><ChevronRight size={14} /></button>
          <button
            type="button"
            className="pdf-stride-chip"
            title={`Shift+A / Shift+D 一次跳 ${stride} 页`}
            aria-label={`快翻步长 ${stride} 页`}
            onClick={() => setStride((value) => cyclePdfStride(value))}
          >{stride}</button>
        </div>
        {libraryRoot && <div className="pdf-toolbar-group">
          <button
            type="button"
            className={activeOffset !== 0 || calibrateOpen ? "active" : ""}
            aria-pressed={calibrateOpen}
            title={
              activeOffset === 0
                ? "标定印刷页码（Ctrl+Shift+G）"
                : `${pageAria}，点击可改或清除`
            }
            onClick={openPageCalibration}
          >
            {activeOffset === 0 || printedFromPhysical(currentPage, activeOffset) < 1
              ? "标定"
              : `${printedFromPhysical(currentPage, activeOffset)} · ${currentPage}`}
          </button>
        </div>}
        {frontierPage != null && <div className="pdf-toolbar-group">
          <button
            type="button"
            disabled={currentPage >= frontierPage}
            title={
              currentPage >= frontierPage
                ? "当前已在最远页"
                : `跳到最远页（文件第 ${frontierPage} 页，Shift+H）`
            }
            onClick={jumpToFrontier}
          >主线</button>
        </div>}
        {(keyboardActive || onPinToSecondary) && <div className="pdf-toolbar-group pdf-pin-group">
          {Array.from({ length: PDF_PAGE_PIN_SLOTS }, (_, index) => {
            const filled = pagePins[index];
            return (
              <button
                key={index}
                type="button"
                className={`pdf-pin-chip${filled != null ? " active" : ""}`}
                aria-pressed={filled != null}
                aria-label={pinChipTitle(index, filled, activeOffset)}
                title={pinChipTitle(index, filled, activeOffset)}
                onClick={(event) => handlePinChipClick(index, event)}
              >{pinChipLabel(filled, activeOffset, index)}</button>
            );
          })}
          {onPinToSecondary && (
            <button
              type="button"
              title="把当前页钉到副栏（Shift+L）"
              onClick={() => onPinToSecondary(currentPage)}
            >锁页</button>
          )}
        </div>}
        <div className="pdf-toolbar-group">
          <button type="button" aria-label="缩小" onClick={() => previewPdfScale(adjustPdfScale(layoutScaleRef.current, -1))}><Minus size={14} /></button>
          <button ref={zoomPercentRef} type="button" title="实际大小" onClick={() => commitPdfScale(1)}>{Math.round(layoutScale * 100)}%</button>
          <button type="button" aria-label="放大" onClick={() => previewPdfScale(adjustPdfScale(layoutScaleRef.current, 1))}><Plus size={14} /></button>
          <button type="button" onClick={() => void fitWidth()}>适宽</button>
        </div>
        <div className="pdf-toolbar-group">
          <button
            type="button"
            className={spreadActive ? "active" : ""}
            aria-pressed={spreadActive}
            disabled={!spreadCapable}
            title={
              spreadCapable
                ? spreadActive
                  ? "回到单页"
                  : "双页并排（封面独立成行）"
                : "窗口宽度不足，无法双页并排（需 ≥1180px 宽窗）"
            }
            onClick={toggleSpread}
          ><BookOpen size={14} />双页</button>
        </div>
        {onRegionCard && <div className="pdf-toolbar-group">
          <button
            type="button"
            className={regionSelect ? "active" : ""}
            aria-pressed={regionSelect}
            disabled={!session}
            title={regionSelect ? "退出截取引用（Esc）" : "框选页面区域生成引用卡片"}
            onClick={() => setRegionSelect((active) => !active)}
          ><Crop size={14} />截取引用</button>
        </div>}
      </>}
    </div>
    {regionSelect && mode === "original" && (
      <div className="pdf-region-hint" role="status">
        在页面上拖出一个矩形即可生成引用卡片；按 Esc 退出。
      </div>
    )}
    {calibrateOpen && mode === "original" && (
      <div className="pdf-region-hint pdf-page-calibrate-hint" role="status">
        <span>当前文件第 {currentPage} 页对应印刷第</span>
        <input
          ref={calibrateInputRef}
          value={calibrateDraft}
          inputMode="numeric"
          aria-label="印刷页码"
          onChange={(event) => {
            setCalibrateDraft(event.target.value);
            setCalibrateError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              confirmPageCalibration();
            }
          }}
        />
        <button type="button" onClick={confirmPageCalibration}>确定</button>
        <button type="button" onClick={clearPageCalibration}>清除</button>
        {calibrateError && <span className="pdf-page-calibrate-error">{calibrateError}</span>}
      </div>
    )}
    {error && (
      <div className="pdf-state pdf-state--error">
        {error}
        {boundError?.sourceKey === sourceKey && boundError.retryable && (
          <button
            type="button"
            className="pdf-retry-button"
            onClick={() => setLoadNonce((nonce) => nonce + 1)}
          >
            重试
          </button>
        )}
      </div>
    )}
    {!error && mode === "original" && !session && <div className="pdf-state"><span className="spinner" />正在读取 PDF 结构…</div>}
    {mode === "original" && session && <div className="pdf-pages" ref={pagesRef} data-spread={spreadActive ? "true" : undefined} style={{ "--pdf-page-width": `${Math.round((nativePageWidth ?? 820) * scale)}px` } as React.CSSProperties}>
      {Array.from({ length: session.pdf.numPages }, (_, index) => {
        const page = index + 1;
        return <PdfPage
          session={session}
          pageNumber={page}
          scale={scale}
          initialRatio={pageRatiosRef.current.get(page) ?? 1.414}
          fuzzyAnchoring={fuzzyAnchoring}
          regionActive={regionSelect}
          renderMargin={spreadActive ? SPREAD_RENDER_MARGIN : undefined}
          onRegionCapture={onRegionCard}
          highlights={annotations.filter(
            (annotation) =>
              isAnnotationMarkKind(annotation.kind) &&
              annotation.locator.kind === "pdf" &&
              annotation.locator.view === "original" &&
              annotation.locator.page === page,
          )}
          onHighlightResolutions={handleHighlightResolutions}
          onRatioChange={handlePageRatioChange}
          onJump={jump}
          badgePage={displayPageNumber(page, activeOffset)}
          key={`${session.lifecycle.generation}-${page}`}
        />;
      })}
    </div>}
    {mode === "reading" && <div className="pdf-reading-mode">
      {readingLoading && <div className="pdf-state"><span className="spinner" />正在生成按页阅读文本…</div>}
      {reading?.warning && <div className="pdf-reading-warning"><ScanSearch size={18} />{reading.warning}</div>}
      {reading && reading.missingPages.length > 0 && <div className="pdf-reading-warning"><ScanSearch size={18} />第 {ranges(reading.missingPages)} 页没有可提取文本；本结果为部分内容，未执行 OCR。</div>}
      {reading?.pages.map((page) => <section id={`pdf-page-${page.page}`} data-page-number={page.page} className="pdf-reading-page" key={page.page}><span className="reade-motion-locator-highlight" aria-hidden="true" /><span className="pdf-reading-page-label">Page {displayPageNumber(page.page, activeOffset)}</span>{page.needsOcr && <p className="pdf-page-missing">本页需要 OCR，当前版本未提取正文。</p>}<MarkdownRenderer content={page.markdown} resolveImageSrc={() => null} onNavigate={() => undefined} /></section>)}
      {!readingLoading && !reading && indexError && <div className="pdf-state pdf-state--error">{indexError}</div>}
    </div>}
  </div>;
}
