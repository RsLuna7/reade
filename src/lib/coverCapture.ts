import {
  APP_RUNTIME,
  readDocumentRange,
  readDocumentThumbnail,
  readEpubAsset,
  storeDocumentThumbnail,
  type EpubDocument,
} from "./backend";
import { pickEpubCoverAsset, pngBase64FromDataUrl, thumbnailDimensions } from "./coverArt";

/**
 * 封面缩略图的浏览器侧生产管线（docs/plan-bookshelf-covers.md §3.3）。
 *
 * - PDF：pdf.js 懒加载 + RangeTransport 渲染第 1 页到离屏 canvas；
 * - EPUB：文档打开时从合法 raster 资产缩放捕获（定稿补记 §0.2——
 *   `read_epub_asset` 只服务当前打开的 EPUB，书架端无法为任意 EPUB 取图）。
 *
 * 产出统一为 PNG base64，经 `store_document_thumbnail` 落缓存 sqlite；
 * 尺寸/字节上限由 `coverArt.ts` 与 Rust 校验双侧同源。纯计算部分
 * （挑选、尺寸、base64 提取）在 coverArt.ts 中有单测；本文件只做 DOM 装配。
 */

/** 书架端封面刷新通知（EPUB 打开捕获后让已挂载的书架重取该文档）。 */
export const COVER_STORED_EVENT = "reade:cover-stored";

function notifyCoverStored(relativePath: string): void {
  try {
    window.dispatchEvent(new CustomEvent(COVER_STORED_EVENT, { detail: relativePath }));
  } catch {
    // 通知失败只影响"已挂载书架的即时刷新"，下次挂载仍会命中缓存。
  }
}

function canvasToStoredPng(canvas: HTMLCanvasElement): string | null {
  try {
    return pngBase64FromDataUrl(canvas.toDataURL("image/png"));
  } catch {
    return null;
  }
}

/**
 * 渲染 PDF 第 1 页为封面并写入缓存。返回 true 表示已写入。
 * pdf.js 动态 import，避免书架把 PDF 引擎拖进首屏路径。
 */
export async function capturePdfCoverThumbnail(
  relativePath: string,
  size: number,
): Promise<boolean> {
  if (APP_RUNTIME === "web") return false;
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.mjs",
      import.meta.url,
    ).toString();
  }

  class ThumbnailRangeTransport extends pdfjs.PDFDataRangeTransport {
    private aborted = false;

    constructor(private readonly path: string, length: number) {
      super(length, null, false);
    }

    override requestDataRange(begin: number, end: number): void {
      if (this.aborted) return;
      void readDocumentRange(this.path, begin, Math.min(end - begin, 4 * 1024 * 1024))
        .then((bytes) => {
          if (!this.aborted) this.onDataRange(begin, bytes);
        })
        .catch(() => undefined);
    }

    override abort(): void {
      this.aborted = true;
    }
  }

  const transport = new ThumbnailRangeTransport(relativePath, size);
  const task = pdfjs.getDocument({
    range: transport,
    rangeChunkSize: 256 * 1024,
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const dims = thumbnailDimensions(
      baseViewport.width,
      baseViewport.height,
      window.devicePixelRatio || 1,
    );
    if (!dims) return false;
    const viewport = page.getViewport({ scale: dims.width / baseViewport.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext("2d");
    if (!context) return false;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const png = canvasToStoredPng(canvas);
    if (!png) return false;
    await storeDocumentThumbnail(relativePath, png, canvas.width, canvas.height);
    return true;
  } finally {
    transport.abort();
    await task.destroy().catch(() => undefined);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("封面图片解码失败"));
    image.src = url;
  });
}

/**
 * 文档打开时的 EPUB 封面捕获：已有缓存直接跳过；挑选合法 raster 资产、
 * 缩放到缩略图尺寸后写缓存。返回 true 表示本次新写入了封面。
 */
export async function captureEpubCoverThumbnail(
  relativePath: string,
  document: EpubDocument,
): Promise<boolean> {
  if (APP_RUNTIME === "web") return false;
  const cached = await readDocumentThumbnail(relativePath).catch(() => null);
  if (cached) return false;
  const asset = pickEpubCoverAsset(document.assets);
  if (!asset) return false;
  const bytes = await readEpubAsset(relativePath, asset.id);
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: asset.mediaType }));
  try {
    const image = await loadImage(blobUrl);
    const dims = thumbnailDimensions(
      image.naturalWidth,
      image.naturalHeight,
      window.devicePixelRatio || 1,
    );
    if (!dims) return false;
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = dims.width;
    canvas.height = dims.height;
    const context = canvas.getContext("2d");
    if (!context) return false;
    context.drawImage(image, 0, 0, dims.width, dims.height);
    const png = canvasToStoredPng(canvas);
    if (!png) return false;
    await storeDocumentThumbnail(relativePath, png, dims.width, dims.height);
    notifyCoverStored(relativePath);
    return true;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
