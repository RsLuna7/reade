// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const backendMocks = vi.hoisted(() => ({
  clearConversionCache: vi.fn<() => Promise<void>>(),
  readDocument: vi.fn<(relativePath: string) => Promise<import("../lib/backend").DocumentContent>>(),
  retryDocumentIndex: vi.fn<(relativePath: string) => Promise<void>>(),
}));

vi.mock("../lib/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/backend")>();
  return { ...actual, ...backendMocks };
});

import {
  DEFAULT_READING_SETTINGS,
  READER_PREFERENCES_STORAGE_KEY,
  READER_PREFERENCES_VERSION,
  getSystemMotionLevel,
  migrateReaderPreferences,
  normalizeMotionLevel,
  normalizeReadingSettings,
  useReaderStore,
} from "./useReaderStore";

function mockReducedMotion(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("reading settings", () => {
  beforeEach(() => {
    localStorage.clear();
    mockReducedMotion(false);
    backendMocks.clearConversionCache.mockReset().mockResolvedValue(undefined);
    backendMocks.readDocument.mockReset().mockImplementation(async (relativePath) => ({ kind: "markdown", relativePath, markdown: "# Test" }));
    backendMocks.retryDocumentIndex.mockReset().mockResolvedValue(undefined);
    useReaderStore.setState({
      theme: "paper-light",
      readingSettings: DEFAULT_READING_SETTINGS,
      motionLevel: "subtle",
      annotationTool: "view",
      highlightColor: "yellow",
      underlineColor: "blue",
      expandedPaths: [],
      activeView: "reader",
      dailyGoalMinutes: 0,
      currentPath: null,
      currentContent: null,
      documents: [],
      indexProgress: null,
      error: null,
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
      contentWidth: 1600,
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

  it("persists only reader preferences using the current schema version", () => {
    useReaderStore.getState().toggleTheme();
    useReaderStore.getState().updateReadingSettings({ contentWidth: 960 });
    useReaderStore.getState().setMotionLevel("full");
    useReaderStore.getState().setAnnotationTool("underline");
    useReaderStore.getState().setHighlightColor("green");
    useReaderStore.getState().setUnderlineColor("pink");
    useReaderStore.getState().toggleDirectory("正文");
    useReaderStore.getState().setActiveView("stats");

    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: Record<string, unknown>; version: number };

    expect(stored.version).toBe(READER_PREFERENCES_VERSION);
    expect(stored.state).toMatchObject({
      theme: "paper-dark",
      readingSettings: { contentWidth: 960 },
      motionLevel: "full",
      highlightColor: "green",
      underlineColor: "pink",
      expandedPaths: ["正文"],
    });
    // The armed annotation tool is session-only: persisting it would turn the
    // first selection after the next launch into an unwanted annotation.
    expect(stored.state).not.toHaveProperty("annotationTool");
    expect(stored.state).not.toHaveProperty("documents");
    expect(stored.state).not.toHaveProperty("currentContent");
    // The workspace view is session-only: launching into the statistics
    // dashboard instead of the reading surface would be surprising.
    expect(stored.state).not.toHaveProperty("activeView");
  });

  it("sets an explicit theme id and ignores unknown values", () => {
    useReaderStore.getState().setTheme("paper-dark");
    expect(useReaderStore.getState().theme).toBe("paper-dark");
    useReaderStore.getState().setTheme("sepia" as "paper-light");
    expect(useReaderStore.getState().theme).toBe("paper-dark");
    // Legacy single-word ids are only accepted through migration, not setTheme.
    useReaderStore.getState().setTheme("light" as "paper-light");
    expect(useReaderStore.getState().theme).toBe("paper-dark");
  });

  it("keeps the reading settings intact when re-picking the current series", () => {
    useReaderStore.getState().updateReadingSettings({ fontFamily: "sans" });
    useReaderStore.getState().setThemeSeries("paper");
    expect(useReaderStore.getState().theme).toBe("paper-light");
    expect(useReaderStore.getState().readingSettings.fontFamily).toBe("sans");
  });

  it("applies the series typography preset on series switch only (D4)", () => {
    useReaderStore.getState().setThemeSeries("ink");
    expect(useReaderStore.getState().theme).toBe("ink-light");
    expect(useReaderStore.getState().readingSettings.fontFamily).toBe("serif");

    // Flipping light/dark never touches the preset.
    useReaderStore.getState().toggleTheme();
    expect(useReaderStore.getState().theme).toBe("ink-dark");
    expect(useReaderStore.getState().readingSettings.fontFamily).toBe("serif");

    // A manual override sticks across mode toggles…
    useReaderStore.getState().updateReadingSettings({ fontFamily: "system" });
    useReaderStore.getState().toggleTheme();
    expect(useReaderStore.getState().theme).toBe("ink-light");
    expect(useReaderStore.getState().readingSettings.fontFamily).toBe("system");

    // …until the next series switch applies that series' preset, keeping mode.
    useReaderStore.getState().setThemeSeries("paper");
    expect(useReaderStore.getState().theme).toBe("paper-light");
    expect(useReaderStore.getState().readingSettings.fontFamily).toBe("system");
    useReaderStore.getState().setThemeSeries("ink");
    expect(useReaderStore.getState().readingSettings.fontFamily).toBe("serif");
  });

  it("persists the switched series and preset like any other preference", () => {
    useReaderStore.getState().setThemeSeries("ink");
    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: Record<string, unknown> };
    expect(stored.state).toMatchObject({
      theme: "ink-light",
      readingSettings: { fontFamily: "serif" },
    });
  });

  it("applies background index status without replacing the open PDF", () => {
    useReaderStore.setState({
      documents: [{ relativePath: "paper.pdf", title: "paper", size: 10, modified: 1, format: "pdf", indexStatus: "indexing", indexError: null }],
      currentPath: "paper.pdf",
      currentContent: { kind: "pdf", relativePath: "paper.pdf", size: 10, indexStatus: "indexing", indexError: null },
    });
    useReaderStore.getState().applyDocumentIndexStatus({ relativePath: "paper.pdf", title: "Paper title", status: "partial", error: "第 3 页缺少文本" });
    expect(useReaderStore.getState().documents[0]).toMatchObject({ title: "Paper title", indexStatus: "partial" });
    expect(useReaderStore.getState().currentContent).toMatchObject({ kind: "pdf", indexStatus: "partial", indexError: "第 3 页缺少文本" });
  });

  it("derives the first-run motion level from the system preference", () => {
    mockReducedMotion(true);
    expect(getSystemMotionLevel()).toBe("off");

    mockReducedMotion(false);
    expect(getSystemMotionLevel()).toBe("subtle");
  });

  it("normalizes corrupt motion values without overriding a valid fallback", () => {
    expect(normalizeMotionLevel("full", "subtle")).toBe("full");
    expect(normalizeMotionLevel("cinematic", "off")).toBe("off");
    expect(normalizeMotionLevel(null, "subtle")).toBe("subtle");
  });

  it("migrates v1 preferences without transient store data", () => {
    expect(
      migrateReaderPreferences(
        {
          theme: "dark",
          readingSettings: { ...DEFAULT_READING_SETTINGS, fontSize: 20 },
          expandedPaths: ["正文"],
          annotationTool: "highlight",
          documents: [{ relativePath: "private.pdf" }],
        },
        1,
      ),
    ).toEqual({
      theme: "paper-dark",
      readingSettings: { ...DEFAULT_READING_SETTINGS, fontSize: 20 },
      expandedPaths: ["正文"],
    });
  });

  it("rehydrates v1 preferences and uses the current system-derived motion default", async () => {
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          theme: "dark",
          readingSettings: { ...DEFAULT_READING_SETTINGS, fontSize: 22 },
          expandedPaths: ["旧目录"],
        },
      }),
    );

    await useReaderStore.persist.rehydrate();

    expect(useReaderStore.getState()).toMatchObject({
      theme: "paper-dark",
      readingSettings: { ...DEFAULT_READING_SETTINGS, fontSize: 22 },
      motionLevel: "subtle",
      expandedPaths: ["旧目录"],
    });
  });

  it("migrates persisted v3 single-word theme ids to the series-mode ids (v4)", async () => {
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        state: {
          theme: "dark",
          readingSettings: { ...DEFAULT_READING_SETTINGS, fontSize: 18 },
        },
      }),
    );

    await useReaderStore.persist.rehydrate();

    expect(useReaderStore.getState().theme).toBe("paper-dark");
    expect(useReaderStore.getState().readingSettings.fontSize).toBe(18);

    // The upgraded id is written back under the current schema version.
    useReaderStore.getState().updateReadingSettings({ fontSize: 19 });
    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: Record<string, unknown>; version: number };
    expect(stored.version).toBe(READER_PREFERENCES_VERSION);
    expect(stored.state).toMatchObject({ theme: "paper-dark" });
  });

  it("drops an unknown persisted theme id instead of inventing one", async () => {
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        state: { theme: "sepia" },
      }),
    );

    await useReaderStore.persist.rehydrate();

    expect(useReaderStore.getState().theme).toBe("paper-light");
  });

  it("rehydrates legacy data containing annotationTool as view while restoring colors", async () => {
    useReaderStore.getState().setAnnotationTool("underline");
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: READER_PREFERENCES_VERSION,
        state: {
          annotationTool: "highlight",
          highlightColor: "green",
          underlineColor: "pink",
        },
      }),
    );

    await useReaderStore.persist.rehydrate();

    expect(useReaderStore.getState().annotationTool).toBe("view");
    expect(useReaderStore.getState().highlightColor).toBe("green");
    expect(useReaderStore.getState().underlineColor).toBe("pink");
  });

  it("keeps an explicitly persisted motion level ahead of the system", async () => {
    mockReducedMotion(true);
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: READER_PREFERENCES_VERSION,
        state: { motionLevel: "full" },
      }),
    );

    await useReaderStore.persist.rehydrate();

    expect(useReaderStore.getState().motionLevel).toBe("full");
  });

  it("resets reading preferences and re-reads the current system default", () => {
    useReaderStore.getState().updateReadingSettings({ fontSize: 24 });
    useReaderStore.getState().setMotionLevel("full");
    mockReducedMotion(true);

    useReaderStore.getState().resetReaderPreferences();

    expect(useReaderStore.getState().readingSettings).toEqual(DEFAULT_READING_SETTINGS);
    expect(useReaderStore.getState().motionLevel).toBe("off");
  });

  it("returns false when retry has no selected document", async () => {
    await expect(useReaderStore.getState().retryCurrentDocumentIndex()).resolves.toBe(false);
    expect(backendMocks.retryDocumentIndex).not.toHaveBeenCalled();
  });

  it("reports retry success and failure as booleans", async () => {
    useReaderStore.setState({ currentPath: "paper.pdf" });
    await expect(useReaderStore.getState().retryCurrentDocumentIndex()).resolves.toBe(true);
    expect(backendMocks.retryDocumentIndex).toHaveBeenCalledWith("paper.pdf");

    backendMocks.retryDocumentIndex.mockRejectedValueOnce(new Error("retry failed"));
    await expect(useReaderStore.getState().retryCurrentDocumentIndex()).resolves.toBe(false);
    expect(useReaderStore.getState().error).toBe("retry failed");
  });

  it("reports cache clearing as a boolean and resets index state only on success", async () => {
    useReaderStore.setState({
      documents: [{ relativePath: "paper.pdf", title: "paper", size: 10, modified: 1, format: "pdf", indexStatus: "ready", indexError: null }],
      currentContent: { kind: "pdf", relativePath: "paper.pdf", size: 10, indexStatus: "ready", indexError: null },
      indexProgress: { total: 1, completed: 1, ready: 1, partial: 0, failed: 0 },
    });

    await expect(useReaderStore.getState().clearDocumentCache()).resolves.toBe(true);
    expect(useReaderStore.getState().documents[0].indexStatus).toBe("pending");
    expect(useReaderStore.getState().currentContent).toMatchObject({ indexStatus: "pending" });
    expect(useReaderStore.getState().indexProgress).toBeNull();

    backendMocks.clearConversionCache.mockRejectedValueOnce(new Error("clear failed"));
    await expect(useReaderStore.getState().clearDocumentCache()).resolves.toBe(false);
    expect(useReaderStore.getState().error).toBe("clear failed");
  });

  it("persists and clamps the daily reading goal", () => {
    useReaderStore.getState().setDailyGoalMinutes(45);
    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: Record<string, unknown> };
    expect(stored.state).toMatchObject({ dailyGoalMinutes: 45 });

    useReaderStore.getState().setDailyGoalMinutes(99_999);
    expect(useReaderStore.getState().dailyGoalMinutes).toBe(1_440);
    useReaderStore.getState().setDailyGoalMinutes(Number.NaN);
    expect(useReaderStore.getState().dailyGoalMinutes).toBe(1_440);
    useReaderStore.getState().setDailyGoalMinutes(0);
    expect(useReaderStore.getState().dailyGoalMinutes).toBe(0);
  });

  it("switches the workspace view and normalizes unknown values", () => {
    expect(useReaderStore.getState().activeView).toBe("reader");
    useReaderStore.getState().setActiveView("stats");
    expect(useReaderStore.getState().activeView).toBe("stats");
    useReaderStore.getState().setActiveView("dashboard" as "stats");
    expect(useReaderStore.getState().activeView).toBe("reader");
  });

  it("returns to the reading surface when a document is opened from stats", async () => {
    useReaderStore.getState().setActiveView("stats");
    await useReaderStore.getState().selectDocument("paper.pdf");
    expect(useReaderStore.getState().activeView).toBe("reader");
    expect(useReaderStore.getState().currentPath).toBe("paper.pdf");
  });

  it("clones repeated search locators so the reader can replay positioning", async () => {
    const locator = { kind: "pdfPage", page: 7 } as const;
    await useReaderStore.getState().selectDocument("paper.pdf", locator);
    const first = useReaderStore.getState().currentLocator;
    await useReaderStore.getState().selectDocument("paper.pdf", locator);
    const second = useReaderStore.getState().currentLocator;

    expect(first).toEqual(locator);
    expect(second).toEqual(locator);
    expect(first).not.toBe(locator);
    expect(second).not.toBe(first);
  });
});
