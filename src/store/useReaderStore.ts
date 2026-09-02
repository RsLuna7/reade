import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  chooseLibraryDirectory,
  clearConversionCache,
  openLibrary as openLibraryFromBackend,
  readDocument,
  retryDocumentIndex,
  refreshLibrary as refreshLibraryFromBackend,
  searchDocuments,
  type DocumentContent,
  type DocumentInfo,
  type LibrarySnapshot,
  type DocumentIndexEvent,
  type IndexProgress,
  type SearchLocator,
  type SearchResult,
} from "../lib/backend";
import {
  DEFAULT_ANNOTATION_COLOR_NAMES,
  normalizeAnnotationColorName,
} from "../lib/annotations";
import {
  isAnnotationTone,
  legacyColorToTone,
  toneToLegacyColor,
  type AnnotationTone,
} from "../lib/annotationModel";
import { normalizeReviewCardMode, type ReviewCardMode } from "../lib/clozeCard";
import {
  EMPTY_NAV_HISTORY,
  popNavBack,
  popNavForward,
  pushNavLocation,
  type NavHistory,
  type NavLocation,
} from "../lib/navHistory";
import { clampTtsRate } from "../lib/ttsPlayer";
import { clampAutoPaceBias } from "../lib/autoPace";
import {
  SERIES_FONT_PRESET,
  THEME_META,
  type ReaderTheme,
  type ThemeSeriesId,
  normalizeReaderTheme,
  setSeries,
  toggleThemeMode,
} from "../lib/themes";
import { buildDocumentTree, findChildNodes, reconcileExpandedPaths } from "../lib/tree";
import {
  type LibraryTreeLayout,
  buildLaidOutDocumentTree,
  moveSibling,
  pinNode,
  readTreeLayout,
  reconcileTreeLayout,
  resetFolderLayout,
  unpinNode,
  writeTreeLayout,
} from "../lib/treeLayout";
// 竖排模式（plan-vertical-writing VW-D1）：每文档记忆的读写在 lib，
// store 只持有"当前文档是否竖排"的会话镜像。
import { readVerticalPreference, writeVerticalPreference } from "../lib/verticalWriting";
import {
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  DEFAULT_READING_SETTINGS,
  MAX_DAILY_GOAL_MINUTES,
  READER_PREFERENCES_STORAGE_KEY,
  READER_PREFERENCES_VERSION,
  createDefaultReaderPreferences,
  createResettablePreferencePatch,
  getSystemMotionLevel,
  mergeReaderPreferences,
  migrateReaderPreferences,
  normalizeAnnotationColor,
  normalizeDailyGoalMinutes,
  normalizeFuzzyAnnotationAnchoring,
  normalizeLibraryViewMode,
  normalizeMotionLevel,
  normalizeReadingSettings,
  pickPersistedPreferences,
  type AnnotationColorPreference,
  type LibraryViewMode,
  type ReaderFontFamily,
  type ReadingSettings,
} from "../lib/readerPreferences";

export type { ReaderMotionLevel } from "../lib/motion";
export type { ReaderTheme, ThemeSeriesId } from "../lib/themes";
export { THEME_IDS, THEME_META, THEME_SERIES, normalizeReaderTheme } from "../lib/themes";
export {
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  DEFAULT_READING_SETTINGS,
  MAX_DAILY_GOAL_MINUTES,
  READER_PREFERENCES_STORAGE_KEY,
  READER_PREFERENCES_VERSION,
  getSystemMotionLevel,
  migrateReaderPreferences,
  normalizeAnnotationColor,
  normalizeDailyGoalMinutes,
  normalizeFuzzyAnnotationAnchoring,
  normalizeLibraryViewMode,
  normalizeMotionLevel,
  normalizeReadingSettings,
  type AnnotationColorPreference,
  type LibraryViewMode,
  type ReaderFontFamily,
  type ReadingSettings,
};

import type { ReaderMotionLevel } from "../lib/motion";

