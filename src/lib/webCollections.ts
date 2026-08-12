/**
 * IndexedDB-backed collections for the web build — the structural twin of
 * the desktop collection commands in `src-tauri/src/user_store.rs`
 * (`docs/plan-collections.md` §3.1/§3.2). Same validation (shared pure
 * functions in `collections.ts`), same ordering, same idempotence rules;
 * the numbered contract fixture CC01.. in `webCollections.test.ts` is
 * replayed by the Rust test
 * `collections_contract_fixture_matches_the_web_snapshots`.
 *
 * The stores live in the shared `reade-annotations` database (schema v5,
 * `webAnnotations.ts`). Item rows hold nothing but library-relative path
 * strings: deleting a collection can never touch documents, annotations
 * or reading progress.
 */

import type { Collection, CollectionItem, CollectionSummary } from "./backend";
import {
  sanitizeCollectionName,
  validateCollectionId,
  validateReorderedPaths,
} from "./collections";
import {
  COLLECTION_ITEMS_STORE,
  COLLECTIONS_STORE,
  openWebUserDatabase,
} from "./webAnnotations";
import { validateLibraryRelativePath } from "./webLibrary";

/** Stored collection row, the web mirror of a desktop `collections` row. */
export interface WebCollectionRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

/** Stored membership row, the web mirror of a desktop `collection_items` row. */
export interface WebCollectionItemRecord {
  collectionId: string;
  relativePath: string;
  position: number;
  addedAt: number;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Collection request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Collection transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Collection transaction aborted"));
  });
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function readCollection(
  store: IDBObjectStore,
  id: string,
): Promise<WebCollectionRecord | undefined> {
  return (await requestToPromise(store.get(id))) as WebCollectionRecord | undefined;
}

/** Ownership gate: the collection must exist (desktop: within the root). */
async function requireCollection(
  store: IDBObjectStore,
  id: string,
): Promise<WebCollectionRecord> {
  validateCollectionId(id);
  const record = await readCollection(store, id);
  if (!record) throw new Error("Collection was not found");
  return record;
}

async function itemsOf(
  store: IDBObjectStore,
  collectionId: string,
): Promise<WebCollectionItemRecord[]> {
  return (await requestToPromise(
    store.index("collectionId").getAll(collectionId),
  )) as WebCollectionItemRecord[];
}

/**
 * Collections in stable `(createdAt, id)` order with item/present counts
 * — the web twin of `list_collections`.
 */
export async function listWebCollections(
  presentPaths: ReadonlySet<string>,
): Promise<CollectionSummary[]> {
  const db = await openWebUserDatabase();
  const tx = db.transaction([COLLECTIONS_STORE, COLLECTION_ITEMS_STORE], "readonly");
  const collections = (await requestToPromise(
    tx.objectStore(COLLECTIONS_STORE).getAll(),
  )) as WebCollectionRecord[];
  const items = (await requestToPromise(
    tx.objectStore(COLLECTION_ITEMS_STORE).getAll(),
  )) as WebCollectionItemRecord[];
  const counts = new Map<string, { itemCount: number; presentCount: number }>();
  for (const item of items) {
    const entry = counts.get(item.collectionId) ?? { itemCount: 0, presentCount: 0 };
    entry.itemCount += 1;
    if (presentPaths.has(item.relativePath)) entry.presentCount += 1;
    counts.set(item.collectionId, entry);
  }
  return collections
    .sort((a, b) => a.createdAt - b.createdAt || compareStrings(a.id, b.id))
    .map((record) => ({
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      itemCount: counts.get(record.id)?.itemCount ?? 0,
      presentCount: counts.get(record.id)?.presentCount ?? 0,
    }));
}

export async function createWebCollection(
  id: string,
  name: string,
  now = Date.now(),
): Promise<Collection> {
  validateCollectionId(id);
  const clean = sanitizeCollectionName(name);
  const db = await openWebUserDatabase();
  const tx = db.transaction(COLLECTIONS_STORE, "readwrite");
  const store = tx.objectStore(COLLECTIONS_STORE);
  if (await readCollection(store, id)) {
    throw new Error("Collection id already exists");
  }
  const record: WebCollectionRecord = { id, name: clean, createdAt: now, updatedAt: now };
  store.put(record);
  await transactionDone(tx);
  return record;
}

export async function renameWebCollection(
  id: string,
  name: string,
  now = Date.now(),
): Promise<void> {
  const clean = sanitizeCollectionName(name);
  const db = await openWebUserDatabase();
  const tx = db.transaction(COLLECTIONS_STORE, "readwrite");
  const store = tx.objectStore(COLLECTIONS_STORE);
  const record = await requireCollection(store, id);
  store.put({ ...record, name: clean, updatedAt: now });
  await transactionDone(tx);
}

