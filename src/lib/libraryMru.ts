/**
 * 最近书库列表（plan-library-mru §3.1）。
 *
 * localStorage `reade-library-mru` 存版本信封
 * `{ version: 1, entries: LibraryMruEntry[] }`，上限 8 条、最近打开在前。
 * MRU 只是"路径备忘录"：打开动作始终走 `open_library` 的 canonicalize
 * 校验边界，这里不做任何文件系统访问。
 *
 * 存储内容一律视为不可信输入：JSON 解析全程防护、条目逐字段校验，
 * 坏条目静默丢弃（与 readingPositions 同一治理姿态）。
 */

export const LIBRARY_MRU_STORAGE_KEY = "reade-library-mru";
export const LIBRARY_MRU_VERSION = 1;
export const LIBRARY_MRU_LIMIT = 8;
/** 旧的单值"上次书库"键；迁移后保留双写过渡（App 仍在写）。 */
export const LEGACY_LAST_LIBRARY_KEY = "reade-last-library";

export interface LibraryMruEntry {
  /** 展示与打开都用原始字符串；比较用 normalizeLibraryPathKey。 */
  path: string;
  title: string;
  /** null = 未知（旧键迁移条目），UI 缺省不显示。 */
  documentCount: number | null;
  /** Unix 毫秒；null = 未知（旧键迁移条目）。 */
  lastOpenedAt: number | null;
}

interface MruEnvelope {
  version: number;
  entries: LibraryMruEntry[];
}

/**
 * Windows 语义的路径比较键：统一反斜杠、去尾分隔符、大小写不敏感。
 * `D:\lib`、`d:/lib/`、`D:/LIB` 视为同一书库；展示始终保留原字符串。
 */
export function normalizeLibraryPathKey(path: string): string {
  const unified = path.trim().replace(/\//g, "\\");
  const trimmed = unified.replace(/\\+$/, "");
  // 全分隔符字符串（如 "\\"）去尾后为空，回退原串避免空键碰撞。
  return (trimmed || unified).toLowerCase();
}

/** 书库标题 = 路径末段目录名（与 App 的 fileName 同规）。 */
export function libraryTitleFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function sanitizeEntry(value: unknown): LibraryMruEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.path !== "string" || !entry.path.trim()) return null;
  const documentCount =
    typeof entry.documentCount === "number" &&
    Number.isFinite(entry.documentCount) &&
    entry.documentCount >= 0
      ? Math.floor(entry.documentCount)
      : null;
  const lastOpenedAt =
    typeof entry.lastOpenedAt === "number" &&
    Number.isFinite(entry.lastOpenedAt) &&
    entry.lastOpenedAt > 0
      ? entry.lastOpenedAt
      : null;
  const title =
    typeof entry.title === "string" && entry.title.trim()
      ? entry.title
      : libraryTitleFromPath(entry.path);
  return { path: entry.path, title, documentCount, lastOpenedAt };
}

/** 归一键去重（保留首个，即最近的一条）并截断到上限。 */
function dedupeEntries(entries: LibraryMruEntry[]): LibraryMruEntry[] {
  const seen = new Set<string>();
  const result: LibraryMruEntry[] = [];
  for (const entry of entries) {
    const key = normalizeLibraryPathKey(entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
    if (result.length >= LIBRARY_MRU_LIMIT) break;
  }
  return result;
}

export function readLibraryMru(): LibraryMruEntry[] {
  try {
    const raw = localStorage.getItem(LIBRARY_MRU_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const envelope = parsed as Partial<MruEnvelope>;
    if (envelope.version !== LIBRARY_MRU_VERSION || !Array.isArray(envelope.entries)) {
      return [];
    }
    return dedupeEntries(
      envelope.entries
        .map(sanitizeEntry)
        .filter((entry): entry is LibraryMruEntry => entry !== null),
    );
  } catch {
    return [];
  }
}

function writeLibraryMru(entries: LibraryMruEntry[]): void {
  try {
    localStorage.setItem(
      LIBRARY_MRU_STORAGE_KEY,
      JSON.stringify({ version: LIBRARY_MRU_VERSION, entries }),
    );
  } catch {
    // 存储不可用（隐私模式/配额）只丢便利性，不影响打开书库本身。
  }
}

/** 打开成功后调用：置顶 + 去重 + 截断，返回写回后的列表。 */
export function upsertLibraryMru(entry: LibraryMruEntry): LibraryMruEntry[] {
  const sanitized = sanitizeEntry(entry);
  if (!sanitized) return readLibraryMru();
  const next = dedupeEntries([sanitized, ...readLibraryMru()]);
  writeLibraryMru(next);
  return next;
}

export function removeLibraryMru(path: string): LibraryMruEntry[] {
  const key = normalizeLibraryPathKey(path);
  const next = readLibraryMru().filter(
    (entry) => normalizeLibraryPathKey(entry.path) !== key,
  );
  writeLibraryMru(next);
  return next;
}

/**
 * 旧单值键 → MRU 播种（一次性：MRU 已有内容时不再动），返回当前列表。
 * 旧键保留不删：启动自动重开仍读它（双写过渡，见方案 §3.1）。
 */
export function migrateLibraryMru(): LibraryMruEntry[] {
  const current = readLibraryMru();
  if (current.length > 0) return current;
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_LAST_LIBRARY_KEY);
  } catch {
    return current;
  }
  if (!legacy || !legacy.trim()) return current;
  const seeded: LibraryMruEntry[] = [
    {
      path: legacy,
      title: libraryTitleFromPath(legacy),
      documentCount: null,
      lastOpenedAt: null,
    },
  ];
  writeLibraryMru(seeded);
  return seeded;
}

/** "刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期"；null 输入返回 null。 */
export function formatLastOpened(
  lastOpenedAt: number | null,
  now: number = Date.now(),
): string | null {
  if (lastOpenedAt === null || !Number.isFinite(lastOpenedAt) || lastOpenedAt <= 0) {
    return null;
  }
  const elapsed = now - lastOpenedAt;
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 30 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  const date = new Date(lastOpenedAt);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
