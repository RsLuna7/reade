// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  READING_POSITIONS_LIBRARY_LIMIT,
  READING_POSITIONS_STORAGE_KEY,
  READING_POSITIONS_VERSION,
  listLibraryReadingPositions,
  readReadingPosition,
  sanitizeReadingPosition,
  writeReadingPosition,
} from "./readingPositions";

const ROOT = "D:\\books";
const NOW = 1_755_000_000_000;

function seedRaw(value: unknown): void {
  localStorage.setItem(
    READING_POSITIONS_STORAGE_KEY,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("reading position round trips", () => {
  it("writes and reads a scroll position under the versioned envelope", () => {
    const stored = writeReadingPosition(ROOT, "guide.md", { kind: "scroll", scrollRatio: 0.42 }, NOW);
    expect(stored).toEqual({
      kind: "scroll",
      scrollRatio: 0.42,
      maxScrollRatio: 0.42,
      updatedAt: NOW,
    });
    expect(readReadingPosition(ROOT, "guide.md")).toEqual(stored);

    const raw = JSON.parse(localStorage.getItem(READING_POSITIONS_STORAGE_KEY) ?? "{}") as {
      version: number;
      libraries: Record<string, Record<string, unknown>>;
    };
    expect(raw.version).toBe(READING_POSITIONS_VERSION);
    expect(Object.keys(raw.libraries)).toEqual([ROOT]);
  });

  it("writes and reads a pdf position and keeps libraries isolated", () => {
    writeReadingPosition(ROOT, "paper.pdf", { kind: "pdf", page: 7, offsetRatio: 0.5 }, NOW);
    writeReadingPosition("E:\\other", "paper.pdf", { kind: "pdf", page: 2, offsetRatio: 0 }, NOW);

    expect(readReadingPosition(ROOT, "paper.pdf")).toMatchObject({ kind: "pdf", page: 7 });
    expect(readReadingPosition("E:\\other", "paper.pdf")).toMatchObject({ kind: "pdf", page: 2 });
    expect(readReadingPosition(ROOT, "missing.md")).toBeNull();
  });

  it("clamps slightly out-of-range write ratios instead of rejecting them", () => {
    const stored = writeReadingPosition(
      ROOT,
      "guide.md",
      { kind: "scroll", scrollRatio: 1.000001 },
      NOW,
    );
    expect(stored?.kind === "scroll" && stored.scrollRatio).toBe(1);
    const pdf = writeReadingPosition(
      ROOT,
      "paper.pdf",
      { kind: "pdf", page: 3.7, offsetRatio: -0.25 },
      NOW,
    );
    expect(pdf).toMatchObject({ kind: "pdf", page: 3, offsetRatio: 0 });
  });

  it("rejects unusable write input without touching storage", () => {
    expect(
      writeReadingPosition(ROOT, "guide.md", { kind: "scroll", scrollRatio: Number.NaN }, NOW),
    ).toBeNull();
    expect(
      writeReadingPosition(ROOT, "paper.pdf", { kind: "pdf", page: 0, offsetRatio: 0.5 }, NOW),
    ).toBeNull();
    expect(
      writeReadingPosition(
        ROOT,
        "guide.md",
        { kind: "heading" } as unknown as { kind: "scroll"; scrollRatio: number },
        NOW,
      ),
    ).toBeNull();
    expect(localStorage.getItem(READING_POSITIONS_STORAGE_KEY)).toBeNull();
  });
});

describe("monotonic high-water marks", () => {
  it("keeps maxScrollRatio at the furthest point when scrolling back up", () => {
    writeReadingPosition(ROOT, "guide.md", { kind: "scroll", scrollRatio: 0.8 }, NOW);
    const backUp = writeReadingPosition(
      ROOT,
      "guide.md",
      { kind: "scroll", scrollRatio: 0.3 },
      NOW + 1000,
    );
    expect(backUp).toEqual({
      kind: "scroll",
      scrollRatio: 0.3,
      maxScrollRatio: 0.8,
      updatedAt: NOW + 1000,
    });
  });

  it("keeps maxPage at the furthest page when paging back", () => {
    writeReadingPosition(ROOT, "paper.pdf", { kind: "pdf", page: 12, offsetRatio: 0.2 }, NOW);
    const backUp = writeReadingPosition(
      ROOT,
      "paper.pdf",
      { kind: "pdf", page: 4, offsetRatio: 0.9 },
      NOW + 1000,
    );
    expect(backUp).toEqual({
      kind: "pdf",
      page: 4,
      offsetRatio: 0.9,
      maxPage: 12,
      updatedAt: NOW + 1000,
    });
  });

  it("resets the high-water mark when the entry kind changes", () => {
    writeReadingPosition(ROOT, "swapped.md", { kind: "scroll", scrollRatio: 0.9 }, NOW);
    const asPdf = writeReadingPosition(
      ROOT,
      "swapped.md",
      { kind: "pdf", page: 2, offsetRatio: 0 },
      NOW + 1000,
    );
    expect(asPdf).toMatchObject({ kind: "pdf", page: 2, maxPage: 2 });
  });
});

describe("per-library LRU", () => {
  it("evicts the oldest entry by updatedAt when the 201st document lands", () => {
    for (let index = 0; index < READING_POSITIONS_LIBRARY_LIMIT; index += 1) {
      writeReadingPosition(
        ROOT,
        `doc-${index}.md`,
        { kind: "scroll", scrollRatio: 0.5 },
        NOW + index,
      );
    }
    // Refresh doc-0 so doc-1 becomes the oldest entry.
    writeReadingPosition(ROOT, "doc-0.md", { kind: "scroll", scrollRatio: 0.6 }, NOW + 10_000);
    writeReadingPosition(ROOT, "overflow.md", { kind: "scroll", scrollRatio: 0.1 }, NOW + 20_000);

    const entries = listLibraryReadingPositions(ROOT);
    expect(Object.keys(entries)).toHaveLength(READING_POSITIONS_LIBRARY_LIMIT);
    expect(entries["doc-1.md"]).toBeUndefined();
    expect(entries["doc-0.md"]).toBeDefined();
    expect(entries["overflow.md"]).toBeDefined();
  });

  it("keeps other libraries untouched by an eviction", () => {
    writeReadingPosition("E:\\other", "keep.md", { kind: "scroll", scrollRatio: 0.2 }, NOW - 99_999);
    for (let index = 0; index <= READING_POSITIONS_LIBRARY_LIMIT; index += 1) {
      writeReadingPosition(ROOT, `doc-${index}.md`, { kind: "scroll", scrollRatio: 0.5 }, NOW + index);
    }
    expect(readReadingPosition("E:\\other", "keep.md")).not.toBeNull();
  });
});

describe("defensive reads", () => {
  it("survives invalid JSON", () => {
    seedRaw("{not json");
    expect(readReadingPosition(ROOT, "guide.md")).toBeNull();
    // A follow-up write replaces the corrupt payload.
    writeReadingPosition(ROOT, "guide.md", { kind: "scroll", scrollRatio: 0.5 }, NOW);
    expect(readReadingPosition(ROOT, "guide.md")).not.toBeNull();
  });

  it("drops unknown envelope versions wholesale", () => {
    seedRaw({
      version: 99,
      libraries: { [ROOT]: { "guide.md": { kind: "scroll", scrollRatio: 0.5, maxScrollRatio: 0.5, updatedAt: NOW } } },
    });
    expect(readReadingPosition(ROOT, "guide.md")).toBeNull();
  });

  it("drops entries with out-of-range ratios, bad pages or unknown kinds", () => {
    seedRaw({
      version: READING_POSITIONS_VERSION,
      libraries: {
        [ROOT]: {
          "over.md": { kind: "scroll", scrollRatio: 1.4, maxScrollRatio: 1.4, updatedAt: NOW },
          "negative.md": { kind: "scroll", scrollRatio: -0.1, maxScrollRatio: 0.5, updatedAt: NOW },
          "nan.md": { kind: "scroll", scrollRatio: Number.NaN, maxScrollRatio: 0.5, updatedAt: NOW },
          "page-zero.pdf": { kind: "pdf", page: 0, offsetRatio: 0.5, maxPage: 3, updatedAt: NOW },
          "page-float.pdf": { kind: "pdf", page: 2.5, offsetRatio: 0.5, maxPage: 3, updatedAt: NOW },
          "mystery.md": { kind: "heading", headingId: "intro", updatedAt: NOW },
          "no-stamp.md": { kind: "scroll", scrollRatio: 0.5, maxScrollRatio: 0.5 },
          "good.md": { kind: "scroll", scrollRatio: 0.5, maxScrollRatio: 0.8, updatedAt: NOW },
        },
      },
    });
    expect(Object.keys(listLibraryReadingPositions(ROOT))).toEqual(["good.md"]);
  });

  it("repairs a high-water mark that fell below the current position", () => {
    expect(
      sanitizeReadingPosition({ kind: "scroll", scrollRatio: 0.7, maxScrollRatio: 0.2, updatedAt: NOW }),
    ).toMatchObject({ scrollRatio: 0.7, maxScrollRatio: 0.7 });
    expect(
      sanitizeReadingPosition({ kind: "pdf", page: 9, offsetRatio: 0, maxPage: 3, updatedAt: NOW }),
    ).toMatchObject({ page: 9, maxPage: 9 });
  });

  it("normalizes second-scale updatedAt to milliseconds (formatModified rule)", () => {
    const seconds = Math.floor(NOW / 1000);
    seedRaw({
      version: READING_POSITIONS_VERSION,
      libraries: {
        [ROOT]: {
          "legacy.md": { kind: "scroll", scrollRatio: 0.5, maxScrollRatio: 0.5, updatedAt: seconds },
        },
      },
    });
    expect(readReadingPosition(ROOT, "legacy.md")?.updatedAt).toBe(seconds * 1000);
    // Normalized stamps compare correctly against fresh millisecond writes,
    // so a hand-edited second-scale entry is not spuriously evicted as 1970.
    writeReadingPosition(ROOT, "fresh.md", { kind: "scroll", scrollRatio: 0.1 }, NOW + 5_000);
    const entries = listLibraryReadingPositions(ROOT);
    expect(entries["legacy.md"].updatedAt).toBeLessThan(entries["fresh.md"].updatedAt);
    expect(entries["legacy.md"].updatedAt).toBeGreaterThan(NOW - 1_000);
  });
});
