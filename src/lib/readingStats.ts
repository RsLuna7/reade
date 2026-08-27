import type { DocumentFormat, ReadingSession } from "./backend";

/**
 * Pure aggregation helpers for reading statistics.
 *
 * Sessions carry wall-clock bounds plus engaged seconds; sessions spanning
 * local midnight or hour boundaries are split proportionally across the
 * buckets they overlap. All bucketing uses the local timezone.
 */

export interface DailyTotal {
  /** Local calendar day, formatted YYYY-MM-DD. */
  date: string;
  seconds: number;
}

export interface DocumentTotal {
  relativePath: string;
  /** Library the sessions were recorded against; empty when the source omitted it. */
  libraryRoot: string;
  title: string | null;
  format: DocumentFormat;
  seconds: number;
  /** Unix ms of the most recent session end. */
  lastReadAt: number;
}

export interface HourlyTotal {
  /** Local hour of day, 0-23. */
  hour: number;
  seconds: number;
}

/** One sitting: glance / sit / immerse / long, by engaged seconds. */
export const SESSION_DEPTH_ORDER = ["glance", "sit", "immerse", "long"] as const;
export type SessionDepthId = (typeof SESSION_DEPTH_ORDER)[number];

export const SESSION_DEPTH_LABELS: Record<SessionDepthId, string> = {
  glance: "短读",
  sit: "中读",
  immerse: "沉浸",
  long: "长读",
};

export const SESSION_DEPTH_RANGES: Record<SessionDepthId, string> = {
  glance: "不足 5 分钟",
  sit: "5–25 分钟",
  immerse: "25–60 分钟",
  long: "1 小时以上",
};

export interface SessionDepthTotal {
  id: SessionDepthId;
  seconds: number;
  count: number;
}

export interface ReadingSummary {
  totalSeconds: number;
  todaySeconds: number;
  last7DaySeconds: number;
  documentCount: number;
  activeDays: number;
  currentStreakDays: number;
  longestStreakDays: number;
}

export interface DayTimelineSegment {
  id: string;
  relativePath: string;
  libraryRoot: string;
  title: string | null;
  format: DocumentFormat;
  /** Session bounds clipped to the local day, unix ms. */
  startMs: number;
  endMs: number;
  /** Position within the day, 0..1. */
  startRatio: number;
  endRatio: number;
  /** Active seconds attributed to this day. */
  seconds: number;
}

export interface TrendPoint {
  date: string;
  seconds: number;
  /** Trailing moving average over the configured window. */
  averageSeconds: number;
  weekend: boolean;
}

export interface CumulativePoint {
  date: string;
  cumulativeSeconds: number;
}

