import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  chooseLibraryDirectory,
  openLibrary as openLibraryFromBackend,
  readDocument,
  refreshLibrary as refreshLibraryFromBackend,
  searchDocuments,
  type DocumentContent,
  type DocumentInfo,
  type LibrarySnapshot,
  type SearchResult,
} from "../lib/backend";
import { buildDocumentTree, reconcileExpandedPaths } from "../lib/tree";

export type ReaderTheme = "light" | "dark";
export type ReaderFontFamily = "system" | "sans" | "serif";

export interface ReadingSettings {
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  paragraphSpacing: number;
  fontFamily: ReaderFontFamily;
}

export const DEFAULT_READING_SETTINGS: ReadingSettings = {
  fontSize: 17,
  lineHeight: 1.9,
  contentWidth: 820,
  paragraphSpacing: 1,
  fontFamily: "system",
};

export const READER_PREFERENCES_STORAGE_KEY = "reade-reader-preferences";

const FONT_FAMILIES = new Set<ReaderFontFamily>(["system", "sans", "serif"]);

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
    contentWidth: clamp(settings.contentWidth ?? current.contentWidth, 560, 1200),
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "发生了未知错误";
}

interface ReaderState {
  snapshot: LibrarySnapshot | null;
  documents: DocumentInfo[];
  currentPath: string | null;
  currentContent: DocumentContent | null;
  searchQuery: string;
  searchResults: SearchResult[];
  theme: ReaderTheme;
  readingSettings: ReadingSettings;
  expandedPaths: string[];
  loading: boolean;
  error: string | null;
  chooseAndOpenLibrary: () => Promise<void>;
  openLibrary: (rootPath: string) => Promise<void>;
  refreshLibrary: () => Promise<void>;
  selectDocument: (relativePath: string) => Promise<void>;
  setSearchQuery: (query: string) => void;
  runSearch: (query?: string) => Promise<void>;
  toggleTheme: () => void;
  updateReadingSettings: (settings: Partial<ReadingSettings>) => void;
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
        searchQuery: "",
        searchResults: [],
        theme: preferredTheme(),
        readingSettings: DEFAULT_READING_SETTINGS,
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
                : { currentPath: null, currentContent: null }),
            });
          } catch (error) {
            set({ error: errorMessage(error) });
          } finally {
            endOperation();
          }
        },

        selectDocument: async (relativePath: string) => {
          const request = ++documentRequest;
          beginOperation();
          try {
            const content = await readDocument(relativePath);
            if (request === documentRequest) {
              set({ currentPath: relativePath, currentContent: content });
            }
          } catch (error) {
            if (request === documentRequest) set({ error: errorMessage(error) });
          } finally {
            endOperation();
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
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        readingSettings: state.readingSettings,
        expandedPaths: state.expandedPaths,
      }),
      merge: (persisted, current) => {
        const preferences = persisted as Partial<ReaderState>;
        return {
          ...current,
          ...preferences,
          readingSettings: normalizeReadingSettings(
            preferences.readingSettings ?? {},
            current.readingSettings,
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
