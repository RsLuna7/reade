/**
 * Cross-restart reading position persistence (home-view plan §3.2, H0).
 *
 * localStorage key `reade-reading-positions` holds a version envelope
 * `{ version: 1, libraries: { [libraryRoot]: { [relativePath]: entry } } }`.
 * Entries are derived display hints, not anchors (same stance as
 * `BookmarkTarget`): `scrollRatio` is approximate after font or window
 * changes; bookmarks remain the precise anchor.
 *
 * Everything read from storage is untrusted: JSON parsing is fully guarded
 * and every entry is validated field by field — invalid entries are dropped
 * silently instead of failing the whole store.
 */

export const READING_POSITIONS_STORAGE_KEY = "reade-reading-positions";
export const READING_POSITIONS_VERSION = 1;
/** Per-library cap; the oldest entries by `updatedAt` are evicted first. */
export const READING_POSITIONS_LIBRARY_LIMIT = 200;

export type ReadingPosition =
  | {
      kind: "scroll";
      /** Reader scroll position, 0..1 of the scrollable range. */
      scrollRatio: number;
      /** Monotonic high-water mark (drives "读到 N%" and heatmap T2). */
      maxScrollRatio: number;
      /** Unix milliseconds. */
      updatedAt: number;
    }
  | {
      kind: "pdf";
      /** 1-based page number. */
      page: number;
      /** Offset within the page, 0..1. */
      offsetRatio: number;
      /** Monotonic high-water mark of the furthest visited page. */
      maxPage: number;
      /** Unix milliseconds. */
      updatedAt: number;
    };

export type ReadingPositionInput =
  | { kind: "scroll"; scrollRatio: number }
  | { kind: "pdf"; page: number; offsetRatio: number };

type LibraryPositions = Record<string, ReadingPosition>;

interface PositionsEnvelope {
  version: number;
  libraries: Record<string, LibraryPositions>;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Timestamps are always written in milliseconds; hand-edited or legacy
 * second-scale values are normalized with the same `< 10^10` heuristic as
 * `formatModified`, so LRU comparisons never mix units.
 */
function sanitizeUpdatedAt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

/** Field-by-field validation; anything unexpected drops the entry. */
export function sanitizeReadingPosition(value: unknown): ReadingPosition | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const updatedAt = sanitizeUpdatedAt(entry.updatedAt);
  if (updatedAt === null) return null;

  if (entry.kind === "scroll") {
    if (!isRatio(entry.scrollRatio) || !isRatio(entry.maxScrollRatio)) return null;
    return {
      kind: "scroll",
      scrollRatio: entry.scrollRatio,
      // The high-water mark is a write-side invariant; restore it here so a
      // corrupted max never reports less progress than the current position.
      maxScrollRatio: Math.max(entry.maxScrollRatio, entry.scrollRatio),
      updatedAt,
    };
  }

  if (entry.kind === "pdf") {
    const isPage = (candidate: unknown): candidate is number =>
      typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 1;
    if (!isPage(entry.page) || !isPage(entry.maxPage) || !isRatio(entry.offsetRatio)) {
      return null;
    }
    return {
      kind: "pdf",
      page: entry.page,
      offsetRatio: entry.offsetRatio,
      maxPage: Math.max(entry.maxPage, entry.page),
      updatedAt,
    };
  }

  return null;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function loadEnvelope(): PositionsEnvelope {
  const empty: PositionsEnvelope = { version: READING_POSITIONS_VERSION, libraries: {} };
  const store = storage();
  if (!store) return empty;

  let parsed: unknown;
  try {
    const raw = store.getItem(READING_POSITIONS_STORAGE_KEY);
    if (!raw) return empty;
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const envelope = parsed as Partial<PositionsEnvelope>;
  if (envelope.version !== READING_POSITIONS_VERSION) return empty;
  if (!envelope.libraries || typeof envelope.libraries !== "object") return empty;

  const libraries: Record<string, LibraryPositions> = {};
  for (const [root, entries] of Object.entries(envelope.libraries)) {
    if (!entries || typeof entries !== "object") continue;
    const sanitized: LibraryPositions = {};
    for (const [path, entry] of Object.entries(entries)) {
      const position = sanitizeReadingPosition(entry);
      if (position) sanitized[path] = position;
    }
    if (Object.keys(sanitized).length > 0) libraries[root] = sanitized;
  }
  return { version: READING_POSITIONS_VERSION, libraries };
}

function saveEnvelope(envelope: PositionsEnvelope): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(READING_POSITIONS_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Quota errors and private-mode restrictions lose only the position hint.
  }
}

export function readReadingPosition(
  libraryRoot: string,
  relativePath: string,
): ReadingPosition | null {
  return loadEnvelope().libraries[libraryRoot]?.[relativePath] ?? null;
}

/** Sanitized copy of one library's entries (web fallback and cold-start probe). */
export function listLibraryReadingPositions(
  libraryRoot: string,
): Record<string, ReadingPosition> {
  return loadEnvelope().libraries[libraryRoot] ?? {};
}

function evictOverLimit(library: LibraryPositions, limit: number): void {
  const paths = Object.keys(library);
  if (paths.length <= limit) return;
  paths
    .sort((a, b) => library[a].updatedAt - library[b].updatedAt)
    .slice(0, paths.length - limit)
    .forEach((path) => delete library[path]);
}

/**
 * Persists a position, merging the monotonic `maxScrollRatio`/`maxPage`
 * high-water marks with any existing entry of the same kind. Returns the
 * stored entry, or null when the input is unusable.
 */
export function writeReadingPosition(
  libraryRoot: string,
  relativePath: string,
  input: ReadingPositionInput,
  now: number = Date.now(),
): ReadingPosition | null {
  if (!libraryRoot || !relativePath) return null;
  if (typeof now !== "number" || !Number.isFinite(now) || now <= 0) return null;

  const envelope = loadEnvelope();
  const library = envelope.libraries[libraryRoot] ?? {};
  const existing = library[relativePath];

  let entry: ReadingPosition;
  if (input.kind === "scroll") {
    if (typeof input.scrollRatio !== "number" || !Number.isFinite(input.scrollRatio)) {
      return null;
    }
    const scrollRatio = clamp01(input.scrollRatio);
    const previousMax = existing?.kind === "scroll" ? existing.maxScrollRatio : 0;
    entry = {
      kind: "scroll",
      scrollRatio,
      maxScrollRatio: Math.max(previousMax, scrollRatio),
      updatedAt: now,
    };
  } else if (input.kind === "pdf") {
    if (
      typeof input.page !== "number" ||
      !Number.isFinite(input.page) ||
      Math.floor(input.page) < 1 ||
      typeof input.offsetRatio !== "number" ||
      !Number.isFinite(input.offsetRatio)
    ) {
      return null;
    }
    const page = Math.floor(input.page);
    const previousMax = existing?.kind === "pdf" ? existing.maxPage : 1;
    entry = {
      kind: "pdf",
      page,
      offsetRatio: clamp01(input.offsetRatio),
      maxPage: Math.max(previousMax, page),
      updatedAt: now,
    };
  } else {
    return null;
  }

  library[relativePath] = entry;
  evictOverLimit(library, READING_POSITIONS_LIBRARY_LIMIT);
  envelope.libraries[libraryRoot] = library;
  saveEnvelope(envelope);
  return entry;
}
