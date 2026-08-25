import { describe, expect, it } from "vitest";
import { buildAnnotationOutline } from "./annotationOutline";
import {
  migrateLegacyAnnotation,
  type Excerpt,
  type ReadingPlace,
  type Reflection,
} from "./annotationModel";
import { ANNOTATION_MIGRATION_FIXTURE } from "./annotationMigrationFixture";

function migratedEntries() {
  const mapped = ANNOTATION_MIGRATION_FIXTURE[0].annotations.map((annotation) =>
    migrateLegacyAnnotation(annotation),
  );
  return {
    excerpts: mapped.flatMap((item) => (item.excerpt ? [item.excerpt] : [])),
    places: mapped.flatMap((item) => (item.place ? [item.place] : [])),
    reflections: mapped.flatMap((item) => (item.reflection ? [item.reflection] : [])),
  };
}

function reflectionMap(items: Reflection[]): Map<string, Reflection> {
  return new Map(items.map((item) => [item.entryId, item]));
}

describe("document annotation outline", () => {
  it("groups Markdown entries in TOC order and puts stale headings last", () => {
    const { excerpts, places, reflections } = migratedEntries();
    const markdown = excerpts.filter((entry) => entry.anchor.format === "markdown");
    const markdownPlaces = places.filter((entry) => entry.target.format === "markdown");
    const result = buildAnnotationOutline({
      format: "markdown",
      toc: [
        { id: "reading-flow", title: "阅读流程", level: 1 },
        { id: "migration", title: "迁移", level: 1 },
      ],
      excerpts: [
        ...markdown,
        {
          ...markdown[0],
          id: "stale-heading",
          anchor: { ...markdown[0].anchor, headingId: "renamed-away" },
          sortIndex: "M|00000|00000999",
        } as Excerpt,
      ],
      places: markdownPlaces,
      reflectionsByEntryId: reflectionMap(reflections),
      currentTocId: "migration",
    });

    expect(result.sections.map((section) => section.title)).toEqual([
      "阅读流程",
      "迁移",
      "未归属",
    ]);
    expect(result.sections.find((section) => section.id === "migration")?.current).toBe(true);
    expect(result.unassignedCount).toBe(1);
    expect(result.excerptCount).toBe(3);
  });

  it("filters to live reflections while retaining section structure", () => {
    const { excerpts, places, reflections } = migratedEntries();
    const result = buildAnnotationOutline({
      format: "markdown",
      toc: [
        { id: "reading-flow", title: "阅读流程", level: 1 },
        { id: "migration", title: "迁移", level: 1 },
      ],
      excerpts: excerpts.filter((entry) => entry.anchor.format === "markdown"),
      places: places.filter((entry) => entry.target.format === "markdown"),
      reflectionsByEntryId: reflectionMap(reflections),
      currentTocId: null,
      view: "reflections",
    });

    expect(result.sections).toHaveLength(2);
    expect(result.sections.flatMap((section) => section.entries).map((item) => item.entry.id)).toEqual([
      "mig-md-highlight",
      "mig-bookmark-md",
    ]);
    expect(result.reflectionCount).toBe(2);
  });

  it("falls back to one whole-document group for headingless Markdown", () => {
    const { excerpts } = migratedEntries();
    const markdown = excerpts.filter((entry) => entry.anchor.format === "markdown");
    const result = buildAnnotationOutline({
      format: "mdx",
      toc: [],
      excerpts: markdown,
      places: [],
      reflectionsByEntryId: new Map(),
      currentTocId: null,
    });
    expect(result.sections.map((section) => section.title)).toEqual(["全文"]);
    expect(result.sections[0].entries).toHaveLength(markdown.length);
  });

  it("uses 20-page bands for PDFs without an Outline", () => {
    const { excerpts, places, reflections } = migratedEntries();
    const pdfExcerpts = excerpts.filter((entry) => entry.anchor.format === "pdfText");
    const pdfPlaces = places.filter((entry) => entry.target.format === "pdf");
    const pdfSeed = pdfExcerpts[0];
    if (pdfSeed.anchor.format !== "pdfText") throw new Error("expected pdf text anchor");
    const extra: Excerpt = {
      ...pdfSeed,
      id: "pdf-page-41",
      anchor: { ...pdfSeed.anchor, page: 41 },
      sortIndex: "P|00041|00001000",
      deletedAt: null,
    };
    const result = buildAnnotationOutline({
      format: "pdf",
      toc: [],
      excerpts: [...pdfExcerpts, extra],
      places: pdfPlaces,
      reflectionsByEntryId: reflectionMap(reflections),
      currentTocId: null,
      currentPage: 41,
    });
    expect(result.sections.map((section) => section.title)).toEqual([
      "第 1–20 页",
      "第 41–60 页",
    ]);
    expect(result.sections[1].current).toBe(true);
  });

  it("attributes PDF entries through existing Outline intervals", () => {
    const { excerpts, places } = migratedEntries();
    const result = buildAnnotationOutline({
      format: "pdf",
      toc: [
        { id: "pdf-page-1", title: "前言", level: 1 },
        { id: "pdf-page-10", title: "正文", level: 1 },
        { id: "pdf-page-20", title: "附录", level: 1 },
      ],
      excerpts: excerpts.filter((entry) => entry.anchor.format === "pdfText"),
      places: places.filter((entry) => entry.target.format === "pdf"),
      reflectionsByEntryId: new Map(),
      currentTocId: "pdf-page-10",
    });
    expect(result.sections.map((section) => section.title)).toEqual(["正文", "附录"]);
  });

  it("attributes EPUB entries through the chapter-to-TOC map", () => {
    const { excerpts } = migratedEntries();
    const result = buildAnnotationOutline({
      format: "epub",
      toc: [{ id: "epub-chapter-hash", title: "第二章", level: 1 }],
      excerpts: excerpts.filter((entry) => entry.anchor.format === "epub"),
      places: [],
      reflectionsByEntryId: new Map(),
      currentTocId: "epub-chapter-hash",
      epubChapterTocIds: new Map([["OEBPS/chapter-2.xhtml", "epub-chapter-hash"]]),
    });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toMatchObject({ title: "第二章", current: true, excerptCount: 1 });
  });

  it("drops tombstoned entries and stays fast for a synthetic 1,000-entry article", () => {
    const { excerpts } = migratedEntries();
    const seed = excerpts.find((entry) => entry.anchor.format === "markdown")!;
    const many = Array.from({ length: 1_000 }, (_, index): Excerpt => ({
      ...seed,
      id: `bulk-${index}`,
      anchor: { ...seed.anchor, headingId: `h-${index % 20}` } as Excerpt["anchor"],
      sortIndex: `M|00000|${String(index).padStart(8, "0")}`,
      createdAt: index + 1,
      updatedAt: index + 1,
      deletedAt: index === 999 ? 2_000 : null,
    }));
    const toc = Array.from({ length: 20 }, (_, index) => ({
      id: `h-${index}`,
      title: `章节 ${index + 1}`,
      level: 1,
    }));
    const started = performance.now();
    const result = buildAnnotationOutline({
      format: "markdown",
      toc,
      excerpts: many,
      places: [] as ReadingPlace[],
      reflectionsByEntryId: new Map(),
      currentTocId: "h-0",
    });
    const elapsed = performance.now() - started;
    expect(result.excerptCount).toBe(999);
    expect(result.sections).toHaveLength(20);
    expect(elapsed).toBeLessThan(50);
  });
});
