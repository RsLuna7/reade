import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { BookOpen, Clock3, FilePlus2, Flame, Sparkles } from "lucide-react";
import {
  APP_RUNTIME,
  listReadingSessions,
  type DocumentFormat,
  type ReadingSession,
} from "../lib/backend";
import {
  buildContinueReading,
  buildFreshDocuments,
  buildWebContinueReading,
  normalizeModifiedMs,
  readHomeBaseline,
  type HomeProgress,
} from "../lib/homeData";
import { listLibraryReadingPositions } from "../lib/readingPositions";
import { buildSummary, formatDuration } from "../lib/readingStats";
import { runMotion } from "../lib/motion";
import { useReaderStore } from "../store/useReaderStore";

const IS_WEB_RUNTIME = APP_RUNTIME === "web";
const DAY_MS = 24 * 60 * 60 * 1000;

const FORMAT_LABELS: Record<DocumentFormat, string> = {
  markdown: "Markdown",
  mdx: "MDX",
  pdf: "PDF",
  epub: "EPUB",
};

/**
 * ④「今日回顾」的扩展点(home-view plan §3.3):数据接口由批注回顾方案
 * 提供;探测结果为 null / 未提供时整卡不渲染,不留死 UI。
 */
export interface HomeReviewSummary {
  pendingCount: number;
  /** 今日已完成的回顾数;pendingCount 为 0 时用于「已完成」态文案。 */
  reviewedToday?: number;
  onStart: () => void;
}

export interface HomeViewProps {
  reviewSummary?: HomeReviewSummary | null;
  /** Injectable session source for harnesses/tests; defaults to the backend. */
  loadSessions?: (fromMs: number, toMs: number) => Promise<ReadingSession[]>;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Coarse relative time for card rows; falls back to a date for old stamps. */
export function formatRelativeTime(ms: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - ms);
  if (delta < 60_000) return "刚刚";
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < DAY_MS) return `${Math.floor(delta / (60 * 60_000))} 小时前`;
  if (delta < 2 * DAY_MS) return "昨天";
  if (delta < 30 * DAY_MS) return `${Math.floor(delta / DAY_MS)} 天前`;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

function progressLabel(progress: HomeProgress | null): string | null {
  if (!progress) return null;
  if (progress.kind === "page") return `读到第 ${progress.page} 页`;
  const percent = Math.round(progress.value * 100);
  return percent > 0 ? `读到 ${percent}%` : null;
}

/** 与 StatsView 的 stats-enter 同一套入场动效等级(motionLevel 体系)。 */
function staggerStyle(index: number): CSSProperties {
  return { "--stats-delay": `${index * 70}ms` } as CSSProperties;
}

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

