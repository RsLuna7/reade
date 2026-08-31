import type { Annotation } from "./backend";
import {
  excerptToLegacyAnnotation,
  legacyColorToTone,
  migrateLegacyAnnotation,
  readingPlaceToLegacyAnnotation,
  type Excerpt,
  type ReadingPlace,
  type Reflection,
  type ReviewEnrollment,
  type SourceRevision,
} from "./annotationModel";
import type { WebDocumentFingerprint } from "./webAnnotations";

export const EXCERPTS_STORE = "excerpts";
export const READING_PLACES_STORE = "readingPlaces";
export const REFLECTIONS_STORE = "reflections";
export const REVIEW_ENROLLMENTS_STORE = "reviewEnrollments";
export const ANNOTATION_V6_META_STORE = "annotationV6Meta";

export const V6_STORE_NAMES = [
  EXCERPTS_STORE,
  READING_PLACES_STORE,
  REFLECTIONS_STORE,
  REVIEW_ENROLLMENTS_STORE,
  ANNOTATION_V6_META_STORE,
] as const;

const ANNOTATIONS_STORE = "annotations";
const DOCUMENTS_STORE = "documents";
const REVIEWS_STORE = "annotationReviews";
const COLLECTIONS_STORE = "collections";
const COLLECTION_ITEMS_STORE = "collectionItems";

export const V6_BACKUP_SOURCE_STORES = [
  ANNOTATIONS_STORE,
  DOCUMENTS_STORE,
  REVIEWS_STORE,
  COLLECTIONS_STORE,
  COLLECTION_ITEMS_STORE,
] as const;

/** Stores writers touch after the v7 wipe — legacy annotations/reviews stay empty shells. */
export const V6_WRITE_STORES = [DOCUMENTS_STORE, ...V6_STORE_NAMES] as const;

const META_KEY = "annotationV6";

export interface AnnotationV6Meta {
  key: typeof META_KEY;
  status: "pending" | "ready";
  backupName: string | null;
  error: string | null;
  excerptCount: number;
  placeCount: number;
  reflectionCount: number;
  migratedAt: number;
}

interface LegacyReviewRow {
  annotationId: string;
  box: number;
  dueAt: number;
  lastReviewedAt: number | null;
  totalReviews: number;
  suspended: boolean;
  updatedAt: number;
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function keyPathForBackupStore(name: string): string | string[] {
  if (name === DOCUMENTS_STORE) return "relativePath";
  if (name === REVIEWS_STORE) return "annotationId";
  if (name === COLLECTION_ITEMS_STORE) return ["collectionId", "relativePath"];
  return "id";
}

export function createAnnotationV6Stores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(EXCERPTS_STORE)) {
    const excerpts = db.createObjectStore(EXCERPTS_STORE, { keyPath: "id" });
    excerpts.createIndex("relativePath", "relativePath", { unique: false });
    excerpts.createIndex("sortIndex", "sortIndex", { unique: false });
    excerpts.createIndex("updatedAt", "updatedAt", { unique: false });
  }
  if (!db.objectStoreNames.contains(READING_PLACES_STORE)) {
    const places = db.createObjectStore(READING_PLACES_STORE, { keyPath: "id" });
    places.createIndex("relativePath", "relativePath", { unique: false });
    places.createIndex("sortIndex", "sortIndex", { unique: false });
  }
  if (!db.objectStoreNames.contains(REFLECTIONS_STORE)) {
    const reflections = db.createObjectStore(REFLECTIONS_STORE, { keyPath: "entryId" });
    reflections.createIndex("entryKind", "entryKind", { unique: false });
    reflections.createIndex("updatedAt", "updatedAt", { unique: false });
  }
  if (!db.objectStoreNames.contains(REVIEW_ENROLLMENTS_STORE)) {
    const enrollments = db.createObjectStore(REVIEW_ENROLLMENTS_STORE, { keyPath: "excerptId" });
    enrollments.createIndex("dueAt", "dueAt", { unique: false });
    enrollments.createIndex("suspended", "suspended", { unique: false });
  }
  if (!db.objectStoreNames.contains(ANNOTATION_V6_META_STORE)) {
    db.createObjectStore(ANNOTATION_V6_META_STORE, { keyPath: "key" });
  }
}

function revisionFromFingerprint(
  fingerprint: WebDocumentFingerprint | undefined,
  observedAt: number,
  basis: SourceRevision["basis"],
): SourceRevision | null {
  if (!fingerprint?.contentHash) return null;
  return { contentHash: fingerprint.contentHash, observedAt, basis };
}

