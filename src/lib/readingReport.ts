import type { Annotation, DocumentInfo, ReadingSession } from "./backend";
import {
  aggregateByDocument,
  aggregateBySessionDepth,
  aggregateDaily,
  sessionDocumentKey,
  weekdayHourMatrix,
  type SessionDepthId,
} from "./readingStats";

/**
 * 阅读报告数据聚合（docs/plan-reading-report-cards.md §3.1）——纯函数，
 * 不碰 DOM。范围为自然月/自然年；对比上期取上一个自然周期（RC 定稿），
 * 跨期界的会话按墙钟时间比例切分归属（与 aggregateDaily 同一语义）。
 */

export interface ReportRange {
  kind: "month" | "year";
  /** Unix ms，含。 */
  startMs: number;
  /** Unix ms，不含。 */
  endMs: number;
  /** 展示用：2026年8月 / 2026年。 */
  label: string;
  /** 文件名用：2026-08 / 2026。 */
  fileLabel: string;
}

/** RC-D4：活跃天数低于该门槛时不生成报告。 */
export const REPORT_MIN_ACTIVE_DAYS = 7;

function makeMonthRange(year: number, monthIndex: number): ReportRange {
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 1);
  return {
    kind: "month",
    startMs: start.getTime(),
    endMs: end.getTime(),
    label: `${start.getFullYear()}年${start.getMonth() + 1}月`,
    fileLabel: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
  };
}

function makeYearRange(year: number): ReportRange {
  return {
    kind: "year",
    startMs: new Date(year, 0, 1).getTime(),
    endMs: new Date(year + 1, 0, 1).getTime(),
    label: `${year}年`,
    fileLabel: String(year),
  };
}

/** 本月（本地日历）。 */
export function monthReportRange(nowMs: number): ReportRange {
  const now = new Date(nowMs);
  return makeMonthRange(now.getFullYear(), now.getMonth());
}

/** 今年（本地日历）。 */
export function yearReportRange(nowMs: number): ReportRange {
  return makeYearRange(new Date(nowMs).getFullYear());
}

/** 上一年（完整自然年）。 */
export function previousYearReportRange(nowMs: number): ReportRange {
  return makeYearRange(new Date(nowMs).getFullYear() - 1);
}

/** 对比基线：上一个自然月/自然年（1 月的上期落在上一年 12 月）。 */
export function previousReportRange(range: ReportRange): ReportRange {
  const start = new Date(range.startMs);
  if (range.kind === "month") {
    return makeMonthRange(start.getFullYear(), start.getMonth() - 1);
  }
  return makeYearRange(start.getFullYear() - 1);
}

/**
 * 把会话按墙钟重叠比例裁剪进 [startMs, endMs)：完全在期内的原样保留，
 * 跨界的按重叠时长折算 activeSeconds 并钳制起止；零时长会话按 startedAt
 * 归属。喂给 readingStats 的聚合族后，期内各指标口径一致。
 */
export function clipSessionsToRange(
  sessions: ReadingSession[],
  range: Pick<ReportRange, "startMs" | "endMs">,
): ReadingSession[] {
  const clipped: ReadingSession[] = [];
  for (const session of sessions) {
    if (session.activeSeconds <= 0) continue;
    const start = session.startedAt;
    const end = Math.max(session.endedAt, start);
    if (end <= start) {
      if (start >= range.startMs && start < range.endMs) clipped.push(session);
      continue;
    }
    const overlapStart = Math.max(start, range.startMs);
    const overlapEnd = Math.min(end, range.endMs);
    if (overlapEnd <= overlapStart) continue;
    if (overlapStart === start && overlapEnd === end) {
      clipped.push(session);
      continue;
    }
    clipped.push({
      ...session,
      startedAt: overlapStart,
      endedAt: overlapEnd,
      activeSeconds: (session.activeSeconds * (overlapEnd - overlapStart)) / (end - start),
    });
  }
  return clipped;
}

/** 入口按档禁用的轻量探测（不做完整聚合）。 */
export function rangeActiveDays(
  sessions: ReadingSession[],
  range: Pick<ReportRange, "startMs" | "endMs">,
): number {
  return aggregateDaily(clipSessionsToRange(sessions, range)).length;
}

export interface ReportDocumentTime {
  relativePath: string;
  title: string;
  seconds: number;
}

export interface ReportDocumentMarks {
  relativePath: string;
  title: string;
  count: number;
}

export interface ReportDepthShare {
  id: SessionDepthId;
  seconds: number;
  /** 0..1，占期内总时长比例。 */
  ratio: number;
}

export interface ReadingReportData {
  range: ReportRange;
  totalSeconds: number;
  activeDays: number;
  longestStreakDays: number;
  documentCount: number;
  /** 期内创建的高亮/下划线条数。 */
  markCount: number;
  /** 较上一自然周期的变化百分比（四舍五入整数）；上期无记录为 null。 */
  totalDeltaPercent: number | null;
  /** 最常阅读时段；weekday 0 = 周一（与 weekdayHourMatrix 行序一致）。 */
  peakSlot: { weekday: number; hour: number; seconds: number } | null;
  /** 期内读得最多的一天。 */
  longestDay: { date: string; seconds: number } | null;
  depthShares: ReportDepthShare[];
  /** 读得最久 Top3。 */
  topByTime: ReportDocumentTime[];
  /** 划线最多 Top3。 */
  topByMarks: ReportDocumentMarks[];
  /** 期内最长摘录（无标注时为 null，金句卡缺席）。 */
  quote: { text: string; title: string } | null;
}

