import { describe, expect, it } from "vitest";
import type { CardCanvas, CardCanvasContext, ResolvedCardTheme } from "./quoteCard";
import type { CardMeasure } from "./quoteCardLayout";
import type { ReadingReportData } from "./readingReport";
import {
  drawReportCard,
  ellipsizeToWidth,
  layoutReportCards,
  renderReportCards,
  reportCardFileName,
  REPORT_CARD_HEIGHT,
  REPORT_CARD_WIDTH,
} from "./reportCards";

/** 等宽 measure：每字符 = 字号的一半（决定性，无 DOM）。 */
const measure: CardMeasure = (text, font) => [...text].length * (font.sizePx / 2);

const theme: ResolvedCardTheme = {
  paper: "#111111",
  paperRaised: "#222222",
  ink: "#333333",
  inkSoft: "#444444",
  muted: "#555555",
  accent: "#666666",
  line: "#777777",
};

function reportData(overrides: Partial<ReadingReportData> = {}): ReadingReportData {
  return {
    range: {
      kind: "year",
      startMs: 0,
      endMs: 1,
      label: "2026年",
      fileLabel: "2026",
    },
    totalSeconds: 3600 * 30,
    activeDays: 42,
    longestStreakDays: 9,
    documentCount: 12,
    markCount: 57,
    totalDeltaPercent: 23,
    peakSlot: { weekday: 2, hour: 21, seconds: 7200 },
    longestDay: { date: "2026-03-14", seconds: 11520 },
    depthShares: [
      { id: "glance", seconds: 1200, ratio: 0.05 },
      { id: "sit", seconds: 3600, ratio: 0.29 },
      { id: "immerse", seconds: 7200, ratio: 0.66 },
      { id: "long", seconds: 0, ratio: 0 },
    ],
    topByTime: [
      { relativePath: "a.md", title: "文档甲", seconds: 7200 },
      { relativePath: "b.pdf", title: "文档乙", seconds: 3600 },
    ],
    topByMarks: [{ relativePath: "a.md", title: "文档甲", count: 21 }],
    quote: { text: "把屏幕重新留给文字本身。", title: "长文阅读" },
    ...overrides,
  };
}

function allLines(cards: ReturnType<typeof layoutReportCards>): string[] {
  return cards.flatMap((card) => card.layout.blocks.flatMap((block) => block.lines));
}

describe("ellipsizeToWidth", () => {
  const font = { sizePx: 20, family: "sans" as const };

  it("keeps text that already fits", () => {
    expect(ellipsizeToWidth("短标题", 1000, measure, font)).toBe("短标题");
  });

  it("trims to the width and appends the ellipsis", () => {
    const out = ellipsizeToWidth("一个非常非常非常长的文档标题", 100, measure, font);
    expect(out.endsWith("…")).toBe(true);
    expect(measure(out, font)).toBeLessThanOrEqual(100);
    expect(out.length).toBeLessThan("一个非常非常非常长的文档标题".length);
  });

  it("collapses whitespace before measuring", () => {
    expect(ellipsizeToWidth("  甲   乙  ", 1000, measure, font)).toBe("甲 乙");
  });
});

