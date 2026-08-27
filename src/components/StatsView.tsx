import {
  cloneElement,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  Flame,
  Info,
  RefreshCw,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import { ActivityCalendar, type Activity } from "react-activity-calendar";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  listAnnotations,
  listDocumentExtents,
  listReadingSessions,
  type DocumentExtent,
  type DocumentFormat,
  type ReadingSession,
} from "../lib/backend";
import { highWaterCoverage } from "../lib/readingTimeEstimate";
// 库覆盖率知识地图(plan-coverage-treemap):布局与聚合纯函数在 lib/treemap。
import { CoverageTreemap } from "./CoverageTreemap";
import { listLibraryReadingPositions } from "../lib/readingPositions";
import {
  aggregateByDocument,
  aggregateByHour,
  aggregateBySessionDepth,
  aggregateDaily,
  aggregateDayDocuments,
  buildDayTimeline,
  buildDocumentDetail,
  buildSummary,
  buildTrendSeries,
  calendarLevel,
  cumulativeSeries,
  dayKeyToDate,
  describeHabitPeak,
  fillDailyRange,
  formatDuration,
  isCurrentLibrarySession,
  libraryFolderName,
  localDayKey,
  medianSessionSeconds,
  sessionDocumentKey,
  SESSION_DEPTH_LABELS,
  SESSION_DEPTH_RANGES,
  weekdayHourMatrix,
  weekdayHourSpans,
  type DocumentTotal,
  type HourlyTotal,
  type ReadingSummary,
  type SessionDepthId,
} from "../lib/readingStats";
import { chartMotionProps, useCountUp, useEntranceFlag } from "../lib/statsMotion";
import { runMotion, type ReaderMotionLevel } from "../lib/motion";
import { THEME_META, useReaderStore } from "../store/useReaderStore";

// 阅读报告卡片(plan-reading-report-cards):随点随生成,懒加载出卡管线。
const ReportDialog = lazy(() => import("./ReportDialog").then((module) => ({ default: module.ReportDialog })));

const DAY_MS = 24 * 60 * 60 * 1000;
const HEATMAP_DAYS = 365;
const RANKING_LIMIT = 10;
/** 高水位覆盖率达到该值视为"读完"（与 read-next 的 0.98 触发语义一致）。 */
const FINISHED_COVERAGE = 0.98;
const TREND_RANGES = [7, 30, 90] as const;
type TrendRange = (typeof TREND_RANGES)[number];

const FORMAT_LABELS: Record<DocumentFormat, string> = {
  markdown: "Markdown",
  mdx: "MDX",
  pdf: "PDF",
  epub: "EPUB",
};

const FORMAT_COLORS: Record<DocumentFormat, string> = {
  markdown: "var(--accent)",
  mdx: "var(--accent-ink)",
  pdf: "var(--teal)",
  epub: "var(--muted)",
};

const DEPTH_COLORS: Record<SessionDepthId, string> = {
  glance: "color-mix(in srgb, var(--accent) 28%, var(--muted))",
  sit: "color-mix(in srgb, var(--accent) 55%, var(--paper-raised))",
  immerse: "var(--accent)",
  long: "var(--teal)",
};

const HEATMAP_SCALE = [
  "var(--stats-scale-0)",
  "var(--stats-scale-1)",
  "var(--stats-scale-2)",
  "var(--stats-scale-3)",
  "var(--stats-scale-4)",
];

const MONTH_LABELS = [
  "1月", "2月", "3月", "4月", "5月", "6月",
  "7月", "8月", "9月", "10月", "11月", "12月",
];
const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const PUNCH_ROW_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function rankingSource(libraryRoot: string | undefined, currentRoot: string | null): {
  canOpen: boolean;
  otherLibrary: boolean;
  folder: string;
} {
  const otherLibrary = Boolean(libraryRoot) && !isCurrentLibrarySession(libraryRoot, currentRoot);
  return {
    canOpen: isCurrentLibrarySession(libraryRoot, currentRoot),
    otherLibrary,
    folder: libraryFolderName(libraryRoot),
  };
}

function rankingTitleHint(
  relativePath: string,
  source: { canOpen: boolean; otherLibrary: boolean; folder: string },
  exists: boolean,
): string {
  if (source.otherLibrary) {
    return `来自文档库「${source.folder}」· 打开该库后可跳转`;
  }
  if (exists) return `打开 ${relativePath}`;
  return "文档已从文档库移除";
}

function weekdayName(dayKey: string): string {
  return `周${WEEKDAY_LABELS[dayKeyToDate(dayKey).getDay()]}`;
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function chartTooltipStyle(): CSSProperties {
  return {
    background: "var(--paper-raised)",
    border: "1px solid var(--line-strong)",
    borderRadius: 10,
    boxShadow: "var(--shadow)",
    color: "var(--ink)",
    fontSize: 12,
    padding: "6px 10px",
  };
}

function downloadTextFile(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function sessionsToCsv(sessions: ReadingSession[]): string {
  const rows = ["id,libraryRoot,relativePath,format,title,startedAt,endedAt,activeSeconds"];
  for (const session of sessions) {
    rows.push(
      [
        csvField(session.id),
        csvField(session.libraryRoot ?? ""),
        csvField(session.relativePath),
        session.format,
        csvField(session.title ?? ""),
        new Date(session.startedAt).toISOString(),
        new Date(session.endedAt).toISOString(),
        String(session.activeSeconds),
      ].join(","),
    );
  }
  return rows.join("\n");
}

function staggerStyle(index: number): CSSProperties {
  return { "--stats-delay": `${index * 70}ms` } as CSSProperties;
}

/* --------------------------------- Cards --------------------------------- */

function GoalRing({ progress }: { progress: number }) {
  const radius = 12;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, progress));
  return (
    <svg className="stats-goal-ring" viewBox="0 0 30 30" aria-hidden="true">
      <circle cx="15" cy="15" r={radius} fill="none" stroke="var(--chrome-strong)" strokeWidth="3.5" />
      <circle
        cx="15"
        cy="15"
        r={radius}
        fill="none"
        stroke="var(--stats-scale-4)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
        transform="rotate(-90 15 15)"
      />
    </svg>
  );
}

interface OverviewCardsProps {
  summary: ReadingSummary;
  todayKey: string;
  goalMinutes: number;
  motionLevel: ReaderMotionLevel;
}