export type AnnotationToolPreference = "view" | "highlight" | "underline";
/**
 * Workspace view: home dashboard, reading surface, reading statistics,
 * daily annotation review or the full-screen annotation hub.
 */
export type ReaderView = "home" | "reader" | "stats" | "review" | "annotations";

const READER_VIEWS = new Set<ReaderView>([
  "home",
  "reader",
  "stats",
  "review",
  "annotations",
]);

const ANNOTATION_TOOLS = new Set<AnnotationToolPreference>(["view", "highlight", "underline"]);

export function normalizeAnnotationTool(
  value: unknown,
  fallback: AnnotationToolPreference = "view",
): AnnotationToolPreference {
  return typeof value === "string" && ANNOTATION_TOOLS.has(value as AnnotationToolPreference)
    ? (value as AnnotationToolPreference)
    : fallback;
}

function preferredTheme(): ReaderTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "paper-light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "paper-dark"
    : "paper-light";
}

export const preferredMotionLevel = getSystemMotionLevel;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "发生了未知错误";
}

interface ReaderState {
  snapshot: LibrarySnapshot | null;
  documents: DocumentInfo[];
  currentPath: string | null;
  currentContent: DocumentContent | null;
  currentLocator: SearchLocator | null;
  indexProgress: IndexProgress | null;
  searchQuery: string;
  searchResults: SearchResult[];
  theme: ReaderTheme;
  readingSettings: ReadingSettings;
  motionLevel: ReaderMotionLevel;
  annotationTool: AnnotationToolPreference;
  highlightColor: AnnotationColorPreference;
  underlineColor: AnnotationColorPreference;
  excerptTone: AnnotationTone;
  /**
   * 四色语义命名(plan-annotation-color-names):纯展示偏好,持久化、
   * 双端同构;不写入任何标注数据或导出格式。
   */
  annotationColorNames: Record<AnnotationColorPreference, string>;
  /**
   * Global switch for the fuzzy last-resort anchoring step (§5.6 D). Off by
   * default: fuzzy may anchor a mark to similar but different text. Persisted.
   */
  fuzzyAnnotationAnchoring: boolean;
  /**
   * Load HTTPS images referenced by Markdown from the network. Off by default
   * (local-first / no drive-by requests); persisted. CSP still forbids http:.
   */
  allowRemoteImages: boolean;
  /**
   * 高亮角标:在高亮标注首段左上角画红色倒三角,便于扫视定位。
   * 默认关(按需启用);持久化、双端同构。仅影响高亮,不影响下划线。
   */
  showHighlightCaret: boolean;
  /**
   * 文档地图刻度层开关(plan-rich-scrollbar RS-D4/RS-D10):默认开,
   * 持久化;关掉后不做任何刻度测量。
   */
  showScrollMap: boolean;
  /**
   * 聚焦模式三开关(plan-focus-mode FM-D3):段落聚焦/打字机滚动/
   * 阅读标尺,相互独立,默认全关;持久化、双端同构。
   */
  focusSpotlight: boolean;
  typewriterScroll: boolean;
  readingRuler: boolean;
  /**
   * 自感应按段推进(plan-auto-pace):开关默认关;bias 整体偏快/偏慢
   * (默认 1,类似语速),持久化、双端同构。
   */
  autoPaceEnabled: boolean;
  autoPaceBias: number;
  /**
   * 读完接着读(plan-read-next):滚动到末尾时的"下一篇"推荐卡。
   * 默认开;持久化、双端同构。
   */
  readNextEnabled: boolean;
  /**
   * 书架视图(plan-bookshelf-covers BC-D4):库 tab 的树/书架浏览形态。
   * 持久化、双端同构。
   */
  libraryViewMode: LibraryViewMode;
  expandedPaths: string[];
  /**
   * 当前书库文档树的置顶/手排（独立键 `reade-tree-layout`）。
   * Session 镜像；切换/刷新书库时从存储读取并 reconcile。
   */
  treeLayout: LibraryTreeLayout;
  /** Session-only; intentionally left out of the persisted preferences. */
  activeView: ReaderView;
  /** Daily reading goal in minutes; 0 disables the goal. Persisted. */
  dailyGoalMinutes: number;
  /** Read-aloud playback rate (0.5–2.0). Persisted. */
  ttsRate: number;
  /** Preferred read-aloud voice by name; null = auto pick. Persisted. */
  ttsVoiceName: string | null;
  /**
   * 每日回顾卡片渲染档(plan-cloze-review §3.2):摘录/挖空/混合。
   * 默认摘录保持现状零惊扰(CZ-D3);持久化、双端同构。
   */
  reviewCardMode: ReviewCardMode;
  /**
   * 阅读回退栈(plan-nav-history):跳转历史的后退/前进双栈。
   * Session-only,不进 persisted preferences;切换书库时清空。
   */
  navHistory: NavHistory;
  /**
   * 竖排模式（plan-vertical-writing VW-D1）：当前文档的竖排开关镜像。
   * Session-only（每文档记忆持久化在 `reade-vertical-writing` 独立键），
   * selectDocument 时从记忆同步。
   */
  verticalWriting: boolean;
  loading: boolean;
  error: string | null;
  chooseAndOpenLibrary: () => Promise<void>;
  openLibrary: (rootPath: string) => Promise<void>;
  refreshLibrary: () => Promise<void>;
  selectDocument: (relativePath: string, locator?: SearchLocator | null) => Promise<void>;
  applyDocumentIndexStatus: (event: DocumentIndexEvent) => void;
  setIndexProgress: (progress: IndexProgress) => void;
  retryCurrentDocumentIndex: () => Promise<boolean>;
  clearDocumentCache: () => Promise<boolean>;
  setSearchQuery: (query: string) => void;
  runSearch: (query?: string) => Promise<void>;
  toggleTheme: () => void;
  setTheme: (theme: ReaderTheme) => void;
  setThemeSeries: (series: ThemeSeriesId) => void;
  updateReadingSettings: (settings: Partial<ReadingSettings>) => void;
  setMotionLevel: (level: ReaderMotionLevel) => void;
  setAnnotationTool: (tool: AnnotationToolPreference) => void;
  setHighlightColor: (color: AnnotationColorPreference) => void;
  setUnderlineColor: (color: AnnotationColorPreference) => void;
  setExcerptTone: (tone: AnnotationTone) => void;
  /** trim + ≤6 字符;空值回落该色默认名。 */
  setAnnotationColorName: (color: AnnotationColorPreference, name: string) => void;
  resetAnnotationColorNames: () => void;
  setFuzzyAnnotationAnchoring: (enabled: boolean) => void;
  setAllowRemoteImages: (enabled: boolean) => void;
  setShowHighlightCaret: (enabled: boolean) => void;
  setShowScrollMap: (enabled: boolean) => void;
  setFocusSpotlight: (enabled: boolean) => void;
  setTypewriterScroll: (enabled: boolean) => void;
  setReadingRuler: (enabled: boolean) => void;
  setAutoPaceEnabled: (enabled: boolean) => void;
  setAutoPaceBias: (bias: number) => void;
  setReadNextEnabled: (enabled: boolean) => void;
  setLibraryViewMode: (mode: LibraryViewMode) => void;
  setActiveView: (view: ReaderView) => void;
  setDailyGoalMinutes: (minutes: number) => void;
  setTtsRate: (rate: number) => void;
  setTtsVoiceName: (name: string | null) => void;
  setReviewCardMode: (mode: ReviewCardMode) => void;
  /** 更新当前文档的竖排开关并写入每文档记忆；无当前文档时忽略。 */
  setVerticalWriting: (enabled: boolean) => void;
  /** 跳转前记录出发点(捕获由 App 完成,见 plan-nav-history NH-D1)。 */
  recordNavLocation: (location: NavLocation) => void;
  /** 后退/前进:弹出目标并把当前位置压入对侧栈;返回 null 表示栈空。 */
  navBack: (current: NavLocation | null) => NavLocation | null;
  navForward: (current: NavLocation | null) => NavLocation | null;
  resetReaderPreferences: () => void;
  toggleDirectory: (path: string) => void;
  pinTreeNode: (parentPath: string, nodeKey: string) => void;
  unpinTreeNode: (parentPath: string, nodeKey: string) => void;
  moveTreeNode: (parentPath: string, nodeKey: string, toIndex: number) => void;
  resetFolderTreeLayout: (parentPath: string) => void;
  clearError: () => void;
}

