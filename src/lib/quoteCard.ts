/**
 * Quote card rendering and export channels (docs/plan-quote-cards.md §3.2,
 * §3.4). The pipeline is split into three independently testable stages:
 *
 * 1. theme resolution — `readCardTheme` consumes the 17-token contract via
 *    computed style (canvas cannot resolve `var()`), with the `:root`
 *    paper-light values as the defensive fallback;
 * 2. typesetting — delegated to the pure functions in `quoteCardLayout.ts`
 *    with a `ctx.measureText`-backed measurer;
 * 3. drawing — `drawQuoteCard` paints a computed layout onto any surface
 *    satisfying the structural `CardCanvasContext` (the real 2D context
 *    does; tests inject a recording double because jsdom has no canvas).
 *
 * Export follows QC-D1/QC-D2: clipboard PNG (`ClipboardItem`) is the primary
 * channel, blob `a[download]` the fallback. `downloadBlobFile` now lives in
 * `fileTransfer.ts` (shared with the text download) and is re-exported here
 * so the engine-layer contract stays intact.
 */

import {
  layoutQuoteCard,
  type CardColorRole,
  type CardFont,
  type CardLayout,
  type CardMeasure,
  type CardStyleId,
  type CardTextBlock,
  type QuoteCardInput,
} from "./quoteCardLayout";

/** Constant 2× export scale (decision QC-D6; same cap as the PDF renderer). */
export const CARD_EXPORT_SCALE = 2;

// ---------------------------------------------------------------------------
// Theme resolution (17-token contract, zero new tokens)
// ---------------------------------------------------------------------------

export interface ResolvedCardTheme {
  paper: string;
  paperRaised: string;
  ink: string;
  inkSoft: string;
  muted: string;
  accent: string;
  line: string;
}

/** `:root` paper-light defaults (src/styles/theme-tokens.css) as the fallback. */
export const CARD_THEME_FALLBACK: ResolvedCardTheme = {
  paper: "#fffefa",
  paperRaised: "#ffffff",
  ink: "#202729",
  inkSoft: "#596264",
  muted: "#8b9290",
  accent: "#af4c38",
  line: "rgba(55, 62, 61, 0.12)",
};

const THEME_TOKEN_NAMES: Record<keyof ResolvedCardTheme, string> = {
  paper: "--paper",
  paperRaised: "--paper-raised",
  ink: "--ink",
  inkSoft: "--ink-soft",
  muted: "--muted",
  accent: "--accent",
  line: "--line",
};

/**
 * Reads the card colors from the live theme via computed style, so the card
 * follows all four series × light/dark automatically. Empty/missing tokens
 * fall back to the `:root` defaults.
 */
export function readCardTheme(root: Element = document.documentElement): ResolvedCardTheme {
  const style = getComputedStyle(root);
  const theme = { ...CARD_THEME_FALLBACK };
  for (const key of Object.keys(THEME_TOKEN_NAMES) as Array<keyof ResolvedCardTheme>) {
    const value = style.getPropertyValue(THEME_TOKEN_NAMES[key]).trim();
    if (value) theme[key] = value;
  }
  return theme;
}

// ---------------------------------------------------------------------------
// Fonts (system stacks only — CSP forbids external webfonts)
// ---------------------------------------------------------------------------

/** Interface sans stack (App.css `:root`). */
const SANS_STACK =
  'Inter, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", "Noto Sans SC", "Microsoft YaHei UI", sans-serif';
/** Article-title serif stack (App.css `.article-title`). */
const SERIF_STACK =
  '"Iowan Old Style", "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif';

/** CSS `font` shorthand for a layout font spec. */
export function cardFontCss(font: CardFont): string {
  const family = font.family === "serif" ? SERIF_STACK : SANS_STACK;
  return `${font.weight ?? 400} ${font.sizePx}px ${family}`;
}

// ---------------------------------------------------------------------------
// Canvas structural types (jsdom has no real canvas; tests inject doubles,
// HTMLCanvasElement/CanvasRenderingContext2D satisfy these shapes as-is)
// ---------------------------------------------------------------------------

export interface CardCanvasContext {
  font: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
  scale(x: number, y: number): void;
  measureText(text: string): { width: number };
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

export interface CardCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): CardCanvasContext | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
}

function createDomCanvas(width: number, height: number): CardCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function themeColor(theme: ResolvedCardTheme, role: CardColorRole): string {
  switch (role) {
    case "ink":
      return theme.ink;
    case "inkSoft":
      return theme.inkSoft;
    case "muted":
      return theme.muted;
    case "accent":
      return theme.accent;
    case "line":
      return theme.line;
  }
}

function drawTextBlock(
  ctx: CardCanvasContext,
  block: CardTextBlock,
  theme: ResolvedCardTheme,
): void {
  ctx.font = cardFontCss(block.font);
  ctx.fillStyle = themeColor(theme, block.color);
  ctx.textAlign = block.align === "center" ? "center" : "left";
  // Vertically center each line inside its line box.
  const leading = Math.max(0, (block.lineHeightPx - block.font.sizePx) / 2);
  block.lines.forEach((line, index) => {
    ctx.fillText(line, block.x, block.y + index * block.lineHeightPx + leading);
  });
}

/**
 * Paints a computed layout in logical coordinates. The caller prepares the
 * surface (physical size and the 2× scale); this stage stays canvas-agnostic
 * so a recording context double can assert the paint order and colors.
 */
