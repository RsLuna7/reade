import {
  toneToLegacyColor,
  type AnnotationEntryKind,
  type DocumentAnnotationBundle,
  type Excerpt,
  type ExcerptAppearance,
  type ExcerptDraft,
  type ReadingPlace,
  type ReadingPlaceDraft,
  type Reflection,
  type ReviewEnrollment,
  type SourceRevision,
} from "./annotationModel";
import {
  normalizeReflectionBody,
  validateAnnotationId,
  validateExcerptDraft,
  validateReadingPlaceDraft,
} from "./annotationValidation";
import { openWebUserDatabase } from "./webAnnotations";
import type { WebDocumentFingerprint } from "./webAnnotations";
import {
  EXCERPTS_STORE,
  READING_PLACES_STORE,
  REFLECTIONS_STORE,
  REVIEW_ENROLLMENTS_STORE,
  V6_WRITE_STORES,
  assertAnnotationV6Ready,
  ensureAnnotationV6Migrated,
  putExcerptProjection,
  putReadingPlaceProjection,
  readAnnotationV6Meta,
  requestToPromise,
  transactionDone,
} from "./webAnnotationV6";

const DOCUMENTS_STORE = "documents";
const REVIEWS_STORE = "annotationReviews";
const REVIEW_IMPLICIT_DUE_OFFSET_MS = 24 * 60 * 60 * 1000;

function compareSort<T extends { sortIndex: string; id: string }>(left: T, right: T): number {
  return left.sortIndex < right.sortIndex
    ? -1
    : left.sortIndex > right.sortIndex
      ? 1
      : left.id.localeCompare(right.id);
}

async function openReadyDb(): Promise<IDBDatabase> {
  const db = await openWebUserDatabase();
  const meta = await ensureAnnotationV6Migrated(db);
  assertAnnotationV6Ready(meta);
  return db;
}

async function readFingerprint(
  tx: IDBTransaction,
  relativePath: string,
): Promise<WebDocumentFingerprint | undefined> {
  return requestToPromise(
    tx.objectStore(DOCUMENTS_STORE).get(relativePath) as IDBRequest<
      WebDocumentFingerprint | undefined
    >,
  );
}

function captureRevision(
  fingerprint: WebDocumentFingerprint | undefined,
  observedAt: number,
): SourceRevision | null {
  if (!fingerprint?.contentHash) return null;
  return { contentHash: fingerprint.contentHash, observedAt, basis: "capture" };
}

async function readLiveExcerpt(tx: IDBTransaction, id: string): Promise<Excerpt> {
  const excerpt = (await requestToPromise(
    tx.objectStore(EXCERPTS_STORE).get(id),
  )) as Excerpt | undefined;
  if (!excerpt || excerpt.deletedAt != null) throw new Error("摘录不存在");
  return excerpt;
}

async function readReflection(
  tx: IDBTransaction,
  entryId: string,
): Promise<Reflection | undefined> {
  return requestToPromise(
    tx.objectStore(REFLECTIONS_STORE).get(entryId) as IDBRequest<Reflection | undefined>,
  );
}

function putSuspendedReview(tx: IDBTransaction, annotationId: string, now: number): void {
  tx.objectStore(REVIEWS_STORE).put({
    annotationId,
    box: 0,
    dueAt: now + REVIEW_IMPLICIT_DUE_OFFSET_MS,
    lastReviewedAt: null,
    totalReviews: 0,
    suspended: true,
    updatedAt: now,
  });
}

