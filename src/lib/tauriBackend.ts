import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  Annotation,
  AssetPayload,
  DocumentContent,
  DocumentFingerprintEntry,
  DocumentIndexEvent,
  DocumentInfo,
  IndexProgress,
  MovedDocumentCandidate,
  PdfReadingMode,
  ReadingSession,
  ReviewQueueItem,
  ReviewState,
  ReviewSummary,
  SearchResult,
} from "./backend";

function asBytes(value: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value);
}

export async function chooseLibraryDirectory(): Promise<string | null> {
  const selection = await open({ directory: true, multiple: false, title: "选择本地文档库" });
  return typeof selection === "string" ? selection : null;
}
export function openLibrary(rootPath: string): Promise<DocumentInfo[]> { return invoke("open_library", { rootPath }); }
export function refreshLibrary(): Promise<DocumentInfo[]> { return invoke("refresh_library"); }
export function openDocument(relativePath: string): Promise<DocumentContent> { return invoke("open_document", { relativePath }); }
export async function readDocumentRange(relativePath: string, offset: number, length: number): Promise<Uint8Array> {
  return asBytes(await invoke("read_document_range", { relativePath, offset, length }));
}
export function readPdfReadingMode(relativePath: string): Promise<PdfReadingMode> { return invoke("read_pdf_reading_mode", { relativePath }); }
export async function readEpubAsset(relativePath: string, assetId: number): Promise<Uint8Array> {
  return asBytes(await invoke("read_epub_asset", { relativePath, assetId }));
}
export function retryDocumentIndex(relativePath: string): Promise<void> { return invoke("retry_document_index", { relativePath }); }
export function clearConversionCache(): Promise<void> { return invoke("clear_conversion_cache"); }
export function searchDocuments(query: string, limit: number): Promise<SearchResult[]> { return invoke("search_documents", { query, limit }); }
export function readAsset(relativePath: string): Promise<AssetPayload> { return invoke("read_asset", { relativePath }); }
export function listAnnotations(relativePath: string | null): Promise<Annotation[]> {
  return invoke("list_annotations", { relativePath });
}
export function upsertAnnotation(annotation: Annotation): Promise<Annotation> {
  return invoke("upsert_annotation", { annotation });
}
export function deleteAnnotation(id: string): Promise<void> {
  return invoke("delete_annotation", { id });
}
export function clearDocumentAnnotations(relativePath: string): Promise<void> {
  return invoke("clear_document_annotations", { relativePath });
}
export function detectMovedDocuments(): Promise<MovedDocumentCandidate[]> {
  return invoke("detect_moved_documents");
}
export function rebindDocumentAnnotations(oldPath: string, newPath: string): Promise<number> {
  return invoke("rebind_document_annotations", { oldPath, newPath });
}
export function listReviewQueue(nowMs: number, limit: number): Promise<ReviewQueueItem[]> {
  return invoke("list_review_queue", { nowMs, limit });
}
// The Rust parameter is `box_level` (`box` is a Rust keyword), so the wire
// key is `boxLevel` while the serialized ReviewState field stays `box`.
export function recordReviewOutcome(annotationId: string, state: ReviewState): Promise<void> {
  return invoke("record_review_outcome", {
    annotationId,
    boxLevel: state.box,
    dueAt: state.dueAt,
    lastReviewedAt: state.lastReviewedAt,
    suspended: state.suspended,
  });
}
export function reviewSummary(dayStartMs: number, nowMs: number): Promise<ReviewSummary> {
  return invoke("review_summary", { dayStartMs, nowMs });
}
export function searchAnnotations(query: string, limit: number): Promise<Annotation[]> {
  return invoke("search_annotations", { query, limit });
}
export function listAnnotationsForTransfer(): Promise<Annotation[]> {
  return invoke("list_annotations_for_transfer");
}
export function listDocumentFingerprints(): Promise<DocumentFingerprintEntry[]> {
  return invoke("list_document_fingerprints");
}
export function importAnnotations(
  annotations: Annotation[],
  fingerprints: DocumentFingerprintEntry[],
): Promise<number> {
  return invoke("import_annotations", { annotations, fingerprints });
}
// The Rust side opens the save dialog itself and only ever writes to the
// path picked there; null means the user cancelled.
export function exportAnnotationsFile(
  defaultName: string,
  contents: string,
): Promise<string | null> {
  return invoke("export_annotations_file", { defaultName, contents });
}
export function pickAnnotationsImportFile(): Promise<{
  fileName: string;
  contents: string;
} | null> {
  return invoke("pick_annotations_import_file");
}
export function recordReadingSession(session: ReadingSession): Promise<void> {
  return invoke("record_reading_session", { session });
}
export function listReadingSessions(fromMs: number, toMs: number): Promise<ReadingSession[]> {
  return invoke("list_reading_sessions", { fromMs, toMs });
}
export function openExternalLink(href: string): Promise<void> { return openUrl(href); }
export function onLibraryChanged(handler: () => void | Promise<void>): Promise<UnlistenFn> {
  return listen("library-changed", () => { void handler(); });
}
export function onLibraryIndexProgress(handler: (progress: IndexProgress) => void): Promise<UnlistenFn> {
  return listen<IndexProgress>("library-index-progress", (event) => handler(event.payload));
}
export function onDocumentIndexStatus(handler: (status: DocumentIndexEvent) => void): Promise<UnlistenFn> {
  return listen<DocumentIndexEvent>("document-index-status", (event) => handler(event.payload));
}
