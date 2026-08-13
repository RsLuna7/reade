import { describe, expect, it } from "vitest";
import type { ResolvedCardTheme } from "./quoteCard";
import type { CardMeasure } from "./quoteCardLayout";
import {
  drawRegionCard,
  layoutRegionCard,
  renderRegionCard,
  REGION_CARD_WIDTH,
  type RegionCardCanvas,
  type RegionCardCanvasContext,
  type RegionImageSource,
} from "./regionCard";

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

const baseInput = {
  sourceTitle: "矩阵分析与应用",
  page: 42,
  dateLabel: "2026年8月13日",
};

describe("layoutRegionCard", () => {
  it("fits a landscape crop to the content width and sizes the card around it", () => {
    const layout = layoutRegionCard({ ...baseInput, imageWidth: 1216, imageHeight: 608 }, measure);
    expect(layout.width).toBe(REGION_CARD_WIDTH);
    expect(layout.image.width).toBe(608);
    expect(layout.image.height).toBe(304);
    expect(layout.image.x).toBe(56);
    expect(layout.image.y).toBe(56);
    // 出处行在位图之下,卡高随位图收缩。
    expect(layout.attribution.y).toBeGreaterThan(layout.image.y + layout.image.height);
    expect(layout.height).toBe(layout.attribution.y + 22 + 52);
    expect(layout.attribution.lines[0]).toBe("《矩阵分析与应用》 · 第 42 页 · 2026年8月13日");
  });

  it("caps very tall crops at the max image height and centers them", () => {
    const layout = layoutRegionCard({ ...baseInput, imageWidth: 400, imageHeight: 4000 }, measure);
    expect(layout.image.height).toBe(640);
    expect(layout.image.width).toBe(64);
    // 水平居中(608 内容宽)。
    expect(layout.image.x).toBe(56 + Math.round((608 - 64) / 2));
  });

  it("ellipsizes over-long titles while keeping the page suffix", () => {
    const layout = layoutRegionCard(
      { ...baseInput, sourceTitle: "标题".repeat(60), imageWidth: 600, imageHeight: 300 },
      measure,
    );
    const text = layout.attribution.lines[0];
    expect(text).toMatch(/…》 · 第 42 页 · 2026年8月13日$/);
    expect(measure(text, { sizePx: 15, family: "sans" })).toBeLessThanOrEqual(
      608 - Math.ceil(measure("Reade", { sizePx: 16, family: "serif", weight: 600 })) - 16,
    );
  });
});

// ------------------------------ 绘制与渲染 ------------------------------

type RecordedOp = Record<string, unknown> & { op: string };

class FakeContext implements RegionCardCanvasContext {
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
  drawImage(_source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void {
    this.ops.push({ op: "drawImage", dx, dy, dw, dh });
  }
  strokeRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ op: "strokeRect", x, y, width, height, strokeStyle: this.strokeStyle });
  }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {
    this.ops.push({ op: "stroke", strokeStyle: this.strokeStyle });
  }
}

class FakeCanvas implements RegionCardCanvas {
  readonly ctx = new FakeContext();
  constructor(
    public width: number,
    public height: number,
    private readonly blob: Blob | null = new Blob(["png"], { type: "image/png" }),
  ) {}
  getContext(): RegionCardCanvasContext {
    return this.ctx;
  }
  toBlob(callback: (blob: Blob | null) => void): void {
    callback(this.blob);
  }
}

const fakeImage = { width: 1216, height: 608 } as unknown as RegionImageSource;

describe("drawRegionCard", () => {
  it("paints paper, bitmap, frame, divider and attribution in theme colors", () => {
    const layout = layoutRegionCard({ ...baseInput, imageWidth: 1216, imageHeight: 608 }, measure);
    const ctx = new FakeContext();
    drawRegionCard(ctx, layout, fakeImage as CanvasImageSource, theme);
    expect(ctx.ops[0]).toMatchObject({ op: "fillRect", fillStyle: theme.paper });
    expect(ctx.ops[1]).toMatchObject({
      op: "drawImage",
      dx: layout.image.x,
      dy: layout.image.y,
      dw: layout.image.width,
      dh: layout.image.height,
    });
    expect(ctx.ops.some((op) => op.op === "strokeRect" && op.strokeStyle === theme.line)).toBe(true);
    expect(ctx.ops.some((op) => op.op === "stroke" && op.strokeStyle === theme.line)).toBe(true);
    expect(
      ctx.ops.some((op) => op.op === "fillText" && op.fillStyle === theme.muted),
    ).toBe(true);
    expect(
      ctx.ops.some((op) => op.op === "fillText" && op.text === "Reade" && op.fillStyle === theme.accent),
    ).toBe(true);
  });
});

describe("renderRegionCard", () => {
  it("renders at the constant 2x scale and resolves the PNG blob", async () => {
    const created: FakeCanvas[] = [];
    const createCanvas = (width: number, height: number) => {
      const canvas = new FakeCanvas(width, height);
      created.push(canvas);
      return canvas;
    };
    const { blob, layout } = await renderRegionCard(fakeImage, baseInput, theme, {
      createCanvas,
      measure,
    });
    expect(blob.type).toBe("image/png");
    expect(created).toHaveLength(1);
    expect(created[0].width).toBe(layout.width * 2);
    expect(created[0].height).toBe(layout.height * 2);
    expect(created[0].ctx.ops[0]).toEqual({ op: "scale", x: 2, y: 2 });
  });

  it("rejects when the canvas cannot produce a blob", async () => {
    await expect(
      renderRegionCard(fakeImage, baseInput, theme, {
        createCanvas: (width, height) => new FakeCanvas(width, height, null),
        measure,
      }),
    ).rejects.toThrow(/toBlob/);
  });
});
