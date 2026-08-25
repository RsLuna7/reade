import type { Annotation, AnnotationSearchHit, ReviewQueueItem, ReviewSummary } from "./backend";
import type { Excerpt, ReviewEnrollment } from "./annotationModel";
import { annotationMatchesQuery, normalizeAnnotationQuery } from "./annotationSearch";
import { deriveAnnotationSortIndex, isValidSortIndex } from "./annotations";
import {
  detectMovedDocumentCandidates,
  type MovedDocumentCandidate,
} from "./documentMoves";
import { isReviewableAnnotation, REVIEW_MAX_BOX, type ReviewState } from "./reviewScheduler";
import type { WebCollectionItemRecord } from "./webCollections";
import { validateLibraryRelativePath } from "./webLibrary";
import {
  createAnnotationV6Stores,
  ensureAnnotationV6Migrated,
  projectAnnotationIntoV6,
  rebindV6Paths,
  removeV6EntriesForPath,
  V6_WRITE_STORES,
} from "./webAnnotationV6";

const DB_NAME = "reade-annotations";
const STORE_NAME = "annotations";
/** Fingerprints of previously seen documents (`user_store.rs` `documents`). */
const DOCUMENTS_STORE = "documents";
/** Review state rows (`user_store.rs` `annotation_reviews`). */
const REVIEWS_STORE = "annotationReviews";
/** Collection rows (`user_store.rs` `collections`), used by `webCollections.ts`. */
export const COLLECTIONS_STORE = "collections";
/** Collection membership rows (`user_store.rs` `collection_items`). */
export const COLLECTION_ITEMS_STORE = "collectionItems";
/**
 * Version 1: plain store (keyPath `id`, `relativePath` index), physical
 * deletes. Version 2 mirrors the desktop user database (`user_store.rs`
 * schema v2): `sortIndex`/`deletedAt` are backfilled onto old records,
 * deleting writes a tombstone, listing filters tombstones, clearing a
 * document purges physically, and expired tombstones are purged on open.
 * Version 3 mirrors desktop schema v3: a `documents` store keyed by
 * `relativePath` holds the manifest content fingerprints that back the
 * move-detection rebind chain; rows for vanished paths are retained on
 * purpose. Version 4 mirrors desktop schema v4: an `annotationReviews`
 * store (keyPath `annotationId`) holds the spaced-repetition state; rows
 * are created lazily on the first outcome, never backfilled. Version 5
 * mirrors desktop schema v5 (plan-collections §3.1): a `collections`
 * store (keyPath `id`) plus a `collectionItems` store (composite keyPath
 * `[collectionId, relativePath]`, `collectionId` index; if the composite
 * keyPath ever misbehaves in a real browser, the documented fallback is a
 * `${collectionId}\u001f${relativePath}` string key). The upgrade steps
 * run sequentially like the desktop migration chain.
 */
const DB_VERSION = 6;
/** Tombstoned annotations are physically purged 90 days after deletion. */
const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** `dueAt` window, mirroring the desktop validation: [now − 1h, now + 180d]. */
const REVIEW_DUE_PAST_SLACK_MS = 60 * 60 * 1000;
const REVIEW_DUE_FUTURE_LIMIT_MS = 180 * DAY_MS;
/** Queue requests over-fetch ×3, like `list_review_queue` on the desktop. */
const REVIEW_QUEUE_OVERFETCH = 3;
const MAX_REVIEW_QUEUE_LIMIT = 500;
/** Search queries are truncated to this many chars before normalization. */
const MAX_SEARCH_QUERY_CHARS = 256;
const MAX_ANNOTATION_SEARCH_RESULTS = 500;

let dbPromise: Promise<IDBDatabase> | null = null;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Annotation request failed"));
  });
}

/**
 * v1 → v2 backfill, run inside the `versionchange` transaction: old records
 * gain `deletedAt: null` and a derived `sortIndex` (records whose locator
 * cannot be interpreted get the broken fallback key and sort last, matching
 * the desktop backfill).
 */
