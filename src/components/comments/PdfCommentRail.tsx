import { useEffect, useMemo, useRef } from "react";
import type { Annotation } from "../../lib/backend";
import {
  commentAnchorYFromPageBox,
  measurePdfCommentAnchor,
  normalizedAnnotationTop,
} from "../../lib/comments/commentAnchor";
import { layoutCommentCards } from "../../lib/comments/commentRailLayout";
import { pdfCommentSortKey } from "../../lib/comments/commentPlacement";
import type {
  CommentAuthor,
  PdfCommentMessage,
  PdfCommentThread,
} from "../../lib/comments/commentModel";
import { PdfCommentCard } from "./PdfCommentCard";

export function PdfCommentRail({
  threads,
  messages,
  authors,
  annotations,
  activeAnnotationId,
  onActivate,
  onReply,
  onEditMessage,
  onDeleteMessage,
  anchorRootRef,
  layoutRootRef,
  reflowKey = "",
}: {
  threads: readonly PdfCommentThread[];
  messages: readonly PdfCommentMessage[];
  authors: readonly CommentAuthor[];
  annotations: readonly Annotation[];
  activeAnnotationId: string | null;
  onActivate: (annotationId: string) => void;
  onReply: (threadId: string, body: string, authorId: string) => Promise<unknown>;
  onEditMessage?: (messageId: string, body: string) => Promise<unknown>;
  onDeleteMessage?: (messageId: string) => Promise<unknown>;
  /** Highlight host. Defaults to the rail's layout parent. */
  anchorRootRef?: { current: HTMLElement | null };
  /** Page-box host used when a highlight is not painted yet. */
  layoutRootRef?: { current: HTMLElement | null };
  reflowKey?: string;
}) {
  const railRef = useRef<HTMLElement>(null);
  const frameRef = useRef<number | null>(null);
  const heightsRef = useRef(new Map<string, number>());
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const annotationsById = useMemo(
    () => new Map(annotations.map((annotation) => [annotation.id, annotation])),
    [annotations],
  );
  const ordered = useMemo(
    () =>
      threads
        .filter((thread) => annotationsById.get(thread.annotationId)?.locator.kind === "pdf")
        .slice()
        .sort((left, right) => {
          const leftKey = pdfCommentSortKey(annotationsById.get(left.annotationId));
          const rightKey = pdfCommentSortKey(annotationsById.get(right.annotationId));
          return (
            leftKey[0] - rightKey[0] ||
            leftKey[1] - rightKey[1] ||
            left.id.localeCompare(right.id)
          );
        }),
    [annotationsById, threads],
  );
  const layoutKey = `${reflowKey}\0${ordered.map((thread) => thread.annotationId).join("\0")}`;

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const place = () => {
      const layout = layoutRootRef?.current ?? rail.parentElement;
      const queryRoot = anchorRootRef?.current ?? layout ?? rail;
      const slots = Array.from(
        rail.querySelectorAll<HTMLElement>(".pdf-comment-card-position"),
      );
      const inputs = [];
      for (const slot of slots) {
        const annotationId = slot.dataset.annotationId;
        if (!annotationId) continue;
        const measured = measurePdfCommentAnchor(queryRoot, rail, annotationId);
        let desiredY = measured?.desiredY ?? null;
        if (desiredY == null && layout) {
          const annotation = annotationsRef.current.find((item) => item.id === annotationId);
          const pageNumber = annotation?.locator.kind === "pdf" ? annotation.locator.page : null;
          const page =
            pageNumber == null
              ? null
              : layout.querySelector<HTMLElement>(`#pdf-page-${pageNumber}`);
          if (page && annotation?.locator.kind === "pdf") {
            desiredY = commentAnchorYFromPageBox(
              page.getBoundingClientRect(),
              rail.getBoundingClientRect(),
              normalizedAnnotationTop(annotation.locator.rects),
            );
          }
        }
        if (desiredY == null) continue;
        const measuredHeight = heightsRef.current.get(annotationId);
        const height = measuredHeight ?? slot.getBoundingClientRect().height;
        inputs.push({
          id: annotationId,
          desiredY,
          height: Number.isFinite(height) ? height : 0,
        });
      }
      const layouts = layoutCommentCards(inputs);
      const placed = new Set(layouts.map((item) => item.id));
      const viewHeight = rail.clientHeight;
      let inView = viewHeight <= 0;
      for (const slot of slots) {
        const annotationId = slot.dataset.annotationId;
        const layoutItem = layouts.find((item) => item.id === annotationId);
        if (!annotationId || !layoutItem || !placed.has(annotationId)) continue;
        slot.style.top = `${layoutItem.renderY}px`;
        slot.dataset.placed = "true";
        if (
          viewHeight > 0 &&
          layoutItem.renderY < viewHeight &&
          layoutItem.renderY + layoutItem.height > 0
        ) {
          inView = true;
        }
      }
      rail.dataset.cardsInView = inView ? "true" : "false";
      const area = layout?.classList.contains("pdf-page-area")
        ? layout
        : layout?.querySelector<HTMLElement>(".pdf-page-area");
      const pages = area?.querySelector<HTMLElement>(".pdf-pages");
      if (area && pages && layouts.length > 0) {
        const scrollTop = area.scrollTop;
        const maxBottom = layouts.reduce(
          (max, item) => Math.max(max, item.renderY + scrollTop + item.height),
          0,
        );
        const existing = Number(pages.dataset.commentTail || 0);
        const natural = area.scrollHeight - (Number.isFinite(existing) ? existing : 0);
        const tail = Math.max(0, Math.ceil(maxBottom + 24 - natural));
        if (String(tail) !== (pages.dataset.commentTail ?? "0")) {
          pages.dataset.commentTail = String(tail);
          pages.style.paddingBottom = tail > 0 ? `${tail}px` : "";
        }
      }
    };

    const schedule = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        place();
      });
    };

    const onWheel = (event: WheelEvent) => {
      const parent = rail.parentElement;
      const area = parent?.classList.contains("pdf-page-area")
        ? parent
        : parent?.querySelector<HTMLElement>(".pdf-page-area");
      if (!area || area.scrollHeight <= area.clientHeight + 1) return;
      if (event.deltaY === 0) return;
      area.scrollTop += event.deltaY;
      event.preventDefault();
    };

    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const target = entry.target;
        if (!(target instanceof HTMLElement)) continue;
        if (!target.classList.contains("pdf-comment-card-position")) {
          schedule();
          continue;
        }
        const annotationId = target.dataset.annotationId;
        if (!annotationId) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (heightsRef.current.get(annotationId) !== height) {
          heightsRef.current.set(annotationId, height);
          changed = true;
        }
      }
      if (changed) schedule();
    });
    rail.querySelectorAll<HTMLElement>(".pdf-comment-card-position").forEach((slot) => {
      observer.observe(slot);
    });
    const pages = (layoutRootRef?.current ?? rail.parentElement)?.querySelector(".pdf-pages");
    if (pages) observer.observe(pages);
    const highlights = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.classList.contains("pdf-user-highlight")) {
            schedule();
            return;
          }
        }
      }
    });
    if (pages) highlights.observe(pages, { childList: true, subtree: true });
    place();
    schedule();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    rail.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      observer.disconnect();
      highlights.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      rail.removeEventListener("wheel", onWheel);
    };
  }, [anchorRootRef, layoutKey, layoutRootRef]);

  return (
    <aside ref={railRef} className="pdf-comment-rail" aria-label="PDF 评论">
      <p className="pdf-comment-rail-hint">批注跟在对应文字旁边。滚到那一页，卡片会出现在那一行的右侧。</p>
      {ordered.map((thread) => {
        const annotation = annotationsById.get(thread.annotationId);
        if (!annotation || annotation.locator.kind !== "pdf") return null;
        return (
          <div
            key={thread.id}
            className="pdf-comment-card-position"
            data-annotation-id={thread.annotationId}
          >
            <PdfCommentCard
              thread={thread}
              page={annotation.locator.page}
              messages={messages}
              authors={authors}
              active={activeAnnotationId === thread.annotationId}
              onActivate={() => onActivate(thread.annotationId)}
              onReply={(body, authorId) => onReply(thread.id, body, authorId)}
              onEditMessage={onEditMessage}
              onDeleteMessage={onDeleteMessage}
            />
          </div>
        );
      })}
    </aside>
  );
}
