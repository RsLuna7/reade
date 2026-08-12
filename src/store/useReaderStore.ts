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
import type { ReaderMotionLevel } from "../lib/motion";
import { clampTtsRate, TTS_DEFAULT_RATE } from "../lib/ttsPlayer";
import {
  LEGACY_THEME_ID_MAP,
  SERIES_FONT_PRESET,
  THEME_META,
  type ReaderTheme,
  type ThemeSeriesId,
  isReaderTheme,
  normalizeReaderTheme,
  setSeries,
  toggleThemeMode,
} from "../lib/themes";
import { buildDocumentTree, reconcileExpandedPaths } from "../lib/tree";

export type { ReaderMotionLevel } from "../lib/motion";
export type { ReaderTheme, ThemeSeriesId } from "../lib/themes";
export { THEME_IDS, THEME_META, THEME_SERIES, normalizeReaderTheme } from "../lib/themes";

export type ReaderFontFamily = "system" | "sans" | "serif";

export interface ReadingSettings {
  fontSize: number;
  lineHeight: number;
  /** Max article width in px. At CONTENT_WIDTH_MAX the measure is fluid (no cap). */
  contentWidth: number;
  paragraphSpacing: number;
  fontFamily: ReaderFontFamily;
}

export const CONTENT_WIDTH_MIN = 560;
export const CONTENT_WIDTH_MAX = 1600;

export const DEFAULT_READING_SETTINGS: ReadingSettings = {
  fontSize: 17,
  lineHeight: 1.9,
  contentWidth: CONTENT_WIDTH_MAX,
  paragraphSpacing: 1,
  fontFamily: "system",
};

export const READER_PREFERENCES_STORAGE_KEY = "reade-reader-preferences";
export const READER_PREFERENCES_VERSION = 4;

export type AnnotationToolPreference = "view" | "highlight" | "underline";
export type AnnotationColorPreference = "yellow" | "green" | "blue" | "pink";
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
const ANNOTATION_COLORS = new Set<AnnotationColorPreference>(["yellow", "green", "blue", "pink"]);

export function normalizeAnnotationTool(
  value: unknown,
  fallback: AnnotationToolPreference = "view",
): AnnotationToolPreference {
  return typeof value === "string" && ANNOTATION_TOOLS.has(value as AnnotationToolPreference)
    ? (value as AnnotationToolPreference)
    : fallback;
}

export function normalizeAnnotationColor(
  value: unknown,
  fallback: AnnotationColorPreference = "yellow",
): AnnotationColorPreference {
  return typeof value === "string" && ANNOTATION_COLORS.has(value as AnnotationColorPreference)
    ? (value as AnnotationColorPreference)
    : fallback;
}

const FONT_FAMILIES = new Set<ReaderFontFamily>(["system", "sans", "serif"]);
const MOTION_LEVELS = new Set<ReaderMotionLevel>(["off", "subtle", "full"]);
export const MAX_DAILY_GOAL_MINUTES = 24 * 60;

/**
 * Fuzzy annotation anchoring is opt-in (report Q2: a fuzzy hit has no score
 * floor and may land on similar-but-different text), so anything that is not
 * an explicit boolean collapses to the fallback.
 */
export function normalizeFuzzyAnnotationAnchoring(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

/** Daily reading goal in minutes; 0 disables the goal. */
export function normalizeDailyGoalMinutes(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(clamp(value, 0, MAX_DAILY_GOAL_MINUTES));
}

export function normalizeReadingSettings(
  settings: Partial<ReadingSettings>,
  current: ReadingSettings = DEFAULT_READING_SETTINGS,
): ReadingSettings {
  return {
    fontSize: clamp(settings.fontSize ?? current.fontSize, 13, 26),
    lineHeight: clamp(settings.lineHeight ?? current.lineHeight, 1.4, 2.4),
    contentWidth: clamp(
      settings.contentWidth ?? current.contentWidth,
      CONTENT_WIDTH_MIN,
      CONTENT_WIDTH_MAX,
    ),
    paragraphSpacing: clamp(
      settings.paragraphSpacing ?? current.paragraphSpacing,
      0.5,
      2,
    ),
    fontFamily:
      settings.fontFamily && FONT_FAMILIES.has(settings.fontFamily)
        ? settings.fontFamily
        : current.fontFamily,
  };
}

function preferredTheme(): ReaderTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "paper-light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "paper-dark"
    : "paper-light";
}

export function getSystemMotionLevel(): ReaderMotionLevel {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "subtle";
  }

  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "off"
      : "subtle";
  } catch {
    return "subtle";
  }
}

export const preferredMotionLevel = getSystemMotionLevel;

export function normalizeMotionLevel(
  value: unknown,
  fallback: ReaderMotionLevel = getSystemMotionLevel(),
): ReaderMotionLevel {
  return typeof value === "string" && MOTION_LEVELS.has(value as ReaderMotionLevel)
    ? (value as ReaderMotionLevel)
    : fallback;
}

