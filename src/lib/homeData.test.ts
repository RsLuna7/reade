// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { DocumentInfo, ReadingSession } from "./backend";
import {
  CONTINUE_READING_WINDOW_MS,
  HOME_BASELINE_STORAGE_KEY,
  HOME_BASELINE_VERSION,
  buildContinueReading,
  buildFreshDocuments,
  buildWebContinueReading,
  hasContinueCandidates,
  normalizeModifiedMs,
  progressFromPosition,
  readHomeBaseline,
  writeHomeBaseline,
} from "./homeData";
import type { ReadingPosition } from "./readingPositions";

const NOW = 1_755_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

function doc(relativePath: string, overrides: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    relativePath,
    title: relativePath.replace(/\.[^.]+$/, ""),
    size: 1024,
    modified: NOW - HOUR_MS,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
    ...overrides,
  };
}

function session(
  relativePath: string,
  endedAt: number,
  overrides: Partial<ReadingSession> = {},
): ReadingSession {
  return {
    id: `${relativePath}:${endedAt}`,
    relativePath,
    format: "markdown",
    title: relativePath,
    startedAt: endedAt - 10 * 60 * 1000,
    endedAt,
    activeSeconds: 300,
    ...overrides,
  };
}

function scrollPosition(updatedAt: number, maxScrollRatio = 0.6): ReadingPosition {
  return { kind: "scroll", scrollRatio: 0.4, maxScrollRatio, updatedAt };
}

beforeEach(() => {
  localStorage.clear();
});

describe("buildContinueReading (desktop)", () => {
  it("aggregates recent sessions, newest last-read first, capped at the limit", () => {
    const documents = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"].map((path) => doc(path));
    const sessions = [
      session("a.md", NOW - 6 * HOUR_MS),
      session("a.md", NOW - 1 * HOUR_MS),
      session("b.md", NOW - 2 * HOUR_MS),
      session("c.md", NOW - 3 * HOUR_MS),
      session("d.md", NOW - 4 * HOUR_MS),
      session("e.md", NOW - 5 * HOUR_MS),
      session("f.md", NOW - 7 * HOUR_MS),
    ];
    const items = buildContinueReading(sessions, documents, {}, NOW);
    expect(items.map((item) => item.relativePath)).toEqual([
      "a.md",
      "b.md",
      "c.md",
      "d.md",
      "e.md",
    ]);
    // Two a.md sessions merge into one row with summed engaged time.
    expect(items[0].totalSeconds).toBe(600);
    expect(items[0].lastReadAt).toBe(NOW - 1 * HOUR_MS);
  });

  it("filters out documents that no longer exist in the library", () => {
    const sessions = [session("gone.md", NOW - HOUR_MS), session("kept.md", NOW - 2 * HOUR_MS)];
    const items = buildContinueReading(sessions, [doc("kept.md")], {}, NOW);
    expect(items.map((item) => item.relativePath)).toEqual(["kept.md"]);
  });

  it("applies the 30-day window boundary on session end times", () => {
    const boundary = NOW - CONTINUE_READING_WINDOW_MS;
    const sessions = [
      session("inside.md", boundary),
      session("outside.md", boundary - 1),
    ];
    const items = buildContinueReading(
      sessions,
      [doc("inside.md"), doc("outside.md")],
      {},
      NOW,
    );
    expect(items.map((item) => item.relativePath)).toEqual(["inside.md"]);
  });

  it("prefers the library title and attaches persisted progress", () => {
    const documents = [doc("a.md", { title: "重命名后的标题" }), doc("b.pdf", { format: "pdf" })];
    const positions: Record<string, ReadingPosition> = {
      "a.md": scrollPosition(NOW, 0.62),
      "b.pdf": { kind: "pdf", page: 3, offsetRatio: 0.5, maxPage: 9, updatedAt: NOW },
    };
    const items = buildContinueReading(
      [session("a.md", NOW - HOUR_MS, { title: "旧标题" }), session("b.pdf", NOW - 2 * HOUR_MS, { format: "pdf" })],
      documents,
      positions,
      NOW,
    );
    expect(items[0]).toMatchObject({
      title: "重命名后的标题",
      progress: { kind: "ratio", value: 0.62 },
    });
    expect(items[1]).toMatchObject({
      format: "pdf",
      progress: { kind: "page", page: 9 },
    });
  });

  it("returns an empty list for an empty library or empty history", () => {
    expect(buildContinueReading([], [doc("a.md")], {}, NOW)).toEqual([]);
    expect(buildContinueReading([session("a.md", NOW)], [], {}, NOW)).toEqual([]);
  });

  it("drops sessions recorded against another library even when the path exists", () => {
    const items = buildContinueReading(
      [
        session("a.md", NOW - HOUR_MS, { libraryRoot: "D:/other", title: "别的库" }),
        session("a.md", NOW - 2 * HOUR_MS, { libraryRoot: "D:/books", title: "当前库" }),
      ],
      [doc("a.md")],
      {},
      NOW,
      5,
      "D:/books",
    );
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("a");
    expect(items[0].lastReadAt).toBe(NOW - 2 * HOUR_MS);
  });

  it("keeps Windows verbatim-prefixed sessions in the current library", () => {
    const items = buildContinueReading(
      [session("a.md", NOW - HOUR_MS, { libraryRoot: "//?/D:/books", title: "机械设计" })],
      [doc("a.md", { title: "机械设计" })],
      {},
      NOW,
      5,
      "D:\\books",
    );
    expect(items).toHaveLength(1);
    expect(items[0].relativePath).toBe("a.md");
  });

  it("keeps Windows device-namespace sessions in the current library", () => {
    const items = buildContinueReading(
      [session("a.md", NOW - HOUR_MS, { libraryRoot: "\\\\.\\D:\\books" })],
      [doc("a.md")],
      {},
      NOW,
      5,
      "D:/books",
    );
    expect(items).toHaveLength(1);
    expect(items[0].relativePath).toBe("a.md");
  });
});

