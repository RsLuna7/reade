import { memo, useLayoutEffect, useRef } from "react";
import type { Annotation } from "../lib/backend";
import {
  buildTextIndex,
  clearAnnotationMarks,
  collectElementText,
  elementTextOffsetInIndex,
  isAnnotationMarkKind,
  paintTextQuoteMarks,
  type TextQuoteMarkInput,
} from "../lib/annotations";
import { MarkdownRenderer, type MarkdownRendererProps } from "./MarkdownRenderer";

function sameIdList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export function paintMarkdownAnnotations(
  markdownRoot: HTMLElement,
  annotations: Annotation[],
): string[] {
  clearAnnotationMarks(markdownRoot);
  // One walk for the whole paint: quote search, heading hints and range
  // construction all reuse this index instead of re-walking per annotation.
  const index = buildTextIndex(markdownRoot);
  const headingOffsets = new Map<string, number | null>();
  const headingOffset = (headingId: string | null): number | undefined => {
    if (!headingId) return undefined;
    let offset = headingOffsets.get(headingId);
    if (offset === undefined) {
      const heading = markdownRoot.querySelector(`#${CSS.escape(headingId)}`);
      offset = heading ? elementTextOffsetInIndex(index, heading) : null;
      headingOffsets.set(headingId, offset);
    }
    return offset ?? undefined;
  };
  const marks: TextQuoteMarkInput[] = [];
  for (const annotation of annotations) {
    if (!isAnnotationMarkKind(annotation.kind) || annotation.locator.kind !== "markdown" || !annotation.color) {
      continue;
    }
    marks.push({
      id: annotation.id,
      color: annotation.color,
      markKind: annotation.kind,
      quote: annotation.locator.quote,
      prefix: annotation.locator.prefix,
      suffix: annotation.locator.suffix,
      // The stored heading disambiguates quotes repeated across sections.
      hintStart: headingOffset(annotation.locator.headingId),
    });
  }
  const broken = paintTextQuoteMarks(markdownRoot, marks, index);
  for (const annotation of annotations) {
    if (annotation.kind === "bookmark" && annotation.locator.kind === "bookmark") {
      const headingId =
        annotation.locator.target.format === "markdown"
          ? annotation.locator.target.headingId
          : null;
      if (headingId && !markdownRoot.querySelector(`#${CSS.escape(headingId)}`)) {
        broken.push(annotation.id);
      }
    }
  }
  return Array.from(new Set(broken));
}

interface AnnotatedMarkdownProps extends Pick<
  MarkdownRendererProps,
  "content" | "resolveImageSrc" | "onNavigate"
> {
  annotations: Annotation[];
  onBrokenIdsChange?: (ids: string[]) => void;
}

export const AnnotatedMarkdown = memo(function AnnotatedMarkdown({
  content,
  annotations,
  resolveImageSrc,
  onNavigate,
  onBrokenIdsChange,
}: AnnotatedMarkdownProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const lastBrokenRef = useRef<string[]>([]);
  const lastPaintRef = useRef<{ annotations: Annotation[]; content: string; text: string } | null>(null);

  // Intentionally no dependency array: repainting on every render is what
  // catches async Shiki/Mermaid DOM swaps. The skip below only avoids the
  // paint cost when annotations, source content and flattened DOM text are
  // all unchanged (marks themselves never alter the flattened text).
  useLayoutEffect(() => {
    const markdownRoot = hostRef.current?.querySelector<HTMLElement>(".markdown-body");
    if (!markdownRoot) return;
    const last = lastPaintRef.current;
    if (
      last &&
      last.annotations === annotations &&
      last.content === content &&
      collectElementText(markdownRoot) === last.text
    ) {
      return;
    }
    const broken = paintMarkdownAnnotations(markdownRoot, annotations);
    lastPaintRef.current = { annotations, content, text: collectElementText(markdownRoot) };
    if (!sameIdList(lastBrokenRef.current, broken)) {
      lastBrokenRef.current = broken;
      onBrokenIdsChange?.(broken);
    }
  });

  return (
    <div ref={hostRef} className="annotated-markdown">
      <MarkdownRenderer
        content={content}
        resolveImageSrc={resolveImageSrc}
        onNavigate={onNavigate}
      />
    </div>
  );
});
