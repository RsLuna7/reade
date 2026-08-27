import { describe, expect, it } from "vitest";
import type { Annotation, DocumentInfo, ReadingSession } from "./backend";
import {
  buildReadingReport,
  clipSessionsToRange,
  monthReportRange,
  previousReportRange,
  previousYearReportRange,
  rangeActiveDays,
  yearReportRange,
  type ReportRange,
} from "./readingReport";

/** 2026-08-13 12:00 本地时间作为"现在"。 */
const NOW = new Date(2026, 7, 13, 12, 0, 0).getTime();

function session(
  id: string,
  startedAt: number,
  minutes: number,
  overrides: Partial<ReadingSession> = {},
): ReadingSession {
  return {
    id,
    relativePath: "docs/a.md",
    format: "markdown",
    title: "文档 A",
    startedAt,
    endedAt: startedAt + minutes * 60_000,
    activeSeconds: minutes * 60,
    ...overrides,
  };
}

function at(year: number, month: number, day: number, hour = 9, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0).getTime();
}

function mark(
  id: string,
  relativePath: string,
  createdAt: number,
  selectedText: string,
  overrides: Partial<Annotation> = {},
): Annotation {
  return {
    id,
    relativePath,
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText,
    title: null,
    locator: { kind: "markdown", quote: selectedText, prefix: "", suffix: "", headingId: null },
    sortIndex: "M|00000|00000000",
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

function doc(relativePath: string, title: string): DocumentInfo {
  return {
    relativePath,
    title,
    size: 1,
    modified: 1,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
  };
}

/** N 个不同活跃日的会话（默认落在 2026 年 8 月内）。 */
function activeDays(count: number, path = "docs/a.md"): ReadingSession[] {
  return Array.from({ length: count }, (_, index) =>
    session(`d${index}`, at(2026, 8, index + 1, 10), 30, { relativePath: path }),
  );
}

describe("report ranges", () => {
  it("builds calendar month / year / previous-year ranges", () => {
    const month = monthReportRange(NOW);
    expect(month).toMatchObject({ kind: "month", label: "2026年8月", fileLabel: "2026-08" });
    expect(month.startMs).toBe(at(2026, 8, 1, 0, 0));
    expect(month.endMs).toBe(at(2026, 9, 1, 0, 0));

    const year = yearReportRange(NOW);
    expect(year).toMatchObject({ kind: "year", label: "2026年", fileLabel: "2026" });
    expect(year.startMs).toBe(at(2026, 1, 1, 0, 0));
    expect(year.endMs).toBe(at(2027, 1, 1, 0, 0));

    expect(previousYearReportRange(NOW)).toMatchObject({ label: "2025年", fileLabel: "2025" });
  });

  it("shifts January's previous month across the year boundary", () => {
    const january = monthReportRange(at(2026, 1, 15));
    const previous = previousReportRange(january);
    expect(previous.label).toBe("2025年12月");
    expect(previous.startMs).toBe(at(2025, 12, 1, 0, 0));
    expect(previous.endMs).toBe(at(2026, 1, 1, 0, 0));
    expect(previousReportRange(yearReportRange(NOW)).label).toBe("2025年");
  });
});

describe("clipSessionsToRange", () => {
  const august: ReportRange = monthReportRange(NOW);

  it("keeps in-range sessions untouched and drops out-of-range ones", () => {
    const inside = session("in", at(2026, 8, 5), 20);
    const before = session("out", at(2026, 7, 5), 20);
    expect(clipSessionsToRange([inside, before], august)).toEqual([inside]);
  });

  it("splits a boundary-spanning session proportionally by wall-clock overlap", () => {
    // 7 月 31 日 23:30 → 8 月 1 日 00:30，一半时长落进 8 月。
    const spanning = session("span", new Date(2026, 6, 31, 23, 30).getTime(), 60);
    const [clipped] = clipSessionsToRange([spanning], august);
    expect(clipped.startedAt).toBe(august.startMs);
    expect(clipped.endedAt).toBe(spanning.endedAt);
    expect(clipped.activeSeconds).toBeCloseTo(1800, 5);
  });

  it("keeps zero-length sessions by their start instant", () => {
    const zero = { ...session("z", at(2026, 8, 3), 10), endedAt: at(2026, 8, 3) };
    expect(clipSessionsToRange([zero], august)).toHaveLength(1);
    const outside = { ...zero, startedAt: at(2026, 9, 3), endedAt: at(2026, 9, 3) };
    expect(clipSessionsToRange([outside], august)).toHaveLength(0);
  });
});

describe("buildReadingReport gate", () => {
  it("returns null below the 7-active-day threshold", () => {
    const range = monthReportRange(NOW);
    expect(
      buildReadingReport({ sessions: activeDays(6), annotations: [], documents: [], range }),
    ).toBeNull();
    expect(
      buildReadingReport({ sessions: activeDays(7), annotations: [], documents: [], range }),
    ).not.toBeNull();
    expect(rangeActiveDays(activeDays(6), range)).toBe(6);
  });

  it("returns null for an empty previous year", () => {
    expect(
      buildReadingReport({
        sessions: activeDays(10),
        annotations: [],
        documents: [],
        range: previousYearReportRange(NOW),
      }),
    ).toBeNull();
  });
});

describe("buildReadingReport metrics", () => {
  const range = monthReportRange(NOW);

  it("aggregates totals, streaks, documents and the busiest day inside the range", () => {
    const sessions = [
      // 8/1–8/3 连续三天 + 8/5–8/9 连续五天（最长连续 = 5）。
      ...[1, 2, 3, 5, 6, 7, 8, 9].map((day) =>
        session(`s${day}`, at(2026, 8, day, 21), 30),
      ),
      // 8/9 再加一段，成为最长单日（60 分钟）。
      session("extra", at(2026, 8, 9, 23), 30, { relativePath: "docs/b.pdf", format: "pdf" }),
      // 期外的会话不参与。
      session("july", at(2026, 7, 20), 500),
    ];
    const report = buildReadingReport({
      sessions,
      annotations: [],
      documents: [doc("docs/b.pdf", "书 B")],
      range,
    });
    expect(report).not.toBeNull();
    expect(report?.activeDays).toBe(8);
    expect(report?.totalSeconds).toBe(9 * 30 * 60);
    expect(report?.longestStreakDays).toBe(5);
    expect(report?.documentCount).toBe(2);
    expect(report?.longestDay).toEqual({ date: "2026-08-09", seconds: 3600 });
    // 峰值时段:21 点档累计 8 段 × 30 分钟,周几取其众数所在行。
    expect(report?.peakSlot?.hour).toBe(21);
    expect(report?.depthShares.map((share) => share.id)).toEqual([
      "glance",
      "sit",
      "immerse",
      "long",
    ]);
    expect(report?.depthShares.find((share) => share.id === "immerse")?.ratio).toBe(1);
    expect(report?.depthShares.find((share) => share.id === "immerse")?.seconds).toBe(9 * 30 * 60);
    expect(report?.topByTime[0]).toMatchObject({ relativePath: "docs/a.md", seconds: 8 * 1800 });
    expect(report?.topByTime[1]).toMatchObject({ title: "书 B" });
  });

  it("compares against the previous calendar window and handles the empty one", () => {
    const withPrevious = buildReadingReport({
      sessions: [
        ...activeDays(7),
        session("prev-1", at(2026, 7, 10), 105),
        session("prev-2", at(2026, 7, 11), 105),
      ],
      annotations: [],
      documents: [],
      range,
    });
    // 本期 7×30=210 分钟,上期 210 分钟 → 0%。
    expect(withPrevious?.totalDeltaPercent).toBe(0);

    const doubled = buildReadingReport({
      sessions: [...activeDays(7), session("prev", at(2026, 7, 10), 105)],
      annotations: [],
      documents: [],
      range,
    });
    expect(doubled?.totalDeltaPercent).toBe(100);

    const noPrevious = buildReadingReport({
      sessions: activeDays(7),
      annotations: [],
      documents: [],
      range,
    });
    expect(noPrevious?.totalDeltaPercent).toBeNull();
  });

  it("counts marks, ranks annotated documents with a deterministic tie-break", () => {
    const annotations = [
      mark("m1", "docs/b.md", at(2026, 8, 2), "短句一"),
      mark("m2", "docs/b.md", at(2026, 8, 3), "短句二"),
      mark("m3", "docs/a.md", at(2026, 8, 4), "短句三"),
      mark("m4", "docs/a.md", at(2026, 8, 5), "短句四"),
      mark("m5", "docs/c.md", at(2026, 8, 6), "短句五"),
      // 期外、书签、已删除、空摘录都不计。
      mark("out", "docs/c.md", at(2026, 7, 6), "期外"),
      mark("del", "docs/c.md", at(2026, 8, 6), "已删除", { deletedAt: at(2026, 8, 7) }),
      mark("bm", "docs/c.md", at(2026, 8, 6), "", { kind: "bookmark", selectedText: null }),
    ];
    const report = buildReadingReport({
      sessions: activeDays(7),
      annotations,
      documents: [doc("docs/a.md", "文档 A"), doc("docs/b.md", "文档 B")],
      range,
    });
    expect(report?.markCount).toBe(5);
    // a 与 b 各 2 条并列 → 路径升序决胜。
    expect(report?.topByMarks.map((entry) => entry.relativePath)).toEqual([
      "docs/a.md",
      "docs/b.md",
      "docs/c.md",
    ]);
    expect(report?.topByMarks[0].title).toBe("文档 A");
    expect(report?.topByMarks[2].title).toBe("c.md");
  });

  it("picks the longest excerpt as the quote, earlier creation wins ties", () => {
    const annotations = [
      mark("q1", "docs/a.md", at(2026, 8, 2), "  短的   摘录  "),
      mark("q2", "docs/a.md", at(2026, 8, 5), "晚创建的同长摘录"),
      mark("q3", "docs/a.md", at(2026, 8, 3), "早创建的同长摘录"),
    ];
    const report = buildReadingReport({
      sessions: activeDays(7),
      annotations,
      documents: [doc("docs/a.md", "文档 A")],
      range,
    });
    expect(report?.quote).toEqual({ text: "早创建的同长摘录", title: "文档 A" });

    const empty = buildReadingReport({
      sessions: activeDays(7),
      annotations: [],
      documents: [],
      range,
    });
    expect(empty?.quote).toBeNull();
  });
});
