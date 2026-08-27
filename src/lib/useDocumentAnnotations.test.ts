// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "./backend";
import {
  migrateLegacyAnnotation,
  type AnnotationEntryKind,
  type DocumentAnnotationBundle,
  type Excerpt,
  type Reflection,
  type ReviewEnrollment,
} from "./annotationModel";

const backendMocks = vi.hoisted(() => ({
  listDocumentAnnotations: vi.fn(),
  upsertAnnotation: vi.fn(),
  createExcerpt: vi.fn(),
  deleteAnnotation: vi.fn(),
  clearDocumentAnnotations: vi.fn(),
  restoreAnnotationEntry: vi.fn(),
  restoreDocumentAnnotations: vi.fn(),
  upsertReflection: vi.fn(),
  setReviewEnrollment: vi.fn(),
}));

vi.mock("./backend", () => backendMocks);

import { useDocumentAnnotations } from "./useDocumentAnnotations";

function emptyBundle(): DocumentAnnotationBundle {
  return { excerpts: [], places: [], reflections: [], reviewEnrollments: [] };
}

function makeAnnotation(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    relativePath: "docs/a.md",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "quote",
    title: null,
    locator: { kind: "markdown", quote: "quote", prefix: "", suffix: "", headingId: null },
    sortIndex: "M|00000|00000000",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function bundleFromAnnotations(items: Annotation[]): DocumentAnnotationBundle {
  const bundle = emptyBundle();
  for (const annotation of items) {
    const migrated = migrateLegacyAnnotation(annotation);
    if (migrated.excerpt) bundle.excerpts.push(migrated.excerpt);
    if (migrated.place) bundle.places.push(migrated.place);
    if (migrated.reflection) bundle.reflections.push(migrated.reflection);
  }
  return bundle;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderAnnotations(initialPath: string | null) {
  return renderHook(({ path }: { path: string | null }) => useDocumentAnnotations(path), {
    initialProps: { path: initialPath },
  });
}

let serverBundle: DocumentAnnotationBundle;
const deletedEntries = new Map<
  string,
  {
    entryKind: AnnotationEntryKind;
    excerpt?: Excerpt;
    place?: DocumentAnnotationBundle["places"][number];
    reflection?: Reflection;
    enrollment?: ReviewEnrollment;
  }
>();

function putLegacyAnnotation(annotation: Annotation): void {
  const migrated = migrateLegacyAnnotation(annotation);
  serverBundle.excerpts = serverBundle.excerpts.filter((item) => item.id !== annotation.id);
  serverBundle.places = serverBundle.places.filter((item) => item.id !== annotation.id);
  serverBundle.reflections = serverBundle.reflections.filter(
    (item) => item.entryId !== annotation.id,
  );
  if (migrated.excerpt) serverBundle.excerpts.push(migrated.excerpt);
  if (migrated.place) serverBundle.places.push(migrated.place);
  if (migrated.reflection) serverBundle.reflections.push(migrated.reflection);
}

function removeServerEntry(id: string): void {
  const excerpt = serverBundle.excerpts.find((item) => item.id === id);
  const place = serverBundle.places.find((item) => item.id === id);
  if (!excerpt && !place) throw new Error("Annotation was not found");
  deletedEntries.set(id, {
    entryKind: excerpt ? "excerpt" : "place",
    ...(excerpt ? { excerpt } : {}),
    ...(place ? { place } : {}),
    reflection: serverBundle.reflections.find((item) => item.entryId === id),
    enrollment: serverBundle.reviewEnrollments.find((item) => item.excerptId === id),
  });
  serverBundle = {
    excerpts: serverBundle.excerpts.filter((item) => item.id !== id),
    places: serverBundle.places.filter((item) => item.id !== id),
    reflections: serverBundle.reflections.filter((item) => item.entryId !== id),
    reviewEnrollments: serverBundle.reviewEnrollments.filter((item) => item.excerptId !== id),
  };
}

beforeEach(() => {
  serverBundle = emptyBundle();
  deletedEntries.clear();
  backendMocks.listDocumentAnnotations.mockReset().mockImplementation(async () => serverBundle);
  backendMocks.upsertAnnotation.mockReset().mockImplementation(async (annotation: Annotation) => {
    putLegacyAnnotation(annotation);
    return annotation;
  });
  backendMocks.createExcerpt.mockReset().mockImplementation(async (draft, reflectionBody) => {
    const excerpt: Excerpt = {
      ...draft,
      sourceRevision: null,
      createdAt: 10,
      updatedAt: 10,
      deletedAt: null,
      legacyKind: draft.appearance.style,
      legacyColor: "yellow",
      legacyTitle: null,
      legacySelectedText: draft.sourceText,
    };
    const reflection: Reflection | null = reflectionBody
      ? {
          entryId: excerpt.id,
          entryKind: "excerpt",
          body: reflectionBody.trim(),
          createdAt: 10,
          updatedAt: 10,
          deletedAt: null,
        }
      : null;
    serverBundle.excerpts = [
      excerpt,
      ...serverBundle.excerpts.filter((item) => item.id !== excerpt.id),
    ];
    serverBundle.reflections = reflection
      ? [
          reflection,
          ...serverBundle.reflections.filter((item) => item.entryId !== excerpt.id),
        ]
      : serverBundle.reflections.filter((item) => item.entryId !== excerpt.id);
    return { excerpt, reflection };
  });
  backendMocks.deleteAnnotation.mockReset().mockImplementation(async (id: string) => {
    removeServerEntry(id);
  });
  backendMocks.clearDocumentAnnotations.mockReset().mockImplementation(async () => {
    const snapshot = serverBundle;
    serverBundle = emptyBundle();
    deletedEntries.clear();
    return snapshot;
  });
  backendMocks.restoreAnnotationEntry
    .mockReset()
    .mockImplementation(async (id: string, entryKind: AnnotationEntryKind) => {
      const deleted = deletedEntries.get(id);
      if (!deleted || deleted.entryKind !== entryKind) throw new Error("Annotation was not found");
      if (deleted.excerpt) serverBundle.excerpts.push(deleted.excerpt);
      if (deleted.place) serverBundle.places.push(deleted.place);
      if (deleted.reflection) serverBundle.reflections.push(deleted.reflection);
      if (deleted.enrollment) serverBundle.reviewEnrollments.push(deleted.enrollment);
      deletedEntries.delete(id);
    });
  backendMocks.restoreDocumentAnnotations
    .mockReset()
    .mockImplementation(async (_path: string, snapshot: DocumentAnnotationBundle) => {
      serverBundle = snapshot;
      return snapshot;
    });
  backendMocks.upsertReflection
    .mockReset()
    .mockImplementation(async (entryId: string, entryKind: AnnotationEntryKind, body: string) => {
      const reflection: Reflection = {
        entryId,
        entryKind,
        body: body.trim(),
        createdAt: 20,
        updatedAt: 20,
        deletedAt: null,
      };
      serverBundle.reflections = [
        reflection,
        ...serverBundle.reflections.filter((item) => item.entryId !== entryId),
      ];
      return reflection;
    });
  backendMocks.setReviewEnrollment
    .mockReset()
    .mockImplementation(async (excerptId: string, enabled: boolean) => {
      serverBundle.reviewEnrollments = serverBundle.reviewEnrollments.filter(
        (item) => item.excerptId !== excerptId,
      );
      if (!enabled) return null;
      const enrollment: ReviewEnrollment = {
        excerptId,
        enrolledAt: 30,
        box: 2,
        dueAt: 40,
        lastReviewedAt: 35,
        totalReviews: 3,
        suspended: false,
        updatedAt: 36,
        deletedAt: null,
      };
      serverBundle.reviewEnrollments.push(enrollment);
      return enrollment;
    });
});

describe("reload race protection", () => {
  it("ignores a slow stale response after switching documents", async () => {
    const slow = deferred<DocumentAnnotationBundle>();
    const fast = deferred<DocumentAnnotationBundle>();
    const stale = bundleFromAnnotations([makeAnnotation("stale", { relativePath: "docs/a.md" })]);
    const current = bundleFromAnnotations([
      makeAnnotation("current", { relativePath: "docs/b.md" }),
    ]);
    backendMocks.listDocumentAnnotations
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(() => fast.promise);

    const { result, rerender } = renderAnnotations("docs/a.md");
    rerender({ path: "docs/b.md" });
    await act(async () => fast.resolve(current));
    expect(result.current.annotations.map((item) => item.id)).toEqual(["current"]);

    await act(async () => slow.resolve(stale));
    expect(result.current.annotations.map((item) => item.id)).toEqual(["current"]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("ignores stale errors and lets only the latest manual reload win", async () => {
    const first = deferred<DocumentAnnotationBundle>();
    const second = deferred<DocumentAnnotationBundle>();
    backendMocks.listDocumentAnnotations
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result } = renderAnnotations("docs/a.md");

    let manual!: Promise<void>;
    act(() => {
      manual = result.current.reload();
    });
    await act(async () => {
      second.resolve(bundleFromAnnotations([makeAnnotation("fresh")]));
      await manual;
    });
    await act(async () => first.reject(new Error("stale failure")));
    expect(result.current.annotations.map((item) => item.id)).toEqual(["fresh"]);
    expect(result.current.error).toBeNull();
  });

  it("clears state when the document closes while loading", async () => {
    const slow = deferred<DocumentAnnotationBundle>();
    backendMocks.listDocumentAnnotations.mockImplementationOnce(() => slow.promise);
    const { result, rerender } = renderAnnotations("docs/a.md");
    expect(result.current.loading).toBe(true);
    rerender({ path: null });
    expect(result.current.loading).toBe(false);
    await act(async () => slow.resolve(bundleFromAnnotations([makeAnnotation("late")])));
    expect(result.current.annotations).toEqual([]);
  });
});

describe("atomic actions and undo semantics", () => {
  it("creates an excerpt and reflection through one backend action", async () => {
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.loading).toBe(false));
    const draft = {
      id: "ex-1",
      relativePath: "docs/a.md",
      sourceText: "quoted line",
      anchor: {
        format: "markdown" as const,
        quote: { exact: "quoted line", prefix: "", suffix: "" },
        headingId: null,
      },
      appearance: { style: "highlight" as const, tone: "sand" as const },
      sortIndex: "M|00000|00000000",
    };
    await act(async () => {
      await result.current.saveExcerpt(draft, "my reflection");
    });
    expect(backendMocks.createExcerpt).toHaveBeenCalledWith(draft, "my reflection");
    expect(result.current.bundle.excerpts).toHaveLength(1);
    expect(result.current.bundle.reflections[0]?.body).toBe("my reflection");
    expect(result.current.annotations[0]?.note).toBe("my reflection");
    expect(result.current.canUndo).toBe(true);
  });

  it("records undo only for new entries and undoes creation", async () => {
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.loading).toBe(false));
    const annotation = makeAnnotation("a1");
    await act(async () => {
      await result.current.save(annotation);
      await result.current.save({ ...annotation, note: "updated", updatedAt: 9 });
    });
    expect(result.current.canUndo).toBe(true);
    await act(async () => expect(result.current.undo()).resolves.toBe(true));
    expect(backendMocks.deleteAnnotation).toHaveBeenCalledWith("a1");
    expect(result.current.annotations).toEqual([]);
    await act(async () => expect(result.current.undo()).resolves.toBe(false));
  });

  it("restores a deleted entry through the v6 restore action", async () => {
    serverBundle = bundleFromAnnotations([makeAnnotation("a1", { note: "reflection" })]);
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.annotations).toHaveLength(1));
    await act(async () => result.current.remove("a1"));
    expect(result.current.annotations).toEqual([]);
    await act(async () => expect(result.current.undo()).resolves.toBe(true));
    expect(backendMocks.restoreAnnotationEntry).toHaveBeenCalledWith("a1", "excerpt");
    expect(result.current.annotations[0]?.note).toBe("reflection");
  });

  it("restores the full clear snapshot including reflection and enrollment", async () => {
    serverBundle = bundleFromAnnotations([makeAnnotation("a1", { note: "remember" })]);
    serverBundle.reviewEnrollments.push({
      excerptId: "a1",
      enrolledAt: 10,
      box: 4,
      dueAt: 20,
      lastReviewedAt: 15,
      totalReviews: 7,
      suspended: false,
      updatedAt: 16,
      deletedAt: null,
    });
    const expected = serverBundle;
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.annotations).toHaveLength(1));
    await act(async () => result.current.clearAll());
    expect(result.current.bundle).toEqual(emptyBundle());
    await act(async () => expect(result.current.undo()).resolves.toBe(true));
    expect(backendMocks.restoreDocumentAnnotations).toHaveBeenCalledWith(
      "docs/a.md",
      expected,
    );
    expect(result.current.bundle).toEqual(expected);
    expect(result.current.bundle.reviewEnrollments[0]?.box).toBe(4);
  });

  it("keeps a failed restore retryable", async () => {
    serverBundle = bundleFromAnnotations([makeAnnotation("a1")]);
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.annotations).toHaveLength(1));
    await act(async () => result.current.clearAll());
    backendMocks.restoreDocumentAnnotations.mockRejectedValueOnce(new Error("conflict"));
    await act(async () => expect(result.current.undo()).rejects.toThrow("conflict"));
    expect(result.current.canUndo).toBe(true);
    await act(async () => expect(result.current.undo()).resolves.toBe(true));
    expect(result.current.canUndo).toBe(false);
  });

  it("makes clear the sole undo boundary after physical purge", async () => {
    serverBundle = bundleFromAnnotations([makeAnnotation("a"), makeAnnotation("b")]);
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.annotations).toHaveLength(2));
    await act(async () => result.current.remove("a"));
    await act(async () => result.current.clearAll());
    await act(async () => expect(result.current.undo()).resolves.toBe(true));
    expect(result.current.annotations.map((item) => item.id)).toEqual(["b"]);
    await act(async () => expect(result.current.undo()).resolves.toBe(false));
  });

  it("updates reflection and enrollment in the same bundle state", async () => {
    serverBundle = bundleFromAnnotations([makeAnnotation("a1")]);
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.annotations).toHaveLength(1));
    await act(async () => {
      await result.current.saveReflection("a1", "excerpt", "new thought");
      await result.current.setEnrollment("a1", true);
    });
    expect(result.current.annotations[0]?.note).toBe("new thought");
    expect(result.current.bundle.reviewEnrollments[0]?.totalReviews).toBe(3);
  });

  it("caps the undo stack at 20 entries", async () => {
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      for (let index = 0; index < 25; index++) {
        await result.current.save(makeAnnotation(`a${index}`));
      }
    });
    let undone = 0;
    await act(async () => {
      while (await result.current.undo()) undone++;
    });
    expect(undone).toBe(20);
  });
});

describe("callback stability", () => {
  it("keeps action callbacks stable while bundle state changes", async () => {
    const { result, rerender } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.loading).toBe(false));
    const initial = {
      save: result.current.save,
      saveExcerpt: result.current.saveExcerpt,
      saveReflection: result.current.saveReflection,
      setEnrollment: result.current.setEnrollment,
      remove: result.current.remove,
      clearAll: result.current.clearAll,
      undo: result.current.undo,
    };
    await act(async () => result.current.save(makeAnnotation("a1")));
    rerender({ path: "docs/a.md" });
    expect(result.current.save).toBe(initial.save);
    expect(result.current.saveExcerpt).toBe(initial.saveExcerpt);
    expect(result.current.saveReflection).toBe(initial.saveReflection);
    expect(result.current.setEnrollment).toBe(initial.setEnrollment);
    expect(result.current.remove).toBe(initial.remove);
    expect(result.current.clearAll).toBe(initial.clearAll);
    expect(result.current.undo).toBe(initial.undo);
  });
});
