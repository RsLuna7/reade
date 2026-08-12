import type { DocumentLinks } from "./documentLinks";
import type { MovedDocumentCandidate } from "./documentMoves";
import { RELATED_DEFAULT_LIMIT } from "./relatedFragments";
import { DAILY_REVIEW_LIMIT, type ReviewState } from "./reviewScheduler";
import { WebLibraryClient, type WebManifestDocument } from "./webLibrary";

export type { BacklinkEntry, DocumentLinks, OutgoingEntry } from "./documentLinks";
export type { MovedDocumentCandidate } from "./documentMoves";
export type { ReviewOutcome, ReviewState } from "./reviewScheduler";

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
export interface EpubChapter { id: string; title: string; level: number; blocks: EpubBlock[] }
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

export type AnnotationKind = "highlight" | "underline" | "bookmark";
export type AnnotationColor = "yellow" | "green" | "blue" | "pink";

export interface AnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * `scrollRatio`/`offsetRatio` are derived display values that may be
 * recomputed after a re-layout; they carry no anchor semantics.
 */
export type BookmarkTarget =
  | { format: "markdown"; headingId: string | null; scrollRatio: number }
  | { format: "pdf"; page: number; offsetRatio: number }
  | { format: "epub"; chapterId: string; headingId: string | null; scrollRatio: number };

/**
 * The quote + context is the authoritative anchor; every other positional
 * field is a hint or render cache. The optional fields below are additive:
 * locators stored by older builds simply lack them (never null), and the
 * anchoring chain skips the corresponding steps.
 */
export type AnnotationLocator =
  | {
      kind: "markdown";
      quote: string;
      prefix: string;
      suffix: string;
      headingId: string | null;
      /** Flattened-text offsets in the markdown body at creation (position hint). */
      start?: number;
      end?: number;
    }
  | {
      kind: "pdf";
      page: number;
      view: "original" | "reading";
      quote: string;
      prefix: string;
      suffix: string;
      rects: AnnotationRect[];
      /** Page size in PDF points at creation, so the normalized `rects` stay convertible offline (e.g. to QuadPoints). */
      pageWidth?: number;
      pageHeight?: number;
    }
  | {
      kind: "epub";
      chapterId: string;
      blockIndex: number;
      startOffset: number;
      endOffset: number;
      quote: string;
      prefix: string;
      suffix: string;
      /** Chapter-level flattened-text offsets at creation (position hint; `startOffset` stays block-scoped). */
      start?: number;
      end?: number;
    }
  | {
      kind: "bookmark";
      target: BookmarkTarget;
    };

export interface Annotation {
  id: string;
  relativePath: string;
  kind: AnnotationKind;
  color: AnnotationColor | null;
  note: string | null;
  selectedText: string | null;
  title: string | null;
  locator: AnnotationLocator;
  /**
   * Precomputed position sort key (`M|00000|00001024` style, string order =
   * document order). Derived on the client via `deriveAnnotationSortIndex`;
   * the backend validates the format and recomputes it when absent.
   */
  sortIndex: string;
  createdAt: number;
  updatedAt: number;
  /** Tombstone timestamp in ms; null or absent = live annotation. */
  deletedAt?: number | null;
}

/** One review card: the annotation plus its (possibly implicit) state. */
export interface ReviewQueueItem {
  annotation: Annotation;
  review: ReviewState;
}

/** Data for the "今日回顾" card on the home view. */
export interface ReviewSummary {
  dueCount: number;
  reviewedToday: number;
}

export interface ReadingSession {
  id: string;
  relativePath: string;
  format: DocumentFormat;
  title: string | null;
  /** Unix milliseconds. */
  startedAt: number;
  /** Unix milliseconds. */
  endedAt: number;
  /** Engaged reading time in whole seconds (idle time excluded). */
  activeSeconds: number;
}

// ---- Collections (plan-collections §3.2; serde camelCase twins of the
// Rust `Collection` / `CollectionSummary` / `CollectionItem` structs) ----

