import { WebLibraryClient } from "./webLibrary";

export type DocumentFormat = "markdown" | "mdx" | "pdf" | "epub";
export type IndexStatus =
  | "pending"
  | "indexing"
  | "ready"
  | "partial"
  | "unsupported"
  | "failed";

export interface DocumentInfo {
  relativePath: string;
  title: string;
  size: number;
  modified: number;
  format: DocumentFormat;
  indexStatus: IndexStatus;
  indexError: string | null;
}

export type SearchLocator =
  | { kind: "pdfPage"; page: number }
  | { kind: "epubChapter"; chapterId: string };

export interface SearchResult {
  resultId: string;
  relativePath: string;
  title: string;
  snippet: string;
  score: number;
  format: DocumentFormat;
  locator: SearchLocator | null;
}

export interface LibrarySnapshot {
  rootPath: string;
  documents: DocumentInfo[];
}

export type EpubLinkTarget =
  | { kind: "external"; value: string }
  | { kind: "relative"; value: string }
  | { kind: "anchor"; value: string };
export type EpubImageSource =
  | { kind: "asset"; value: number }
  | { kind: "externalBlocked"; value: string }
  | { kind: "unavailable" };
export type EpubInline =
  | { kind: "text"; text: string; bold: boolean; italic: boolean; strike: boolean; code: boolean }
  | { kind: "link"; content: EpubInline[]; target: EpubLinkTarget }
  | { kind: "image"; alt: string; source: EpubImageSource }
  | { kind: "anchor"; id: string }
  | { kind: "noteRef"; id: string }
  | { kind: "lineBreak" };
export interface EpubListItem { blocks: EpubBlock[]; checked: boolean | null; markerLabel: string | null }
export type EpubTableSlot =
  | { kind: "cell"; blocks: EpubBlock[]; colSpan: number; rowSpan: number }
  | { kind: "covered" };
export type EpubBlock =
  | { kind: "heading"; level: number; anchor: string | null; content: EpubInline[] }
  | { kind: "paragraph"; content: EpubInline[] }
  | { kind: "list"; ordered: boolean; marker: string; start: number; items: EpubListItem[] }
  | { kind: "table"; headerRows: number; layout: boolean; rows: EpubTableSlot[][] }
  | { kind: "blockQuote"; blocks: EpubBlock[] }
  | { kind: "codeBlock"; language: string | null; text: string }
  | { kind: "rule" };
export interface EpubChapter { id: string; title: string; blocks: EpubBlock[] }
export interface EpubAsset { id: number; mediaType: string; allowed: boolean; alt: string }
export interface EpubNote { id: string; kind: string; blocks: EpubBlock[] }
export interface EpubDocument {
  title: string;
  chapters: EpubChapter[];
  assets: EpubAsset[];
  notes: EpubNote[];
}

export type DocumentContent =
  | { kind: "markdown"; relativePath: string; markdown: string }
  | { kind: "pdf"; relativePath: string; size: number; indexStatus: IndexStatus; indexError: string | null }
  | { kind: "epub"; relativePath: string; document: EpubDocument };

export interface PdfPageContent { page: number; markdown: string; needsOcr: boolean; ocrReason: string | null }
export interface PdfReadingMode {
  relativePath: string;
  status: IndexStatus;
  pages: PdfPageContent[];
  missingPages: number[];
  warning: string | null;
}
export interface IndexProgress { total: number; completed: number; ready: number; partial: number; failed: number }
export interface DocumentIndexEvent { relativePath: string; title: string; status: IndexStatus; error: string | null }

export interface AssetPayload { relativePath: string; mimeType: string; data: string }

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
export const APP_RUNTIME = __READE_RUNTIME__;
export const DEFAULT_LIBRARY_ROOT = APP_RUNTIME === "web" ? "reade-web" : "";
type UnlistenFn = () => void;
const webLibrary = APP_RUNTIME === "web" ? new WebLibraryClient() : null;
let tauriBackendPromise: Promise<typeof import("./tauriBackend")> | null = null;