describe("layoutReportCards", () => {
  it("emits four fixed-size cards when a quote exists, three otherwise", () => {
    const withQuote = layoutReportCards(reportData(), measure, "2026年8月13日");
    expect(withQuote.map((card) => card.id)).toEqual(["overview", "habit", "books", "quote"]);
    for (const card of withQuote) {
      expect(card.layout.width).toBe(REPORT_CARD_WIDTH);
      expect(card.layout.height).toBe(REPORT_CARD_HEIGHT);
    }
    const withoutQuote = layoutReportCards(reportData({ quote: null }), measure, "2026年8月13日");
    expect(withoutQuote.map((card) => card.id)).toEqual(["overview", "habit", "books"]);
  });

  it("renders the headline numbers and the comparison line on the overview card", () => {
    const [overview] = layoutReportCards(reportData(), measure, "2026年8月13日");
    const lines = overview.layout.blocks.flatMap((block) => block.lines);
    expect(lines).toContain("30 小时");
    expect(lines).toContain("较上一年 +23%");
    expect(lines).toContain("42 天");
    expect(lines).toContain("57 条");
    expect(lines).toContain("2026年 · 阅读报告");
  });

  it("marks an empty previous period instead of a percentage", () => {
    const [overview] = layoutReportCards(
      reportData({ totalDeltaPercent: null, range: { kind: "month", startMs: 0, endMs: 1, label: "2026年8月", fileLabel: "2026-08" } }),
      measure,
      "2026年8月13日",
    );
    const lines = overview.layout.blocks.flatMap((block) => block.lines);
    expect(lines).toContain("上一月无记录");
  });

  it("draws sitting-depth bars clamped to the content width", () => {
    const habit = layoutReportCards(reportData(), measure, "2026年8月13日")[1];
    expect(habit.id).toBe("habit");
    const lines = habit.layout.blocks.flatMap((block) => block.lines);
    expect(lines).toContain("周三 21:00");
    expect(lines).toContain("阅读节奏");
    expect(lines).toContain("沉浸");
    expect(lines).toContain("66%");
    // 四个档位各一条轨道 + 一条数值条；零占比的数值条宽度为 0。
    expect(habit.layout.bars).toHaveLength(8);
    for (const bar of habit.layout.bars) {
      expect(bar.width).toBeLessThanOrEqual(REPORT_CARD_WIDTH - 2 * 64);
    }
    const immerseValueBar = habit.layout.bars[5];
    expect(immerseValueBar.color).toBe("accent");
    expect(immerseValueBar.width).toBe(Math.round((REPORT_CARD_WIDTH - 128) * 0.66));
    expect(habit.layout.bars[7].width).toBe(0);
  });

  it("keeps every block inside the horizontal card bounds", () => {
    for (const card of layoutReportCards(reportData(), measure, "2026年8月13日")) {
      for (const block of card.layout.blocks) {
        for (const line of block.lines) {
          const width = measure(line, block.font);
          const left = block.align === "center" ? block.x - width / 2 : block.x;
          expect(left).toBeGreaterThanOrEqual(0);
          expect(left + width).toBeLessThanOrEqual(REPORT_CARD_WIDTH + 1);
        }
      }
    }
  });

  it("ellipsizes over-long book titles in the ranked rows", () => {
    const longTitle = "标题".repeat(60);
    const books = layoutReportCards(
      reportData({ topByTime: [{ relativePath: "x.md", title: longTitle, seconds: 60 }] }),
      measure,
      "2026年8月13日",
    )[2];
    const row = books.layout.blocks.find((block) => block.lines[0]?.endsWith("…"));
    expect(row).toBeDefined();
  });

  it("wraps and truncates the quote card body", () => {
    const cards = layoutReportCards(
      reportData({ quote: { text: "字".repeat(400), title: "书" } }),
      measure,
      "2026年8月13日",
    );
    const quoteCard = cards[3];
    const body = quoteCard.layout.blocks.find((block) => block.lines.length > 1);
    expect(body).toBeDefined();
    expect(body!.lines.length).toBeLessThanOrEqual(8);
    expect(body!.lines[body!.lines.length - 1].endsWith("……")).toBe(true);
    expect(quoteCard.layout.background).toBe("paperRaised");
  });

  it("shows the empty-marks note on the books card", () => {
    const books = layoutReportCards(
      reportData({ topByMarks: [], quote: null }),
      measure,
      "2026年8月13日",
    )[2];
    const lines = books.layout.blocks.flatMap((block) => block.lines);
    expect(lines).toContain("该周期还没有标注");
  });

  it("stamps the injected date label and brand on every card", () => {
    const lines = allLines(layoutReportCards(reportData(), measure, "2026年8月13日"));
    expect(lines.filter((line) => line === "2026年8月13日")).toHaveLength(4);
    expect(lines.filter((line) => line === "Reade")).toHaveLength(4);
  });
});

