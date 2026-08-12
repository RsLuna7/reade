/**
 * Theme registry for Reade UI chrome.
 * Themes form a "series × mode" matrix. Ids use the two-part
 * `${series}-${mode}` format (paper-light, paper-dark, …); legacy single-word
 * ids ("light"/"dark") map into the paper series via LEGACY_THEME_ID_MAP.
 * Add future series to THEME_SERIES/THEME_META and keep the matching
 * `:root[data-theme="…"]` block in src/styles/theme-tokens.css in sync.
 */

export type ThemeMode = "light" | "dark";

export const THEME_SERIES = [
  { id: "paper", label: "纸感" },
  { id: "ink", label: "墨韵" },
  { id: "mist", label: "清透" },
] as const;

export type ThemeSeriesId = (typeof THEME_SERIES)[number]["id"];

export type ReaderTheme = `${ThemeSeriesId}-${ThemeMode}`;

export const THEME_IDS: readonly ReaderTheme[] = THEME_SERIES.flatMap(
  (series) => [`${series.id}-light`, `${series.id}-dark`] as const,
);

export interface ThemeMeta {
  id: ReaderTheme;
  /** UI family; every series ships a light and a dark mode. */
  series: ThemeSeriesId;
  label: string;
  mode: ThemeMode;
  /** Browser chrome / meta theme-color. Keep in sync with --theme-color in CSS. */
  themeColor: string;
  /**
   * Series-picker tile colors. Must equal the --paper/--chrome/--accent values
   * of the matching CSS block (registry ↔ CSS consistency is test-enforced).
   */
  swatch: { paper: string; chrome: string; accent: string };
}

export const THEME_META: Record<ReaderTheme, ThemeMeta> = {
  "paper-light": {
    id: "paper-light",
    series: "paper",
    label: "纸感浅色",
    mode: "light",
    themeColor: "#f5f1e8",
    swatch: { paper: "#fffefa", chrome: "#f3efe6", accent: "#af4c38" },
  },
  "paper-dark": {
    id: "paper-dark",
    series: "paper",
    label: "纸感深色",
    mode: "dark",
    themeColor: "#1a1d1b",
    swatch: { paper: "#1a1d1b", chrome: "#141716", accent: "#e0856c" },
  },
  "ink-light": {
    id: "ink-light",
    series: "ink",
    label: "墨韵浅色",
    mode: "light",
    themeColor: "#f2f0e5",
    swatch: { paper: "#fffcf0", chrome: "#f2f0e5", accent: "#205ea6" },
  },
  "ink-dark": {
    id: "ink-dark",
    series: "ink",
    label: "墨韵深色",
    mode: "dark",
    themeColor: "#1c1b1a",
    swatch: { paper: "#1c1b1a", chrome: "#161514", accent: "#4385be" },
  },
  "mist-light": {
    id: "mist-light",
    series: "mist",
    label: "清透浅色",
    mode: "light",
    themeColor: "#f0f1f3",
    swatch: { paper: "#fcfcfd", chrome: "#f1f2f4", accent: "#3b6fd4" },
  },
  "mist-dark": {
    id: "mist-dark",
    series: "mist",
    label: "清透深色",
    mode: "dark",
    themeColor: "#16181b",
    swatch: { paper: "#16181b", chrome: "#101214", accent: "#6ea2f5" },
  },
};

/**
 * One-time id migration (store v3 → v4) and boot-script whitelist:
 * data persisted before the series × mode matrix used single-word ids.
 */
export const LEGACY_THEME_ID_MAP: Record<string, ReaderTheme> = {
  light: "paper-light",
  dark: "paper-dark",
};

/**
 * D4: each series carries a typography preset. Switching series applies it via
 * setThemeSeries; toggling light/dark never does. Values are a subset of
 * ReaderFontFamily (declared in the store, which depends on this module).
 */
export const SERIES_FONT_PRESET: Record<ThemeSeriesId, "system" | "serif"> = {
  paper: "system",
  ink: "serif",
  mist: "system",
};

const THEME_ID_SET = new Set<string>(THEME_IDS);

export function isReaderTheme(value: unknown): value is ReaderTheme {
  return typeof value === "string" && THEME_ID_SET.has(value);
}

export function normalizeReaderTheme(
  value: unknown,
  fallback: ReaderTheme = "paper-light",
): ReaderTheme {
  return isReaderTheme(value) ? value : fallback;
}

export function getThemeColor(theme: ReaderTheme): string {
  return THEME_META[theme].themeColor;
}

export function getThemeSeriesLabel(theme: ReaderTheme): string {
  const series = THEME_META[theme].series;
  return THEME_SERIES.find((entry) => entry.id === series)?.label ?? series;
}

/** Flip light ↔ dark within the current series (registry lookup). */
export function toggleThemeMode(theme: ReaderTheme): ReaderTheme {
  const meta = THEME_META[theme];
  const nextMode: ThemeMode = meta.mode === "light" ? "dark" : "light";
  const candidate: string = `${meta.series}-${nextMode}`;
  return isReaderTheme(candidate) ? candidate : theme;
}

/** Switch series while keeping the current light/dark mode. */
export function setSeries(theme: ReaderTheme, series: ThemeSeriesId): ReaderTheme {
  const candidate: string = `${series}-${THEME_META[theme].mode}`;
  return isReaderTheme(candidate) ? candidate : theme;
}
