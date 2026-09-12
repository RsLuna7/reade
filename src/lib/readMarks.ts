/**
 * 文档「已阅」标记（浏览偏好，不改磁盘、不改阅读进度）。
 *
 * localStorage `reade-read-marks` 存版本信封
 * `{ version: 1, libraries: { [libraryKey]: { [relativePath]: markedAtMs } } }`。
 * 书库键走 `normalizeLibraryPathKey`。存储一律视为不可信输入：坏条目静默丢弃。
 */

import { normalizeLibraryKey } from "./libraryKey";
import { loadLibraryEnvelope, saveLibraryEnvelope, sanitizeEpochMs } from "./localEnvelope";
import { normalizeRelativePath } from "./tree";

export const READ_MARKS_STORAGE_KEY = "reade-read-marks";
export const READ_MARKS_VERSION = 1;

/** 当前书库：相对路径 → 标记时间（Unix 毫秒）。 */
export type LibraryReadMarks = Record<string, number>;

interface MarksEnvelope {
  version: number;
  libraries: Record<string, LibraryReadMarks>;
}

function sanitizeRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = normalizeRelativePath(value);
  if (!path || path.split("/").includes("..")) return null;
  return path;
}

export function sanitizeLibraryReadMarks(value: unknown): LibraryReadMarks {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: LibraryReadMarks = {};
  for (const [rawPath, rawAt] of Object.entries(value as Record<string, unknown>)) {
    const path = sanitizeRelativePath(rawPath);
    const markedAt = sanitizeEpochMs(rawAt);
    if (!path || markedAt === null) continue;
    result[path] = markedAt;
  }
  return result;
}

function loadEnvelope(): MarksEnvelope {
  return loadLibraryEnvelope<LibraryReadMarks>({
    storageKey: READ_MARKS_STORAGE_KEY,
    version: READ_MARKS_VERSION,
    sanitizeLibrary: (raw) => {
      const sanitized = sanitizeLibraryReadMarks(raw);
      return Object.keys(sanitized).length > 0 ? sanitized : null;
    },
    // Equivalent spellings of one library union instead of overwriting;
    // the newest stamp per document wins.
    mergeLibrary: (existing, incoming) => {
      const merged: LibraryReadMarks = { ...existing };
      for (const [path, markedAt] of Object.entries(incoming)) {
        const current = merged[path];
        if (current === undefined || markedAt >= current) merged[path] = markedAt;
      }
      return merged;
    },
  });
}

function saveEnvelope(envelope: MarksEnvelope): void {
  saveLibraryEnvelope(READ_MARKS_STORAGE_KEY, envelope);
}

export function readReadMarks(libraryRoot: string): LibraryReadMarks {
  if (!libraryRoot.trim()) return {};
  return loadEnvelope().libraries[normalizeLibraryKey(libraryRoot)] ?? {};
}

export function writeReadMarks(libraryRoot: string, marks: LibraryReadMarks): void {
  if (!libraryRoot.trim()) return;
  const envelope = loadEnvelope();
  const libKey = normalizeLibraryKey(libraryRoot);
  const cleaned = sanitizeLibraryReadMarks(marks);
  if (Object.keys(cleaned).length === 0) delete envelope.libraries[libKey];
  else envelope.libraries[libKey] = cleaned;
  saveEnvelope(envelope);
}

export function isMarkedRead(marks: LibraryReadMarks, relativePath: string): boolean {
  const path = sanitizeRelativePath(relativePath);
  return Boolean(path && marks[path]);
}

export function reconcileReadMarks(
  marks: LibraryReadMarks,
  documents: ReadonlyArray<{ relativePath: string }>,
): LibraryReadMarks {
  const present = new Set(
    documents
      .map((document) => sanitizeRelativePath(document.relativePath))
      .filter((path): path is string => Boolean(path)),
  );
  const next: LibraryReadMarks = {};
  for (const [path, markedAt] of Object.entries(marks)) {
    if (present.has(path)) next[path] = markedAt;
  }
  return next;
}

export function markRead(
  marks: LibraryReadMarks,
  relativePath: string,
  now: number = Date.now(),
): LibraryReadMarks {
  const path = sanitizeRelativePath(relativePath);
  if (!path || typeof now !== "number" || !Number.isFinite(now) || now <= 0) return marks;
  if (path in marks) return marks;
  return { ...marks, [path]: now };
}

export function unmarkRead(marks: LibraryReadMarks, relativePath: string): LibraryReadMarks {
  const path = sanitizeRelativePath(relativePath);
  if (!path || !(path in marks)) return marks;
  const next = { ...marks };
  delete next[path];
  return next;
}