let pendingOperations = 0;
let libraryRequest = 0;
// Only a successfully committed open changes the library context. Async
// document/search work captures this generation so a late response from the
// previous library cannot populate the newly opened one. Refreshes deliberately
// keep the generation: they should not cancel an otherwise valid read/search.
let activeLibraryGeneration = 0;
let documentRequest = 0;
let searchRequest = 0;

export const useReaderStore = create<ReaderState>()(
  persist(
    (set, get) => {
      const beginOperation = () => {
        pendingOperations += 1;
        set({ loading: true, error: null });
      };

      const endOperation = () => {
        pendingOperations = Math.max(0, pendingOperations - 1);
        set({ loading: pendingOperations > 0 });
      };

      const loadTreeLayout = (
        rootPath: string,
        tree: ReturnType<typeof buildDocumentTree>,
      ): LibraryTreeLayout => {
        const next = reconcileTreeLayout(readTreeLayout(rootPath), tree);
        writeTreeLayout(rootPath, next);
        return next;
      };

      const commitTreeLayout = (next: LibraryTreeLayout) => {
        const rootPath = get().snapshot?.rootPath;
        if (!rootPath) return;
        writeTreeLayout(rootPath, next);
        set({ treeLayout: next });
      };

      const openLibrary = async (rootPath: string) => {
        const trimmedPath = rootPath.trim();
        if (!trimmedPath) return;

        const request = ++libraryRequest;
        beginOperation();
        try {
          const snapshot = await openLibraryFromBackend(trimmedPath);
          if (request !== libraryRequest) return;
          const tree = buildDocumentTree(snapshot.documents);
          const expandedPaths = reconcileExpandedPaths(get().expandedPaths, tree);
          activeLibraryGeneration += 1;
          set({
            snapshot,
            documents: snapshot.documents,
            currentPath: null,
            currentContent: null,
            currentLocator: null,
            indexProgress: null,
            searchQuery: "",
            searchResults: [],
            expandedPaths,
            treeLayout: loadTreeLayout(snapshot.rootPath, tree),
            // 切换书库清空跳转历史:栈里的相对路径只对旧库有意义。
            navHistory: EMPTY_NAV_HISTORY,
            // 当前文档被清空,竖排镜像随之复位。
            verticalWriting: false,
          });
        } catch (error) {
          if (request !== libraryRequest) return;
          set({ error: errorMessage(error) });
        } finally {
          endOperation();
        }
      };

      return {
        snapshot: null,
        documents: [],
        currentPath: null,
        currentContent: null,
        currentLocator: null,
        indexProgress: null,
        searchQuery: "",
        searchResults: [],
        ...createDefaultReaderPreferences(preferredTheme()),
        annotationTool: "view",
        treeLayout: {},
        activeView: "reader",
        navHistory: EMPTY_NAV_HISTORY,
        verticalWriting: false,
        loading: false,
        error: null,

        chooseAndOpenLibrary: async () => {
          try {
            const rootPath = await chooseLibraryDirectory();
            if (rootPath) await openLibrary(rootPath);
          } catch (error) {
            set({ error: errorMessage(error) });
          }
        },

        openLibrary,

        refreshLibrary: async () => {
          const rootPath = get().snapshot?.rootPath;
          if (!rootPath) return;

          const request = ++libraryRequest;
          beginOperation();
          try {
            const snapshot = await refreshLibraryFromBackend(rootPath);
            if (request !== libraryRequest) return;
            const tree = buildDocumentTree(snapshot.documents);
            const currentPath = get().currentPath;
            const currentStillExists = snapshot.documents.some(
              (document) => document.relativePath === currentPath,
            );

            set({
              snapshot,
              documents: snapshot.documents,
              expandedPaths: reconcileExpandedPaths(get().expandedPaths, tree),
              treeLayout: loadTreeLayout(snapshot.rootPath, tree),
              ...(currentStillExists
                ? {}
                : {
                    currentPath: null,
                    currentContent: null,
                    currentLocator: null,
                    verticalWriting: false,
                  }),
            });
          } catch (error) {
            if (request !== libraryRequest) return;
            set({ error: errorMessage(error) });
          } finally {
            endOperation();
          }
        },

        selectDocument: async (relativePath: string, locator = null) => {
          const request = ++documentRequest;
          const libraryGeneration = activeLibraryGeneration;
          beginOperation();
          try {
            const content = await readDocument(relativePath);
            if (
              request === documentRequest &&
              libraryGeneration === activeLibraryGeneration
            ) {
              const rootPath = get().snapshot?.rootPath;
              set({
                currentPath: relativePath,
                currentContent: content,
                currentLocator: locator ? { ...locator } : null,
                // 竖排开关随文档切换从每文档记忆同步（VW-D1）。
                verticalWriting: rootPath
                  ? readVerticalPreference(rootPath, relativePath)
                  : false,
                // Opening a document always returns to the reading surface,
                // e.g. from the statistics ranking or search results.
                activeView: "reader",
              });
            }
          } catch (error) {
            if (
              request === documentRequest &&
              libraryGeneration === activeLibraryGeneration
            ) {
              set({ error: errorMessage(error) });
            }
          } finally {
            endOperation();
          }
        },

        applyDocumentIndexStatus: (event) => {
          set((state) => ({
            documents: state.documents.map((document) =>
              document.relativePath === event.relativePath
                ? { ...document, title: event.title, indexStatus: event.status, indexError: event.error }
                : document,
            ),
            currentContent:
              state.currentContent?.kind === "pdf" && state.currentContent.relativePath === event.relativePath
                ? { ...state.currentContent, indexStatus: event.status, indexError: event.error }
                : state.currentContent,
          }));
        },

        setIndexProgress: (indexProgress) => set({ indexProgress }),

        retryCurrentDocumentIndex: async () => {
          const relativePath = get().currentPath;
          if (!relativePath) return false;
          try {
            await retryDocumentIndex(relativePath);
            return true;
          } catch (error) {
            set({ error: errorMessage(error) });
            return false;
          }
        },

        clearDocumentCache: async () => {
          try {
            await clearConversionCache();
            set((state) => ({
              documents: state.documents.map((document) => ({
                ...document,
                indexStatus: "pending",
                indexError: null,
              })),
              currentContent: state.currentContent?.kind === "pdf"
                ? { ...state.currentContent, indexStatus: "pending", indexError: null }
                : state.currentContent,
              indexProgress: null,
            }));
            return true;
          } catch (error) {
            set({ error: errorMessage(error) });
            return false;
          }
        },

        setSearchQuery: (query: string) => {
          searchRequest += 1;
          set({
            searchQuery: query,
            ...(query.trim() ? {} : { searchResults: [] }),
          });
        },

        runSearch: async (query?: string) => {
          const nextQuery = query ?? get().searchQuery;
          const normalizedQuery = nextQuery.trim();
          if (query !== undefined) set({ searchQuery: query });

          const request = ++searchRequest;
          const libraryGeneration = activeLibraryGeneration;
          if (!normalizedQuery) {
            set({ searchResults: [] });
            return;
          }

          beginOperation();
          try {
            const searchResults = await searchDocuments(normalizedQuery, 100);
            if (
              request === searchRequest &&
              libraryGeneration === activeLibraryGeneration
            ) {
              set({ searchResults });
            }
          } catch (error) {
            if (
              request === searchRequest &&
              libraryGeneration === activeLibraryGeneration
            ) {
              set({ error: errorMessage(error) });
            }
          } finally {
            endOperation();
          }
        },

        toggleTheme: () => {
          set((state) => ({ theme: toggleThemeMode(state.theme) }));
        },

        setTheme: (theme) => {
          set({ theme: normalizeReaderTheme(theme, get().theme) });
        },

        setThemeSeries: (series) => {
          set((state) => {
            // Re-picking the current series must not clobber a manual
            // fontFamily override — only a real series switch applies presets.
            if (THEME_META[state.theme].series === series) return {};
            return {
              theme: setSeries(state.theme, series),
              // D4: theme-managed typography follows a real series switch.
              // Explicit curated/custom font choices remain theme-resistant.
              readingSettings:
                state.readingSettings.fontMode === "theme"
                  ? normalizeReadingSettings(
                      { fontFamily: SERIES_FONT_PRESET[series] },
                      state.readingSettings,
                    )
                  : state.readingSettings,
            };
          });
        },

        updateReadingSettings: (settings) => {
          set((state) => ({
            readingSettings: normalizeReadingSettings(settings, state.readingSettings),
          }));
        },

        setMotionLevel: (motionLevel) => {
          set((state) => ({
            motionLevel: normalizeMotionLevel(motionLevel, state.motionLevel),
          }));
        },

        setAnnotationTool: (tool) => {
          set({ annotationTool: normalizeAnnotationTool(tool) });
        },

        setHighlightColor: (color) => {
          const highlightColor = normalizeAnnotationColor(color);
          set({ highlightColor, excerptTone: legacyColorToTone(highlightColor) });
        },

        setUnderlineColor: (color) => {
          set({ underlineColor: normalizeAnnotationColor(color, "blue") });
        },

        setExcerptTone: (tone) => {
          const excerptTone = isAnnotationTone(tone) ? tone : "sand";
          set({ excerptTone, highlightColor: toneToLegacyColor(excerptTone) });
        },

        setAnnotationColorName: (color, name) => {
          const key = normalizeAnnotationColor(color);
          set((state) => ({
            annotationColorNames: {
              ...state.annotationColorNames,
              [key]: normalizeAnnotationColorName(key, name),
            },
          }));
        },

        resetAnnotationColorNames: () => {
          set({ annotationColorNames: { ...DEFAULT_ANNOTATION_COLOR_NAMES } });
        },

        setFuzzyAnnotationAnchoring: (enabled) => {
          set({ fuzzyAnnotationAnchoring: normalizeFuzzyAnnotationAnchoring(enabled) });
        },

        setAllowRemoteImages: (enabled) => {
          set({ allowRemoteImages: enabled === true });
        },

        setShowHighlightCaret: (enabled) => {
          set({ showHighlightCaret: enabled === true });
        },

        setShowScrollMap: (enabled) => {
          set({ showScrollMap: typeof enabled === "boolean" ? enabled : true });
        },

        setFocusSpotlight: (enabled) => {
          set({ focusSpotlight: enabled === true });
        },

        setTypewriterScroll: (enabled) => {
          set({ typewriterScroll: enabled === true });
        },

        setReadingRuler: (enabled) => {
          set({ readingRuler: enabled === true });
        },

        setAutoPaceEnabled: (enabled) => {
          set({ autoPaceEnabled: enabled === true });
        },

        setAutoPaceBias: (bias) => {
          set({ autoPaceBias: clampAutoPaceBias(bias) });
        },

        setReadNextEnabled: (enabled) => {
          set({ readNextEnabled: typeof enabled === "boolean" ? enabled : true });
        },

        setLibraryViewMode: (mode) => {
          set((state) => ({
            libraryViewMode: normalizeLibraryViewMode(mode, state.libraryViewMode),
          }));
        },

        setActiveView: (view) => {
          set({ activeView: READER_VIEWS.has(view) ? view : "reader" });
        },

        setDailyGoalMinutes: (minutes) => {
          set((state) => ({
            dailyGoalMinutes: normalizeDailyGoalMinutes(minutes, state.dailyGoalMinutes),
          }));
        },

        setTtsRate: (rate) => {
          set({ ttsRate: clampTtsRate(rate) });
        },

        setTtsVoiceName: (name) => {
          set({ ttsVoiceName: typeof name === "string" && name ? name : null });
        },

        setReviewCardMode: (mode) => {
          set((state) => ({
            reviewCardMode: normalizeReviewCardMode(mode, state.reviewCardMode),
          }));
        },

        setVerticalWriting: (enabled) => {
          const { snapshot, currentPath } = get();
          if (!snapshot?.rootPath || !currentPath) return;
          writeVerticalPreference(snapshot.rootPath, currentPath, enabled);
          set({ verticalWriting: enabled });
        },

        recordNavLocation: (location) => {
          set((state) => ({ navHistory: pushNavLocation(state.navHistory, location) }));
        },

        navBack: (current) => {
          const result = popNavBack(get().navHistory, current);
          if (!result) return null;
          set({ navHistory: result.history });
          return result.target;
        },

        navForward: (current) => {
          const result = popNavForward(get().navHistory, current);
          if (!result) return null;
          set({ navHistory: result.history });
          return result.target;
        },

        resetReaderPreferences: () => {
          set({
            ...createResettablePreferencePatch(),
            annotationTool: "view",
          });
        },

        toggleDirectory: (path: string) => {
          set((state) => ({
            expandedPaths: state.expandedPaths.includes(path)
              ? state.expandedPaths.filter((item) => item !== path)
              : [...state.expandedPaths, path],
          }));
        },

        pinTreeNode: (parentPath, nodeKey) => {
          const next = pinNode(get().treeLayout, parentPath, nodeKey);
          if (next !== get().treeLayout) commitTreeLayout(next);
        },

        unpinTreeNode: (parentPath, nodeKey) => {
          const siblings = findChildNodes(buildDocumentTree(get().documents), parentPath) ?? [];
          const next = unpinNode(get().treeLayout, parentPath, nodeKey, siblings);
          if (next !== get().treeLayout) commitTreeLayout(next);
        },

        moveTreeNode: (parentPath, nodeKey, toIndex) => {
          const siblings = findChildNodes(
            buildLaidOutDocumentTree(get().documents, get().treeLayout),
            parentPath,
          );
          if (!siblings) return;
          const next = moveSibling(get().treeLayout, parentPath, nodeKey, toIndex, siblings);
          if (next && next !== get().treeLayout) commitTreeLayout(next);
        },

        resetFolderTreeLayout: (parentPath) => {
          const next = resetFolderLayout(get().treeLayout, parentPath);
          if (next !== get().treeLayout) commitTreeLayout(next);
        },

        clearError: () => set({ error: null }),
      };
    },
    {
      name: READER_PREFERENCES_STORAGE_KEY,
      version: READER_PREFERENCES_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => pickPersistedPreferences(state),
      migrate: migrateReaderPreferences,
      merge: (persisted, current) => {
        const preferences = migrateReaderPreferences(
          persisted,
          READER_PREFERENCES_VERSION,
        );
        return {
          ...current,
          ...mergeReaderPreferences(preferences, current),
          // Always start a session in "view": persisting an armed
          // highlight/underline tool would turn any selection made right
          // after launch (even a copy gesture) into an annotation.
          annotationTool: "view",
        };
      },
    },
  ),
);
