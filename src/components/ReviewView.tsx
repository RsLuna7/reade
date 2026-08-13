import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Sparkles } from "lucide-react";
import {
  listReviewQueue,
  recordReviewOutcome,
  type Annotation,
  type ReviewQueueItem,
} from "../lib/backend";
import { annotationKindLabel } from "../lib/annotations";
import { annotationPositionLabel } from "../lib/annotationExport";
import {
  buildClozeCard,
  clozeBlankWidthEm,
  clozeModeForCard,
  type ReviewCardMode,
} from "../lib/clozeCard";
import { runMotion } from "../lib/motion";
import {
  DAILY_REVIEW_LIMIT,
  applyReviewOutcome,
  buildReviewQueue,
  type ReviewOutcome,
} from "../lib/reviewScheduler";
import { localDayKey } from "../lib/readingStats";
import { useReaderStore } from "../store/useReaderStore";

/**
 * 回顾会话由 App 以内存 state 持有(方案二 §3.5):「打开原文」跳转离开
 * 视图后同日返回可续接;跨重启不保留,重开按当日种子重建。
 */
export interface ReviewSession {
  /** 本地日键(localDayKey);跨日后的旧会话作废重建。 */
  dayKey: string;
  queue: ReviewQueueItem[];
  /** 当前卡片下标;≥ queue.length 表示本批完成。 */
  cursor: number;
  /** 今日累计完成数(跨「再来一批」累计;suspend 与写回失败不计)。 */
  reviewedCount: number;
}

interface ReviewViewProps {
  session: ReviewSession | null;
  onSessionChange: (session: ReviewSession) => void;
  /** 「打开原文」:复用全库标注的跳转链(选中文档 + 定位标注)。 */
  onOpenAnnotation: (annotation: Annotation) => void;
  onExit: () => void;
  /** 测试注入的时钟;默认 Date.now。 */
  now?: () => number;
}

/**
 * 空队列时向前看这么远,取最早的未来到期日:Leitner 阶梯最长间隔 60 天,
 * 因此 61 天窗口必然覆盖回顾池中所有未来到期的批注。
 */
const UPCOMING_WINDOW_MS = 61 * 24 * 60 * 60 * 1000;

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function formatDueDate(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(date);
}

const CARD_MODE_OPTIONS: ReadonlyArray<{ value: ReviewCardMode; label: string }> = [
  { value: "excerpt", label: "摘录" },
  { value: "cloze", label: "挖空" },
  { value: "mixed", label: "混合" },
];

