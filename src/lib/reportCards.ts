import type { DocumentFormat } from "./backend";
import {
  CARD_EXPORT_SCALE,
  cardFontCss,
  type CardCanvas,
  type CardCanvasContext,
  type ResolvedCardTheme,
} from "./quoteCard";
import {
  formatCardDateLabel,
  layoutQuoteLines,
  type CardColorRole,
  type CardDivider,
  type CardFont,
  type CardMeasure,
  type CardTextBlock,
} from "./quoteCardLayout";
import { formatDuration } from "./readingStats";
import type { ReadingReportData } from "./readingReport";

/**
 * 阅读报告卡片排版与绘制（docs/plan-reading-report-cards.md §3.2）。
 * 排版是纯函数（注入 measure），绘制沿金句卡的 CardCanvasContext 结构类型；
 * 取色走同一 17-token 契约（readCardTheme），本模块零新 token、零新依赖。
 * 四张固定 720×900 卡（RC-D1）：总览 / 习惯 / 书单 / 金句（期内无标注时缺席）。
 */

export const REPORT_CARD_WIDTH = 720;
export const REPORT_CARD_HEIGHT = 900;
const PADDING_X = 64;
const CONTENT_WIDTH = REPORT_CARD_WIDTH - PADDING_X * 2;
const HEADER_Y = 72;
const TITLE_Y = 100;
const BODY_Y = 208;
const FOOTER_Y = REPORT_CARD_HEIGHT - 56 - 22;
const META_LINE_HEIGHT = 22;

export type ReportCardId = "overview" | "habit" | "books" | "quote";

export interface ReportBar {
  x: number;
  y: number;
  width: number;
  height: number;
  color: CardColorRole;
}

export interface ReportCardLayout {
  width: number;
  height: number;
  background: "paper" | "paperRaised";
  blocks: CardTextBlock[];
  dividers: CardDivider[];
  bars: ReportBar[];
}

export interface ReportCardSpec {
  id: ReportCardId;
  title: string;
  layout: ReportCardLayout;
}

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const FORMAT_LABELS: Record<DocumentFormat, string> = {
  markdown: "Markdown",
  mdx: "MDX",
  pdf: "PDF",
  epub: "EPUB",
};

const EYEBROW_FONT: CardFont = { sizePx: 14, family: "sans" };
const TITLE_FONT: CardFont = { sizePx: 30, family: "serif", weight: 700 };
const LABEL_FONT: CardFont = { sizePx: 13, family: "sans" };
const VALUE_FONT: CardFont = { sizePx: 26, family: "sans", weight: 600 };
const BIG_VALUE_FONT: CardFont = { sizePx: 40, family: "sans", weight: 700 };
const ROW_FONT: CardFont = { sizePx: 17, family: "sans" };
const META_FONT: CardFont = { sizePx: 15, family: "sans" };
const BRAND_FONT: CardFont = { sizePx: 16, family: "serif", weight: 600 };

/** 尾部省略到给定宽度（排版原语，plan §7 风险项要求带单测）。 */
export function ellipsizeToWidth(
  text: string,
  maxWidth: number,
  measure: CardMeasure,
  font: CardFont,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (measure(normalized, font) <= maxWidth) return normalized;
  let characters = [...normalized];
  while (characters.length > 1 && measure(`${characters.join("")}…`, font) > maxWidth) {
    characters = characters.slice(0, -1);
  }
  return `${characters.join("")}…`;
}

function textBlock(
  lines: string[],
  x: number,
  y: number,
  font: CardFont,
  color: CardColorRole,
  align: "left" | "center" = "left",
  lineHeightPx = Math.round(font.sizePx * 1.5),
): CardTextBlock {
  return { lines, x, y, font, lineHeightPx, align, color };
}

interface CardChrome {
  blocks: CardTextBlock[];
  dividers: CardDivider[];
}

/** 页眉（周期 · 眉题 + 大标题）与页脚（分隔线 + 日期 + Reade 字标）。 */
function cardChrome(
  data: ReadingReportData,
  title: string,
  measure: CardMeasure,
  dateLabel: string,
): CardChrome {
  const brandX =
    REPORT_CARD_WIDTH - PADDING_X - Math.ceil(measure("Reade", BRAND_FONT));
  return {
    blocks: [
      textBlock([`${data.range.label} · 阅读报告`], PADDING_X, HEADER_Y, EYEBROW_FONT, "muted"),
      textBlock([title], PADDING_X, TITLE_Y, TITLE_FONT, "ink", "left", 40),
      textBlock([dateLabel], PADDING_X, FOOTER_Y, META_FONT, "muted", "left", META_LINE_HEIGHT),
      textBlock(["Reade"], brandX, FOOTER_Y, BRAND_FONT, "accent", "left", META_LINE_HEIGHT),
    ],
    dividers: [
      {
        x1: PADDING_X,
        x2: REPORT_CARD_WIDTH - PADDING_X,
        y: FOOTER_Y - 18,
        color: "line",
      },
    ],
  };
}

