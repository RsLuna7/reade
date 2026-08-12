import { describe, expect, it } from "vitest";
import {
  MAX_COLLECTION_ID_CHARS,
  MAX_COLLECTION_NAME_CHARS,
  sanitizeCollectionName,
  validateCollectionId,
  validateReorderedPaths,
} from "./collections";

describe("validateCollectionId", () => {
  it("accepts the annotation id alphabet up to 64 chars", () => {
    expect(validateCollectionId("col-1_A")).toBe("col-1_A");
    expect(validateCollectionId("x".repeat(MAX_COLLECTION_ID_CHARS))).toHaveLength(64);
    expect(validateCollectionId(crypto.randomUUID())).toBeTruthy();
  });

  it("rejects empty, oversized and out-of-alphabet ids", () => {
    expect(() => validateCollectionId("")).toThrow();
    expect(() => validateCollectionId("x".repeat(65))).toThrow();
    expect(() => validateCollectionId("bad id!")).toThrow();
    expect(() => validateCollectionId("路径")).toThrow();
  });
});

describe("sanitizeCollectionName", () => {
  it("trims and enforces the 100-char cap", () => {
    expect(sanitizeCollectionName("  考研数学  ")).toBe("考研数学");
    expect(sanitizeCollectionName("名".repeat(MAX_COLLECTION_NAME_CHARS))).toHaveLength(100);
  });

  it("rejects blank and oversized names", () => {
    expect(() => sanitizeCollectionName("")).toThrow();
    expect(() => sanitizeCollectionName("   ")).toThrow();
    expect(() => sanitizeCollectionName("名".repeat(101))).toThrow();
  });
});

describe("validateReorderedPaths", () => {
  const existing = ["a.md", "b.md", "c.md"];

  it("accepts an exact permutation", () => {
    expect(() => validateReorderedPaths(existing, ["c.md", "a.md", "b.md"])).not.toThrow();
  });

  it("rejects missing, extra, duplicated and substituted entries", () => {
    expect(() => validateReorderedPaths(existing, ["a.md", "b.md"])).toThrow();
    expect(() =>
      validateReorderedPaths(existing, ["a.md", "b.md", "c.md", "d.md"]),
    ).toThrow();
    expect(() => validateReorderedPaths(existing, ["a.md", "a.md", "b.md"])).toThrow();
    expect(() => validateReorderedPaths(existing, ["a.md", "b.md", "d.md"])).toThrow();
  });
});