export async function listDocumentAnnotations(
  relativePath: string,
): Promise<DocumentAnnotationBundle> {
  const db = await openReadyDb();
  const tx = db.transaction(
    [EXCERPTS_STORE, READING_PLACES_STORE, REFLECTIONS_STORE, REVIEW_ENROLLMENTS_STORE],
    "readonly",
  );
  const excerpts = (
    (await requestToPromise(
      tx.objectStore(EXCERPTS_STORE).index("relativePath").getAll(relativePath),
    )) as Excerpt[]
  )
    .filter((item) => item.deletedAt == null)
    .sort(compareSort);
  const places = (
    (await requestToPromise(
      tx.objectStore(READING_PLACES_STORE).index("relativePath").getAll(relativePath),
    )) as ReadingPlace[]
  )
    .filter((item) => item.deletedAt == null)
    .sort(compareSort);
  const liveIds = new Set([...excerpts, ...places].map((item) => item.id));
  const excerptIds = new Set(excerpts.map((item) => item.id));
  const reflections = (
    (await requestToPromise(tx.objectStore(REFLECTIONS_STORE).getAll())) as Reflection[]
  )
    .filter((item) => item.deletedAt == null && liveIds.has(item.entryId))
    .sort((left, right) => left.entryId.localeCompare(right.entryId));
  const reviewEnrollments = (
    (await requestToPromise(
      tx.objectStore(REVIEW_ENROLLMENTS_STORE).getAll(),
    )) as ReviewEnrollment[]
  )
    .filter((item) => item.deletedAt == null && excerptIds.has(item.excerptId))
    .sort((left, right) => left.excerptId.localeCompare(right.excerptId));
  return { excerpts, places, reflections, reviewEnrollments };
}

export async function createExcerpt(draft: ExcerptDraft): Promise<Excerpt> {
  const sanitized = validateExcerptDraft(draft);
  const db = await openReadyDb();
  const now = Date.now();
  const tx = db.transaction([...V6_WRITE_STORES], "readwrite");
  const fingerprint = await readFingerprint(tx, sanitized.relativePath);
  const excerpt: Excerpt = {
    id: sanitized.id,
    relativePath: sanitized.relativePath,
    sourceText: sanitized.sourceText,
    anchor: sanitized.anchor,
    sourceRevision: captureRevision(fingerprint, now),
    appearance: { ...sanitized.appearance },
    sortIndex: sanitized.sortIndex,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    legacyKind: sanitized.appearance.style,
    legacyColor: toneToLegacyColor(sanitized.appearance.tone),
    legacyTitle: null,
    legacySelectedText: sanitized.sourceText,
  };
  putExcerptProjection(tx, excerpt, null);
  putSuspendedReview(tx, excerpt.id, now);
  await transactionDone(tx);
  return excerpt;
}

export async function updateExcerptAppearance(
  id: string,
  appearance: ExcerptAppearance,
): Promise<Excerpt> {
  validateAnnotationId(id);
  const db = await openReadyDb();
  const tx = db.transaction([...V6_WRITE_STORES], "readwrite");
  const excerpt = await readLiveExcerpt(tx, id);
  const toneChanged = excerpt.appearance.tone !== appearance.tone;
  excerpt.appearance = { ...appearance };
  excerpt.updatedAt = Date.now();
  excerpt.legacyKind = appearance.style;
  if (toneChanged) excerpt.legacyColor = toneToLegacyColor(appearance.tone);
  const reflection = await readReflection(tx, id);
  putExcerptProjection(tx, excerpt, liveReflection(reflection));
  await transactionDone(tx);
  return excerpt;
}

export async function createReadingPlace(draft: ReadingPlaceDraft): Promise<ReadingPlace> {
  const sanitized = validateReadingPlaceDraft(draft);
  const db = await openReadyDb();
  const now = Date.now();
  const tx = db.transaction([...V6_WRITE_STORES], "readwrite");
  const fingerprint = await readFingerprint(tx, sanitized.relativePath);
  const place: ReadingPlace = {
    id: sanitized.id,
    relativePath: sanitized.relativePath,
    title: sanitized.title,
    target: sanitized.target,
    sourceRevision: captureRevision(fingerprint, now),
    sortIndex: sanitized.sortIndex,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    legacyColor: null,
    legacySelectedText: null,
  };
  putReadingPlaceProjection(tx, place, null);
  await transactionDone(tx);
  return place;
}

