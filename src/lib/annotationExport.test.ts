import { describe, expect, it } from "vitest";
import type { Annotation } from "./backend";
import {
  annotationPositionLabel,
  buildAnnotationsMarkdown,
  compareAnnotationSortKeys,
  locatorSortKey,
} from "./annotationExport";

const fixedDate = () => "2026-08-12";

function pdfHighlight(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "pdf-1",
    relativePath: "papers/report.pdf",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "关键结论文本",
    title: "关键结论文本",
    locator: {
      kind: "pdf",
      page: 3,
      view: "original",
      quote: "关键结论文本",
      prefix: "",
      suffix: "",
      rects: [],
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function markdownUnderline(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "md-1",
    relativePath: "notes/guide.md",
    kind: "underline",
    color: "blue",
    note: "要点",
    selectedText: "第二段重点",
    title: "第二段重点",
    locator: {
      kind: "markdown",
      quote: "第二段重点",
      prefix: "",
      suffix: "",
      headingId: "section-2",
    },
    createdAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function pdfBookmark(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "bm-1",
    relativePath: "papers/report.pdf",
    kind: "bookmark",
    color: null,
    note: null,
    selectedText: null,
    title: "第 1 页",
    locator: {
      kind: "bookmark",
      target: { format: "pdf", page: 1, offsetRatio: 0.25 },
    },
    createdAt: 500,
    updatedAt: 500,
    ...overrides,
  };
}

describe("compareAnnotationSortKeys", () => {
  it("compares keys element-wise and puts unresolved keys last", () => {
    expect(compareAnnotationSortKeys([1, 2], [1, 3])).toBeLessThan(0);
    expect(compareAnnotationSortKeys([2], [1, 9])).toBeGreaterThan(0);
    expect(compareAnnotationSortKeys([1], [1, 0])).toBe(0);
    expect(compareAnnotationSortKeys(null, [1])).toBeGreaterThan(0);
    expect(compareAnnotationSortKeys([1], null)).toBeLessThan(0);
    expect(compareAnnotationSortKeys(null, null)).toBe(0);
  });
});

describe("locatorSortKey", () => {
  it("derives keys from pdf pages and epub offsets, and gives up on markdown quotes", () => {
    expect(locatorSortKey(pdfHighlight())).toEqual([3, 0, 0]);
    expect(locatorSortKey(pdfBookmark())).toEqual([1, 0, 0]);
    expect(
      locatorSortKey({
        ...markdownUnderline(),
        locator: {
          kind: "epub",
          chapterId: "ch-2",
          blockIndex: 4,
          startOffset: 12,
          endOffset: 20,
          quote: "x",
          prefix: "",
          suffix: "",
        },
      }),
    ).toEqual([4, 12]);
    expect(locatorSortKey(markdownUnderline())).toBeNull();
  });
});

describe("annotationPositionLabel", () => {
  it("labels pdf pages, epub chapters, markdown headings and scroll fallback", () => {
    expect(annotationPositionLabel(pdfHighlight())).toBe("第 3 页");
    expect(annotationPositionLabel(pdfBookmark())).toBe("第 1 页");
    expect(annotationPositionLabel(markdownUnderline())).toBe("标题 section-2");
    expect(
      annotationPositionLabel({
        ...pdfBookmark(),
        locator: {
          kind: "bookmark",
          target: { format: "markdown", headingId: null, scrollRatio: 0.5 },
        },
      }),
    ).toBe("进度 50%");
  });
});

describe("buildAnnotationsMarkdown", () => {
  it("returns an empty string for no annotations", () => {
    expect(buildAnnotationsMarkdown([])).toBe("");
  });

  it("groups annotations by document with mapped titles and counts", () => {
    const titles = new Map([
      ["papers/report.pdf", "年度报告"],
      ["notes/guide.md", "使用指南"],
    ]);
    const output = buildAnnotationsMarkdown(
      [pdfHighlight(), markdownUnderline(), pdfBookmark()],
      { documentTitles: titles, formatDate: fixedDate },
    );

    expect(output).toContain("# 标注摘录");
    expect(output).toContain("## 使用指南(1 条)");
    expect(output).toContain("## 年度报告(2 条)");
    // 组间按路径排序:notes/guide.md 在 papers/report.pdf 之前。
    expect(output.indexOf("## 使用指南")).toBeLessThan(output.indexOf("## 年度报告"));
  });

  it("sorts entries within a document by position and keeps unresolved entries last", () => {
    const early = pdfHighlight({ id: "pdf-early", createdAt: 9_000, updatedAt: 9_000 });
    const late = pdfHighlight({
      id: "pdf-late",
      selectedText: "第八页内容",
      createdAt: 100,
      updatedAt: 100,
      locator: { kind: "pdf", page: 8, view: "original", quote: "第八页内容", prefix: "", suffix: "", rects: [] },
    });
    const bookmark = pdfBookmark();
    const output = buildAnnotationsMarkdown([late, early, bookmark], { formatDate: fixedDate });

    const bookmarkIndex = output.indexOf("**书签**");
    const page3Index = output.indexOf("第 3 页");
    const page8Index = output.indexOf("第 8 页");
    expect(bookmarkIndex).toBeGreaterThan(-1);
    expect(bookmarkIndex).toBeLessThan(page3Index);
    expect(page3Index).toBeLessThan(page8Index);
  });

  it("prefers caller-provided sort keys over locator fallback", () => {
    const a = markdownUnderline({ id: "md-a", selectedText: "后文", createdAt: 1 });
    const b = markdownUnderline({ id: "md-b", selectedText: "前文", createdAt: 2 });
    const output = buildAnnotationsMarkdown([a, b], {
      formatDate: fixedDate,
      sortKeys: new Map([
        ["md-a", [200]],
        ["md-b", [10]],
      ]),
    });
    expect(output.indexOf("前文")).toBeLessThan(output.indexOf("后文"));
  });

  it("renders kind badge, quote, note, position and date per entry", () => {
    const output = buildAnnotationsMarkdown([markdownUnderline()], { formatDate: fixedDate });
    expect(output).toContain("- **下划线** · 标题 section-2 · 2026-08-12");
    expect(output).toContain("  > 第二段重点");
    expect(output).toContain("  笔记:要点");
  });

  it("omits the note line when the note is empty and the quote for bookmarks", () => {
    const output = buildAnnotationsMarkdown([pdfHighlight(), pdfBookmark()], {
      formatDate: fixedDate,
    });
    expect(output).not.toContain("笔记:");
    const bookmarkBlock = output.slice(output.indexOf("**书签**"), output.indexOf("**高亮**"));
    expect(bookmarkBlock).not.toContain("> ");
    expect(bookmarkBlock).toContain("第 1 页");
  });

  it("ends with a single trailing newline", () => {
    const output = buildAnnotationsMarkdown([pdfHighlight()], { formatDate: fixedDate });
    expect(output.endsWith("\n")).toBe(true);
    expect(output.endsWith("\n\n")).toBe(false);
  });
});
