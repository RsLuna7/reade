import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearDocumentAnnotations,
  createExcerpt,
  deleteAnnotation,
  listDocumentAnnotations,
  restoreAnnotationEntry,
  restoreDocumentAnnotations,
  setReviewEnrollment,
  updateExcerptAppearance,
  upsertAnnotation,
  upsertReflection,
  type Annotation,
  type AnnotationColor,
} from "./backend";
import {
  excerptToLegacyAnnotation,
  legacyColorToTone,
  readingPlaceToLegacyAnnotation,
  type AnnotationEntryKind,
  type DocumentAnnotationBundle,
  type ExcerptDraft,
} from "./annotationModel";
import { isAnnotationMarkKind } from "./annotations";

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
  // Compatibility projection: live UI still consumes legacy Annotation marks,
  // but the bundle is the v6 source of truth owned by this hook.
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
  // D03: document epoch increments on every document switch. Every mutation
  // captures it before awaiting and drops ALL local state writes (bundle,
  // undo stack, loading, error) when the user switched away. Backend writes
  // that already succeeded are never rolled back — they belong to their own
  // document and show up again on the next open.
  const documentEpochRef = useRef(0);
  // D03: per-document serial mutation queue. Same-document writes apply in
  // order (a color update cannot clobber a just-landed note); switching
  // documents resets the chain so the new document never waits behind the
  // old one's in-flight work.
  const mutationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  // D03: bumped after every successful local commit. A reload that started
  // before a mutation must not commit its (possibly older) server snapshot
  // over the mutation's optimistic state — it reschedules instead.
  const dataVersionRef = useRef(0);
  const reloadRef = useRef<() => void>(() => {});

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
    const versionAtStart = dataVersionRef.current;
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
      if (dataVersionRef.current !== versionAtStart) {
        // A mutation committed while this reload was in flight; the server
        // snapshot may predate it. Refresh again rather than regressing the
        // local state, and leave loading to the rescheduled reload.
        reloadRef.current();
        return;
      }
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
    ++documentEpochRef.current;
    reloadRef.current = reload;
    // A new document starts with an empty queue, empty version and no undo
    // history; stale mutations from the previous document are dropped by
    // their epoch check instead of being replayed here.
    mutationQueueRef.current = Promise.resolve();
    dataVersionRef.current = 0;
    undoStackRef.current = [];
    syncUndoFlag();
    void reload();
    return () => {
      reloadTokenRef.current += 1;
    };
  }, [reload, syncUndoFlag]);

  const runMutation = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = mutationQueueRef.current.then(task, task);
    // The stored chain never rejects; each caller still sees its own result.
    mutationQueueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const save = useCallback(
    async (annotation: Annotation, options?: { recordUndo?: boolean }) => {
      const epoch = documentEpochRef.current;
      return runMutation(async () => {
        const existed = annotationsRef.current.some((item) => item.id === annotation.id);
        const saved = await upsertAnnotation(annotation);
        // Bookmarks and relocation still use the legacy command. Reload the v6
        // source of truth; reload records an error without turning a committed
        // mutation into a false save failure.
        if (documentEpochRef.current !== epoch) return saved;
        dataVersionRef.current += 1;
        await reload();
        if (documentEpochRef.current !== epoch) return saved;
        if (options?.recordUndo !== false && !existed) {
          pushUndo({
            type: "create",
            id: saved.id,
            entryKind: entryKindForAnnotation(saved),
          });
        }
        return saved;
      });
    },
    [pushUndo, reload, runMutation],
  );

  const saveExcerpt = useCallback(
    async (draft: ExcerptDraft, reflectionBody: string | null = null) => {
      const epoch = documentEpochRef.current;
      return runMutation(async () => {
        const captured = await createExcerpt(draft, reflectionBody);
        if (documentEpochRef.current !== epoch) return captured;
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
        dataVersionRef.current += 1;
        pushUndo({ type: "create", id: captured.excerpt.id, entryKind: "excerpt" });
        return captured;
      });
    },
    [commitBundle, pushUndo, runMutation],
  );

  const remove = useCallback(
    async (id: string, options?: { recordUndo?: boolean }) => {
      const epoch = documentEpochRef.current;
      return runMutation(async () => {
        const existing = annotationsRef.current.find((item) => item.id === id);
        if (!existing) return;
        const entryKind = entryKindForAnnotation(existing);
        await deleteAnnotation(id);
        if (documentEpochRef.current !== epoch) return;
        commitBundle({
          excerpts: bundleRef.current.excerpts.filter((item) => item.id !== id),
          places: bundleRef.current.places.filter((item) => item.id !== id),
          reflections: bundleRef.current.reflections.filter((item) => item.entryId !== id),
          reviewEnrollments: bundleRef.current.reviewEnrollments.filter(
            (item) => item.excerptId !== id,
          ),
        });
        dataVersionRef.current += 1;
        if (options?.recordUndo !== false) {
          pushUndo({ type: "delete", id, entryKind });
        }
      });
    },
    [commitBundle, pushUndo, runMutation],
  );

  const clearAll = useCallback(async () => {
    const path = relativePath;
    if (!path) return;
    const epoch = documentEpochRef.current;
    return runMutation(async () => {
      const snapshot = await clearDocumentAnnotations(path);
      if (documentEpochRef.current !== epoch) return;
      commitBundle(emptyBundle());
      dataVersionRef.current += 1;
      // Physical clear also purges tombstones, so earlier undo entries can no
      // longer be replayed safely. The returned full v6 snapshot is the sole
      // recoverable action for this document.
      undoStackRef.current = hasBundleEntries(snapshot)
        ? [{ type: "clear", relativePath: path, snapshot }]
        : [];
      syncUndoFlag();
    });
  }, [commitBundle, relativePath, runMutation, syncUndoFlag]);

  const undo = useCallback(async () => {
    const epoch = documentEpochRef.current;
    return runMutation(async () => {
      const entry = undoStackRef.current[undoStackRef.current.length - 1];
      if (!entry) return false;

      if (entry.type === "create") {
        await deleteAnnotation(entry.id);
        if (documentEpochRef.current !== epoch) return true;
        commitBundle({
          excerpts: bundleRef.current.excerpts.filter((item) => item.id !== entry.id),
          places: bundleRef.current.places.filter((item) => item.id !== entry.id),
          reflections: bundleRef.current.reflections.filter((item) => item.entryId !== entry.id),
          reviewEnrollments: bundleRef.current.reviewEnrollments.filter(
            (item) => item.excerptId !== entry.id,
          ),
        });
        dataVersionRef.current += 1;
      } else if (entry.type === "delete") {
        await restoreAnnotationEntry(entry.id, entry.entryKind);
        if (documentEpochRef.current !== epoch) return true;
        dataVersionRef.current += 1;
        await reload();
      } else {
        const restored = await restoreDocumentAnnotations(entry.relativePath, entry.snapshot);
        if (documentEpochRef.current !== epoch) return true;
        commitBundle(restored);
        dataVersionRef.current += 1;
      }

      // Only spend the undo entry after the backend action succeeds. A failed
      // restore remains retryable instead of losing the user's escape.
      if (
        documentEpochRef.current === epoch &&
        undoStackRef.current[undoStackRef.current.length - 1] === entry
      ) {
        undoStackRef.current.pop();
      }
      syncUndoFlag();
      return true;
    });
  }, [commitBundle, reload, runMutation, syncUndoFlag]);

  const updateNote = useCallback(
    async (annotation: Annotation, note: string | null) =>
      save({ ...annotation, note, updatedAt: Date.now() }, { recordUndo: false }),
    [save],
  );

  const updateColor = useCallback(
    async (annotation: Annotation, color: AnnotationColor) => {
      if (!isAnnotationMarkKind(annotation.kind)) {
        return save({ ...annotation, color, updatedAt: Date.now() }, { recordUndo: false });
      }
      // Capture the narrowed kind for use inside the queued closure (narrowing
      // does not survive the callback boundary).
      const markKind = annotation.kind;
      const epoch = documentEpochRef.current;
      return runMutation(async () => {
        const saved = await updateExcerptAppearance(annotation.id, {
          style: markKind,
          tone: legacyColorToTone(color),
        });
        if (documentEpochRef.current !== epoch) return saved;
        commitBundle({
          ...bundleRef.current,
          excerpts: [
            saved,
            ...bundleRef.current.excerpts.filter((item) => item.id !== saved.id),
          ],
        });
        dataVersionRef.current += 1;
        return saved;
      });
    },
    [commitBundle, runMutation, save],
  );

  const saveReflection = useCallback(
    async (entryId: string, entryKind: AnnotationEntryKind, body: string) => {
      const epoch = documentEpochRef.current;
      return runMutation(async () => {
        const saved = await upsertReflection(entryId, entryKind, body);
        if (documentEpochRef.current !== epoch) return saved;
        commitBundle({
          ...bundleRef.current,
          reflections: [
            saved,
            ...bundleRef.current.reflections.filter((item) => item.entryId !== saved.entryId),
          ],
        });
        dataVersionRef.current += 1;
        return saved;
      });
    },
    [commitBundle, runMutation],
  );

  const setEnrollment = useCallback(
    async (excerptId: string, enabled: boolean) => {
      const epoch = documentEpochRef.current;
      return runMutation(async () => {
        const saved = await setReviewEnrollment(excerptId, enabled);
        if (documentEpochRef.current !== epoch) return saved;
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
        dataVersionRef.current += 1;
        return saved;
      });
    },
    [commitBundle, runMutation],
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
