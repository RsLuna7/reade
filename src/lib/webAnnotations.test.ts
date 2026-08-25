import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import type { Annotation, ReviewState } from "./backend";
import {
  clearWebDocumentAnnotations,
  deleteWebAnnotation,
  detectWebMovedDocuments,
  importWebAnnotations,
  listWebAnnotations,
  listWebAnnotationsForTransfer,
  listWebDocumentFingerprints,
  listWebReviewQueue,
  rebindWebDocumentAnnotations,
  recordWebReviewOutcome,
  resetWebAnnotationStoreForTests,
  searchWebAnnotations,
  syncWebDocumentFingerprints,
  upsertWebAnnotation,
  webReviewSummary,
  type WebDocumentFingerprint,
} from "./webAnnotations";

const DB_NAME = "reade-annotations";
const STORE_NAME = "annotations";
const DOCUMENTS_STORE = "documents";
const REVIEWS_STORE = "annotationReviews";
const REVIEW_ENROLLMENTS_STORE = "reviewEnrollments";
const DAY_MS = 24 * 60 * 60 * 1000;
const HASH_A = `ntxt:${"a".repeat(64)}`;
const HASH_B = `ntxt:${"b".repeat(64)}`;
const CURRENT_DB_VERSION = 7;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("request failed"));
  });
}

function openRaw(
  version?: number,
  onUpgrade?: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => onUpgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("cannot open raw db"));
  });
}

function createStore(db: IDBDatabase): void {
  const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
  store.createIndex("relativePath", "relativePath", { unique: false });
}

/** Writes records (any shape) and waits for the transaction to commit. */
function seedRecords(db: IDBDatabase, records: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("seed failed"));
    const store = tx.objectStore(STORE_NAME);
    for (const record of records) store.put(record as Annotation);
  });
}

/** Reads reverse-projected rows (tombstones included) from the v6 stores. */
async function readAllProjected(includeDeleted = true): Promise<Annotation[]> {
  return includeDeleted
    ? listWebAnnotationsForTransfer()
    : listWebAnnotations(null);
}

async function readAllLegacyRaw(): Promise<Annotation[]> {
  const db = await openRaw();
  try {
    const tx = db.transaction(STORE_NAME, "readonly");
    return await requestToPromise(tx.objectStore(STORE_NAME).getAll() as IDBRequest<Annotation[]>);
  } finally {
    db.close();
  }
}

function makeAnnotation(
  id: string,
  relativePath: string,
  overrides: Partial<Annotation> = {},
): Annotation {
  return {
    id,
    relativePath,
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "hello world",
    title: "hello world",
    locator: {
      kind: "markdown",
      quote: "hello world",
      prefix: "say ",
      suffix: " today",
      headingId: null,
      start: 1024,
      end: 1035,
    },
    sortIndex: "M|00000|00001024",
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetWebAnnotationStoreForTests();
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = new IDBFactory();
});

