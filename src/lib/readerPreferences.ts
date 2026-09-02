/**
 * Single source of truth for persisted reader preferences.
 *
 * The Zustand store still owns runtime state and setters; this module owns
 * defaults, persistence pick/merge/migrate, and the reset patch — so adding a
 * preference is one schema change instead of eight hand-maintained lists.
 */

import {
  DEFAULT_ANNOTATION_COLOR_NAMES,
  normalizeAnnotationColorNames,
} from "./annotations";
import type { AnnotationColor } from "./backend";
import {
  isAnnotationTone,
  legacyColorToTone,
  type AnnotationTone,
} from "./annotationModel";
import { AUTO_PACE_BIAS_DEFAULT, clampAutoPaceBias } from "./autoPace";
import { normalizeReviewCardMode, type ReviewCardMode } from "./clozeCard";
import type { ReaderMotionLevel } from "./motion";
import { clampTtsRate, TTS_DEFAULT_RATE } from "./ttsPlayer";
import {
  LEGACY_THEME_ID_MAP,
  normalizeReaderTheme,
  type ReaderTheme,
  isReaderTheme,
} from "./themes";
import {
  DEFAULT_CJK_READER_FONT_ID,
  DEFAULT_LATIN_READER_FONT_ID,
  DEFAULT_READER_FONT_PAIR_ID,
  normalizeReaderFontId,
  normalizeReaderFontMode,
  normalizeReaderFontPairId,
  type ReaderFontId,
  type ReaderFontMode,
  type ReaderFontPairId,
} from "./readerFonts";

export const READER_PREFERENCES_STORAGE_KEY = "reade-reader-preferences";
export const READER_PREFERENCES_VERSION = 5;

export type AnnotationColorPreference = "yellow" | "green" | "blue" | "pink";
export type LibraryViewMode = "tree" | "shelf";
export type ReaderFontFamily = "system" | "sans" | "serif";

export interface ReadingSettings {
  fontSize: number;
  lineHeight: number;
  /** Max article width in px. At CONTENT_WIDTH_MAX the measure is fluid (no cap). */
  contentWidth: number;
  paragraphSpacing: number;
  /** Theme-series font preset, retained for the existing reading style. */
  fontFamily: ReaderFontFamily;
  /** Desktop custom fonts are opt-in; theme preserves pre-integration behavior. */
  fontMode: ReaderFontMode;
  fontPairId: ReaderFontPairId;
  cjkFontId: ReaderFontId;
  latinFontId: ReaderFontId;
}

export const CONTENT_WIDTH_MIN = 560;
export const CONTENT_WIDTH_MAX = 1600;
export const MAX_DAILY_GOAL_MINUTES = 24 * 60;

export const DEFAULT_READING_SETTINGS: ReadingSettings = {
  fontSize: 17,
  lineHeight: 1.9,
  contentWidth: CONTENT_WIDTH_MAX,
  paragraphSpacing: 1,
  fontFamily: "system",
  fontMode: "theme",
  fontPairId: DEFAULT_READER_FONT_PAIR_ID,
  cjkFontId: DEFAULT_CJK_READER_FONT_ID,
  latinFontId: DEFAULT_LATIN_READER_FONT_ID,
};

const LIBRARY_VIEW_MODES = new Set<LibraryViewMode>(["tree", "shelf"]);
const ANNOTATION_COLORS = new Set<AnnotationColorPreference>([
  "yellow",
  "green",
  "blue",
  "pink",
]);
const FONT_FAMILIES = new Set<ReaderFontFamily>(["system", "sans", "serif"]);
const MOTION_LEVELS = new Set<ReaderMotionLevel>(["off", "subtle", "full"]);

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function getSystemMotionLevel(): ReaderMotionLevel {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "subtle";
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "off" : "subtle";
  } catch {
    return "subtle";
  }
}

export function normalizeLibraryViewMode(
  value: unknown,
  fallback: LibraryViewMode = "tree",
): LibraryViewMode {
  return typeof value === "string" && LIBRARY_VIEW_MODES.has(value as LibraryViewMode)
    ? (value as LibraryViewMode)
    : fallback;
}

