import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearDocumentAnnotations,
  createExcerpt,
  deleteAnnotation,
  listDocumentAnnotations,
  restoreAnnotationEntry,
  restoreDocumentAnnotations,
  setReviewEnrollment,
  upsertAnnotation,
  upsertReflection,
  type Annotation,
  type AnnotationColor,
} from "./backend";
import {
  excerptToLegacyAnnotation,
  readingPlaceToLegacyAnnotation,
  type AnnotationEntryKind,
  type DocumentAnnotationBundle,
  type ExcerptDraft,
} from "./annotationModel";

const MAX_UNDO = 20;

type UndoEntry =
  | { type: "create"; id: string; entryKind: AnnotationEntryKind }
  | { type: "delete"; id: string; entryKind: AnnotationEntryKind }
  | { type: "clear"; relativePath: string; snapshot: DocumentAnnotationBundle };

function emptyBundle(): DocumentAnnotationBundle {
  return { excerpts: [], places: [], reflections: [], reviewEnrollments: [] };
}

function hasBundleEntries(bundle: DocumentAnnotationBundle): boolean {
  return bundle.excerpts.length > 0 || bundle.places.length > 0;
}

function entryKindForAnnotation(annotation: Annotation): AnnotationEntryKind {
  return annotation.kind === "bookmark" ? "place" : "excerpt";
}

