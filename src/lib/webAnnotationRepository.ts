import {
  toneToLegacyColor,
  type AnnotationEntryKind,
  type DocumentAnnotationBundle,
  type Excerpt,
  type ExcerptAppearance,
  type ExcerptCaptureResult,
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
import { validateLibraryRelativePath } from "./webLibrary";
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
  removeV6EntriesForPath,
  requestToPromise,
  transactionDone,
} from "./webAnnotationV6";

const DOCUMENTS_STORE = "documents";
const REVIEW_IMPLICIT_DUE_OFFSET_MS = 24 * 60 * 60 * 1000;
const MAX_DOCUMENT_ANNOTATION_BUNDLE_ROWS = 10_000;
const REVIEW_MAX_BOX = 5;

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

function liveReflection(reflection: Reflection | undefined): Reflection | null {
  if (!reflection || reflection.deletedAt != null) return null;
  return reflection;
}

async function readDocumentAnnotationBundle(
  tx: IDBTransaction,
  relativePath: string,
): Promise<DocumentAnnotationBundle> {
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

export async function listDocumentAnnotations(
  relativePath: string,
): Promise<DocumentAnnotationBundle> {
  validateLibraryRelativePath(relativePath);
  const db = await openReadyDb();
  const tx = db.transaction(
    [EXCERPTS_STORE, READING_PLACES_STORE, REFLECTIONS_STORE, REVIEW_ENROLLMENTS_STORE],
    "readonly",
  );
  return readDocumentAnnotationBundle(tx, relativePath);
}

export async function createExcerpt(
  draft: ExcerptDraft,
  reflectionBody: string | null,
): Promise<ExcerptCaptureResult> {
  const sanitized = validateExcerptDraft(draft);
  const normalizedReflection =
    reflectionBody === null ? null : normalizeReflectionBody(reflectionBody);
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
  const reflection: Reflection | null =
    normalizedReflection === null
      ? null
      : {
          entryId: excerpt.id,
          entryKind: "excerpt",
          body: normalizedReflection,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
  putExcerptProjection(tx, excerpt, reflection);
  await transactionDone(tx);
  return { excerpt, reflection };
}

function bundleRowCount(bundle: DocumentAnnotationBundle): number {
  return (
    bundle.excerpts.length +
    bundle.places.length +
    bundle.reflections.length +
    bundle.reviewEnrollments.length
  );
}

function requireRestoreTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}无效`);
}

function requireRestoreTimestampOrder(createdAt: number, updatedAt: number): void {
  requireRestoreTimestamp(createdAt, "标注创建时间");
  requireRestoreTimestamp(updatedAt, "标注更新时间");
  if (createdAt > updatedAt) throw new Error("标注时间顺序无效");
}

function validateRestoreSourceRevision(revision: SourceRevision | null): void {
  if (revision === null) return;
  if (
    typeof revision.contentHash !== "string" ||
    revision.contentHash.trim().length === 0 ||
    revision.contentHash.length > 256 ||
    !Number.isSafeInteger(revision.observedAt) ||
    revision.observedAt < 0 ||
    (revision.basis !== "capture" && revision.basis !== "migrationSnapshot")
  ) {
    throw new Error("标注来源版本无效");
  }
}

function validateDocumentAnnotationBundle(
  relativePath: string,
  snapshot: DocumentAnnotationBundle,
): DocumentAnnotationBundle {
  validateLibraryRelativePath(relativePath);
  if (
    !snapshot ||
    !Array.isArray(snapshot.excerpts) ||
    !Array.isArray(snapshot.places) ||
    !Array.isArray(snapshot.reflections) ||
    !Array.isArray(snapshot.reviewEnrollments)
  ) {
    throw new Error("标注恢复快照格式无效");
  }
  if (bundleRowCount(snapshot) > MAX_DOCUMENT_ANNOTATION_BUNDLE_ROWS) {
    throw new Error(`单篇文档标注恢复不能超过 ${MAX_DOCUMENT_ANNOTATION_BUNDLE_ROWS} 行`);
  }

  const parentKinds = new Map<string, AnnotationEntryKind>();
  for (const excerpt of snapshot.excerpts) {
    if (excerpt.deletedAt !== null) throw new Error("标注恢复快照不能包含墓碑");
    if (excerpt.relativePath !== relativePath) throw new Error("标注恢复快照包含其他文档");
    validateExcerptDraft({
      id: excerpt.id,
      relativePath: excerpt.relativePath,
      sourceText: excerpt.sourceText,
      anchor: excerpt.anchor,
      appearance: excerpt.appearance,
      sortIndex: excerpt.sortIndex,
    });
    requireRestoreTimestampOrder(excerpt.createdAt, excerpt.updatedAt);
    validateRestoreSourceRevision(excerpt.sourceRevision);
    if (excerpt.legacyTitle !== null && typeof excerpt.legacyTitle !== "string") {
      throw new Error("旧摘录标题无效");
    }
    if (excerpt.legacyTitle !== null && Array.from(excerpt.legacyTitle).length > 200) {
      throw new Error("旧摘录标题过长");
    }
    if (excerpt.legacySelectedText !== null && typeof excerpt.legacySelectedText !== "string") {
      throw new Error("旧摘录文本无效");
    }
    if (excerpt.legacySelectedText !== null && Array.from(excerpt.legacySelectedText).length > 2_000) {
      throw new Error("旧摘录文本过长");
    }
    if (parentKinds.has(excerpt.id)) throw new Error("标注恢复快照包含重复 ID");
    parentKinds.set(excerpt.id, "excerpt");
  }
  for (const place of snapshot.places) {
    if (place.deletedAt !== null) throw new Error("标注恢复快照不能包含墓碑");
    if (place.relativePath !== relativePath) throw new Error("标注恢复快照包含其他文档");
    validateReadingPlaceDraft({
      id: place.id,
      relativePath: place.relativePath,
      title: place.title,
      target: place.target,
      sortIndex: place.sortIndex,
    });
    requireRestoreTimestampOrder(place.createdAt, place.updatedAt);
    validateRestoreSourceRevision(place.sourceRevision);
    if (place.legacySelectedText !== null && typeof place.legacySelectedText !== "string") {
      throw new Error("旧阅读位置文本无效");
    }
    if (place.legacySelectedText !== null && Array.from(place.legacySelectedText).length > 2_000) {
      throw new Error("旧阅读位置文本过长");
    }
    if (parentKinds.has(place.id)) throw new Error("标注恢复快照包含重复 ID");
    parentKinds.set(place.id, "place");
  }

  const reflectionIds = new Set<string>();
  for (const reflection of snapshot.reflections) {
    if (reflection.deletedAt !== null) throw new Error("感悟恢复快照不能包含墓碑");
    validateAnnotationId(reflection.entryId);
    const parentKind = parentKinds.get(reflection.entryId);
    if (!parentKind) throw new Error("标注恢复快照包含孤立感悟");
    if (parentKind !== reflection.entryKind) throw new Error("标注恢复快照包含错配感悟");
    if (normalizeReflectionBody(reflection.body) !== reflection.body) {
      throw new Error("感悟恢复快照不是规范格式");
    }
    requireRestoreTimestampOrder(reflection.createdAt, reflection.updatedAt);
    if (reflectionIds.has(reflection.entryId)) throw new Error("标注恢复快照包含重复感悟");
    reflectionIds.add(reflection.entryId);
  }

  const enrollmentIds = new Set<string>();
  for (const enrollment of snapshot.reviewEnrollments) {
    if (enrollment.deletedAt !== null) throw new Error("回顾恢复快照不能包含墓碑");
    validateAnnotationId(enrollment.excerptId);
    if (parentKinds.get(enrollment.excerptId) !== "excerpt") {
      throw new Error("标注恢复快照包含孤立回顾状态");
    }
    requireRestoreTimestamp(enrollment.enrolledAt, "加入回顾时间");
    requireRestoreTimestamp(enrollment.dueAt, "回顾到期时间");
    requireRestoreTimestamp(enrollment.updatedAt, "回顾更新时间");
    if (enrollment.lastReviewedAt !== null) {
      requireRestoreTimestamp(enrollment.lastReviewedAt, "最近回顾时间");
    }
    if (!Number.isInteger(enrollment.box) || enrollment.box < 0 || enrollment.box > REVIEW_MAX_BOX) {
      throw new Error(`回顾箱位必须在 0 到 ${REVIEW_MAX_BOX} 之间`);
    }
    if (!Number.isSafeInteger(enrollment.totalReviews) || enrollment.totalReviews < 0) {
      throw new Error("回顾次数无效");
    }
    if (typeof enrollment.suspended !== "boolean") throw new Error("回顾暂停状态无效");
    if (enrollmentIds.has(enrollment.excerptId)) throw new Error("标注恢复快照包含重复回顾状态");
    enrollmentIds.add(enrollment.excerptId);
  }
  return snapshot;
}

export async function clearDocumentAnnotations(
  relativePath: string,
): Promise<DocumentAnnotationBundle> {
  validateLibraryRelativePath(relativePath);
  const db = await openReadyDb();
  const tx = db.transaction([...V6_WRITE_STORES], "readwrite");
  const snapshot = await readDocumentAnnotationBundle(tx, relativePath);
  if (bundleRowCount(snapshot) > MAX_DOCUMENT_ANNOTATION_BUNDLE_ROWS) {
    tx.abort();
    throw new Error(`单篇文档标注不能超过 ${MAX_DOCUMENT_ANNOTATION_BUNDLE_ROWS} 行`);
  }
  removeV6EntriesForPath(tx, relativePath);
  await transactionDone(tx);
  return snapshot;
}

async function restoreIdExists(tx: IDBTransaction, id: string): Promise<boolean> {
  const [excerpt, place, reflection, enrollment] = await Promise.all([
    requestToPromise(tx.objectStore(EXCERPTS_STORE).get(id)),
    requestToPromise(tx.objectStore(READING_PLACES_STORE).get(id)),
    requestToPromise(tx.objectStore(REFLECTIONS_STORE).get(id)),
    requestToPromise(tx.objectStore(REVIEW_ENROLLMENTS_STORE).get(id)),
  ]);
  return [excerpt, place, reflection, enrollment].some((item) => item !== undefined);
}

export async function restoreDocumentAnnotations(
  relativePath: string,
  snapshot: DocumentAnnotationBundle,
): Promise<DocumentAnnotationBundle> {
  const validated = validateDocumentAnnotationBundle(relativePath, snapshot);
  const db = await openReadyDb();
  const tx = db.transaction([...V6_WRITE_STORES], "readwrite");
  const current = await readDocumentAnnotationBundle(tx, relativePath);
  if (current.excerpts.length > 0 || current.places.length > 0) {
    tx.abort();
    throw new Error("清空后文档标注已发生变化");
  }
  for (const id of [
    ...validated.excerpts.map((item) => item.id),
    ...validated.places.map((item) => item.id),
  ]) {
    if (await restoreIdExists(tx, id)) {
      tx.abort();
      throw new Error("标注恢复与现有 ID 冲突");
    }
  }
  const reflectionById = new Map(validated.reflections.map((item) => [item.entryId, item]));
  for (const excerpt of validated.excerpts) {
    putExcerptProjection(tx, excerpt, reflectionById.get(excerpt.id) ?? null);
  }
  for (const place of validated.places) {
    putReadingPlaceProjection(tx, place, reflectionById.get(place.id) ?? null);
  }
  for (const enrollment of validated.reviewEnrollments) {
    tx.objectStore(REVIEW_ENROLLMENTS_STORE).put(enrollment);
  }
  await transactionDone(tx);
  return listDocumentAnnotations(relativePath);
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
  await transactionDone(tx);
  return null;
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
