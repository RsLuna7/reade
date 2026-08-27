import {
  excerptToLegacyAnnotation,
  readingPlaceToLegacyAnnotation,
  type DocumentAnnotationBundle,
} from "./annotationModel";
import type { Annotation } from "./backend";

/** Projects one v6 bundle entry for legacy mark rendering and navigation. */
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
