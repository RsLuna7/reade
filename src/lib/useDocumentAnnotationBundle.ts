import { useCallback, useEffect, useRef, useState } from "react";
import {
  listDocumentAnnotations,
  upsertReflection,
  type Annotation,
} from "./backend";
import {
  excerptToLegacyAnnotation,
  readingPlaceToLegacyAnnotation,
  type AnnotationEntryKind,
  type DocumentAnnotationBundle,
  type Reflection,
} from "./annotationModel";

const EMPTY_BUNDLE: DocumentAnnotationBundle = {
  excerpts: [],
  places: [],
  reflections: [],
  reviewEnrollments: [],
};

export function annotationFromBundleEntry(
  bundle: DocumentAnnotationBundle,
  entryId: string,
): Annotation | null {
  const reflection = bundle.reflections.find((item) => item.entryId === entryId) ?? null;
  const excerpt = bundle.excerpts.find((item) => item.id === entryId);
  if (excerpt) return excerptToLegacyAnnotation(excerpt, reflection);
  const place = bundle.places.find((item) => item.id === entryId);
  if (place) return readingPlaceToLegacyAnnotation(place, reflection);
  return null;
}

export function useDocumentAnnotationBundle(relativePath: string | null) {
  const [bundle, setBundle] = useState<DocumentAnnotationBundle>(EMPTY_BUNDLE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadTokenRef = useRef(0);

  const reload = useCallback(async () => {
    const token = ++reloadTokenRef.current;
    if (!relativePath) {
      setBundle(EMPTY_BUNDLE);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await listDocumentAnnotations(relativePath);
      if (token !== reloadTokenRef.current) return;
      setBundle(next);
      setError(null);
    } catch (cause) {
      if (token !== reloadTokenRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === reloadTokenRef.current) setLoading(false);
    }
  }, [relativePath]);

  useEffect(() => {
    void reload();
    return () => {
      reloadTokenRef.current += 1;
    };
  }, [reload]);

  const saveReflection = useCallback(
    async (entryId: string, entryKind: AnnotationEntryKind, body: string) => {
      const reflection = await upsertReflection(entryId, entryKind, body);
      setBundle((current) => ({
        ...current,
        reflections: [
          reflection,
          ...current.reflections.filter((item) => item.entryId !== reflection.entryId),
        ],
      }));
      return reflection;
    },
    [],
  );

  const reflectionsByEntryId = new Map<string, Reflection>(
    bundle.reflections.map((item) => [item.entryId, item]),
  );

  return {
    bundle,
    loading,
    error,
    reload,
    saveReflection,
    reflectionsByEntryId,
  };
}
