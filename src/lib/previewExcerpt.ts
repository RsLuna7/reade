/**
 * Preview-excerpt contract for the hover preview card
 * (docs/plan-hover-preview.md §3.1/HP-D7): turns a raw markdown (or
 * page/chapter) text into a bounded plain-text excerpt, optionally
 * starting after the heading a `#fragment` points at.
 *
 * The Rust twin `build_preview_excerpt` lives in
 * `src-tauri/src/library.rs`; the numbered cases PE01.. in
 * `previewExcerpt.test.ts` are mirrored by its tests — any change here
 * must update both ends together (the documentLinks L01.. discipline).
 *
 * Output stays plain text (HP-D1): markdown markers are stripped
 * line-by-line, never parsed into HTML; the card renders it through
 * React text nodes only.
 */

/** Hard excerpt cap in Unicode code points (HP-D9). */
export const PREVIEW_EXCERPT_MAX_CHARS = 600;

export interface PreviewExcerpt {
  excerpt: string;
  /** The fragment matched a heading line (best-effort, HP-D6). */
  matchedFragment: boolean;
}

/** Collapses inner whitespace runs and lowercases for direct comparison. */
function normalizeHeadingText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Slug approximation of the rehype-slug output (HP-D6): lowercase,
 * spaces to hyphens, everything that is not a letter, digit, hyphen or
 * underscore dropped. Consecutive hyphens are kept (github-slugger does
 * not collapse them either).
 */
export function previewSlug(value: string): string {
  let slug = "";
  for (const ch of value.trim().toLowerCase()) {
    if (ch === " " || ch === "\t") slug += "-";
    else if (ch === "-" || ch === "_" || /[\p{L}\p{N}]/u.test(ch)) slug += ch;
  }
  return slug;
}

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;

/** Heading text with trailing closing hashes (`## title ##`) removed. */
function headingText(rest: string): string {
  return rest.replace(/[ \t]+#+[ \t]*$/, "").trim();
}

/** One line of markdown reduced to plain text (block + inline markers). */
function cleanPreviewLine(line: string): string {
  let text = line.trim();
  // Setext underlines and thematic breaks carry no preview text.
  if (/^(?:=+|-+|\*{3,}|_{3,})$/.test(text)) return "";
  text = text.replace(/^(?:> ?)+/, "");
  const heading = ATX_HEADING.exec(text);
  if (heading) text = headingText(heading[2]);
  text = text.replace(/^(?:[-*+]|\d{1,3}[.)])[ \t]+/, "");
  text = text.replace(/^\[[ xX]\][ \t]+/, "");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
  text = text.replace(/\[\[([^\]]*)\]\]/g, "$1");
  text = text.replace(/\*\*|__/g, "");
  text = text.replace(/`/g, "");
  return text.trim();
}

/**
 * Finds the first ATX heading line matching the fragment: direct
 * case-insensitive text equality or slug equality (HP-D6). Returns the
 * line index or -1.
 */
function findFragmentHeading(lines: readonly string[], fragment: string): number {
  const target = normalizeHeadingText(fragment);
  const targetSlug = previewSlug(fragment);
  if (!target && !targetSlug) return -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = ATX_HEADING.exec(lines[index]);
    if (!match) continue;
    const text = headingText(match[2]);
    if (
      (target && normalizeHeadingText(text) === target) ||
      (targetSlug && previewSlug(text) === targetSlug)
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * Builds the bounded plain-text excerpt. Fence marker lines toggle a
 * skip-the-marker state (content inside fences is kept as plain text);
 * blank lines collapse to at most one; the result is capped at
 * {@link PREVIEW_EXCERPT_MAX_CHARS} code points with a `…` suffix.
 */
export function buildPreviewExcerpt(
  content: string,
  fragment: string | null = null,
): PreviewExcerpt {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  let matchedFragment = false;
  if (fragment && fragment.trim()) {
    const headingLine = findFragmentHeading(lines, fragment);
    if (headingLine >= 0) {
      start = headingLine + 1;
      matchedFragment = true;
    }
  }

  const collected: string[] = [];
  let charCount = 0;
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) continue;
    const clean = cleanPreviewLine(lines[index]);
    if (!clean) {
      if (collected.length === 0 || collected[collected.length - 1] === "") continue;
      collected.push("");
      charCount += 1;
      continue;
    }
    collected.push(clean);
    charCount += Array.from(clean).length + 1;
    if (charCount > PREVIEW_EXCERPT_MAX_CHARS) break;
  }
  while (collected[collected.length - 1] === "") collected.pop();

  const text = collected.join("\n");
  const chars = Array.from(text);
  const excerpt =
    chars.length > PREVIEW_EXCERPT_MAX_CHARS
      ? `${chars.slice(0, PREVIEW_EXCERPT_MAX_CHARS).join("")}…`
      : text;
  return { excerpt, matchedFragment };
}
