/**
 * 全书回顾编纂视图（docs/plan-book-digest.md）：把当前文档的全部摘录类
 * 标注按章节结构穿插成一页只读"读书报告"。呈现为 reader 之上的全屏
 * overlay（BD-D1，不新增 ReaderView 枚举值）；条目点击跳回原文；导出
 * Markdown 走前端 `downloadBlobFile` 下载通道（BD-D3，零 Rust 改动）。
 */

import { useEffect, useMemo } from "react";
import { ArrowLeft, Download } from "lucide-react";
import type { Annotation } from "../lib/backend";
import { annotationPositionLabel } from "../lib/annotationExport";
import {
  buildBookDigest,
  buildDigestMarkdown,
  digestFileName,
  digestStatsLine,
} from "../lib/bookDigest";
import { downloadBlobFile } from "../lib/fileTransfer";
import type { TocItem } from "../lib/markdown";

export interface BookDigestViewProps {
  docTitle: string;
  format: "markdown" | "pdf" | "epub";
  toc: TocItem[];
  annotations: Annotation[];
  epubChapterTocIds?: Map<string, string>;
  onClose: () => void;
  /** 点击条目：关闭视图并跳回原文标注处（App 接线）。 */
  onJump: (annotation: Annotation) => void;
  /** 导出反馈（沿 App 的 notice 通道）。 */
  onNotice?: (message: string) => void;
}

export function BookDigestView({
  docTitle,
  format,
  toc,
  annotations,
  epubChapterTocIds,
  onClose,
  onJump,
  onNotice,
}: BookDigestViewProps) {
  const digest = useMemo(
    () => buildBookDigest({ items: toc, annotations, format, epubChapterTocIds }),
    [annotations, epubChapterTocIds, format, toc],
  );

  // 捕获阶段抢先消费 Esc:只关编纂 overlay,不连带退出底下的中枢视图
  // (中枢/回顾的 window 监听都检查 defaultPrevented)。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onClose]);

  const handleExport = () => {
    const markdown = buildDigestMarkdown(digest, docTitle);
    downloadBlobFile(
      digestFileName(docTitle),
      new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
    );
    onNotice?.("已开始下载读书报告 Markdown。");
  };

  return (
    <div className="book-digest-view" role="dialog" aria-label="读书报告">
      <header className="book-digest-header">
        <button
          className="icon-button"
          type="button"
          aria-label="返回阅读"
          title="返回阅读（Esc）"
          onClick={onClose}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <div className="book-digest-heading">
          <h1>读书报告</h1>
          <span>{digestStatsLine(digest)}</span>
        </div>
        <button
          type="button"
          className="book-digest-export"
          disabled={digest.excerptCount === 0}
          onClick={handleExport}
        >
          <Download size={14} aria-hidden="true" />
          导出 Markdown
        </button>
      </header>
      <div className="book-digest-scroll">
        <article className="book-digest-article">
          <h2 className="book-digest-title">{docTitle}</h2>
          {digest.excerptCount === 0 ? (
            <p className="book-digest-empty">
              这篇文档还没有可编纂的摘录。划几段高亮或下划线，再回来生成读书报告。
              {digest.skippedBookmarks > 0
                ? `（${digest.skippedBookmarks} 条书签不含摘录文本，不进入报告。）`
                : null}
            </p>
          ) : (
            digest.sections.map((section) => (
              <section
                className="book-digest-section"
                key={section.tocId ?? "@digest-unassigned"}
              >
                {!digest.flat && (
                  <h3
                    className="book-digest-heading-row"
                    data-level={Math.min(4, Math.max(1, section.level))}
                  >
                    {section.heading}
                  </h3>
                )}
                <ul className="book-digest-items">
                  {section.items.map((annotation) => {
                    // markdown 条目已在所属章节小节之下,"标题 <slug>"徽标是
                    // 纯冗余(且展示的是 slug);页码/章节与未归属条目保留。
                    const redundantHeading =
                      annotation.locator.kind === "markdown" &&
                      section.tocId !== null &&
                      annotation.locator.headingId === section.tocId;
                    const position = redundantHeading
                      ? null
                      : annotationPositionLabel(annotation);
                    const note = annotation.note?.trim();
                    return (
                      <li key={annotation.id}>
                        <button
                          type="button"
                          className="book-digest-item"
                          title="跳回原文中的标注处"
                          onClick={() => onJump(annotation)}
                        >
                          <span
                            className={`annotation-color-dot annotation-color-dot--${annotation.color ?? "yellow"}`}
                            aria-hidden="true"
                          />
                          <span className="book-digest-item-body">
                            <blockquote>{annotation.selectedText}</blockquote>
                            {note ? <p className="book-digest-note">{note}</p> : null}
                            {position ? (
                              <span className="book-digest-meta">{position}</span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </article>
      </div>
    </div>
  );
}

export default BookDigestView;