export function projectAnnotationIntoV6(
  tx: IDBTransaction,
  annotation: Annotation,
  fingerprint: WebDocumentFingerprint | undefined,
  basis: SourceRevision["basis"] = "capture",
  existingExcerpt?: Excerpt | null,
): void {
  const migrated = migrateLegacyAnnotation(
    annotation,
    revisionFromFingerprint(fingerprint, annotation.updatedAt, basis),
  );
  if (migrated.excerpt) {
    if (existingExcerpt && existingExcerpt.deletedAt == null) {
      const incomingTone = legacyColorToTone(annotation.color);
      if (incomingTone !== existingExcerpt.appearance.tone) {
        migrated.excerpt.appearance.tone = incomingTone;
        migrated.excerpt.legacyColor = annotation.color;
      } else {
        migrated.excerpt.appearance.tone = existingExcerpt.appearance.tone;
        migrated.excerpt.legacyColor = existingExcerpt.legacyColor;
      }
      migrated.excerpt.createdAt = existingExcerpt.createdAt;
    }
    tx.objectStore(EXCERPTS_STORE).put(migrated.excerpt);
    tx.objectStore(READING_PLACES_STORE).delete(annotation.id);
  } else if (migrated.place) {
    tx.objectStore(READING_PLACES_STORE).put(migrated.place);
    tx.objectStore(EXCERPTS_STORE).delete(annotation.id);
  }
  if (migrated.reflection) {
    tx.objectStore(REFLECTIONS_STORE).put(migrated.reflection);
  } else {
    tx.objectStore(REFLECTIONS_STORE).delete(annotation.id);
  }
}

export function removeV6EntriesForPath(tx: IDBTransaction, relativePath: string): void {
  const excerptRequest = tx
    .objectStore(EXCERPTS_STORE)
    .index("relativePath")
    .openCursor(relativePath);
  excerptRequest.onsuccess = () => {
    const cursor = excerptRequest.result;
    if (!cursor) return;
    const id = (cursor.value as Excerpt).id;
    cursor.delete();
    tx.objectStore(REFLECTIONS_STORE).delete(id);
    tx.objectStore(REVIEW_ENROLLMENTS_STORE).delete(id);
    cursor.continue();
  };
  const placeRequest = tx
    .objectStore(READING_PLACES_STORE)
    .index("relativePath")
    .openCursor(relativePath);
  placeRequest.onsuccess = () => {
    const cursor = placeRequest.result;
    if (!cursor) return;
    const id = (cursor.value as ReadingPlace).id;
    cursor.delete();
    tx.objectStore(REFLECTIONS_STORE).delete(id);
    cursor.continue();
  };
}

export function rebindV6Paths(tx: IDBTransaction, oldPath: string, newPath: string): void {
  const excerptRequest = tx
    .objectStore(EXCERPTS_STORE)
    .index("relativePath")
    .openCursor(oldPath);
  excerptRequest.onsuccess = () => {
    const cursor = excerptRequest.result;
    if (!cursor) return;
    cursor.update({ ...(cursor.value as Excerpt), relativePath: newPath });
    cursor.continue();
  };
  const placeRequest = tx
    .objectStore(READING_PLACES_STORE)
    .index("relativePath")
    .openCursor(oldPath);
  placeRequest.onsuccess = () => {
    const cursor = placeRequest.result;
    if (!cursor) return;
    cursor.update({ ...(cursor.value as ReadingPlace), relativePath: newPath });
    cursor.continue();
  };
}

async function readLegacyStoreSnapshot(
  source: IDBDatabase,
  storeNames: readonly string[],
): Promise<Map<string, unknown[]>> {
  const snapshot = new Map<string, unknown[]>();
  if (storeNames.length === 0) return snapshot;
  await new Promise<void>((resolve, reject) => {
    const tx = source.transaction([...storeNames], "readonly");
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("Cannot read the v5 annotation backup source"));
    tx.onabort = () =>
      reject(tx.error ?? new Error("Cannot read the v5 annotation backup source"));
    for (const name of storeNames) {
      const request = tx.objectStore(name).getAll();
      request.onsuccess = () => {
        snapshot.set(name, request.result);
      };
    }
  });
  return snapshot;
}