export function annotationsFromBundle(bundle: DocumentAnnotationBundle): Annotation[] {
  const reflections = new Map(bundle.reflections.map((item) => [item.entryId, item]));
  const annotations = [
    ...bundle.excerpts.map((excerpt) =>
      excerptToLegacyAnnotation(excerpt, reflections.get(excerpt.id) ?? null),
    ),
    ...bundle.places.map((place) =>
      readingPlaceToLegacyAnnotation(place, reflections.get(place.id) ?? null),
    ),
  ];
  return annotations.sort(
    (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
  );
}

export function useDocumentAnnotations(relativePath: string | null) {
  const [bundle, setBundle] = useState<DocumentAnnotationBundle>(emptyBundle);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const bundleRef = useRef<DocumentAnnotationBundle>(emptyBundle());
  const annotationsRef = useRef<Annotation[]>([]);
  const undoStackRef = useRef<UndoEntry[]>([]);
  // Only the latest reload may commit, so a slow response from a previous
  // document cannot overwrite the current bundle.
  const reloadTokenRef = useRef(0);

  const commitBundle = useCallback((next: DocumentAnnotationBundle) => {
    const projected = annotationsFromBundle(next);
    bundleRef.current = next;
    annotationsRef.current = projected;
    setBundle(next);
    setAnnotations(projected);
  }, []);

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
      commitBundle(emptyBundle());
      setError(null);
      setLoading(false);
      undoStackRef.current = [];
      syncUndoFlag();
      return;
    }
    setLoading(true);
    try {
      const next = await listDocumentAnnotations(relativePath);
      if (token !== reloadTokenRef.current) return;
      commitBundle(next);
      setError(null);
    } catch (cause) {
      if (token !== reloadTokenRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === reloadTokenRef.current) setLoading(false);
    }
  }, [commitBundle, relativePath, syncUndoFlag]);

  useEffect(() => {
    undoStackRef.current = [];
    syncUndoFlag();
    void reload();
    return () => {
      reloadTokenRef.current += 1;
    };
  }, [reload, syncUndoFlag]);

  const save = useCallback(
    async (annotation: Annotation, options?: { recordUndo?: boolean }) => {
      const existed = annotationsRef.current.some((item) => item.id === annotation.id);
      const saved = await upsertAnnotation(annotation);
      // Bookmarks and relocation still use the legacy command. Reload the v6
      // source of truth; reload records an error without turning a committed
      // mutation into a false save failure.
      await reload();
      if (options?.recordUndo !== false && !existed) {
        pushUndo({
          type: "create",
          id: saved.id,
          entryKind: entryKindForAnnotation(saved),
        });
      }
      return saved;
    },
    [pushUndo, reload],
  );

  const saveExcerpt = useCallback(
    async (draft: ExcerptDraft, reflectionBody: string | null = null) => {
      const captured = await createExcerpt(draft, reflectionBody);
      const next: DocumentAnnotationBundle = {
        ...bundleRef.current,
        excerpts: [
          captured.excerpt,
          ...bundleRef.current.excerpts.filter((item) => item.id !== captured.excerpt.id),
        ],
        reflections: captured.reflection
          ? [
              captured.reflection,
              ...bundleRef.current.reflections.filter(
                (item) => item.entryId !== captured.reflection?.entryId,
              ),
            ]
          : bundleRef.current.reflections.filter(
              (item) => item.entryId !== captured.excerpt.id,
            ),
      };
      commitBundle(next);
      pushUndo({ type: "create", id: captured.excerpt.id, entryKind: "excerpt" });
      return captured;
    },
    [commitBundle, pushUndo],
  );

  const remove = useCallback(
    async (id: string, options?: { recordUndo?: boolean }) => {
      const existing = annotationsRef.current.find((item) => item.id === id);
      if (!existing) return;
      const entryKind = entryKindForAnnotation(existing);
      await deleteAnnotation(id);
      commitBundle({
        excerpts: bundleRef.current.excerpts.filter((item) => item.id !== id),
        places: bundleRef.current.places.filter((item) => item.id !== id),
        reflections: bundleRef.current.reflections.filter((item) => item.entryId !== id),
        reviewEnrollments: bundleRef.current.reviewEnrollments.filter(
          (item) => item.excerptId !== id,
        ),
      });
      if (options?.recordUndo !== false) {
        pushUndo({ type: "delete", id, entryKind });
      }
    },
    [commitBundle, pushUndo],
  );

  const clearAll = useCallback(async () => {
    if (!relativePath) return;
    const snapshot = await clearDocumentAnnotations(relativePath);
    commitBundle(emptyBundle());
    // Physical clear also purges tombstones, so earlier undo entries can no
    // longer be replayed safely. The returned full v6 snapshot is the sole
    // recoverable action for this document.
    undoStackRef.current = hasBundleEntries(snapshot)
      ? [{ type: "clear", relativePath, snapshot }]
      : [];
    syncUndoFlag();
  }, [commitBundle, relativePath, syncUndoFlag]);

  const undo = useCallback(async () => {
    const entry = undoStackRef.current[undoStackRef.current.length - 1];
    if (!entry) return false;

    if (entry.type === "create") {
      await deleteAnnotation(entry.id);
      commitBundle({
        excerpts: bundleRef.current.excerpts.filter((item) => item.id !== entry.id),
        places: bundleRef.current.places.filter((item) => item.id !== entry.id),
        reflections: bundleRef.current.reflections.filter((item) => item.entryId !== entry.id),
        reviewEnrollments: bundleRef.current.reviewEnrollments.filter(
          (item) => item.excerptId !== entry.id,
        ),
      });
    } else if (entry.type === "delete") {
      await restoreAnnotationEntry(entry.id, entry.entryKind);
      await reload();
    } else {
      const restored = await restoreDocumentAnnotations(entry.relativePath, entry.snapshot);
      commitBundle(restored);
    }

    // Only spend the undo entry after the backend action succeeds. A failed
    // restore remains retryable instead of losing the user's escape.
    if (undoStackRef.current[undoStackRef.current.length - 1] === entry) {
      undoStackRef.current.pop();
    }
    syncUndoFlag();
    return true;
  }, [commitBundle, reload, syncUndoFlag]);

  const updateNote = useCallback(
    async (annotation: Annotation, note: string | null) =>
      save({ ...annotation, note, updatedAt: Date.now() }, { recordUndo: false }),
    [save],
  );

  const updateColor = useCallback(
    async (annotation: Annotation, color: AnnotationColor) =>
      save({ ...annotation, color, updatedAt: Date.now() }, { recordUndo: false }),
    [save],
  );

  const saveReflection = useCallback(
    async (entryId: string, entryKind: AnnotationEntryKind, body: string) => {
      const saved = await upsertReflection(entryId, entryKind, body);
      commitBundle({
        ...bundleRef.current,
        reflections: [
          saved,
          ...bundleRef.current.reflections.filter((item) => item.entryId !== saved.entryId),
        ],
      });
      return saved;
    },
    [commitBundle],
  );

  const setEnrollment = useCallback(
    async (excerptId: string, enabled: boolean) => {
      const saved = await setReviewEnrollment(excerptId, enabled);
      commitBundle({
        ...bundleRef.current,
        reviewEnrollments: saved
          ? [
              saved,
              ...bundleRef.current.reviewEnrollments.filter(
                (item) => item.excerptId !== excerptId,
              ),
            ]
          : bundleRef.current.reviewEnrollments.filter(
              (item) => item.excerptId !== excerptId,
            ),
      });
      return saved;
    },
    [commitBundle],
  );

  return {
    annotations,
    bundle,
    loading,
    error,
    canUndo,
    reload,
    save,
    saveExcerpt,
    saveReflection,
    setEnrollment,
    remove,
    clearAll,
    undo,
    updateNote,
    updateColor,
  };
}
