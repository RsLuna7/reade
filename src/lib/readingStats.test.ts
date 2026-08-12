import { describe, expect, it } from "vitest";
import type { ReadingSession } from "./backend";
import {
  aggregateByDocument,
  aggregateByFormat,
  aggregateByHour,
  aggregateDaily,
  aggregateDayDocuments,
  buildDayTimeline,
  buildDocumentDetail,
  buildSummary,
  buildTrendSeries,
  calendarLevel,
  cumulativeSeries,
  fillDailyRange,
  formatDuration,
  isWeekendDay,
  localDayKey,
  weekdayHourMatrix,
} from "./readingStats";

let sequence = 0;

function session(overrides: Partial<ReadingSession>): ReadingSession {
  sequence += 1;
  return {
    id: `session-${sequence}`,
    relativePath: "notes/a.md",
    format: "markdown",
    title: "A",
    startedAt: local(2026, 8, 10, 9, 0),
    endedAt: local(2026, 8, 10, 9, 30),
    activeSeconds: 1_200,
    ...overrides,
  };
}

function local(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

describe("readingStats aggregation", () => {
  it("splits a session crossing local midnight proportionally between days", () => {
    const daily = aggregateDaily([
      session({
        startedAt: local(2026, 8, 10, 23, 0),
        endedAt: local(2026, 8, 11, 1, 0),
        activeSeconds: 3_600,
      }),
    ]);
    expect(daily).toEqual([
      { date: "2026-08-10", seconds: 1_800 },
      { date: "2026-08-11", seconds: 1_800 },
    ]);
  });

  it("assigns zero-span sessions to the day they happened", () => {
    const at = local(2026, 8, 10, 9, 0);
    const daily = aggregateDaily([
      session({ startedAt: at, endedAt: at, activeSeconds: 42 }),
    ]);
    expect(daily).toEqual([{ date: "2026-08-10", seconds: 42 }]);
  });

  it("splits hours proportionally across boundaries", () => {
    const hourly = aggregateByHour([
      session({
        startedAt: local(2026, 8, 10, 9, 30),
        endedAt: local(2026, 8, 10, 10, 30),
        activeSeconds: 600,
      }),
    ]);
    expect(hourly[9].seconds).toBe(300);
    expect(hourly[10].seconds).toBe(300);
    expect(hourly.reduce((sum, entry) => sum + entry.seconds, 0)).toBe(600);
  });

  it("ranks documents by total time and keeps the latest title", () => {
    const totals = aggregateByDocument([
      session({ relativePath: "a.md", title: "Old title", activeSeconds: 100, endedAt: local(2026, 8, 9, 10, 0) }),
      session({ relativePath: "a.md", title: "New title", activeSeconds: 200, endedAt: local(2026, 8, 10, 10, 0) }),
      session({ relativePath: "b.pdf", format: "pdf", title: "B", activeSeconds: 50 }),
    ]);
    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({
      relativePath: "a.md",
      title: "New title",
      seconds: 300,
      lastReadAt: local(2026, 8, 10, 10, 0),
    });
    expect(totals[1]).toMatchObject({ relativePath: "b.pdf", format: "pdf", seconds: 50 });
  });

  it("totals formats in descending order", () => {
    const totals = aggregateByFormat([
      session({ format: "markdown", activeSeconds: 30 }),
      session({ format: "pdf", activeSeconds: 100 }),
      session({ format: "markdown", activeSeconds: 20 }),
    ]);
    expect(totals).toEqual([
      { format: "pdf", seconds: 100 },
      { format: "markdown", seconds: 50 },
    ]);
  });

  it("builds today, rolling-week, and streak numbers", () => {
    const now = local(2026, 8, 12, 15, 0);
    const day = (offset: number, seconds: number) =>
      session({
        startedAt: local(2026, 8, 12 - offset, 9, 0),
        endedAt: local(2026, 8, 12 - offset, 10, 0),
        activeSeconds: seconds,
      });
    const summary = buildSummary(
      [
        day(0, 600),
        day(1, 300),
        day(2, 900),
        // Gap on 2026-08-09.
        day(4, 1_200),
        day(8, 500),
        session({
          relativePath: "b.pdf",
          startedAt: local(2026, 8, 12, 20, 0),
          endedAt: local(2026, 8, 12, 20, 10),
          activeSeconds: 600,
        }),
      ],
      now,
    );
    expect(summary.totalSeconds).toBe(4_100);
    expect(summary.todaySeconds).toBe(1_200);
    expect(summary.last7DaySeconds).toBe(3_600);
    expect(summary.documentCount).toBe(2);
    expect(summary.activeDays).toBe(5);
    expect(summary.currentStreakDays).toBe(3);
    expect(summary.longestStreakDays).toBe(3);
  });

  it("counts the current streak from yesterday when today has no reading", () => {
    const now = local(2026, 8, 12, 8, 0);
    const summary = buildSummary(
      [
        session({
          startedAt: local(2026, 8, 11, 9, 0),
          endedAt: local(2026, 8, 11, 10, 0),
          activeSeconds: 600,
        }),
        session({
          startedAt: local(2026, 8, 10, 9, 0),
          endedAt: local(2026, 8, 10, 10, 0),
          activeSeconds: 600,
        }),
      ],
      now,
    );
    expect(summary.todaySeconds).toBe(0);
    expect(summary.currentStreakDays).toBe(2);
  });

  it("fills calendar ranges with zero days", () => {
    const filled = fillDailyRange(
      [{ date: "2026-08-11", seconds: 120 }],
      local(2026, 8, 9),
      local(2026, 8, 12),
    );
    expect(filled).toEqual([
      { date: "2026-08-09", seconds: 0 },
      { date: "2026-08-10", seconds: 0 },
      { date: "2026-08-11", seconds: 120 },
      { date: "2026-08-12", seconds: 0 },
    ]);
  });

  it("maps seconds onto heatmap levels relative to the busiest day", () => {
    expect(calendarLevel(0, 3_600)).toBe(0);
    expect(calendarLevel(1, 3_600)).toBe(1);
    expect(calendarLevel(1_800, 3_600)).toBe(2);
    expect(calendarLevel(3_600, 3_600)).toBe(4);
    expect(calendarLevel(10, 0)).toBe(0);
  });

  it("formats durations for display", () => {
    expect(formatDuration(45)).toBe("45 秒");
    expect(formatDuration(150)).toBe("2 分钟");
    expect(formatDuration(3_600)).toBe("1 小时");
    expect(formatDuration(5_460)).toBe("1 小时 31 分");
  });

  it("derives stable local day keys", () => {
    expect(localDayKey(local(2026, 1, 5))).toBe("2026-01-05");
    expect(localDayKey(local(2026, 12, 31, 23, 59))).toBe("2026-12-31");
  });

  it("clips the day timeline at local midnight and keeps proportional seconds", () => {
    const crossing = session({
      startedAt: local(2026, 8, 10, 23, 0),
      endedAt: local(2026, 8, 11, 1, 0),
      activeSeconds: 3_600,
    });
    const sameDay = session({
      startedAt: local(2026, 8, 10, 9, 0),
      endedAt: local(2026, 8, 10, 9, 30),
      activeSeconds: 900,
    });

    const day1 = buildDayTimeline([crossing, sameDay], "2026-08-10");
    expect(day1).toHaveLength(2);
    expect(day1[0].startRatio).toBeCloseTo(9 / 24, 5);
    expect(day1[1].startRatio).toBeCloseTo(23 / 24, 5);
    expect(day1[1].endRatio).toBe(1);
    expect(day1[1].seconds).toBeCloseTo(1_800, 5);

    const day2 = buildDayTimeline([crossing, sameDay], "2026-08-11");
    expect(day2).toHaveLength(1);
    expect(day2[0].startRatio).toBe(0);
    expect(day2[0].endRatio).toBeCloseTo(1 / 24, 5);
    expect(day2[0].seconds).toBeCloseTo(1_800, 5);
  });

  it("aggregates per-document totals for a single day", () => {
    const totals = aggregateDayDocuments(
      [
        session({ relativePath: "a.md", activeSeconds: 600 }),
        session({
          relativePath: "b.pdf",
          format: "pdf",
          startedAt: local(2026, 8, 10, 14, 0),
          endedAt: local(2026, 8, 10, 15, 0),
          activeSeconds: 1_000,
        }),
        session({
          relativePath: "a.md",
          startedAt: local(2026, 8, 11, 9, 0),
          endedAt: local(2026, 8, 11, 9, 10),
          activeSeconds: 400,
        }),
      ],
      "2026-08-10",
    );
    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({ relativePath: "b.pdf", seconds: 1_000 });
    expect(totals[1]).toMatchObject({ relativePath: "a.md", seconds: 600 });
  });

  it("buckets the weekday-by-hour matrix with Monday-first rows", () => {
    // 2026-08-10 is a Monday.
    const matrix = weekdayHourMatrix([
      session({
        startedAt: local(2026, 8, 10, 9, 30),
        endedAt: local(2026, 8, 10, 10, 30),
        activeSeconds: 600,
      }),
      session({
        startedAt: local(2026, 8, 9, 21, 0), // Sunday
        endedAt: local(2026, 8, 9, 22, 0),
        activeSeconds: 240,
      }),
    ]);
    expect(matrix).toHaveLength(7);
    expect(matrix[0][9]).toBe(300);
    expect(matrix[0][10]).toBe(300);
    expect(matrix[6][21]).toBe(240);
    expect(matrix[3].every((seconds) => seconds === 0)).toBe(true);
  });

  it("builds a trend series with trailing averages and weekend flags", () => {
    const day = (offset: number, seconds: number) =>
      session({
        startedAt: local(2026, 8, 12 - offset, 9, 0),
        endedAt: local(2026, 8, 12 - offset, 10, 0),
        activeSeconds: seconds,
      });
    const series = buildTrendSeries(
      aggregateDaily([day(0, 700), day(1, 1_400)]),
      local(2026, 8, 12, 15, 0),
      7,
      7,
    );
    expect(series).toHaveLength(7);
    const last = series[series.length - 1];
    expect(last).toMatchObject({ date: "2026-08-12", seconds: 700, averageSeconds: 300 });
    // 2026-08-08 / 08-09 are Saturday and Sunday.
    expect(series.find((point) => point.date === "2026-08-08")?.weekend).toBe(true);
    expect(series.find((point) => point.date === "2026-08-09")?.weekend).toBe(true);
    expect(last.weekend).toBe(false);
    expect(isWeekendDay("2026-08-08")).toBe(true);
    expect(isWeekendDay("2026-08-12")).toBe(false);
  });

  it("accumulates the growth curve from the first active day", () => {
    const series = cumulativeSeries(
      [
        { date: "2026-08-09", seconds: 100 },
        { date: "2026-08-11", seconds: 50 },
      ],
      local(2026, 8, 12, 12, 0),
    );
    expect(series).toEqual([
      { date: "2026-08-09", cumulativeSeconds: 100 },
      { date: "2026-08-10", cumulativeSeconds: 100 },
      { date: "2026-08-11", cumulativeSeconds: 150 },
      { date: "2026-08-12", cumulativeSeconds: 150 },
    ]);
    expect(cumulativeSeries([], local(2026, 8, 12))).toEqual([]);
  });

  it("summarizes a single document with session averages", () => {
    const detail = buildDocumentDetail(
      [
        session({ relativePath: "a.md", title: "A", activeSeconds: 300 }),
        session({
          relativePath: "a.md",
          title: "A v2",
          startedAt: local(2026, 8, 11, 9, 0),
          endedAt: local(2026, 8, 11, 9, 30),
          activeSeconds: 900,
        }),
        session({ relativePath: "b.pdf", format: "pdf", activeSeconds: 60 }),
      ],
      "a.md",
      local(2026, 8, 12, 12, 0),
      7,
    );
    expect(detail).toMatchObject({
      relativePath: "a.md",
      title: "A v2",
      totalSeconds: 1_200,
      sessionCount: 2,
      averageSessionSeconds: 600,
    });
    expect(detail?.daily).toHaveLength(7);
    expect(detail?.daily.find((total) => total.date === "2026-08-11")?.seconds).toBe(900);
    expect(buildDocumentDetail([], "a.md", local(2026, 8, 12))).toBeNull();
  });
});