export function drawQuoteCard(
  ctx: CardCanvasContext,
  layout: CardLayout,
  theme: ResolvedCardTheme,
): void {
  ctx.textBaseline = "top";
  ctx.fillStyle = layout.background === "paper" ? theme.paper : theme.paperRaised;
  ctx.fillRect(0, 0, layout.width, layout.height);
  if (layout.decoration) drawTextBlock(ctx, layout.decoration, theme);
  drawTextBlock(ctx, layout.quote, theme);
  if (layout.divider) {
    ctx.strokeStyle = themeColor(theme, layout.divider.color);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(layout.divider.x1, layout.divider.y + 0.5);
    ctx.lineTo(layout.divider.x2, layout.divider.y + 0.5);
    ctx.stroke();
  }
  drawTextBlock(ctx, layout.attribution, theme);
  if (layout.brand) drawTextBlock(ctx, layout.brand, theme);
}

// ---------------------------------------------------------------------------
// Rendering pipeline
// ---------------------------------------------------------------------------

export interface RenderQuoteCardOptions {
  /** Canvas factory (tests inject a fake; defaults to `document.createElement`). */
  createCanvas?: (width: number, height: number) => CardCanvas;
  /** Replaces the `ctx.measureText` measurer (tests). */
  measure?: CardMeasure;
}

export interface RenderedQuoteCard {
  blob: Blob;
  /** The computed layout the blob was painted from (`truncated` drives the preview hint). */
  layout: CardLayout;
}

/**
 * Renders the card to a PNG blob at the constant 2× scale and also returns
 * the computed layout. The preview and the export share this one blob, so
 * there is no second rendering pass.
 */
export async function renderQuoteCardDetailed(
  input: QuoteCardInput,
  styleId: CardStyleId,
  theme: ResolvedCardTheme,
  options: RenderQuoteCardOptions = {},
): Promise<RenderedQuoteCard> {
  const createCanvas = options.createCanvas ?? createDomCanvas;
  let measure = options.measure;
  if (!measure) {
    const probeCtx = createCanvas(1, 1).getContext("2d");
    if (!probeCtx) throw new Error("无法创建 canvas 上下文");
    measure = (text, font) => {
      probeCtx.font = cardFontCss(font);
      return probeCtx.measureText(text).width;
    };
  }
  const layout = layoutQuoteCard(input, styleId, measure);
  const canvas = createCanvas(
    layout.width * CARD_EXPORT_SCALE,
    layout.height * CARD_EXPORT_SCALE,
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 canvas 上下文");
  ctx.scale(CARD_EXPORT_SCALE, CARD_EXPORT_SCALE);
  drawQuoteCard(ctx, layout, theme);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!blob) throw new Error("卡片导出失败（canvas.toBlob 未返回图像）");
  return { blob, layout };
}

/** Blob-only variant of {@link renderQuoteCardDetailed} (original contract). */
export async function renderQuoteCard(
  input: QuoteCardInput,
  styleId: CardStyleId,
  theme: ResolvedCardTheme,
  options: RenderQuoteCardOptions = {},
): Promise<Blob> {
  return (await renderQuoteCardDetailed(input, styleId, theme, options)).blob;
}

// ---------------------------------------------------------------------------
// Export channels (QC-D1 primary: clipboard PNG; QC-D2 fallback: download)
// ---------------------------------------------------------------------------

type ClipboardItemConstructorLike = new (
  items: Record<string, Blob>,
) => ClipboardItem;

export interface CopyImageDependencies {
  /** Clipboard override; `null` forces the "unavailable" path (tests). */
  clipboard?: Pick<Clipboard, "write"> | null;
  /** ClipboardItem constructor override; `null` forces "unsupported" (tests). */
  clipboardItem?: ClipboardItemConstructorLike | null;
}

function defaultClipboard(): Pick<Clipboard, "write"> | null {
  if (typeof navigator === "undefined") return null;
  const clipboard = navigator.clipboard as Clipboard | undefined;
  return clipboard && typeof clipboard.write === "function" ? clipboard : null;
}

function defaultClipboardItem(): ClipboardItemConstructorLike | null {
  return typeof ClipboardItem === "function" ? ClipboardItem : null;
}

/**
 * Primary export channel: writes the PNG to the clipboard through
 * `ClipboardItem`. Returns false — never throws — when the runtime lacks the
 * API, reports the type as unsupported, or rejects the write (permission,
 * clipboard managers, remote desktop); the caller then falls back to
 * `downloadBlobFile`.
 */
export async function copyImageToClipboard(
  blob: Blob,
  dependencies: CopyImageDependencies = {},
): Promise<boolean> {
  const clipboard =
    dependencies.clipboard !== undefined ? dependencies.clipboard : defaultClipboard();
  const ItemCtor =
    dependencies.clipboardItem !== undefined
      ? dependencies.clipboardItem
      : defaultClipboardItem();
  if (!clipboard || !ItemCtor) return false;
  const supports = (ItemCtor as { supports?: (type: string) => boolean }).supports;
  if (typeof supports === "function" && !supports.call(ItemCtor, "image/png")) return false;
  try {
    await clipboard.write([new ItemCtor({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fallback export channel: standard blob download via a transient
 * `a[download]`. The implementation moved into `fileTransfer.ts` (wiring
 * pass); the re-export keeps this module's contract stable.
 */
export { downloadBlobFile } from "./fileTransfer";

/** Default download name: `reade-quote-YYYYMMDD.png`. */
export function quoteCardFileName(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `reade-quote-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.png`;
}
