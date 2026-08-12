/**
 * Shared validation pure functions for reading collections
 * (`docs/plan-collections.md` §3.1/§3.2) — the two-end contract points
 * used by the IndexedDB store (`webCollections.ts`) and mirrored by the
 * Rust validators in `src-tauri/src/user_store.rs`
 * (`validate_collection_id` / `validate_collection_name` /
 * `reorder_collection_item_rows`).
 */

/** Same cap and alphabet as annotation ids (`crypto.randomUUID` fits). */
export const MAX_COLLECTION_ID_CHARS = 64;
export const MAX_COLLECTION_NAME_CHARS = 100;

const COLLECTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateCollectionId(id: string): string {
  if (!id || Array.from(id).length > MAX_COLLECTION_ID_CHARS) {
    throw new Error("Collection id is invalid");
  }
  if (!COLLECTION_ID_PATTERN.test(id)) {
    throw new Error("Collection id contains unsupported characters");
  }
  return id;
}

/** Trimmed, non-empty, at most {@link MAX_COLLECTION_NAME_CHARS} chars. */
export function sanitizeCollectionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Collection name must not be empty");
  }
  if (Array.from(trimmed).length > MAX_COLLECTION_NAME_CHARS) {
    throw new Error(`Collection name exceeds ${MAX_COLLECTION_NAME_CHARS} characters`);
  }
  return trimmed;
}

/**
 * CO-D4 reorder gate: the reordered list must be exactly the current item
 * set — anything extra, missing or duplicated rejects the whole reorder
 * before any write.
 */
export function validateReorderedPaths(
  existingPaths: readonly string[],
  orderedPaths: readonly string[],
): void {
  const orderedSet = new Set(orderedPaths);
  if (
    orderedPaths.length !== existingPaths.length ||
    orderedSet.size !== orderedPaths.length ||
    existingPaths.some((path) => !orderedSet.has(path))
  ) {
    throw new Error("Reordered paths do not match the collection items");
  }
}
