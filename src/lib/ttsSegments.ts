/**
 * Sentence segmentation for local read-aloud (docs/plan-read-aloud.md §3.3,
 * decision RA-D2).
 *
 * Input is flattened text (the `buildTextIndex(root).text` of a reading
 * root), output is a list of sentence segments whose `start`/`end` are
 * offsets into that flattened text, ready for `rangeFromTextIndex`.
 *
 * Two segmentation paths share one post-processing step so their output
 * structure stays interchangeable:
 * - `Intl.Segmenter` with sentence granularity (feature-detected at runtime;
 *   always available in the WebView2 the desktop build targets);
 * - a terminator-scanner fallback for engines without `Segmenter`
 *   (e.g. Firefox < 125 on the web build).
 *
 * Invariants (unit-tested for both paths):
 * - segments are sorted by `start` and never overlap;
 * - `text.slice(segment.start, segment.end) === segment.text`;
 * - no segment is blank, and the gaps between segments contain only
 *   whitespace (no non-whitespace character is ever dropped);
 * - no segment is longer than `MAX_SENTENCE_CHARS` (long sentences are
 *   re-split at newlines, then clause separators, then hard-chunked, which
 *   also sidesteps Chromium's long-utterance truncation bug).
 */

export interface SentenceSegment {
  /** Flattened-text offset of the first character (inclusive). */
  start: number;
  /** Flattened-text offset one past the last character (exclusive). */
  end: number;
  /** Always equals `text.slice(start, end)` of the segmented input. */
  text: string;
}

/**
 * ~12–15 seconds of speech; sentences longer than this are re-split so the
 * follow highlight stays fine-grained and no single utterance approaches the
 * Chromium 15-second truncation window.
 */
export const MAX_SENTENCE_CHARS = 240;

/** Unconditional sentence terminators (an ASCII `.` only counts before whitespace/EOL). */
const TERMINATORS = new Set(["。", "！", "？", "!", "?", "；", ";", "…"]);

/**
 * Closing quotes/brackets that belong to the sentence they terminate
 * (plan list `" ' 」 』 ） ) 】 ]` plus the curly forms of those quotes).
 */
const TRAILING_CLOSERS = new Set(['"', "'", "\u201d", "\u2019", "」", "』", "）", ")", "】", "]"]);

/** Secondary split points for over-long sentences. */
const CLAUSE_SEPARATORS = new Set(["，", "、", ",", "：", ":"]);

interface SegmentRange {
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Intl.Segmenter access without widening the global type surface.
//
// The repository's `tsconfig` lib is ES2020 while the Segmenter types live in
// lib.es2022.intl.d.ts, so the constructor is reached through a module-local
// structural type instead of a `declare global` block (nothing leaks into the
// global type surface). Delete this once the TS lib target moves to ES2022+.
// ---------------------------------------------------------------------------

interface SegmenterSentencePart {
  segment: string;
  index: number;
}

interface SegmenterLike {
  segment(input: string): Iterable<SegmenterSentencePart>;
}

type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity?: "grapheme" | "word" | "sentence" },
) => SegmenterLike;

type IntlWithSegmenter = typeof Intl & { Segmenter?: SegmenterConstructor };

function segmenterConstructor(): SegmenterConstructor | null {
  if (typeof Intl === "undefined") return null;
  const candidate = (Intl as IntlWithSegmenter).Segmenter;
  return typeof candidate === "function" ? candidate : null;
}

/** Runtime feature detection for `Intl.Segmenter` sentence granularity. */
export function sentenceSegmenterAvailable(): boolean {
  return segmenterConstructor() !== null;
}

// ---------------------------------------------------------------------------
// Shared post-processing
// ---------------------------------------------------------------------------

function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}

/** `.` ends a sentence only when followed by whitespace or the end of input. */
function isSentencePeriod(text: string, index: number): boolean {
  if (text[index] !== ".") return false;
  const next = text[index + 1];
  return next === undefined || isWhitespace(next);
}

function isTerminator(text: string, index: number): boolean {
  return TERMINATORS.has(text[index]) || isSentencePeriod(text, index);
}

/**
 * Greedily packs `range` into chunks of at most `MAX_SENTENCE_CHARS`,
 * cutting right after the furthest separator that still fits; a chunk with
 * no separator in reach is hard-cut at the limit.
 */