describe("buildWebContinueReading (web fallback)", () => {
  it("orders persisted positions by updatedAt and filters missing documents", () => {
    const documents = [doc("a.md"), doc("b.md")];
    const positions: Record<string, ReadingPosition> = {
      "a.md": scrollPosition(NOW - 2 * HOUR_MS),
      "b.md": scrollPosition(NOW - 1 * HOUR_MS),
      "gone.md": scrollPosition(NOW),
    };
    const items = buildWebContinueReading(documents, positions);
    expect(items.map((item) => item.relativePath)).toEqual(["b.md", "a.md"]);
    expect(items[0].totalSeconds).toBe(0);
    expect(items[0].lastReadAt).toBe(NOW - 1 * HOUR_MS);
  });

  it("caps the list at the limit", () => {
    const documents = Array.from({ length: 8 }, (_, index) => doc(`d${index}.md`));
    const positions = Object.fromEntries(
      documents.map((document, index) => [
        document.relativePath,
        scrollPosition(NOW - index * HOUR_MS),
      ]),
    );
    expect(buildWebContinueReading(documents, positions)).toHaveLength(5);
  });
});

describe("hasContinueCandidates (cold-start probe)", () => {
  it("detects candidates from positions or sessions still in the library", () => {
    const documents = [doc("a.md")];
    expect(hasContinueCandidates(documents, {}, [])).toBe(false);
    expect(hasContinueCandidates(documents, { "a.md": scrollPosition(NOW) }, [])).toBe(true);
    expect(hasContinueCandidates(documents, {}, [session("a.md", NOW)])).toBe(true);
    // Stale traces of removed documents do not count.
    expect(hasContinueCandidates(documents, { "gone.md": scrollPosition(NOW) }, [])).toBe(false);
    expect(hasContinueCandidates(documents, {}, [session("gone.md", NOW)])).toBe(false);
  });
});