export interface DocumentDetail {
  relativePath: string;
  libraryRoot: string;
  title: string | null;
  format: DocumentFormat;
  totalSeconds: number;
  sessionCount: number;
  averageSessionSeconds: number;
  lastReadAt: number;
  /** Recent daily totals for this document, gap-filled. */
  daily: DailyTotal[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Strip the Windows extended-length / device prefix that
 * `std::fs::canonicalize` stamps onto stored `library_root` values
 * (`\\?\C:\foo` → `//?/C:/foo` after slash conversion). The folder picker
 * and `snapshot.rootPath` never carry that prefix, so a naive string
 * compare would treat every Windows session as a foreign library.
 */
function stripWindowsVerbatimPrefix(path: string): string {
  const head = path.slice(0, 8).toLowerCase();
  if (head === "//?/unc/" || head === "//./unc/") {
    return `//${path.slice(8)}`;
  }
  const short = path.slice(0, 4);
  if (short === "//?/" || short === "//./") {
    return path.slice(4);
  }
  return path;
}

/** Slash-normalize a library root so Windows `\\`, trailing slashes, and the verbatim prefix still match. */
export function normalizeLibraryRoot(root: string | undefined | null): string {
  if (!root) return "";
  return stripWindowsVerbatimPrefix(root.replace(/\\/g, "/").replace(/\/+$/, ""));
}

export function sameLibraryRoot(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  // Windows paths are case-insensitive; canonicalize may also rewrite casing.
  return normalizeLibraryRoot(a).toLowerCase() === normalizeLibraryRoot(b).toLowerCase();
}

/** Last path segment of a library root, used as a source-folder label. */
export function libraryFolderName(root: string | undefined | null): string {
  const normalized = normalizeLibraryRoot(root);
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function sessionDocumentKey(session: {
  libraryRoot?: string;
  relativePath: string;
}): string {
  return `${normalizeLibraryRoot(session.libraryRoot).toLowerCase()}\n${session.relativePath}`;
}

/**
 * Sessions recorded in `libraryRoot`. Rows with no `libraryRoot` (write path /
 * test fixtures) are treated as belonging to the current library.
 */
export function sessionsInLibrary(
  sessions: ReadingSession[],
  libraryRoot: string | undefined | null,
): ReadingSession[] {
  return sessions.filter((session) => {
    if (!session.libraryRoot) return true;
    return sameLibraryRoot(session.libraryRoot, libraryRoot);
  });
}

/**
 * True when a listed session can be opened in the currently open library.
 * Missing `libraryRoot` is treated as the current library (test fixtures).
 */
export function isCurrentLibrarySession(
  libraryRoot: string | undefined | null,
  currentRoot: string | undefined | null,
): boolean {
  if (!libraryRoot) return true;
  return sameLibraryRoot(libraryRoot, currentRoot);
}

export function localDayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Local Date for a YYYY-MM-DD key (avoids UTC parsing of the Date constructor). */
export function dayKeyToDate(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

export function isWeekendDay(key: string): boolean {
  const weekday = dayKeyToDate(key).getDay();
  return weekday === 0 || weekday === 6;
}

function nextLocalDayStart(ms: number): number {
  const date = new Date(ms);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function nextLocalHourStart(ms: number): number {
  const date = new Date(ms);
  date.setMinutes(60, 0, 0);
  return date.getTime();
}

function previousDayKey(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() - 1);
  return localDayKey(date.getTime());
}

/**
 * Distributes a session's active seconds across bucket boundaries in
 * proportion to the wall-clock time spent inside each bucket.
 */
function splitProportional(
  session: ReadingSession,
  nextBoundary: (ms: number) => number,
  assign: (bucketSampleMs: number, seconds: number) => void,
): void {
  if (session.activeSeconds <= 0) return;
  const start = session.startedAt;
  const end = Math.max(session.endedAt, start);
  if (end <= start) {
    assign(start, session.activeSeconds);
    return;
  }
  const span = end - start;
  let cursor = start;
  while (cursor < end) {
    const boundary = Math.min(end, nextBoundary(cursor));
    if (boundary <= cursor) return;
    assign(cursor, (session.activeSeconds * (boundary - cursor)) / span);
    cursor = boundary;
  }
}

export function aggregateDaily(sessions: ReadingSession[]): DailyTotal[] {
  const byDay = new Map<string, number>();
  for (const session of sessions) {
    splitProportional(session, nextLocalDayStart, (sampleMs, seconds) => {
      const key = localDayKey(sampleMs);
      byDay.set(key, (byDay.get(key) ?? 0) + seconds);
    });
  }
  return [...byDay.entries()]
    .map(([date, seconds]) => ({ date, seconds: Math.round(seconds) }))
    .filter((total) => total.seconds > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function aggregateByHour(sessions: ReadingSession[]): HourlyTotal[] {
  const byHour = new Array<number>(24).fill(0);
  for (const session of sessions) {
    splitProportional(session, nextLocalHourStart, (sampleMs, seconds) => {
      byHour[new Date(sampleMs).getHours()] += seconds;
    });
  }
  return byHour.map((seconds, hour) => ({ hour, seconds: Math.round(seconds) }));
}

export function aggregateByDocument(sessions: ReadingSession[]): DocumentTotal[] {
  const byKey = new Map<string, DocumentTotal & { latestEnd: number }>();
  for (const session of sessions) {
    const key = sessionDocumentKey(session);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        relativePath: session.relativePath,
        libraryRoot: session.libraryRoot ?? "",
        title: session.title,
        format: session.format,
        seconds: session.activeSeconds,
        lastReadAt: session.endedAt,
        latestEnd: session.endedAt,
      });
      continue;
    }
    existing.seconds += session.activeSeconds;
    if (session.endedAt >= existing.latestEnd) {
      existing.latestEnd = session.endedAt;
      existing.lastReadAt = session.endedAt;
      existing.title = session.title;
      existing.format = session.format;
    }
  }
  return [...byKey.values()]
    .map(({ latestEnd: _latestEnd, ...total }) => total)
    .sort((a, b) => b.seconds - a.seconds || b.lastReadAt - a.lastReadAt);
}

export function sessionDepthId(activeSeconds: number): SessionDepthId {
  if (activeSeconds < 5 * 60) return "glance";
  if (activeSeconds < 25 * 60) return "sit";
  if (activeSeconds < 60 * 60) return "immerse";
  return "long";
}

/** Time and sitting counts in four depth bins, always in display order. */
export function aggregateBySessionDepth(sessions: ReadingSession[]): SessionDepthTotal[] {
  const buckets: Record<SessionDepthId, SessionDepthTotal> = {
    glance: { id: "glance", seconds: 0, count: 0 },
    sit: { id: "sit", seconds: 0, count: 0 },
    immerse: { id: "immerse", seconds: 0, count: 0 },
    long: { id: "long", seconds: 0, count: 0 },
  };
  for (const session of sessions) {
    if (session.activeSeconds <= 0) continue;
    const id = sessionDepthId(session.activeSeconds);
    buckets[id].seconds += session.activeSeconds;
    buckets[id].count += 1;
  }
  return SESSION_DEPTH_ORDER.map((id) => buckets[id]);
}

/** Median engaged seconds across sittings; 0 when there are none. */
export function medianSessionSeconds(sessions: ReadingSession[]): number {
  const values = sessions
    .map((session) => session.activeSeconds)
    .filter((seconds) => seconds > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return 0;
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 0) {
    return Math.round((values[mid - 1] + values[mid]) / 2);
  }
  return values[mid];
}

export function buildSummary(sessions: ReadingSession[], nowMs: number): ReadingSummary {
  const daily = aggregateDaily(sessions);
  const byDay = new Map(daily.map((total) => [total.date, total.seconds]));
  const todayKey = localDayKey(nowMs);

  let last7DaySeconds = 0;
  let cursorKey = todayKey;
  for (let i = 0; i < 7; i += 1) {
    last7DaySeconds += byDay.get(cursorKey) ?? 0;
    cursorKey = previousDayKey(cursorKey);
  }

  const activeDayKeys = new Set(daily.map((total) => total.date));
  let currentStreakDays = 0;
  let streakCursor = activeDayKeys.has(todayKey) ? todayKey : previousDayKey(todayKey);
  while (activeDayKeys.has(streakCursor)) {
    currentStreakDays += 1;
    streakCursor = previousDayKey(streakCursor);
  }

  let longestStreakDays = 0;
  let run = 0;
  let previous: string | null = null;
  for (const total of daily) {
    run = previous !== null && previousDayKey(total.date) === previous ? run + 1 : 1;
    longestStreakDays = Math.max(longestStreakDays, run);
    previous = total.date;
  }

  return {
    totalSeconds: sessions.reduce((sum, session) => sum + session.activeSeconds, 0),
    todaySeconds: byDay.get(todayKey) ?? 0,
    last7DaySeconds,
    documentCount: new Set(sessions.map((session) => sessionDocumentKey(session))).size,
    activeDays: activeDayKeys.size,
    currentStreakDays,
    longestStreakDays,
  };
}

/** Fills every local day in [fromMs, toMs] so calendar heatmaps have no gaps. */
export function fillDailyRange(
  daily: DailyTotal[],
  fromMs: number,
  toMs: number,
): DailyTotal[] {
  const byDay = new Map(daily.map((total) => [total.date, total.seconds]));
  const filled: DailyTotal[] = [];
  const cursor = new Date(fromMs);
  cursor.setHours(12, 0, 0, 0);
  const endKey = localDayKey(toMs);
  let key = localDayKey(cursor.getTime());
  while (true) {
    filled.push({ date: key, seconds: byDay.get(key) ?? 0 });
    if (key === endKey) break;
    cursor.setDate(cursor.getDate() + 1);
    key = localDayKey(cursor.getTime());
  }
  return filled;
}

/** Maps day totals onto heatmap levels 0..maxLevel relative to the busiest day. */
export function calendarLevel(seconds: number, maxSeconds: number, maxLevel = 4): number {
  if (seconds <= 0 || maxSeconds <= 0) return 0;
  return Math.min(maxLevel, Math.max(1, Math.ceil((seconds / maxSeconds) * maxLevel)));
}

function dayBounds(key: string): { start: number; end: number } {
  const start = dayKeyToDate(key);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(24, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

/** Sessions overlapping a local day, clipped to it, sorted by start time. */
export function buildDayTimeline(
  sessions: ReadingSession[],
  dayKey: string,
): DayTimelineSegment[] {
  const { start: dayStart, end: dayEnd } = dayBounds(dayKey);
  const dayLength = dayEnd - dayStart;
  const segments: DayTimelineSegment[] = [];
  for (const session of sessions) {
    if (session.activeSeconds <= 0) continue;
    const start = session.startedAt;
    const end = Math.max(session.endedAt, start);
    if (end <= start) {
      if (start >= dayStart && start < dayEnd) {
        const ratio = (start - dayStart) / dayLength;
        segments.push({
          id: session.id,
          relativePath: session.relativePath,
          libraryRoot: session.libraryRoot ?? "",
          title: session.title,
          format: session.format,
          startMs: start,
          endMs: start,
          startRatio: ratio,
          endRatio: ratio,
          seconds: session.activeSeconds,
        });
      }
      continue;
    }
    const clippedStart = Math.max(start, dayStart);
    const clippedEnd = Math.min(end, dayEnd);
    if (clippedEnd <= clippedStart) continue;
    segments.push({
      id: session.id,
      relativePath: session.relativePath,
      libraryRoot: session.libraryRoot ?? "",
      title: session.title,
      format: session.format,
      startMs: clippedStart,
      endMs: clippedEnd,
      startRatio: (clippedStart - dayStart) / dayLength,
      endRatio: (clippedEnd - dayStart) / dayLength,
      seconds: (session.activeSeconds * (clippedEnd - clippedStart)) / (end - start),
    });
  }
  return segments.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
}

/** Per-document totals for one local day (clipped, like the daily buckets). */
export function aggregateDayDocuments(
  sessions: ReadingSession[],
  dayKey: string,
): DocumentTotal[] {
  const byKey = new Map<string, DocumentTotal>();
  for (const segment of buildDayTimeline(sessions, dayKey)) {
    const key = sessionDocumentKey(segment);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        relativePath: segment.relativePath,
        libraryRoot: segment.libraryRoot,
        title: segment.title,
        format: segment.format,
        seconds: segment.seconds,
        lastReadAt: segment.endMs,
      });
      continue;
    }
    existing.seconds += segment.seconds;
    if (segment.endMs >= existing.lastReadAt) {
      existing.lastReadAt = segment.endMs;
      existing.title = segment.title;
      existing.format = segment.format;
    }
  }
  return [...byKey.values()]
    .map((total) => ({ ...total, seconds: Math.round(total.seconds) }))
    .filter((total) => total.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds || b.lastReadAt - a.lastReadAt);
}

/** 7x24 seconds matrix; rows start on Monday to match the calendar heatmap. */
export function weekdayHourMatrix(sessions: ReadingSession[]): number[][] {
  const matrix = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const session of sessions) {
    splitProportional(session, nextLocalHourStart, (sampleMs, seconds) => {
      const date = new Date(sampleMs);
      matrix[(date.getDay() + 6) % 7][date.getHours()] += seconds;
    });
  }
  return matrix.map((row) => row.map((seconds) => Math.round(seconds)));
}

/** One contiguous reading window on a weekday lane. Hours are local 0–24. */
export interface HabitSpan {
  weekday: number;
  startHour: number;
  endHour: number;
  seconds: number;
  peakSeconds: number;
}

const WEEKDAY_SPAN_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** Merges adjacent active hours into Gantt spans. Rows are Monday-first. */
export function weekdayHourSpans(matrix: number[][]): HabitSpan[] {
  const spans: HabitSpan[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const row = matrix[weekday] ?? [];
    let start: number | null = null;
    let seconds = 0;
    let peakSeconds = 0;
    const flush = (endHour: number) => {
      if (start === null) return;
      spans.push({ weekday, startHour: start, endHour, seconds, peakSeconds });
      start = null;
      seconds = 0;
      peakSeconds = 0;
    };
    for (let hour = 0; hour < 24; hour += 1) {
      const value = row[hour] ?? 0;
      if (value > 0) {
        if (start === null) start = hour;
        seconds += value;
        peakSeconds = Math.max(peakSeconds, value);
        continue;
      }
      flush(hour);
    }
    flush(24);
  }
  return spans;
}

function formatWeekdayPhrase(days: number[]): string {
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length === 7) return "每天";
  const asSet = new Set(unique);
  if (unique.length === 5 && [0, 1, 2, 3, 4].every((day) => asSet.has(day))) return "工作日";
  if (unique.length === 2 && asSet.has(5) && asSet.has(6)) return "周末";
  const runs: string[] = [];
  let runStart = unique[0];
  let runEnd = unique[0];
  const name = (day: number) => WEEKDAY_SPAN_NAMES[day];
  const pushRun = () => {
    runs.push(runStart === runEnd ? name(runStart) : `${name(runStart)}至${name(runEnd)}`);
  };
  for (let index = 1; index < unique.length; index += 1) {
    const day = unique[index];
    if (day === runEnd + 1) {
      runEnd = day;
      continue;
    }
    pushRun();
    runStart = day;
    runEnd = day;
  }
  pushRun();
  return runs.join("、");
}