function backfillV2Records(store: IDBObjectStore): void {
  const cursorRequest = store.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    const record = cursor.value as Annotation;
    cursor.update({
      ...record,
      sortIndex:
        typeof record.sortIndex === "string" && isValidSortIndex(record.sortIndex)
          ? record.sortIndex
          : deriveAnnotationSortIndex(record.locator),
      deletedAt: record.deletedAt ?? null,
    });
    cursor.continue();
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      // Step 1: the v1 store and its relativePath index.
      if (event.oldVersion < 1) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("relativePath", "relativePath", { unique: false });
      }
      // Step 2: backfill sortIndex/deletedAt onto pre-v2 records (a no-op on
      // the store step 1 just created).
      if (event.oldVersion < 2) {
        backfillV2Records(request.transaction!.objectStore(STORE_NAME));
      }
      // Step 3: the document fingerprint store (desktop `documents` table).
      if (event.oldVersion < 3) {
        db.createObjectStore(DOCUMENTS_STORE, { keyPath: "relativePath" });
      }
      // Step 4: the review state store (desktop `annotation_reviews` table).
      if (event.oldVersion < 4) {
        db.createObjectStore(REVIEWS_STORE, { keyPath: "annotationId" });
      }
      // Step 5: the collection stores (desktop `collections` +
      // `collection_items` tables).
      if (event.oldVersion < 5) {
        db.createObjectStore(COLLECTIONS_STORE, { keyPath: "id" });
        const items = db.createObjectStore(COLLECTION_ITEMS_STORE, {
          keyPath: ["collectionId", "relativePath"],
        });
        items.createIndex("collectionId", "collectionId", { unique: false });
      }
      // Step 6: v6 excerpt / reading-place / reflection stores plus a
      // migration ledger. Legacy stores stay; dual-write keeps them current.
      if (event.oldVersion < 6) {
        createAnnotationV6Stores(db);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Cannot open annotation store"));
  });
}

/**
 * Deletes tombstones older than the retention window and, mirroring the
 * desktop `purge_expired_tombstones`, drops review rows whose annotation no
 * longer exists. A live tombstone keeps its review row so undoing a
 * deletion restores the progress. Callback-driven so the single readwrite
 * transaction stays open across both passes.
 */
function purgeExpiredTombstones(db: IDBDatabase, now: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cutoff = now - TOMBSTONE_RETENTION_MS;
    const tx = db.transaction([STORE_NAME, REVIEWS_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Cannot clean up annotation tombstones"));
    tx.onabort = () => reject(tx.error ?? new Error("Cannot clean up annotation tombstones"));
    const survivors = new Set<string>();
    const cursorRequest = tx.objectStore(STORE_NAME).openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        // The annotation pass is done; orphaned review rows go next.
        const reviewCursorRequest = tx.objectStore(REVIEWS_STORE).openCursor();
        reviewCursorRequest.onsuccess = () => {
          const reviewCursor = reviewCursorRequest.result;
          if (!reviewCursor) return;
          const review = reviewCursor.value as WebReviewRecord;
          if (!survivors.has(review.annotationId)) reviewCursor.delete();
          reviewCursor.continue();
        };
        return;
      }
      const record = cursor.value as Annotation;
      if (typeof record.deletedAt === "number" && record.deletedAt < cutoff) {
        cursor.delete();
      } else {
        survivors.add(record.id);
      }
      cursor.continue();
    };
  });
}

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= (async () => {
    try {
      const db = await openDatabase();
      await purgeExpiredTombstones(db, Date.now());
      await ensureAnnotationV6Migrated(db);
      return db;
    } catch (error) {
      dbPromise = null;
      throw error;
    }
  })();
  return dbPromise;
}

/** Closes the cached connection so tests can swap the global `indexedDB`. */
export function resetWebAnnotationStoreForTests(): void {
  void dbPromise?.then((db) => db.close()).catch(() => undefined);
  dbPromise = null;
}

/**
 * Shared handle to the user database for sibling stores in the same file
 * (`webCollections.ts`): one connection, one upgrade chain, one purge
 * pass — the web twin of every store living in `reade-user.sqlite3`.
 */
export function openWebUserDatabase(): Promise<IDBDatabase> {
  return openDb();
}