async function writeLegacyStoreBackup(
  backupName: string,
  snapshot: Map<string, unknown[]>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(backupName, 1);
    request.onupgradeneeded = () => {
      const backup = request.result;
      for (const name of V6_BACKUP_SOURCE_STORES) {
        if (!backup.objectStoreNames.contains(name)) {
          backup.createObjectStore(name, { keyPath: keyPathForBackupStore(name) });
        }
      }
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Cannot open the v5 annotation backup"));
    request.onsuccess = () => {
      const backup = request.result;
      const present = [...snapshot.keys()];
      if (present.length === 0) {
        backup.close();
        resolve();
        return;
      }
      const writeTx = backup.transaction(present, "readwrite");
      writeTx.oncomplete = () => {
        backup.close();
        resolve();
      };
      writeTx.onerror = () => {
        backup.close();
        reject(writeTx.error ?? new Error("Cannot write the v5 annotation backup"));
      };
      writeTx.onabort = () => {
        backup.close();
        reject(writeTx.error ?? new Error("Cannot write the v5 annotation backup"));
      };
      for (const name of present) {
        const store = writeTx.objectStore(name);
        for (const row of snapshot.get(name) ?? []) store.put(row);
      }
    };
  });
}

async function backupLegacyStores(source: IDBDatabase): Promise<string> {
  const backupName = `reade-annotations-backup-v5-${Date.now()}`;
  const present = V6_BACKUP_SOURCE_STORES.filter((name) => source.objectStoreNames.contains(name));
  // Read the source DB to completion before opening the backup DB. Overlapping
  // transactions let Chromium auto-commit the empty write tx ("transaction has
  // finished") while fake-indexeddb still accepts late puts.
  const snapshot = await readLegacyStoreSnapshot(source, present);
  await writeLegacyStoreBackup(backupName, snapshot);
  return backupName;
}

export async function readAnnotationV6Meta(
  db: IDBDatabase,
): Promise<AnnotationV6Meta | undefined> {
  if (!db.objectStoreNames.contains(ANNOTATION_V6_META_STORE)) return undefined;
  const tx = db.transaction(ANNOTATION_V6_META_STORE, "readonly");
  return requestToPromise(
    tx.objectStore(ANNOTATION_V6_META_STORE).get(META_KEY) as IDBRequest<
      AnnotationV6Meta | undefined
    >,
  );
}

export function assertAnnotationV6Ready(meta: AnnotationV6Meta | undefined): void {
  if (meta?.status === "ready") return;
  throw new Error("标注升级未完成，数据仍由旧系统读取");
}

export async function ensureAnnotationV6Migrated(db: IDBDatabase): Promise<AnnotationV6Meta> {
  const existing = await readAnnotationV6Meta(db);
  if (existing?.status === "ready") return existing;

  let backupName = existing?.backupName ?? null;
  try {
    if (!backupName || existing?.error) backupName = await backupLegacyStores(db);
  } catch (error) {
    const failed: AnnotationV6Meta = {
      key: META_KEY,
      status: "pending",
      backupName,
      error: error instanceof Error ? error.message : String(error),
      excerptCount: 0,
      placeCount: 0,
      reflectionCount: 0,
      migratedAt: Date.now(),
    };
    const tx = db.transaction(ANNOTATION_V6_META_STORE, "readwrite");
    tx.objectStore(ANNOTATION_V6_META_STORE).put(failed);
    await transactionDone(tx);
    return failed;
  }

  const tx = db.transaction(
    [ANNOTATIONS_STORE, DOCUMENTS_STORE, REVIEWS_STORE, ...V6_STORE_NAMES],
    "readwrite",
  );
  const annotationsRequest = tx.objectStore(ANNOTATIONS_STORE).getAll() as IDBRequest<Annotation[]>;
  const fingerprintRequest = tx.objectStore(DOCUMENTS_STORE).getAll() as IDBRequest<
    WebDocumentFingerprint[]
  >;
  const reviewRequest = tx.objectStore(REVIEWS_STORE).getAll() as IDBRequest<LegacyReviewRow[]>;
  const [annotations, fingerprints, reviews] = await Promise.all([
    requestToPromise(annotationsRequest),
    requestToPromise(fingerprintRequest),
    requestToPromise(reviewRequest),
  ]);
  const fingerprintByPath = new Map(fingerprints.map((row) => [row.relativePath, row]));

  for (const annotation of annotations) {
    projectAnnotationIntoV6(
      tx,
      annotation,
      fingerprintByPath.get(annotation.relativePath),
      "migrationSnapshot",
    );
  }
  for (const review of reviews) {
    if (review.suspended) continue;
    const excerpt = (await requestToPromise(
      tx.objectStore(EXCERPTS_STORE).get(review.annotationId),
    )) as Excerpt | undefined;
    if (!excerpt || excerpt.deletedAt != null) continue;
    const enrollment: ReviewEnrollment = {
      excerptId: review.annotationId,
      enrolledAt: excerpt.createdAt,
      box: review.box,
      dueAt: review.dueAt,
      lastReviewedAt: review.lastReviewedAt,
      totalReviews: review.totalReviews,
      suspended: false,
      updatedAt: review.updatedAt,
      deletedAt: null,
    };
    tx.objectStore(REVIEW_ENROLLMENTS_STORE).put(enrollment);
  }

  const meta: AnnotationV6Meta = {
    key: META_KEY,
    status: "ready",
    backupName,
    error: null,
    excerptCount: annotations.filter((item) => item.kind !== "bookmark").length,
    placeCount: annotations.filter((item) => item.kind === "bookmark").length,
    reflectionCount: annotations.filter((item) => (item.note ?? "").trim().length > 0).length,
    migratedAt: Date.now(),
  };
  tx.objectStore(ANNOTATION_V6_META_STORE).put(meta);
  await transactionDone(tx);
  return meta;
}

