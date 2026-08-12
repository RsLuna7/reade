/**
 * Document move detection (fingerprint rebind chain step ②,
 * `docs/research-annotation-data-models.md` §5.5).
 *
 * A "move" is an annotated path that vanished from the current scan while
 * its content fingerprint reappears at another scanned path. The pure
 * function below mirrors `detect_moved_rows` in
 * `src-tauri/src/user_store.rs`; the desktop build runs the Rust version
 * against the user database, the web build feeds this one from IndexedDB
 * plus the static manifest.
 */

/**
 * One `oldPath → newPath` rebind proposal. When the same content hash allows
 * several pairings (multiple new candidates for one missing path, or several
 * missing paths collapsing onto one candidate), every pairing is returned
 * with `ambiguous: true` and callers must not apply any of them
 * automatically.
 */
export interface MovedDocumentCandidate {
  oldPath: string;
  newPath: string;
  /** Live (non-tombstoned) annotations still attached to `oldPath`. */
  annotationCount: number;
  ambiguous: boolean;
}

export interface DetectMovedDocumentsInput {
  /** Relative paths found by the current scan (or manifest). */
  presentPaths: Iterable<string>;
  /** Fingerprints of the present documents, keyed by relative path. */
  currentHashes: ReadonlyMap<string, string>;
  /**
   * Last known fingerprints from previous scans, keyed by relative path.
   * Entries for vanished paths are the rebind clue and must be retained by
   * the caller's store.
   */
  storedHashes: ReadonlyMap<string, string>;
  /** Live annotation counts per relative path (tombstones excluded). */
  liveAnnotationCounts: ReadonlyMap<string, number>;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function detectMovedDocumentCandidates(
  input: DetectMovedDocumentsInput,
): MovedDocumentCandidate[] {
  const present = new Set(input.presentPaths);

  const candidatesByHash = new Map<string, string[]>();
  for (const [path, hash] of input.currentHashes) {
    if (!present.has(path)) continue;
    const bucket = candidatesByHash.get(hash);
    if (bucket) bucket.push(path);
    else candidatesByHash.set(hash, [path]);
  }

  // Annotated paths that vanished from the scan, grouped by their last known
  // fingerprint. A missing path without a stored fingerprint has no rebind
  // clue and is left to the (future §5.6) manual flow.
  const missingByHash = new Map<string, Array<{ path: string; count: number }>>();
  for (const [path, count] of input.liveAnnotationCounts) {
    if (count <= 0 || present.has(path)) continue;
    const hash = input.storedHashes.get(path);
    if (!hash) continue;
    const bucket = missingByHash.get(hash);
    if (bucket) bucket.push({ path, count });
    else missingByHash.set(hash, [{ path, count }]);
  }

  const results: MovedDocumentCandidate[] = [];
  for (const [hash, oldEntries] of missingByHash) {
    const candidates = [...(candidatesByHash.get(hash) ?? [])].sort(comparePaths);
    if (candidates.length === 0) continue;
    oldEntries.sort((a, b) => comparePaths(a.path, b.path));
    const ambiguous = oldEntries.length > 1 || candidates.length > 1;
    for (const oldEntry of oldEntries) {
      for (const newPath of candidates) {
        results.push({
          oldPath: oldEntry.path,
          newPath,
          annotationCount: oldEntry.count,
          ambiguous,
        });
      }
    }
  }
  results.sort(
    (a, b) => comparePaths(a.oldPath, b.oldPath) || comparePaths(a.newPath, b.newPath),
  );
  return results;
}
