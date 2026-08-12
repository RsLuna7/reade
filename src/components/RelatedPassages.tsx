/**
 * Related-passages result popover (docs/plan-related-passages.md §3.3,
 * decision RP-D4): floats next to the selection toolbar position, shows the
 * `SearchResult`-shaped hits from `findRelatedPassages` and hands clicks to
 * the existing `selectDocument(path, locator)` jump chain. Word-surface
 * matching, so the wording stays "相关" (never "相似").
 *
 * Closes on Esc and outside clicks (the AnnotationEditBubble pattern);
 * loading/empty/error states are all explicit.
 */

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { SearchResult } from "../lib/backend";

export type RelatedPassagesStatus =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; results: SearchResult[] };

export interface RelatedPassagesPopoverProps {
  state: RelatedPassagesStatus;
  x: number;
  y: number;
  onSelect: (result: SearchResult) => void;
  onClose: () => void;
}

function formatBadge(format: SearchResult["format"]): string {
  return format === "markdown" ? "MD" : format.toUpperCase();
}

export function RelatedPassagesPopover({
  state,
  x,
  y,
  onSelect,
  onClose,
}: RelatedPassagesPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: Event) => {
      const element = ref.current;
      if (!element) return;
      if (event.target instanceof Node && element.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="related-passages-popover reade-motion-panel"
      role="dialog"
      aria-label="相关段落"
      style={{ left: x, top: y }}
    >
      <div className="related-passages-heading">
        <span>相关段落</span>
        <button
          className="icon-button"
          type="button"
          aria-label="关闭相关段落"
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {state.status === "loading" && (
        <div className="related-passages-state" role="status">
          <span className="spinner" aria-hidden="true" />
          正在检索相关段落…
        </div>
      )}
      {state.status === "error" && (
        <div className="related-passages-state related-passages-state--error" role="alert">
          {state.message}
        </div>
      )}
      {state.status === "ready" &&
        (state.results.length === 0 ? (
          <p className="related-passages-state" role="status">
            没有找到相关段落。
          </p>
        ) : (
          <ol className="related-passages-list">
            {state.results.map((result) => (
              <li key={result.resultId}>
                <button
                  type="button"
                  className="related-passage"
                  onClick={() => onSelect(result)}
                >
                  <span className="related-passage-head">
                    <span
                      className={`document-tree__format document-tree__format--${result.format}`}
                      aria-hidden="true"
                    >
                      {formatBadge(result.format)}
                    </span>
                    <span className="related-passage-title">{result.title}</span>
                    {result.locator?.kind === "pdfPage" && (
                      <span className="related-passage-locator">第 {result.locator.page} 页</span>
                    )}
                    {result.locator?.kind === "epubChapter" && (
                      <span className="related-passage-locator">章节命中</span>
                    )}
                  </span>
                  {result.snippet && (
                    <span className="related-passage-snippet">{result.snippet}</span>
                  )}
                </button>
              </li>
            ))}
          </ol>
        ))}
    </div>
  );
}

export default RelatedPassagesPopover;