function statPair(
  value: string,
  label: string,
  x: number,
  y: number,
): CardTextBlock[] {
  return [
    textBlock([value], x, y, VALUE_FONT, "ink", "left", 34),
    textBlock([label], x, y + 40, LABEL_FONT, "muted", "left", 18),
  ];
}

/** 右对齐一行（canvas 无 textAlign:right 档,用 measure 反推 x）。 */
function rightAlignedBlock(
  text: string,
  y: number,
  font: CardFont,
  color: CardColorRole,
  measure: CardMeasure,
  lineHeightPx: number,
): CardTextBlock {
  const x = REPORT_CARD_WIDTH - PADDING_X - Math.ceil(measure(text, font));
  return textBlock([text], x, y, font, color, "left", lineHeightPx);
}

function layoutOverviewCard(
  data: ReadingReportData,
  measure: CardMeasure,
  dateLabel: string,
): ReportCardLayout {
  const chrome = cardChrome(data, "总览", measure, dateLabel);
  const blocks = [...chrome.blocks];

  blocks.push(textBlock(["累计阅读"], PADDING_X, BODY_Y, LABEL_FONT, "muted", "left", 18));
  blocks.push(
    textBlock([formatDuration(data.totalSeconds)], PADDING_X, BODY_Y + 30, BIG_VALUE_FONT, "accent", "left", 52),
  );
  const compare =
    data.totalDeltaPercent === null
      ? `上一${data.range.kind === "month" ? "月" : "年"}无记录`
      : `较上一${data.range.kind === "month" ? "月" : "年"} ${
          data.totalDeltaPercent >= 0 ? "+" : ""
        }${data.totalDeltaPercent}%`;
  blocks.push(textBlock([compare], PADDING_X, BODY_Y + 96, META_FONT, "inkSoft", "left", META_LINE_HEIGHT));

  const gridY = BODY_Y + 172;
  const columnX = PADDING_X + Math.round(CONTENT_WIDTH / 2);
  blocks.push(...statPair(`${data.activeDays} 天`, "活跃阅读日", PADDING_X, gridY));
  blocks.push(...statPair(`${data.longestStreakDays} 天`, "最长连续", columnX, gridY));
  blocks.push(...statPair(`${data.documentCount} 篇`, "读过的文档", PADDING_X, gridY + 110));
  blocks.push(...statPair(`${data.markCount} 条`, "划下的标注", columnX, gridY + 110));

  return {
    width: REPORT_CARD_WIDTH,
    height: REPORT_CARD_HEIGHT,
    background: "paper",
    blocks,
    dividers: chrome.dividers,
    bars: [],
  };
}

function layoutHabitCard(
  data: ReadingReportData,
  measure: CardMeasure,
  dateLabel: string,
): ReportCardLayout {
  const chrome = cardChrome(data, "习惯", measure, dateLabel);
  const blocks = [...chrome.blocks];
  const bars: ReportBar[] = [];

  const peakText = data.peakSlot
    ? `${WEEKDAY_LABELS[data.peakSlot.weekday]} ${data.peakSlot.hour}:00`
    : "—";
  blocks.push(textBlock(["最常阅读时段"], PADDING_X, BODY_Y, LABEL_FONT, "muted", "left", 18));
  blocks.push(textBlock([peakText], PADDING_X, BODY_Y + 30, BIG_VALUE_FONT, "accent", "left", 52));

  const longestY = BODY_Y + 130;
  if (data.longestDay) {
    blocks.push(
      ...statPair(formatDuration(data.longestDay.seconds), `单日最长 · ${data.longestDay.date}`, PADDING_X, longestY),
    );
  }

  const sharesY = longestY + 130;
  blocks.push(textBlock(["格式占比"], PADDING_X, sharesY, LABEL_FONT, "muted", "left", 18));
  data.formatShares.slice(0, 4).forEach((share, index) => {
    const rowY = sharesY + 34 + index * 56;
    const percent = Math.round(share.ratio * 100);
    blocks.push(
      textBlock([FORMAT_LABELS[share.format]], PADDING_X, rowY, ROW_FONT, "ink", "left", 24),
    );
    blocks.push(rightAlignedBlock(`${percent}%`, rowY, ROW_FONT, "inkSoft", measure, 24));
    const trackY = rowY + 30;
    bars.push({ x: PADDING_X, y: trackY, width: CONTENT_WIDTH, height: 6, color: "line" });
    bars.push({
      x: PADDING_X,
      y: trackY,
      width: Math.max(4, Math.round(CONTENT_WIDTH * share.ratio)),
      height: 6,
      color: "accent",
    });
  });

  return {
    width: REPORT_CARD_WIDTH,
    height: REPORT_CARD_HEIGHT,
    background: "paper",
    blocks,
    dividers: chrome.dividers,
    bars,
  };
}

