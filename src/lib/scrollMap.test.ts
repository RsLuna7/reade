// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Annotation, SearchResult } from "./backend";
import {
  buildScrollMapMarks,
  collectAnnotationScrollPoints,
  collectFindScrollPoints,
  collectSearchScrollPoints,
  SCROLL_MAP_MAX_MARKS,
  truncateScrollMapLabel,
  ttsRatioFromRect,
  type ScrollMapPoint,
} from "./scrollMap";

function point(overrides: Partial<ScrollMapPoint> = {}): ScrollMapPoint {
  return {
    kind: "annotation",
    color: "yellow",
    offset: 100,
    label: "标注 · 摘录",
    targetId: "a1",
    ...overrides,
  };
}

describe("buildScrollMapMarks", () => {
  it("maps offsets to clamped ratios in document order", () => {
    const marks = buildScrollMapMarks(
      [
        point({ offset: 900, targetId: "late" }),
        point({ offset: -50, targetId: "above" }),
        point({ offset: 1500, targetId: "below" }),
        point({ offset: 100, targetId: "early", color: "blue" }),
      ],
      1000,
    );
    expect(marks.map((mark) => mark.targetId)).toEqual(["above", "early", "late", "below"]);
    expect(marks[0].ratio).toBe(0);
    expect(marks[1].ratio).toBeCloseTo(0.1);
    expect(marks[3].ratio).toBe(1);
  });

  it("returns nothing without a measurable scroll height or finite offsets", () => {
    expect(buildScrollMapMarks([point()], 0)).toEqual([]);
    expect(buildScrollMapMarks([point()], Number.NaN)).toEqual([]);
    expect(buildScrollMapMarks([point({ offset: Number.NaN })], 1000)).toEqual([]);
  });

  it("merges same-kind same-color neighbors within ±0.002 and keeps distinct ones", () => {
    const marks = buildScrollMapMarks(
      [
        point({ offset: 500, targetId: "first" }),
        // 0.0015 的差距在 ±0.002 合并窗内(边界值受浮点噪声影响,不测)。
        point({ offset: 501.5, targetId: "merged-away" }),
        point({ offset: 501, color: "blue", targetId: "other-color" }),
        point({ offset: 501, kind: "bookmark", color: null, targetId: "other-kind" }),
        point({ offset: 510, targetId: "kept-apart" }),
      ],
      1000,
    );
    expect(marks.map((mark) => mark.targetId)).toEqual([
      "first",
      "other-color",
      "other-kind",
      "kept-apart",
    ]);
  });

  it("thins uniformly beyond the 200-mark cap instead of truncating the tail", () => {
    // 同色相邻间距 0.004 > 合并窗,500 枚全部存活后再触发抽稀。
    const many = Array.from({ length: 500 }, (_, index) =>
      point({ offset: index * 2, targetId: `p${index}`, color: index % 2 ? "yellow" : "blue" }),
    );
    const marks = buildScrollMapMarks(many, 1000);
    expect(marks).toHaveLength(SCROLL_MAP_MAX_MARKS);
    // 均匀抽稀:首端保留,末端仍有代表(非首 200 截断)。
    expect(marks[0].targetId).toBe("p0");
    expect(marks[marks.length - 1].ratio).toBeGreaterThan(0.9);
    const ratios = marks.map((mark) => mark.ratio);
    expect([...ratios].sort((a, b) => a - b)).toEqual(ratios);
  });
});

describe("truncateScrollMapLabel", () => {
  it("collapses whitespace and caps at 24 code points", () => {
    expect(truncateScrollMapLabel("  多行\n 摘录  ")).toBe("多行 摘录");
    expect(truncateScrollMapLabel("字".repeat(30))).toBe(`${"字".repeat(24)}…`);
    expect(truncateScrollMapLabel("字".repeat(24))).toBe("字".repeat(24));
  });
});

// ---- DOM collectors (rect-stubbed like tocCoverage.test) ----

function stubRect(element: HTMLElement, top: number, height = 0): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    top,
    height,
  } as DOMRect);
}

