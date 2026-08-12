/**
 * Pre-paint theme boot. Loaded from index.html before main.tsx so a
 * dark-preference cold start does not flash the light paper defaults
 * (A5: without this, data-theme only lands with React's first effect,
 * a couple hundred ms after first paint). Desktop CSP is `script-src 'self'`,
 * so this must stay a same-origin external module — never an inline script.
 * React's theme effect remains the runtime source of truth after hydration.
 */
import {
  LEGACY_THEME_ID_MAP,
  THEME_META,
  isReaderTheme,
  type ReaderTheme,
} from "./lib/themes";

/** Mirrors READER_PREFERENCES_STORAGE_KEY in useReaderStore (contract-tested). */
export const BOOT_STORAGE_KEY = "reade-reader-preferences";

function storedTheme(): ReaderTheme | null {
  // Zustand persist JSON shape: { state: { theme, … }, version } (contract-tested).
  try {
    const raw = localStorage.getItem(BOOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const theme = (parsed as { state?: { theme?: unknown } } | null)?.state?.theme;
    const mapped =
      typeof theme === "string" && theme in LEGACY_THEME_ID_MAP
        ? LEGACY_THEME_ID_MAP[theme]
        : theme;
    return isReaderTheme(mapped) ? mapped : null;
  } catch {
    // Corrupt storage falls through to the system color scheme.
    return null;
  }
}

function systemTheme(): ReaderTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "paper-dark"
    : "paper-light";
}

export function bootTheme(): void {
  let theme: ReaderTheme = "paper-light";
  try {
    theme = storedTheme() ?? systemTheme();
  } catch {
    // Corrupt storage or missing matchMedia: keep the paper-light default.
  }
  try {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", THEME_META[theme].themeColor);
  } catch {
    // First paint falls back to the :root paper-light token defaults.
  }
}

bootTheme();
