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

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function sanitizeUpdatedAt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
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
  const updatedAt = sanitizeUpdatedAt(entry.updatedAt);
  if (updatedAt === null) return null;
  if (!isInt(entry.offset) || entry.offset === 0) return null;
  if (!isInt(entry.atPhysical) || entry.atPhysical < 1) return null;
  return {
    offset: entry.offset,
    atPhysical: entry.atPhysical,
    updatedAt,
  };
}

function loadEnvelope(): OffsetsEnvelope {
  const empty: OffsetsEnvelope = { version: PDF_PAGE_OFFSETS_VERSION, libraries: {} };
  const store = storage();
  if (!store) return empty;

  let parsed: unknown;
  try {
    const raw = store.getItem(PDF_PAGE_OFFSETS_STORAGE_KEY);
    if (!raw) return empty;
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const envelope = parsed as Partial<OffsetsEnvelope>;
  if (envelope.version !== PDF_PAGE_OFFSETS_VERSION) return empty;
  if (!envelope.libraries || typeof envelope.libraries !== "object") return empty;

  const libraries: Record<string, LibraryOffsets> = {};
  for (const [root, entries] of Object.entries(envelope.libraries)) {
    if (!entries || typeof entries !== "object") continue;
    const sanitized: LibraryOffsets = {};
    for (const [path, entry] of Object.entries(entries)) {
      const offset = sanitizePdfPageOffsetEntry(entry);
      if (offset) sanitized[path] = offset;
    }
    if (Object.keys(sanitized).length > 0) libraries[root] = sanitized;
  }
  return { version: PDF_PAGE_OFFSETS_VERSION, libraries };
}

function saveEnvelope(envelope: OffsetsEnvelope): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PDF_PAGE_OFFSETS_STORAGE_KEY, JSON.stringify(envelope));
    notifyOffsetListeners();
  } catch {
    // Quota / private-mode: lose only the calibration hint.
  }
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
  return loadEnvelope().libraries[libraryRoot]?.[relativePath] ?? null;
}

export function listLibraryPdfPageOffsets(
  libraryRoot: string,
): Record<string, PdfPageOffsetEntry> {
  return loadEnvelope().libraries[libraryRoot] ?? {};
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

  const envelope = loadEnvelope();
  const library = envelope.libraries[libraryRoot] ?? {};
  const entry: PdfPageOffsetEntry = {
    offset: input.offset,
    atPhysical: input.atPhysical,
    updatedAt: now,
  };
  library[relativePath] = entry;
  evictOverLimit(library, PDF_PAGE_OFFSETS_LIBRARY_LIMIT);
  envelope.libraries[libraryRoot] = library;
  saveEnvelope(envelope);
  return entry;
}

export function deletePdfPageOffset(libraryRoot: string, relativePath: string): void {
  if (!libraryRoot || !relativePath) return;
  const envelope = loadEnvelope();
  const library = envelope.libraries[libraryRoot];
  if (!library || !(relativePath in library)) return;
  delete library[relativePath];
  if (Object.keys(library).length === 0) delete envelope.libraries[libraryRoot];
  else envelope.libraries[libraryRoot] = library;
  saveEnvelope(envelope);
}
