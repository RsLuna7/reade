import { describe, expect, it } from "vitest";
import type { Annotation, AnnotationLocator } from "./backend";
import type { TocItem } from "./markdown";
import {
  buildBookDigest,
  buildDigestMarkdown,
  digestFileName,
  digestStatsLine,
  DIGEST_UNASSIGNED_HEADING,
} from "./bookDigest";

function annotation(
  id: string,
  locator: AnnotationLocator,
  overrides: Partial<Annotation> = {},
): Annotation {
  return {
    id,
    relativePath: "docs/guide.md",
    kind: locator.kind === "bookmark" ? "bookmark" : "highlight",
    color: locator.kind === "bookmark" ? null : "yellow",
    note: null,
    selectedText: locator.kind === "bookmark" ? null : `摘录 ${id}`,
    title: null,
    locator,
    sortIndex: "M|00000|00000000",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

function markdownMark(
  id: string,
  headingId: string | null,
  overrides: Partial<Annotation> = {},
): Annotation {
  return annotation(
    id,
    { kind: "markdown", quote: "q", prefix: "", suffix: "", headingId },
    overrides,
  );
}

function heading(id: string, level = 2): TocItem {
  return { id, title: `《${id}》`, level };
}

const TOC = [heading("intro", 1), heading("usage", 2), heading("faq", 2)];

describe("buildBookDigest grouping", () => {
  it("interleaves sections in TOC order and skips empty ones", () => {
    const digest = buildBookDigest({
      items: TOC,
      format: "markdown",
      annotations: [
        markdownMark("a-faq", "faq"),
        markdownMark("a-intro", "intro"),
        markdownMark("b-intro", "intro"),
      ],
    });
    expect(digest.sections.map((section) => section.tocId)).toEqual(["intro", "faq"]);
    expect(digest.sections[0].heading).toBe("《intro》");
    expect(digest.sections[0].level).toBe(1);
    expect(digest.excerptCount).toBe(3);
    expect(digest.flat).toBe(false);
  });

  it("sends before-first-heading and stale headings to the trailing unassigned section", () => {
    const digest = buildBookDigest({
      items: TOC,
      format: "markdown",
      annotations: [
        markdownMark("first", null),
        markdownMark("stale", "renamed-away"),
        markdownMark("ok", "usage"),
      ],
    });
    expect(digest.sections.map((section) => section.tocId)).toEqual(["usage", null]);
    const unassigned = digest.sections[1];
    expect(unassigned.heading).toBe(DIGEST_UNASSIGNED_HEADING);
    expect(unassigned.items.map((item) => item.id)).toEqual(["first", "stale"]);
  });

  it("degrades to a flat list when the document has no TOC", () => {
    const digest = buildBookDigest({
      items: [],
      format: "markdown",
      annotations: [markdownMark("a", null), markdownMark("b", "anything")],
    });
    expect(digest.flat).toBe(true);
    expect(digest.sections).toHaveLength(1);
    expect(digest.sections[0].tocId).toBeNull();
    expect(digest.sections[0].items).toHaveLength(2);
  });

  it("attributes pdf pages through outline intervals (tocHeat 共享归因)", () => {
    const outline: TocItem[] = [
      { id: "pdf-page-1", title: "第一章", level: 1 },
      { id: "pdf-page-5", title: "第二章", level: 1 },
    ];
    const pdfMark = (id: string, page: number) =>
      annotation(id, {
        kind: "pdf",
        page,
        view: "original",
        quote: "q",
        prefix: "",
        suffix: "",
        rects: [],
      });
    const digest = buildBookDigest({
      items: outline,
      format: "pdf",
      annotations: [pdfMark("p4", 4), pdfMark("p6", 6), pdfMark("p1", 1)],
    });
    expect(digest.sections.map((section) => section.tocId)).toEqual([
      "pdf-page-1",
      "pdf-page-5",
    ]);
    expect(digest.sections[0].items.map((item) => item.id)).toEqual(["p1", "p4"]);
    expect(digest.sections[1].items.map((item) => item.id)).toEqual(["p6"]);
  });

  it("attributes epub chapters through the chapter→toc map", () => {
    const toc: TocItem[] = [{ id: "toc-ch1", title: "第一章", level: 1 }];
    const digest = buildBookDigest({
      items: toc,
      format: "epub",
      epubChapterTocIds: new Map([["OEBPS/ch1.xhtml", "toc-ch1"]]),
      annotations: [
        annotation("e1", {
          kind: "epub",
          chapterId: "OEBPS/ch1.xhtml",
          blockIndex: 0,
          startOffset: 0,
          endOffset: 1,
          quote: "q",
          prefix: "",
          suffix: "",
        }),
        annotation("ghost", {
          kind: "epub",
          chapterId: "ghost.xhtml",
          blockIndex: 0,
          startOffset: 0,
          endOffset: 1,
          quote: "q",
          prefix: "",
          suffix: "",
        }),
      ],
    });
    expect(digest.sections.map((section) => section.tocId)).toEqual(["toc-ch1", null]);
  });

  it("orders items inside a section by sortIndex, falling back to createdAt and id", () => {
    const digest = buildBookDigest({
      items: TOC,
      format: "markdown",
      annotations: [
        markdownMark("late", "usage", { sortIndex: "M|00000|00000900" }),
        markdownMark("early", "usage", { sortIndex: "M|00000|00000010" }),
        markdownMark("tie-b", "usage", { sortIndex: "M|00000|00000500", createdAt: 9 }),
        markdownMark("tie-a", "usage", { sortIndex: "M|00000|00000500", createdAt: 3 }),
      ],
    });
    expect(digest.sections[0].items.map((item) => item.id)).toEqual([
      "early",
      "tie-a",
      "tie-b",
      "late",
    ]);
  });

  it("skips bookmarks with a count, tombstones and textless marks silently", () => {
    const digest = buildBookDigest({
      items: TOC,
      format: "markdown",
      annotations: [
        markdownMark("live", "usage", { note: " 想法 " }),
        markdownMark("dead", "usage", { deletedAt: 5 }),
        markdownMark("blank", "usage", { selectedText: "   " }),
        annotation("bm", {
          kind: "bookmark",
          target: { format: "markdown", headingId: "usage", scrollRatio: 0.5 },
        }),
      ],
    });
    expect(digest.excerptCount).toBe(1);
    expect(digest.noteCount).toBe(1);
    expect(digest.skippedBookmarks).toBe(1);
    expect(digestStatsLine(digest)).toBe("1 条摘录 · 1 条笔记 · 已略过 1 条书签");
  });
});

describe("buildDigestMarkdown", () => {
  const formatDate = () => "2026-08-13";

  it("emits the title, stats, per-section headings and item blocks", () => {
    const digest = buildBookDigest({
      items: TOC,
      format: "markdown",
      annotations: [
        markdownMark("a", "intro", { selectedText: "第一段摘录", note: "很关键" }),
        markdownMark("b", null, { selectedText: "文首的摘录" }),
      ],
    });
    const markdown = buildDigestMarkdown(digest, "长文指南", { formatDate });
    expect(markdown).toBe(
      [
        "# 长文指南 · 读书报告",
        "",
        "2 条摘录 · 1 条笔记",
        "",
        "## 《intro》",
        "",
        "> 第一段摘录",
        "",
        "笔记：很关键",
        "",
        "— 高亮 · 标题 intro · 2026-08-13",
        "",
        `## ${DIGEST_UNASSIGNED_HEADING}`,
        "",
        "> 文首的摘录",
        "",
        "— 高亮 · 2026-08-13",
        "",
      ].join("\n"),
    );
  });

  it("deepens hashes with the toc level and clamps at ######", () => {
    const digest = buildBookDigest({
      items: [heading("deep", 6)],
      format: "markdown",
      annotations: [markdownMark("a", "deep")],
    });
    const markdown = buildDigestMarkdown(digest, "书", { formatDate });
    expect(markdown).toContain("\n###### 《deep》\n");
  });

  it("omits section headings entirely for flat digests", () => {
    const digest = buildBookDigest({
      items: [],
      format: "markdown",
      annotations: [markdownMark("a", null)],
    });
    const markdown = buildDigestMarkdown(digest, "无标题长文", { formatDate });
    expect(markdown).not.toContain("##");
    expect(markdown).toContain("> 摘录 a");
  });

  it("keeps multi-line excerpts inside the blockquote and adds pdf page labels", () => {
    const digest = buildBookDigest({
      items: [{ id: "pdf-page-1", title: "第一章", level: 1 }],
      format: "pdf",
      annotations: [
        annotation("p", {
          kind: "pdf",
          page: 3,
          view: "original",
          quote: "q",
          prefix: "",
          suffix: "",
          rects: [],
        }, { selectedText: "第一行\n第二行" }),
      ],
    });
    const markdown = buildDigestMarkdown(digest, "扫描书", { formatDate });
    expect(markdown).toContain("> 第一行\n> 第二行");
    expect(markdown).toContain("— 高亮 · 第 3 页 · 2026-08-13");
  });
});

describe("digestFileName", () => {
  it("sanitizes illegal file name characters", () => {
    expect(digestFileName("导论: A/B <测试>?")).toBe("reade-读书报告-导论- A-B -测试--.md");
    expect(digestFileName("   ")).toBe("reade-读书报告-文档.md");
  });
});