describe("reportCardFileName", () => {
  it("combines the range file label and the card title", () => {
    expect(reportCardFileName("2026", "总览")).toBe("reade-report-2026-总览.png");
    expect(reportCardFileName("2026-08", "书单")).toBe("reade-report-2026-08-书单.png");
  });
});

// --------------------------- 绘制与渲染管线 ---------------------------

type RecordedOp = Record<string, unknown> & { op: string };

class FakeContext implements CardCanvasContext {
  font = "";
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  strokeStyle: string | CanvasGradient | CanvasPattern = "";
  lineWidth = 0;
  textBaseline: CanvasTextBaseline = "alphabetic";
  textAlign: CanvasTextAlign = "start";
  ops: RecordedOp[] = [];

  scale(x: number, y: number): void {
    this.ops.push({ op: "scale", x, y });
  }
  measureText(text: string): { width: number } {
    return { width: [...text].length * 10 };
  }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ op: "fillRect", x, y, width, height, fillStyle: this.fillStyle });
  }
  fillText(text: string, x: number, y: number): void {
    this.ops.push({ op: "fillText", text, x, y, fillStyle: this.fillStyle });
  }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {
    this.ops.push({ op: "stroke", strokeStyle: this.strokeStyle });
  }
}

class FakeCanvas implements CardCanvas {
  readonly ctx = new FakeContext();
  constructor(
    public width: number,
    public height: number,
    private readonly blob: Blob | null = new Blob(["png"], { type: "image/png" }),
  ) {}
  getContext(): CardCanvasContext {
    return this.ctx;
  }
  toBlob(callback: (blob: Blob | null) => void): void {
    callback(this.blob);
  }
}

describe("drawReportCard", () => {
  it("paints the ground first, then bars, dividers and text with theme colors", () => {
    const spec = layoutReportCards(reportData(), measure, "2026年8月13日")[1];
    const ctx = new FakeContext();
    drawReportCard(ctx, spec.layout, theme);
    expect(ctx.ops[0]).toMatchObject({
      op: "fillRect",
      x: 0,
      y: 0,
      width: REPORT_CARD_WIDTH,
      height: REPORT_CARD_HEIGHT,
      fillStyle: theme.paper,
    });
    expect(ctx.ops.some((op) => op.op === "fillRect" && op.fillStyle === theme.accent)).toBe(true);
    expect(ctx.ops.some((op) => op.op === "stroke" && op.strokeStyle === theme.line)).toBe(true);
    expect(
      ctx.ops.some((op) => op.op === "fillText" && op.fillStyle === theme.accent && op.text === "Reade"),
    ).toBe(true);
    expect(ctx.textBaseline).toBe("top");
  });
});

describe("renderReportCards", () => {
  it("renders each card at the 2x scale and names the files by range and title", async () => {
    const created: FakeCanvas[] = [];
    const createCanvas = (width: number, height: number) => {
      const canvas = new FakeCanvas(width, height);
      created.push(canvas);
      return canvas;
    };
    const cards = await renderReportCards(reportData(), theme, {
      createCanvas,
      measure,
      dateLabel: "2026年8月13日",
    });
    expect(cards.map((card) => card.fileName)).toEqual([
      "reade-report-2026-总览.png",
      "reade-report-2026-习惯.png",
      "reade-report-2026-书单.png",
      "reade-report-2026-金句.png",
    ]);
    // 注入 measure 时不创建探针 canvas，四张卡各一个 2× 画布。
    expect(created).toHaveLength(4);
    for (const canvas of created) {
      expect(canvas.width).toBe(REPORT_CARD_WIDTH * 2);
      expect(canvas.height).toBe(REPORT_CARD_HEIGHT * 2);
      expect(canvas.ctx.ops[0]).toEqual({ op: "scale", x: 2, y: 2 });
    }
    expect(cards.every((card) => card.blob.type === "image/png")).toBe(true);
  });

  it("rejects when the canvas cannot produce a blob", async () => {
    const createCanvas = (width: number, height: number) => new FakeCanvas(width, height, null);
    await expect(
      renderReportCards(reportData(), theme, { createCanvas, measure }),
    ).rejects.toThrow(/toBlob/);
  });
});
