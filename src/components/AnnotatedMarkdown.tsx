import { memo, useLayoutEffect, useRef } from "react";
import type { Annotation } from "../lib/backend";
import type { AnchorResolution } from "../lib/annotationModel";
import {
  buildTextIndex,
  clearAnnotationMarks,
  collectElementText,
  elementTextOffsetInIndex,
  isAnnotationMarkKind,
  paintTextQuoteMarks,
  type TextQuoteMarkInput,
  type TextQuoteResolutionMethod,
} from "../lib/annotations";
import { MarkdownRenderer, type MarkdownRendererProps } from "./MarkdownRenderer";

function sameIdList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function sameResolutions(
  left: Array<{ id: string; resolution: AnchorResolution }>,
  right: Array<{ id: string; resolution: AnchorResolution }>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].id !== right[index].id) return false;
    if (JSON.stringify(left[index].resolution) !== JSON.stringify(right[index].resolution)) {
      return false;
    }
  }
  return true;
}

function markdownQuoteResolution(
  method: TextQuoteResolutionMethod,
): Extract<AnchorResolution, { status: "exact" } | { status: "approximate" }> {
  if (method === "normalized" || method === "fuzzy") {
    return { status: "approximate", method };
  }
  return { status: "exact", method };
}

export interface MarkdownPaintResult {
  broken: string[];
  /** Ids anchored through a non-exact step (normalized/fuzzy weak hint). */
  approximate: string[];
  resolutions: Array<{ id: string; resolution: AnchorResolution }>;
}

export function paintMarkdownAnnotations(
  markdownRoot: HTMLElement,
  annotations: Annotation[],
  options?: { fuzzy?: boolean },
): MarkdownPaintResult {
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
  const markAnnotations: Annotation[] = [];
  for (const annotation of annotations) {
    if (!isAnnotationMarkKind(annotation.kind) || annotation.locator.kind !== "markdown" || !annotation.color) {
      continue;
    }
    markAnnotations.push(annotation);
    marks.push({
      id: annotation.id,
      color: annotation.color,
      markKind: annotation.kind,
      quote: annotation.locator.quote,
      prefix: annotation.locator.prefix,
      suffix: annotation.locator.suffix,
      // The persisted position hint resolves directly (quote-verified);
      // older annotations without it fall back to the stored heading, which
      // disambiguates quotes repeated across sections.
      hintStart: annotation.locator.start ?? headingOffset(annotation.locator.headingId),
    });
  }
  const painted = paintTextQuoteMarks(markdownRoot, marks, index, { fuzzy: options?.fuzzy });
  const broken = [...painted.broken];
  const brokenSet = new Set(painted.broken);
  const resolutions: Array<{ id: string; resolution: AnchorResolution }> = [];
  for (const annotation of markAnnotations) {
    if (annotation.locator.kind !== "markdown") continue;
    if (brokenSet.has(annotation.id)) {
      const headingId = annotation.locator.headingId;
      const headingExists = Boolean(
        headingId && markdownRoot.querySelector(`#${CSS.escape(headingId)}`),
      );
      resolutions.push({
        id: annotation.id,
        resolution: { status: "detached", fallback: headingExists ? "heading" : null },
      });
      continue;
    }
    const approx = painted.approximate.get(annotation.id);
    resolutions.push({
      id: annotation.id,
      resolution: approx ? markdownQuoteResolution(approx) : { status: "exact", method: "exact" },
    });
  }
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
  return {
    broken: Array.from(new Set(broken)),
    approximate: Array.from(painted.approximate.keys()),
    resolutions,
  };
}

interface AnnotatedMarkdownProps extends Pick<
  MarkdownRendererProps,
  | "content"
  | "resolveImageSrc"
  | "onNavigate"
  | "onAllowRemoteImages"
  | "onLinkPreview"
  | "onLinkPreviewCancel"
  | "onLoadLocalImage"
  | "localImageErrors"
  | "resolveLocalSvg"
> {
  annotations: Annotation[];
  /** Enables the fuzzy last-resort anchoring step (global preference). */
  fuzzyAnchoring?: boolean;
  onBrokenIdsChange?: (ids: string[]) => void;
  onApproximateIdsChange?: (ids: string[]) => void;
  onResolutionsChange?: (resolutions: Array<{ id: string; resolution: AnchorResolution }>) => void;
}

export const AnnotatedMarkdown = memo(function AnnotatedMarkdown({
  content,
  annotations,
  fuzzyAnchoring = false,
  resolveImageSrc,
  onNavigate,
  onAllowRemoteImages,
  onLinkPreview,
  onLinkPreviewCancel,
  onLoadLocalImage,
  localImageErrors,
  resolveLocalSvg,
  onBrokenIdsChange,
  onApproximateIdsChange,
  onResolutionsChange,
}: AnnotatedMarkdownProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const lastBrokenRef = useRef<string[]>([]);
  const lastApproximateRef = useRef<string[]>([]);
  const lastResolutionsRef = useRef<Array<{ id: string; resolution: AnchorResolution }>>([]);
  const lastPaintRef = useRef<{
    annotations: Annotation[];
    content: string;
    text: string;
    fuzzy: boolean;
  } | null>(null);

  // Intentionally no dependency array: repainting on every render is what
  // catches async Shiki/Mermaid DOM swaps. The skip below only avoids the
  // paint cost when annotations, source content, the fuzzy switch and the
  // flattened DOM text are all unchanged (marks never alter the flattened
  // text).
  useLayoutEffect(() => {
    const markdownRoot = hostRef.current?.querySelector<HTMLElement>(".markdown-body");
    if (!markdownRoot) return;
    const last = lastPaintRef.current;
    if (
      last &&
      last.annotations === annotations &&
      last.content === content &&
      last.fuzzy === fuzzyAnchoring &&
      collectElementText(markdownRoot) === last.text
    ) {
      return;
    }
    const painted = paintMarkdownAnnotations(markdownRoot, annotations, { fuzzy: fuzzyAnchoring });
    lastPaintRef.current = {
      annotations,
      content,
      text: collectElementText(markdownRoot),
      fuzzy: fuzzyAnchoring,
    };
    if (!sameIdList(lastBrokenRef.current, painted.broken)) {
      lastBrokenRef.current = painted.broken;
      onBrokenIdsChange?.(painted.broken);
    }
    if (!sameIdList(lastApproximateRef.current, painted.approximate)) {
      lastApproximateRef.current = painted.approximate;
      onApproximateIdsChange?.(painted.approximate);
    }
    if (!sameResolutions(lastResolutionsRef.current, painted.resolutions)) {
      lastResolutionsRef.current = painted.resolutions;
      onResolutionsChange?.(painted.resolutions);
    }
  });

  return (
    <div ref={hostRef} className="annotated-markdown">
      <MarkdownRenderer
        content={content}
        resolveImageSrc={resolveImageSrc}
        onNavigate={onNavigate}
        onAllowRemoteImages={onAllowRemoteImages}
        onLinkPreview={onLinkPreview}
        onLinkPreviewCancel={onLinkPreviewCancel}
        onLoadLocalImage={onLoadLocalImage}
        localImageErrors={localImageErrors}
        resolveLocalSvg={resolveLocalSvg}
      />
    </div>
  );
});