function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function previousDayKey(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  date.setDate(date.getDate() - 1);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 期内是活跃标注、且属于摘录类（高亮/下划线带文本）。 */
function isMarkInRange(annotation: Annotation, range: ReportRange): boolean {
  if (annotation.deletedAt != null) return false;
  if (annotation.kind !== "highlight" && annotation.kind !== "underline") return false;
  if (!annotation.selectedText?.trim()) return false;
  return annotation.createdAt >= range.startMs && annotation.createdAt < range.endMs;
}

export interface BuildReadingReportInput {
  sessions: ReadingSession[];
  annotations: Annotation[];
  documents: DocumentInfo[];
  range: ReportRange;
  /** 测试可降低门槛；默认 REPORT_MIN_ACTIVE_DAYS。 */
  minActiveDays?: number;
}

/**
 * 聚合一期的报告指标；活跃天数不足门槛返回 null（RC-D4）。
 * 全部指标基于裁剪进期内的会话与期内创建的标注。
 */
export function buildReadingReport(input: BuildReadingReportInput): ReadingReportData | null {
  const { range } = input;
  const minActiveDays = input.minActiveDays ?? REPORT_MIN_ACTIVE_DAYS;
  const clipped = clipSessionsToRange(input.sessions, range);
  const daily = aggregateDaily(clipped);
  if (daily.length < minActiveDays) return null;

  const titleOf = new Map(
    input.documents.map((document) => [document.relativePath, document.title]),
  );
  const resolveTitle = (relativePath: string, fallback: string | null): string =>
    titleOf.get(relativePath) ?? fallback ?? fileName(relativePath);

  const totalSeconds = daily.reduce((sum, day) => sum + day.seconds, 0);

  // 期内最长连续（与 buildSummary 的 longestStreak 同算法，作用域限定在期内）。
  let longestStreakDays = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of daily) {
    run = previous !== null && previousDayKey(day.date) === previous ? run + 1 : 1;
    longestStreakDays = Math.max(longestStreakDays, run);
    previous = day.date;
  }

  const longestDay = daily.reduce<{ date: string; seconds: number } | null>(
    (best, day) => (best === null || day.seconds > best.seconds ? day : best),
    null,
  );

  const matrix = weekdayHourMatrix(clipped);
  let peakSlot: ReadingReportData["peakSlot"] = null;
  matrix.forEach((row, weekday) => {
    row.forEach((seconds, hour) => {
      if (seconds > 0 && (peakSlot === null || seconds > peakSlot.seconds)) {
        peakSlot = { weekday, hour, seconds };
      }
    });
  });

  const depthTotals = aggregateBySessionDepth(clipped);
  const depthTotalSeconds = depthTotals.reduce((sum, entry) => sum + entry.seconds, 0);
  const depthShares = depthTotals.map((entry) => ({
    id: entry.id,
    seconds: Math.round(entry.seconds),
    ratio: depthTotalSeconds > 0 ? entry.seconds / depthTotalSeconds : 0,
  }));

  const documentTotals = aggregateByDocument(clipped);
  const topByTime = documentTotals.slice(0, 3).map((entry) => ({
    relativePath: entry.relativePath,
    title: resolveTitle(entry.relativePath, entry.title),
    seconds: Math.round(entry.seconds),
  }));

  const marks = input.annotations.filter((annotation) => isMarkInRange(annotation, range));
  const marksByPath = new Map<string, number>();
  for (const mark of marks) {
    marksByPath.set(mark.relativePath, (marksByPath.get(mark.relativePath) ?? 0) + 1);
  }
  const topByMarks = [...marksByPath.entries()]
    // 并列决胜：条数降序，再按路径升序，保证稳定可测。
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 3)
    .map(([relativePath, count]) => ({
      relativePath,
      title: resolveTitle(relativePath, null),
      count,
    }));

  // 金句：期内最长摘录（长度≈显著的朴素启发，与 cloze 一致）；
  // 决胜按创建时间早者、再按 id，保证确定性。
  let quoteMark: Annotation | null = null;
  let quoteLength = 0;
  for (const mark of marks) {
    const text = mark.selectedText?.replace(/\s+/g, " ").trim() ?? "";
    const length = [...text].length;
    if (
      length > quoteLength ||
      (length === quoteLength &&
        quoteMark !== null &&
        (mark.createdAt < quoteMark.createdAt ||
          (mark.createdAt === quoteMark.createdAt && mark.id < quoteMark.id)))
    ) {
      quoteMark = mark;
      quoteLength = length;
    }
  }
  const quote =
    quoteMark && quoteLength > 0
      ? {
          text: quoteMark.selectedText?.replace(/\s+/g, " ").trim() ?? "",
          title: resolveTitle(quoteMark.relativePath, null),
        }
      : null;

  // 对比上期：上一自然周期的总时长；无记录 → null（卡面显示"上期无记录"）。
  const previousDaily = aggregateDaily(
    clipSessionsToRange(input.sessions, previousReportRange(range)),
  );
  const previousTotalSeconds = previousDaily.reduce((sum, day) => sum + day.seconds, 0);
  const totalDeltaPercent =
    previousTotalSeconds > 0
      ? Math.round(((totalSeconds - previousTotalSeconds) / previousTotalSeconds) * 100)
      : null;

  return {
    range,
    totalSeconds,
    activeDays: daily.length,
    longestStreakDays,
    documentCount: new Set(clipped.map((session) => sessionDocumentKey(session))).size,
    markCount: marks.length,
    totalDeltaPercent,
    peakSlot,
    longestDay,
    depthShares,
    topByTime,
    topByMarks,
    quote,
  };
}