export function putExcerptProjection(
  tx: IDBTransaction,
  excerpt: Excerpt,
  reflection: Reflection | null,
): void {
  tx.objectStore(EXCERPTS_STORE).put(excerpt);
  if (reflection) tx.objectStore(REFLECTIONS_STORE).put(reflection);
}

export function putReadingPlaceProjection(
  tx: IDBTransaction,
  place: ReadingPlace,
  reflection: Reflection | null,
): void {
  tx.objectStore(READING_PLACES_STORE).put(place);
  if (reflection) tx.objectStore(REFLECTIONS_STORE).put(reflection);
}

/**
 * Rebuilds the legacy `Annotation` DTO from v6 stores — the web twin of
 * `reverse_project_v6_annotations` in `user_store.rs`.
 */
export async function reverseProjectV6Annotations(
  db: IDBDatabase,
  relativePath: string | null = null,
  includeDeleted = false,
): Promise<Annotation[]> {
  if (!db.objectStoreNames.contains(EXCERPTS_STORE)) return [];
  const tx = db.transaction(
    [EXCERPTS_STORE, READING_PLACES_STORE, REFLECTIONS_STORE],
    "readonly",
  );
  const excerpts = relativePath
    ? ((await requestToPromise(
        tx.objectStore(EXCERPTS_STORE).index("relativePath").getAll(relativePath),
      )) as Excerpt[])
    : ((await requestToPromise(tx.objectStore(EXCERPTS_STORE).getAll())) as Excerpt[]);
  const places = relativePath
    ? ((await requestToPromise(
        tx.objectStore(READING_PLACES_STORE).index("relativePath").getAll(relativePath),
      )) as ReadingPlace[])
    : ((await requestToPromise(tx.objectStore(READING_PLACES_STORE).getAll())) as ReadingPlace[]);
  const reflections = (await requestToPromise(
    tx.objectStore(REFLECTIONS_STORE).getAll(),
  )) as Reflection[];
  const reflectionById = new Map(reflections.map((item) => [item.entryId, item]));
  const projected: Annotation[] = [];
  for (const excerpt of excerpts) {
    if (!includeDeleted && excerpt.deletedAt != null) continue;
    projected.push(
      excerptToLegacyAnnotation(excerpt, reflectionById.get(excerpt.id) ?? null),
    );
  }
  for (const place of places) {
    if (!includeDeleted && place.deletedAt != null) continue;
    projected.push(
      readingPlaceToLegacyAnnotation(place, reflectionById.get(place.id) ?? null),
    );
  }
  return projected;
}

/** Clears annotation content stores for the v7 wipe; keeps documents + collections shells. */
export function wipeAnnotationContentForV7(tx: IDBTransaction): void {
  for (const name of [
    ANNOTATIONS_STORE,
    REVIEWS_STORE,
    EXCERPTS_STORE,
    READING_PLACES_STORE,
    REFLECTIONS_STORE,
    REVIEW_ENROLLMENTS_STORE,
    COLLECTION_ITEMS_STORE,
  ] as const) {
    if (tx.objectStoreNames.contains(name)) tx.objectStore(name).clear();
  }
  if (tx.objectStoreNames.contains(ANNOTATION_V6_META_STORE)) {
    const meta: AnnotationV6Meta = {
      key: META_KEY,
      status: "ready",
      backupName: null,
      error: null,
      excerptCount: 0,
      placeCount: 0,
      reflectionCount: 0,
      migratedAt: Date.now(),
    };
    tx.objectStore(ANNOTATION_V6_META_STORE).put(meta);
  }
}
