import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createExcerpt,
  createReadingPlace,
  deleteAnnotationEntry,
  listDocumentAnnotations,
  restoreAnnotationEntry,
  setReviewEnrollment,
  upsertReflection,
} from "./webAnnotationRepository";
import { listWebAnnotations, resetWebAnnotationStoreForTests, upsertWebAnnotation } from "./webAnnotations";

beforeEach(() => {
  resetWebAnnotationStoreForTests();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe("web v6 annotation repository", () => {
  it("creates an excerpt without dual-writing the legacy store, and skips review enrollment", async () => {
    const excerpt = await createExcerpt({
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
    });
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
    });
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
    });
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
});
