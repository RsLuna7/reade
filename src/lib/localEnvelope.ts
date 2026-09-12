/**
 * Shared scaffolding for the `{ version, libraries: { [libraryKey]: ... } }`
 * localStorage envelopes used by browsing/progress state.
 *
 * Before this module each store re-implemented the same parse/sanitize/save
 * block, and the copies drifted on the two behaviors that decide whether user
 * state survives: how a library key is computed (`libraryKey.ts`) and what
 * happens when two stored keys normalize onto the same library. The naive
 * `libraries[key] = sanitized` loop silently dropped every earlier bucket, so
 * state written under a second spelling of the same library was destroyed on
 * the next load.
 *
 * Loading therefore normalizes every key and *merges* colliding libraries,
 * which also transparently re-keys envelopes written before normalization
 * existed (the caller saves the merged result on its next write).
 */

import { normalizeLibraryKey } from "./libraryKey";

export interface LibraryEnvelope<T> {
  version: number;
  libraries: Record<string, T>;
}

/**
 * localStorage, or null when unavailable (SSR, private mode, blocked).
 * Reading or writing storage is a preference-level convenience: every caller
 * degrades to in-memory defaults rather than failing the action that triggered it.
 */
export function localStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Timestamps are always persisted in milliseconds. Legacy or hand-edited
 * second-scale values are lifted so LRU comparisons and "last read" formatting
 * never mix units. Returns null when unusable.
 *
 * Only values that could plausibly *be* epoch seconds are lifted. A blanket
 * `< 10^10` rule is not idempotent: a genuinely small millisecond stamp would
 * be multiplied again on every load, and after a few writes the oldest entries
 * outrank the newest, so eviction starts discarding the wrong end. Requiring a
 * floor keeps the conversion stable under repeated reads.
 */
export const EPOCH_SECONDS_MIN = 100_000_000; // 1973-03-03, below any real stored stamp
export const EPOCH_SECONDS_MAX = 10_000_000_000; // year 2286 in seconds

export function sanitizeEpochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= EPOCH_SECONDS_MIN && value < EPOCH_SECONDS_MAX) return value * 1000;
  return value;
}

export interface LoadLibraryEnvelopeOptions<T> {
  storageKey: string;
  version: number;
  /**
   * Validates one library's raw entry map. Return null when nothing in it is
   * usable, so empty buckets are not materialized.
   */
  sanitizeLibrary: (raw: unknown) => T | null;
  /**
   * Folds a colliding library's entries into the ones already collected.
   * `incoming` came from a later key in storage order.
   */
  mergeLibrary: (existing: T, incoming: T) => T;
}

/**
 * Parses a versioned library envelope, dropping malformed content silently and
 * collapsing equivalent library spellings onto one merged bucket.
 */
export function loadLibraryEnvelope<T>(
  options: LoadLibraryEnvelopeOptions<T>,
): LibraryEnvelope<T> {
  const empty = (): LibraryEnvelope<T> => ({
    version: options.version,
    libraries: Object.create(null) as Record<string, T>,
  });
  const store = localStorageOrNull();
  if (!store) return empty();

  let parsed: unknown;
  try {
    const raw = store.getItem(options.storageKey);
    if (!raw) return empty();
    parsed = JSON.parse(raw);
  } catch {
    return empty();
  }
  if (!parsed || typeof parsed !== "object") return empty();
  const envelope = parsed as Partial<LibraryEnvelope<unknown>>;
  if (envelope.version !== options.version) return empty();
  if (!envelope.libraries || typeof envelope.libraries !== "object") return empty();

  // Null-prototype map: a stored library literally named `__proto__` (or
  // `constructor`) must become an ordinary key instead of touching the
  // prototype chain, which would silently drop the entry and could poison
  // lookups for unrelated libraries.
  const libraries = Object.create(null) as Record<string, T>;
  for (const [root, rawLibrary] of Object.entries(envelope.libraries)) {
    if (typeof root !== "string" || !root.trim()) continue;
    const sanitized = options.sanitizeLibrary(rawLibrary);
    if (sanitized === null) continue;
    const key = normalizeLibraryKey(root);
    if (Object.prototype.hasOwnProperty.call(libraries, key)) {
      libraries[key] = options.mergeLibrary(libraries[key], sanitized);
    } else {
      libraries[key] = sanitized;
    }
  }
  return { version: options.version, libraries };
}

/**
 * Writes a versioned library envelope. Returns false when storage is
 * unavailable or the write was rejected (quota / private mode), so callers can
 * avoid notifying subscribers about a change that never landed.
 */
export function saveLibraryEnvelope<T>(
  storageKey: string,
  envelope: LibraryEnvelope<T>,
): boolean {
  const store = localStorageOrNull();
  if (!store) return false;
  try {
    store.setItem(storageKey, JSON.stringify(envelope));
    return true;
  } catch {
    // Losing these hints never blocks the action that triggered the write.
    return false;
  }
}
