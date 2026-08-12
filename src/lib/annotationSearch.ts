import type { Annotation, AnnotationColor, AnnotationKind } from "./backend";

/**
 * Pure query normalisation and matching for annotation search
 * (`docs/plan-annotation-hub.md` §3.1). The web backend filters with these
 * functions directly; the desktop `search_annotations` command implements
 * the same contract in SQL (FTS5 trigram for ≥3-char queries, LIKE below
 * that, plus a title LIKE supplement). The numbered contract cases in
 * `annotationSearch.test.ts` are mirrored by the Rust tests in
 * `src-tauri/src/user_store.rs`; keep both sides in sync.
 */

/**
 * NFKC + lowercase + trim — the same pipeline as `normalize_search_query`
 * on the desktop, and the same NFKC folding `build_searchable_text` applies
 * when annotations are written.
 */
export function normalizeAnnotationQuery(raw: string): string {
  return raw.normalize("NFKC").toLowerCase().trim();
}

function fieldMatches(field: string | null | undefined, normalizedQuery: string): boolean {
  if (!field) return false;
  return field.normalize("NFKC").toLowerCase().includes(normalizedQuery);
}

/**
 * Substring match over selectedText / note / title with both sides
 * normalised; an empty (post-normalisation) query matches everything.
 * Desktop parity note: `searchable_text` (selectedText + note) is
 * NFKC-normalised at write time, so both ends agree there; desktop titles
 * are matched byte-wise by an ASCII-case-insensitive LIKE, so the NFKC
 * contract cases target selectedText/note only.
 */
export function annotationMatchesQuery(
  annotation: Pick<Annotation, "selectedText" | "note" | "title">,
  query: string,
): boolean {
  const normalized = normalizeAnnotationQuery(query);
  if (!normalized) return true;
  return (
    fieldMatches(annotation.selectedText, normalized) ||
    fieldMatches(annotation.note, normalized) ||
    fieldMatches(annotation.title, normalized)
  );
}

export interface AnnotationFilterOptions {
  /** Free-text query; blank means "no text filter". */
  query?: string;
  /** Kind chips; empty/absent means "all kinds". */
  kinds?: readonly AnnotationKind[];
  /** Colour chips; empty/absent means "all colours". Bookmarks have no colour and never pass a colour filter. */
  colors?: readonly AnnotationColor[];
}

/**
 * Client-side filter used by the hub UI (and as the web search backend's
 * core): query × kinds × colours intersect; tombstones never surface,
 * mirroring the desktop `deleted_at IS NULL` scope. Input order is kept —
 * grouping/sorting is `annotationHub.ts`'s job.
 */
export function filterAnnotations(
  items: readonly Annotation[],
  options: AnnotationFilterOptions = {},
): Annotation[] {
  const normalized = normalizeAnnotationQuery(options.query ?? "");
  const kinds = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
  const colors = options.colors && options.colors.length > 0 ? new Set(options.colors) : null;
  return items.filter((annotation) => {
    if (annotation.deletedAt != null) return false;
    if (kinds && !kinds.has(annotation.kind)) return false;
    if (colors && (annotation.color == null || !colors.has(annotation.color))) return false;
    if (normalized && !annotationMatchesQuery(annotation, normalized)) return false;
    return true;
  });
}
