/**
 * Quote card typesetting (docs/plan-quote-cards.md §3.2–§3.3) — pure
 * functions, no DOM and no canvas. Text measurement is injected
 * (`CardMeasure`), so line breaking is unit-testable with a deterministic
 * measurer while the drawer (`quoteCard.ts`) plugs in `ctx.measureText`.
 *
 * Two curated styles (decision QC-D4), nothing user-configurable:
 * - "plain"(素笺): `--paper` ground, accent quote-mark decoration, left
 *   aligned sans text, bottom attribution row with divider and brand mark;
 * - "serif"(衬线中轴): `--paper-raised` ground, centered serif text with
 *   symmetric vertical whitespace, centered attribution.
 *
 * All coordinates are logical pixels on a 720-wide card; the drawer scales
 * everything by the constant 2× export factor (decision QC-D6).
 */

export type CardStyleId = "plain" | "serif";

export interface QuoteCardInput {
  quote: string;
  sourceTitle: string;
  /** Preformatted date label (see `formatCardDateLabel`) — generation day, not annotation day. */
  dateLabel: string;
}

export interface CardFont {
  sizePx: number;
  family: "sans" | "serif";
  /** CSS font-weight; 400 when omitted. */
  weight?: number;
}

/** Injected text measurer: the advance width of `text` in the given font. */
export type CardMeasure = (text: string, font: CardFont) => number;

/** Color slots resolved by the drawer against the 17-token theme contract. */
export type CardColorRole = "ink" | "inkSoft" | "muted" | "accent" | "line";

export interface CardTextBlock {
  lines: string[];
  /** Left edge for `align: "left"`, center line for `align: "center"`. */
  x: number;
  /** Top of the first line box (the drawer renders with `textBaseline: "top"`). */
  y: number;
  font: CardFont;
  lineHeightPx: number;
  align: "left" | "center";
  color: CardColorRole;
}

export interface CardDivider {
  x1: number;
  x2: number;
  y: number;
  color: CardColorRole;
}

export interface CardLayout {
  styleId: CardStyleId;
  width: number;
  height: number;
  background: "paper" | "paperRaised";
  truncated: boolean;
  /** Large decorative quote mark (style "plain" only). */
  decoration: CardTextBlock | null;
  quote: CardTextBlock;
  divider: CardDivider | null;
  attribution: CardTextBlock;
  /** "Reade" mark (style "plain" only). */
  brand: CardTextBlock | null;
}

export const CARD_WIDTH = 720;
export const CARD_MIN_HEIGHT = 480;
export const CARD_MAX_HEIGHT = 1080;
/** Quotes are clipped here before layout (the selection pipeline caps at 2000). */
export const MAX_QUOTE_CHARS = 240;
/** Layouts taller than this are cut to `TRUNCATED_QUOTE_LINES` + ellipsis. */
export const MAX_QUOTE_LINES = 12;
export const TRUNCATED_QUOTE_LINES = 11;
export const QUOTE_ELLIPSIS = "……";
/** measureText carries sub-pixel error for ligatures/cluster punctuation; keep a 4% reserve. */
export const LINE_WIDTH_SAFETY = 0.96;
const LINE_HEIGHT_FACTOR = 1.7;
/** Placeholder body for empty/whitespace-only input (fixed, asserted behaviour). */
export const EMPTY_QUOTE_PLACEHOLDER = "\u3000";

/** Font-size ladder by quote length (plan §3.2): ≤60 → 28, ≤160 → 22, else 18. */
export function quoteFontSizePx(quoteLength: number): number {
  if (quoteLength <= 60) return 28;
  if (quoteLength <= 160) return 22;
  return 18;
}

/** `YYYY年M月D日` (no zero padding) for the attribution row. */
export function formatCardDateLabel(date: Date = new Date()): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

// ---------------------------------------------------------------------------
// Tokenization (plan §3.3): Intl.Segmenter word granularity when available,
// regex fallback otherwise. Both paths end at the same unit inventory —
// whitespace runs / whole Latin words / single CJK or other characters —
// because CJK may break between any two characters regardless of the
// segmenter's word grouping.
// ---------------------------------------------------------------------------