describe("v1 → v2 upgrade", () => {
  it("backfills during the chain then v7 wipe clears legacy content", async () => {
    // Hand-build a v1 database: no sortIndex, no deletedAt, physical shape.
    const legacy = [
      {
        id: "ann-markdown",
        relativePath: "notes/a.md",
        kind: "highlight",
        color: "yellow",
        note: "remember",
        selectedText: "hello world",
        title: "Title",
        locator: {
          kind: "markdown",
          quote: "hello world",
          prefix: "say ",
          suffix: " today",
          headingId: "intro",
        },
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: "ann-pdf",
        relativePath: "paper.pdf",
        kind: "highlight",
        color: "yellow",
        note: null,
        selectedText: "q",
        title: null,
        locator: {
          kind: "pdf",
          page: 3,
          view: "original",
          quote: "q",
          prefix: "",
          suffix: "",
          rects: [{ x: 0.1, y: 0.25, w: 0.5, h: 0.02 }],
        },
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: "ann-epub",
        relativePath: "book.epub",
        kind: "underline",
        color: "blue",
        note: null,
        selectedText: "q",
        title: null,
        locator: {
          kind: "epub",
          chapterId: "OEBPS/ch1.xhtml",
          blockIndex: 2,
          startOffset: 15,
          endOffset: 25,
          quote: "q",
          prefix: "",
          suffix: "",
        },
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: "ann-bookmark",
        relativePath: "notes/a.md",
        kind: "bookmark",
        color: null,
        note: null,
        selectedText: null,
        title: null,
        locator: {
          kind: "bookmark",
          target: { format: "markdown", headingId: null, scrollRatio: 0.5 },
        },
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: "ann-corrupt",
        relativePath: "broken.md",
        kind: "highlight",
        color: "yellow",
        note: null,
        selectedText: "x",
        title: null,
        locator: { kind: "not-a-kind" },
        createdAt: 100,
        updatedAt: 100,
      },
    ];
    const seed = await openRaw(1, createStore);
    await seedRecords(seed, legacy);
    seed.close();

    // Full upgrade to current: v2 backfill runs, then v7 wipe clears content.
    expect(await listWebAnnotations(null)).toEqual([]);
    expect(await readAllLegacyRaw()).toEqual([]);

    const db = await openRaw();
    expect(db.version).toBe(CURRENT_DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual(
      [
        STORE_NAME,
        DOCUMENTS_STORE,
        REVIEWS_STORE,
        "collections",
        "collectionItems",
        "annotationV6Meta",
        "excerpts",
        "readingPlaces",
        "reflections",
        "reviewEnrollments",
      ].sort(),
    );
    const meta = await requestToPromise(
      db.transaction("annotationV6Meta", "readonly").objectStore("annotationV6Meta").get(
        "annotationV6",
      ),
    );
    expect(meta).toMatchObject({
      status: "ready",
      excerptCount: 0,
      placeCount: 0,
      reflectionCount: 0,
    });
    db.close();
  });

  it("keeps records already carrying v2 fields through the v2 step before wipe", async () => {
    const seed = await openRaw(1, createStore);
    await seedRecords(seed, [
      makeAnnotation("ann-kept", "notes/a.md", { sortIndex: "M|00000|00000007" }),
    ]);
    seed.close();

    // Opening via the app upgrades through v7 wipe — legacy rows are gone.
    expect(await listWebAnnotations(null)).toEqual([]);
    expect(await readAllLegacyRaw()).toEqual([]);
  });
});

describe("tombstone semantics", () => {
  it("delete writes a tombstone, list filters it, upsert resurrects it", async () => {
    const annotation = makeAnnotation("ann-1", "notes/a.md");
    await upsertWebAnnotation(annotation);
    await upsertWebAnnotation(makeAnnotation("ann-2", "notes/b.md"));

    const before = Date.now();
    await deleteWebAnnotation("ann-1");

    expect((await listWebAnnotations(null)).map((item) => item.id)).toEqual(["ann-2"]);
    expect(await listWebAnnotations("notes/a.md")).toEqual([]);

    const projected = await readAllProjected(true);
    const tombstone = projected.find((record) => record.id === "ann-1");
    expect(typeof tombstone?.deletedAt).toBe("number");
    expect(tombstone!.deletedAt!).toBeGreaterThanOrEqual(before);
    expect(tombstone!.updatedAt).toBe(tombstone!.deletedAt);
    // Legacy annotations store stays empty after v7.
    expect(await readAllLegacyRaw()).toEqual([]);

    // A tombstoned id behaves as missing, like the desktop command.
    await expect(deleteWebAnnotation("ann-1")).rejects.toThrow("not found");
    await expect(deleteWebAnnotation("ann-unknown")).rejects.toThrow("not found");

    // Undo restores by upserting the original annotation.
    await upsertWebAnnotation(annotation);
    expect((await listWebAnnotations("notes/a.md")).map((item) => item.id)).toEqual(["ann-1"]);
  });

  it("clearing a document purges its rows physically, tombstones included", async () => {
    await upsertWebAnnotation(makeAnnotation("ann-a1", "a.md"));
    await upsertWebAnnotation(makeAnnotation("ann-a2", "a.md"));
    await upsertWebAnnotation(makeAnnotation("ann-b", "b.md"));
    await deleteWebAnnotation("ann-a1");

    await clearWebDocumentAnnotations("a.md");

    const projected = await readAllProjected(true);
    expect(projected.map((record) => record.id)).toEqual(["ann-b"]);
    expect((await listWebAnnotations("b.md")).map((item) => item.id)).toEqual(["ann-b"]);
  });

  it("purges only expired tombstones on open", async () => {
    const now = Date.now();
    await upsertWebAnnotation(makeAnnotation("ann-live", "a.md"));
    await upsertWebAnnotation(
      makeAnnotation("ann-old", "a.md", {
        deletedAt: now - 91 * DAY_MS,
        updatedAt: now - 91 * DAY_MS,
      }),
    );
    await upsertWebAnnotation(
      makeAnnotation("ann-fresh", "a.md", {
        deletedAt: now - DAY_MS,
        updatedAt: now - DAY_MS,
      }),
    );

    resetWebAnnotationStoreForTests();
    const listed = await listWebAnnotations(null);
    expect(listed.map((item) => item.id)).toEqual(["ann-live"]);

    const projected = await readAllProjected(true);
    const ids = projected.map((record) => record.id).sort();
    expect(ids).toEqual(["ann-fresh", "ann-live"]);
  });
});

describe("upsert sort index fallback", () => {
  it("derives a missing sort key from the locator", async () => {
    const saved = await upsertWebAnnotation(
      makeAnnotation("ann-derive", "notes/a.md", { sortIndex: "" }),
    );
    expect(saved.sortIndex).toBe("M|00000|00001024");
    const listed = await listWebAnnotations("notes/a.md");
    expect(listed[0].sortIndex).toBe("M|00000|00001024");
    expect(await readAllLegacyRaw()).toEqual([]);
  });

  it("rejects malformed sort keys", async () => {
    await expect(
      upsertWebAnnotation(makeAnnotation("ann-bad", "notes/a.md", { sortIndex: "garbage" })),
    ).rejects.toThrow("sort index");
  });

  it("defaults deletedAt to null for records that omit it", async () => {
    const annotation = makeAnnotation("ann-default", "notes/a.md");
    delete (annotation as Partial<Annotation>).deletedAt;
    const saved = await upsertWebAnnotation(annotation);
    expect(saved.deletedAt).toBeNull();
    const listed = await listWebAnnotations("notes/a.md");
    expect(listed[0].deletedAt).toBeNull();
  });
});

async function readAllFingerprints(): Promise<WebDocumentFingerprint[]> {
  const db = await openRaw();
  try {
    const tx = db.transaction(DOCUMENTS_STORE, "readonly");
    return await requestToPromise(
      tx.objectStore(DOCUMENTS_STORE).getAll() as IDBRequest<WebDocumentFingerprint[]>,
    );
  } finally {
    db.close();
  }
}

describe("document fingerprints and the move rebind chain", () => {
  it("sync upserts manifest fingerprints and retains rows for vanished paths", async () => {
    await syncWebDocumentFingerprints(
      [
        { relativePath: "old.md", size: 10, contentHash: HASH_A },
        { relativePath: "keep.md", size: 20, contentHash: HASH_B },
        { relativePath: "no-hash.md", size: 30 },
      ],
      1_000,
    );
    // The next manifest no longer contains old.md; its row must survive as
    // the rebind clue, while keep.md is refreshed in place.
    await syncWebDocumentFingerprints(
      [{ relativePath: "keep.md", size: 22, contentHash: HASH_B }],
      2_000,
    );

    const rows = await readAllFingerprints();
    expect(rows).toHaveLength(2);
    const byPath = new Map(rows.map((row) => [row.relativePath, row]));
    expect(byPath.get("old.md")).toEqual({
      relativePath: "old.md",
      contentHash: HASH_A,
      fileSize: 10,
      lastSeenAt: 1_000,
    });
    expect(byPath.get("keep.md")).toEqual({
      relativePath: "keep.md",
      contentHash: HASH_B,
      fileSize: 22,
      lastSeenAt: 2_000,
    });
  });

  it("detects a one-to-one move from stored fingerprints and live annotations", async () => {
    await upsertWebAnnotation(makeAnnotation("ann-1", "old.md"));
    await upsertWebAnnotation(makeAnnotation("ann-2", "old.md"));
    await upsertWebAnnotation(makeAnnotation("ann-3", "old.md"));
    await deleteWebAnnotation("ann-3");
    await syncWebDocumentFingerprints(
      [{ relativePath: "old.md", size: 10, contentHash: HASH_A }],
      1_000,
    );

    const manifest = [
      { relativePath: "moved/new.md", size: 10, contentHash: HASH_A },
      { relativePath: "other.md", size: 5, contentHash: HASH_B },
    ];
    await syncWebDocumentFingerprints(manifest, 2_000);
    // Tombstoned ann-3 must not count toward the migration size.
    await expect(detectWebMovedDocuments(manifest)).resolves.toEqual([
      { oldPath: "old.md", newPath: "moved/new.md", annotationCount: 2, ambiguous: false },
    ]);

    // Without a stored fingerprint for the vanished path there is no clue.
    await upsertWebAnnotation(makeAnnotation("ann-4", "unhashed.md"));
    const detected = await detectWebMovedDocuments(manifest);
    expect(detected).toHaveLength(1);
    expect(detected[0].oldPath).toBe("old.md");
  });

  it("rebind moves live records and tombstones, drops the stale fingerprint row", async () => {
    await upsertWebAnnotation(makeAnnotation("ann-1", "old.md"));
    await upsertWebAnnotation(makeAnnotation("ann-2", "old.md"));
    await deleteWebAnnotation("ann-2");
    await upsertWebAnnotation(makeAnnotation("ann-other", "other.md"));
    await syncWebDocumentFingerprints(
      [
        { relativePath: "old.md", size: 10, contentHash: HASH_A },
        { relativePath: "moved/new.md", size: 10, contentHash: HASH_A },
      ],
      1_000,
    );

    await expect(rebindWebDocumentAnnotations("old.md", "moved/new.md")).resolves.toBe(2);

    expect(await listWebAnnotations("old.md")).toEqual([]);
    expect((await listWebAnnotations("moved/new.md")).map((item) => item.id)).toEqual(["ann-1"]);
    const projected = await readAllProjected(true);
    const tombstone = projected.find((record) => record.id === "ann-2");
    expect(tombstone?.relativePath).toBe("moved/new.md");
    expect(typeof tombstone?.deletedAt).toBe("number");
    expect(projected.find((record) => record.id === "ann-other")?.relativePath).toBe("other.md");

    const fingerprints = await readAllFingerprints();
    expect(fingerprints.map((row) => row.relativePath)).toEqual(["moved/new.md"]);

    await expect(rebindWebDocumentAnnotations("old.md", "moved/new.md")).resolves.toBe(0);
  });

  it("rebind rejects unsafe or identical paths", async () => {
    await expect(rebindWebDocumentAnnotations("../escape.md", "new.md")).rejects.toThrow();
    await expect(rebindWebDocumentAnnotations("old.md", "/rooted.md")).rejects.toThrow();
    await expect(rebindWebDocumentAnnotations("old.md", "old.md")).rejects.toThrow(
      "different paths",
    );
  });
});

// ---- Spaced-repetition review state (mirrors user_store.rs, plan R0) ----

interface RawReviewRecord {
  annotationId: string;
  box: number;
  dueAt: number;
  lastReviewedAt: number | null;
  totalReviews: number;
  suspended: boolean;
  updatedAt: number;
}

interface RawEnrollmentRecord {
  excerptId: string;
  enrolledAt: number;
  box: number;
  dueAt: number;
  lastReviewedAt: number | null;
  totalReviews: number;
  suspended: boolean;
  updatedAt: number;
  deletedAt: number | null;
}

async function readAllReviews(): Promise<RawReviewRecord[]> {
  const db = await openRaw();
  try {
    const tx = db.transaction(REVIEWS_STORE, "readonly");
    return await requestToPromise(
      tx.objectStore(REVIEWS_STORE).getAll() as IDBRequest<RawReviewRecord[]>,
    );
  } finally {
    db.close();
  }
}

async function readAllEnrollments(): Promise<RawEnrollmentRecord[]> {
  const db = await openRaw();
  try {
    const tx = db.transaction(REVIEW_ENROLLMENTS_STORE, "readonly");
    return await requestToPromise(
      tx.objectStore(REVIEW_ENROLLMENTS_STORE).getAll() as IDBRequest<RawEnrollmentRecord[]>,
    );
  } finally {
    db.close();
  }
}

/** Writes enrollment rows (the store must already exist at v6+). */
async function seedEnrollmentRecords(records: RawEnrollmentRecord[]): Promise<void> {
  const db = await openRaw();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(REVIEW_ENROLLMENTS_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("seed enrollments failed"));
      const store = tx.objectStore(REVIEW_ENROLLMENTS_STORE);
      for (const record of records) store.put(record);
    });
  } finally {
    db.close();
  }
}

