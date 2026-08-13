/**
 * PDF 区域引用卡片的排版与绘制（docs/plan-pdf-region-card.md §3.3）：
 * 位图等比放置在 720 逻辑宽的纸面上,下方出处行"《文档标题》 · 第 N 页"。
 * 取色走金句卡同一 17-token 契约（readCardTheme）;2× 导出;排版纯函数
 * 注入 measure,绘制面注入 canvas 工厂,与 quoteCard/reportCards 同姿势。
 */

import {
  CARD_EXPORT_SCALE,
  cardFontCss,
  type CardCanvasContext,
  type ResolvedCardTheme,
} from "./quoteCard";
import type { CardFont, CardMeasure, CardTextBlock } from "./quoteCardLayout";

export const REGION_CARD_WIDTH = 720;
const PADDING_X = 56;
const PADDING_TOP = 56;
const PADDING_BOTTOM = 52;
const CONTENT_WIDTH = REGION_CARD_WIDTH - PADDING_X * 2;
const IMAGE_MAX_HEIGHT = 640;
const IMAGE_MIN_HEIGHT = 48;
const ATTRIBUTION_GAP = 26;
const DIVIDER_GAP = 18;
const META_LINE_HEIGHT = 22;
const META_FONT: CardFont = { sizePx: 15, family: "sans" };
const BRAND_FONT: CardFont = { sizePx: 16, family: "serif", weight: 600 };

export interface RegionCardInput {
  imageWidth: number;
  imageHeight: number;
  sourceTitle: string;
  page: number;
  dateLabel: string;
}

export interface RegionCardLayout {
  width: number;
  height: number;
  /** 位图槽位（逻辑 px,等比缩放后水平居中）。 */
  image: { x: number; y: number; width: number; height: number };
  divider: { x1: number; x2: number; y: number };
  attribution: CardTextBlock;
  brand: CardTextBlock;
}

function ellipsizeTitle(
  title: string,
  suffix: string,
  maxWidth: number,
  measure: CardMeasure,
): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  const full = `《${normalized}》${suffix}`;
  if (measure(full, META_FONT) <= maxWidth) return full;
  let characters = [...normalized];
  while (
    characters.length > 1 &&
    measure(`《${characters.join("")}…》${suffix}`, META_FONT) > maxWidth
  ) {
    characters = characters.slice(0, -1);
  }
  return `《${characters.join("")}…》${suffix}`;
}

/** 计算卡面布局：位图等比缩进内容区（超高时按上限缩放）。 */
export function layoutRegionCard(
  input: RegionCardInput,
  measure: CardMeasure,
): RegionCardLayout {
  const ratio =
    input.imageWidth > 0 && input.imageHeight > 0
      ? input.imageHeight / input.imageWidth
      : 1;
  let imageWidth = CONTENT_WIDTH;
  let imageHeight = Math.round(imageWidth * ratio);
  if (imageHeight > IMAGE_MAX_HEIGHT) {
    imageHeight = IMAGE_MAX_HEIGHT;
    imageWidth = Math.round(imageHeight / ratio);
  }
  imageHeight = Math.max(IMAGE_MIN_HEIGHT, imageHeight);
  const imageX = PADDING_X + Math.round((CONTENT_WIDTH - imageWidth) / 2);

  const attributionY =
    PADDING_TOP + imageHeight + ATTRIBUTION_GAP + DIVIDER_GAP;
  const height = attributionY + META_LINE_HEIGHT + PADDING_BOTTOM;

  const brandWidth = Math.ceil(measure("Reade", BRAND_FONT));
  const attributionText = ellipsizeTitle(
    input.sourceTitle,
    ` · 第 ${input.page} 页 · ${input.dateLabel}`,
    CONTENT_WIDTH - brandWidth - 16,
    measure,
  );

  return {
    width: REGION_CARD_WIDTH,
    height,
    image: { x: imageX, y: PADDING_TOP, width: imageWidth, height: imageHeight },
    divider: {
      x1: PADDING_X,
      x2: REGION_CARD_WIDTH - PADDING_X,
      y: attributionY - DIVIDER_GAP,
    },
    attribution: {
      lines: [attributionText],
      x: PADDING_X,
      y: attributionY,
      font: META_FONT,
      lineHeightPx: META_LINE_HEIGHT,
      align: "left",
      color: "muted",
    },
    brand: {
      lines: ["Reade"],
      x: REGION_CARD_WIDTH - PADDING_X - brandWidth,
      y: attributionY,
      font: BRAND_FONT,
      lineHeightPx: META_LINE_HEIGHT,
      align: "left",
      color: "accent",
    },
  };
}