export interface Collection {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface CollectionSummary extends Collection {
  itemCount: number;
  /** Items whose path is in the current scan/manifest — the list health badge. */
  presentCount: number;
}

export interface CollectionItem {
  relativePath: string;
  position: number;
  addedAt: number;
  /** Missing items are kept (greyed out) and never auto-deleted (CO-D3). */
  present: boolean;
}

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
/**
 * Web counterpart of the desktop scan hook (`record_scan_fingerprints` in
 * `library.rs`): records the manifest fingerprints that move detection
 * compares against. Failures only weaken move detection, so the library
 * load itself must keep working.
 */
async function recordWebManifestFingerprints(documents: WebManifestDocument[]): Promise<void> {
  try {
    const { syncWebDocumentFingerprints } = await import("./webAnnotations");
    await syncWebDocumentFingerprints(documents);
  } catch (error) {
    console.warn("Reade: 无法记录 Web 文档指纹", error);
  }
}

export async function openLibrary(rootPath: string): Promise<LibrarySnapshot> {
  if (APP_RUNTIME === "web") {
    const manifest = await getWebLibrary().loadManifest();
    await recordWebManifestFingerprints(manifest.documents);
    return { rootPath: manifest.title, documents: manifest.documents };
  }
  return { rootPath, documents: await (await getTauriBackend()).openLibrary(rootPath) };
}
export async function refreshLibrary(rootPath: string): Promise<LibrarySnapshot> {
  if (APP_RUNTIME === "web") {
    const client = getWebLibrary();
    client.clearCache();
    const manifest = await client.loadManifest(true);
    await recordWebManifestFingerprints(manifest.documents);
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

/**
 * Read-only backlink/outgoing view for one document (plan-backlinks
 * §3.3). Desktop reads the derived `document_links` cache table; the web
 * build extracts links from `search.json` at runtime and throws the
 * exported `WEB_LINKS_DISABLED_MESSAGE` beyond 500 documents (BL-D4).
 */
export async function listDocumentLinks(relativePath: string): Promise<DocumentLinks> {
  if (APP_RUNTIME === "web") return getWebLibrary().documentLinks(relativePath);
  return (await getTauriBackend()).listDocumentLinks(relativePath);
}

/**
 * Selection-driven related passages (plan-related-passages §3.1). Both
 * runtimes share the fragment-extraction contract; the desktop ranks with
 * FTS5 bm25, the web build with substring counting (RP-D5) — a documented
 * scoring divergence, like library search itself.
 */
export async function findRelatedPassages(
  text: string,
  excludePath: string | null = null,
  limit: number = RELATED_DEFAULT_LIMIT,
): Promise<SearchResult[]> {
  if (APP_RUNTIME === "web") return getWebLibrary().relatedPassages(text, excludePath, limit);
  return (await getTauriBackend()).findRelatedPassages(text, excludePath, limit);
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

export async function listAnnotations(relativePath?: string | null): Promise<Annotation[]> {
  if (APP_RUNTIME === "web") {
    const { listWebAnnotations } = await import("./webAnnotations");
    return listWebAnnotations(relativePath ?? null);
  }
  return (await getTauriBackend()).listAnnotations(relativePath ?? null);
}

export async function upsertAnnotation(annotation: Annotation): Promise<Annotation> {
  if (APP_RUNTIME === "web") {
    const { upsertWebAnnotation } = await import("./webAnnotations");
    return upsertWebAnnotation(annotation);
  }
  return (await getTauriBackend()).upsertAnnotation(annotation);
}

export async function deleteAnnotation(id: string): Promise<void> {
  if (APP_RUNTIME === "web") {
    const { deleteWebAnnotation } = await import("./webAnnotations");
    return deleteWebAnnotation(id);
  }
  return (await getTauriBackend()).deleteAnnotation(id);
}

export async function clearDocumentAnnotations(relativePath: string): Promise<void> {
  if (APP_RUNTIME === "web") {
    const { clearWebDocumentAnnotations } = await import("./webAnnotations");
    return clearWebDocumentAnnotations(relativePath);
  }
  return (await getTauriBackend()).clearDocumentAnnotations(relativePath);
}

/**
 * Fingerprint rebind chain (§5.5): after a library open/refresh, lists the
 * annotated documents whose path vanished while their content fingerprint
 * reappeared elsewhere. Entries flagged `ambiguous` must not be applied
 * automatically.
 */
export async function detectMovedDocuments(): Promise<MovedDocumentCandidate[]> {
  if (APP_RUNTIME === "web") {
    const manifest = await getWebLibrary().loadManifest();
    const { detectWebMovedDocuments } = await import("./webAnnotations");
    return detectWebMovedDocuments(manifest.documents);
  }
  return (await getTauriBackend()).detectMovedDocuments();
}

/**
 * Moves every annotation (tombstones included) from `oldPath` to `newPath`
 * atomically and returns the number of migrated records.
 */
export async function rebindDocumentAnnotations(
  oldPath: string,
  newPath: string,
): Promise<number> {
  if (APP_RUNTIME === "web") {
    const { rebindWebDocumentAnnotations } = await import("./webAnnotations");
    return rebindWebDocumentAnnotations(oldPath, newPath);
  }
  return (await getTauriBackend()).rebindDocumentAnnotations(oldPath, newPath);
}

/**
 * Due review candidates in due-date order, over-fetched ×3 relative to
 * `limit`; run the result through `buildReviewQueue` (reviewScheduler) for
 * the rotated daily batch.
 */
export async function listReviewQueue(
  nowMs: number,
  limit: number = DAILY_REVIEW_LIMIT,
): Promise<ReviewQueueItem[]> {
  if (APP_RUNTIME === "web") {
    const { listWebReviewQueue } = await import("./webAnnotations");
    return listWebReviewQueue(nowMs, limit);
  }
  return (await getTauriBackend()).listReviewQueue(nowMs, limit);
}

/**
 * Persists a client-derived review state (`applyReviewOutcome`); the backend
 * validates it and counts `totalReviews` itself (suspending is not counted).
 */
export async function recordReviewOutcome(
  annotationId: string,
  state: ReviewState,
): Promise<void> {
  if (APP_RUNTIME === "web") {
    const { recordWebReviewOutcome } = await import("./webAnnotations");
    return recordWebReviewOutcome(annotationId, state);
  }
  return (await getTauriBackend()).recordReviewOutcome(annotationId, state);
}

/**
 * Review card numbers for the home view; the local-timezone day boundary is
 * computed by the caller (e.g. from `localDayKey`), never by the backend.
 */
export async function reviewSummary(dayStartMs: number, nowMs: number): Promise<ReviewSummary> {
  if (APP_RUNTIME === "web") {
    const { webReviewSummary } = await import("./webAnnotations");
    return webReviewSummary(dayStartMs, nowMs);
  }
  return (await getTauriBackend()).reviewSummary(dayStartMs, nowMs);
}

/**
 * Full-text search over live annotations, ordered by document path and
 * position. Desktop rides the FTS5 trigram index; the web build filters in
 * memory with the same contract (`annotationSearch.ts`).
 */
export async function searchAnnotations(query: string, limit = 200): Promise<Annotation[]> {
  if (APP_RUNTIME === "web") {
    const { searchWebAnnotations } = await import("./webAnnotations");
    return searchWebAnnotations(query, limit);
  }
  return (await getTauriBackend()).searchAnnotations(query, limit);
}

// ---- Collections (plan-collections §3.2) ----
//
// camelCase ↔ snake_case wire contract with the Rust commands:
//   listCollections()                    ↔ list_collections()
//   createCollection(id, name)           ↔ create_collection(id, name)
//   renameCollection(id, name)           ↔ rename_collection(id, name)
//   deleteCollection(id)                 ↔ delete_collection(id)
//   listCollectionItems(collectionId)    ↔ list_collection_items(collection_id)
//   addCollectionItem(collectionId, relativePath)
//                                        ↔ add_collection_item(collection_id, relative_path)
//   removeCollectionItem(collectionId, relativePath)
//                                        ↔ remove_collection_item(collection_id, relative_path)
//   reorderCollectionItems(collectionId, orderedPaths)
//                                        ↔ reorder_collection_items(collection_id, ordered_paths)

/** The manifest paths, the web stand-in for the desktop scan snapshot. */
async function webPresentPaths(): Promise<Set<string>> {
  const manifest = await getWebLibrary().loadManifest();
  return new Set(manifest.documents.map((document) => document.relativePath));
}

/** Collections of the open library in stable `(createdAt, id)` order. */
export async function listCollections(): Promise<CollectionSummary[]> {
  if (APP_RUNTIME === "web") {
    const [{ listWebCollections }, present] = await Promise.all([
      import("./webCollections"),
      webPresentPaths(),
    ]);
    return listWebCollections(present);
  }
  return (await getTauriBackend()).listCollections();
}

/** `id` comes from the client (`crypto.randomUUID()`), the backend validates. */
export async function createCollection(id: string, name: string): Promise<Collection> {
  if (APP_RUNTIME === "web") {
    const { createWebCollection } = await import("./webCollections");
    return createWebCollection(id, name);
  }
  return (await getTauriBackend()).createCollection(id, name);
}

export async function renameCollection(id: string, name: string): Promise<void> {
  if (APP_RUNTIME === "web") {
    const { renameWebCollection } = await import("./webCollections");
    return renameWebCollection(id, name);
  }
  return (await getTauriBackend()).renameCollection(id, name);
}

/** Deletes the list only; documents and annotations are never touched. */
export async function deleteCollection(id: string): Promise<void> {
  if (APP_RUNTIME === "web") {
    const { deleteWebCollection } = await import("./webCollections");
    return deleteWebCollection(id);
  }
  return (await getTauriBackend()).deleteCollection(id);
}

export async function listCollectionItems(collectionId: string): Promise<CollectionItem[]> {
  if (APP_RUNTIME === "web") {
    const [{ listWebCollectionItems }, present] = await Promise.all([
      import("./webCollections"),
      webPresentPaths(),
    ]);
    return listWebCollectionItems(collectionId, present);
  }
  return (await getTauriBackend()).listCollectionItems(collectionId);
}

/** Idempotent for already-added paths; the document must be in the library. */
export async function addCollectionItem(
  collectionId: string,
  relativePath: string,
): Promise<CollectionItem> {
  if (APP_RUNTIME === "web") {
    const [{ addWebCollectionItem }, present] = await Promise.all([
      import("./webCollections"),
      webPresentPaths(),
    ]);
    return addWebCollectionItem(collectionId, relativePath, present);
  }
  return (await getTauriBackend()).addCollectionItem(collectionId, relativePath);
}

export async function removeCollectionItem(
  collectionId: string,
  relativePath: string,
): Promise<void> {
  if (APP_RUNTIME === "web") {
    const { removeWebCollectionItem } = await import("./webCollections");
    return removeWebCollectionItem(collectionId, relativePath);
  }
  return (await getTauriBackend()).removeCollectionItem(collectionId, relativePath);
}

/** `orderedPaths` must be exactly the current item set (CO-D4). */
export async function reorderCollectionItems(
  collectionId: string,
  orderedPaths: string[],
): Promise<void> {
  if (APP_RUNTIME === "web") {
    const { reorderWebCollectionItems } = await import("./webCollections");
    return reorderWebCollectionItems(collectionId, orderedPaths);
  }
  return (await getTauriBackend()).reorderCollectionItems(collectionId, orderedPaths);
}

// ---- Annotation transfer (export/import, §5.7) ----

/** One stored document fingerprint (`documents` table / store). */
export interface DocumentFingerprintEntry {
  relativePath: string;
  contentHash: string;
}

/**
 * Every annotation of the current library, tombstones included, in stable
 * `(relativePath, sortIndex, id)` order — the export source and the LWW
 * base for `planAnnotationImport`.
 */
export async function listAnnotationsForTransfer(): Promise<Annotation[]> {
  if (APP_RUNTIME === "web") {
    const { listWebAnnotationsForTransfer } = await import("./webAnnotations");
    return listWebAnnotationsForTransfer();
  }
  return (await getTauriBackend()).listAnnotationsForTransfer();
}

/** Stored content fingerprints, vanished paths included. */
export async function listDocumentFingerprints(): Promise<DocumentFingerprintEntry[]> {
  if (APP_RUNTIME === "web") {
    const { listWebDocumentFingerprints } = await import("./webAnnotations");
    return listWebDocumentFingerprints();
  }
  return (await getTauriBackend()).listDocumentFingerprints();
}

/**
 * Applies a confirmed import plan in one transaction (no partial writes).
 * Returns the number of annotation records written.
 */
export async function importAnnotations(
  records: Annotation[],
  fingerprints: DocumentFingerprintEntry[],
): Promise<number> {
  if (APP_RUNTIME === "web") {
    const [{ importWebAnnotations }, manifest] = await Promise.all([
      import("./webAnnotations"),
      getWebLibrary().loadManifest(),
    ]);
    const present = new Set(manifest.documents.map((document) => document.relativePath));
    return importWebAnnotations(records, fingerprints, present);
  }
  return (await getTauriBackend()).importAnnotations(records, fingerprints);
}

/**
 * Saves an export file: the desktop opens a native save dialog from Rust
 * (the frontend never chooses a path), the web build downloads a Blob.
 * Returns the written path/file name, or null when the user cancelled.
 */
export async function saveAnnotationExportFile(
  fileName: string,
  contents: string,
  mimeType: string,
): Promise<string | null> {
  if (APP_RUNTIME === "web") {
    const { downloadTextFile } = await import("./fileTransfer");
    downloadTextFile(fileName, contents, mimeType);
    return fileName;
  }
  return (await getTauriBackend()).exportAnnotationsFile(fileName, contents);
}

/**
 * Lets the user pick an import file and returns its text (size-capped on
 * both runtimes), or null when the dialog was dismissed.
 */
export async function pickAnnotationImportFile(): Promise<{
  fileName: string;
  contents: string;
} | null> {
  if (APP_RUNTIME === "web") {
    const { pickTextFile } = await import("./fileTransfer");
    return pickTextFile({ accept: ".json,application/json" });
  }
  return (await getTauriBackend()).pickAnnotationsImportFile();
}

// Reading statistics are desktop-only: getTauriBackend() rejects in the Web
// build, mirroring readDocumentRange.
export async function recordReadingSession(session: ReadingSession): Promise<void> {
  return (await getTauriBackend()).recordReadingSession(session);
}

export async function listReadingSessions(fromMs: number, toMs: number): Promise<ReadingSession[]> {
  return (await getTauriBackend()).listReadingSessions(fromMs, toMs);
}
