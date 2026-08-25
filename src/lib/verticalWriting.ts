/**
 * 竖排模式（实验档，plan-vertical-writing §8）。
 *
 * 每文档竖排开关的持久化与纯判定逻辑。localStorage 键
 * `reade-vertical-writing` 采用与 readingPositions 相同的版本信封 +
 * 按库分组 + 条目上限 LRU 治理形状；只存"开启"的文档，缺席即横排，
 * 所以条目形状只需要一个 LRU 时间戳。
 *
 * 存储内容全部按不可信输入处理：JSON 解析全程护栏，字段逐一校验，
 * 坏条目静默丢弃。
 */

import type { DocumentFormat } from "./backend";

export const VERTICAL_WRITING_STORAGE_KEY = "reade-vertical-writing";
export const VERTICAL_WRITING_VERSION = 1;
/** Per-library cap; the oldest entries by `updatedAt` are evicted first. */
export const VERTICAL_WRITING_LIBRARY_LIMIT = 200;

/** 竖排激活时显式禁用的功能清单（定稿矩阵 ⛔ 行，进设置提示与 USER_GUIDE）。 */
export const VERTICAL_DISABLED_FEATURES =
  "聚焦模式、文档地图、目录跟随高亮、阅读位置记忆、读完接着读";

type LibraryEntries = Record<string, { updatedAt: number }>;

interface VerticalEnvelope {
  version: number;
  libraries: Record<string, LibraryEntries>;
}

/**
 * 竖排开关对当前文档不可用的原因；null = 可用。
 * 范围定稿（VW-D1）：仅 Markdown/EPUB；PDF 版式由 canvas 决定，
 * mdx 收窄在实验面之外。
 */
export function verticalWritingUnavailableReason(
  format: DocumentFormat | null,
): string | null {
  if (format === null) return "打开文档后可用。";
  if (format === "markdown" || format === "epub") return null;
  if (format === "pdf") return "PDF 版式由页面画布决定，竖排不适用。";
  return "MDX 文档不在竖排实验范围内。";
}

/**
 * 竖排（RTL 横向滚动）下的阅读进度比例。Chromium 规范行为里
 * `scrollLeft ∈ [-max, 0]`，用绝对值兼容史遗的正值实现。
 */
export function verticalScrollRatio(scrollLeft: number, range: number): number {
  if (!Number.isFinite(scrollLeft) || !Number.isFinite(range) || range <= 0) return 0;
  return Math.min(1, Math.max(0, Math.abs(scrollLeft) / range));
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function loadEnvelope(): VerticalEnvelope {
  const empty: VerticalEnvelope = { version: VERTICAL_WRITING_VERSION, libraries: {} };
  const store = storage();
  if (!store) return empty;

  let parsed: unknown;
  try {
    const raw = store.getItem(VERTICAL_WRITING_STORAGE_KEY);
    if (!raw) return empty;
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const envelope = parsed as Partial<VerticalEnvelope>;
  if (envelope.version !== VERTICAL_WRITING_VERSION) return empty;
  if (!envelope.libraries || typeof envelope.libraries !== "object") return empty;

  const libraries: Record<string, LibraryEntries> = {};
  for (const [root, entries] of Object.entries(envelope.libraries)) {
    if (!entries || typeof entries !== "object") continue;
    const sanitized: LibraryEntries = {};
    for (const [path, entry] of Object.entries(entries)) {
      const updatedAt = (entry as { updatedAt?: unknown } | null)?.updatedAt;
      if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) {
        continue;
      }
      sanitized[path] = { updatedAt };
    }
    if (Object.keys(sanitized).length > 0) libraries[root] = sanitized;
  }
  return { version: VERTICAL_WRITING_VERSION, libraries };
}

function saveEnvelope(envelope: VerticalEnvelope): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(VERTICAL_WRITING_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Quota errors and private-mode restrictions lose only the preference.
  }
}

export function readVerticalPreference(libraryRoot: string, relativePath: string): boolean {
  if (!libraryRoot || !relativePath) return false;
  return loadEnvelope().libraries[libraryRoot]?.[relativePath] !== undefined;
}

function evictOverLimit(library: LibraryEntries, limit: number): void {
  const paths = Object.keys(library);
  if (paths.length <= limit) return;
  paths
    .sort((a, b) => library[a].updatedAt - library[b].updatedAt)
    .slice(0, paths.length - limit)
    .forEach((path) => delete library[path]);
}

/** 关闭即删除条目（缺席即横排），开启写入 LRU 时间戳。 */
export function writeVerticalPreference(
  libraryRoot: string,
  relativePath: string,
  enabled: boolean,
  now: number = Date.now(),
): void {
  if (!libraryRoot || !relativePath) return;
  const envelope = loadEnvelope();
  const library = envelope.libraries[libraryRoot] ?? {};
  if (enabled) {
    library[relativePath] = {
      updatedAt: typeof now === "number" && Number.isFinite(now) && now > 0 ? now : Date.now(),
    };
    evictOverLimit(library, VERTICAL_WRITING_LIBRARY_LIMIT);
    envelope.libraries[libraryRoot] = library;
  } else {
    delete library[relativePath];
    if (Object.keys(library).length === 0) {
      delete envelope.libraries[libraryRoot];
    } else {
      envelope.libraries[libraryRoot] = library;
    }
  }
  saveEnvelope(envelope);
}