export function normalizeMotionLevel(
  value: unknown,
  fallback: ReaderMotionLevel = getSystemMotionLevel(),
): ReaderMotionLevel {
  return typeof value === "string" && MOTION_LEVELS.has(value as ReaderMotionLevel)
    ? (value as ReaderMotionLevel)
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

export function normalizeFuzzyAnnotationAnchoring(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

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
    fontMode: normalizeReaderFontMode(settings.fontMode, current.fontMode),
    fontPairId: normalizeReaderFontPairId(settings.fontPairId, current.fontPairId),
    cjkFontId: normalizeReaderFontId(settings.cjkFontId, current.cjkFontId),
    latinFontId: normalizeReaderFontId(settings.latinFontId, current.latinFontId),
  };
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export interface ReaderPreferences {
  theme: ReaderTheme;
  readingSettings: ReadingSettings;
  motionLevel: ReaderMotionLevel;
  expandedPaths: string[];
  highlightColor: AnnotationColorPreference;
  underlineColor: AnnotationColorPreference;
  excerptTone: AnnotationTone;
  annotationColorNames: Record<AnnotationColor, string>;
  dailyGoalMinutes: number;
  fuzzyAnnotationAnchoring: boolean;
  allowRemoteImages: boolean;
  showHighlightCaret: boolean;
  showScrollMap: boolean;
  focusSpotlight: boolean;
  typewriterScroll: boolean;
  readingRuler: boolean;
  autoPaceEnabled: boolean;
  autoPaceBias: number;
  readNextEnabled: boolean;
  libraryViewMode: LibraryViewMode;
  ttsRate: number;
  ttsVoiceName: string | null;
  reviewCardMode: ReviewCardMode;
}

export function createDefaultReaderPreferences(
  theme: ReaderTheme = "paper-light",
): ReaderPreferences {
  return {
    theme,
    readingSettings: { ...DEFAULT_READING_SETTINGS },
    motionLevel: getSystemMotionLevel(),
    expandedPaths: [],
    highlightColor: "yellow",
    underlineColor: "blue",
    excerptTone: "sand",
    annotationColorNames: { ...DEFAULT_ANNOTATION_COLOR_NAMES },
    dailyGoalMinutes: 0,
    fuzzyAnnotationAnchoring: false,
    allowRemoteImages: false,
    showHighlightCaret: false,
    showScrollMap: true,
    focusSpotlight: false,
    typewriterScroll: false,
    readingRuler: false,
    autoPaceEnabled: false,
    autoPaceBias: AUTO_PACE_BIAS_DEFAULT,
    readNextEnabled: true,
    libraryViewMode: "tree",
    ttsRate: TTS_DEFAULT_RATE,
    ttsVoiceName: null,
    reviewCardMode: "excerpt",
  };
}

/**
 * Fields restored by settings "reset preferences".
 * Theme, library view, TTS, review mode, expanded paths, and daily goal stay.
 */
export function createResettablePreferencePatch(): Omit<
  ReaderPreferences,
  | "theme"
  | "expandedPaths"
  | "dailyGoalMinutes"
  | "libraryViewMode"
  | "ttsRate"
  | "ttsVoiceName"
  | "reviewCardMode"
> {
  const defaults = createDefaultReaderPreferences();
  return {
    readingSettings: { ...defaults.readingSettings },
    motionLevel: defaults.motionLevel,
    highlightColor: defaults.highlightColor,
    underlineColor: defaults.underlineColor,
    excerptTone: defaults.excerptTone,
    annotationColorNames: { ...defaults.annotationColorNames },
    fuzzyAnnotationAnchoring: defaults.fuzzyAnnotationAnchoring,
    allowRemoteImages: defaults.allowRemoteImages,
    showHighlightCaret: defaults.showHighlightCaret,
    showScrollMap: defaults.showScrollMap,
    focusSpotlight: defaults.focusSpotlight,
    typewriterScroll: defaults.typewriterScroll,
    readingRuler: defaults.readingRuler,
    autoPaceEnabled: defaults.autoPaceEnabled,
    autoPaceBias: defaults.autoPaceBias,
    readNextEnabled: defaults.readNextEnabled,
  };
}

export type PersistedReaderPreferences = Partial<ReaderPreferences>;

export function pickPersistedPreferences(state: ReaderPreferences): PersistedReaderPreferences {
  return {
    theme: state.theme,
    readingSettings: state.readingSettings,
    motionLevel: state.motionLevel,
    expandedPaths: state.expandedPaths,
    highlightColor: state.highlightColor,
    underlineColor: state.underlineColor,
    excerptTone: state.excerptTone,
    annotationColorNames: state.annotationColorNames,
    dailyGoalMinutes: state.dailyGoalMinutes,
    fuzzyAnnotationAnchoring: state.fuzzyAnnotationAnchoring,
    allowRemoteImages: state.allowRemoteImages,
    showHighlightCaret: state.showHighlightCaret,
    showScrollMap: state.showScrollMap,
    focusSpotlight: state.focusSpotlight,
    typewriterScroll: state.typewriterScroll,
    readingRuler: state.readingRuler,
    autoPaceEnabled: state.autoPaceEnabled,
    autoPaceBias: state.autoPaceBias,
    readNextEnabled: state.readNextEnabled,
    libraryViewMode: state.libraryViewMode,
    ttsRate: state.ttsRate,
    ttsVoiceName: state.ttsVoiceName,
    reviewCardMode: state.reviewCardMode,
  };
}

export function migrateReaderPreferences(
  persistedState: unknown,
  _version: number,
): PersistedReaderPreferences {
  if (!persistedState || typeof persistedState !== "object") return {};

  const state = persistedState as PersistedReaderPreferences;
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
    ...(Array.isArray(state.expandedPaths) ? { expandedPaths: state.expandedPaths } : {}),
    ...(MOTION_LEVELS.has(state.motionLevel as ReaderMotionLevel)
      ? { motionLevel: state.motionLevel as ReaderMotionLevel }
      : {}),
    ...(ANNOTATION_COLORS.has(state.highlightColor as AnnotationColorPreference)
      ? { highlightColor: state.highlightColor }
      : {}),
    ...(ANNOTATION_COLORS.has(state.underlineColor as AnnotationColorPreference)
      ? { underlineColor: state.underlineColor }
      : {}),
    ...(isAnnotationTone(state.excerptTone)
      ? { excerptTone: state.excerptTone }
      : ANNOTATION_COLORS.has(state.highlightColor as AnnotationColorPreference)
        ? { excerptTone: legacyColorToTone(state.highlightColor as AnnotationColorPreference) }
        : {}),
    ...(state.annotationColorNames && typeof state.annotationColorNames === "object"
      ? { annotationColorNames: normalizeAnnotationColorNames(state.annotationColorNames) }
      : {}),
    ...(typeof state.dailyGoalMinutes === "number"
      ? { dailyGoalMinutes: state.dailyGoalMinutes }
      : {}),
    ...(typeof state.fuzzyAnnotationAnchoring === "boolean"
      ? { fuzzyAnnotationAnchoring: state.fuzzyAnnotationAnchoring }
      : {}),
    ...(typeof state.allowRemoteImages === "boolean"
      ? { allowRemoteImages: state.allowRemoteImages }
      : {}),
    ...(typeof state.showHighlightCaret === "boolean"
      ? { showHighlightCaret: state.showHighlightCaret }
      : {}),
    ...(typeof state.showScrollMap === "boolean" ? { showScrollMap: state.showScrollMap } : {}),
    ...(typeof state.focusSpotlight === "boolean" ? { focusSpotlight: state.focusSpotlight } : {}),
    ...(typeof state.typewriterScroll === "boolean"
      ? { typewriterScroll: state.typewriterScroll }
      : {}),
    ...(typeof state.readingRuler === "boolean" ? { readingRuler: state.readingRuler } : {}),
    ...(typeof state.autoPaceEnabled === "boolean"
      ? { autoPaceEnabled: state.autoPaceEnabled }
      : {}),
    ...(typeof state.autoPaceBias === "number"
      ? { autoPaceBias: clampAutoPaceBias(state.autoPaceBias) }
      : {}),
    ...(typeof state.readNextEnabled === "boolean"
      ? { readNextEnabled: state.readNextEnabled }
      : {}),
    ...(typeof state.libraryViewMode === "string"
      ? { libraryViewMode: normalizeLibraryViewMode(state.libraryViewMode) }
      : {}),
    ...(typeof state.ttsRate === "number" ? { ttsRate: state.ttsRate } : {}),
    ...(typeof state.ttsVoiceName === "string" ? { ttsVoiceName: state.ttsVoiceName } : {}),
    ...(typeof state.reviewCardMode === "string"
      ? { reviewCardMode: normalizeReviewCardMode(state.reviewCardMode) }
      : {}),
  };
}

