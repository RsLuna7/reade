import type { RefObject } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { DocumentFindStatus } from "../lib/useDocumentFind";

export interface FindBarProps {
  query: string;
  activeIndex: number;
  matchCount: number;
  status: DocumentFindStatus;
  inputRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (value: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}

function statusLabel(status: DocumentFindStatus, activeIndex: number, matchCount: number): string {
  if (status === "searching") return "查找中…";
  if (matchCount <= 0) return "无匹配";
  return `第 ${activeIndex + 1} 项，共 ${matchCount} 项`;
}

export function FindBar({
  query,
  activeIndex,
  matchCount,
  status,
  inputRef,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
}: FindBarProps) {
  return (
    <div className="find-bar" role="search" aria-label="在文档中查找">
      <input
        ref={inputRef}
        className="find-bar__input"
        type="search"
        value={query}
        placeholder="在本文中查找"
        aria-label="查找内容"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && event.shiftKey) {
            event.preventDefault();
            onPrevious();
          } else if (event.key === "Enter") {
            event.preventDefault();
            onNext();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <output className="find-bar__status" aria-live="polite">
        {statusLabel(status, activeIndex, matchCount)}
        {status === "truncated" ? "（结果过多，已截断）" : null}
      </output>
      <button
        type="button"
        className="icon-button find-bar__nav"
        aria-label="上一个匹配"
        title="上一个（Shift+Enter）"
        disabled={matchCount <= 0}
        onClick={onPrevious}
      >
        <ChevronUp size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-button find-bar__nav"
        aria-label="下一个匹配"
        title="下一个（Enter）"
        disabled={matchCount <= 0}
        onClick={onNext}
      >
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-button find-bar__close"
        aria-label="关闭查找"
        title="关闭（Esc）"
        onClick={onClose}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
