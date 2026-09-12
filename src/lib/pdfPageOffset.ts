/**
 * PDF printed-page calibration (plan-pdf-tactical-nav A1).
 *
 * File (physical) pages stay the locator truth. The stored offset only
 * changes what the toolbar, page-corner badge and reading-mode labels show
 * and how typed page numbers are interpreted:
 *
 *   physical = printed + offset
 *   printed  = physical - offset
 *   offset   = physical - printed   // written at calibration
 *
 * Persistence is a dedicated localStorage envelope, not readingPositions
 * (those are LRU'd as "where I was" and must not evict calibration).
 */

import { loadLibraryEnvelope, saveLibraryEnvelope, sanitizeEpochMs } from "./localEnvelope";
import { normalizeLibraryKey } from "./libraryKey";

export const PDF_PAGE_OFFSETS_STORAGE_KEY = "reade-pdf-page-offsets";
export const PDF_PAGE_OFFSETS_VERSION = 1;
/** Per-library cap; oldest entries by `updatedAt` are evicted first. */
export const PDF_PAGE_OFFSETS_LIBRARY_LIMIT = 200;

export interface PdfPageOffsetEntry {
  /** physical − printed. Zero means uncalibrated. */
  offset: number;
  /** File page where the user calibrated; display/debug only. */
  atPhysical: number;
  /** Unix milliseconds. */
  updatedAt: number;
}

type LibraryOffsets = Record<string, PdfPageOffsetEntry>;

interface OffsetsEnvelope {
  version: number;
  libraries: Record<string, LibraryOffsets>;
}

type OffsetListener = () => void;

const listeners = new Set<OffsetListener>();

