import { isValidSortIndex } from "./annotations";
import {
  EXCERPT_STYLES,
  isAnnotationTone,
  type ExcerptDraft,
  type ReadingPlaceDraft,
  type SourceAnchor,
} from "./annotationModel";
import { validateLibraryRelativePath } from "./webLibrary";

export const MAX_EXCERPT_CHARS = 2_000;
export const MAX_REFLECTION_CHARS = 4_000;
export const MAX_QUOTE_CONTEXT_CHARS = 32;
export const MAX_ANNOTATION_RECTS = 64;
export const MAX_ANNOTATION_ID_CHARS = 64;

const ANNOTATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function requireBoundedText(
  value: string,
  label: string,
  maxChars: number,
  options: { allowBlank?: boolean } = {},
): string {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  if (!options.allowBlank && !value.trim()) throw new Error(`${label}不能为空`);
  if (codePointLength(value) > maxChars) {
    throw new Error(`${label}不能超过 ${maxChars} 个字符`);
  }
  return value;
}

function requireNonNegativeInteger(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}无效`);
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}无效`);
}

function validateQuote(anchor: SourceAnchor): void {
  requireBoundedText(anchor.quote.exact, "标注原文", MAX_EXCERPT_CHARS);
  requireBoundedText(anchor.quote.prefix, "标注前文", MAX_QUOTE_CONTEXT_CHARS, {
    allowBlank: true,
  });
  requireBoundedText(anchor.quote.suffix, "标注后文", MAX_QUOTE_CONTEXT_CHARS, {
    allowBlank: true,
  });
}

function validateSourceAnchor(anchor: SourceAnchor): void {
  validateQuote(anchor);
  if (anchor.format === "markdown") {
    requireNonNegativeInteger(anchor.start, "Markdown 起始位置");
    requireNonNegativeInteger(anchor.end, "Markdown 结束位置");
    if (
      anchor.start !== undefined &&
      anchor.end !== undefined &&
      anchor.end < anchor.start
    ) {
      throw new Error("Markdown 标注位置前后颠倒");
    }
    return;
  }
  if (anchor.format === "pdfText") {
    requirePositiveInteger(anchor.page, "PDF 页码");
    if (anchor.view !== "original" && anchor.view !== "reading") {
      throw new Error("PDF 标注视图无效");
    }
    if (anchor.rects.length > MAX_ANNOTATION_RECTS) {
      throw new Error(`PDF 标注矩形不能超过 ${MAX_ANNOTATION_RECTS} 个`);
    }
    for (const rect of anchor.rects) {
      if (
        ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ||
        rect.w <= 0 ||
        rect.h <= 0
      ) {
        throw new Error("PDF 标注矩形无效");
      }
    }
    for (const dimension of [anchor.pageWidth, anchor.pageHeight]) {
      if (dimension !== undefined && (!Number.isFinite(dimension) || dimension <= 0)) {
        throw new Error("PDF 页面尺寸无效");
      }
    }
    return;
  }
  requireBoundedText(anchor.chapterId, "EPUB 章节", 1_024);
  requireNonNegativeInteger(anchor.blockIndex, "EPUB 段落序号");
  requireNonNegativeInteger(anchor.startOffset, "EPUB 起始位置");
  requireNonNegativeInteger(anchor.endOffset, "EPUB 结束位置");
  if (anchor.endOffset < anchor.startOffset) throw new Error("EPUB 标注位置前后颠倒");
  requireNonNegativeInteger(anchor.start, "EPUB 章节起始位置");
  requireNonNegativeInteger(anchor.end, "EPUB 章节结束位置");
  if (
    anchor.start !== undefined &&
    anchor.end !== undefined &&
    anchor.end < anchor.start
  ) {
    throw new Error("EPUB 章节位置前后颠倒");
  }
}

function cloneSourceAnchor(anchor: SourceAnchor): SourceAnchor {
  if (anchor.format === "markdown") {
    return { ...anchor, quote: { ...anchor.quote } };
  }
  if (anchor.format === "pdfText") {
    return {
      ...anchor,
      quote: { ...anchor.quote },
      rects: anchor.rects.map((rect) => ({ ...rect })),
    };
  }
  return { ...anchor, quote: { ...anchor.quote } };
}

export function validateAnnotationId(id: string): string {
  if (!ANNOTATION_ID_PATTERN.test(id) || id.length > MAX_ANNOTATION_ID_CHARS) {
    throw new Error("标注 ID 无效");
  }
  return id;
}

export function validateExcerptDraft(draft: ExcerptDraft): ExcerptDraft {
  validateAnnotationId(draft.id);
  validateLibraryRelativePath(draft.relativePath);
  requireBoundedText(draft.sourceText, "摘录", MAX_EXCERPT_CHARS);
  validateSourceAnchor(draft.anchor);
  if (!EXCERPT_STYLES.includes(draft.appearance.style)) throw new Error("标注样式无效");
  if (!isAnnotationTone(draft.appearance.tone)) throw new Error("标注颜色无效");
  if (!isValidSortIndex(draft.sortIndex)) throw new Error("标注排序位置无效");
  return {
    ...draft,
    anchor: cloneSourceAnchor(draft.anchor),
    appearance: { ...draft.appearance },
  };
}

function validateRatio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label}无效`);
}

export function validateReadingPlaceDraft(draft: ReadingPlaceDraft): ReadingPlaceDraft {
  validateAnnotationId(draft.id);
  validateLibraryRelativePath(draft.relativePath);
  if (draft.title !== null) requireBoundedText(draft.title, "书签标题", 200);
  if (!isValidSortIndex(draft.sortIndex)) throw new Error("书签排序位置无效");
  if (draft.target.format === "pdf") {
    requirePositiveInteger(draft.target.page, "PDF 页码");
    validateRatio(draft.target.offsetRatio, "PDF 页内位置");
  } else if (draft.target.format === "markdown") {
    validateRatio(draft.target.scrollRatio, "Markdown 阅读位置");
  } else {
    requireBoundedText(draft.target.chapterId, "EPUB 章节", 1_024);
    validateRatio(draft.target.scrollRatio, "EPUB 阅读位置");
  }
  return { ...draft, target: { ...draft.target } };
}

export function normalizeReflectionBody(body: string): string {
  requireBoundedText(body, "感悟", MAX_REFLECTION_CHARS);
  return body.trim();
}