type PersistedReaderPreferences = Partial<
  Pick<
    ReaderState,
    | "theme"
    | "readingSettings"
    | "expandedPaths"
    | "motionLevel"
    | "highlightColor"
    | "underlineColor"
    | "dailyGoalMinutes"
    | "fuzzyAnnotationAnchoring"
    | "ttsRate"
    | "ttsVoiceName"
  >
>;

export function migrateReaderPreferences(
  persistedState: unknown,
  _version: number,
): PersistedReaderPreferences {
  if (!persistedState || typeof persistedState !== "object") return {};

  const state = persistedState as PersistedReaderPreferences;
  // v3 → v4: single-word theme ids became `${series}-${mode}` (D2 one-time map).
  const rawTheme: unknown = state.theme;
  const theme =
    typeof rawTheme === "string" && rawTheme in LEGACY_THEME_ID_MAP
      ? LEGACY_THEME_ID_MAP[rawTheme]
      : rawTheme;
  return {
    ...(isReaderTheme(theme) ? { theme } : {}),
    ...(state.readingSettings && typeof state.readingSettings === "object"
      ? { readingSettings: state.readingSettings }
      : {}),
    ...(Array.isArray(state.expandedPaths)
      ? { expandedPaths: state.expandedPaths }
      : {}),
    ...(MOTION_LEVELS.has(state.motionLevel as ReaderMotionLevel)
      ? { motionLevel: state.motionLevel as ReaderMotionLevel }
      : {}),
    // annotationTool is deliberately not migrated: a leftover value from older
    // persisted data must not re-arm the annotation mode on launch.
    ...(ANNOTATION_COLORS.has(state.highlightColor as AnnotationColorPreference)
      ? { highlightColor: state.highlightColor }
      : {}),
    ...(ANNOTATION_COLORS.has(state.underlineColor as AnnotationColorPreference)
      ? { underlineColor: state.underlineColor }
      : {}),
    ...(typeof state.dailyGoalMinutes === "number"
      ? { dailyGoalMinutes: state.dailyGoalMinutes }
      : {}),
    ...(typeof state.fuzzyAnnotationAnchoring === "boolean"
      ? { fuzzyAnnotationAnchoring: state.fuzzyAnnotationAnchoring }
      : {}),
    ...(typeof state.ttsRate === "number" ? { ttsRate: state.ttsRate } : {}),
    ...(typeof state.ttsVoiceName === "string" ? { ttsVoiceName: state.ttsVoiceName } : {}),
  };
}

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
  /**
   * Global switch for the fuzzy last-resort anchoring step (§5.6 D). Off by
   * default: fuzzy may anchor a mark to similar but different text. Persisted.
   */
  fuzzyAnnotationAnchoring: boolean;
  expandedPaths: string[];
  /** Session-only; intentionally left out of the persisted preferences. */
  activeView: ReaderView;
  /** Daily reading goal in minutes; 0 disables the goal. Persisted. */
  dailyGoalMinutes: number;
  /** Read-aloud playback rate (0.5–2.0). Persisted. */
  ttsRate: number;
  /** Preferred read-aloud voice by name; null = auto pick. Persisted. */
  ttsVoiceName: string | null;
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
  setFuzzyAnnotationAnchoring: (enabled: boolean) => void;
  setActiveView: (view: ReaderView) => void;
  setDailyGoalMinutes: (minutes: number) => void;
  setTtsRate: (rate: number) => void;
  setTtsVoiceName: (name: string | null) => void;
  resetReaderPreferences: () => void;
  toggleDirectory: (path: string) => void;
  clearError: () => void;
}

