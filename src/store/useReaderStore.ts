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
import { buildDocumentTree, reconcileExpandedPaths } from "../lib/tree";

export type { ReaderMotionLevel } from "../lib/motion";

export type ReaderTheme = "light" | "dark";
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
export const READER_PREFERENCES_VERSION = 2;

const FONT_FAMILIES = new Set<ReaderFontFamily>(["system", "sans", "serif"]);
const MOTION_LEVELS = new Set<ReaderMotionLevel>(["off", "subtle", "full"]);

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
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
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
  Pick<ReaderState, "theme" | "readingSettings" | "expandedPaths" | "motionLevel">
>;

export function migrateReaderPreferences(
  persistedState: unknown,
  _version: number,
): PersistedReaderPreferences {
  if (!persistedState || typeof persistedState !== "object") return {};

  const state = persistedState as PersistedReaderPreferences;
  return {
    ...(state.theme === "light" || state.theme === "dark"
      ? { theme: state.theme }
      : {}),
    ...(state.readingSettings && typeof state.readingSettings === "object"
      ? { readingSettings: state.readingSettings }
      : {}),
    ...(Array.isArray(state.expandedPaths)
      ? { expandedPaths: state.expandedPaths }
      : {}),
    ...(MOTION_LEVELS.has(state.motionLevel as ReaderMotionLevel)
      ? { motionLevel: state.motionLevel as ReaderMotionLevel }
      : {}),
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
  expandedPaths: string[];
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
  updateReadingSettings: (settings: Partial<ReadingSettings>) => void;
  setMotionLevel: (level: ReaderMotionLevel) => void;
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
        expandedPaths: [],
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
          set((state) => ({ theme: state.theme === "light" ? "dark" : "light" }));
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

        resetReaderPreferences: () => {
          set({
            readingSettings: { ...DEFAULT_READING_SETTINGS },
            motionLevel: getSystemMotionLevel(),
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
      }),
      migrate: migrateReaderPreferences,
      merge: (persisted, current) => {
        const preferences = migrateReaderPreferences(
          persisted,
          READER_PREFERENCES_VERSION,
        );
        return {
          ...current,
          theme:
            preferences.theme === "light" || preferences.theme === "dark"
              ? preferences.theme
              : current.theme,
          readingSettings: normalizeReadingSettings(
            preferences.readingSettings ?? {},
            current.readingSettings,
          ),
          motionLevel: normalizeMotionLevel(
            preferences.motionLevel,
            current.motionLevel,
          ),
          expandedPaths: Array.isArray(preferences.expandedPaths)
            ? preferences.expandedPaths.filter(
                (path): path is string => typeof path === "string",
              )
            : current.expandedPaths,
        };
      },
    },
  ),
);
