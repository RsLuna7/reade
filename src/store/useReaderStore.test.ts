// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const backendMocks = vi.hoisted(() => ({
  clearConversionCache: vi.fn<() => Promise<void>>(),
  openLibrary: vi.fn<(rootPath: string) => Promise<import("../lib/backend").LibrarySnapshot>>(),
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
    backendMocks.openLibrary
      .mockReset()
      .mockImplementation(async (rootPath) => ({ rootPath, documents: [] }));
    backendMocks.readDocument.mockReset().mockImplementation(async (relativePath) => ({ kind: "markdown", relativePath, markdown: "# Test" }));
    backendMocks.retryDocumentIndex.mockReset().mockResolvedValue(undefined);
    useReaderStore.setState({
      theme: "paper-light",
      readingSettings: DEFAULT_READING_SETTINGS,
      motionLevel: "subtle",
      annotationTool: "view",
      highlightColor: "yellow",
      underlineColor: "blue",
      annotationColorNames: { yellow: "金句", green: "疑问", blue: "行动", pink: "术语" },
      fuzzyAnnotationAnchoring: false,
      expandedPaths: [],
      activeView: "reader",
      dailyGoalMinutes: 0,
      currentPath: null,
      currentContent: null,
      documents: [],
      indexProgress: null,
      navHistory: { back: [], forward: [] },
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

    // Celadon (M3) carries the system preset, replacing ink's serif.
    useReaderStore.getState().setThemeSeries("celadon");
    expect(useReaderStore.getState().theme).toBe("celadon-light");
    expect(useReaderStore.getState().readingSettings.fontFamily).toBe("system");
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

  it("persists the fuzzy anchoring switch and defaults it off (§5.6 D)", async () => {
    expect(useReaderStore.getState().fuzzyAnnotationAnchoring).toBe(false);

    useReaderStore.getState().setFuzzyAnnotationAnchoring(true);
    expect(useReaderStore.getState().fuzzyAnnotationAnchoring).toBe(true);
    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: Record<string, unknown> };
    expect(stored.state).toMatchObject({ fuzzyAnnotationAnchoring: true });

    // An explicitly persisted opt-in survives rehydration on the next launch.
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: READER_PREFERENCES_VERSION,
        state: { fuzzyAnnotationAnchoring: true },
      }),
    );
    await useReaderStore.persist.rehydrate();
    expect(useReaderStore.getState().fuzzyAnnotationAnchoring).toBe(true);
  });

  it("collapses corrupt fuzzy anchoring values to the safe default", async () => {
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: READER_PREFERENCES_VERSION,
        state: { fuzzyAnnotationAnchoring: "yes" },
      }),
    );
    await useReaderStore.persist.rehydrate();
    expect(useReaderStore.getState().fuzzyAnnotationAnchoring).toBe(false);

    // Older persisted payloads without the field also stay off.
    expect(
      migrateReaderPreferences({ theme: "paper-light" }, READER_PREFERENCES_VERSION),
    ).not.toHaveProperty("fuzzyAnnotationAnchoring");
  });

  it("resets the fuzzy anchoring switch with the other reader preferences", () => {
    useReaderStore.getState().setFuzzyAnnotationAnchoring(true);
    useReaderStore.getState().resetReaderPreferences();
    expect(useReaderStore.getState().fuzzyAnnotationAnchoring).toBe(false);
  });

  it("persists the scroll-map switch and defaults it on (plan-rich-scrollbar RS-D10)", async () => {
    useReaderStore.setState({ showScrollMap: true });

    useReaderStore.getState().setShowScrollMap(false);
    expect(useReaderStore.getState().showScrollMap).toBe(false);
    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: Record<string, unknown> };
    expect(stored.state).toMatchObject({ showScrollMap: false });

    // A persisted opt-out survives rehydration on the next launch.
    // (setState 会触发 persist 写入,必须先改内存态再覆写存储。)
    useReaderStore.setState({ showScrollMap: true });
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: READER_PREFERENCES_VERSION,
        state: { showScrollMap: false },
      }),
    );
    await useReaderStore.persist.rehydrate();
    expect(useReaderStore.getState().showScrollMap).toBe(false);
  });

  it("collapses corrupt scroll-map values to the default-on state", async () => {
    useReaderStore.setState({ showScrollMap: true });
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: READER_PREFERENCES_VERSION,
        state: { showScrollMap: "no" },
      }),
    );
    await useReaderStore.persist.rehydrate();
    expect(useReaderStore.getState().showScrollMap).toBe(true);

    // Older persisted payloads without the field never emit the key.
    expect(
      migrateReaderPreferences({ theme: "paper-light" }, READER_PREFERENCES_VERSION),
    ).not.toHaveProperty("showScrollMap");

    // 恢复默认把开关拨回默认开。
    useReaderStore.getState().setShowScrollMap(false);
    useReaderStore.getState().resetReaderPreferences();
    expect(useReaderStore.getState().showScrollMap).toBe(true);
  });

  it("persists the three focus-mode switches and defaults them off (plan-focus-mode FM-D3)", async () => {
    expect(useReaderStore.getState().focusSpotlight).toBe(false);
    expect(useReaderStore.getState().typewriterScroll).toBe(false);
    expect(useReaderStore.getState().readingRuler).toBe(false);

    useReaderStore.getState().setFocusSpotlight(true);
    useReaderStore.getState().setTypewriterScroll(true);
    useReaderStore.getState().setReadingRuler(true);
    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: Record<string, unknown> };
    expect(stored.state).toMatchObject({
      focusSpotlight: true,
      typewriterScroll: true,
      readingRuler: true,
    });

    // 显式开启的偏好在下次启动 rehydrate 后保留。
    useReaderStore.setState({
      focusSpotlight: false,
      typewriterScroll: false,
      readingRuler: false,
    });
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: READER_PREFERENCES_VERSION,
        state: { focusSpotlight: true, typewriterScroll: true, readingRuler: true },
      }),
    );
    await useReaderStore.persist.rehydrate();
    expect(useReaderStore.getState().focusSpotlight).toBe(true);
    expect(useReaderStore.getState().typewriterScroll).toBe(true);
    expect(useReaderStore.getState().readingRuler).toBe(true);
  });

  it("collapses corrupt focus-mode values to the default-off state", async () => {
    useReaderStore.setState({
      focusSpotlight: false,
      typewriterScroll: false,
      readingRuler: false,
    });
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: READER_PREFERENCES_VERSION,
        state: { focusSpotlight: "yes", typewriterScroll: 1, readingRuler: null },
      }),
    );
    await useReaderStore.persist.rehydrate();
    expect(useReaderStore.getState().focusSpotlight).toBe(false);
    expect(useReaderStore.getState().typewriterScroll).toBe(false);
    expect(useReaderStore.getState().readingRuler).toBe(false);

    // 旧持久化数据没有这些键时不注入。
    const migrated = migrateReaderPreferences(
      { theme: "paper-light" },
      READER_PREFERENCES_VERSION,
    );
    expect(migrated).not.toHaveProperty("focusSpotlight");
    expect(migrated).not.toHaveProperty("typewriterScroll");
    expect(migrated).not.toHaveProperty("readingRuler");

    // 恢复默认把三开关拨回默认关。
    useReaderStore.getState().setFocusSpotlight(true);
    useReaderStore.getState().setTypewriterScroll(true);
    useReaderStore.getState().setReadingRuler(true);
    useReaderStore.getState().resetReaderPreferences();
    expect(useReaderStore.getState().focusSpotlight).toBe(false);
    expect(useReaderStore.getState().typewriterScroll).toBe(false);
    expect(useReaderStore.getState().readingRuler).toBe(false);
  });

  it("persists annotation color names and normalizes them on write", () => {
    expect(useReaderStore.getState().annotationColorNames).toEqual({
      yellow: "金句",
      green: "疑问",
      blue: "行动",
      pink: "术语",
    });

    useReaderStore.getState().setAnnotationColorName("yellow", "  重点摘录截断  ");
    // trim + 6 字符截断。
    expect(useReaderStore.getState().annotationColorNames.yellow).toBe("重点摘录截断");
    // 空值回落该色默认名。
    useReaderStore.getState().setAnnotationColorName("green", "   ");
    expect(useReaderStore.getState().annotationColorNames.green).toBe("疑问");

    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: { annotationColorNames: Record<string, string> } };
    expect(stored.state.annotationColorNames).toMatchObject({ yellow: "重点摘录截断" });
  });

  it("rehydrates color names and fills defaults for missing or corrupt keys", async () => {
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: READER_PREFERENCES_VERSION,
        state: { annotationColorNames: { yellow: "灵感", blue: 42 } },
      }),
    );
    await useReaderStore.persist.rehydrate();
    expect(useReaderStore.getState().annotationColorNames).toEqual({
      yellow: "灵感",
      green: "疑问",
      blue: "行动",
      pink: "术语",
    });

    // 旧持久化数据完全没有该键 → 全默认。
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: READER_PREFERENCES_VERSION, state: {} }),
    );
    await useReaderStore.persist.rehydrate();
    expect(useReaderStore.getState().annotationColorNames.pink).toBe("术语");
  });

  it("resets color names alone and with the other reader preferences", () => {
    useReaderStore.getState().setAnnotationColorName("pink", "生词");
    useReaderStore.getState().resetAnnotationColorNames();
    expect(useReaderStore.getState().annotationColorNames.pink).toBe("术语");

    useReaderStore.getState().setAnnotationColorName("yellow", "灵感");
    useReaderStore.getState().resetReaderPreferences();
    expect(useReaderStore.getState().annotationColorNames.yellow).toBe("金句");
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

  it("persists and clamps the read-aloud rate and voice preferences", () => {
    useReaderStore.getState().setTtsRate(1.4);
    useReaderStore.getState().setTtsVoiceName("Microsoft Huihui");
    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: Record<string, unknown> };
    expect(stored.state).toMatchObject({
      ttsRate: 1.4,
      ttsVoiceName: "Microsoft Huihui",
    });

    useReaderStore.getState().setTtsRate(9);
    expect(useReaderStore.getState().ttsRate).toBe(2);
    useReaderStore.getState().setTtsRate(0.1);
    expect(useReaderStore.getState().ttsRate).toBe(0.5);
    useReaderStore.getState().setTtsRate(Number.NaN);
    expect(useReaderStore.getState().ttsRate).toBe(1);
    // 空字符串回落为"自动挑选"。
    useReaderStore.getState().setTtsVoiceName("");
    expect(useReaderStore.getState().ttsVoiceName).toBeNull();
  });

  it("persists the review card mode and defaults it to excerpt (plan-cloze-review CZ-D9)", async () => {
    expect(useReaderStore.getState().reviewCardMode).toBe("excerpt");

    useReaderStore.getState().setReviewCardMode("cloze");
    expect(useReaderStore.getState().reviewCardMode).toBe("cloze");
    const stored = JSON.parse(
      localStorage.getItem(READER_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { state: Record<string, unknown> };
    expect(stored.state).toMatchObject({ reviewCardMode: "cloze" });

    // 持久化的档位在下次启动 rehydrate 后保留。
    useReaderStore.setState({ reviewCardMode: "excerpt" });
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: READER_PREFERENCES_VERSION,
        state: { reviewCardMode: "mixed" },
      }),
    );
    await useReaderStore.persist.rehydrate();
    expect(useReaderStore.getState().reviewCardMode).toBe("mixed");
  });

  it("collapses corrupt review card modes to the excerpt default", async () => {
    useReaderStore.setState({ reviewCardMode: "excerpt" });
    localStorage.setItem(
      READER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: READER_PREFERENCES_VERSION,
        state: { reviewCardMode: "flashcard" },
      }),
    );
    await useReaderStore.persist.rehydrate();
    expect(useReaderStore.getState().reviewCardMode).toBe("excerpt");

    // setter 对坏值保持原档不变。
    useReaderStore.getState().setReviewCardMode("cloze");
    useReaderStore.getState().setReviewCardMode("bogus" as "cloze");
    expect(useReaderStore.getState().reviewCardMode).toBe("cloze");

    // 旧持久化数据没有该键时不产出字段。
    expect(
      migrateReaderPreferences({ theme: "paper-light" }, READER_PREFERENCES_VERSION),
    ).not.toHaveProperty("reviewCardMode");
    useReaderStore.setState({ reviewCardMode: "excerpt" });
  });

  it("switches the workspace view and normalizes unknown values", () => {
    expect(useReaderStore.getState().activeView).toBe("reader");
    useReaderStore.getState().setActiveView("stats");
    expect(useReaderStore.getState().activeView).toBe("stats");
    useReaderStore.getState().setActiveView("home");
    expect(useReaderStore.getState().activeView).toBe("home");
    useReaderStore.getState().setActiveView("review");
    expect(useReaderStore.getState().activeView).toBe("review");
    useReaderStore.getState().setActiveView("annotations");
    expect(useReaderStore.getState().activeView).toBe("annotations");
    useReaderStore.getState().setActiveView("dashboard" as "stats");
    expect(useReaderStore.getState().activeView).toBe("reader");
  });

  it("returns to the reading surface when a document is opened from stats", async () => {
    useReaderStore.getState().setActiveView("stats");
    await useReaderStore.getState().selectDocument("paper.pdf");
    expect(useReaderStore.getState().activeView).toBe("reader");
    expect(useReaderStore.getState().currentPath).toBe("paper.pdf");
  });

  it("returns to the reading surface when a document is opened from home", async () => {
    useReaderStore.getState().setActiveView("home");
    await useReaderStore.getState().selectDocument("guide.md");
    expect(useReaderStore.getState().activeView).toBe("reader");
    expect(useReaderStore.getState().currentPath).toBe("guide.md");
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

describe("navigation history (plan-nav-history)", () => {
  const departure = {
    path: "a.md",
    position: { kind: "scroll", scrollTop: 100 },
  } as const;

  beforeEach(() => {
    backendMocks.openLibrary
      .mockReset()
      .mockImplementation(async (rootPath) => ({ rootPath, documents: [] }));
    useReaderStore.setState({
      navHistory: { back: [], forward: [] },
      expandedPaths: [],
      error: null,
    });
  });

  it("records departures and walks back/forward through the store actions", () => {
    useReaderStore.getState().recordNavLocation(departure);
    expect(useReaderStore.getState().navHistory.back).toHaveLength(1);

    const current = {
      path: "b.md",
      position: { kind: "scroll", scrollTop: 0 },
    } as const;
    const target = useReaderStore.getState().navBack(current);
    expect(target).toEqual(departure);
    expect(useReaderStore.getState().navHistory.back).toHaveLength(0);
    expect(useReaderStore.getState().navHistory.forward).toEqual([current]);

    const forwardTarget = useReaderStore.getState().navForward(departure);
    expect(forwardTarget).toEqual(current);
    expect(useReaderStore.getState().navHistory.forward).toHaveLength(0);
    expect(useReaderStore.getState().navHistory.back).toEqual([departure]);
  });

  it("returns null on empty stacks without touching state", () => {
    expect(useReaderStore.getState().navBack(departure)).toBeNull();
    expect(useReaderStore.getState().navForward(departure)).toBeNull();
    expect(useReaderStore.getState().navHistory).toEqual({ back: [], forward: [] });
  });

  it("clears the history when a library opens", async () => {
    useReaderStore.getState().recordNavLocation(departure);
    await useReaderStore.getState().openLibrary("D:/next-library");
    expect(backendMocks.openLibrary).toHaveBeenCalledWith("D:/next-library");
    expect(useReaderStore.getState().navHistory).toEqual({ back: [], forward: [] });
  });
});