interface WrapToken {
  text: string;
  kind: "space" | "word" | "char";
}

const CJK_CHAR = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
const LATIN_WORD = /^[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*$/;

// Module-local structural view of the ES2022 Segmenter (the repo's TS lib is
// ES2020); mirrors ttsSegments.ts and must not leak into the global type
// surface. Delete when the TS lib target moves to ES2022+.
interface WordSegmentPart {
  segment: string;
}

interface WordSegmenterLike {
  segment(input: string): Iterable<WordSegmentPart>;
}

type WordSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity?: "grapheme" | "word" | "sentence" },
) => WordSegmenterLike;

function wordSegmenter(): WordSegmenterLike | null {
  if (typeof Intl === "undefined") return null;
  const Ctor = (Intl as typeof Intl & { Segmenter?: WordSegmenterConstructor }).Segmenter;
  if (typeof Ctor !== "function") return null;
  try {
    return new Ctor(undefined, { granularity: "word" });
  } catch {
    return null;
  }
}

function pushCharTokens(tokens: WrapToken[], text: string): void {
  for (const character of text) {
    tokens.push({ text: character, kind: /\s/.test(character) ? "space" : "char" });
  }
}

function pushPart(tokens: WrapToken[], part: string): void {
  if (!part) return;
  if (/^\s+$/.test(part)) {
    tokens.push({ text: part, kind: "space" });
    return;
  }
  if (LATIN_WORD.test(part)) {
    tokens.push({ text: part, kind: "word" });
    return;
  }
  // CJK and mixed clusters break per character.
  pushCharTokens(tokens, part);
}

function tokenizeWithRegex(text: string): WrapToken[] {
  const tokens: WrapToken[] = [];
  const pattern = /(\s+)|([A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*)|(.)/gsu;
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined) tokens.push({ text: match[1], kind: "space" });
    else if (match[2] !== undefined) tokens.push({ text: match[2], kind: "word" });
    else pushCharTokens(tokens, match[3] ?? "");
  }
  return tokens;
}

function tokenizeForWrap(text: string): WrapToken[] {
  const segmenter = wordSegmenter();
  if (!segmenter) return tokenizeWithRegex(text);
  const tokens: WrapToken[] = [];
  for (const part of segmenter.segment(text)) {
    if (CJK_CHAR.test(part.segment)) pushCharTokens(tokens, part.segment);
    else pushPart(tokens, part.segment);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Line breaking
// ---------------------------------------------------------------------------

/** Line-start prohibitions (plan §3.3 list, applied as a single correction). */
const FORBIDDEN_LINE_START = new Set([..."。，、；：！？》」』)]%~…"]);
/** Line-end prohibitions. */
const FORBIDDEN_LINE_END = new Set([..."《「『(["]);

function applyKinsoku(lines: string[]): string[] {
  const result = [...lines];
  // Pull a forbidden leading character up to the previous line (may slightly
  // overflow; the 4% safety margin absorbs it).
  for (let index = 1; index < result.length; index += 1) {
    const first = [...result[index]][0];
    if (first !== undefined && FORBIDDEN_LINE_START.has(first)) {
      result[index - 1] += first;
      result[index] = result[index].slice(first.length);
    }
  }
  // Push a forbidden trailing character down to the next line.
  for (let index = 0; index < result.length - 1; index += 1) {
    const characters = [...result[index]];
    const last = characters[characters.length - 1];
    if (last !== undefined && FORBIDDEN_LINE_END.has(last)) {
      result[index] = result[index].slice(0, result[index].length - last.length);
      result[index + 1] = last + result[index + 1];
    }
  }
  return result.filter((line) => line.length > 0);
}

/**
 * Greedy line breaking for mixed CJK/Latin text: Latin words wrap whole
 * (an over-wide lone word is hard-split by character), CJK breaks anywhere,
 * whitespace collapses at line boundaries, then one kinsoku correction pass.
 */
export function layoutQuoteLines(
  text: string,
  maxWidth: number,
  measure: CardMeasure,
  font: CardFont,
): string[] {
  const lines: string[] = [];
  let current = "";
  let pendingSpace = false;
  const width = (value: string) => measure(value, font);
  const flush = () => {
    if (current) lines.push(current);
    current = "";
    pendingSpace = false;
  };
  const hardSplit = (word: string) => {
    for (const character of word) {
      const candidate = current ? current + character : character;
      if (current && width(candidate) > maxWidth) {
        flush();
        current = character;
      } else {
        current = candidate;
      }
    }
  };
  for (const token of tokenizeForWrap(text)) {
    if (token.kind === "space") {
      if (current) pendingSpace = true;
      continue;
    }
    const joiner = pendingSpace ? " " : "";
    if (!current) {
      if (token.text.length > 1 && width(token.text) > maxWidth) hardSplit(token.text);
      else current = token.text;
      pendingSpace = false;
      continue;
    }
    const candidate = current + joiner + token.text;
    if (width(candidate) <= maxWidth) {
      current = candidate;
      pendingSpace = false;
      continue;
    }
    flush();
    if (token.text.length > 1 && width(token.text) > maxWidth) hardSplit(token.text);
    else current = token.text;
  }
  flush();
  return applyKinsoku(lines);
}

function fitEllipsis(
  line: string,
  maxWidth: number,
  measure: CardMeasure,
  font: CardFont,
): string {
  let kept = line;
  while (kept.length > 0 && measure(kept.trimEnd() + QUOTE_ELLIPSIS, font) > maxWidth) {
    kept = [...kept].slice(0, -1).join("");
  }
  return kept.trimEnd() + QUOTE_ELLIPSIS;
}

function clampHeight(value: number): number {
  return Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, Math.round(value)));
}

