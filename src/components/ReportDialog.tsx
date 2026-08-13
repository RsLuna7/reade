/**
 * 阅读报告卡片预览对话框（docs/plan-reading-report-cards.md §3.3）。
 * 范围三档（本月/今年/上一年，RC-D3），活跃天不足 7 的档禁用（RC-D4）；
 * 卡片由 renderReportCards 一次性生成，预览即导出物本身。出口沿金句卡：
 * 剪贴板 PNG 为主、a[download] 兜底；"全部下载"逐张触发既有下载出口。
 * 桌面专属（入口在 StatsView）；反馈用对话框内 status 行，不新增全局通道。
 */

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  listAnnotations,
  type Annotation,
  type DocumentInfo,
  type ReadingSession,
} from "../lib/backend";
import { copyImageToClipboard, downloadBlobFile, readCardTheme } from "../lib/quoteCard";
import {
  buildReadingReport,
  monthReportRange,
  previousYearReportRange,
  rangeActiveDays,
  REPORT_MIN_ACTIVE_DAYS,
  yearReportRange,
  type ReportRange,
} from "../lib/readingReport";
import { renderReportCards, type RenderedReportCard } from "../lib/reportCards";

export interface ReportDialogProps {
  sessions: ReadingSession[];
  documents: DocumentInfo[];
  onClose: () => void;
  /** 测试可注入；默认全库标注（桌面 SQLite）。 */
  loadAnnotations?: () => Promise<Annotation[]>;
}

type RangeKey = "month" | "year" | "prevYear";

interface RangeOption {
  key: RangeKey;
  label: string;
  range: ReportRange;
  enabled: boolean;
}

type CardsState =
  | { status: "loading" }
  | { status: "insufficient" }
  | { status: "error"; message: string }
  | { status: "ready"; cards: Array<RenderedReportCard & { url: string }> };