describe("progressFromPosition", () => {
  it("maps scroll entries to ratios and pdf entries to the furthest page", () => {
    expect(progressFromPosition(scrollPosition(NOW, 0.8))).toEqual({ kind: "ratio", value: 0.8 });
    expect(
      progressFromPosition({ kind: "pdf", page: 2, offsetRatio: 0, maxPage: 7, updatedAt: NOW }),
    ).toEqual({ kind: "page", page: 7 });
    expect(progressFromPosition(null)).toBeNull();
  });
});

describe("buildFreshDocuments", () => {
  it("normalizes second- and millisecond-scale modified before comparing", () => {
    const baseline = NOW - 1 * HOUR_MS;
    const freshSeconds = Math.floor((NOW - 30 * 60 * 1000) / 1000);
    const staleSeconds = Math.floor((NOW - 2 * HOUR_MS) / 1000);
    const documents = [
      doc("fresh-ms.md", { modified: NOW - 10 * 60 * 1000 }),
      doc("fresh-s.md", { modified: freshSeconds }),
      doc("stale-ms.md", { modified: NOW - 3 * HOUR_MS }),
      doc("stale-s.md", { modified: staleSeconds }),
    ];
    const fresh = buildFreshDocuments(documents, baseline);
    expect(fresh.count).toBe(2);
    expect(fresh.items.map((item) => item.relativePath)).toEqual(["fresh-ms.md", "fresh-s.md"]);
  });

  it("reports nothing before the first visit establishes a baseline", () => {
    expect(buildFreshDocuments([doc("a.md", { modified: NOW })], null)).toEqual({
      count: 0,
      items: [],
    });
  });

  it("counts all matches but caps the display list", () => {
    const documents = Array.from({ length: 9 }, (_, index) =>
      doc(`n${index}.md`, { modified: NOW - index * 1000 }),
    );
    const fresh = buildFreshDocuments(documents, NOW - HOUR_MS);
    expect(fresh.count).toBe(9);
    expect(fresh.items).toHaveLength(5);
    expect(fresh.items[0].relativePath).toBe("n0.md");
  });

  it("clears the count once the baseline advances past the newest change", () => {
    const documents = [doc("a.md", { modified: NOW - 10_000 })];
    expect(buildFreshDocuments(documents, NOW - HOUR_MS).count).toBe(1);
    expect(buildFreshDocuments(documents, NOW).count).toBe(0);
  });

  it("treats non-finite modified values as never fresh", () => {
    expect(normalizeModifiedMs(Number.NaN)).toBe(0);
    expect(
      buildFreshDocuments([doc("bad.md", { modified: Number.NaN })], NOW - HOUR_MS).count,
    ).toBe(0);
  });
});

describe("home baseline storage", () => {
  it("round-trips per-library baselines under a version envelope", () => {
    expect(readHomeBaseline("D:\\books")).toBeNull();
    writeHomeBaseline("D:\\books", NOW);
    writeHomeBaseline("E:\\other", NOW - HOUR_MS);
    expect(readHomeBaseline("D:\\books")).toBe(NOW);
    expect(readHomeBaseline("E:\\other")).toBe(NOW - HOUR_MS);

    const raw = JSON.parse(localStorage.getItem(HOME_BASELINE_STORAGE_KEY) ?? "{}") as {
      version: number;
    };
    expect(raw.version).toBe(HOME_BASELINE_VERSION);
  });

  it("survives corrupt payloads and rejects unusable stamps", () => {
    localStorage.setItem(HOME_BASELINE_STORAGE_KEY, "{corrupt");
    expect(readHomeBaseline("D:\\books")).toBeNull();
    localStorage.setItem(
      HOME_BASELINE_STORAGE_KEY,
      JSON.stringify({ version: HOME_BASELINE_VERSION, libraries: { "D:\\books": "soon" } }),
    );
    expect(readHomeBaseline("D:\\books")).toBeNull();
    writeHomeBaseline("D:\\books", Number.NaN);
    expect(readHomeBaseline("D:\\books")).toBeNull();
  });
});