function attributionText(
  input: QuoteCardInput,
  font: CardFont,
  maxWidth: number,
  measure: CardMeasure,
): string {
  const title = input.sourceTitle.replace(/\s+/g, " ").trim();
  const date = input.dateLabel.trim();
  if (!title) return date;
  const full = `${title} · ${date}`;
  if (measure(full, font) <= maxWidth) return full;
  let characters = [...title];
  while (
    characters.length > 1 &&
    measure(`${characters.join("")}… · ${date}`, font) > maxWidth
  ) {
    characters = characters.slice(0, -1);
  }
  return `${characters.join("")}… · ${date}`;
}

// Style geometry (logical px on the 720-wide card).
const PLAIN_PADDING_X = 64;
const PLAIN_DECORATION_Y = 60;
const PLAIN_DECORATION_SIZE = 64;
const PLAIN_QUOTE_Y = 152;
const PLAIN_BOTTOM_PADDING = 56;
const PLAIN_META_LINE_HEIGHT = 22;
const PLAIN_DIVIDER_GAP = 18;
const PLAIN_QUOTE_BOTTOM_GAP = 28;
const SERIF_PADDING_X = 84;
const SERIF_MIN_VERTICAL_PAD = 96;
const SERIF_ATTRIBUTION_GAP = 44;
const META_FONT_SIZE = 15;
export const CARD_BRAND_TEXT = "Reade";

/**
 * Computes the full card layout: wraps the quote (clipping at
 * `MAX_QUOTE_CHARS` / `MAX_QUOTE_LINES` with an ellipsis marker), sizes the
 * card between `CARD_MIN_HEIGHT` and `CARD_MAX_HEIGHT`, and positions every
 * drawable block for the chosen style.
 */
