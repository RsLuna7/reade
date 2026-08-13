import { describe, expect, it } from "vitest";
import type { Annotation, DocumentInfo, ReadingSession } from "./backend";
import { localDayKey } from "./readingStats";
import {
  ON_THIS_DAY_MIN_DOC_SECONDS,
  buildOnThisDay,
  onThisDayExcerpt,
  shiftMonthsClamped,
} from "./onThisDay";

// 固定本地时钟：2026-08-13 10:00（月份参数 0 起算）。
const NOW = new Date(2026, 7, 13, 10, 0, 0).getTime();
// 目标日：一年前 2025-08-13、一个月前 2026-07-13。
const YEAR_DAY = new Date(2025, 7, 13, 12, 0, 0).getTime();
const MONTH_DAY = new Date(2026, 6, 13, 12, 0, 0).getTime();

function doc(relativePath: string, title = relativePath): DocumentInfo {
  return {
    relativePath,
    title,
    size: 1024,
    modified: 1,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
  };
}

function annotation(
  id: string,
  relativePath: string,
  createdAt: number,
  overrides: Partial<Annotation> = {},
): Annotation {
  return {
    id,
    relativePath,
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: `摘录 ${id}`,
    title: null,
    locator: { kind: "markdown", quote: `摘录 ${id}`, prefix: "", suffix: "", headingId: null },
    sortIndex: "M|00000|00000000",
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

function session(
  relativePath: string,
  startedAt: number,
  activeSeconds: number,
): ReadingSession {
  return {
    id: `${relativePath}:${startedAt}`,
    relativePath,
    format: "markdown",
    title: null,
    startedAt,
    endedAt: startedAt + activeSeconds * 1000,
    activeSeconds,
  };
}

describe("shiftMonthsClamped (OD-D4)", () => {
  it("subtracts calendar months keeping the day of month", () => {
    expect(localDayKey(shiftMonthsClamped(NOW, -1).getTime())).toBe("2026-07-13");
    expect(localDayKey(shiftMonthsClamped(NOW, -12).getTime())).toBe("2025-08-13");
  });

  it("clamps month-end overflow instead of spilling into the next month", () => {
    const jan31 = new Date(2026, 0, 31, 9, 0, 0).getTime();
    expect(localDayKey(shiftMonthsClamped(jan31, -1).getTime())).toBe("2025-12-31");
    const mar31 = new Date(2026, 2, 31, 9, 0, 0).getTime();
    expect(localDayKey(shiftMonthsClamped(mar31, -1).getTime())).toBe("2026-02-28");
    // 闰年二月保留 29 日。
    const leapMar31 = new Date(2028, 2, 31, 9, 0, 0).getTime();
    expect(localDayKey(shiftMonthsClamped(leapMar31, -1).getTime())).toBe("2028-02-29");
  });

  it("maps a leap day one year back to Feb 28 (not a 365-day drift)", () => {
    const leapDay = new Date(2028, 1, 29, 9, 0, 0).getTime();
    expect(localDayKey(shiftMonthsClamped(leapDay, -12).getTime())).toBe("2027-02-28");
  });
});

describe("onThisDayExcerpt (OD-D7)", () => {
  it("collapses whitespace and truncates at 60 code points with an ellipsis", () => {
    expect(onThisDayExcerpt("  第一行\n\n第二行\t结尾  ")).toBe("第一行 第二行 结尾");
    const long = "字".repeat(80);
    const excerpt = onThisDayExcerpt(long);
    expect(excerpt).toBe(`${"字".repeat(60)}…`);
  });
});

describe("buildOnThisDay", () => {
  const documents = [doc("a.md", "文档甲"), doc("b.md", "文档乙"), doc("c.md", "文档丙")];

  it("returns [] when neither target day has any trace", () => {
    expect(
      buildOnThisDay({ annotations: [], sessions: [], documents, nowMs: NOW }),
    ).toEqual([]);
  });

  it("groups annotations by local calendar day, oldest first, capped at 3", () => {
    const annotations = [
      annotation("y-2", "a.md", YEAR_DAY + 2 * 60 * 60 * 1000),
      annotation("y-1", "a.md", YEAR_DAY),
      annotation("y-3", "b.md", YEAR_DAY + 3 * 60 * 60 * 1000),
      annotation("y-4", "b.md", YEAR_DAY + 4 * 60 * 60 * 1000),
      annotation("m-1", "c.md", MONTH_DAY),
    ];
    const groups = buildOnThisDay({ annotations, sessions: [], documents, nowMs: NOW });

    expect(groups.map((group) => group.key)).toEqual(["year", "month"]);
    expect(groups[0].label).toBe("一年前");
    expect(groups[0].dayKey).toBe("2025-08-13");
    // createdAt 升序 + 3 条封顶：y-4 被裁掉。
    expect(
      groups[0].entries.map((entry) => (entry.kind === "annotation" ? entry.annotation.id : "")),
    ).toEqual(["y-1", "y-2", "y-3"]);
    expect(groups[0].entries[0]).toMatchObject({ excerpt: "摘录 y-1", docTitle: "文档甲" });
    expect(groups[1]).toMatchObject({ key: "month", dayKey: "2026-07-13" });
  });

  it("honours the local day boundary at 23:59 vs 00:00", () => {
    const lastMinute = new Date(2025, 7, 13, 23, 59, 59).getTime();
    const nextMidnight = new Date(2025, 7, 14, 0, 0, 1).getTime();
    const groups = buildOnThisDay({
      annotations: [
        annotation("in", "a.md", lastMinute),
        annotation("out", "a.md", nextMidnight),
      ],
      sessions: [],
      documents,
      nowMs: NOW,
    });
    expect(groups).toHaveLength(1);
    expect(
      groups[0].entries.map((entry) => (entry.kind === "annotation" ? entry.annotation.id : "")),
    ).toEqual(["in"]);
  });

  it("skips tombstones, missing documents, bookmarks and blank excerpts", () => {
    const groups = buildOnThisDay({
      annotations: [
        annotation("tomb", "a.md", YEAR_DAY, { deletedAt: YEAR_DAY + 1000 }),
        annotation("gone", "removed.md", YEAR_DAY),
        annotation("mark", "a.md", YEAR_DAY, {
          kind: "bookmark",
          selectedText: null,
          locator: {
            kind: "bookmark",
            target: { format: "markdown", headingId: null, scrollRatio: 0.5 },
          },
        }),
        annotation("blank", "a.md", YEAR_DAY, { selectedText: "   " }),
      ],
      sessions: [],
      documents,
      nowMs: NOW,
    });
    expect(groups).toEqual([]);
  });

  it("fills the remaining slots with ≥300s documents, deduped against annotation rows", () => {
    const annotations = [annotation("y-1", "a.md", YEAR_DAY)];
    const sessions = [
      // a.md 已被标注条目占用，跳过。
      session("a.md", YEAR_DAY, 3600),
      session("b.md", YEAR_DAY + 60 * 60 * 1000, 900),
      // 低于 300s 门槛。
      session("c.md", YEAR_DAY + 2 * 60 * 60 * 1000, ON_THIS_DAY_MIN_DOC_SECONDS - 1),
    ];
    const groups = buildOnThisDay({ annotations, sessions, documents, nowMs: NOW });

    expect(groups).toHaveLength(1);
    expect(groups[0].entries).toHaveLength(2);
    expect(groups[0].entries[0]).toMatchObject({ kind: "annotation" });
    expect(groups[0].entries[1]).toMatchObject({
      kind: "document",
      relativePath: "b.md",
      title: "文档乙",
      activeSeconds: 900,
    });
  });

  it("keeps document fill within the target day even for sessions spanning midnight", () => {
    // 会话从目标日 23:00 跨到次日 01:00：只有前半段计入目标日。
    const start = new Date(2026, 6, 13, 23, 0, 0).getTime();
    const sessions = [
      {
        ...session("b.md", start, 7200),
        endedAt: start + 2 * 60 * 60 * 1000,
      },
    ];
    const groups = buildOnThisDay({ annotations: [], sessions, documents, nowMs: NOW });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("month");
    expect(groups[0].entries[0]).toMatchObject({
      kind: "document",
      relativePath: "b.md",
      activeSeconds: 3600,
    });
  });

  it("omits a group entirely when only the other target day has data", () => {
    const groups = buildOnThisDay({
      annotations: [annotation("m-1", "c.md", MONTH_DAY)],
      sessions: [],
      documents,
      nowMs: NOW,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("month");
  });
});