export function mergeReaderPreferences(
  preferences: PersistedReaderPreferences,
  current: ReaderPreferences,
): ReaderPreferences {
  return {
    theme: normalizeReaderTheme(preferences.theme, current.theme),
    readingSettings: normalizeReadingSettings(
      preferences.readingSettings ?? {},
      current.readingSettings,
    ),
    motionLevel: normalizeMotionLevel(preferences.motionLevel, current.motionLevel),
    highlightColor: normalizeAnnotationColor(
      preferences.highlightColor,
      current.highlightColor,
    ),
    underlineColor: normalizeAnnotationColor(
      preferences.underlineColor,
      current.underlineColor,
    ),
    excerptTone: isAnnotationTone(preferences.excerptTone)
      ? preferences.excerptTone
      : legacyColorToTone(
          normalizeAnnotationColor(preferences.highlightColor, current.highlightColor),
        ),
    annotationColorNames: normalizeAnnotationColorNames(preferences.annotationColorNames),
    expandedPaths: Array.isArray(preferences.expandedPaths)
      ? preferences.expandedPaths.filter((path): path is string => typeof path === "string")
      : current.expandedPaths,
    dailyGoalMinutes: normalizeDailyGoalMinutes(
      preferences.dailyGoalMinutes,
      current.dailyGoalMinutes,
    ),
    fuzzyAnnotationAnchoring: normalizeFuzzyAnnotationAnchoring(
      preferences.fuzzyAnnotationAnchoring,
      current.fuzzyAnnotationAnchoring,
    ),
    allowRemoteImages: normalizeBoolean(
      preferences.allowRemoteImages,
      current.allowRemoteImages,
    ),
    showHighlightCaret: normalizeBoolean(
      preferences.showHighlightCaret,
      current.showHighlightCaret,
    ),
    showScrollMap: normalizeBoolean(preferences.showScrollMap, current.showScrollMap),
    focusSpotlight: normalizeBoolean(preferences.focusSpotlight, current.focusSpotlight),
    typewriterScroll: normalizeBoolean(
      preferences.typewriterScroll,
      current.typewriterScroll,
    ),
    readingRuler: normalizeBoolean(preferences.readingRuler, current.readingRuler),
    autoPaceEnabled: normalizeBoolean(preferences.autoPaceEnabled, current.autoPaceEnabled),
    autoPaceBias:
      typeof preferences.autoPaceBias === "number"
        ? clampAutoPaceBias(preferences.autoPaceBias)
        : current.autoPaceBias,
    readNextEnabled: normalizeBoolean(preferences.readNextEnabled, current.readNextEnabled),
    libraryViewMode: normalizeLibraryViewMode(
      preferences.libraryViewMode,
      current.libraryViewMode,
    ),
    ttsRate:
      typeof preferences.ttsRate === "number"
        ? clampTtsRate(preferences.ttsRate)
        : current.ttsRate,
    ttsVoiceName:
      typeof preferences.ttsVoiceName === "string" && preferences.ttsVoiceName
        ? preferences.ttsVoiceName
        : current.ttsVoiceName,
    reviewCardMode: normalizeReviewCardMode(
      preferences.reviewCardMode,
      current.reviewCardMode,
    ),
  };
}