let pendingOperations = 0;
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

      const openLibrary = async (rootPath: string) => {
        const trimmedPath = rootPath.trim();
        if (!trimmedPath) return;

        beginOperation();
        try {
          const snapshot = await openLibraryFromBackend(trimmedPath);
          const expandedPaths = reconcileExpandedPaths(
            get().expandedPaths,
            buildDocumentTree(snapshot.documents),
          );
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
          });
        } catch (error) {
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
        theme: preferredTheme(),
        readingSettings: DEFAULT_READING_SETTINGS,
        motionLevel: getSystemMotionLevel(),
        annotationTool: "view",
        highlightColor: "yellow",
        underlineColor: "blue",
        fuzzyAnnotationAnchoring: false,
        expandedPaths: [],
        activeView: "reader",
        dailyGoalMinutes: 0,
        ttsRate: TTS_DEFAULT_RATE,
        ttsVoiceName: null,
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

          beginOperation();
          try {
            const snapshot = await refreshLibraryFromBackend(rootPath);
            const tree = buildDocumentTree(snapshot.documents);
            const currentPath = get().currentPath;
            const currentStillExists = snapshot.documents.some(
              (document) => document.relativePath === currentPath,
            );

            set({
              snapshot,
              documents: snapshot.documents,
              expandedPaths: reconcileExpandedPaths(get().expandedPaths, tree),
              ...(currentStillExists
                ? {}
                : { currentPath: null, currentContent: null, currentLocator: null }),
            });
          } catch (error) {
            set({ error: errorMessage(error) });
          } finally {
            endOperation();
          }
        },

        selectDocument: async (relativePath: string, locator = null) => {
          const request = ++documentRequest;
          beginOperation();
          try {
            const content = await readDocument(relativePath);
            if (request === documentRequest) {
              set({
                currentPath: relativePath,
                currentContent: content,
                currentLocator: locator ? { ...locator } : null,
                // Opening a document always returns to the reading surface,
                // e.g. from the statistics ranking or search results.
                activeView: "reader",
              });
            }
          } catch (error) {
            if (request === documentRequest) set({ error: errorMessage(error) });
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
          if (!normalizedQuery) {
            set({ searchResults: [] });
            return;
          }

          beginOperation();
          try {
            const searchResults = await searchDocuments(normalizedQuery, 100);
            if (request === searchRequest) set({ searchResults });
          } catch (error) {
            if (request === searchRequest) set({ error: errorMessage(error) });
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
              // D4: the new series' typography preset lands with the switch;
              // manual overrides afterwards stick until the next series switch.
              readingSettings: normalizeReadingSettings(
                { fontFamily: SERIES_FONT_PRESET[series] },
                state.readingSettings,
              ),
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
          set({ highlightColor: normalizeAnnotationColor(color) });
        },

        setUnderlineColor: (color) => {
          set({ underlineColor: normalizeAnnotationColor(color, "blue") });
        },

        setFuzzyAnnotationAnchoring: (enabled) => {
          set({ fuzzyAnnotationAnchoring: normalizeFuzzyAnnotationAnchoring(enabled) });
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

        resetReaderPreferences: () => {
          set({
            readingSettings: { ...DEFAULT_READING_SETTINGS },
            motionLevel: getSystemMotionLevel(),
            annotationTool: "view",
            highlightColor: "yellow",
            underlineColor: "blue",
            fuzzyAnnotationAnchoring: false,
          });
        },

        toggleDirectory: (path: string) => {
          set((state) => ({
            expandedPaths: state.expandedPaths.includes(path)
              ? state.expandedPaths.filter((item) => item !== path)
              : [...state.expandedPaths, path],
          }));
        },

        clearError: () => set({ error: null }),
      };
    },
    {
      name: READER_PREFERENCES_STORAGE_KEY,
      version: READER_PREFERENCES_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        readingSettings: state.readingSettings,
        motionLevel: state.motionLevel,
        expandedPaths: state.expandedPaths,
        highlightColor: state.highlightColor,
        underlineColor: state.underlineColor,
        dailyGoalMinutes: state.dailyGoalMinutes,
        fuzzyAnnotationAnchoring: state.fuzzyAnnotationAnchoring,
        ttsRate: state.ttsRate,
        ttsVoiceName: state.ttsVoiceName,
      }),
      migrate: migrateReaderPreferences,
      merge: (persisted, current) => {
        const preferences = migrateReaderPreferences(
          persisted,
          READER_PREFERENCES_VERSION,
        );
        return {
          ...current,
          theme: normalizeReaderTheme(preferences.theme, current.theme),
          readingSettings: normalizeReadingSettings(
            preferences.readingSettings ?? {},
            current.readingSettings,
          ),
          motionLevel: normalizeMotionLevel(
            preferences.motionLevel,
            current.motionLevel,
          ),
          // Always start a session in "view": persisting an armed
          // highlight/underline tool would turn any selection made right
          // after launch (even a copy gesture) into an annotation.
          annotationTool: "view",
          highlightColor: normalizeAnnotationColor(
            preferences.highlightColor,
            current.highlightColor,
          ),
          underlineColor: normalizeAnnotationColor(
            preferences.underlineColor,
            current.underlineColor,
          ),
          expandedPaths: Array.isArray(preferences.expandedPaths)
            ? preferences.expandedPaths.filter(
                (path): path is string => typeof path === "string",
              )
            : current.expandedPaths,
          dailyGoalMinutes: normalizeDailyGoalMinutes(
            preferences.dailyGoalMinutes,
            current.dailyGoalMinutes,
          ),
          fuzzyAnnotationAnchoring: normalizeFuzzyAnnotationAnchoring(
            preferences.fuzzyAnnotationAnchoring,
            current.fuzzyAnnotationAnchoring,
          ),
          ttsRate:
            typeof preferences.ttsRate === "number"
              ? clampTtsRate(preferences.ttsRate)
              : current.ttsRate,
          ttsVoiceName:
            typeof preferences.ttsVoiceName === "string" && preferences.ttsVoiceName
              ? preferences.ttsVoiceName
              : current.ttsVoiceName,
        };
      },
    },
  ),
);