function packAtSeparators(
  text: string,
  range: SegmentRange,
  isSeparator: (character: string) => boolean,
): SegmentRange[] {
  const pieces: SegmentRange[] = [];
  let start = range.start;
  while (range.end - start > MAX_SENTENCE_CHARS) {
    let cut = -1;
    const windowEnd = start + MAX_SENTENCE_CHARS;
    for (let index = start; index < windowEnd; index += 1) {
      if (isSeparator(text[index])) cut = index + 1;
    }
    if (cut <= start) cut = windowEnd;
    pieces.push({ start, end: cut });
    start = cut;
  }
  pieces.push({ start, end: range.end });
  return pieces;
}

/** Splits a range at every newline (the newline stays with the preceding piece). */
function splitAtNewlines(text: string, range: SegmentRange): SegmentRange[] {
  const pieces: SegmentRange[] = [];
  let start = range.start;
  for (let index = range.start; index < range.end; index += 1) {
    if (text[index] !== "\n") continue;
    pieces.push({ start, end: index + 1 });
    start = index + 1;
  }
  if (start < range.end) pieces.push({ start, end: range.end });
  return pieces;
}

/**
 * Re-splits an over-long sentence: first at newlines, then oversized lines
 * are greedily packed at clause separators, with hard chunks of
 * `MAX_SENTENCE_CHARS` as the last resort.
 */
function splitLongRange(text: string, range: SegmentRange): SegmentRange[] {
  if (range.end - range.start <= MAX_SENTENCE_CHARS) return [range];
  const result: SegmentRange[] = [];
  for (const line of splitAtNewlines(text, range)) {
    if (line.end - line.start <= MAX_SENTENCE_CHARS) {
      result.push(line);
      continue;
    }
    // packAtSeparators hard-chunks stretches without separators.
    result.push(...packAtSeparators(text, line, (ch) => CLAUSE_SEPARATORS.has(ch)));
  }
  return result;
}

/** Shrinks a range to exclude leading/trailing whitespace; null when blank. */
function trimRange(text: string, range: SegmentRange): SegmentRange | null {
  let { start, end } = range;
  while (start < end && isWhitespace(text[start])) start += 1;
  while (end > start && isWhitespace(text[end - 1])) end -= 1;
  return end > start ? { start, end } : null;
}

function finalizeSegments(text: string, ranges: SegmentRange[]): SentenceSegment[] {
  const segments: SentenceSegment[] = [];
  for (const range of ranges) {
    for (const piece of splitLongRange(text, range)) {
      const trimmed = trimRange(text, piece);
      if (!trimmed) continue;
      segments.push({
        start: trimmed.start,
        end: trimmed.end,
        text: text.slice(trimmed.start, trimmed.end),
      });
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Segmentation paths
// ---------------------------------------------------------------------------

/**
 * Segments through `Intl.Segmenter` (sentence granularity), or returns null
 * when the runtime lacks it. Exported so tests can drive this path directly.
 */
export function segmentSentencesWithSegmenter(
  text: string,
  locale?: string,
): SentenceSegment[] | null {
  const Ctor = segmenterConstructor();
  if (!Ctor) return null;
  let segmenter: SegmenterLike;
  try {
    segmenter = new Ctor(locale, { granularity: "sentence" });
  } catch {
    return null;
  }
  const ranges: SegmentRange[] = [];
  for (const part of segmenter.segment(text)) {
    ranges.push({ start: part.index, end: part.index + part.segment.length });
  }
  return finalizeSegments(text, ranges);
}

/**
 * Terminator-scanner fallback: a sentence closes at `。！？!?；;…`, or at an
 * ASCII `.` followed by whitespace/EOL; consecutive terminators (`……`, `?!`)
 * and closing quotes/brackets right after them stay with the sentence.
 * Exported so tests can compare both paths on the same corpus.
 */
export function segmentSentencesWithRegex(text: string): SentenceSegment[] {
  const ranges: SegmentRange[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    if (!isTerminator(text, index)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < text.length && isTerminator(text, end)) end += 1;
    while (end < text.length && TRAILING_CLOSERS.has(text[end])) end += 1;
    ranges.push({ start, end });
    start = end;
    index = end;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return finalizeSegments(text, ranges);
}

/**
 * Main entry: `Intl.Segmenter` when available, terminator scanner otherwise.
 * `locale` is a hint (e.g. the document language); both paths tolerate mixed
 * CJK/Latin content.
 */
export function segmentSentences(text: string, locale?: string): SentenceSegment[] {
  return segmentSentencesWithSegmenter(text, locale) ?? segmentSentencesWithRegex(text);
}
