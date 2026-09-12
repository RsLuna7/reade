import type { DocumentFormat, DocumentInfo, ReadingSession } from "./backend";
import { loadLibraryEnvelope, saveLibraryEnvelope } from "./localEnvelope";
import { normalizeLibraryKey } from "./libraryKey";
import type { ReadingPosition } from "./readingPositions";
import { aggregateByDocument, sessionsInLibrary } from "./readingStats";

/**
 * Pure aggregation helpers for the home ("今日") view — home-view plan §3.3.
 *
 * The home view adds no data collection of its own: everything here is
 * assembled from reading sessions, persisted reading positions and the
 * document list the library scan already provides.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Sessions older than this are ignored by the continue-reading card. */
export const CONTINUE_READING_WINDOW_MS = 30 * DAY_MS;
export const CONTINUE_READING_LIMIT = 5;
export const FRESH_DOCUMENTS_LIMIT = 5;

export type HomeProgress =
  | {
      /** Furthest scroll progress, 0..1 (`maxScrollRatio`). */
      kind: "ratio";
      value: number;
    }
  | {
      /** Furthest visited PDF page (`maxPage`); total pages are unknown here. */
      kind: "page";
      page: number;
    };

export interface ContinueReadingItem {
  relativePath: string;
  title: string | null;
  format: DocumentFormat;
  /** Unix ms of the latest session end (desktop) or position update (web). */
  lastReadAt: number;
  /** Engaged seconds aggregated inside the window; 0 in the web fallback. */
  totalSeconds: number;
  progress: HomeProgress | null;
}

export function progressFromPosition(
  position: ReadingPosition | undefined | null,
): HomeProgress | null {
  if (!position) return null;
  if (position.kind === "scroll") return { kind: "ratio", value: position.maxScrollRatio };
  return { kind: "page", page: position.maxPage };
}

/**
 * Desktop continue-reading list: sessions from the last 30 days, aggregated
 * per document, restricted to documents that still exist in the current
 * library, newest `lastReadAt` first. `libraryRoot` drops sessions recorded
 * against a different folder so a colliding relative path cannot sneak in.
 */
export function buildContinueReading(
  sessions: ReadingSession[],
  documents: DocumentInfo[],
  positions: Record<string, ReadingPosition>,
  nowMs: number,
  limit: number = CONTINUE_READING_LIMIT,
  libraryRoot?: string,
): ContinueReadingItem[] {
  const cutoff = nowMs - CONTINUE_READING_WINDOW_MS;
  const scoped = libraryRoot ? sessionsInLibrary(sessions, libraryRoot) : sessions;
  const windowed = scoped.filter((session) => session.endedAt >= cutoff);
  const byPath = new Map(documents.map((document) => [document.relativePath, document]));
  return aggregateByDocument(windowed)
    .filter((total) => byPath.has(total.relativePath))
    .sort((a, b) => b.lastReadAt - a.lastReadAt || b.seconds - a.seconds)
    .slice(0, Math.max(0, limit))
    .map((total) => {
      const document = byPath.get(total.relativePath);
      return {
        relativePath: total.relativePath,
        title: document?.title ?? total.title,
        format: document?.format ?? total.format,
        lastReadAt: total.lastReadAt,
        totalSeconds: total.seconds,
        progress: progressFromPosition(positions[total.relativePath]),
      };
    });
}

/**
 * Web fallback (no session store): persisted reading positions ordered by
 * `updatedAt`, restricted to documents present in the manifest.
 */
export function buildWebContinueReading(
  documents: DocumentInfo[],
  positions: Record<string, ReadingPosition>,
  limit: number = CONTINUE_READING_LIMIT,
): ContinueReadingItem[] {
  const byPath = new Map(documents.map((document) => [document.relativePath, document]));
  return Object.entries(positions)
    .filter(([path]) => byPath.has(path))
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(0, limit))
    .map(([path, position]) => {
      const document = byPath.get(path);
      return {
        relativePath: path,
        title: document?.title ?? null,
        format: document?.format ?? "markdown",
        lastReadAt: position.updatedAt,
        totalSeconds: 0,
        progress: progressFromPosition(position),
      };
    });
}

/**
 * Cold-start probe (decision H-D1, option A): the home view is a worthwhile
 * landing only when the continue-reading card would have at least one row —
 * a persisted position or a recent session for a document still in the
 * library.
 */
export function hasContinueCandidates(
  documents: DocumentInfo[],
  positions: Record<string, ReadingPosition>,
  sessions: ReadingSession[],
): boolean {
  const present = new Set(documents.map((document) => document.relativePath));
  if (Object.keys(positions).some((path) => present.has(path))) return true;
  return sessions.some((session) => present.has(session.relativePath));
}

/**
 * `DocumentInfo.modified` is ambiguous between seconds and milliseconds
 * depending on the source; normalize with the same `< 10^10` heuristic as
 * `formatModified` before comparing against baselines.
 */
export function normalizeModifiedMs(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}

export interface FreshDocuments {
  /** Total number of documents newer than the baseline. */
  count: number;
  /** Newest first, capped at the display limit. */
  items: DocumentInfo[];
}

/**
 * Documents modified after the last home visit. A missing baseline (first
 * visit) reports nothing: "new since last time" is undefined until a first
 * visit establishes the reference point.
 */
export function buildFreshDocuments(
  documents: DocumentInfo[],
  baselineMs: number | null,
  limit: number = FRESH_DOCUMENTS_LIMIT,
): FreshDocuments {
  if (baselineMs === null || !Number.isFinite(baselineMs)) return { count: 0, items: [] };
  const fresh = documents
    .filter((document) => normalizeModifiedMs(document.modified) > baselineMs)
    .sort((a, b) => normalizeModifiedMs(b.modified) - normalizeModifiedMs(a.modified));
  return { count: fresh.length, items: fresh.slice(0, Math.max(0, limit)) };
}

/* ------------------------- Home baseline storage ------------------------- */

export const HOME_BASELINE_STORAGE_KEY = "reade-home-baseline";
export const HOME_BASELINE_VERSION = 1;

interface BaselineEnvelope {
  version: number;
  libraries: Record<string, number>;
}

function loadBaselines(): BaselineEnvelope {
  return loadLibraryEnvelope<number>({
    storageKey: HOME_BASELINE_STORAGE_KEY,
    version: HOME_BASELINE_VERSION,
    sanitizeLibrary: (raw) =>
      typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null,
    // Two spellings of one library: keep the more recent visit.
    mergeLibrary: (existing, incoming) => Math.max(existing, incoming),
  });
}

/** Baseline of the last home visit for a library; null before the first visit. */
export function readHomeBaseline(libraryRoot: string): number | null {
  return loadBaselines().libraries[normalizeLibraryKey(libraryRoot)] ?? null;
}

export function writeHomeBaseline(libraryRoot: string, nowMs: number = Date.now()): void {
  if (!libraryRoot || typeof nowMs !== "number" || !Number.isFinite(nowMs) || nowMs <= 0) {
    return;
  }
  const envelope = loadBaselines();
  envelope.libraries[normalizeLibraryKey(libraryRoot)] = nowMs;
  saveLibraryEnvelope(HOME_BASELINE_STORAGE_KEY, envelope);
}