// ---------------------------------------------------------------------------
// 绘制与渲染（结构化 canvas:在金句卡的上下文形状上追加 drawImage）
// ---------------------------------------------------------------------------

export interface RegionCardCanvasContext extends CardCanvasContext {
  drawImage(
    source: CanvasImageSource,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
}

export interface RegionCardCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): RegionCardCanvasContext | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
}

/** 位图源的结构类型：真实 HTMLCanvasElement/ImageBitmap 均满足。 */
export type RegionImageSource = CanvasImageSource & {
  width: number;
  height: number;
};

export function drawRegionCard(
  ctx: RegionCardCanvasContext,
  layout: RegionCardLayout,
  image: CanvasImageSource,
  theme: ResolvedCardTheme,
): void {
  ctx.textBaseline = "top";
  ctx.fillStyle = theme.paper;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.drawImage(image, layout.image.x, layout.image.y, layout.image.width, layout.image.height);
  // 细线框把位图从纸面上"托"起来,与卡面分隔线同 token。
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(
    layout.image.x + 0.5,
    layout.image.y + 0.5,
    layout.image.width - 1,
    layout.image.height - 1,
  );
  ctx.beginPath();
  ctx.moveTo(layout.divider.x1, layout.divider.y + 0.5);
  ctx.lineTo(layout.divider.x2, layout.divider.y + 0.5);
  ctx.stroke();
  for (const block of [layout.attribution, layout.brand]) {
    ctx.font = cardFontCss(block.font);
    ctx.fillStyle = block.color === "accent" ? theme.accent : theme.muted;
    ctx.textAlign = "left";
    const leading = Math.max(0, (block.lineHeightPx - block.font.sizePx) / 2);
    block.lines.forEach((line, index) => {
      ctx.fillText(line, block.x, block.y + index * block.lineHeightPx + leading);
    });
  }
}

export interface RenderRegionCardOptions {
  createCanvas?: (width: number, height: number) => RegionCardCanvas;
  measure?: CardMeasure;
}

function createDomCanvas(width: number, height: number): RegionCardCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** 渲染为 PNG blob（恒 2×,QC-D6 同款）。 */
export async function renderRegionCard(
  image: RegionImageSource,
  meta: { sourceTitle: string; page: number; dateLabel: string },
  theme: ResolvedCardTheme,
  options: RenderRegionCardOptions = {},
): Promise<{ blob: Blob; layout: RegionCardLayout }> {
  const createCanvas = options.createCanvas ?? createDomCanvas;
  let measure = options.measure;
  if (!measure) {
    const probeCtx = createCanvas(1, 1).getContext("2d");
    if (!probeCtx) throw new Error("无法创建 canvas 上下文");
    measure = (text, font) => {
      probeCtx.font = cardFontCss(font);
      return probeCtx.measureText(text).width;
    };
  }
  const layout = layoutRegionCard(
    {
      imageWidth: image.width,
      imageHeight: image.height,
      sourceTitle: meta.sourceTitle,
      page: meta.page,
      dateLabel: meta.dateLabel,
    },
    measure,
  );
  const canvas = createCanvas(
    layout.width * CARD_EXPORT_SCALE,
    layout.height * CARD_EXPORT_SCALE,
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 canvas 上下文");
  ctx.scale(CARD_EXPORT_SCALE, CARD_EXPORT_SCALE);
  drawRegionCard(ctx, layout, image, theme);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!blob) throw new Error("卡片导出失败（canvas.toBlob 未返回图像）");
  return { blob, layout };
}
