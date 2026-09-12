// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadLibraryEnvelope,
  saveLibraryEnvelope,
  sanitizeEpochMs,
} from "./localEnvelope";
import { normalizeLibraryKey } from "./libraryKey";

const STORAGE_KEY = "reade-test-envelope";
const VERSION = 3;

function seed(value: unknown): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

function load(): { version: number; libraries: Record<string, number[]> } {
  return loadLibraryEnvelope<number[]>({
    storageKey: STORAGE_KEY,
    version: VERSION,
    sanitizeLibrary: (raw) => (Array.isArray(raw) ? (raw as number[]) : null),
    mergeLibrary: (existing, incoming) => [...existing, ...incoming],
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe("loadLibraryEnvelope", () => {
  it("re-keys raw spellings onto the normalized library identity", () => {
    seed({ version: VERSION, libraries: { "D:\\books": [1] } });
    expect(Object.keys(load().libraries)).toEqual([normalizeLibraryKey("D:\\books")]);
  });

  it("merges colliding spellings instead of dropping the earlier bucket", () => {
    seed({
      version: VERSION,
      libraries: { "D:\\books": [1], "d:/books/": [2], "//?/D:/books": [3] },
    });
    const libraries = load().libraries;
    expect(Object.keys(libraries)).toHaveLength(1);
    expect(libraries[normalizeLibraryKey("D:\\books")]).toEqual([1, 2, 3]);
  });

  it("drops malformed libraries, wrong versions, and unparsable payloads", () => {
    seed({ version: VERSION, libraries: { "D:\\a": "nope", "D:\\b": [7] } });
    expect(load().libraries).toEqual({ [normalizeLibraryKey("D:\\b")]: [7] });

    seed({ version: VERSION + 1, libraries: { "D:\\a": [1] } });
    expect(load().libraries).toEqual({});

    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(load()).toEqual({ version: VERSION, libraries: {} });
  });

  it("ignores blank library keys", () => {
    seed({ version: VERSION, libraries: { "  ": [1] } });
    expect(load().libraries).toEqual({});
  });

  it("treats prototype names as ordinary library keys", () => {
    // Regression guard: a plain `{}` map would route `__proto__` through the
    // prototype chain, silently dropping the entry and poisoning lookups.
    localStorage.setItem(
      STORAGE_KEY,
      `{"version":${VERSION},"libraries":{"__proto__":[1],"constructor":[2]}}`,
    );
    const libraries = load().libraries;
    expect(Object.keys(libraries).sort()).toEqual(["__proto__", "constructor"]);
    expect(libraries["__proto__"]).toEqual([1]);
    expect(libraries["constructor"]).toEqual([2]);
    expect(Object.getPrototypeOf(libraries)).toBeNull();
  });
});

describe("saveLibraryEnvelope", () => {
  it("reports whether the write landed so listeners are not notified spuriously", () => {
    expect(saveLibraryEnvelope(STORAGE_KEY, { version: VERSION, libraries: {} })).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ version: VERSION, libraries: {} }));
  });
});

describe("sanitizeEpochMs", () => {
  it("lifts plausible epoch seconds to milliseconds", () => {
    expect(sanitizeEpochMs(1_755_000_000)).toBe(1_755_000_000_000);
  });

  it("passes millisecond stamps through unchanged and is idempotent", () => {
    const ms = 1_755_000_000_000;
    expect(sanitizeEpochMs(ms)).toBe(ms);
    expect(sanitizeEpochMs(sanitizeEpochMs(ms))).toBe(ms);
  });

  it("leaves small synthetic stamps alone instead of inflating them per load", () => {
    // A blanket `< 10^10` rule would multiply this on every read, eventually
    // inverting LRU order and evicting the newest entries.
    const small = 1_500;
    expect(sanitizeEpochMs(small)).toBe(small);
    expect(sanitizeEpochMs(sanitizeEpochMs(small))).toBe(small);
  });

  it("rejects unusable values", () => {
    expect(sanitizeEpochMs(0)).toBeNull();
    expect(sanitizeEpochMs(-5)).toBeNull();
    expect(sanitizeEpochMs(Number.NaN)).toBeNull();
    expect(sanitizeEpochMs("1")).toBeNull();
    expect(sanitizeEpochMs(null)).toBeNull();
  });
});