/** In-tab fan-out so a second PdfReader (split pane) re-reads after a write. */
export function subscribePdfPageOffsets(listener: OffsetListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyOffsetListeners(): void {
  for (const listener of listeners) listener();
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function physicalFromPrinted(printed: number, offset: number): number {
  return printed + offset;
}

export function printedFromPhysical(physical: number, offset: number): number {
  return physical - offset;
}

export function offsetFromCalibration(physical: number, printed: number): number {
  return physical - printed;
}

/**
 * Visible page number: printed when ≥ 1, otherwise the file page.
 * Never returns 0 or a negative number.
 */
export function displayPageNumber(physical: number, offset: number): number {
  const printed = physical - offset;
  return printed < 1 ? physical : printed;
}

/**
 * Toolbar input accessible name. Uncalibrated copy stays "当前页" so the
 * existing control is unchanged; calibrated copy includes both numbers.
 */
export function pageInputAriaLabel(physical: number, offset: number, numPages: number): string {
  if (offset === 0) return "当前页";
  const printed = physical - offset;
  if (printed < 1) {
    return `文件第 ${physical} 页，共 ${numPages} 页`;
  }
  return `印刷第 ${printed} 页，文件第 ${physical} 页，共 ${numPages} 页`;
}

/**
 * Rejects calibrations that cannot map a ≥1 printed number onto the file.
 * `printed` must be a ≥1 integer; `|offset|` must be strictly less than
 * `numPages`; at least one file page must have printed ≥ 1.
 */
export function isValidCalibration(physical: number, printed: number, numPages: number): boolean {
  if (!isInt(physical) || !isInt(printed) || !isInt(numPages)) return false;
  if (printed < 1 || physical < 1 || numPages < 1 || physical > numPages) return false;
  const offset = physical - printed;
  if (Math.abs(offset) >= numPages) return false;
  return numPages - offset >= 1;
}

/** Drop a stored offset that could not apply to this document's page count. */
export function effectiveOffset(offset: number, numPages: number): number {
  if (!isInt(offset) || offset === 0 || numPages < 1) return 0;
  if (Math.abs(offset) >= numPages) return 0;
  if (numPages - offset < 1) return 0;
  return offset;
}

export function sanitizePdfPageOffsetEntry(value: unknown): PdfPageOffsetEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const updatedAt = sanitizeEpochMs(entry.updatedAt);
  if (updatedAt === null) return null;
  if (!isInt(entry.offset) || entry.offset === 0) return null;
  if (!isInt(entry.atPhysical) || entry.atPhysical < 1) return null;
  return {
    offset: entry.offset,
    atPhysical: entry.atPhysical,
    updatedAt,
  };
}

function sanitizeLibraryOffsets(raw: unknown): LibraryOffsets | null {
  if (!raw || typeof raw !== "object") return null;
  const sanitized: LibraryOffsets = {};
  for (const [path, entry] of Object.entries(raw as Record<string, unknown>)) {
    const offset = sanitizePdfPageOffsetEntry(entry);
    if (offset) sanitized[path] = offset;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

/** Two buckets for the same library union their documents; newest calibration wins. */
function mergeLibraryOffsets(
  existing: LibraryOffsets,
  incoming: LibraryOffsets,
): LibraryOffsets {
  const merged: LibraryOffsets = { ...existing };
  for (const [path, entry] of Object.entries(incoming)) {
    const current = merged[path];
    if (!current || entry.updatedAt >= current.updatedAt) merged[path] = entry;
  }
  return merged;
}

function loadEnvelope(): OffsetsEnvelope {
  return loadLibraryEnvelope<LibraryOffsets>({
    storageKey: PDF_PAGE_OFFSETS_STORAGE_KEY,
    version: PDF_PAGE_OFFSETS_VERSION,
    sanitizeLibrary: sanitizeLibraryOffsets,
    mergeLibrary: mergeLibraryOffsets,
  });
}

function saveEnvelope(envelope: OffsetsEnvelope): void {
  if (saveLibraryEnvelope(PDF_PAGE_OFFSETS_STORAGE_KEY, envelope)) notifyOffsetListeners();
}

function evictOverLimit(library: LibraryOffsets, limit: number): void {
  const paths = Object.keys(library);
  if (paths.length <= limit) return;
  paths
    .sort((a, b) => library[a].updatedAt - library[b].updatedAt)
    .slice(0, paths.length - limit)
    .forEach((path) => delete library[path]);
}

export function readPdfPageOffset(
  libraryRoot: string,
  relativePath: string,
): PdfPageOffsetEntry | null {
  return loadEnvelope().libraries[normalizeLibraryKey(libraryRoot)]?.[relativePath] ?? null;
}

export function listLibraryPdfPageOffsets(
  libraryRoot: string,
): Record<string, PdfPageOffsetEntry> {
  return loadEnvelope().libraries[normalizeLibraryKey(libraryRoot)] ?? {};
}

export function writePdfPageOffset(
  libraryRoot: string,
  relativePath: string,
  input: { offset: number; atPhysical: number },
  now: number = Date.now(),
): PdfPageOffsetEntry | null {
  if (!libraryRoot || !relativePath) return null;
  if (typeof now !== "number" || !Number.isFinite(now) || now <= 0) return null;
  if (!isInt(input.offset) || input.offset === 0) return null;
  if (!isInt(input.atPhysical) || input.atPhysical < 1) return null;

  const libraryKey = normalizeLibraryKey(libraryRoot);
  const envelope = loadEnvelope();
  const library = envelope.libraries[libraryKey] ?? {};
  const entry: PdfPageOffsetEntry = {
    offset: input.offset,
    atPhysical: input.atPhysical,
    updatedAt: now,
  };
  library[relativePath] = entry;
  evictOverLimit(library, PDF_PAGE_OFFSETS_LIBRARY_LIMIT);
  envelope.libraries[libraryKey] = library;
  saveEnvelope(envelope);
  return entry;
}

export function deletePdfPageOffset(libraryRoot: string, relativePath: string): void {
  if (!libraryRoot || !relativePath) return;
  const libraryKey = normalizeLibraryKey(libraryRoot);
  const envelope = loadEnvelope();
  const library = envelope.libraries[libraryKey];
  if (!library || !(relativePath in library)) return;
  delete library[relativePath];
  if (Object.keys(library).length === 0) delete envelope.libraries[libraryKey];
  else envelope.libraries[libraryKey] = library;
  saveEnvelope(envelope);
}
