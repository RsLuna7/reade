/**
 * Quote card preview dialog (docs/plan-quote-cards.md §3.1, decision QC-D5):
 * a centered `reade-motion-panel` showing the rendered card. The preview img
 * IS the export blob (one rendering pass, no drift); the primary action
 * copies the PNG to the clipboard (QC-D1), the secondary action downloads it
 * (QC-D2 fallback). Two curated styles, nothing else configurable (QC-D4).
 *
 * Mounted lazily by App both for live selections (M1) and for existing
 * highlight/underline annotations (M2) — the source is just text + title.
 *
 * plan-pdf-region-card RG-D3: the source is a discriminated union; the
 * `kind: "region"` variant previews a cropped PDF bitmap through
 * `renderRegionCard` (single curated layout, so the style toggle hides),
 * reusing the same copy/download exits and error states.
 */

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { regionCardFileName } from "../lib/pdfRegion";
import {
  copyImageToClipboard,
  downloadBlobFile,
  quoteCardFileName,
  readCardTheme,
  renderQuoteCardDetailed,
} from "../lib/quoteCard";
import { formatCardDateLabel, type CardStyleId } from "../lib/quoteCardLayout";
import { renderRegionCard, type RegionImageSource } from "../lib/regionCard";

export type QuoteCardSource =
  | { kind?: "quote"; quote: string; sourceTitle: string }
  | { kind: "region"; image: RegionImageSource; sourceTitle: string; page: number };

const CARD_STYLE_OPTIONS: ReadonlyArray<[CardStyleId, string]> = [
  ["plain", "素笺"],
  ["serif", "衬线中轴"],
];

type CardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; blob: Blob; url: string; truncated: boolean };

export function QuoteCardDialog({
  source,
  onClose,
  onNotice,
}: {
  source: QuoteCardSource;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const [styleId, setStyleId] = useState<CardStyleId>("plain");
  const [card, setCard] = useState<CardState>({ status: "loading" });
  const [copyFailed, setCopyFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const isRegion = source.kind === "region";
  const dialogTitle = isRegion ? "引用卡片" : "金句卡片";

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setCard({ status: "loading" });
    setCopyFailed(false);
    const rendering =
      source.kind === "region"
        ? renderRegionCard(
            source.image,
            {
              sourceTitle: source.sourceTitle,
              page: source.page,
              // Generation day, mirroring the quote card semantics.
              dateLabel: formatCardDateLabel(),
            },
            readCardTheme(),
          ).then(({ blob }) => ({ blob, truncated: false }))
        : renderQuoteCardDetailed(
            {
              quote: source.quote,
              sourceTitle: source.sourceTitle,
              // Generation day, not annotation day (plan §3.3): "今天我摘了这句".
              dateLabel: formatCardDateLabel(),
            },
            styleId,
            readCardTheme(),
          ).then(({ blob, layout }) => ({ blob, truncated: layout.truncated }));
    rendering
      .then(({ blob, truncated }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setCard({ status: "ready", blob, url: objectUrl, truncated });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setCard({
            status: "error",
            message: cause instanceof Error ? cause.message : "卡片渲染失败",
          });
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, styleId]);

  const handleCopy = async () => {
    if (card.status !== "ready" || busy) return;
    setBusy(true);
    try {
      const copied = await copyImageToClipboard(card.blob);
      if (copied) {
        onNotice("卡片已复制，可直接粘贴到聊天或笔记应用。");
        onClose();
        return;
      }
      setCopyFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = () => {
    if (card.status !== "ready") return;
    downloadBlobFile(
      source.kind === "region"
        ? regionCardFileName(source.sourceTitle, source.page)
        : quoteCardFileName(),
      card.blob,
    );
    onNotice("已开始下载卡片 PNG。");
  };

  return (
    <div className="quote-card-dialog reade-motion-panel" role="dialog" aria-label={dialogTitle}>
      <div className="settings-heading">
        <span>{dialogTitle}</span>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label={`关闭${dialogTitle}`}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      {!isRegion && (
        <div
          className="quote-card-style-toggle"
          role="group"
          aria-label="卡片版式"
        >
          {CARD_STYLE_OPTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={styleId === id ? "active" : undefined}
              aria-pressed={styleId === id}
              onClick={() => setStyleId(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="quote-card-preview" aria-live="polite">
        {card.status === "loading" && (
          <div className="quote-card-state" role="status">
            <span className="spinner" aria-hidden="true" />
            正在生成卡片…
          </div>
        )}
        {card.status === "error" && (
          <div className="quote-card-state quote-card-state--error" role="alert">
            {card.message}
          </div>
        )}
        {card.status === "ready" && <img src={card.url} alt={`${dialogTitle}预览`} />}
      </div>
      {card.status === "ready" && card.truncated && (
        <p className="quote-card-hint" role="status">
          引文过长，已截断。
        </p>
      )}
      {copyFailed && (
        <p className="quote-card-hint quote-card-hint--error" role="alert">
          复制失败，可能被系统或剪贴板工具拦截；可改用「下载 PNG」保存卡片。
        </p>
      )}
      <div className="quote-card-actions">
        <button
          type="button"
          className="quote-card-download"
          disabled={card.status !== "ready"}
          onClick={handleDownload}
        >
          下载 PNG
        </button>
        <button
          type="button"
          className="quote-card-copy"
          disabled={card.status !== "ready" || busy}
          onClick={() => void handleCopy()}
        >
          {busy ? "正在复制…" : "复制图片"}
        </button>
      </div>
    </div>
  );
}

export default QuoteCardDialog;
