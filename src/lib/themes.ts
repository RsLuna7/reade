/**
 * Theme registry for Reade UI chrome.
 * First series is "paper" (warm reading surfaces). Add future series here.
 */

export const THEME_IDS = ["light", "dark"] as const;

export type ReaderTheme = (typeof THEME_IDS)[number];

export type ThemeSeriesId = "paper";

export interface ThemeMeta {
  id: ReaderTheme;
  /** UI family; future themes can share a series with light/dark modes. */
  series: ThemeSeriesId;
  label: string;
  mode: "light" | "dark";
  /** Browser chrome / meta theme-color. Keep in sync with --theme-color in CSS. */
  themeColor: string;
}

export const THEME_SERIES: ReadonlyArray<{ id: ThemeSeriesId; label: string }> = [
  { id: "paper", label: "纸感" },
];

export const THEME_META: Record<ReaderTheme, ThemeMeta> = {
  light: {
    id: "light",
    series: "paper",
    label: "纸感浅色",
    mode: "light",
    themeColor: "#f5f1e8",
  },
  dark: {
    id: "dark",
    series: "paper",
    label: "纸感深色",
    mode: "dark",
    themeColor: "#1a1d1b",
  },
};

const THEME_ID_SET = new Set<string>(THEME_IDS);

export function isReaderTheme(value: unknown): value is ReaderTheme {
  return typeof value === "string" && THEME_ID_SET.has(value);
}

export function normalizeReaderTheme(
  value: unknown,
  fallback: ReaderTheme = "light",
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

/** Flip light ↔ dark within the current series (paper for now). */
export function toggleThemeMode(theme: ReaderTheme): ReaderTheme {
  return theme === "light" ? "dark" : "light";
}