export async function upsertReflection(
  entryId: string,
  entryKind: AnnotationEntryKind,
  body: string,
): Promise<Reflection> {
  validateAnnotationId(entryId);
  const normalized = normalizeReflectionBody(body);
  const db = await openReadyDb();
  const now = Date.now();
  const tx = db.transaction([...V6_WRITE_STORES], "readwrite");
  await assertLiveEntry(tx, entryId, entryKind);
  const existing = await readReflection(tx, entryId);
  const reflection: Reflection = {
    entryId,
    entryKind,
    body: normalized,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    deletedAt: null,
  };
  await writeReflectionProjection(tx, reflection);
  await transactionDone(tx);
  return reflection;
}

export async function deleteReflection(entryId: string): Promise<void> {
  validateAnnotationId(entryId);
  const db = await openReadyDb();
  const now = Date.now();
  const tx = db.transaction([...V6_WRITE_STORES], "readwrite");
  const existing = await readReflection(tx, entryId);
  if (!existing || existing.deletedAt != null) throw new Error("感悟不存在");
  const reflection: Reflection = { ...existing, updatedAt: now, deletedAt: now };
  await writeReflectionProjection(tx, reflection);
  await transactionDone(tx);
}

export async function deleteAnnotationEntry(
  id: string,
  entryKind: AnnotationEntryKind,
): Promise<void> {
  await setEntryDeleted(id, entryKind, true);
}

export async function restoreAnnotationEntry(
  id: string,
  entryKind: AnnotationEntryKind,
): Promise<void> {
  await setEntryDeleted(id, entryKind, false);
}

export async function setReviewEnrollment(
  excerptId: string,
  enabled: boolean,
): Promise<ReviewEnrollment | null> {
  validateAnnotationId(excerptId);
  const db = await openReadyDb();
  const now = Date.now();
  const tx = db.transaction([...V6_WRITE_STORES], "readwrite");
  await readLiveExcerpt(tx, excerptId);
  const existing = (await requestToPromise(
    tx.objectStore(REVIEW_ENROLLMENTS_STORE).get(excerptId),
  )) as ReviewEnrollment | undefined;
  if (enabled) {
    const enrollment: ReviewEnrollment = existing
      ? { ...existing, suspended: false, deletedAt: null, updatedAt: now }
      : {
          excerptId,
          enrolledAt: now,
          box: 0,
          dueAt: now + REVIEW_IMPLICIT_DUE_OFFSET_MS,
          lastReviewedAt: null,
          totalReviews: 0,
          suspended: false,
          updatedAt: now,
          deletedAt: null,
        };
    tx.objectStore(REVIEW_ENROLLMENTS_STORE).put(enrollment);
    const review = (await requestToPromise(tx.objectStore(REVIEWS_STORE).get(excerptId))) as
      | { annotationId: string; box: number; dueAt: number; lastReviewedAt: number | null; totalReviews: number; suspended: boolean; updatedAt: number }
      | undefined;
    tx.objectStore(REVIEWS_STORE).put({
      annotationId: excerptId,
      box: review?.box ?? enrollment.box,
      dueAt: review?.dueAt ?? enrollment.dueAt,
      lastReviewedAt: review?.lastReviewedAt ?? enrollment.lastReviewedAt,
      totalReviews: review?.totalReviews ?? enrollment.totalReviews,
      suspended: false,
      updatedAt: now,
    });
    await transactionDone(tx);
    return enrollment;
  }
  if (existing) {
    tx.objectStore(REVIEW_ENROLLMENTS_STORE).put({
      ...existing,
      suspended: true,
      deletedAt: now,
      updatedAt: now,
    });
  }
  putSuspendedReview(tx, excerptId, now);
  await transactionDone(tx);
  return null;
}

function liveReflection(reflection: Reflection | undefined): Reflection | null {
  if (!reflection || reflection.deletedAt != null) return null;
  return reflection;
}

