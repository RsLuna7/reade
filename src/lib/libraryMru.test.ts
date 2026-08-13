// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_LAST_LIBRARY_KEY,
  LIBRARY_MRU_LIMIT,
  LIBRARY_MRU_STORAGE_KEY,
  LIBRARY_MRU_VERSION,
  formatLastOpened,
  libraryTitleFromPath,
  migrateLibraryMru,
  normalizeLibraryPathKey,
  readLibraryMru,
  removeLibraryMru,
  upsertLibraryMru,
  type LibraryMruEntry,
} from "./libraryMru";

const NOW = 1_755_000_000_000;

function entry(path: string, overrides: Partial<LibraryMruEntry> = {}): LibraryMruEntry {
  return {
    path,
    title: libraryTitleFromPath(path),
    documentCount: 12,
    lastOpenedAt: NOW,
    ...overrides,
  };
}

function seedRaw(value: unknown): void {
  localStorage.setItem(
    LIBRARY_MRU_STORAGE_KEY,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("normalizeLibraryPathKey", () => {
  it("treats separator and case variants as the same library", () => {
    expect(normalizeLibraryPathKey("D:\\lib")).toBe(normalizeLibraryPathKey("d:/lib"));
    expect(normalizeLibraryPathKey("D:/LIB/")).toBe(normalizeLibraryPathKey("d:\\lib"));
    expect(normalizeLibraryPathKey("D:\\a\\b\\")).toBe(normalizeLibraryPathKey("D:/a/b"));
  });

  it("keeps genuinely different paths apart", () => {
    expect(normalizeLibraryPathKey("D:\\lib")).not.toBe(normalizeLibraryPathKey("D:\\lib2"));
    expect(normalizeLibraryPathKey("D:\\a\\b")).not.toBe(normalizeLibraryPathKey("D:\\a"));
  });
});

describe("upsert / remove round trips", () => {
  it("puts the newest entry first and persists the versioned envelope", () => {
    upsertLibraryMru(entry("D:\\books", { lastOpenedAt: NOW - 1000 }));
    const list = upsertLibraryMru(entry("E:\\notes"));

    expect(list.map((item) => item.path)).toEqual(["E:\\notes", "D:\\books"]);
    expect(readLibraryMru()).toEqual(list);

    const raw = JSON.parse(localStorage.getItem(LIBRARY_MRU_STORAGE_KEY) ?? "{}") as {
      version: number;
      entries: unknown[];
    };
    expect(raw.version).toBe(LIBRARY_MRU_VERSION);
    expect(raw.entries).toHaveLength(2);
  });

  it("dedupes case- and separator-insensitively, keeping the fresh entry", () => {
    upsertLibraryMru(entry("D:\\books", { documentCount: 3, lastOpenedAt: NOW - 5000 }));
    const list = upsertLibraryMru(entry("d:/books/", { documentCount: 9 }));

    expect(list).toHaveLength(1);
    // 展示保留最新一次打开的原始字符串与元信息。
    expect(list[0]).toMatchObject({ path: "d:/books/", documentCount: 9, lastOpenedAt: NOW });
  });

  it("caps the list at the MRU limit, evicting the oldest", () => {
    for (let index = 0; index < LIBRARY_MRU_LIMIT + 3; index += 1) {
      upsertLibraryMru(entry(`D:\\lib-${index}`, { lastOpenedAt: NOW + index }));
    }
    const list = readLibraryMru();
    expect(list).toHaveLength(LIBRARY_MRU_LIMIT);
    expect(list[0].path).toBe(`D:\\lib-${LIBRARY_MRU_LIMIT + 2}`);
    expect(list.some((item) => item.path === "D:\\lib-0")).toBe(false);
  });

  it("removes entries by any path spelling", () => {
    upsertLibraryMru(entry("D:\\books"));
    upsertLibraryMru(entry("E:\\notes"));

    const list = removeLibraryMru("d:/books");
    expect(list.map((item) => item.path)).toEqual(["E:\\notes"]);
    expect(readLibraryMru()).toEqual(list);
  });
});

describe("untrusted storage hygiene", () => {
  it("tolerates broken JSON and wrong envelope shapes", () => {
    seedRaw("{not json");
    expect(readLibraryMru()).toEqual([]);
    seedRaw({ version: 99, entries: [entry("D:\\books")] });
    expect(readLibraryMru()).toEqual([]);
    seedRaw({ version: LIBRARY_MRU_VERSION, entries: "nope" });
    expect(readLibraryMru()).toEqual([]);
  });

  it("drops invalid entries field by field and keeps valid ones", () => {
    seedRaw({
      version: LIBRARY_MRU_VERSION,
      entries: [
        { path: "", title: "空路径", documentCount: 1, lastOpenedAt: NOW },
        { path: "D:\\ok", title: "", documentCount: -3, lastOpenedAt: "later" },
        42,
        entry("E:\\fine"),
      ],
    });
    const list = readLibraryMru();
    expect(list).toHaveLength(2);
    // 坏字段回落:标题取路径末段,非法计数/时间归 null。
    expect(list[0]).toEqual({ path: "D:\\ok", title: "ok", documentCount: null, lastOpenedAt: null });
    expect(list[1].path).toBe("E:\\fine");
  });
});

describe("legacy last-library migration", () => {
  it("seeds the list once from the legacy key with unknown metadata", () => {
    localStorage.setItem(LEGACY_LAST_LIBRARY_KEY, "D:\\old-library");
    const list = migrateLibraryMru();
    expect(list).toEqual([
      { path: "D:\\old-library", title: "old-library", documentCount: null, lastOpenedAt: null },
    ]);
    // 旧键保留（双写过渡），播种结果已持久化。
    expect(localStorage.getItem(LEGACY_LAST_LIBRARY_KEY)).toBe("D:\\old-library");
    expect(readLibraryMru()).toEqual(list);
  });

  it("never overwrites an existing list and is a no-op without the key", () => {
    upsertLibraryMru(entry("E:\\current"));
    localStorage.setItem(LEGACY_LAST_LIBRARY_KEY, "D:\\old-library");
    expect(migrateLibraryMru().map((item) => item.path)).toEqual(["E:\\current"]);

    localStorage.clear();
    expect(migrateLibraryMru()).toEqual([]);
  });
});

describe("formatLastOpened", () => {
  it("buckets elapsed time into human-readable Chinese labels", () => {
    expect(formatLastOpened(NOW - 20_000, NOW)).toBe("刚刚");
    expect(formatLastOpened(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
    expect(formatLastOpened(NOW - 3 * 3_600_000, NOW)).toBe("3 小时前");
    expect(formatLastOpened(NOW - 6 * 86_400_000, NOW)).toBe("6 天前");
  });

  it("falls back to a concrete date beyond 30 days and null for unknown", () => {
    const old = new Date(2026, 0, 5).getTime();
    expect(formatLastOpened(old, old + 40 * 86_400_000)).toBe("2026年1月5日");
    expect(formatLastOpened(null, NOW)).toBeNull();
    expect(formatLastOpened(Number.NaN, NOW)).toBeNull();
  });
});
