import { describe, expect, it } from "vitest";
import {
  DOCUMENT_FIND_MAX_MATCHES,
  findAllMatches,
  findMatchesInPdfPages,
  nextFindIndex,
  previousFindIndex,
} from "./documentFind";

describe("findAllMatches", () => {
  it("finds case-insensitive substring hits with UTF-16 offsets", () => {
    const { matches } = findAllMatches("Alpha beta ALPHA", "alpha");
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ start: 0, end: 5 });
    expect(matches[1]).toMatchObject({ start: 11, end: 16 });
  });

  it("returns empty for blank query", () => {
    expect(findAllMatches("hello", "  ").matches).toEqual([]);
  });

  it("reports truncation when capped", () => {
    const haystack = "aa".repeat(DOCUMENT_FIND_MAX_MATCHES + 5);
    const { matches, truncated } = findAllMatches(haystack, "a", {
      maxMatches: 3,
    });
    expect(matches).toHaveLength(3);
    expect(truncated).toBe(true);
  });
});

describe("findMatchesInPdfPages", () => {
  it("tags hits with page numbers and quote slices", () => {
    const { matches } = findMatchesInPdfPages(
      [
        { page: 1, markdown: "hello world", needsOcr: false },
        { page: 2, markdown: "hello again", needsOcr: false },
      ],
      "hello",
    );
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ pdfPage: 1, quote: "hello" });
    expect(matches[1]).toMatchObject({ pdfPage: 2, quote: "hello" });
  });

  it("skips OCR-only pages", () => {
    const { matches } = findMatchesInPdfPages(
      [{ page: 3, markdown: "", needsOcr: true }],
      "scan",
    );
    expect(matches).toEqual([]);
  });
});

describe("find index navigation", () => {
  it("wraps forward and backward", () => {
    expect(nextFindIndex(2, 5)).toBe(3);
    expect(nextFindIndex(4, 5)).toBe(0);
    expect(previousFindIndex(0, 5)).toBe(4);
    expect(previousFindIndex(-1, 5)).toBe(4);
  });
});