export function ReportDialog({
  sessions,
  documents,
  onClose,
  loadAnnotations = listAnnotations,
}: ReportDialogProps) {
  const [nowMs] = useState(() => Date.now());
  const options = useMemo<RangeOption[]>(() => {
    const entries: Array<[RangeKey, string, ReportRange]> = [
      ["month", "本月", monthReportRange(nowMs)],
      ["year", "今年", yearReportRange(nowMs)],
      ["prevYear", "上一年", previousYearReportRange(nowMs)],
    ];
    return entries.map(([key, label, range]) => ({
      key,
      label,
      range,
      enabled: rangeActiveDays(sessions, range) >= REPORT_MIN_ACTIVE_DAYS,
    }));
  }, [nowMs, sessions]);

  // 默认选中"今年"（Wrapped 语义），不足时回落到首个可用档。
  const [rangeKey, setRangeKey] = useState<RangeKey>(() => {
    const year = options.find((option) => option.key === "year");
    if (year?.enabled) return "year";
    return options.find((option) => option.enabled)?.key ?? "year";
  });
  const active = options.find((option) => option.key === rangeKey) ?? options[1];

  const [annotations, setAnnotations] = useState<Annotation[] | null>(null);
  const [annotationsFailed, setAnnotationsFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadAnnotations()
      .then((data) => {
        if (!cancelled) setAnnotations(data);
      })
      .catch(() => {
        // 标注读不到时报告仍可生成(金句/划线维度缺席),不整体失败。
        if (!cancelled) {
          setAnnotations([]);
          setAnnotationsFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadAnnotations]);

  const report = useMemo(() => {
    if (annotations === null || !active.enabled) return null;
    return buildReadingReport({ sessions, annotations, documents, range: active.range });
  }, [active.enabled, active.range, annotations, documents, sessions]);

  const [cards, setCards] = useState<CardsState>({ status: "loading" });
  const [activeCard, setActiveCard] = useState(0);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStatusLine(null);
    setActiveCard(0);
    if (annotations === null) {
      setCards({ status: "loading" });
      return;
    }
    if (!active.enabled || report === null) {
      setCards({ status: "insufficient" });
      return;
    }
    let cancelled = false;
    let urls: string[] = [];
    setCards({ status: "loading" });
    renderReportCards(report, readCardTheme())
      .then((rendered) => {
        if (cancelled) return;
        const withUrls = rendered.map((card) => {
          const url = URL.createObjectURL(card.blob);
          urls.push(url);
          return { ...card, url };
        });
        setCards({ status: "ready", cards: withUrls });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setCards({
            status: "error",
            message: cause instanceof Error ? cause.message : "报告卡片渲染失败",
          });
        }
      });
    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
      urls = [];
    };
  }, [active.enabled, annotations, report]);

  const current = cards.status === "ready" ? cards.cards[activeCard] ?? cards.cards[0] : null;

  const handleCopy = async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const copied = await copyImageToClipboard(current.blob);
      setStatusLine(
        copied
          ? `已复制「${current.title}」卡片，可直接粘贴。`
          : "复制失败，可能被系统或剪贴板工具拦截；可改用下载保存。",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = () => {
    if (!current) return;
    downloadBlobFile(current.fileName, current.blob);
    setStatusLine(`已开始下载「${current.title}」卡片。`);
  };

  const handleDownloadAll = () => {
    if (cards.status !== "ready") return;
    for (const card of cards.cards) downloadBlobFile(card.fileName, card.blob);
    setStatusLine(`已开始下载全部 ${cards.cards.length} 张卡片。`);
  };

  return (
    <div className="report-dialog reade-motion-panel" role="dialog" aria-label="阅读报告">
      <div className="settings-heading">
        <span>阅读报告</span>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭阅读报告">
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="report-range-toggle" role="group" aria-label="报告周期">
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            className={rangeKey === option.key ? "active" : undefined}
            aria-pressed={rangeKey === option.key}
            disabled={!option.enabled}
            title={
              option.enabled
                ? option.range.label
                : `该周期活跃阅读日不足 ${REPORT_MIN_ACTIVE_DAYS} 天`
            }
            onClick={() => setRangeKey(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="report-preview" aria-live="polite">
        {cards.status === "loading" && (
          <div className="quote-card-state" role="status">
            <span className="spinner" aria-hidden="true" />
            正在生成报告卡片…
          </div>
        )}
        {cards.status === "insufficient" && (
          <div className="quote-card-state" role="status">
            {active.range.label}的活跃阅读日不足 {REPORT_MIN_ACTIVE_DAYS} 天，攒一攒再来生成报告。
          </div>
        )}
        {cards.status === "error" && (
          <div className="quote-card-state quote-card-state--error" role="alert">
            {cards.message}
          </div>
        )}
        {cards.status === "ready" && current && (
          <img src={current.url} alt={`${current.title}卡片预览`} />
        )}
      </div>
      {cards.status === "ready" && (
        <div className="report-thumbs" role="group" aria-label="切换卡片">
          {cards.cards.map((card, index) => (
            <button
              key={card.id}
              type="button"
              className={index === activeCard ? "active" : undefined}
              aria-pressed={index === activeCard}
              onClick={() => setActiveCard(index)}
            >
              <img src={card.url} alt="" aria-hidden="true" />
              <span>{card.title}</span>
            </button>
          ))}
        </div>
      )}
      {annotationsFailed && (
        <p className="quote-card-hint" role="status">
          标注数据读取失败，书单与金句维度已省略。
        </p>
      )}
      {statusLine && (
        <p className="quote-card-hint" role="status">
          {statusLine}
        </p>
      )}
      <div className="quote-card-actions">
        <button
          type="button"
          className="quote-card-download"
          disabled={cards.status !== "ready"}
          onClick={handleDownloadAll}
        >
          全部下载
        </button>
        <button
          type="button"
          className="quote-card-download"
          disabled={!current}
          onClick={handleDownload}
        >
          下载本张
        </button>
        <button
          type="button"
          className="quote-card-copy"
          disabled={!current || busy}
          onClick={() => void handleCopy()}
        >
          {busy ? "正在复制…" : "复制本张"}
        </button>
      </div>
    </div>
  );
}

export default ReportDialog;