function formatHourWindow(startHour: number, endHour: number): string {
  if (endHour - startHour <= 1) return `${startHour} 点`;
  return `${startHour}–${endHour} 点`;
}

/**
 * One-line reading of the weekly habit matrix: the densest hour window
 * and the weekdays that actually show up in it.
 */
export function describeHabitPeak(matrix: number[][]): string | null {
  const hourly = new Array<number>(24).fill(0);
  for (const row of matrix) {
    for (let hour = 0; hour < 24; hour += 1) {
      hourly[hour] += row[hour] ?? 0;
    }
  }
  const maxHourSeconds = hourly.reduce((max, seconds) => Math.max(max, seconds), 0);
  if (maxHourSeconds <= 0) return null;

  const threshold = maxHourSeconds * 0.45;
  let bestStart = 0;
  let bestEnd = 1;
  let bestSum = 0;
  let cursor = 0;
  while (cursor < 24) {
    if (hourly[cursor] < threshold) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    let sum = 0;
    while (cursor < 24 && hourly[cursor] >= threshold) {
      sum += hourly[cursor];
      cursor += 1;
    }
    if (sum > bestSum) {
      bestStart = start;
      bestEnd = cursor;
      bestSum = sum;
    }
  }

  const weekdaySeconds = matrix.map((row) =>
    (row ?? []).slice(bestStart, bestEnd).reduce((sum, seconds) => sum + seconds, 0),
  );
  const maxWeekdaySeconds = weekdaySeconds.reduce((max, seconds) => Math.max(max, seconds), 0);
  const weekdays = weekdaySeconds.flatMap((seconds, weekday) =>
    seconds > 0 && seconds >= maxWeekdaySeconds * 0.35 ? [weekday] : [],
  );
  if (weekdays.length === 0) return null;
  return `高峰在${formatWeekdayPhrase(weekdays)} ${formatHourWindow(bestStart, bestEnd)}`;
}

