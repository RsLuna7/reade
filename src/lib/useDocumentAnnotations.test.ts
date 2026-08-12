// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "./backend";

const backendMocks = vi.hoisted(() => ({
  listAnnotations: vi.fn<(relativePath?: string | null) => Promise<Annotation[]>>(),
  upsertAnnotation: vi.fn<(annotation: Annotation) => Promise<Annotation>>(),
  deleteAnnotation: vi.fn<(id: string) => Promise<void>>(),
  clearDocumentAnnotations: vi.fn<(relativePath: string) => Promise<void>>(),
}));

vi.mock("./backend", () => backendMocks);

import { useDocumentAnnotations } from "./useDocumentAnnotations";

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

beforeEach(() => {
  backendMocks.listAnnotations.mockReset().mockResolvedValue([]);
  backendMocks.upsertAnnotation.mockReset().mockImplementation(async (annotation) => annotation);
  backendMocks.deleteAnnotation.mockReset().mockResolvedValue(undefined);
  backendMocks.clearDocumentAnnotations.mockReset().mockResolvedValue(undefined);
});

describe("reload race protection", () => {
  it("ignores a slow stale response after switching documents", async () => {
    const slow = deferred<Annotation[]>();
    const fast = deferred<Annotation[]>();
    const staleDoc = makeAnnotation("stale", { relativePath: "docs/a.md" });
    const currentDoc = makeAnnotation("current", { relativePath: "docs/b.md" });
    backendMocks.listAnnotations
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(() => fast.promise);

    const { result, rerender } = renderAnnotations("docs/a.md");
    rerender({ path: "docs/b.md" });

    await act(async () => {
      fast.resolve([currentDoc]);
    });
    expect(result.current.annotations).toEqual([currentDoc]);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      slow.resolve([staleDoc]);
    });
    expect(result.current.annotations).toEqual([currentDoc]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("ignores errors from a stale reload", async () => {
    const slow = deferred<Annotation[]>();
    backendMocks.listAnnotations
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce([]);

    const { result, rerender } = renderAnnotations("docs/a.md");
    rerender({ path: "docs/b.md" });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      slow.reject(new Error("stale failure"));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("lets only the latest manual reload win", async () => {
    const first = deferred<Annotation[]>();
    const second = deferred<Annotation[]>();
    const stale = makeAnnotation("stale");
    const fresh = makeAnnotation("fresh");
    backendMocks.listAnnotations
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result } = renderAnnotations("docs/a.md");

    let manual!: Promise<void>;
    act(() => {
      manual = result.current.reload();
    });
    await act(async () => {
      second.resolve([fresh]);
      await manual;
    });
    expect(result.current.annotations).toEqual([fresh]);

    await act(async () => {
      first.resolve([stale]);
    });
    expect(result.current.annotations).toEqual([fresh]);
    expect(result.current.loading).toBe(false);
  });

  it("clears state and loading when the document is closed while loading", async () => {
    const slow = deferred<Annotation[]>();
    backendMocks.listAnnotations.mockImplementationOnce(() => slow.promise);

    const { result, rerender } = renderAnnotations("docs/a.md");
    expect(result.current.loading).toBe(true);

    rerender({ path: null });
    expect(result.current.loading).toBe(false);
    expect(backendMocks.listAnnotations).toHaveBeenCalledTimes(1);

    await act(async () => {
      slow.resolve([makeAnnotation("late")]);
    });
    expect(result.current.annotations).toEqual([]);
  });
});

describe("undo semantics", () => {
  it("records undo only for newly created annotations and undoes the creation", async () => {
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.loading).toBe(false));

    const annotation = makeAnnotation("a1");
    await act(async () => {
      await result.current.save(annotation);
      // Immediate follow-up update of the same id must not add an undo entry.
      await result.current.save({ ...annotation, note: "updated", updatedAt: 9 });
    });
    expect(result.current.annotations).toHaveLength(1);
    expect(result.current.annotations[0].note).toBe("updated");
    expect(result.current.canUndo).toBe(true);

    await act(async () => {
      await expect(result.current.undo()).resolves.toBe(true);
    });
    expect(backendMocks.deleteAnnotation).toHaveBeenCalledWith("a1");
    expect(result.current.annotations).toEqual([]);
    expect(result.current.canUndo).toBe(false);

    await act(async () => {
      await expect(result.current.undo()).resolves.toBe(false);
    });
  });

  it("skips undo recording when recordUndo is false", async () => {
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save(makeAnnotation("a1"), { recordUndo: false });
    });
    expect(result.current.annotations).toHaveLength(1);
    expect(result.current.canUndo).toBe(false);
  });

  it("restores a removed annotation on undo and ignores removing unknown ids", async () => {
    const annotation = makeAnnotation("a1");
    backendMocks.listAnnotations.mockResolvedValueOnce([annotation]);
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.annotations).toHaveLength(1));

    await act(async () => {
      await result.current.remove("ghost");
    });
    expect(result.current.canUndo).toBe(false);

    await act(async () => {
      await result.current.remove("a1");
    });
    expect(result.current.annotations).toEqual([]);
    expect(result.current.canUndo).toBe(true);

    await act(async () => {
      await expect(result.current.undo()).resolves.toBe(true);
    });
    expect(backendMocks.upsertAnnotation).toHaveBeenCalledWith(annotation);
    expect(result.current.annotations).toEqual([annotation]);
    expect(result.current.canUndo).toBe(false);
  });

  it("restores the full snapshot when undoing clearAll", async () => {
    const a = makeAnnotation("a", { updatedAt: 2 });
    const b = makeAnnotation("b", { updatedAt: 1 });
    backendMocks.listAnnotations.mockResolvedValueOnce([a, b]);
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.annotations).toHaveLength(2));

    await act(async () => {
      await result.current.clearAll();
    });
    expect(backendMocks.clearDocumentAnnotations).toHaveBeenCalledWith("docs/a.md");
    expect(result.current.annotations).toEqual([]);
    expect(result.current.canUndo).toBe(true);

    await act(async () => {
      await expect(result.current.undo()).resolves.toBe(true);
    });
    expect(result.current.annotations.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.current.canUndo).toBe(false);
  });

  it("caps the undo stack at 20 entries", async () => {
    const { result } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      for (let index = 0; index < 25; index += 1) {
        await result.current.save(makeAnnotation(`a${index}`));
      }
    });
    expect(result.current.annotations).toHaveLength(25);

    let undone = 0;
    await act(async () => {
      while (await result.current.undo()) undone += 1;
    });
    expect(undone).toBe(20);
  });
});

describe("callback stability", () => {
  it("keeps mutation callbacks referentially stable while the list changes", async () => {
    const { result, rerender } = renderAnnotations("docs/a.md");
    await waitFor(() => expect(result.current.loading).toBe(false));

    const initial = {
      save: result.current.save,
      remove: result.current.remove,
      clearAll: result.current.clearAll,
      undo: result.current.undo,
    };

    await act(async () => {
      await result.current.save(makeAnnotation("a1"));
    });
    rerender({ path: "docs/a.md" });
    expect(result.current.annotations).toHaveLength(1);

    expect(result.current.save).toBe(initial.save);
    expect(result.current.remove).toBe(initial.remove);
    expect(result.current.clearAll).toBe(initial.clearAll);
    expect(result.current.undo).toBe(initial.undo);
  });
});
