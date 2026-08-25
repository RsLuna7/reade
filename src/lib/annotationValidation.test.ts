import { describe, expect, it } from "vitest";
import { deriveAnnotationSortIndex } from "./annotations";
import {
  migrateLegacyAnnotation,
  type ExcerptDraft,
  type ReadingPlaceDraft,
} from "./annotationModel";
import { ANNOTATION_MIGRATION_FIXTURE } from "./annotationMigrationFixture";
import {
  MAX_EXCERPT_CHARS,
  MAX_REFLECTION_CHARS,
  normalizeReflectionBody,
  validateExcerptDraft,
  validateReadingPlaceDraft,
} from "./annotationValidation";

function validExcerptDraft(): ExcerptDraft {
  const legacy = ANNOTATION_MIGRATION_FIXTURE[0].annotations[0];
  const excerpt = migrateLegacyAnnotation(legacy).excerpt!;
  return {
    id: "draft-1",
    relativePath: excerpt.relativePath,
    sourceText: excerpt.sourceText,
    anchor: excerpt.anchor,
    appearance: { style: "highlight", tone: "sand" },
    sortIndex: excerpt.sortIndex,
  };
}

describe("new annotation contract validation", () => {
  it("accepts and clones a valid excerpt draft", () => {
    const draft = validExcerptDraft();
    const validated = validateExcerptDraft(draft);
    expect(validated).toEqual(draft);
    expect(validated).not.toBe(draft);
    expect(validated.anchor).not.toBe(draft.anchor);
  });

  it("rejects oversized source and quote instead of truncating one side", () => {
    const oversized = "字".repeat(MAX_EXCERPT_CHARS + 1);
    expect(() => validateExcerptDraft({ ...validExcerptDraft(), sourceText: oversized })).toThrow(
      /不能超过/,
    );
    const draft = validExcerptDraft();
    if (draft.anchor.format !== "markdown") throw new Error("expected markdown");
    expect(() =>
      validateExcerptDraft({
        ...draft,
        anchor: { ...draft.anchor, quote: { ...draft.anchor.quote, exact: oversized } },
      }),
    ).toThrow(/不能超过/);
  });

  it("rejects unsafe paths, invalid ids, styles, tones and sort keys", () => {
    const draft = validExcerptDraft();
    expect(() => validateExcerptDraft({ ...draft, relativePath: "../escape.md" })).toThrow();
    expect(() => validateExcerptDraft({ ...draft, id: "bad id" })).toThrow();
    expect(() =>
      validateExcerptDraft({
        ...draft,
        appearance: { ...draft.appearance, style: "strike" as "highlight" },
      }),
    ).toThrow(/样式/);
    expect(() =>
      validateExcerptDraft({
        ...draft,
        appearance: { ...draft.appearance, tone: "pink" as "sand" },
      }),
    ).toThrow(/颜色/);
    expect(() => validateExcerptDraft({ ...draft, sortIndex: "M|0|0" })).toThrow(/排序/);
  });

  it("validates PDF geometry and EPUB offsets", () => {
    const base = validExcerptDraft();
    const pdfAnchor = {
      format: "pdfText" as const,
      page: 3,
      view: "original" as const,
      quote: { exact: "text", prefix: "", suffix: "" },
      rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.03 }],
      pageWidth: 595,
      pageHeight: 842,
    };
    expect(() =>
      validateExcerptDraft({
        ...base,
        anchor: pdfAnchor,
        sortIndex: deriveAnnotationSortIndex({
          kind: "pdf",
          page: 3,
          view: "original",
          quote: "text",
          prefix: "",
          suffix: "",
          rects: pdfAnchor.rects,
        }),
      }),
    ).not.toThrow();
    expect(() =>
      validateExcerptDraft({
        ...base,
        anchor: { ...pdfAnchor, rects: [{ x: 0, y: 0, w: 0, h: 1 }] },
      }),
    ).toThrow(/矩形/);

    expect(() =>
      validateExcerptDraft({
        ...base,
        anchor: {
          format: "epub",
          chapterId: "c1",
          blockIndex: 1,
          startOffset: 8,
          endOffset: 2,
          quote: { exact: "text", prefix: "", suffix: "" },
        },
      }),
    ).toThrow(/前后颠倒/);
  });

  it("normalizes reflection text and enforces the 4,000-character cap", () => {
    expect(normalizeReflectionBody("  我的感悟  ")).toBe("我的感悟");
    expect(() => normalizeReflectionBody(" ")).toThrow(/不能为空/);
    expect(() => normalizeReflectionBody("想".repeat(MAX_REFLECTION_CHARS + 1))).toThrow(
      /不能超过/,
    );
  });

  it("validates reading-place paths, ratios and pages", () => {
    const draft: ReadingPlaceDraft = {
      id: "place-1",
      relativePath: "notes/a.md",
      title: "位置",
      target: { format: "markdown", headingId: "a", scrollRatio: 0.5 },
      sortIndex: "M|00000|50000000",
    };
    expect(validateReadingPlaceDraft(draft)).toEqual(draft);
    expect(() =>
      validateReadingPlaceDraft({
        ...draft,
        target: { format: "markdown", headingId: null, scrollRatio: 1.1 },
      }),
    ).toThrow(/位置/);
    expect(() =>
      validateReadingPlaceDraft({
        ...draft,
        target: { format: "pdf", page: 0, offsetRatio: 0.2 },
      }),
    ).toThrow(/页码/);
  });
});