/** Gap-filled recent series with a trailing moving average and weekend flags. */
export function buildTrendSeries(
  daily: DailyTotal[],
  nowMs: number,
  rangeDays: number,
  window = 7,
): TrendPoint[] {
  const byDay = new Map(daily.map((total) => [total.date, total.seconds]));
  const filled = fillDailyRange(daily, nowMs - (rangeDays - 1) * DAY_MS, nowMs);
  return filled.map((total) => {
    let sum = 0;
    let cursor = total.date;
    for (let i = 0; i < window; i += 1) {
      sum += byDay.get(cursor) ?? 0;
      cursor = previousDayKey(cursor);
    }
    return {
      date: total.date,
      seconds: total.seconds,
      averageSeconds: Math.round(sum / window),
      weekend: isWeekendDay(total.date),
    };
  });
}

/** Running total from the first active day through today. */
export function cumulativeSeries(daily: DailyTotal[], nowMs: number): CumulativePoint[] {
  if (daily.length === 0) return [];
  const filled = fillDailyRange(daily, dayBounds(daily[0].date).start, nowMs);
  let running = 0;
  return filled.map((total) => {
    running += total.seconds;
    return { date: total.date, cumulativeSeconds: running };
  });
}

export function buildDocumentDetail(
  sessions: ReadingSession[],
  relativePath: string,
  nowMs: number,
  rangeDays = 30,
  libraryRoot?: string,
): DocumentDetail | null {
  const documentSessions = sessions.filter((session) => {
    if (session.relativePath !== relativePath) return false;
    if (libraryRoot === undefined) return true;
    return sameLibraryRoot(session.libraryRoot, libraryRoot);
  });
  if (documentSessions.length === 0) return null;
  const totals = aggregateByDocument(documentSessions)[0];
  return {
    relativePath,
    libraryRoot: totals.libraryRoot,
    title: totals.title,
    format: totals.format,
    totalSeconds: totals.seconds,
    sessionCount: documentSessions.length,
    averageSessionSeconds: Math.round(totals.seconds / documentSessions.length),
    lastReadAt: totals.lastReadAt,
    daily: fillDailyRange(
      aggregateDaily(documentSessions),
      nowMs - (rangeDays - 1) * DAY_MS,
      nowMs,
    ),
  };
}

export function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded} 秒`;
  const totalMinutes = Math.floor(rounded / 60);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}