export function layoutQuoteCard(
  input: QuoteCardInput,
  styleId: CardStyleId,
  measure: CardMeasure,
): CardLayout {
  const paddingX = styleId === "serif" ? SERIF_PADDING_X : PLAIN_PADDING_X;
  const contentWidth = CARD_WIDTH - paddingX * 2;
  const wrapWidth = contentWidth * LINE_WIDTH_SAFETY;

  const normalized = input.quote.replace(/\s+/g, " ").trim();
  let truncated = false;
  let quoteText = normalized;
  if ([...quoteText].length > MAX_QUOTE_CHARS) {
    quoteText = [...quoteText].slice(0, MAX_QUOTE_CHARS).join("");
    truncated = true;
  }

  const quoteFont: CardFont = {
    sizePx: quoteFontSizePx([...normalized].length || 1),
    family: styleId === "serif" ? "serif" : "sans",
  };
  const lineHeightPx = Math.round(quoteFont.sizePx * LINE_HEIGHT_FACTOR);

  let lines = normalized
    ? layoutQuoteLines(quoteText, wrapWidth, measure, quoteFont)
    : [EMPTY_QUOTE_PLACEHOLDER];
  if (lines.length > MAX_QUOTE_LINES) {
    lines = lines.slice(0, TRUNCATED_QUOTE_LINES);
    truncated = true;
  }
  if (truncated && lines.length > 0) {
    lines[lines.length - 1] = fitEllipsis(lines[lines.length - 1], wrapWidth, measure, quoteFont);
  }
  const quoteHeight = lines.length * lineHeightPx;

  const metaFont: CardFont = {
    sizePx: META_FONT_SIZE,
    family: styleId === "serif" ? "serif" : "sans",
  };
  const attribution = attributionText(input, metaFont, contentWidth, measure);

  if (styleId === "serif") {
    const innerHeight = quoteHeight + SERIF_ATTRIBUTION_GAP + PLAIN_META_LINE_HEIGHT;
    const height = clampHeight(innerHeight + SERIF_MIN_VERTICAL_PAD * 2);
    const quoteY = Math.round((height - innerHeight) / 2);
    return {
      styleId,
      width: CARD_WIDTH,
      height,
      background: "paperRaised",
      truncated,
      decoration: null,
      quote: {
        lines,
        x: CARD_WIDTH / 2,
        y: quoteY,
        font: quoteFont,
        lineHeightPx,
        align: "center",
        color: "ink",
      },
      divider: null,
      attribution: {
        lines: [attribution],
        x: CARD_WIDTH / 2,
        y: quoteY + quoteHeight + SERIF_ATTRIBUTION_GAP,
        font: metaFont,
        lineHeightPx: PLAIN_META_LINE_HEIGHT,
        align: "center",
        color: "muted",
      },
      brand: null,
    };
  }

  const contentHeight =
    PLAIN_QUOTE_Y +
    quoteHeight +
    PLAIN_QUOTE_BOTTOM_GAP +
    PLAIN_DIVIDER_GAP +
    PLAIN_META_LINE_HEIGHT +
    PLAIN_BOTTOM_PADDING;
  const height = clampHeight(contentHeight);
  const attributionY = height - PLAIN_BOTTOM_PADDING - PLAIN_META_LINE_HEIGHT;
  const brandFont: CardFont = { sizePx: 16, family: "serif", weight: 600 };
  return {
    styleId,
    width: CARD_WIDTH,
    height,
    background: "paper",
    truncated,
    decoration: {
      lines: ["\u201c"],
      x: PLAIN_PADDING_X,
      y: PLAIN_DECORATION_Y,
      font: { sizePx: PLAIN_DECORATION_SIZE, family: "serif", weight: 700 },
      lineHeightPx: PLAIN_DECORATION_SIZE,
      align: "left",
      color: "accent",
    },
    quote: {
      lines,
      x: PLAIN_PADDING_X,
      y: PLAIN_QUOTE_Y,
      font: quoteFont,
      lineHeightPx,
      align: "left",
      color: "ink",
    },
    divider: {
      x1: PLAIN_PADDING_X,
      x2: CARD_WIDTH - PLAIN_PADDING_X,
      y: attributionY - PLAIN_DIVIDER_GAP,
      color: "line",
    },
    attribution: {
      lines: [attribution],
      x: PLAIN_PADDING_X,
      y: attributionY,
      font: metaFont,
      lineHeightPx: PLAIN_META_LINE_HEIGHT,
      align: "left",
      color: "muted",
    },
    brand: {
      lines: [CARD_BRAND_TEXT],
      x: CARD_WIDTH - PLAIN_PADDING_X - Math.ceil(measure(CARD_BRAND_TEXT, brandFont)),
      y: attributionY,
      font: brandFont,
      lineHeightPx: PLAIN_META_LINE_HEIGHT,
      align: "left",
      color: "accent",
    },
  };
}
