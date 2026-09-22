import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Annotation } from "../../lib/backend";
import {
  findPdfCommentLead,
  isCollapsedCommentRect,
  measurePdfCommentAnchor,
  type CommentAnchor,
} from "../../lib/comments/commentAnchor";
import {
  layoutCommentCards,
  type CommentCardLayout,
} from "../../lib/comments/commentRailLayout";
import type {
  CommentAuthor,
  PdfCommentMessage,
  PdfCommentThread,
} from "../../lib/comments/commentModel";
import { PdfCommentCard } from "./PdfCommentCard";

function layoutsEqual(
  left: readonly CommentCardLayout[],
  right: readonly CommentCardLayout[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        other?.id === item.id &&
        Math.abs(other.desiredY - item.desiredY) < 0.5 &&
        Math.abs(other.renderY - item.renderY) < 0.5 &&
        Math.abs(other.height - item.height) < 0.5
      );
    })
  );
}

export function PdfCommentRail({
  anchorRootRef,
  layoutRootRef,
  threads,
  messages,
  authors,
  annotations,
  activeAnnotationId,
  reflowKey,
  onActivate,
  onReply,
}: {
  anchorRootRef: RefObject<HTMLElement | null>;
  layoutRootRef: RefObject<HTMLElement | null>;
  threads: readonly PdfCommentThread[];
  messages: readonly PdfCommentMessage[];
  authors: readonly CommentAuthor[];
  annotations: readonly Annotation[];
  activeAnnotationId: string | null;
  reflowKey: string;
  onActivate: (annotationId: string) => void;
  onReply: (threadId: string, body: string, authorId: string) => Promise<unknown>;
}) {
  const railRef = useRef<HTMLElement>(null);
  const cardElementsRef = useRef(new Map<string, HTMLElement>());
  const cardHeightsRef = useRef(new Map<string, number>());
  const cardObserverRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef<number | null>(null);
  const [layouts, setLayouts] = useState<CommentCardLayout[]>([]);
  const annotationsById = useMemo(
    () => new Map(annotations.map((annotation) => [annotation.id, annotation])),
    [annotations],
  );

  const measure = useCallback(() => {
    frameRef.current = null;
    const anchorRoot = anchorRootRef.current;
    const layoutRoot = layoutRootRef.current;
    const rail = railRef.current;
    if (!anchorRoot || !layoutRoot || !rail || rail.getClientRects().length === 0) {
      setLayouts((current) => (current.length ? [] : current));
      return;
    }
    const anchors: CommentAnchor[] = [];
    let collapsedLeads = 0;
    for (const thread of threads) {
      const lead = findPdfCommentLead(anchorRoot, thread.annotationId);
      if (lead && isCollapsedCommentRect(lead.getBoundingClientRect())) {
        collapsedLeads += 1;
        continue;
      }
      const anchor = measurePdfCommentAnchor(anchorRoot, layoutRoot, thread.annotationId);
      if (anchor) anchors.push(anchor);
    }
    // Live zoom hides the text layer, so every lead collapses to a zero box.
    // Dropping the cards here makes the column jump; keep the last alignment
    // until the highlights are measurable again.
    if (anchors.length === 0 && collapsedLeads > 0) return;
    const next = layoutCommentCards(
      anchors.map((anchor) => ({
        id: anchor.annotationId,
        desiredY: anchor.desiredY,
        height: cardHeightsRef.current.get(anchor.annotationId) ?? 1,
      })),
    );
    setLayouts((current) => (layoutsEqual(current, next) ? current : next));
  }, [anchorRootRef, layoutRootRef, threads]);

  const scheduleReflow = useCallback(() => {
    if (frameRef.current === null) frameRef.current = window.requestAnimationFrame(measure);
  }, [measure]);

  const setCardRef = useCallback(
    (annotationId: string, node: HTMLElement | null) => {
      const previous = cardElementsRef.current.get(annotationId);
      if (previous && previous !== node) cardObserverRef.current?.unobserve(previous);
      if (!node) {
        cardElementsRef.current.delete(annotationId);
        cardHeightsRef.current.delete(annotationId);
        return;
      }
      cardElementsRef.current.set(annotationId, node);
      cardObserverRef.current?.observe(node);
    },
    [],
  );

  useLayoutEffect(() => {
    scheduleReflow();
  }, [reflowKey, scheduleReflow]);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const annotationId = element.dataset.annotationId;
        if (!annotationId) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (Math.abs((cardHeightsRef.current.get(annotationId) ?? -1) - height) < 0.5) {
          continue;
        }
        cardHeightsRef.current.set(annotationId, height);
        changed = true;
      }
      if (changed) scheduleReflow();
    });
    cardObserverRef.current = observer;
    for (const element of cardElementsRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      cardObserverRef.current = null;
    };
  }, [scheduleReflow]);

  useEffect(() => {
    const anchorRoot = anchorRootRef.current;
    const layoutRoot = layoutRootRef.current;
    if (!anchorRoot || !layoutRoot) return;
    const scrollRoot = anchorRoot.closest<HTMLElement>(".reading-scroll");
    const resizeObserver = new ResizeObserver(scheduleReflow);
    resizeObserver.observe(layoutRoot);
    resizeObserver.observe(anchorRoot);
    const mutationObserver = new MutationObserver(scheduleReflow);
    mutationObserver.observe(anchorRoot, { childList: true, subtree: true });
    scrollRoot?.addEventListener("scroll", scheduleReflow, { passive: true });
    window.addEventListener("resize", scheduleReflow);
    scheduleReflow();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      scrollRoot?.removeEventListener("scroll", scheduleReflow);
      window.removeEventListener("resize", scheduleReflow);
    };
  }, [anchorRootRef, layoutRootRef, scheduleReflow]);

  useEffect(() => {
    if (!activeAnnotationId) return;
    cardElementsRef.current.get(activeAnnotationId)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "auto",
    });
  }, [activeAnnotationId]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      // Reset the slot too: a canceled-but-uncleared id would make every later
      // scheduleReflow() believe a frame is already pending (React StrictMode
      // remounts effects, so the rail would otherwise never lay out at all).
      frameRef.current = null;
    },
    [],
  );

  const layoutsById = new Map(layouts.map((layout) => [layout.id, layout]));
  const visibleThreads = threads.filter((thread) => layoutsById.has(thread.annotationId));
  const bottom = layouts.reduce(
    (maximum, layout) => Math.max(maximum, layout.renderY + layout.height),
    0,
  );

  return (
    <aside
      ref={railRef}
      className="pdf-comment-rail"
      aria-label="PDF 评论"
      style={bottom > 0 ? { minHeight: `${Math.ceil(bottom)}px` } : undefined}
    >
      {visibleThreads.map((thread) => {
        const layout = layoutsById.get(thread.annotationId);
        const annotation = annotationsById.get(thread.annotationId);
        if (!layout || annotation?.locator.kind !== "pdf") return null;
        return (
          <div
            key={thread.id}
            ref={(node) => setCardRef(thread.annotationId, node)}
            className="pdf-comment-card-position"
            data-annotation-id={thread.annotationId}
            style={{ top: `${layout.renderY}px` }}
          >
            <PdfCommentCard
              thread={thread}
              page={annotation.locator.page}
              messages={messages}
              authors={authors}
              active={activeAnnotationId === thread.annotationId}
              onActivate={() => onActivate(thread.annotationId)}
              onReply={(body, authorId) => onReply(thread.id, body, authorId)}
            />
          </div>
        );
      })}
    </aside>
  );
}