function v6WriteStores(db: IDBDatabase): string[] {
  const names = new Set<string>([STORE_NAME, DOCUMENTS_STORE]);
  for (const name of V6_WRITE_STORES) {
    if (db.objectStoreNames.contains(name)) names.add(name);
  }
  return [...names];
}

async function projectLegacyIntoV6(tx: IDBTransaction, record: Annotation): Promise<void> {
  if (!tx.objectStoreNames.contains("excerpts")) return;
  const fingerprint = (await requestToPromise(
    tx.objectStore(DOCUMENTS_STORE).get(record.relativePath),
  )) as WebDocumentFingerprint | undefined;
  const existingExcerpt = (await requestToPromise(
    tx.objectStore("excerpts").get(record.id),
  )) as Excerpt | undefined;
  projectAnnotationIntoV6(tx, record, fingerprint, "capture", existingExcerpt);
}

export async function listWebAnnotations(relativePath: string | null): Promise<Annotation[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const matches = relativePath
    ? await requestToPromise(
        store.index("relativePath").getAll(relativePath) as IDBRequest<Annotation[]>,
      )
    : await requestToPromise(store.getAll() as IDBRequest<Annotation[]>);
  return matches
    .filter((annotation) => annotation.deletedAt == null)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export async function upsertWebAnnotation(annotation: Annotation): Promise<Annotation> {
  // Same fallback semantics as the desktop command: derive a missing sort
  // key from the locator, reject malformed ones.
  const record: Annotation = {
    ...annotation,
    sortIndex: annotation.sortIndex || deriveAnnotationSortIndex(annotation.locator),
    deletedAt: annotation.deletedAt ?? null,
  };
  if (!isValidSortIndex(record.sortIndex)) {
    throw new Error("Annotation sort index is invalid");
  }
  const db = await openDb();
  const tx = db.transaction(v6WriteStores(db), "readwrite");
  await requestToPromise(tx.objectStore(STORE_NAME).put(record));
  await projectLegacyIntoV6(tx, record);
  await transactionDone(tx);
  return record;
}

/**
 * Deleting writes a tombstone (mirroring the desktop semantics) so the
 * record survives until the retention purge; an already tombstoned or
 * missing id is an error, like on the desktop.
 */
export async function deleteWebAnnotation(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(v6WriteStores(db), "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const existing = (await requestToPromise(store.get(id))) as Annotation | undefined;
  if (!existing || existing.deletedAt != null) {
    throw new Error("Annotation was not found");
  }
  const now = Date.now();
  const tombstone: Annotation = { ...existing, deletedAt: now, updatedAt: now };
  await requestToPromise(store.put(tombstone));
  await projectLegacyIntoV6(tx, tombstone);
  await transactionDone(tx);
}

/** Explicitly clearing a document purges its rows physically, tombstones included. */
export async function clearWebDocumentAnnotations(relativePath: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(v6WriteStores(db), "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const index = store.index("relativePath");
  const matches = await requestToPromise(index.getAllKeys(relativePath) as IDBRequest<IDBValidKey[]>);
  await Promise.all(matches.map((key) => requestToPromise(store.delete(key))));
  if (tx.objectStoreNames.contains("excerpts")) {
    removeV6EntriesForPath(tx, relativePath);
  }
  await transactionDone(tx);
}

// ---- Annotation transfer (export/import, §5.7) ----

/** Import caps shared with `annotationTransfer.ts` and the desktop command. */
const MAX_IMPORT_ANNOTATIONS = 10_000;
const MAX_IMPORT_FINGERPRINTS = 2_000;

function compareTransferOrder(a: Annotation, b: Annotation): number {
  return (
    compareStrings(a.relativePath, b.relativePath) ||
    compareStrings(a.sortIndex, b.sortIndex) ||
    compareStrings(a.id, b.id)
  );
}

/**
 * Every stored annotation — tombstones included — in stable
 * `(relativePath, sortIndex, id)` order; the web twin of the desktop
 * `list_annotations_for_transfer` command (export source + import LWW base).
 */
export async function listWebAnnotationsForTransfer(): Promise<Annotation[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readonly");
  const records = await requestToPromise(
    tx.objectStore(STORE_NAME).getAll() as IDBRequest<Annotation[]>,
  );
  return records.sort(compareTransferOrder);
}

/** All stored fingerprint rows (vanished paths included), path-sorted. */
export async function listWebDocumentFingerprints(): Promise<
  Array<{ relativePath: string; contentHash: string }>
> {
  const db = await openDb();
  const tx = db.transaction(DOCUMENTS_STORE, "readonly");
  const rows = await requestToPromise(
    tx.objectStore(DOCUMENTS_STORE).getAll() as IDBRequest<WebDocumentFingerprint[]>,
  );
  return rows
    .map((row) => ({ relativePath: row.relativePath, contentHash: row.contentHash }))
    .sort((a, b) => compareStrings(a.relativePath, b.relativePath));
}

/**
 * Applies a planned import (`planAnnotationImport`) in one readwrite
 * transaction, mirroring the desktop `import_annotations` command: records
 * are validated first (no partial writes), envelope fingerprints only seed
 * rows for paths absent from the current manifest and never overwrite
 * existing rows. Returns the number of annotation records written.
 */
export async function importWebAnnotations(
  records: readonly Annotation[],
  fingerprints: ReadonlyArray<{ relativePath: string; contentHash: string }>,
  presentPaths: ReadonlySet<string>,
  now = Date.now(),
): Promise<number> {
  if (records.length > MAX_IMPORT_ANNOTATIONS) {
    throw new Error(`Import exceeds the ${MAX_IMPORT_ANNOTATIONS}-annotation limit`);
  }
  if (fingerprints.length > MAX_IMPORT_FINGERPRINTS) {
    throw new Error(`Import exceeds the ${MAX_IMPORT_FINGERPRINTS}-document limit`);
  }
  const prepared = records.map((record) => {
    validateLibraryRelativePath(record.relativePath);
    const clean: Annotation = {
      ...record,
      sortIndex: record.sortIndex || deriveAnnotationSortIndex(record.locator),
      deletedAt: record.deletedAt ?? null,
    };
    if (!isValidSortIndex(clean.sortIndex)) {
      throw new Error("Annotation sort index is invalid");
    }
    return clean;
  });
  for (const entry of fingerprints) {
    validateLibraryRelativePath(entry.relativePath);
  }
  const db = await openDb();
  const tx = db.transaction(v6WriteStores(db), "readwrite");
  const store = tx.objectStore(STORE_NAME);
  for (const record of prepared) {
    store.put(record);
  }
  const documents = tx.objectStore(DOCUMENTS_STORE);
  for (const entry of fingerprints) {
    if (presentPaths.has(entry.relativePath)) continue;
    const existing = (await requestToPromise(documents.get(entry.relativePath))) as
      | WebDocumentFingerprint
      | undefined;
    if (existing) continue;
    const row: WebDocumentFingerprint = {
      relativePath: entry.relativePath,
      contentHash: entry.contentHash,
      fileSize: 0,
      lastSeenAt: now,
    };
    documents.put(row);
  }
  for (const record of prepared) {
    await projectLegacyIntoV6(tx, record);
  }
  await transactionDone(tx);
  return prepared.length;
}

// ---- Document fingerprints and the move-detection rebind chain (§5.5) ----

/** Stored fingerprint record, the web mirror of a desktop `documents` row. */
export interface WebDocumentFingerprint {
  relativePath: string;
  contentHash: string;
  fileSize: number;
  lastSeenAt: number;
}

/** Manifest fields the fingerprint chain consumes. */
export interface WebFingerprintSource {
  relativePath: string;
  size: number;
  contentHash?: string;
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Annotation transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Annotation transaction aborted"));
  });
}

/**
 * Upserts the manifest fingerprints after a (re)load — the web equivalent of
 * the desktop scan hook. Rows for paths missing from `documents` are
 * retained on purpose: they are the rebind clue for `detectWebMovedDocuments`.
 */
export async function syncWebDocumentFingerprints(
  documents: ReadonlyArray<WebFingerprintSource>,
  now = Date.now(),
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(DOCUMENTS_STORE, "readwrite");
  const store = tx.objectStore(DOCUMENTS_STORE);
  for (const document of documents) {
    if (!document.contentHash) continue;
    const record: WebDocumentFingerprint = {
      relativePath: document.relativePath,
      contentHash: document.contentHash,
      fileSize: document.size,
      lastSeenAt: now,
    };
    store.put(record);
  }
  await transactionDone(tx);
}

/**
 * Web move detection: the manifest is the "current scan", the fingerprint
 * store provides the last known hashes of vanished paths, live annotations
 * provide the counts. Pure logic lives in `detectMovedDocumentCandidates`.
 */
export async function detectWebMovedDocuments(
  documents: ReadonlyArray<WebFingerprintSource>,
): Promise<MovedDocumentCandidate[]> {
  const db = await openDb();
  const tx = db.transaction([STORE_NAME, DOCUMENTS_STORE], "readonly");
  const annotations = await requestToPromise(
    tx.objectStore(STORE_NAME).getAll() as IDBRequest<Annotation[]>,
  );
  const stored = await requestToPromise(
    tx.objectStore(DOCUMENTS_STORE).getAll() as IDBRequest<WebDocumentFingerprint[]>,
  );

  const liveAnnotationCounts = new Map<string, number>();
  for (const annotation of annotations) {
    if (annotation.deletedAt != null) continue;
    liveAnnotationCounts.set(
      annotation.relativePath,
      (liveAnnotationCounts.get(annotation.relativePath) ?? 0) + 1,
    );
  }
  const currentHashes = new Map<string, string>();
  for (const document of documents) {
    if (document.contentHash) currentHashes.set(document.relativePath, document.contentHash);
  }
  return detectMovedDocumentCandidates({
    presentPaths: documents.map((document) => document.relativePath),
    currentHashes,
    storedHashes: new Map(stored.map((record) => [record.relativePath, record.contentHash])),
    liveAnnotationCounts,
  });
}

/**
 * Moves every annotation of `oldPath` (tombstones included, so deletion
 * history follows the document) to `newPath` in one transaction and drops
 * the stale fingerprint row, mirroring the desktop
 * `rebind_document_annotations` command. Collection membership rides the
 * same confirmation (CO-D3): item rows move to the new path, and an item
 * whose collection already contains the new path is dropped instead of
 * duplicated. Returns the number of annotation records updated.
 */
export async function rebindWebDocumentAnnotations(
  oldPath: string,
  newPath: string,
): Promise<number> {
  validateLibraryRelativePath(oldPath);
  validateLibraryRelativePath(newPath);
  if (oldPath === newPath) {
    throw new Error("Rebinding requires two different paths");
  }
  const db = await openDb();
  const tx = db.transaction(
    [...v6WriteStores(db), COLLECTION_ITEMS_STORE],
    "readwrite",
  );
  const store = tx.objectStore(STORE_NAME);
  const matches = await requestToPromise(
    store.index("relativePath").getAll(oldPath) as IDBRequest<Annotation[]>,
  );
  for (const record of matches) {
    store.put({ ...record, relativePath: newPath });
  }
  if (tx.objectStoreNames.contains("excerpts")) {
    rebindV6Paths(tx, oldPath, newPath);
  }
  const items = tx.objectStore(COLLECTION_ITEMS_STORE);
  const itemRows = await requestToPromise(
    items.getAll() as IDBRequest<WebCollectionItemRecord[]>,
  );
  for (const item of itemRows) {
    if (item.relativePath !== oldPath) continue;
    const conflict = itemRows.some(
      (other) => other.collectionId === item.collectionId && other.relativePath === newPath,
    );
    items.delete([item.collectionId, oldPath]);
    if (!conflict) items.put({ ...item, relativePath: newPath });
  }
  tx.objectStore(DOCUMENTS_STORE).delete(oldPath);
  await transactionDone(tx);
  return matches.length;
}

// ---- Spaced-repetition review state (plan-annotation-review §3.3) ----

/** Stored review row, the web mirror of a desktop `annotation_reviews` row. */
interface WebReviewRecord {
  annotationId: string;
  box: number;
  dueAt: number;
  lastReviewedAt: number | null;
  totalReviews: number;
  suspended: boolean;
  updatedAt: number;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function readAnnotationsAndReviews(db: IDBDatabase): Promise<{
  annotations: Annotation[];
  reviews: Map<string, WebReviewRecord>;
}> {
  const tx = db.transaction([STORE_NAME, REVIEWS_STORE], "readonly");
  const annotations = await requestToPromise(
    tx.objectStore(STORE_NAME).getAll() as IDBRequest<Annotation[]>,
  );
  const reviewRows = await requestToPromise(
    tx.objectStore(REVIEWS_STORE).getAll() as IDBRequest<WebReviewRecord[]>,
  );
  return {
    annotations,
    reviews: new Map(reviewRows.map((record) => [record.annotationId, record])),
  };
}

/**
 * Enrollment-only pool: live mark annotations with a non-blank excerpt and
 * a stored, unsuspended review row. Missing rows stay out of the queue.
 */
function reviewCandidates(
  annotations: Annotation[],
  reviews: Map<string, WebReviewRecord>,
): ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  for (const annotation of annotations) {
    if (annotation.deletedAt != null) continue;
    if (!isReviewableAnnotation(annotation)) continue;
    const record = reviews.get(annotation.id);
    if (!record || record.suspended) continue;
    items.push({
      annotation,
      review: {
        box: record.box,
        dueAt: record.dueAt,
        lastReviewedAt: record.lastReviewedAt,
        totalReviews: record.totalReviews,
        suspended: record.suspended,
      },
    });
  }
  return items;
}

/**
 * Due candidates in due-date order, over-fetched ×3 — behaviourally
 * identical to the desktop `list_review_queue` command; feed the result
 * through `buildReviewQueue` for the rotated daily batch.
 */
export async function listWebReviewQueue(
  nowMs: number,
  limit: number,
): Promise<ReviewQueueItem[]> {
  const capped = Math.min(Math.max(Math.floor(limit), 1), MAX_REVIEW_QUEUE_LIMIT);
  const db = await openDb();
  const { annotations, reviews } = await readAnnotationsAndReviews(db);
  return reviewCandidates(annotations, reviews)
    .filter((item) => !item.review.suspended && item.review.dueAt <= nowMs)
    .sort(
      (a, b) =>
        a.review.dueAt - b.review.dueAt || compareStrings(a.annotation.id, b.annotation.id),
    )
    .slice(0, capped * REVIEW_QUEUE_OVERFETCH);
}

/**
 * Persists a client-derived review state with the same validation as the
 * desktop `record_review_outcome`: the annotation must exist and be live,
 * the box must sit on the ladder, the due date inside the skew window.
 * `totalReviews` is counted here, not taken from the caller; suspending
 * does not count as a review.
 */
export async function recordWebReviewOutcome(
  annotationId: string,
  state: ReviewState,
  now = Date.now(),
): Promise<void> {
  if (!Number.isInteger(state.box) || state.box < 0 || state.box > REVIEW_MAX_BOX) {
    throw new Error(`Review box must be between 0 and ${REVIEW_MAX_BOX}`);
  }
  if (
    state.dueAt < now - REVIEW_DUE_PAST_SLACK_MS ||
    state.dueAt > now + REVIEW_DUE_FUTURE_LIMIT_MS
  ) {
    throw new Error("Review due date is out of range");
  }
  if (state.lastReviewedAt != null && state.lastReviewedAt > now + REVIEW_DUE_PAST_SLACK_MS) {
    throw new Error("Review timestamp is in the future");
  }
  const db = await openDb();
  const storeNames = db.objectStoreNames.contains("reviewEnrollments")
    ? [STORE_NAME, REVIEWS_STORE, "reviewEnrollments"]
    : [STORE_NAME, REVIEWS_STORE];
  const tx = db.transaction(storeNames, "readwrite");
  const annotation = (await requestToPromise(tx.objectStore(STORE_NAME).get(annotationId))) as
    | Annotation
    | undefined;
  if (!annotation || annotation.deletedAt != null) {
    throw new Error("Annotation was not found");
  }
  const store = tx.objectStore(REVIEWS_STORE);
  const existing = (await requestToPromise(store.get(annotationId))) as
    | WebReviewRecord
    | undefined;
  const record: WebReviewRecord = {
    annotationId,
    box: state.box,
    dueAt: state.dueAt,
    lastReviewedAt: state.lastReviewedAt,
    totalReviews: (existing?.totalReviews ?? 0) + (state.suspended ? 0 : 1),
    suspended: state.suspended,
    updatedAt: now,
  };
  await requestToPromise(store.put(record));
  if (db.objectStoreNames.contains("reviewEnrollments")) {
    const enrollmentStore = tx.objectStore("reviewEnrollments");
    const enrollment = (await requestToPromise(enrollmentStore.get(annotationId))) as
      | ReviewEnrollment
      | undefined;
    if (enrollment && enrollment.deletedAt == null) {
      await requestToPromise(
        enrollmentStore.put({
          ...enrollment,
          box: record.box,
          dueAt: record.dueAt,
          lastReviewedAt: record.lastReviewedAt,
          totalReviews: record.totalReviews,
          suspended: record.suspended,
          updatedAt: now,
        }),
      );
    }
  }
}

/**
 * Review card numbers, mirroring the desktop `review_summary`: due
 * candidates at `nowMs` plus review rows whose `lastReviewedAt` falls into
 * `[dayStartMs, nowMs]` (the caller computes the local day boundary).
 */
export async function webReviewSummary(
  dayStartMs: number,
  nowMs: number,
): Promise<ReviewSummary> {
  if (dayStartMs > nowMs) {
    throw new Error("The review summary range start must not exceed its end");
  }
  const db = await openDb();
  const { annotations, reviews } = await readAnnotationsAndReviews(db);
  const dueCount = reviewCandidates(annotations, reviews).filter(
    (item) => !item.review.suspended && item.review.dueAt <= nowMs,
  ).length;
  let reviewedToday = 0;
  for (const record of reviews.values()) {
    if (
      record.lastReviewedAt != null &&
      record.lastReviewedAt >= dayStartMs &&
      record.lastReviewedAt <= nowMs
    ) {
      reviewedToday += 1;
    }
  }
  return { dueCount, reviewedToday };
}

// ---- Annotation search (plan-annotation-hub §3.1) ----

/**
 * In-memory counterpart of the desktop `search_annotations` command: same
 * truncate → normalize pipeline, same live-only scope, same
 * `relativePath, sortIndex` ordering and limit cap. Matching runs through
 * the shared contract functions in `annotationSearch.ts`.
 */
export async function searchWebAnnotations(
  query: string,
  limit: number,
): Promise<Annotation[]> {
  // Truncate on code points before NFKC, like the desktop `chars().take(n)`.
  const truncated = [...query].slice(0, MAX_SEARCH_QUERY_CHARS).join("");
  const normalized = normalizeAnnotationQuery(truncated);
  if (!normalized) return [];
  const capped = Math.min(Math.max(Math.floor(limit), 1), MAX_ANNOTATION_SEARCH_RESULTS);
  const live = await listWebAnnotations(null);
  return live
    .filter((annotation) => annotationMatchesQuery(annotation, normalized))
    .sort(
      (a, b) =>
        compareStrings(a.relativePath, b.relativePath) ||
        compareStrings(a.sortIndex, b.sortIndex) ||
        compareStrings(a.id, b.id),
    )
    .slice(0, capped);
}

export async function searchWebAnnotationEntries(
  query: string,
  limit: number,
): Promise<AnnotationSearchHit[]> {
  const annotations = await searchWebAnnotations(query, limit);
  const db = await openDb();
  const { reviews } = await readAnnotationsAndReviews(db);
  return annotations.map((annotation) => ({
    annotation,
    hasReflection: Boolean(annotation.note?.trim()),
    enrolled: reviews.get(annotation.id)?.suspended === false,
  }));
}
