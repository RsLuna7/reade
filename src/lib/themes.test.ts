import { describe, expect, it } from "vitest";
import {
  LEGACY_THEME_ID_MAP,
  SERIES_FONT_PRESET,
  THEME_IDS,
  THEME_META,
  THEME_SERIES,
  getThemeColor,
  getThemeSeriesLabel,
  isReaderTheme,
  normalizeReaderTheme,
  setSeries,
  toggleThemeMode,
} from "./themes";

describe("theme registry", () => {
  it("registers every series as a light/dark pair with two-part ids", () => {
    expect(THEME_IDS.length).toBe(THEME_SERIES.length * 2);
    for (const series of THEME_SERIES) {
      expect(THEME_IDS).toContain(`${series.id}-light`);
      expect(THEME_IDS).toContain(`${series.id}-dark`);
    }
    for (const id of THEME_IDS) {
      const meta = THEME_META[id];
      expect(meta.id).toBe(id);
      expect(id).toBe(`${meta.series}-${meta.mode}`);
    }
  });

  it("exposes the paper series with matching meta theme-colors", () => {
    expect(THEME_META["paper-light"].themeColor).toBe("#f5f1e8");
    expect(THEME_META["paper-dark"].themeColor).toBe("#1a1d1b");
    expect(getThemeColor("paper-dark")).toBe("#1a1d1b");
    expect(getThemeSeriesLabel("paper-light")).toBe("纸感");
  });

  it("registers the ink series with the indigo accent family (D1/D6)", () => {
    expect(getThemeSeriesLabel("ink-light")).toBe("墨韵");
    expect(THEME_META["ink-light"].themeColor).toBe("#f2f0e5");
    expect(THEME_META["ink-dark"].themeColor).toBe("#1c1b1a");
    expect(THEME_META["ink-light"].swatch.accent).toBe("#205ea6");
    expect(THEME_META["ink-dark"].swatch.accent).toBe("#4385be");
  });

  it("registers the mist series with the cool blue accent (D1)", () => {
    expect(getThemeSeriesLabel("mist-light")).toBe("清透");
    expect(THEME_META["mist-light"].themeColor).toBe("#f0f1f3");
    expect(THEME_META["mist-dark"].themeColor).toBe("#16181b");
    expect(SERIES_FONT_PRESET.mist).toBe("system");
  });

  it("registers the celadon series with a tea-brown accent (M3/D1)", () => {
    expect(getThemeSeriesLabel("celadon-light")).toBe("青瓷");
    expect(THEME_META["celadon-light"].themeColor).toBe("#e3ede0");
    expect(THEME_META["celadon-dark"].themeColor).toBe("#141f1c");
    // Tea-brown, not green: the accent (and the selection/heatmap tints mixed
    // from it) must never collide with the fixed annotation green #78dc8c.
    expect(THEME_META["celadon-light"].swatch.accent).toBe("#8a6138");
    expect(THEME_META["celadon-dark"].swatch.accent).toBe("#c69c66");
    expect(SERIES_FONT_PRESET.celadon).toBe("system");
  });

  it("maps legacy single-word ids into the paper series", () => {
    expect(LEGACY_THEME_ID_MAP.light).toBe("paper-light");
    expect(LEGACY_THEME_ID_MAP.dark).toBe("paper-dark");
  });

  it("normalizes unknown theme ids without inventing values", () => {
    expect(isReaderTheme("paper-dark")).toBe(true);
    // Legacy ids are mapped by the store migration and boot script,
    // not silently accepted by the whitelist.
    expect(isReaderTheme("dark")).toBe(false);
    expect(normalizeReaderTheme("paper-dark", "paper-light")).toBe("paper-dark");
    expect(normalizeReaderTheme("sepia", "paper-light")).toBe("paper-light");
    expect(normalizeReaderTheme("dark")).toBe("paper-light");
  });

  it("toggles only the light/dark mode within each series", () => {
    for (const id of THEME_IDS) {
      const toggled = toggleThemeMode(id);
      expect(THEME_META[toggled].series).toBe(THEME_META[id].series);
      expect(THEME_META[toggled].mode).not.toBe(THEME_META[id].mode);
      expect(toggleThemeMode(toggled)).toBe(id);
    }
  });

  it("switches series while preserving the mode", () => {
    for (const id of THEME_IDS) {
      for (const series of THEME_SERIES) {
        const next = setSeries(id, series.id);
        expect(THEME_META[next].series).toBe(series.id);
        expect(THEME_META[next].mode).toBe(THEME_META[id].mode);
      }
    }
  });

  it("declares a typography preset for every series (D4)", () => {
    for (const series of THEME_SERIES) {
      expect(["system", "serif"]).toContain(SERIES_FONT_PRESET[series.id]);
    }
    expect(SERIES_FONT_PRESET.paper).toBe("system");
    expect(SERIES_FONT_PRESET.ink).toBe("serif");
  });
});
