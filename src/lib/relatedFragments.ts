/**
 * Fragment extraction for the related-passages feature
 * (`docs/plan-related-passages.md` §3.2, RP-D1): the selection text is
 * split into runs of non-delimiter characters (immune to line-wrapping
 * differences between the selection and the indexed text), long runs are
 * sliced into fixed windows so CJK prose yields independently matchable
 * pieces, and the longest fragments win.
 *
 * This is the shared two-end contract: the Rust twin
 * (`extract_related_fragments` in `src-tauri/src/library.rs`) must
 * produce byte-identical output; the numbered cases F01.. in
 * `relatedFragments.test.ts` are mirrored by its tests. The desktop feeds
 * the fragments into an FTS5 `OR` phrase query, the web build counts
 * lowercase substring hits (RP-D5) — both are substring semantics, so the
 * contract locks the fragments, not the scoring.
 */

export const RELATED_MAX_FRAGMENTS = 6;
export const RELATED_MAX_TEXT_CHARS = 2_000;
/** SelectionToolbar enables the action from this many non-blank chars. */
export const RELATED_MIN_SELECTION_CHARS = 8;
export const RELATED_DEFAULT_LIMIT = 12;
export const RELATED_MAX_LIMIT = 50;

const RELATED_LONG_RUN_CHARS = 12;
const RELATED_FRAGMENT_SLICE_CHARS = 8;
const RELATED_MIN_FRAGMENT_CHARS = 3;
/**
 * Common CJK punctuation that splits runs, on top of ASCII punctuation
 * and whitespace. Must stay identical to `RELATED_CJK_DELIMITERS` in
 * `src-tauri/src/library.rs`.
 */
const RELATED_CJK_DELIMITERS = new Set(
  Array.from("，。；：！？、「」『』（）《》…—·\u{201c}\u{201d}\u{2018}\u{2019}"),
);

function isRelatedDelimiter(ch: string): boolean {
  if (/\s/u.test(ch)) return true;
  const code = ch.codePointAt(0) ?? 0;
  const isAsciiPunctuation =
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e);
  return isAsciiPunctuation || RELATED_CJK_DELIMITERS.has(ch);
}

/**
 * Selection text → significant fragments: input capped at 2,000 chars,
 * runs split on whitespace/punctuation, runs longer than 12 chars sliced
 * into non-overlapping 8-char windows, fragments below 3 chars dropped
 * (the trigram floor), case-insensitive dedupe keeping the first casing,
 * stable length-descending order (ties keep text order), top 6.
 */
export function extractRelatedFragments(text: string): string[] {
  const candidates: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > RELATED_LONG_RUN_CHARS) {
      for (let start = 0; start < run.length; start += RELATED_FRAGMENT_SLICE_CHARS) {
        const chunk = run.slice(start, start + RELATED_FRAGMENT_SLICE_CHARS);
        if (chunk.length >= RELATED_MIN_FRAGMENT_CHARS) candidates.push(chunk.join(""));
      }
    } else if (run.length >= RELATED_MIN_FRAGMENT_CHARS) {
      candidates.push(run.join(""));
    }
    run = [];
  };
  for (const ch of Array.from(text).slice(0, RELATED_MAX_TEXT_CHARS)) {
    if (isRelatedDelimiter(ch)) flush();
    else run.push(ch);
  }
  flush();

  const seen = new Set<string>();
  const fragments: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      fragments.push(candidate);
    }
  }
  // Longer fragments carry more trigram selectivity; Array.prototype.sort
  // is stable, so equal lengths keep original text order.
  fragments.sort((a, b) => Array.from(b).length - Array.from(a).length);
  return fragments.slice(0, RELATED_MAX_FRAGMENTS);
}