function rankedRows(
  entries: Array<{ title: string; right: string }>,
  startY: number,
  measure: CardMeasure,
): CardTextBlock[] {
  const blocks: CardTextBlock[] = [];
  entries.forEach((entry, index) => {
    const rowY = startY + index * 52;
    const rightWidth = Math.ceil(measure(entry.right, ROW_FONT));
    const titleMax = CONTENT_WIDTH - 34 - rightWidth - 16;
    blocks.push(
      textBlock([`${index + 1}`], PADDING_X, rowY, { ...ROW_FONT, weight: 600 }, "accent", "left", 26),
    );
    blocks.push(
      textBlock(
        [ellipsizeToWidth(entry.title, titleMax, measure, ROW_FONT)],
        PADDING_X + 34,
        rowY,
        ROW_FONT,
        "ink",
        "left",
        26,
      ),
    );
    blocks.push(rightAlignedBlock(entry.right, rowY, ROW_FONT, "inkSoft", measure, 26));
  });
  return blocks;
}

function layoutBooksCard(
  data: ReadingReportData,
  measure: CardMeasure,
  dateLabel: string,
): ReportCardLayout {
  const chrome = cardChrome(data, "书单", measure, dateLabel);
  const blocks = [...chrome.blocks];

  blocks.push(textBlock(["读得最久"], PADDING_X, BODY_Y, LABEL_FONT, "muted", "left", 18));
  blocks.push(
    ...rankedRows(
      data.topByTime.map((entry) => ({
        title: entry.title,
        right: formatDuration(entry.seconds),
      })),
      BODY_Y + 34,
      measure,
    ),
  );

  const marksY = BODY_Y + 34 + 3 * 52 + 44;
  blocks.push(textBlock(["划线最多"], PADDING_X, marksY, LABEL_FONT, "muted", "left", 18));
  if (data.topByMarks.length > 0) {
    blocks.push(
      ...rankedRows(
        data.topByMarks.map((entry) => ({
          title: entry.title,
          right: `${entry.count} 条`,
        })),
        marksY + 34,
        measure,
      ),
    );
  } else {
    blocks.push(
      textBlock(["该周期还没有标注"], PADDING_X, marksY + 34, ROW_FONT, "muted", "left", 26),
    );
  }

  return {
    width: REPORT_CARD_WIDTH,
    height: REPORT_CARD_HEIGHT,
    background: "paper",
    blocks,
    dividers: chrome.dividers,
    bars: [],
  };
}

const QUOTE_MAX_CHARS = 160;
const QUOTE_MAX_LINES = 8;

