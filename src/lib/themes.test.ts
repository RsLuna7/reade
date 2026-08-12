import { describe, expect, it } from "vitest";
import {
  THEME_IDS,
  THEME_META,
  getThemeColor,
  getThemeSeriesLabel,
  isReaderTheme,
  normalizeReaderTheme,
  toggleThemeMode,
} from "./themes";

describe("theme registry", () => {
  it("exposes light and dark paper themes with matching meta theme-colors", () => {
    expect([...THEME_IDS]).toEqual(["light", "dark"]);
    expect(THEME_META.light.themeColor).toBe("#f5f1e8");
    expect(THEME_META.dark.themeColor).toBe("#1a1d1b");
    expect(getThemeColor("dark")).toBe("#1a1d1b");
    expect(getThemeSeriesLabel("light")).toBe("纸感");
  });

  it("normalizes unknown theme ids without inventing values", () => {
    expect(isReaderTheme("dark")).toBe(true);
    expect(isReaderTheme("paper-dark")).toBe(false);
    expect(normalizeReaderTheme("dark", "light")).toBe("dark");
    expect(normalizeReaderTheme("sepia", "light")).toBe("light");
  });

  it("toggles only the light/dark mode within the paper series", () => {
    expect(toggleThemeMode("light")).toBe("dark");
    expect(toggleThemeMode("dark")).toBe("light");
  });
});