function enrollmentRecord(
  excerptId: string,
  overrides: Partial<RawEnrollmentRecord> = {},
): RawEnrollmentRecord {
  return {
    excerptId,
    enrolledAt: 1,
    box: 1,
    dueAt: 0,
    lastReviewedAt: null,
    totalReviews: 1,
    suspended: false,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

function reviewState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    box: 1,
    dueAt: 0,
    lastReviewedAt: null,
    totalReviews: 0,
    suspended: false,
    ...overrides,
  };
}

function bookmarkAnnotation(id: string, relativePath: string, title: string): Annotation {
  return makeAnnotation(id, relativePath, {
    kind: "bookmark",
    color: null,
    selectedText: null,
    title,
    locator: {
      kind: "bookmark",
      target: { format: "markdown", headingId: null, scrollRatio: 0.5 },
    },
    sortIndex: "M|00000|50000000",
  });
}

describe("v3 → v4 upgrade", () => {
  it("keeps schema stores through the chain; v7 wipe clears seeded rows", async () => {
    const seed = await openRaw(3, (db) => {
      createStore(db);
      db.createObjectStore(DOCUMENTS_STORE, { keyPath: "relativePath" });
    });
    await seedRecords(seed, [makeAnnotation("ann-v3", "notes/a.md")]);
    seed.close();

    // First use triggers the upgrade; v7 wipe clears the seeded legacy row.
    expect(await listWebAnnotations(null)).toEqual([]);

    const db = await openRaw();
    expect(db.version).toBe(CURRENT_DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual(
      [
        STORE_NAME,
        DOCUMENTS_STORE,
        REVIEWS_STORE,
        "collections",
        "collectionItems",
        "annotationV6Meta",
        "excerpts",
        "readingPlaces",
        "reflections",
        "reviewEnrollments",
      ].sort(),
    );
    db.close();
    expect(await readAllReviews()).toEqual([]);
  });
});

describe("v6 → v7 wipe", () => {
  it("clears annotation content, keeps shells, and marks the ledger ready empty", async () => {
    const seed = await openRaw(5, (db) => {
      createStore(db);
      db.createObjectStore(DOCUMENTS_STORE, { keyPath: "relativePath" });
      db.createObjectStore(REVIEWS_STORE, { keyPath: "annotationId" });
      db.createObjectStore("collections", { keyPath: "id" });
      const items = db.createObjectStore("collectionItems", {
        keyPath: ["collectionId", "relativePath"],
      });
      items.createIndex("collectionId", "collectionId", { unique: false });
    });
    await seedRecords(seed, [
      makeAnnotation("ann-v5", "notes/a.md", { note: "keep me", color: "pink" }),
    ]);
    await new Promise<void>((resolve, reject) => {
      const tx = seed.transaction("collections", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("seed collection failed"));
      tx.objectStore("collections").put({
        id: "col-1",
        name: "shell",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    seed.close();

    expect(await listWebAnnotations("notes/a.md")).toEqual([]);
    expect(await readAllLegacyRaw()).toEqual([]);

    const { openWebUserDatabase } = await import("./webAnnotations");
    const { readAnnotationV6Meta } = await import("./webAnnotationV6");
    const db = await openWebUserDatabase();
    const meta = await readAnnotationV6Meta(db);
    expect(meta?.status).toBe("ready");
    expect(meta?.excerptCount).toBe(0);
    expect(meta?.placeCount).toBe(0);
    expect(meta?.reflectionCount).toBe(0);
    expect(db.version).toBe(CURRENT_DB_VERSION);

    const collections = await requestToPromise(
      db.transaction("collections", "readonly").objectStore("collections").getAll(),
    );
    expect(collections).toEqual([
      expect.objectContaining({ id: "col-1", name: "shell" }),
    ]);
  });
});

describe("review queue (contract fixture Q1..Q7, mirrored by the Rust tests)", () => {
  const created = 1_700_000_000_000;

  it("keeps unenrolled marks out of the queue and filters the pool (Q1..Q6)", async () => {
    // Q1: no enrollment → not enrolled, never due.
    await upsertWebAnnotation(
      makeAnnotation("ann-implicit", "a.md", { createdAt: created, updatedAt: created }),
    );
    // Q2: explicit enrollments order by dueAt ascending.
    await upsertWebAnnotation(makeAnnotation("ann-early", "b.md", { createdAt: created }));
    await upsertWebAnnotation(makeAnnotation("ann-late", "b.md", { createdAt: created }));
    // Q3: suspended enrollments never enter the queue.
    await upsertWebAnnotation(makeAnnotation("ann-susp", "c.md", { createdAt: created }));
    // Q4: tombstones are excluded.
    await upsertWebAnnotation(makeAnnotation("ann-dead", "c.md", { createdAt: created }));
    await deleteWebAnnotation("ann-dead");
    // Q5: bookmarks are not review material.
    await upsertWebAnnotation(bookmarkAnnotation("ann-bookmark", "c.md", "第三章 力学导论"));
    // Q6: a blank excerpt is excluded.
    await upsertWebAnnotation(
      makeAnnotation("ann-blank", "c.md", { selectedText: "   ", createdAt: created }),
    );
    await seedEnrollmentRecords([
      enrollmentRecord("ann-early", { box: 1, dueAt: created + 1_000, lastReviewedAt: created }),
      enrollmentRecord("ann-late", {
        box: 2,
        dueAt: created + 2 * DAY_MS,
        lastReviewedAt: created,
      }),
      enrollmentRecord("ann-susp", { box: 0, dueAt: created, suspended: true }),
    ]);

    const now = created + DAY_MS;
    const queue = await listWebReviewQueue(now, 10);
    expect(queue.map((item) => item.annotation.id)).toEqual(["ann-early"]);
    expect(queue[0].review.box).toBe(1);
    expect(queue[0].review.dueAt).toBe(created + 1_000);

    // Q1 boundary: one millisecond before createdAt + 1d the enrolled row is still due.
    const before = await listWebReviewQueue(now - 1, 10);
    expect(before.map((item) => item.annotation.id)).toEqual(["ann-early"]);
  });

  it("over-fetches three times the limit and clamps a zero limit (Q7)", async () => {
    for (let index = 0; index < 7; index += 1) {
      await upsertWebAnnotation(
        makeAnnotation(`ann-${index}`, `doc-${index}.md`, { createdAt: created }),
      );
    }
    await seedEnrollmentRecords(
      Array.from({ length: 7 }, (_, index) =>
        enrollmentRecord(`ann-${index}`, { box: 0, dueAt: created, totalReviews: 0 }),
      ),
    );
    const now = created + 2 * DAY_MS;
    expect(await listWebReviewQueue(now, 2)).toHaveLength(6);
    expect(await listWebReviewQueue(now, 0)).toHaveLength(3);
  });
});

describe("recordWebReviewOutcome", () => {
  it("validates like the desktop command and counts reviews itself", async () => {
    const now = Date.now();
    await upsertWebAnnotation(makeAnnotation("ann-live", "a.md"));
    await upsertWebAnnotation(makeAnnotation("ann-gone", "a.md"));
    await deleteWebAnnotation("ann-gone");
    await seedEnrollmentRecords([
      enrollmentRecord("ann-live", { box: 0, dueAt: now + DAY_MS, totalReviews: 0 }),
    ]);

    const valid = reviewState({ box: 1, dueAt: now + 3 * DAY_MS, lastReviewedAt: now });
    // Rejection matrix: unknown id, tombstoned id, unenrolled id, box outside
    // 0..=5, due date outside [now − 1h, now + 180d], future lastReviewedAt.
    await expect(recordWebReviewOutcome("ann-unknown", valid)).rejects.toThrow("not found");
    await expect(recordWebReviewOutcome("ann-gone", valid)).rejects.toThrow("not found");
    await upsertWebAnnotation(makeAnnotation("ann-unenrolled", "a.md"));
    await expect(recordWebReviewOutcome("ann-unenrolled", valid)).rejects.toThrow("not enrolled");
    await expect(
      recordWebReviewOutcome("ann-live", reviewState({ box: -1, dueAt: now + DAY_MS })),
    ).rejects.toThrow("box");
    await expect(
      recordWebReviewOutcome("ann-live", reviewState({ box: 6, dueAt: now + DAY_MS })),
    ).rejects.toThrow("box");
    await expect(
      recordWebReviewOutcome("ann-live", reviewState({ dueAt: now - 2 * 60 * 60 * 1000 })),
    ).rejects.toThrow("due date");
    await expect(
      recordWebReviewOutcome("ann-live", reviewState({ dueAt: now + 181 * DAY_MS })),
    ).rejects.toThrow("due date");
    await expect(
      recordWebReviewOutcome(
        "ann-live",
        reviewState({ dueAt: now + DAY_MS, lastReviewedAt: now + 2 * 60 * 60 * 1000 }),
      ),
    ).rejects.toThrow("future");
    expect(await readAllReviews()).toEqual([]);

    // remembered → counted server-side; the caller's totalReviews is ignored.
    await recordWebReviewOutcome(
      "ann-live",
      reviewState({ box: 1, dueAt: now + 3 * DAY_MS, lastReviewedAt: now, totalReviews: 99 }),
    );
    let rows = await readAllEnrollments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      excerptId: "ann-live",
      box: 1,
      totalReviews: 1,
      suspended: false,
    });

    // again → counted once more.
    await recordWebReviewOutcome(
      "ann-live",
      reviewState({ box: 0, dueAt: now + DAY_MS, lastReviewedAt: now }),
    );
    rows = await readAllEnrollments();
    expect(rows[0]).toMatchObject({ box: 0, totalReviews: 2 });

    // suspend flips the flag without counting a review.
    await recordWebReviewOutcome(
      "ann-live",
      reviewState({ box: 0, dueAt: now + DAY_MS, lastReviewedAt: now, suspended: true }),
    );
    rows = await readAllEnrollments();
    expect(rows[0]).toMatchObject({ totalReviews: 2, suspended: true });
  });
});

describe("webReviewSummary", () => {
  it("counts due candidates and reviews inside the day window", async () => {
    const now = Date.now();
    const created = now - 10 * DAY_MS;
    const dayStart = now - 60 * 60 * 1000;
    await upsertWebAnnotation(makeAnnotation("ann-a", "a.md", { createdAt: created }));
    await upsertWebAnnotation(makeAnnotation("ann-b", "b.md", { createdAt: created }));
    await upsertWebAnnotation(makeAnnotation("ann-c", "c.md", { createdAt: created }));
    await seedEnrollmentRecords([
      enrollmentRecord("ann-b", { dueAt: now - 1_000, lastReviewedAt: dayStart + 500 }),
      enrollmentRecord("ann-c", {
        box: 2,
        dueAt: now + DAY_MS,
        lastReviewedAt: dayStart - 5_000,
      }),
    ]);
    await expect(webReviewSummary(dayStart, now)).resolves.toEqual({
      dueCount: 1,
      reviewedToday: 1,
    });
    await expect(webReviewSummary(now + 1, now)).rejects.toThrow("range");
  });
});

describe("orphan enrollment purge on open", () => {
  it("drops enrollments without a surviving excerpt, keeps rows of live tombstones", async () => {
    const now = Date.now();
    await upsertWebAnnotation(makeAnnotation("ann-live", "a.md"));
    await upsertWebAnnotation(
      makeAnnotation("ann-old", "a.md", {
        deletedAt: now - 91 * DAY_MS,
        updatedAt: now - 91 * DAY_MS,
      }),
    );
    await upsertWebAnnotation(
      makeAnnotation("ann-fresh", "a.md", {
        deletedAt: now - DAY_MS,
        updatedAt: now - DAY_MS,
      }),
    );
    await seedEnrollmentRecords([
      enrollmentRecord("ann-live", { dueAt: now }),
      enrollmentRecord("ann-old", { dueAt: now }),
      enrollmentRecord("ann-fresh", { dueAt: now }),
      enrollmentRecord("ann-ghost", { dueAt: now }),
    ]);

    resetWebAnnotationStoreForTests();
    await listWebAnnotations(null);
    const remaining = (await readAllEnrollments()).map((row) => row.excerptId).sort();
    expect(remaining).toEqual(["ann-fresh", "ann-live"]);
  });
});

// ---- Annotation search (contract cases C1..C19, see annotationSearch.test.ts) ----

describe("searchWebAnnotations", () => {
  async function hits(query: string, limit = 50): Promise<string[]> {
    return (await searchWebAnnotations(query, limit)).map((annotation) => annotation.id);
  }

  it("matches the shared contract cases and orders by path and position", async () => {
    await upsertWebAnnotation(
      makeAnnotation("ann-cn", "notes/physics.md", {
        selectedText: "量子纠缠是一种物理现象",
        title: null,
      }),
    );
    await upsertWebAnnotation(
      makeAnnotation("ann-en", "notes/hello.md", {
        selectedText: "Hello World reading notes",
        title: null,
      }),
    );
    await upsertWebAnnotation(
      makeAnnotation("ann-full", "notes/full.md", {
        selectedText: "ｈｅｌｌｏ　ｗｏｒｌｄ",
        title: null,
      }),
    );
    await upsertWebAnnotation(
      makeAnnotation("ann-note", "notes/note.md", {
        selectedText: "占位",
        note: "回头再读这一段",
        title: null,
      }),
    );
    await upsertWebAnnotation(bookmarkAnnotation("ann-bm", "chapters/three.md", "第三章 力学导论"));
    await upsertWebAnnotation(
      makeAnnotation("ann-dead", "notes/physics.md", {
        selectedText: "量子纠缠已删除样本",
        title: null,
      }),
    );
    await deleteWebAnnotation("ann-dead");

    await expect(hits("量子")).resolves.toEqual(["ann-cn"]); // C1
    await expect(hits("量子纠")).resolves.toEqual(["ann-cn"]); // C2
    await expect(hits("引力")).resolves.toEqual([]); // C3
    await expect(hits("HELLO")).resolves.toEqual(["ann-full", "ann-en"]); // C4 + path order
    await expect(hits("HE")).resolves.toEqual(["ann-full", "ann-en"]); // C5
    await expect(hits("ｈｅｌｌｏ")).resolves.toEqual(["ann-full", "ann-en"]); // C6
    await expect(hits("hello")).resolves.toEqual(["ann-full", "ann-en"]); // C7
    await expect(hits("回头再读")).resolves.toEqual(["ann-note"]); // C8
    await expect(hits("第三章")).resolves.toEqual(["ann-bm"]); // C9 (3 chars)
    await expect(hits("导论")).resolves.toEqual(["ann-bm"]); // C9 (2 chars)
    await expect(hits("已删除")).resolves.toEqual([]); // C10
    await expect(hits("")).resolves.toEqual([]); // C17
    await expect(hits("   ")).resolves.toEqual([]); // C17
  });

  it("applies the limit and the 256-char truncation (C18/C19)", async () => {
    await upsertWebAnnotation(
      makeAnnotation("ann-c", "c.md", { selectedText: "共享词组样本", title: null }),
    );
    await upsertWebAnnotation(
      makeAnnotation("ann-a", "a.md", { selectedText: "共享词组样本", title: null }),
    );
    await upsertWebAnnotation(
      makeAnnotation("ann-b", "b.md", { selectedText: "共享词组样本", title: null }),
    );
    await expect(hits("共享词组")).resolves.toEqual(["ann-a", "ann-b", "ann-c"]);
    await expect(hits("共享词组", 2)).resolves.toEqual(["ann-a", "ann-b"]); // C18
    await expect(hits("共享词组", 0)).resolves.toEqual(["ann-a"]); // clamped to ≥1

    await upsertWebAnnotation(
      makeAnnotation("ann-long", "long.md", { selectedText: "y".repeat(300), title: null }),
    );
    // C19: the 257-char query matches only because its tail is cut at 256.
    await expect(hits(`${"y".repeat(256)}z`)).resolves.toEqual(["ann-long"]);
    await expect(hits(`${"y".repeat(255)}z`)).resolves.toEqual([]);
  });
});

describe("annotation transfer (export/import, §5.7)", () => {
  it("lists every record including tombstones in transfer order", async () => {
    await upsertWebAnnotation(makeAnnotation("ann-b", "b.md"));
    await upsertWebAnnotation(makeAnnotation("ann-a", "a.md"));
    await deleteWebAnnotation("ann-b");

    const records = await listWebAnnotationsForTransfer();
    expect(records.map((record) => record.id)).toEqual(["ann-a", "ann-b"]);
    expect(typeof records[1].deletedAt).toBe("number");
    // The live listing keeps hiding the tombstone.
    await expect(listWebAnnotations(null)).resolves.toHaveLength(1);
  });

  it("imports records and seeds fingerprints for missing paths only", async () => {
    await syncWebDocumentFingerprints(
      [
        { relativePath: "present.md", size: 10, contentHash: HASH_A },
        { relativePath: "already-known.md", size: 10, contentHash: HASH_A },
      ],
      1_000,
    );

    const written = await importWebAnnotations(
      [
        makeAnnotation("imp-live", "present.md"),
        makeAnnotation("imp-dead", "moved/away.md", { deletedAt: 900, updatedAt: 900 }),
      ],
      [
        { relativePath: "present.md", contentHash: HASH_B },
        { relativePath: "moved/away.md", contentHash: HASH_B },
        { relativePath: "already-known.md", contentHash: HASH_B },
      ],
      new Set(["present.md"]),
      2_000,
    );
    expect(written).toBe(2);

    const records = await listWebAnnotationsForTransfer();
    expect(records.map((record) => record.id).sort()).toEqual(["imp-dead", "imp-live"]);
    expect(records.find((record) => record.id === "imp-dead")?.deletedAt).toBe(900);
    expect(await readAllLegacyRaw()).toEqual([]);

    const fingerprints = await listWebDocumentFingerprints();
    // present.md keeps its manifest-synced hash; moved/away.md is seeded
    // from the envelope; already-known.md keeps the locally stored value.
    expect(fingerprints).toEqual([
      { relativePath: "already-known.md", contentHash: HASH_A },
      { relativePath: "moved/away.md", contentHash: HASH_B },
      { relativePath: "present.md", contentHash: HASH_A },
    ]);
  });

  it("validates before writing and enforces the batch cap", async () => {
    // Initialize the schema so the raw reads below see the real store.
    await expect(listWebAnnotationsForTransfer()).resolves.toEqual([]);
    await expect(
      importWebAnnotations(
        [makeAnnotation("imp-bad", "../escape.md")],
        [],
        new Set(),
      ),
    ).rejects.toThrow();
    await expect(readAllLegacyRaw()).resolves.toEqual([]);

    const oversized = Array.from({ length: 10_001 }, (_, index) =>
      makeAnnotation(`imp-${index}`, "a.md"),
    );
    await expect(importWebAnnotations(oversized, [], new Set())).rejects.toThrow(/limit/);
    await expect(readAllLegacyRaw()).resolves.toEqual([]);
  });

  it("seeded fingerprints feed the move-detection chain", async () => {
    await importWebAnnotations(
      [makeAnnotation("imp-moved", "old/location.md")],
      [{ relativePath: "old/location.md", contentHash: HASH_A }],
      new Set(["notes/current.md"]),
    );
    const candidates = await detectWebMovedDocuments([
      { relativePath: "notes/current.md", size: 10, contentHash: HASH_A },
    ]);
    expect(candidates).toEqual([
      {
        oldPath: "old/location.md",
        newPath: "notes/current.md",
        annotationCount: 1,
        ambiguous: false,
      },
    ]);
  });
});
