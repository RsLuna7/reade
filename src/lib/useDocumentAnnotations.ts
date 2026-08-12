import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearDocumentAnnotations,
  deleteAnnotation,
  listAnnotations,
  upsertAnnotation,
  type Annotation,
  type AnnotationColor,
} from "./backend";

const MAX_UNDO = 20;

type UndoEntry =
  | { type: "create"; id: string }
  | { type: "delete"; annotation: Annotation }
  | { type: "clear"; annotations: Annotation[] };

function sortedAnnotations(list: Annotation[]): Annotation[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function useDocumentAnnotations(relativePath: string | null) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const undoStackRef = useRef<UndoEntry[]>([]);
  // Mirrors the annotations state so the mutation callbacks can stay
  // referentially stable while still reading the latest list synchronously.
  const annotationsRef = useRef<Annotation[]>([]);
  // Monotonic token: only the most recent reload may commit its result, so a
  // slow response for a previously selected document can never overwrite the
  // list of the current one.
  const reloadTokenRef = useRef(0);

  const commitAnnotations = useCallback((next: Annotation[]) => {
    annotationsRef.current = next;
    setAnnotations(next);
  }, []);

  const updateAnnotations = useCallback(
    (updater: (current: Annotation[]) => Annotation[]) => {
      annotationsRef.current = updater(annotationsRef.current);
      setAnnotations(annotationsRef.current);
    },
    [],
  );

  const syncUndoFlag = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0);
  }, []);

  const pushUndo = useCallback(
    (entry: UndoEntry) => {
      undoStackRef.current = [...undoStackRef.current, entry].slice(-MAX_UNDO);
      syncUndoFlag();
    },
    [syncUndoFlag],
  );

  const reload = useCallback(async () => {
    const token = ++reloadTokenRef.current;
    if (!relativePath) {
      commitAnnotations([]);
      setError(null);
      // A load for a previous document may still be in flight; its finally
      // block is now stale, so clear the loading flag here.
      setLoading(false);
      undoStackRef.current = [];
      syncUndoFlag();
      return;
    }
    setLoading(true);
    try {
      const next = await listAnnotations(relativePath);
      if (token !== reloadTokenRef.current) return;
      commitAnnotations(next);
      setError(null);
    } catch (cause) {
      if (token !== reloadTokenRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === reloadTokenRef.current) setLoading(false);
    }
  }, [commitAnnotations, relativePath, syncUndoFlag]);

  useEffect(() => {
    undoStackRef.current = [];
    syncUndoFlag();
    void reload();
    return () => {
      // Invalidate any in-flight load when the document changes or the hook
      // unmounts.
      reloadTokenRef.current += 1;
    };
  }, [reload, syncUndoFlag]);

  const save = useCallback(
    async (annotation: Annotation, options?: { recordUndo?: boolean }) => {
      const existed = annotationsRef.current.some((item) => item.id === annotation.id);
      const saved = await upsertAnnotation(annotation);
      updateAnnotations((current) =>
        sortedAnnotations([saved, ...current.filter((item) => item.id !== saved.id)]),
      );
      if (options?.recordUndo !== false && !existed) {
        pushUndo({ type: "create", id: saved.id });
      }
      return saved;
    },
    [pushUndo, updateAnnotations],
  );

  const remove = useCallback(
    async (id: string, options?: { recordUndo?: boolean }) => {
      const existing = annotationsRef.current.find((item) => item.id === id);
      await deleteAnnotation(id);
      updateAnnotations((current) => current.filter((item) => item.id !== id));
      if (options?.recordUndo !== false && existing) {
        pushUndo({ type: "delete", annotation: existing });
      }
    },
    [pushUndo, updateAnnotations],
  );

  const clearAll = useCallback(async () => {
    if (!relativePath) return;
    const snapshot = [...annotationsRef.current];
    await clearDocumentAnnotations(relativePath);
    commitAnnotations([]);
    if (snapshot.length > 0) {
      pushUndo({ type: "clear", annotations: snapshot });
    }
  }, [commitAnnotations, pushUndo, relativePath]);

  const undo = useCallback(async () => {
    const entry = undoStackRef.current.pop();
    syncUndoFlag();
    if (!entry) return false;
    if (entry.type === "create") {
      await deleteAnnotation(entry.id);
      updateAnnotations((current) => current.filter((item) => item.id !== entry.id));
      return true;
    }
    if (entry.type === "delete") {
      const restored = await upsertAnnotation(entry.annotation);
      updateAnnotations((current) =>
        sortedAnnotations([restored, ...current.filter((item) => item.id !== restored.id)]),
      );
      return true;
    }
    for (const annotation of entry.annotations) {
      await upsertAnnotation(annotation);
    }
    updateAnnotations((current) => {
      const byId = new Map(current.map((item) => [item.id, item]));
      for (const annotation of entry.annotations) byId.set(annotation.id, annotation);
      return sortedAnnotations(Array.from(byId.values()));
    });
    return true;
  }, [syncUndoFlag, updateAnnotations]);

  const updateNote = useCallback(
    async (annotation: Annotation, note: string | null) => {
      return save(
        {
          ...annotation,
          note,
          updatedAt: Date.now(),
        },
        { recordUndo: false },
      );
    },
    [save],
  );

  const updateColor = useCallback(
    async (annotation: Annotation, color: AnnotationColor) => {
      return save(
        {
          ...annotation,
          color,
          updatedAt: Date.now(),
        },
        { recordUndo: false },
      );
    },
    [save],
  );

  return {
    annotations,
    loading,
    error,
    canUndo,
    reload,
    save,
    remove,
    clearAll,
    undo,
    updateNote,
    updateColor,
  };
}
