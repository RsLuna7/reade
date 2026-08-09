// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_READING_SETTINGS,
  READER_PREFERENCES_STORAGE_KEY,
  normalizeReadingSettings,
  useReaderStore,
} from "./useReaderStore";

describe("reading settings", () => {
  beforeEach(() => {
    localStorage.clear();
    useReaderStore.setState({
      theme: "light",
      readingSettings: DEFAULT_READING_SETTINGS,
      expandedPaths: [],
    });
  });

  it("clamps numeric settings to reader-safe bounds", () => {
    expect(
      normalizeReadingSettings({
        fontSize: 100,
        lineHeight: 0,
        contentWidth: 2000,
        paragraphSpacing: Number.NaN,
      }),
    ).toEqual({
      ...DEFAULT_READING_SETTINGS,
      fontSize: 26,
      lineHeight: 1.4,
      contentWidth: 1200,
      paragraphSpacing: 0.5,
    });
  });

  it("updates partial settings without dropping untouched preferences", () => {
    useReaderStore.getState().updateReadingSettings({ fontSize: 21 });
    expect(useReaderStore.getState().readingSettings).toEqual({
      ...DEFAULT_READING_SETTINGS,
      fontSize: 21,
    });
  });

  it("persists only theme, reading settings and expanded paths", () => {
    useReaderStore.getState().toggleTheme();
    useReaderStore.getState().updateReadingSettings({ contentWidth: 960 });
    useReaderStore.getState().toggleDirectory("正文");

    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: Record<string, unknown> };

    expect(stored.state).toMatchObject({
      theme: "dark",
      readingSettings: { contentWidth: 960 },
      expandedPaths: ["正文"],
    });
    expect(stored.state).not.toHaveProperty("documents");
    expect(stored.state).not.toHaveProperty("currentContent");
  });
});