/** Deletes the collection row and its items; documents stay untouched. */
export async function deleteWebCollection(id: string): Promise<void> {
  const db = await openWebUserDatabase();
  const tx = db.transaction([COLLECTIONS_STORE, COLLECTION_ITEMS_STORE], "readwrite");
  const collections = tx.objectStore(COLLECTIONS_STORE);
  await requireCollection(collections, id);
  const items = tx.objectStore(COLLECTION_ITEMS_STORE);
  for (const item of await itemsOf(items, id)) {
    items.delete([item.collectionId, item.relativePath]);
  }
  collections.delete(id);
  await transactionDone(tx);
}

/** Items in manual order — the web twin of `list_collection_items`. */
export async function listWebCollectionItems(
  collectionId: string,
  presentPaths: ReadonlySet<string>,
): Promise<CollectionItem[]> {
  const db = await openWebUserDatabase();
  const tx = db.transaction([COLLECTIONS_STORE, COLLECTION_ITEMS_STORE], "readonly");
  await requireCollection(tx.objectStore(COLLECTIONS_STORE), collectionId);
  const items = await itemsOf(tx.objectStore(COLLECTION_ITEMS_STORE), collectionId);
  return items
    .sort(
      (a, b) => a.position - b.position || compareStrings(a.relativePath, b.relativePath),
    )
    .map((item) => ({
      relativePath: item.relativePath,
      position: item.position,
      addedAt: item.addedAt,
      present: presentPaths.has(item.relativePath),
    }));
}

/**
 * Appends a manifest-present document; re-adding an existing item is
 * idempotent and returns the stored row without touching any timestamp.
 */
export async function addWebCollectionItem(
  collectionId: string,
  relativePath: string,
  presentPaths: ReadonlySet<string>,
  now = Date.now(),
): Promise<CollectionItem> {
  validateLibraryRelativePath(relativePath);
  if (!presentPaths.has(relativePath)) {
    throw new Error("Document is not in the current library");
  }
  const db = await openWebUserDatabase();
  const tx = db.transaction([COLLECTIONS_STORE, COLLECTION_ITEMS_STORE], "readwrite");
  const collections = tx.objectStore(COLLECTIONS_STORE);
  const collection = await requireCollection(collections, collectionId);
  const items = tx.objectStore(COLLECTION_ITEMS_STORE);
  const existing = (await requestToPromise(items.get([collectionId, relativePath]))) as
    | WebCollectionItemRecord
    | undefined;
  if (existing) {
    return {
      relativePath: existing.relativePath,
      position: existing.position,
      addedAt: existing.addedAt,
      present: true,
    };
  }
  const siblings = await itemsOf(items, collectionId);
  const position = siblings.reduce(
    (highest, item) => Math.max(highest, item.position + 1),
    0,
  );
  const record: WebCollectionItemRecord = { collectionId, relativePath, position, addedAt: now };
  items.put(record);
  collections.put({ ...collection, updatedAt: now });
  await transactionDone(tx);
  return { relativePath, position, addedAt: now, present: true };
}

export async function removeWebCollectionItem(
  collectionId: string,
  relativePath: string,
  now = Date.now(),
): Promise<void> {
  validateLibraryRelativePath(relativePath);
  const db = await openWebUserDatabase();
  const tx = db.transaction([COLLECTIONS_STORE, COLLECTION_ITEMS_STORE], "readwrite");
  const collections = tx.objectStore(COLLECTIONS_STORE);
  const collection = await requireCollection(collections, collectionId);
  const items = tx.objectStore(COLLECTION_ITEMS_STORE);
  const existing = (await requestToPromise(items.get([collectionId, relativePath]))) as
    | WebCollectionItemRecord
    | undefined;
  if (!existing) {
    throw new Error("Collection item was not found");
  }
  items.delete([collectionId, relativePath]);
  collections.put({ ...collection, updatedAt: now });
  await transactionDone(tx);
}

/** Rewrites positions 0..n-1 after the CO-D4 exact-set check. */
export async function reorderWebCollectionItems(
  collectionId: string,
  orderedPaths: readonly string[],
  now = Date.now(),
): Promise<void> {
  const db = await openWebUserDatabase();
  const tx = db.transaction([COLLECTIONS_STORE, COLLECTION_ITEMS_STORE], "readwrite");
  const collections = tx.objectStore(COLLECTIONS_STORE);
  const collection = await requireCollection(collections, collectionId);
  const items = tx.objectStore(COLLECTION_ITEMS_STORE);
  const existing = await itemsOf(items, collectionId);
  validateReorderedPaths(
    existing.map((item) => item.relativePath),
    orderedPaths,
  );
  const byPath = new Map(existing.map((item) => [item.relativePath, item] as const));
  orderedPaths.forEach((relativePath, position) => {
    const item = byPath.get(relativePath);
    if (item) items.put({ ...item, position });
  });
  collections.put({ ...collection, updatedAt: now });
  await transactionDone(tx);
}
