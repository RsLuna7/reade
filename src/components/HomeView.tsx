import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { BookOpen, CalendarClock, Clock3, FilePlus2, Flame } from "lucide-react";
import {
  APP_RUNTIME,
  listAnnotations,
  listReadingSessions,
  type Annotation,
  type DocumentFormat,
  type ReadingSession,
} from "../lib/backend";
import { annotationKindLabel } from "../lib/annotations";
import {
  CONTINUE_READING_LIMIT,
  buildContinueReading,
  buildFreshDocuments,
  buildWebContinueReading,
  normalizeModifiedMs,
  readHomeBaseline,
  type HomeProgress,
} from "../lib/homeData";
import { buildOnThisDay } from "../lib/onThisDay";
import { listLibraryReadingPositions } from "../lib/readingPositions";
import { buildSummary, dayKeyToDate, formatDuration, sessionsInLibrary } from "../lib/readingStats";
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
 * Interval review is opened from 全库摘录 or the command palette
 * (annotation redesign §3.4); Home does not show a due card.
 */
export interface HomeViewProps {
  loadSessions?: (fromMs: number, toMs: number) => Promise<ReadingSession[]>;
  /**
   * 阅读时间预估(plan-reading-time-estimate §3.3):继续阅读卡的
   * "剩余约 N 分钟"文案;返回 null(读完/无数据)不渲染。
   */
  remainingEstimate?: (relativePath: string, progress: HomeProgress | null) => string | null;
  /** 「那年今日」的标注源(plan-on-this-day OD-D9);可注入供测试。 */
  loadAnnotations?: () => Promise<Annotation[]>;
  /**
   * 「那年今日」标注行的跳转链(OD-D8):App 传全库标注同款
   * `handleSelectLibraryAnnotation`;缺席时回落为仅打开文档。
   */
  onOpenAnnotation?: (annotation: Annotation) => void;
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

export function HomeView({
  loadSessions = listReadingSessions,
  remainingEstimate,
  loadAnnotations = listAnnotations,
  onOpenAnnotation,
}: HomeViewProps) {
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

  // 「那年今日」的标注源:挂载时一次全库读取(标注中枢同量级,OD-D9),
  // 失败静默降级为空——主页是行动入口而非诊断页。
  const [memoryAnnotations, setMemoryAnnotations] = useState<Annotation[] | null>(null);
  useEffect(() => {
    if (!rootPath) {
      setMemoryAnnotations([]);
      return;
    }
    let cancelled = false;
    setMemoryAnnotations(null);
    loadAnnotations()
      .then((data) => {
        if (!cancelled) setMemoryAnnotations(data);
      })
      .catch(() => {
        if (!cancelled) setMemoryAnnotations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, loadAnnotations]);

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
        : buildContinueReading(
            loaded,
            documents,
            positions,
            now,
            CONTINUE_READING_LIMIT,
            rootPath ?? undefined,
          ),
    [documents, loaded, now, positions, rootPath],
  );
  const fresh = useMemo(() => buildFreshDocuments(documents, baseline), [baseline, documents]);
  const summary = useMemo(() => buildSummary(loaded, now), [loaded, now]);

  // 那年今日:标注与会话都就绪后才计算;空数组 = 整卡不渲染(OD-D3)。
  const memoryGroups = useMemo(
    () =>
      memoryAnnotations === null || sessions === null
        ? []
        : buildOnThisDay({
            annotations: memoryAnnotations,
            sessions: rootPath ? sessionsInLibrary(loaded, rootPath) : loaded,
            documents,
            nowMs: now,
          }),
    [documents, loaded, memoryAnnotations, now, sessions],
  );

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

  const openAnnotation = (annotation: Annotation) => {
    if (onOpenAnnotation) onOpenAnnotation(annotation);
    else openDocument(annotation.relativePath);
  };

  const memoryDateLabel = (dayKey: string) =>
    new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(dayKeyToDate(dayKey));

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
                const remaining = remainingEstimate?.(item.relativePath, item.progress) ?? null;
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
                        {remaining && (
                          <span className="home-continue-estimate">{remaining}</span>
                        )}
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

        {memoryGroups.length > 0 && (
          <section
            className="home-card stats-enter"
            style={staggerStyle(cardIndex++)}
            aria-label="那年今日"
          >
            <div className="home-card-head">
              <h2>
                <CalendarClock size={15} aria-hidden="true" />
                那年今日
              </h2>
            </div>
            <div className="home-memory-groups">
              {memoryGroups.map((group) => (
                <div key={group.key} className="home-memory-group">
                  <div className="home-memory-head">
                    <span className="home-memory-label">{group.label}的今天</span>
                    <span className="home-card-hint">{memoryDateLabel(group.dayKey)}</span>
                  </div>
                  <ol className="home-continue-list">
                    {group.entries.map((entry) =>
                      entry.kind === "annotation" ? (
                        <li key={`annotation-${entry.annotation.id}`}>
                          <button
                            type="button"
                            className="home-continue-row"
                            title={`跳回 ${entry.docTitle} 中的这条标注`}
                            onClick={() => openAnnotation(entry.annotation)}
                          >
                            <span className="home-memory-excerpt">{entry.excerpt}</span>
                            <span className="home-continue-meta">
                              <span
                                className={`annotation-list-kind annotation-list-kind--${entry.annotation.kind}${
                                  entry.annotation.color
                                    ? ` annotation-list-kind--${entry.annotation.color}`
                                    : ""
                                }`}
                              >
                                {annotationKindLabel(entry.annotation.kind)}
                              </span>
                              <span className="home-memory-doc">{entry.docTitle}</span>
                            </span>
                          </button>
                        </li>
                      ) : (
                        <li key={`document-${entry.relativePath}`}>
                          <button
                            type="button"
                            className="home-continue-row"
                            title={`打开 ${entry.relativePath}`}
                            onClick={() => openDocument(entry.relativePath)}
                          >
                            <span className="home-continue-title">{entry.title}</span>
                            <span className="home-continue-meta">
                              <span className="home-format-badge">
                                {FORMAT_LABELS[entry.format]}
                              </span>
                              <span>当天读了 {formatDuration(entry.activeSeconds)}</span>
                            </span>
                          </button>
                        </li>
                      ),
                    )}
                  </ol>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export default HomeView;
