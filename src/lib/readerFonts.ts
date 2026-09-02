import {
  READER_FONT_PACK,
  type GeneratedReaderFont,
  type GeneratedReaderFontId,
  type GeneratedReaderFontPair,
  type GeneratedReaderFontPairId,
} from "./readerFonts.generated";

export type ReaderFontMode = "theme" | "pair" | "custom";
export type ReaderFontId = GeneratedReaderFontId;
export type ReaderFontPairId = GeneratedReaderFontPairId;

export const DEFAULT_READER_FONT_PAIR_ID: ReaderFontPairId = "balanced-modern-book";
export const DEFAULT_CJK_READER_FONT_ID: ReaderFontId = "source-han-serif-sc";
export const DEFAULT_LATIN_READER_FONT_ID: ReaderFontId = "source-serif-4";

export const READER_FONTS = READER_FONT_PACK.fonts;
export const READER_FONT_PAIRS = READER_FONT_PACK.pairings;
export const READER_CJK_FONTS = READER_FONTS.filter((font) => font.script === "cjk");
export const READER_LATIN_FONTS = READER_FONTS.filter((font) => font.script === "latin");

const FONT_BY_ID = new Map<ReaderFontId, GeneratedReaderFont>(
  READER_FONTS.map((font) => [font.id, font]),
);
const PAIR_BY_ID = new Map<ReaderFontPairId, GeneratedReaderFontPair>(
  READER_FONT_PAIRS.map((pair) => [pair.id, pair]),
);
const FONT_IDS = new Set<string>(READER_FONTS.map((font) => font.id));
const PAIR_IDS = new Set<string>(READER_FONT_PAIRS.map((pair) => pair.id));
const CJK_SANS_IDS = new Set<ReaderFontId>([
  "misans",
  "source-han-sans-cn",
  "sarasa-gothic-sc",
  "smiley-sans",
]);

export interface ReaderFontSelectionSettings {
  fontFamily: "system" | "sans" | "serif";
  fontMode: ReaderFontMode;
  fontPairId: ReaderFontPairId;
  cjkFontId: ReaderFontId;
  latinFontId: ReaderFontId;
}

export interface ResolvedReaderFontSelection {
  mode: ReaderFontMode;
  cssStack: string;
  label: string;
  fonts: readonly GeneratedReaderFont[];
  warnings: readonly string[];
}

export function isReaderFontId(value: unknown): value is ReaderFontId {
  return typeof value === "string" && FONT_IDS.has(value);
}

export function isReaderFontPairId(value: unknown): value is ReaderFontPairId {
  return typeof value === "string" && PAIR_IDS.has(value);
}

export function normalizeReaderFontMode(
  value: unknown,
  fallback: ReaderFontMode = "theme",
): ReaderFontMode {
  return value === "theme" || value === "pair" || value === "custom" ? value : fallback;
}

export function normalizeReaderFontId(
  value: unknown,
  fallback: ReaderFontId,
): ReaderFontId {
  return isReaderFontId(value) ? value : fallback;
}

export function normalizeReaderFontPairId(
  value: unknown,
  fallback: ReaderFontPairId = DEFAULT_READER_FONT_PAIR_ID,
): ReaderFontPairId {
  return isReaderFontPairId(value) ? value : fallback;
}

function themeFontStack(fontFamily: ReaderFontSelectionSettings["fontFamily"]): string {
  return fontFamily === "serif"
    ? '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif'
    : '"Segoe UI Variable Text", "Segoe UI", "Noto Sans SC", "Microsoft YaHei UI", sans-serif';
}

function fontWarnings(fonts: readonly GeneratedReaderFont[]): string[] {
  return fonts.flatMap((font) => {
    const messages: string[] = [];
    if (font.warning) messages.push(`${font.label}：${font.warning}`);
    if (font.licenseStatus === "claimed-by-local-index-unverified") {
      messages.push(`${font.label}：重新分发依据仅来自本地索引，尚未独立核实。`);
    }
    return messages;
  });
}

function customStack(latin: GeneratedReaderFont, cjk: GeneratedReaderFont): string {
  const generic = CJK_SANS_IDS.has(cjk.id) ? "sans-serif" : "serif";
  return `"${latin.cssFamily}", "${cjk.cssFamily}", ${generic}`;
}

export function resolveReaderFontSelection(
  settings: ReaderFontSelectionSettings,
): ResolvedReaderFontSelection {
  if (settings.fontMode === "theme") {
    const labels = {
      system: "系统均衡",
      sans: "清晰无衬线",
      serif: "书刊衬线",
    } as const;
    return {
      mode: "theme",
      cssStack: themeFontStack(settings.fontFamily),
      label: labels[settings.fontFamily],
      fonts: [],
      warnings: [],
    };
  }

  const pair =
    settings.fontMode === "pair"
      ? (PAIR_BY_ID.get(settings.fontPairId) ?? PAIR_BY_ID.get(DEFAULT_READER_FONT_PAIR_ID)!)
      : null;
  const cjkId = pair?.cjkFontId ?? settings.cjkFontId;
  const latinId = pair?.latinFontId ?? settings.latinFontId;
  const cjk = FONT_BY_ID.get(cjkId) ?? FONT_BY_ID.get(DEFAULT_CJK_READER_FONT_ID)!;
  const latin = FONT_BY_ID.get(latinId) ?? FONT_BY_ID.get(DEFAULT_LATIN_READER_FONT_ID)!;
  const fonts = [latin, cjk] as const;
  return {
    mode: settings.fontMode,
    cssStack: customStack(latin, cjk),
    label: pair?.label ?? `${cjk.label} × ${latin.label}`,
    fonts,
    warnings: fontWarnings(fonts),
  };
}

let fontStylesPromise: Promise<void> | null = null;

/**
 * Build-time boundary: `__READE_RUNTIME__` is defined by Vite, so in web
 * builds this resolves to the non-importing branch and the dynamic
 * `import("./readerFontDesktopAssets")` is tree-shaken away entirely.
 */
const registerReaderFontAssets =
  __READE_RUNTIME__ === "web"
    ? (): Promise<void> => Promise.resolve()
    : (): Promise<void> =>
        import("./readerFontDesktopAssets").then(() => undefined);

function ensureReaderFontStyles(): Promise<void> {
  fontStylesPromise ??= registerReaderFontAssets();
  return fontStylesPromise;
}

/**
 * Register the desktop-only @font-face catalog, then request only the selected
 * Chinese/Latin families and the regular/strong weights used by reflowable text.
 */
export async function loadResolvedReaderFonts(
  selection: ResolvedReaderFontSelection,
): Promise<void> {
  if (__READE_RUNTIME__ === "web" || selection.mode === "theme") return;
  await ensureReaderFontStyles();
  if (typeof document === "undefined" || !document.fonts?.load) return;
  const requests = selection.fonts.flatMap((font) => {
    const sample = font.script === "cjk" ? "汉字标题" : "Reader heading";
    const family = `"${font.cssFamily}"`;
    const weights = font.hasRealStrong ? [400, 700] : [400];
    return weights.map((weight) => document.fonts.load(`${weight} 1em ${family}`, sample));
  });
  await Promise.allSettled(requests);
}
