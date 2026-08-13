/**
 * Hover preview card (docs/plan-hover-preview.md §3.2): a fixed-position
 * plain-text card for in-library link targets and footnote references.
 *
 * Security shape (HP-D1): everything here renders through React text
 * nodes — no markdown re-rendering, no HTML, no images. The only action
 * is the optional 打开 row, which replays the original href through the
 * existing `onNavigate` chain.
 */

import type { DocumentFormat } from "../lib/backend";
import type { HoverPreviewState } from "../lib/useHoverPreview";

export interface HoverPreviewCardProps {
  preview: HoverPreviewState;
  onOpen: (href: string) => void;
  onHold: () => void;
  onRelease: () => void;
}

function formatBadge(format: DocumentFormat): string {
  return format === "markdown" ? "MD" : format.toUpperCase();
}

/** Status line shown instead of an empty excerpt. */
function emptyExcerptNotice(indexStatus: string | null): string {
  if (indexStatus === "pending" || indexStatus === "indexing") {
    return "索引尚未就绪，暂无预览。";
  }
  if (indexStatus === "failed" || indexStatus === "unsupported") {
    return "该文档没有可检索文本，无法预览。";
  }
  return "该文档没有可预览的正文。";
}

export function HoverPreviewCard({ preview, onOpen, onHold, onRelease }: HoverPreviewCardProps) {
  const { data } = preview;
  return (
    <div
      className="hover-preview-card reade-motion-panel"
      role="dialog"
      aria-label={data.kind === "footnote" ? "脚注预览" : "链接预览"}
      data-placement={preview.placement}
      style={{ left: preview.x, top: preview.y }}
      onPointerEnter={onHold}
      onPointerLeave={onRelease}
    >
      {data.kind === "footnote" ? (
        <>
          <div className="hover-preview-head">
            <span className="hover-preview-kicker">脚注</span>
          </div>
          <p className="hover-preview-excerpt">{data.text}</p>
        </>
      ) : (
        <>
          <div className="hover-preview-head">
            {data.format && (
              <span
                className={`document-tree__format document-tree__format--${data.format}`}
                aria-hidden="true"
              >
                {formatBadge(data.format)}
              </span>
            )}
            <span className="hover-preview-title">{data.title}</span>
            {data.pdfPages !== null && (
              <span className="hover-preview-meta">共 {data.pdfPages} 页</span>
            )}
          </div>
          {data.fragment && (
            <p className="hover-preview-fragment"># {data.fragment}</p>
          )}
          {data.status === "loading" && (
            <p className="hover-preview-state" role="status">
              正在加载预览…
            </p>
          )}
          {data.status === "error" && (
            <p className="hover-preview-state hover-preview-state--error" role="alert">
              {data.error ?? "预览加载失败"}
            </p>
          )}
          {data.status === "ready" &&
            (data.excerpt ? (
              <p className="hover-preview-excerpt">{data.excerpt}</p>
            ) : (
              <p className="hover-preview-state" role="status">
                {emptyExcerptNotice(data.indexStatus)}
              </p>
            ))}
          <button
            type="button"
            className="hover-preview-open"
            onClick={() => onOpen(data.href)}
          >
            打开 →
          </button>
        </>
      )}
    </div>
  );
}

export default HoverPreviewCard;