function fixture() {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
  scroller.scrollTop = 0;
  stubRect(scroller, 0);
  const article = document.createElement("div");
  scroller.appendChild(article);
  return { scroller, article };
}

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    relativePath: "doc.md",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "选中的句子",
    title: null,
    locator: { kind: "markdown", quote: "q", prefix: "", suffix: "", headingId: null },
    sortIndex: "M|00000|00000000",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("collectAnnotationScrollPoints", () => {
  it("positions highlights by their painted mark element", () => {
    const { scroller, article } = fixture();
    const mark = document.createElement("mark");
    mark.dataset.annotationId = "a1";
    stubRect(mark, 100);
    article.appendChild(mark);

    const points = collectAnnotationScrollPoints(scroller, article, [annotation()]);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      kind: "annotation",
      color: "yellow",
      offset: 100,
      targetId: "a1",
    });
    expect(points[0].label).toBe("标注 · 选中的句子");
  });

  it("falls back to the PDF page skeleton plus stored rects when no mark is painted", () => {
    const { scroller, article } = fixture();
    const page = document.createElement("section");
    page.id = "pdf-page-3";
    stubRect(page, 500, 100);
    article.appendChild(page);

    const points = collectAnnotationScrollPoints(scroller, article, [
      annotation({
        id: "pdf1",
        locator: {
          kind: "pdf",
          page: 3,
          view: "original",
          quote: "q",
          prefix: "",
          suffix: "",
          rects: [{ x: 0.1, y: 0.5, w: 0.2, h: 0.02 }],
        },
      }),
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].offset).toBe(550);
  });

  it("skips unanchored flowed annotations instead of guessing", () => {
    const { scroller, article } = fixture();
    const points = collectAnnotationScrollPoints(scroller, article, [annotation()]);
    expect(points).toEqual([]);
  });

  it("positions bookmarks by heading, scroll ratio and PDF page offset", () => {
    const { scroller, article } = fixture();
    const heading = document.createElement("h2");
    heading.id = "sec";
    stubRect(heading, 300);
    article.appendChild(heading);
    const page = document.createElement("section");
    page.id = "pdf-page-2";
    stubRect(page, 600, 200);
    article.appendChild(page);

    const points = collectAnnotationScrollPoints(scroller, article, [
      annotation({
        id: "b-heading",
        kind: "bookmark",
        color: null,
        title: "第二章",
        locator: {
          kind: "bookmark",
          target: { format: "markdown", headingId: "sec", scrollRatio: 0.9 },
        },
      }),
      annotation({
        id: "b-ratio",
        kind: "bookmark",
        color: null,
        title: null,
        locator: {
          kind: "bookmark",
          target: { format: "epub", chapterId: "c1", headingId: null, scrollRatio: 0.4 },
        },
      }),
      annotation({
        id: "b-pdf",
        kind: "bookmark",
        color: null,
        title: null,
        locator: {
          kind: "bookmark",
          target: { format: "pdf", page: 2, offsetRatio: 0.25 },
        },
      }),
    ]);
    expect(points.map((entry) => [entry.targetId, entry.offset])).toEqual([
      ["b-heading", 300],
      ["b-ratio", 400],
      ["b-pdf", 650],
    ]);
    expect(points[0].label).toBe("书签 · 第二章");
    expect(points[1].label).toBe("书签");
  });

  it("accounts for the current scroll offset of the container", () => {
    const { scroller, article } = fixture();
    scroller.scrollTop = 250;
    const mark = document.createElement("mark");
    mark.dataset.annotationId = "a1";
    stubRect(mark, 100);
    article.appendChild(mark);

    const points = collectAnnotationScrollPoints(scroller, article, [annotation()]);
    expect(points[0].offset).toBe(350);
  });
});

describe("collectSearchScrollPoints", () => {
  function result(overrides: Partial<SearchResult> = {}): SearchResult {
    return {
      resultId: "r1",
      relativePath: "doc.pdf",
      title: "文档",
      snippet: "……命中片段……",
      score: 1,
      format: "pdf",
      locator: { kind: "pdfPage", page: 3 },
      ...overrides,
    };
  }

  it("positions PDF page and EPUB chapter hits and skips markdown hits", () => {
    const { scroller, article } = fixture();
    const page = document.createElement("section");
    page.id = "pdf-page-3";
    stubRect(page, 500, 100);
    article.appendChild(page);
    const chapter = document.createElement("section");
    chapter.className = "epub-chapter";
    chapter.dataset.chapterId = "c2";
    stubRect(chapter, 700);
    article.appendChild(chapter);

    const points = collectSearchScrollPoints(scroller, article, [
      result(),
      result({
        resultId: "r2",
        format: "epub",
        locator: { kind: "epubChapter", chapterId: "c2" },
      }),
      result({ resultId: "r3", format: "markdown", locator: null }),
      result({ resultId: "r4", locator: { kind: "pdfPage", page: 99 } }),
    ]);
    expect(points.map((entry) => [entry.targetId, entry.offset])).toEqual([
      ["r1", 500],
      ["r2", 700],
    ]);
    expect(points[0].kind).toBe("search");
  });
});

describe("collectFindScrollPoints", () => {
  it("measures resolved ranges into search ticks", () => {
    const { scroller, article } = fixture();
    scroller.scrollTop = 50;
    stubRect(scroller, 0);
    const mark = document.createElement("span");
    mark.textContent = "find";
    stubRect(mark, 200);
    article.appendChild(mark);
    const range = document.createRange();
    range.selectNodeContents(mark);

    const points = collectFindScrollPoints(scroller, [
      { targetId: "0:4", label: "find", range },
      { targetId: "missing", label: "x", range: null },
    ]);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      kind: "search",
      offset: 250,
      targetId: "0:4",
    });
    expect(points[0].label).toBe("命中 · find");
  });
});

describe("ttsRatioFromRect", () => {
  it("maps the sentence rect into a clamped ratio and rejects missing input", () => {
    const { scroller } = fixture();
    scroller.scrollTop = 100;
    expect(ttsRatioFromRect(scroller, { top: 400 })).toBeCloseTo(0.5);
    expect(ttsRatioFromRect(scroller, { top: -500 })).toBe(0);
    expect(ttsRatioFromRect(scroller, null)).toBeNull();

    const empty = document.createElement("div");
    Object.defineProperty(empty, "scrollHeight", { configurable: true, value: 0 });
    expect(ttsRatioFromRect(empty, { top: 10 })).toBeNull();
  });
});