export function ReviewView({
  session,
  onSessionChange,
  onOpenAnnotation,
  onExit,
  now = Date.now,
}: ReviewViewProps) {
  const documents = useReaderStore((state) => state.documents);
  const motionLevel = useReaderStore((state) => state.motionLevel);
  const reviewCardMode = useReaderStore((state) => state.reviewCardMode);
  const setReviewCardMode = useReaderStore((state) => state.setReviewCardMode);
  // 同日会话直接续接,否则(首次进入/跨日)在挂载时重建队列。
  const [loading, setLoading] = useState(
    () => !(session && session.dayKey === localDayKey(now())),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nextDueAt, setNextDueAt] = useState<number | null>(null);
  /**
   * 挖空档的揭示态(plan-cloze-review §3.2):记录"已揭示的卡片键"而非
   * 布尔值,换卡/切档时键不再匹配即自动回到遮蔽态——避免 effect 重置
   * 造成新卡答案闪现一帧。
   */
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const busyRef = useRef(false);
  const answerRef = useRef<HTMLElement | null>(null);

  const documentTitles = useMemo(
    () => new Map(documents.map((document) => [document.relativePath, document.title])),
    [documents],
  );

  const loadBatch = useCallback(
    async (previousReviewedCount: number) => {
      setLoading(true);
      setLoadError(null);
      const nowMs = now();
      try {
        // 超取(wrapper ×3)后用同文档打散的纯函数裁到每日上限。
        const candidates = await listReviewQueue(nowMs, DAILY_REVIEW_LIMIT);
        const queue = buildReviewQueue(candidates, nowMs, DAILY_REVIEW_LIMIT);
        if (queue.length === 0) {
          const upcoming = await listReviewQueue(nowMs + UPCOMING_WINDOW_MS, DAILY_REVIEW_LIMIT);
          const futureDues = upcoming
            .map((item) => item.review.dueAt)
            .filter((dueAt) => dueAt > nowMs);
          setNextDueAt(futureDues.length ? Math.min(...futureDues) : null);
        } else {
          setNextDueAt(null);
        }
        // 新一批从遮蔽态开始:防写回失败的同卡在新批 cursor 0 上复用旧揭示键。
        setRevealedKey(null);
        onSessionChange({
          dayKey: localDayKey(nowMs),
          queue,
          cursor: 0,
          reviewedCount: previousReviewedCount,
        });
      } catch (cause) {
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [now, onSessionChange],
  );

  useEffect(() => {
    if (session && session.dayKey === localDayKey(now())) return;
    void loadBatch(0);
    // 仅挂载时判定一次:离开视图即卸载,再次进入重新走这里。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentItem =
    session && session.cursor < session.queue.length ? session.queue[session.cursor] : null;

  /**
   * 当前卡的挖空构造(CZ-D4:每次确定性重算,零持久化):档位对该卡
   * 不生效或摘录不可挖空(CZ-D5)时为 null,按摘录档渲染。
   */
  const clozeCard = useMemo(() => {
    if (!currentItem) return null;
    if (clozeModeForCard(currentItem.annotation.id, reviewCardMode) !== "cloze") return null;
    return buildClozeCard(currentItem.annotation.selectedText ?? "");
  }, [currentItem, reviewCardMode]);

  const cardKey =
    session && currentItem
      ? `${session.cursor}:${currentItem.annotation.id}:${reviewCardMode}`
      : null;
  const revealed = cardKey !== null && revealedKey === cardKey;
  // 揭示前评分锁(CZ-D2):保证"先想后看"。
  const gradingLocked = clozeCard !== null && !revealed;

  const reveal = useCallback(() => setRevealedKey(cardKey), [cardKey]);

  // 揭示动效(subtle 档淡入;off 档由 runMotion 内部跳过)。
  useEffect(() => {
    if (!revealed || !answerRef.current) return;
    runMotion(
      answerRef.current,
      "cloze-reveal",
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: motionLevel === "subtle" ? 160 : 240, easing: "ease-out" },
      motionLevel,
    );
  }, [motionLevel, revealed]);

  const grade = useCallback(
    async (outcome: ReviewOutcome) => {
      if (!session || busyRef.current) return;
      const item = session.queue[session.cursor];
      if (!item) return;
      busyRef.current = true;
      try {
        const nextState = applyReviewOutcome(item.review, outcome, now());
        let counted = outcome !== "suspend";
        try {
          await recordReviewOutcome(item.annotation.id, nextState);
        } catch {
          // 批注可能在回顾中途被删除:写回失败静默跳过该卡前进(§3.5)。
          counted = false;
        }
        onSessionChange({
          ...session,
          cursor: session.cursor + 1,
          reviewedCount: session.reviewedCount + (counted ? 1 : 0),
        });
      } finally {
        busyRef.current = false;
      }
    },
    [now, onSessionChange, session],
  );

  const suspendCurrent = useCallback(() => {
    if (!currentItem) return;
    const confirmed = window.confirm("不再回顾这条标注？它将不再出现在每日回顾中。");
    if (!confirmed) return;
    void grade("suspend");
  }, [currentItem, grade]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onExit();
        return;
      }
      if (!currentItem) return;
      // 焦点在按钮上时 Space/Enter 交给原生激活,避免双触发。
      const onButton = target?.tagName === "BUTTON";
      if (event.key === "1" || (event.key === " " && !onButton)) {
        event.preventDefault();
        // 揭示前评分锁(CZ-D7):空格先揭示,数字键静默忽略。
        if (gradingLocked) {
          if (event.key === " ") reveal();
          return;
        }
        void grade("remembered");
      } else if (event.key === "2") {
        event.preventDefault();
        if (gradingLocked) return;
        void grade("again");
      } else if (event.key === "Enter" && !onButton) {
        event.preventDefault();
        onOpenAnnotation(currentItem.annotation);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentItem, grade, gradingLocked, onExit, onOpenAnnotation, reveal]);

  const queueLength = session?.queue.length ?? 0;
  const reviewedCount = session?.reviewedCount ?? 0;

  let body;
  if (loading) {
    body = (
      <div className="review-state">
        <span className="spinner" aria-hidden="true" />
        正在准备回顾队列…
      </div>
    );
  } else if (loadError) {
    body = (
      <div className="review-complete" role="alert">
        <p className="review-complete-title">无法加载回顾队列</p>
        <p className="review-complete-hint">{loadError}</p>
        <div className="review-complete-actions">
          <button type="button" onClick={() => void loadBatch(reviewedCount)}>
            重试
          </button>
          <button type="button" onClick={onExit}>
            回到主页
          </button>
        </div>
      </div>
    );
  } else if (currentItem) {
    const annotation = currentItem.annotation;
    const source = [
      documentTitles.get(annotation.relativePath) ?? fileName(annotation.relativePath),
      annotationPositionLabel(annotation),
    ]
      .filter(Boolean)
      .join(" · ");
    body = (
      <>
        <div className="review-mode-switch" role="radiogroup" aria-label="回顾卡片样式">
          {CARD_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={reviewCardMode === option.value}
              onClick={() => {
                // 切档重置揭示态(CZ-D10):切回挖空档也从遮蔽开始。
                setRevealedKey(null);
                setReviewCardMode(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <article className="review-card" aria-label="回顾卡片">
          <span
            className={`annotation-list-kind annotation-list-kind--${annotation.kind}${
              annotation.color ? ` annotation-list-kind--${annotation.color}` : ""
            }`}
          >
            {annotationKindLabel(annotation.kind)}
          </span>
          <blockquote className="review-excerpt">
            {clozeCard ? (
              revealed ? (
                <>
                  {clozeCard.prefix}
                  <mark ref={answerRef} className="review-cloze-answer">
                    {clozeCard.blank}
                  </mark>
                  {clozeCard.suffix}
                </>
              ) : (
                <>
                  {clozeCard.prefix}
                  <button
                    type="button"
                    className="review-cloze-blank"
                    style={{ minWidth: `${clozeBlankWidthEm(clozeCard.blank)}em` }}
                    title="揭示被挖空的片段（空格）"
                    onClick={reveal}
                  >
                    点击回想答案
                  </button>
                  {clozeCard.suffix}
                </>
              )
            ) : (
              annotation.selectedText
            )}
          </blockquote>
          {annotation.note ? <p className="review-note">{annotation.note}</p> : null}
          <p className="review-source">{source}</p>
        </article>
        <div className="review-actions">
          <button
            type="button"
            className="review-primary"
            onClick={() => void grade("remembered")}
            disabled={gradingLocked}
            title={gradingLocked ? "先回想，揭示答案后再评分" : undefined}
          >
            记住了
            <kbd aria-hidden="true">1</kbd>
          </button>
          <button
            type="button"
            onClick={() => void grade("again")}
            disabled={gradingLocked}
            title={gradingLocked ? "先回想，揭示答案后再评分" : undefined}
          >
            再看一次
            <kbd aria-hidden="true">2</kbd>
          </button>
        </div>
        <div className="review-secondary">
          <button type="button" onClick={() => onOpenAnnotation(annotation)}>
            打开原文
          </button>
          <button type="button" onClick={suspendCurrent}>
            不再回顾
          </button>
        </div>
      </>
    );
  } else if (queueLength > 0) {
    body = (
      <div className="review-complete">
        <Sparkles size={18} aria-hidden="true" />
        <p className="review-complete-title">这批回顾完成</p>
        <p className="review-complete-hint">今日已回顾 {reviewedCount} 条标注。</p>
        <div className="review-complete-actions">
          <button
            type="button"
            className="review-primary"
            onClick={() => void loadBatch(reviewedCount)}
          >
            再来一批
          </button>
          <button type="button" onClick={onExit}>
            回到主页
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="review-complete">
        <p className="review-complete-title">今天没有待回顾的标注。</p>
        {reviewedCount > 0 ? (
          <p className="review-complete-hint">今日已回顾 {reviewedCount} 条标注。</p>
        ) : null}
        <p className="review-complete-hint">
          {nextDueAt !== null
            ? `下次最早到期：${formatDueDate(nextDueAt)}`
            : "在正文中划几条高亮或下划线，明天就会出现在这里。"}
        </p>
        <div className="review-complete-actions">
          <button type="button" onClick={onExit}>
            回到主页
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="review-view" aria-label="每日回顾">
      <header className="review-header">
        <button
          className="icon-button"
          type="button"
          aria-label="退出回顾"
          title="退出回顾（Esc）"
          onClick={onExit}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <div className="review-heading">
          <h1>每日回顾</h1>
          <span>
            {currentItem && session
              ? `回味你划下的段落 · ${session.cursor + 1} / ${queueLength}`
              : "回味你划下的段落"}
          </span>
        </div>
      </header>
      {body}
    </div>
  );
}

export default ReviewView;