function layoutQuoteCardOfReport(
  data: ReadingReportData,
  quote: NonNullable<ReadingReportData["quote"]>,
  measure: CardMeasure,
  dateLabel: string,
): ReportCardLayout {
  const chrome = cardChrome(data, "金句", measure, dateLabel);
  const blocks = [...chrome.blocks];

  let text = quote.text;
  let truncatedByChars = false;
  if ([...text].length > QUOTE_MAX_CHARS) {
    text = [...text].slice(0, QUOTE_MAX_CHARS).join("");
    truncatedByChars = true;
  }
  const quoteFont: CardFont = {
    sizePx: [...text].length <= 60 ? 26 : 21,
    family: "serif",
  };
  const wrapWidth = (CONTENT_WIDTH - 24) * 0.96;
  let lines = layoutQuoteLines(text, wrapWidth, measure, quoteFont);
  let truncated = truncatedByChars;
  if (lines.length > QUOTE_MAX_LINES) {
    lines = lines.slice(0, QUOTE_MAX_LINES);
    truncated = true;
  }
  if (truncated && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1].trimEnd()}……`;
  }
  const lineHeightPx = Math.round(quoteFont.sizePx * 1.8);
  const quoteHeight = lines.length * lineHeightPx;
  const zoneTop = BODY_Y + 40;
  const zoneBottom = FOOTER_Y - 90;
  const quoteY = Math.max(zoneTop, Math.round((zoneTop + zoneBottom - quoteHeight) / 2));

  blocks.push(
    textBlock(["\u201c"], PADDING_X, BODY_Y - 24, { sizePx: 56, family: "serif", weight: 700 }, "accent", "left", 56),
  );
  blocks.push(
    textBlock(lines, REPORT_CARD_WIDTH / 2, quoteY, quoteFont, "ink", "center", lineHeightPx),
  );
  blocks.push(
    textBlock(
      [
        ellipsizeToWidth(`《${quote.title}》`, CONTENT_WIDTH, measure, META_FONT),
      ],
      REPORT_CARD_WIDTH / 2,
      quoteY + quoteHeight + 36,
      META_FONT,
      "muted",
      "center",
      META_LINE_HEIGHT,
    ),
  );

  return {
    width: REPORT_CARD_WIDTH,
    height: REPORT_CARD_HEIGHT,
    background: "paperRaised",
    blocks,
    dividers: chrome.dividers,
    bars: [],
  };
}

/**
 * 排版全组卡片：总览/习惯/书单恒在；金句卡仅当期内有摘录（RC-D1）。
 * dateLabel 可注入（测试）；默认生成当日。
 */
export function layoutReportCards(
  data: ReadingReportData,
  measure: CardMeasure,
  dateLabel: string = formatCardDateLabel(),
): ReportCardSpec[] {
  const specs: ReportCardSpec[] = [
    { id: "overview", title: "总览", layout: layoutOverviewCard(data, measure, dateLabel) },
    { id: "habit", title: "习惯", layout: layoutHabitCard(data, measure, dateLabel) },
    { id: "books", title: "书单", layout: layoutBooksCard(data, measure, dateLabel) },
  ];
  if (data.quote) {
    specs.push({
      id: "quote",
      title: "金句",
      layout: layoutQuoteCardOfReport(data, data.quote, measure, dateLabel),
    });
  }
  return specs;
}

/** 下载文件名：reade-report-2026-总览.png / reade-report-2026-08-书单.png。 */
export function reportCardFileName(fileLabel: string, title: string): string {
  return `reade-report-${fileLabel}-${title}.png`;
}

// ---------------------------------------------------------------------------
// 绘制（与 drawQuoteCard 同一结构类型；金句卡的 drawTextBlock 未导出，
// 此处按报告布局自绘，映射同一 17-token 主题）
// ---------------------------------------------------------------------------

function themeColor(theme: ResolvedCardTheme, role: CardColorRole): string {
  switch (role) {
    case "ink":
      return theme.ink;
    case "inkSoft":
      return theme.inkSoft;
    case "muted":
      return theme.muted;
    case "accent":
      return theme.accent;
    case "line":
      return theme.line;
  }
}

export function drawReportCard(
  ctx: CardCanvasContext,
  layout: ReportCardLayout,
  theme: ResolvedCardTheme,
): void {
  ctx.textBaseline = "top";
  ctx.fillStyle = layout.background === "paper" ? theme.paper : theme.paperRaised;
  ctx.fillRect(0, 0, layout.width, layout.height);
  for (const bar of layout.bars) {
    ctx.fillStyle = themeColor(theme, bar.color);
    ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
  }
  for (const divider of layout.dividers) {
    ctx.strokeStyle = themeColor(theme, divider.color);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(divider.x1, divider.y + 0.5);
    ctx.lineTo(divider.x2, divider.y + 0.5);
    ctx.stroke();
  }
  for (const block of layout.blocks) {
    ctx.font = cardFontCss(block.font);
    ctx.fillStyle = themeColor(theme, block.color);
    ctx.textAlign = block.align === "center" ? "center" : "left";
    const leading = Math.max(0, (block.lineHeightPx - block.font.sizePx) / 2);
    block.lines.forEach((line, index) => {
      ctx.fillText(line, block.x, block.y + index * block.lineHeightPx + leading);
    });
  }
}

// ---------------------------------------------------------------------------
// 渲染管线（与 renderQuoteCardDetailed 同姿势：2× 导出、可注入 canvas/measure）
// ---------------------------------------------------------------------------

export interface RenderReportCardsOptions {
  createCanvas?: (width: number, height: number) => CardCanvas;
  measure?: CardMeasure;
  dateLabel?: string;
}

export interface RenderedReportCard {
  id: ReportCardId;
  title: string;
  fileName: string;
  blob: Blob;
}

function createDomCanvas(width: number, height: number): CardCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function renderReportCards(
  data: ReadingReportData,
  theme: ResolvedCardTheme,
  options: RenderReportCardsOptions = {},
): Promise<RenderedReportCard[]> {
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
  const specs = layoutReportCards(data, measure, options.dateLabel);
  const rendered: RenderedReportCard[] = [];
  for (const spec of specs) {
    const canvas = createCanvas(
      spec.layout.width * CARD_EXPORT_SCALE,
      spec.layout.height * CARD_EXPORT_SCALE,
    );
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建 canvas 上下文");
    ctx.scale(CARD_EXPORT_SCALE, CARD_EXPORT_SCALE);
    drawReportCard(ctx, spec.layout, theme);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob) throw new Error("卡片导出失败（canvas.toBlob 未返回图像）");
    rendered.push({
      id: spec.id,
      title: spec.title,
      fileName: reportCardFileName(data.range.fileLabel, spec.title),
      blob,
    });
  }
  return rendered;
}