async function assertLiveEntry(
  tx: IDBTransaction,
  entryId: string,
  entryKind: AnnotationEntryKind,
): Promise<void> {
  if (entryKind === "excerpt") {
    await readLiveExcerpt(tx, entryId);
    return;
  }
  const place = (await requestToPromise(
    tx.objectStore(READING_PLACES_STORE).get(entryId),
  )) as ReadingPlace | undefined;
  if (!place || place.deletedAt != null) throw new Error("阅读位置不存在");
}

async function writeReflectionProjection(
  tx: IDBTransaction,
  reflection: Reflection,
): Promise<void> {
  tx.objectStore(REFLECTIONS_STORE).put(reflection);
  if (reflection.entryKind === "excerpt") {
    const excerpt = (await requestToPromise(
      tx.objectStore(EXCERPTS_STORE).get(reflection.entryId),
    )) as Excerpt | undefined;
    if (!excerpt) throw new Error("摘录不存在");
    putExcerptProjection(tx, excerpt, reflection);
  } else {
    const place = (await requestToPromise(
      tx.objectStore(READING_PLACES_STORE).get(reflection.entryId),
    )) as ReadingPlace | undefined;
    if (!place) throw new Error("阅读位置不存在");
    putReadingPlaceProjection(tx, place, reflection);
  }
}

async function setEntryDeleted(
  id: string,
  entryKind: AnnotationEntryKind,
  deleted: boolean,
): Promise<void> {
  validateAnnotationId(id);
  const db = await openReadyDb();
  const now = Date.now();
  const tx = db.transaction([...V6_WRITE_STORES], "readwrite");
  if (entryKind === "excerpt") {
    const excerpt = (await requestToPromise(
      tx.objectStore(EXCERPTS_STORE).get(id),
    )) as Excerpt | undefined;
    if (!excerpt) throw new Error("摘录不存在");
    if (deleted) {
      if (excerpt.deletedAt != null) throw new Error("摘录不存在");
      excerpt.deletedAt = now;
    } else {
      const previous = excerpt.deletedAt;
      if (previous == null) throw new Error("摘录不存在");
      excerpt.deletedAt = null;
      const reflection = await readReflection(tx, id);
      if (reflection?.deletedAt === previous) {
        reflection.deletedAt = null;
        reflection.updatedAt = now;
        tx.objectStore(REFLECTIONS_STORE).put(reflection);
      }
    }
    excerpt.updatedAt = now;
    if (deleted) {
      const reflection = await readReflection(tx, id);
      if (reflection && reflection.deletedAt == null) {
        reflection.deletedAt = now;
        reflection.updatedAt = now;
        tx.objectStore(REFLECTIONS_STORE).put(reflection);
      }
    }
    const reflection = await readReflection(tx, id);
    putExcerptProjection(tx, excerpt, reflection ?? null);
  } else {
    const place = (await requestToPromise(
      tx.objectStore(READING_PLACES_STORE).get(id),
    )) as ReadingPlace | undefined;
    if (!place) throw new Error("阅读位置不存在");
    if (deleted) {
      if (place.deletedAt != null) throw new Error("阅读位置不存在");
      place.deletedAt = now;
    } else {
      const previous = place.deletedAt;
      if (previous == null) throw new Error("阅读位置不存在");
      place.deletedAt = null;
      const reflection = await readReflection(tx, id);
      if (reflection?.deletedAt === previous) {
        reflection.deletedAt = null;
        reflection.updatedAt = now;
        tx.objectStore(REFLECTIONS_STORE).put(reflection);
      }
    }
    place.updatedAt = now;
    if (deleted) {
      const reflection = await readReflection(tx, id);
      if (reflection && reflection.deletedAt == null) {
        reflection.deletedAt = now;
        reflection.updatedAt = now;
        tx.objectStore(REFLECTIONS_STORE).put(reflection);
      }
    }
    const reflection = await readReflection(tx, id);
    putReadingPlaceProjection(tx, place, reflection ?? null);
  }
  await transactionDone(tx);
}

export async function annotationV6Status(): Promise<"pending" | "ready"> {
  const db = await openWebUserDatabase();
  const meta = await readAnnotationV6Meta(db);
  return meta?.status === "ready" ? "ready" : "pending";
}