function getWebLibrary(): WebLibraryClient {
  if (!webLibrary) throw new Error("Web 文档库仅在 Web 构建中可用");
  return webLibrary;
}
function getTauriBackend(): Promise<typeof import("./tauriBackend")> {
  if (APP_RUNTIME === "web") return Promise.reject(new Error("Tauri 后端在 Web 构建中不可用"));
  tauriBackendPromise ??= import("./tauriBackend");
  return tauriBackendPromise;
}

export async function chooseLibraryDirectory(): Promise<string | null> {
  if (APP_RUNTIME === "web") return DEFAULT_LIBRARY_ROOT;
  return (await getTauriBackend()).chooseLibraryDirectory();
}
export async function openLibrary(rootPath: string): Promise<LibrarySnapshot> {
  if (APP_RUNTIME === "web") {
    const manifest = await getWebLibrary().loadManifest();
    return { rootPath: manifest.title, documents: manifest.documents };
  }
  return { rootPath, documents: await (await getTauriBackend()).openLibrary(rootPath) };
}
export async function refreshLibrary(rootPath: string): Promise<LibrarySnapshot> {
  if (APP_RUNTIME === "web") {
    const client = getWebLibrary();
    client.clearCache();
    const manifest = await client.loadManifest(true);
    return { rootPath: manifest.title, documents: manifest.documents };
  }
  return { rootPath, documents: await (await getTauriBackend()).refreshLibrary() };
}
export async function readDocument(relativePath: string): Promise<DocumentContent> {
  if (APP_RUNTIME === "web") return getWebLibrary().loadDocument(relativePath);
  return (await getTauriBackend()).openDocument(relativePath);
}
export async function readDocumentRange(relativePath: string, offset: number, length: number): Promise<Uint8Array> {
  return (await getTauriBackend()).readDocumentRange(relativePath, offset, length);
}
export async function readPdfReadingMode(relativePath: string): Promise<PdfReadingMode> {
  return (await getTauriBackend()).readPdfReadingMode(relativePath);
}
export async function readEpubAsset(relativePath: string, assetId: number): Promise<Uint8Array> {
  return (await getTauriBackend()).readEpubAsset(relativePath, assetId);
}
export async function retryDocumentIndex(relativePath: string): Promise<void> {
  if (APP_RUNTIME !== "web") await (await getTauriBackend()).retryDocumentIndex(relativePath);
}
export async function clearConversionCache(): Promise<void> {
  if (APP_RUNTIME !== "web") await (await getTauriBackend()).clearConversionCache();
}
export async function searchDocuments(query: string, limit = 100): Promise<SearchResult[]> {
  if (APP_RUNTIME === "web") return getWebLibrary().search(query, limit);
  return (await getTauriBackend()).searchDocuments(query, limit);
}
export async function readAsset(relativePath: string): Promise<AssetPayload> {
  if (APP_RUNTIME === "web") return getWebLibrary().loadAsset(relativePath);
  return (await getTauriBackend()).readAsset(relativePath);
}
export function assetDataUrl(asset: AssetPayload): string { return `data:${asset.mimeType};base64,${asset.data}`; }
export async function openExternalLink(href: string): Promise<void> {
  let url: URL;
  try { url = new URL(href); } catch { throw new Error("无法打开无效链接"); }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) throw new Error(`不允许打开 ${url.protocol} 链接`);
  if (APP_RUNTIME === "web") { window.open(url.toString(), "_blank", "noopener,noreferrer"); return; }
  await (await getTauriBackend()).openExternalLink(url.toString());
}
export async function onLibraryChanged(handler: () => void | Promise<void>): Promise<UnlistenFn> {
  if (APP_RUNTIME === "web") return () => undefined;
  return (await getTauriBackend()).onLibraryChanged(handler);
}
export async function onLibraryIndexProgress(handler: (progress: IndexProgress) => void): Promise<UnlistenFn> {
  if (APP_RUNTIME === "web") return () => undefined;
  return (await getTauriBackend()).onLibraryIndexProgress(handler);
}
export async function onDocumentIndexStatus(handler: (event: DocumentIndexEvent) => void): Promise<UnlistenFn> {
  if (APP_RUNTIME === "web") return () => undefined;
  return (await getTauriBackend()).onDocumentIndexStatus(handler);
}