/** Isolated so count-up re-renders stay out of the chart subtree. */
function OverviewCards({ summary, todayKey, goalMinutes, motionLevel }: OverviewCardsProps) {
  const today = useCountUp(summary.todaySeconds, motionLevel);
  const week = useCountUp(summary.last7DaySeconds, motionLevel);
  const total = useCountUp(summary.totalSeconds, motionLevel);
  const streak = useCountUp(summary.currentStreakDays, motionLevel);
  const goalSeconds = goalMinutes * 60;
  const goalProgress = goalSeconds > 0 ? today / goalSeconds : 0;
  const realProgress = goalSeconds > 0 ? summary.todaySeconds / goalSeconds : 0;

  return (
    <section className="stats-cards" aria-label="阅读概览">
      <article className="stats-card stats-card--metric stats-enter" style={staggerStyle(0)}>
        <span className="stats-metric-label"><Clock3 size={13} aria-hidden="true" />今日</span>
        <span className="stats-metric-value">
          <strong>{formatDuration(Math.round(today))}</strong>
          {goalSeconds > 0 && <GoalRing progress={goalProgress} />}
        </span>
        <span className="stats-metric-hint">
          {goalSeconds > 0
            ? `目标 ${goalMinutes} 分 · 完成 ${Math.round(realProgress * 100)}%`
            : todayKey}
        </span>
      </article>
      <article className="stats-card stats-card--metric stats-enter" style={staggerStyle(1)}>
        <span className="stats-metric-label"><CalendarDays size={13} aria-hidden="true" />近 7 天</span>
        <span className="stats-metric-value">
          <strong>{formatDuration(Math.round(week))}</strong>
        </span>
        <span className="stats-metric-hint">日均 {formatDuration(Math.round(summary.last7DaySeconds / 7))}</span>
      </article>
      <article className="stats-card stats-card--metric stats-enter" style={staggerStyle(2)}>
        <span className="stats-metric-label"><BookOpen size={13} aria-hidden="true" />累计</span>
        <span className="stats-metric-value">
          <strong>{formatDuration(Math.round(total))}</strong>
        </span>
        <span className="stats-metric-hint">{summary.documentCount} 篇文档 · {summary.activeDays} 个阅读日</span>
      </article>
      <article className="stats-card stats-card--metric stats-enter" style={staggerStyle(3)}>
        <span className="stats-metric-label"><Flame size={13} aria-hidden="true" />连续阅读</span>
        <span className="stats-metric-value">
          <strong>{Math.round(streak)} 天</strong>
        </span>
        <span className="stats-metric-hint">最长 {summary.longestStreakDays} 天</span>
      </article>
    </section>
  );
}

/* ------------------------------ Footprint -------------------------------- */

/** 一篇达到"读完"覆盖率的文档（清单抽屉的数据行）。 */
interface FinishedDocument {
  relativePath: string;
  title: string;
  format: DocumentFormat;
  coverage: number;
  /** 阅读位置最后更新时间，清单按它倒序。 */
  updatedAt: number;
}

interface FootprintCardProps {
  readCount: number;
  finishedCount: number;
  activeDays: number;
  noteCount: number | null;
  firstDayKey: string | null;
  companionDays: number;
  motionLevel: ReaderMotionLevel;
  onShowFinished: () => void;
  onShowNotes: () => void;
}

