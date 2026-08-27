import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDocumentAnnotations,
  createExcerpt,
  createReadingPlace,
  deleteAnnotationEntry,
  listDocumentAnnotations,
  restoreAnnotationEntry,
  restoreDocumentAnnotations,
  setReviewEnrollment,
  upsertReflection,
} from "./webAnnotationRepository";
import {
  listWebAnnotations,
  openWebUserDatabase,
  resetWebAnnotationStoreForTests,
  upsertWebAnnotation,
} from "./webAnnotations";
import { requestToPromise, transactionDone } from "./webAnnotationV6";

beforeEach(() => {
  resetWebAnnotationStoreForTests();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe("web v6 annotation repository", () => {
  it("creates an excerpt without dual-writing the legacy store, and skips review enrollment", async () => {
    const { excerpt, reflection } = await createExcerpt({
      id: "ex-1",
      relativePath: "notes/a.md",
      sourceText: "hello world",
      anchor: {
        format: "markdown",
        quote: { exact: "hello world", prefix: "say ", suffix: " today" },
        headingId: "intro",
        start: 1024,
        end: 1035,
      },
      appearance: { style: "highlight", tone: "sand" },
      sortIndex: "M|00000|00001024",
    }, null);
    expect(reflection).toBeNull();
    expect(excerpt.legacyColor).toBe("yellow");
    expect(excerpt.sourceRevision).toBeNull();

    const bundle = await listDocumentAnnotations("notes/a.md");
    expect(bundle.excerpts).toHaveLength(1);
    expect(bundle.reviewEnrollments).toEqual([]);

    const legacy = await listWebAnnotations("notes/a.md");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({
      id: "ex-1",
      kind: "highlight",
      color: "yellow",
      selectedText: "hello world",
    });

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("reade-annotations");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
    try {
      const raw = await new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction("annotations", "readonly");
        const req = tx.objectStore("annotations").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("read failed"));
      });
      expect(raw).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("preserves excerpt tone and rewrites the v6 anchor on legacy relocate upsert", async () => {
    await createExcerpt({
      id: "ex-relocate",
      relativePath: "notes/a.md",
      sourceText: "hello world",
      anchor: {
        format: "markdown",
        quote: { exact: "hello world", prefix: "say ", suffix: " today" },
        headingId: "intro",
        start: 1024,
        end: 1035,
      },
      appearance: { style: "highlight", tone: "sage" },
      sortIndex: "M|00000|00001024",
    }, null);
    const [legacy] = await listWebAnnotations("notes/a.md");
    await upsertWebAnnotation({
      ...legacy,
      color: "yellow",
      selectedText: "relocated quote",
      locator: {
        kind: "markdown",
        quote: "relocated quote",
        prefix: "fresh ",
        suffix: " context",
        headingId: "later",
        start: 4242,
        end: 4258,
      },
      sortIndex: "M|00000|00004242",
      updatedAt: 9_000,
    });
    const bundle = await listDocumentAnnotations("notes/a.md");
    expect(bundle.excerpts[0]?.appearance.tone).toBe("sage");
    expect(bundle.excerpts[0]?.legacyColor).toBe("green");
    expect(bundle.excerpts[0]?.createdAt).toBe(legacy.createdAt);
    expect(bundle.excerpts[0]?.anchor).toMatchObject({
      format: "markdown",
      headingId: "later",
      start: 4242,
      quote: { exact: "relocated quote" },
    });
  });

  it("writes a reading place, reflection, enrollment without legacy dual-write", async () => {
    await createExcerpt({
      id: "ex-2",
      relativePath: "notes/a.md",
      sourceText: "hello world",
      anchor: {
        format: "markdown",
        quote: { exact: "hello world", prefix: "", suffix: "" },
        headingId: null,
      },
      appearance: { style: "highlight", tone: "sand" },
      sortIndex: "M|00000|00001024",
    }, null);
    await createReadingPlace({
      id: "pl-2",
      relativePath: "notes/a.md",
      title: "here",
      target: { format: "markdown", headingId: null, scrollRatio: 0.25 },
      sortIndex: "M|00000|25000000",
    });
    const reflection = await upsertReflection("ex-2", "excerpt", "  我的感悟  ");
    expect(reflection.body).toBe("我的感悟");
    expect((await listWebAnnotations("notes/a.md")).find((item) => item.id === "ex-2")?.note).toBe(
      "我的感悟",
    );

    const enrolled = await setReviewEnrollment("ex-2", true);
    expect(enrolled?.suspended).toBe(false);
    expect((await listDocumentAnnotations("notes/a.md")).reviewEnrollments).toHaveLength(1);

    await deleteAnnotationEntry("ex-2", "excerpt");
    expect((await listDocumentAnnotations("notes/a.md")).excerpts).toHaveLength(0);
    expect((await listWebAnnotations("notes/a.md")).every((item) => item.id !== "ex-2")).toBe(true);

    await restoreAnnotationEntry("ex-2", "excerpt");
    expect((await listDocumentAnnotations("notes/a.md")).excerpts).toHaveLength(1);
  });

  it("creates excerpt and optional reflection atomically", async () => {
    const draft = {
      id: "ex-atomic",
      relativePath: "notes/atomic.md",
      sourceText: "atomic quote",
      anchor: {
        format: "markdown" as const,
        quote: { exact: "atomic quote", prefix: "", suffix: "" },
        headingId: null,
      },
      appearance: { style: "highlight" as const, tone: "sand" as const },
      sortIndex: "M|00000|00000042",
    };

    await expect(createExcerpt(draft, "   ")).rejects.toThrow("感悟");
    expect(await listDocumentAnnotations("notes/atomic.md")).toEqual({
      excerpts: [],
      places: [],
      reflections: [],
      reviewEnrollments: [],
    });

    const result = await createExcerpt(draft, "  同一事务  ");
    expect(result.reflection).toMatchObject({
      entryId: "ex-atomic",
      body: "同一事务",
      createdAt: result.excerpt.createdAt,
      updatedAt: result.excerpt.updatedAt,
    });
  });

  it("round-trips a complete clear snapshot without touching legacy shells", async () => {
    const capture = await createExcerpt(
      {
        id: "ex-roundtrip",
        relativePath: "notes/roundtrip.md",
        sourceText: "remember this",
        anchor: {
          format: "markdown",
          quote: { exact: "remember this", prefix: "", suffix: "" },
          headingId: "review",
        },
        appearance: { style: "underline", tone: "sage" },
        sortIndex: "M|00000|00000100",
      },
      "excerpt reflection",
    );
    await createReadingPlace({
      id: "place-roundtrip",
      relativePath: "notes/roundtrip.md",
      title: "resume here",
      target: { format: "markdown", headingId: "review", scrollRatio: 0.4 },
      sortIndex: "M|00000|40000000",
    });
    await upsertReflection("place-roundtrip", "place", "place reflection");
    const enrollment = await setReviewEnrollment(capture.excerpt.id, true);
    expect(enrollment).not.toBeNull();

    const db = await openWebUserDatabase();
    const enrollmentTx = db.transaction("reviewEnrollments", "readwrite");
    enrollmentTx.objectStore("reviewEnrollments").put({
      ...enrollment!,
      box: 4,
      dueAt: 123,
      lastReviewedAt: 99,
      totalReviews: 7,
      suspended: true,
      updatedAt: 456,
    });
    await transactionDone(enrollmentTx);

    const before = await listDocumentAnnotations("notes/roundtrip.md");
    const snapshot = await clearDocumentAnnotations("notes/roundtrip.md");
    expect(snapshot).toEqual(before);
    expect((await listDocumentAnnotations("notes/roundtrip.md")).excerpts).toEqual([]);

    const restored = await restoreDocumentAnnotations("notes/roundtrip.md", snapshot);
    expect(restored).toEqual(before);

    const legacyTx = db.transaction(["annotations", "annotationReviews"], "readonly");
    const [legacyAnnotations, legacyReviews] = await Promise.all([
      requestToPromise(legacyTx.objectStore("annotations").getAll()),
      requestToPromise(legacyTx.objectStore("annotationReviews").getAll()),
    ]);
    expect(legacyAnnotations).toEqual([]);
    expect(legacyReviews).toEqual([]);
  });

  it("rejects an invalid restore before writing any rows", async () => {
    const capture = await createExcerpt(
      {
        id: "ex-invalid-restore",
        relativePath: "notes/invalid.md",
        sourceText: "payload",
        anchor: {
          format: "markdown",
          quote: { exact: "payload", prefix: "", suffix: "" },
          headingId: null,
        },
        appearance: { style: "highlight", tone: "slate" },
        sortIndex: "M|00000|00000001",
      },
      null,
    );
    const snapshot = await clearDocumentAnnotations("notes/invalid.md");
    snapshot.reflections.push({
      entryId: capture.excerpt.id,
      entryKind: "place",
      body: "mismatched",
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    });

    await expect(restoreDocumentAnnotations("notes/invalid.md", snapshot)).rejects.toThrow(
      "错配感悟",
    );
    expect((await listDocumentAnnotations("notes/invalid.md")).excerpts).toEqual([]);
  });
});