export function HomeView({ reviewSummary = null, loadSessions = listReadingSessions }: HomeViewProps) {
  const snapshot = useReaderStore((state) => state.snapshot);
  const documents = useReaderStore((state) => state.documents);
  const motionLevel = useReaderStore((state) => state.motionLevel);
  const dailyGoalMinutes = useReaderStore((state) => state.dailyGoalMinutes);
  const selectDocument = useReaderStore((state) => state.selectDocument);

  const rootPath = snapshot?.rootPath ?? null;
  // Web 构建没有会话存储(listReadingSessions 直接 reject),从初始状态起
  // 就视为"已加载空数据",后面的 effect 也绝不发起调用。
  const [sessions, setSessions] = useState<ReadingSession[] | null>(IS_WEB_RUNTIME ? [] : null);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (IS_WEB_RUNTIME) return;
    if (!rootPath) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    setSessions(null);
    const requestedAt = Date.now();
    loadSessions(0, requestedAt + DAY_MS)
      .then((data) => {
        if (cancelled) return;
        setSessions(data);
        setNow(requestedAt);
      })
      .catch(() => {
        // 主页是行动入口而非诊断页:读取失败时静默降级为空历史。
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, loadSessions]);

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

  const positions = useMemo(
    () => (rootPath ? listLibraryReadingPositions(rootPath) : {}),
    [rootPath],
  );
  // Baseline 在离开主页时才推进(App 负责),所以停留期间列表保持稳定。
  const baseline = useMemo(() => (rootPath ? readHomeBaseline(rootPath) : null), [rootPath]);

  const loaded = useMemo(() => sessions ?? [], [sessions]);
  const loading = sessions === null;
  const continueItems = useMemo(
    () =>
      IS_WEB_RUNTIME
        ? buildWebContinueReading(documents, positions)
        : buildContinueReading(loaded, documents, positions, now),
    [documents, loaded, now, positions],
  );
  const fresh = useMemo(() => buildFreshDocuments(documents, baseline), [baseline, documents]);
  const summary = useMemo(() => buildSummary(loaded, now), [loaded, now]);

  const goalSeconds = dailyGoalMinutes * 60;
  const goalProgress = goalSeconds > 0 ? summary.todaySeconds / goalSeconds : 0;
  const dateLabel = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(now));

  const openDocument = (relativePath: string) => {
    // selectDocument 自动切回阅读面(store 契约)。
    void selectDocument(relativePath);
  };

  let cardIndex = 0;

  return (
    <div className="home-view" aria-label="主页" ref={rootRef}>
      <header className="home-header">
        <div className="home-heading">
          <h1>今日</h1>
          <span>{dateLabel}{rootPath ? ` · ${fileName(rootPath)}` : ""}</span>
        </div>
      </header>

      <div className="home-grid">
        <section
          className="home-card stats-enter"
          style={staggerStyle(cardIndex++)}
          aria-label="继续阅读"
        >
          <div className="home-card-head">
            <h2>
              <BookOpen size={15} aria-hidden="true" />
              继续阅读
            </h2>
            {!IS_WEB_RUNTIME && continueItems.length > 0 && (
              <span className="home-card-hint">近 30 天</span>
            )}
          </div>
          {loading ? (
            <p className="home-card-empty">正在加载阅读记录…</p>
          ) : continueItems.length > 0 ? (
            <ol className="home-continue-list">
              {continueItems.map((item) => {
                const progress = progressLabel(item.progress);
                return (
                  <li key={item.relativePath}>
                    <button
                      type="button"
                      className="home-continue-row"
                      title={`继续阅读 ${item.relativePath}`}
                      onClick={() => openDocument(item.relativePath)}
                    >
                      <span className="home-continue-title">
                        {item.title ?? fileName(item.relativePath)}
                      </span>
                      <span className="home-continue-meta">
                        <span className="home-format-badge">{FORMAT_LABELS[item.format]}</span>
                        <span>{formatRelativeTime(item.lastReadAt, now)}</span>
                        {item.totalSeconds > 0 && <span>{formatDuration(item.totalSeconds)}</span>}
                        {progress && <span className="home-continue-progress">{progress}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="home-card-empty">
              {documents.length > 0
                ? "还没有阅读记录，从左侧选择一篇文档开始。"
                : "文档库为空。"}
            </p>
          )}
        </section>

        {!IS_WEB_RUNTIME && (
          <section
            className="home-card stats-enter"
            style={staggerStyle(cardIndex++)}
            aria-label="今日进度"
          >
            <div className="home-card-head">
              <h2>
                <Clock3 size={15} aria-hidden="true" />
                今日进度
              </h2>
            </div>
            {loading ? (
              <p className="home-card-empty">正在加载阅读记录…</p>
            ) : (
              <>
                <div className="home-progress-value">
                  <strong>{formatDuration(summary.todaySeconds)}</strong>
                  {goalSeconds > 0 && <GoalRing progress={goalProgress} />}
                </div>
                <p className="home-progress-hint">
                  {goalSeconds > 0
                    ? `目标 ${dailyGoalMinutes} 分 · 完成 ${Math.round(goalProgress * 100)}%`
                    : summary.todaySeconds > 0
                      ? "未设定每日目标"
                      : "今天还没有开始阅读"}
                </p>
                {summary.currentStreakDays > 0 && (
                  <p className="home-progress-streak">
                    <Flame size={13} aria-hidden="true" />
                    连续阅读 {summary.currentStreakDays} 天
                  </p>
                )}
              </>
            )}
          </section>
        )}

        <section
          className="home-card stats-enter"
          style={staggerStyle(cardIndex++)}
          aria-label="库内新动态"
        >
          <div className="home-card-head">
            <h2>
              <FilePlus2 size={15} aria-hidden="true" />
              库内新动态
            </h2>
            {fresh.count > 0 && <span className="home-card-hint">{fresh.count} 篇有更新</span>}
          </div>
          {fresh.items.length > 0 ? (
            <ol className="home-continue-list">
              {fresh.items.map((document) => (
                <li key={document.relativePath}>
                  <button
                    type="button"
                    className="home-continue-row"
                    title={`打开 ${document.relativePath}`}
                    onClick={() => openDocument(document.relativePath)}
                  >
                    <span className="home-continue-title">{document.title}</span>
                    <span className="home-continue-meta">
                      <span className="home-format-badge">{FORMAT_LABELS[document.format]}</span>
                      <span>{formatRelativeTime(normalizeModifiedMs(document.modified), now)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="home-card-empty">
              {baseline === null
                ? "从下次来访开始，这里会列出库里新增或修改的文档。"
                : "自上次来访以来没有新变化。"}
            </p>
          )}
        </section>

        {reviewSummary && (
          <section
            className="home-card stats-enter"
            style={staggerStyle(cardIndex++)}
            aria-label="今日回顾"
          >
            <div className="home-card-head">
              <h2>
                <Sparkles size={15} aria-hidden="true" />
                今日回顾
              </h2>
            </div>
            {reviewSummary.pendingCount > 0 ? (
              <>
                <p className="home-progress-hint">待回顾 {reviewSummary.pendingCount} 条标注</p>
                <button
                  type="button"
                  className="home-review-start"
                  onClick={reviewSummary.onStart}
                >
                  开始回顾
                </button>
              </>
            ) : (
              <p className="home-progress-hint">
                今天的回顾已完成
                {reviewSummary.reviewedToday ? `，共回顾 ${reviewSummary.reviewedToday} 条` : ""}。
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export default HomeView;