/** 数量型总览（读过/读完/阅读天数/笔记），对应微信读书式的"阅读足迹"。 */
function FootprintCard({
  readCount,
  finishedCount,
  activeDays,
  noteCount,
  firstDayKey,
  companionDays,
  motionLevel,
  onShowFinished,
  onShowNotes,
}: FootprintCardProps) {
  const read = useCountUp(readCount, motionLevel);
  const finished = useCountUp(finishedCount, motionLevel);
  const days = useCountUp(activeDays, motionLevel);
  const notes = useCountUp(noteCount ?? 0, motionLevel);
  return (
    <section
      className="stats-card stats-section stats-facts stats-enter"
      aria-label="阅读足迹"
      style={staggerStyle(4)}
    >
      <div className="stats-section-head">
        <h2>阅读足迹</h2>
        {firstDayKey && (
          <span className="stats-section-hint">
            {firstDayKey} 至今 · 与 Reade 相伴 {companionDays} 天
          </span>
        )}
      </div>
      <div className="stats-facts-grid">
        <div className="stats-fact">
          <span className="stats-fact-label">读过</span>
          <strong>{Math.round(read)}</strong>
          <span className="stats-fact-unit">篇</span>
        </div>
        <button
          type="button"
          className="stats-fact"
          title="查看当前文档库中读完的文档"
          disabled={finishedCount === 0}
          onClick={onShowFinished}
        >
          <span className="stats-fact-label">读完</span>
          <strong>{Math.round(finished)}</strong>
          <span className="stats-fact-unit">篇</span>
          <ChevronRight size={14} className="stats-fact-chevron" aria-hidden="true" />
        </button>
        <div className="stats-fact">
          <span className="stats-fact-label">阅读</span>
          <strong>{Math.round(days)}</strong>
          <span className="stats-fact-unit">天</span>
        </div>
        <button
          type="button"
          className="stats-fact"
          title="打开当前文档库的批注中心"
          disabled={noteCount === null}
          onClick={onShowNotes}
        >
          <span className="stats-fact-label">笔记</span>
          <strong>{noteCount === null ? "—" : Math.round(notes)}</strong>
          <span className="stats-fact-unit">条</span>
          <ChevronRight size={14} className="stats-fact-chevron" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

/* ------------------------------- Habit Gantt ----------------------------- */

const GANTT_HOUR_TICKS = [0, 6, 12, 18, 24];

function habitBarTitle(label: string, span: { startHour: number; endHour: number; seconds: number }): string {
  const range =
    span.endHour - span.startHour <= 1
      ? `${span.startHour}:00–${span.startHour}:59`
      : `${span.startHour}:00–${span.endHour}:00`;
  return `周${label} ${range} · ${formatDuration(span.seconds)}`;
}

function HabitGantt({ matrix }: { matrix: number[][] }) {
  const spans = useMemo(() => weekdayHourSpans(matrix), [matrix]);
  const peak = useMemo(() => describeHabitPeak(matrix), [matrix]);
  const maxPeak = spans.reduce((result, span) => Math.max(result, span.peakSeconds), 0);
  const ariaLabel = peak ?? (spans.length > 0 ? "按星期排布的阅读时段" : "还没有形成固定阅读时段");

  return (
    <div className="stats-gantt">
      {peak && <p className="stats-gantt-peak">{peak}</p>}
      <div className="stats-gantt-chart" role="img" aria-label={ariaLabel}>
        {PUNCH_ROW_LABELS.map((label, rowIndex) => (
          <div
            className="stats-gantt-row stats-enter"
            style={staggerStyle(rowIndex)}
            key={label}
          >
            <span className="stats-gantt-label">{label}</span>
            <div className="stats-gantt-track">
              {GANTT_HOUR_TICKS.slice(1, -1).map((hour) => (
                <span
                  key={hour}
                  className="stats-gantt-gridline"
                  style={{ left: `${(hour / 24) * 100}%` }}
                  aria-hidden="true"
                />
              ))}
              {spans
                .filter((span) => span.weekday === rowIndex)
                .map((span) => {
                  const level = calendarLevel(span.peakSeconds, maxPeak);
                  return (
                    <span
                      key={`${span.startHour}-${span.endHour}`}
                      className="stats-gantt-bar"
                      data-level={level}
                      style={{
                        left: `${(span.startHour / 24) * 100}%`,
                        width: `${Math.max(1.2, ((span.endHour - span.startHour) / 24) * 100)}%`,
                        background: `var(--stats-scale-${level})`,
                      }}
                      title={habitBarTitle(label, span)}
                    />
                  );
                })}
            </div>
          </div>
        ))}
        <div className="stats-gantt-row stats-gantt-axis" aria-hidden="true">
          <span className="stats-gantt-label" />
          <div className="stats-gantt-track stats-gantt-track--axis">
            {GANTT_HOUR_TICKS.map((hour) => (
              <span
                key={hour}
                className="stats-gantt-tick"
                style={{ left: `${(hour / 24) * 100}%` }}
                data-label={hour}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- Clock chart ----------------------------- */

function polarPoint(cx: number, cy: number, radius: number, angle: number): string {
  return `${(cx + radius * Math.cos(angle)).toFixed(2)} ${(cy + radius * Math.sin(angle)).toFixed(2)}`;
}

function ClockChart({ hourly }: { hourly: HourlyTotal[] }) {
  const size = 244;
  const center = size / 2;
  const inner = 36;
  const outer = 104;
  const max = hourly.reduce((result, entry) => Math.max(result, entry.seconds), 0);
  return (
    <div className="stats-clock stats-enter">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="按钟面排布的时段分布">
        <circle cx={center} cy={center} r={outer} fill="none" stroke="var(--line)" />
        <circle cx={center} cy={center} r={inner} fill="none" stroke="var(--line)" />
        {hourly.map(({ hour, seconds }) => {
          if (max <= 0 || seconds <= 0) return null;
          const gap = 0.022;
          const start = (hour / 24) * Math.PI * 2 - Math.PI / 2 + gap;
          const end = ((hour + 1) / 24) * Math.PI * 2 - Math.PI / 2 - gap;
          const radius = inner + Math.max(3, (seconds / max) * (outer - inner));
          const d = [
            `M ${polarPoint(center, center, inner, start)}`,
            `L ${polarPoint(center, center, radius, start)}`,
            `A ${radius} ${radius} 0 0 1 ${polarPoint(center, center, radius, end)}`,
            `L ${polarPoint(center, center, inner, end)}`,
            `A ${inner} ${inner} 0 0 0 ${polarPoint(center, center, inner, start)}`,
            "Z",
          ].join(" ");
          return (
            <path key={hour} className="stats-clock-wedge" d={d} fill="var(--teal)">
              <title>{`${hour}:00 – ${hour}:59 · ${formatDuration(seconds)}`}</title>
            </path>
          );
        })}
        {[0, 6, 12, 18].map((hour) => {
          const angle = (hour / 24) * Math.PI * 2 - Math.PI / 2;
          const [x, y] = polarPoint(center, center, outer + 10, angle).split(" ").map(Number);
          return (
            <text key={hour} x={x} y={y + 3.5} textAnchor="middle" className="stats-clock-label">
              {hour}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

/* --------------------------------- Drawer -------------------------------- */

interface StatsDrawerProps {
  title: string;
  subtitle?: string;
  motionLevel: ReaderMotionLevel;
  onClose: () => void;
  children: ReactNode;
}

function StatsDrawer({ title, subtitle, motionLevel, onClose, children }: StatsDrawerProps) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!panelRef.current) return;
    runMotion(
      panelRef.current,
      "enter",
      [
        { transform: "translateX(26px)", opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      { duration: motionLevel === "subtle" ? 180 : 280, easing: "cubic-bezier(0.22, 0.8, 0.36, 1)" },
      motionLevel,
    );
  }, [motionLevel]);
  return (
    <>
      <button
        type="button"
        className="stats-drawer-backdrop"
        aria-label="关闭详情"
        onClick={onClose}
      />
      <aside className="stats-drawer" role="dialog" aria-label={title} ref={panelRef}>
        <header className="stats-drawer-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <span>{subtitle}</span>}
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        <div className="stats-drawer-body">{children}</div>
      </aside>
    </>
  );
}

interface DayDrawerProps {
  dayKey: string;
  sessions: ReadingSession[];
  existingPaths: Set<string>;
  currentRoot: string | null;
  motionLevel: ReaderMotionLevel;
  onClose: () => void;
  onOpenDocument: (relativePath: string) => void;
}

function DayDrawer({
  dayKey,
  sessions,
  existingPaths,
  currentRoot,
  motionLevel,
  onClose,
  onOpenDocument,
}: DayDrawerProps) {
  const timeline = useMemo(() => buildDayTimeline(sessions, dayKey), [sessions, dayKey]);
  const documents = useMemo(() => aggregateDayDocuments(sessions, dayKey), [sessions, dayKey]);
  const totalSeconds = documents.reduce((sum, total) => sum + total.seconds, 0);
  const maxDocSeconds = documents.reduce((max, total) => Math.max(max, total.seconds), 0);

  return (
    <StatsDrawer
      title={`${dayKey} ${weekdayName(dayKey)}`}
      subtitle={totalSeconds > 0 ? `共阅读 ${formatDuration(totalSeconds)} · ${documents.length} 篇文档` : "这一天没有阅读记录"}
      motionLevel={motionLevel}
      onClose={onClose}
    >
      {timeline.length > 0 && (
        <>
          <h3 className="stats-drawer-subhead">当日时间线</h3>
          <div className="stats-timeline" aria-label="当日阅读时间线">
            {[0, 6, 12, 18, 24].map((hour) => (
              <span
                key={hour}
                className="stats-timeline-tick"
                style={{ left: `${(hour / 24) * 100}%` }}
                data-label={hour}
              />
            ))}
            {timeline.map((segment) => {
              const source = rankingSource(segment.libraryRoot, currentRoot);
              const exists = source.canOpen && existingPaths.has(segment.relativePath);
              return (
              <button
                key={`${segment.id}-${segment.startMs}`}
                type="button"
                className="stats-timeline-segment"
                style={{
                  left: `${segment.startRatio * 100}%`,
                  width: `${Math.max(0.6, (segment.endRatio - segment.startRatio) * 100)}%`,
                  background: FORMAT_COLORS[segment.format],
                }}
                title={`${segment.title ?? fileName(segment.relativePath)}\n${formatClock(segment.startMs)} – ${formatClock(segment.endMs)} · ${formatDuration(Math.round(segment.seconds))}${source.otherLibrary ? `\n来自文档库「${source.folder}」` : ""}`}
                disabled={!exists}
                onClick={() => onOpenDocument(segment.relativePath)}
              />
              );
            })}
          </div>
        </>
      )}
      {documents.length > 0 && (
        <>
          <h3 className="stats-drawer-subhead">文档分解</h3>
          <ul className="stats-drawer-docs">
            {documents.map((total) => {
              const source = rankingSource(total.libraryRoot, currentRoot);
              const exists = source.canOpen && existingPaths.has(total.relativePath);
              return (
              <li key={sessionDocumentKey(total)}>
                <button
                  type="button"
                  className="stats-ranking-row"
                  disabled={!exists}
                  title={rankingTitleHint(total.relativePath, source, exists)}
                  onClick={() => onOpenDocument(total.relativePath)}
                >
                  <span className="stats-ranking-main">
                    <span className="stats-ranking-title">
                      {total.title ?? fileName(total.relativePath)}
                      {source.otherLibrary && <em>（{source.folder}）</em>}
                    </span>
                    <span
                      className="stats-ranking-bar"
                      style={{
                        width: `${maxDocSeconds > 0 ? Math.max(4, (total.seconds / maxDocSeconds) * 100) : 0}%`,
                        background: FORMAT_COLORS[total.format],
                      }}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="stats-ranking-meta">
                    <strong>{formatDuration(total.seconds)}</strong>
                    <span>{FORMAT_LABELS[total.format]}</span>
                  </span>
                </button>
              </li>
              );
            })}
          </ul>
        </>
      )}
    </StatsDrawer>
  );
}

interface DocDrawerProps {
  relativePath: string;
  libraryRoot: string;
  sessions: ReadingSession[];
  nowMs: number;
  exists: boolean;
  otherLibrary: boolean;
  folder: string;
  motionLevel: ReaderMotionLevel;
  onClose: () => void;
  onOpenDocument: (relativePath: string) => void;
}

function DocDrawer({
  relativePath,
  libraryRoot,
  sessions,
  nowMs,
  exists,
  otherLibrary,
  folder,
  motionLevel,
  onClose,
  onOpenDocument,
}: DocDrawerProps) {
  const detail = useMemo(
    () => buildDocumentDetail(sessions, relativePath, nowMs, 30, libraryRoot),
    [sessions, relativePath, libraryRoot, nowMs],
  );
  if (!detail) return null;
  const miniData = detail.daily.map((total) => ({
    label: total.date.slice(5),
    minutes: Math.round((total.seconds / 60) * 10) / 10,
    seconds: total.seconds,
  }));
  return (
    <StatsDrawer
      title={detail.title ?? fileName(relativePath)}
      subtitle={
        otherLibrary
          ? `${FORMAT_LABELS[detail.format]} · ${relativePath} · 来自「${folder}」`
          : `${FORMAT_LABELS[detail.format]} · ${relativePath}`
      }
      motionLevel={motionLevel}
      onClose={onClose}
    >
      <dl className="stats-doc-facts">
        <div><dt>累计阅读</dt><dd>{formatDuration(detail.totalSeconds)}</dd></div>
        <div><dt>阅读次数</dt><dd>{detail.sessionCount} 次</dd></div>
        <div><dt>平均单次</dt><dd>{formatDuration(detail.averageSessionSeconds)}</dd></div>
        <div><dt>最近阅读</dt><dd>{`${localDayKey(detail.lastReadAt)} ${formatClock(detail.lastReadAt)}`}</dd></div>
      </dl>
      <h3 className="stats-drawer-subhead">最近 30 天</h3>
      <div className="stats-doc-mini">
        <ResponsiveContainer width="100%" height={96}>
          <BarChart data={miniData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <XAxis dataKey="label" hide />
            <Tooltip
              cursor={{ fill: "var(--selection)" }}
              contentStyle={chartTooltipStyle()}
              labelFormatter={(label) => String(label)}
              formatter={(_value, _name, item) => [
                formatDuration((item?.payload as { seconds?: number })?.seconds ?? 0),
                "阅读时长",
              ]}
            />
            <Bar
              dataKey="minutes"
              fill={FORMAT_COLORS[detail.format]}
              radius={[2, 2, 0, 0]}
              {...chartMotionProps(motionLevel)}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <button
        type="button"
        className="stats-drawer-action"
        disabled={!exists}
        onClick={() => onOpenDocument(relativePath)}
      >
        {exists ? "打开文档" : otherLibrary ? `来自文档库「${folder}」` : "文档已从文档库移除"}
      </button>
    </StatsDrawer>
  );
}

/* --------------------------------- View ---------------------------------- */

export interface StatsViewProps {
  /** Injectable session source for harnesses/tests; defaults to the backend. */
  loadSessions?: (fromMs: number, toMs: number) => Promise<ReadingSession[]>;
}

export function StatsView({ loadSessions = listReadingSessions }: StatsViewProps) {
  const snapshot = useReaderStore((state) => state.snapshot);
  const documents = useReaderStore((state) => state.documents);
  const theme = useReaderStore((state) => state.theme);
  const motionLevel = useReaderStore((state) => state.motionLevel);
  const dailyGoalMinutes = useReaderStore((state) => state.dailyGoalMinutes);
  const setDailyGoalMinutes = useReaderStore((state) => state.setDailyGoalMinutes);
  const selectDocument = useReaderStore((state) => state.selectDocument);
  const setActiveView = useReaderStore((state) => state.setActiveView);

  const [sessions, setSessions] = useState<ReadingSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [trendRange, setTrendRange] = useState<TrendRange>(30);
  const [hourView, setHourView] = useState<"bars" | "clock">("bars");
  const [rankSort, setRankSort] = useState<"time" | "recent">("time");
  const [rankExpanded, setRankExpanded] = useState(false);
  const [drillDay, setDrillDay] = useState<string | null>(null);
  const [docDetail, setDocDetail] = useState<{ relativePath: string; libraryRoot: string } | null>(null);
  const [finishedOpen, setFinishedOpen] = useState(false);
  const [goalEditorOpen, setGoalEditorOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const rootPath = snapshot?.rootPath ?? null;
  const entered = useEntranceFlag(motionLevel);

  // 知识地图数据:extents 一次聚合(失败静默降级为 size 兜底),
  // 阅读位置快照随刷新按钮重取;两者都与会话数据无关。
  const [extents, setExtents] = useState<Map<string, DocumentExtent> | null>(null);
  useEffect(() => {
    if (!rootPath) {
      setExtents(null);
      return;
    }
    let cancelled = false;
    void listDocumentExtents()
      .then((entries) => {
        if (cancelled) return;
        setExtents(new Map(entries.map((entry) => [entry.relativePath, entry])));
      })
      .catch(() => {
        if (!cancelled) setExtents(null);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, reloadToken]);
  const readingPositions = useMemo(
    () => (rootPath ? listLibraryReadingPositions(rootPath) : {}),
    // reloadToken:刷新按钮同时刷新位置快照。
    [rootPath, reloadToken],
  );

  // 阅读足迹的笔记数:批注总量(高亮/划线/书签),读取失败显示为占位。
  const [annotationCount, setAnnotationCount] = useState<number | null>(null);
  useEffect(() => {
    if (!rootPath) {
      setAnnotationCount(null);
      return;
    }
    let cancelled = false;
    void listAnnotations()
      .then((entries) => {
        if (!cancelled) setAnnotationCount(entries.length);
      })
      .catch(() => {
        if (!cancelled) setAnnotationCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, reloadToken]);

  useEffect(() => {
    if (!rootPath) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    setSessions(null);
    setError(null);
    const requestedAt = Date.now();
    loadSessions(0, requestedAt + DAY_MS)
      .then((data) => {
        if (cancelled) return;
        setSessions(data);
        setNow(requestedAt);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, reloadToken, loadSessions]);

  useEffect(() => {
    if (!rootRef.current) return;
    runMotion(
      rootRef.current,
      "enter",
      [
        { opacity: 0, transform: "translateY(14px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: motionLevel === "subtle" ? 200 : 320, easing: "ease-out" },
      motionLevel,
    );
    // 仅入场一次;motionLevel 变化不重播。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const overlayState = useRef({ report: false, goal: false, exportMenu: false, finished: false, doc: null as { relativePath: string; libraryRoot: string } | null, day: null as string | null });
  overlayState.current = { report: reportOpen, goal: goalEditorOpen, exportMenu: exportOpen, finished: finishedOpen, doc: docDetail, day: drillDay };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const overlays = overlayState.current;
      if (overlays.report) setReportOpen(false);
      else if (overlays.goal) setGoalEditorOpen(false);
      else if (overlays.exportMenu) setExportOpen(false);
      else if (overlays.finished) setFinishedOpen(false);
      else if (overlays.doc) setDocDetail(null);
      else if (overlays.day) setDrillDay(null);
      else setActiveView("reader");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setActiveView]);

  const loaded = useMemo(() => sessions ?? [], [sessions]);
  const summary = useMemo(() => buildSummary(loaded, now), [loaded, now]);
  const daily = useMemo(() => aggregateDaily(loaded), [loaded]);
  const documentTotals = useMemo(() => aggregateByDocument(loaded), [loaded]);
  const hourly = useMemo(() => aggregateByHour(loaded), [loaded]);
  const sessionDepth = useMemo(() => aggregateBySessionDepth(loaded), [loaded]);
  const medianSitting = useMemo(() => medianSessionSeconds(loaded), [loaded]);
  const punchMatrix = useMemo(() => weekdayHourMatrix(loaded), [loaded]);

  const heatmapData = useMemo<Activity[]>(() => {
    const filled = fillDailyRange(daily, now - (HEATMAP_DAYS - 1) * DAY_MS, now);
    const busiest = filled.reduce((max, day) => Math.max(max, day.seconds), 0);
    return filled.map((day) => ({
      date: day.date,
      count: day.seconds,
      level: calendarLevel(day.seconds, busiest),
    }));
  }, [daily, now]);

  const trendData = useMemo(
    () =>
      buildTrendSeries(daily, now, trendRange).map((point) => ({
        ...point,
        label: point.date.slice(5),
        minutes: Math.round((point.seconds / 60) * 10) / 10,
        avgMinutes: Math.round((point.averageSeconds / 60) * 10) / 10,
      })),
    [daily, now, trendRange],
  );

  const hourlyData = useMemo(
    () =>
      hourly.map((entry) => ({
        label: String(entry.hour),
        hour: entry.hour,
        seconds: entry.seconds,
        minutes: Math.round((entry.seconds / 60) * 10) / 10,
      })),
    [hourly],
  );

  const cumulativeData = useMemo(
    () =>
      cumulativeSeries(daily, now).map((point) => ({
        label: point.date.slice(5),
        date: point.date,
        hours: Math.round((point.cumulativeSeconds / 3600) * 100) / 100,
        cumulativeSeconds: point.cumulativeSeconds,
      })),
    [daily, now],
  );

  const rankingAll = useMemo(() => {
    if (rankSort === "time") return documentTotals;
    return [...documentTotals].sort(
      (a, b) => b.lastReadAt - a.lastReadAt || b.seconds - a.seconds,
    );
  }, [documentTotals, rankSort]);
  const ranking = rankExpanded ? rankingAll : rankingAll.slice(0, RANKING_LIMIT);
  const rankingMax = rankingAll.reduce((max, entry) => Math.max(max, entry.seconds), 0);
  const depthTotal = sessionDepth.reduce((sum, entry) => sum + entry.seconds, 0);
  const existingPaths = useMemo(
    () => new Set(documents.map((document) => document.relativePath)),
    [documents],
  );

  // 读完清单:库内文档 × 阅读位置高水位,覆盖率达标者按最近读完倒序。
  const finishedDocuments = useMemo<FinishedDocument[]>(() => {
    const result: FinishedDocument[] = [];
    for (const document of documents) {
      const position = readingPositions[document.relativePath];
      if (!position) continue;
      const coverage = highWaterCoverage(
        position,
        extents?.get(document.relativePath)?.segmentCount,
      );
      if (coverage === null || coverage < FINISHED_COVERAGE) continue;
      result.push({
        relativePath: document.relativePath,
        title: document.title,
        format: document.format,
        coverage,
        updatedAt: position.updatedAt,
      });
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [documents, extents, readingPositions]);

  const loading = sessions === null;
  const empty = !loading && loaded.length === 0;
  const todayKey = localDayKey(now);
  const goalMinutes = dailyGoalMinutes;

  // 阅读足迹的陪伴天数:首个阅读日至今(含两端)。
  const firstDayKey = daily.length > 0 ? daily[0].date : null;
  const companionDays = firstDayKey
    ? Math.max(
        1,
        Math.round(
          (dayKeyToDate(todayKey).getTime() - dayKeyToDate(firstDayKey).getTime()) / DAY_MS,
        ) + 1,
      )
    : 0;

  const openDocument = (relativePath: string) => {
    if (!existingPaths.has(relativePath)) return;
    void selectDocument(relativePath);
  };

  const renderRanking = (entry: DocumentTotal, index: number) => {
    const source = rankingSource(entry.libraryRoot, rootPath);
    const exists = source.canOpen && existingPaths.has(entry.relativePath);
    const width = rankingMax > 0 ? Math.max(4, (entry.seconds / rankingMax) * 100) : 0;
    return (
      <li key={sessionDocumentKey(entry)} className="stats-enter" style={staggerStyle(Math.min(index, 9))}>
        <button
          type="button"
          className="stats-ranking-row"
          disabled={!exists}
          title={rankingTitleHint(entry.relativePath, source, exists)}
          onClick={() => openDocument(entry.relativePath)}
        >
          <span className="stats-ranking-index">{index + 1}</span>
          <span className="stats-ranking-main">
            <span className="stats-ranking-title">
              {entry.title ?? fileName(entry.relativePath)}
              {source.otherLibrary && <em>（{source.folder}）</em>}
              {!exists && !source.otherLibrary && <em>（已移除）</em>}
            </span>
            <span
              className="stats-ranking-bar"
              style={{
                width: entered ? `${width}%` : "0%",
                background: FORMAT_COLORS[entry.format],
              }}
              aria-hidden="true"
            />
          </span>
          <span className="stats-ranking-meta">
            <strong>{formatDuration(entry.seconds)}</strong>
            <span>{FORMAT_LABELS[entry.format]}</span>
          </span>
        </button>
        <button
          type="button"
          className="icon-button stats-ranking-info"
          aria-label={`查看 ${entry.title ?? fileName(entry.relativePath)} 的统计详情`}
          title="文档统计详情"
          onClick={() =>
            setDocDetail({
              relativePath: entry.relativePath,
              libraryRoot: entry.libraryRoot,
            })
          }
        >
          <Info size={14} aria-hidden="true" />
        </button>
      </li>
    );
  };

  return (
    <div className="stats-view" aria-label="阅读统计" ref={rootRef}>
      <header className="stats-header">
        <button
          className="icon-button"
          type="button"
          aria-label="返回阅读"
          title="返回阅读（Esc）"
          onClick={() => setActiveView("reader")}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <div className="stats-heading">
          <h1>阅读统计</h1>
          <span>数据仅保存在本机 · 个人累计，跨文档库</span>
        </div>
        <div className="stats-header-tools">
          <div className="stats-popover-anchor">
            <button
              className={`icon-button${goalMinutes > 0 ? " is-armed" : ""}`}
              type="button"
              aria-label="设定每日阅读目标"
              title="每日目标"
              aria-expanded={goalEditorOpen}
              onClick={() => {
                setGoalEditorOpen((open) => !open);
                setExportOpen(false);
              }}
            >
              <Target size={15} aria-hidden="true" />
            </button>
            {goalEditorOpen && (
              <div className="stats-popover" role="dialog" aria-label="每日阅读目标">
                <label>
                  每日目标（分钟，0 表示关闭）
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    value={goalMinutes}
                    onChange={(event) => setDailyGoalMinutes(Number(event.target.value))}
                  />
                </label>
                <div className="stats-popover-presets">
                  {[15, 30, 60, 120].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={goalMinutes === preset ? "is-active" : undefined}
                      onClick={() => setDailyGoalMinutes(preset)}
                    >
                      {preset} 分
                    </button>
                  ))}
                  <button type="button" onClick={() => setDailyGoalMinutes(0)}>关闭</button>
                </div>
              </div>
            )}
          </div>
          <div className="stats-popover-anchor">
            <button
              className="icon-button"
              type="button"
              aria-label="导出阅读数据"
              title="导出数据"
              aria-expanded={exportOpen}
              disabled={loaded.length === 0}
              onClick={() => {
                setExportOpen((open) => !open);
                setGoalEditorOpen(false);
              }}
            >
              <Download size={15} aria-hidden="true" />
            </button>
            {exportOpen && (
              <div className="stats-popover" role="dialog" aria-label="导出阅读数据">
                <div className="stats-popover-presets">
                  <button
                    type="button"
                    onClick={() => {
                      downloadTextFile(
                        `reade-reading-stats-${todayKey}.csv`,
                        "text/csv;charset=utf-8",
                        `\uFEFF${sessionsToCsv(loaded)}`,
                      );
                      setExportOpen(false);
                    }}
                  >
                    导出 CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      downloadTextFile(
                        `reade-reading-stats-${todayKey}.json`,
                        "application/json",
                        JSON.stringify(loaded, null, 2),
                      );
                      setExportOpen(false);
                    }}
                  >
                    导出 JSON
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="生成阅读报告"
            title="生成阅读报告"
            disabled={loaded.length === 0}
            onClick={() => setReportOpen(true)}
          >
            <Sparkles size={15} aria-hidden="true" />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="刷新统计"
            title="刷新统计"
            onClick={() => setReloadToken((token) => token + 1)}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {loading && (
        <div className="stats-state">
          <span className="spinner" aria-hidden="true" />
          正在读取阅读记录…
        </div>
      )}
      {!loading && error && (
        <div className="stats-state stats-state--error" role="alert">
          无法读取阅读统计：{error}
        </div>
      )}
      {empty && !error && (
        <div className="stats-state">
          <BookOpen size={28} aria-hidden="true" />
          <p>还没有阅读记录。打开一篇文档开始阅读，这里就会出现你的时长统计。</p>
        </div>
      )}

      {!loading && (
        <div className="stats-grid">
          {!empty && (
            <>
          <OverviewCards
            summary={summary}
            todayKey={todayKey}
            goalMinutes={goalMinutes}
            motionLevel={motionLevel}
          />

          <FootprintCard
            readCount={summary.documentCount}
            finishedCount={finishedDocuments.length}
            activeDays={summary.activeDays}
            noteCount={annotationCount}
            firstDayKey={firstDayKey}
            companionDays={companionDays}
            motionLevel={motionLevel}
            onShowFinished={() => setFinishedOpen(true)}
            onShowNotes={() => setActiveView("annotations")}
          />

          <section className="stats-card stats-section stats-heatmap" aria-label="过去一年的阅读热力图">
            <div className="stats-section-head">
              <h2>过去一年</h2>
              <span className="stats-section-hint">点击色块查看当日详情</span>
            </div>
            <div className="stats-heatmap-scroll">
              <div className="stats-heatmap-scroll-inner">
                <ActivityCalendar
                  data={heatmapData}
                  colorScheme={THEME_META[theme].mode}
                  theme={{ light: HEATMAP_SCALE, dark: HEATMAP_SCALE }}
                  blockSize={11}
                  blockMargin={3}
                  blockRadius={2}
                  fontSize={12}
                  weekStart={1}
                  maxLevel={4}
                  showTotalCount={false}
                  showWeekdayLabels={["mon", "wed", "fri"]}
                  labels={{
                    months: MONTH_LABELS,
                    weekdays: WEEKDAY_LABELS,
                    legend: { less: "少", more: "多" },
                  }}
                  tooltips={{
                    activity: {
                      text: (activity) =>
                        activity.count > 0
                          ? `${activity.date} · ${formatDuration(activity.count)}`
                          : `${activity.date} · 无阅读`,
                    },
                  }}
                  renderBlock={(block, activity) =>
                    cloneElement(block, {
                      onClick: () => setDrillDay(activity.date),
                      style: { cursor: "pointer" },
                    })
                  }
                />
              </div>
            </div>
          </section>

          <section className="stats-card stats-section" aria-label="每日阅读趋势">
            <div className="stats-section-head">
              <h2>阅读趋势</h2>
              <div className="stats-segment" role="group" aria-label="趋势时间范围">
                {TREND_RANGES.map((range) => (
                  <button
                    key={range}
                    type="button"
                    aria-pressed={trendRange === range}
                    onClick={() => setTrendRange(range)}
                  >
                    {range} 天
                  </button>
                ))}
              </div>
            </div>
            <div className="stats-chart stats-chart--clickable">
              <ResponsiveContainer width="100%" height={190}>
                <ComposedChart
                  data={trendData}
                  margin={{ top: 8, right: 4, bottom: 0, left: -14 }}
                >
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "var(--muted)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--line-strong)" }}
                    minTickGap={26}
                  />
                  <YAxis
                    tick={{ fill: "var(--muted)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value: number) => `${value}分`}
                  />
                  <Tooltip
                    cursor={{ fill: "var(--selection)" }}
                    contentStyle={chartTooltipStyle()}
                    labelFormatter={(label, payload) =>
                      (payload?.[0]?.payload as { date?: string } | undefined)?.date ??
                      String(label ?? "")
                    }
                    formatter={(_value, name, item) => {
                      const payload = item?.payload as
                        | { seconds?: number; averageSeconds?: number }
                        | undefined;
                      if (name === "7 日均值") {
                        return [formatDuration(payload?.averageSeconds ?? 0), "7 日均值"];
                      }
                      return [formatDuration(payload?.seconds ?? 0), "当日"];
                    }}
                  />
                  {goalMinutes > 0 && (
                    <ReferenceLine
                      y={goalMinutes}
                      stroke="var(--line-strong)"
                      strokeDasharray="4 4"
                      label={{
                        value: "目标",
                        fill: "var(--muted)",
                        fontSize: 10,
                        position: "insideTopRight",
                      }}
                    />
                  )}
                  <Bar
                    dataKey="minutes"
                    name="当日"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={18}
                    activeBar={{ fill: "var(--accent-ink)" }}
                    onClick={(entry: unknown) => {
                      const date =
                        (entry as { payload?: { date?: string } })?.payload?.date ??
                        (entry as { date?: string })?.date;
                      if (date) setDrillDay(date);
                    }}
                    {...chartMotionProps(motionLevel)}
                  >
                    {trendData.map((point) => (
                      <Cell
                        key={point.date}
                        fill={point.weekend ? "var(--stats-scale-2)" : "var(--accent)"}
                      />
                    ))}
                  </Bar>
                  <Line
                    dataKey="avgMinutes"
                    name="7 日均值"
                    type="monotone"
                    stroke="var(--teal)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3, fill: "var(--teal)" }}
                    {...chartMotionProps(motionLevel, 1)}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="stats-card stats-section" aria-label="二十四小时时段分布">
            <div className="stats-section-head">
              <h2>时段分布</h2>
              <div className="stats-segment" role="group" aria-label="时段视图">
                <button type="button" aria-pressed={hourView === "bars"} onClick={() => setHourView("bars")}>
                  柱状
                </button>
                <button type="button" aria-pressed={hourView === "clock"} onClick={() => setHourView("clock")}>
                  钟面
                </button>
              </div>
            </div>
            {hourView === "bars" ? (
              <div className="stats-chart">
                <ResponsiveContainer width="100%" height={190}>
                  <BarChart data={hourlyData} margin={{ top: 8, right: 4, bottom: 0, left: -14 }}>
                    <CartesianGrid stroke="var(--line)" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "var(--muted)", fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: "var(--line-strong)" }}
                      ticks={["0", "6", "12", "18", "23"]}
                    />
                    <YAxis
                      tick={{ fill: "var(--muted)", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value: number) => `${value}分`}
                    />
                    <Tooltip
                      cursor={{ fill: "var(--selection)" }}
                      contentStyle={chartTooltipStyle()}
                      labelFormatter={(label) => `${String(label)}:00 – ${String(label)}:59`}
                      formatter={(_value, _name, item) => [
                        formatDuration((item?.payload as { seconds?: number })?.seconds ?? 0),
                        "阅读时长",
                      ]}
                    />
                    <Bar
                      dataKey="minutes"
                      fill="var(--teal)"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={16}
                      activeBar={{ fill: "var(--teal)", stroke: "var(--ink-soft)", strokeWidth: 1 }}
                      {...chartMotionProps(motionLevel, 1)}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <ClockChart hourly={hourly} />
            )}
          </section>

          <section className="stats-card stats-section stats-span" aria-label="星期与时段阅读习惯">
            <div className="stats-section-head">
              <h2>阅读习惯</h2>
              <span className="stats-section-hint">各日阅读时段</span>
            </div>
            <HabitGantt matrix={punchMatrix} />
          </section>

          {cumulativeData.length >= 2 && (
            <section className="stats-card stats-section stats-span" aria-label="累计阅读增长">
              <div className="stats-section-head">
                <h2>累计增长</h2>
                <span className="stats-section-hint">
                  自 {cumulativeData[0].date} 起
                </span>
              </div>
              <div className="stats-chart">
                <ResponsiveContainer width="100%" height={170}>
                  <AreaChart data={cumulativeData} margin={{ top: 8, right: 4, bottom: 0, left: -8 }}>
                    <defs>
                      <linearGradient id="statsCumulativeFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.32} />
                        <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--line)" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "var(--muted)", fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: "var(--line-strong)" }}
                      minTickGap={40}
                    />
                    <YAxis
                      tick={{ fill: "var(--muted)", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value: number) => `${value}时`}
                    />
                    <Tooltip
                      contentStyle={chartTooltipStyle()}
                      labelFormatter={(label, payload) =>
                        (payload?.[0]?.payload as { date?: string } | undefined)?.date ??
                        String(label ?? "")
                      }
                      formatter={(_value, _name, item) => [
                        formatDuration(
                          (item?.payload as { cumulativeSeconds?: number })?.cumulativeSeconds ?? 0,
                        ),
                        "累计阅读",
                      ]}
                    />
                    <Area
                      dataKey="hours"
                      type="monotone"
                      stroke="var(--accent)"
                      strokeWidth={2}
                      fill="url(#statsCumulativeFill)"
                      {...chartMotionProps(motionLevel)}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          <section className="stats-card stats-section" aria-label="文档时长排行">
            <div className="stats-section-head">
              <h2>文档排行</h2>
              <div className="stats-segment" role="group" aria-label="排行排序方式">
                <button type="button" aria-pressed={rankSort === "time"} onClick={() => setRankSort("time")}>
                  按时长
                </button>
                <button type="button" aria-pressed={rankSort === "recent"} onClick={() => setRankSort("recent")}>
                  按最近
                </button>
              </div>
            </div>
            <ol className="stats-ranking">{ranking.map(renderRanking)}</ol>
            {rankingAll.length > RANKING_LIMIT && (
              <button
                type="button"
                className="stats-expand"
                aria-expanded={rankExpanded}
                onClick={() => setRankExpanded((expanded) => !expanded)}
              >
                <ChevronDown size={13} aria-hidden="true" className={rankExpanded ? "is-flipped" : undefined} />
                {rankExpanded ? "收起" : `展开全部（${rankingAll.length}）`}
              </button>
            )}
          </section>

          <section className="stats-card stats-section" aria-label="阅读节奏">
            <div className="stats-section-head">
              <h2>阅读节奏</h2>
              <span className="stats-section-hint">
                {medianSitting > 0 ? `中位单次 ${formatDuration(medianSitting)}` : "每次打开的专注时长"}
              </span>
            </div>
            <div className="stats-share-bar" aria-hidden="true">
              {sessionDepth.map((entry) => (
                <span
                  key={entry.id}
                  style={{
                    width: entered
                      ? `${depthTotal > 0 ? (entry.seconds / depthTotal) * 100 : 0}%`
                      : "0%",
                    background: DEPTH_COLORS[entry.id],
                  }}
                />
              ))}
            </div>
            <ul className="stats-share-legend">
              {sessionDepth.map((entry) => (
                <li key={entry.id}>
                  <span
                    className="stats-share-dot"
                    style={{ background: DEPTH_COLORS[entry.id] }}
                    aria-hidden="true"
                  />
                  <span className="stats-share-name">
                    {SESSION_DEPTH_LABELS[entry.id]}
                    <span className="stats-share-range">{SESSION_DEPTH_RANGES[entry.id]}</span>
                  </span>
                  <strong>{entry.seconds > 0 ? formatDuration(entry.seconds) : "—"}</strong>
                  <span className="stats-share-pct">
                    {depthTotal > 0 ? Math.round((entry.seconds / depthTotal) * 100) : 0}%
                  </span>
                </li>
              ))}
            </ul>
          </section>
            </>
          )}

          {/* 知识地图与会话数据无关:空会话时同样渲染(定稿补记 §0.4)。 */}
          <section
            className="stats-card stats-section stats-span"
            aria-label="库覆盖率知识地图"
          >
            <div className="stats-section-head">
              <h2>知识地图</h2>
              <span className="stats-section-hint">
                当前文档库 · 面积 = 文本量 · 色深 = 到达覆盖率 · 点击文件夹下钻、文档直达
              </span>
            </div>
            <CoverageTreemap
              documents={documents}
              extents={extents}
              positions={readingPositions}
              motionLevel={motionLevel}
              onOpenDocument={openDocument}
            />
          </section>
        </div>
      )}

      {finishedOpen && (
        <StatsDrawer
          title="读完的文档"
          subtitle={`阅读进度达 ${Math.round(FINISHED_COVERAGE * 100)}% 以上 · ${finishedDocuments.length} 篇`}
          motionLevel={motionLevel}
          onClose={() => setFinishedOpen(false)}
        >
          <ul className="stats-drawer-docs">
            {finishedDocuments.map((entry) => (
              <li key={entry.relativePath}>
                <button
                  type="button"
                  className="stats-ranking-row"
                  title={`打开 ${entry.relativePath}`}
                  onClick={() => {
                    setFinishedOpen(false);
                    openDocument(entry.relativePath);
                  }}
                >
                  <span className="stats-ranking-main">
                    <span className="stats-ranking-title">{entry.title}</span>
                  </span>
                  <span className="stats-ranking-meta">
                    <strong>{Math.min(100, Math.round(entry.coverage * 100))}%</strong>
                    <span>{FORMAT_LABELS[entry.format]}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </StatsDrawer>
      )}
      {drillDay && !docDetail && (
        <DayDrawer
          dayKey={drillDay}
          sessions={loaded}
          existingPaths={existingPaths}
          currentRoot={rootPath}
          motionLevel={motionLevel}
          onClose={() => setDrillDay(null)}
          onOpenDocument={openDocument}
        />
      )}
      {docDetail && (
        <DocDrawer
          relativePath={docDetail.relativePath}
          libraryRoot={docDetail.libraryRoot}
          sessions={loaded}
          nowMs={now}
          exists={
            rankingSource(docDetail.libraryRoot, rootPath).canOpen &&
            existingPaths.has(docDetail.relativePath)
          }
          otherLibrary={rankingSource(docDetail.libraryRoot, rootPath).otherLibrary}
          folder={libraryFolderName(docDetail.libraryRoot)}
          motionLevel={motionLevel}
          onClose={() => setDocDetail(null)}
          onOpenDocument={openDocument}
        />
      )}
      {reportOpen && (
        <Suspense fallback={null}>
          <ReportDialog
            sessions={loaded}
            documents={documents}
            onClose={() => setReportOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

export default StatsView;
