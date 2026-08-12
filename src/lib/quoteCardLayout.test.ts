import { describe, expect, it } from "vitest";
import {
  CARD_MAX_HEIGHT,
  CARD_MIN_HEIGHT,
  CARD_WIDTH,
  EMPTY_QUOTE_PLACEHOLDER,
  LINE_WIDTH_SAFETY,
  MAX_QUOTE_CHARS,
  QUOTE_ELLIPSIS,
  TRUNCATED_QUOTE_LINES,
  formatCardDateLabel,
  layoutQuoteCard,
  layoutQuoteLines,
  quoteFontSizePx,
  type CardFont,
  type CardMeasure,
  type QuoteCardInput,
} from "./quoteCardLayout";

/** Deterministic measurer: every code point advances one em (`font.sizePx`). */
const emMeasure: CardMeasure = (text, font) => [...text].length * font.sizePx;

const font20: CardFont = { sizePx: 20, family: "sans" };

function input(quote: string, overrides: Partial<QuoteCardInput> = {}): QuoteCardInput {
  return { quote, sourceTitle: "测试文档", dateLabel: "2026年8月13日", ...overrides };
}

describe("layoutQuoteLines", () => {
  it("breaks pure CJK per character without overflowing the width", () => {
    const text = "字".repeat(13);
    const lines = layoutQuoteLines(text, 100, emMeasure, font20); // 5 chars per line
    expect(lines).toEqual(["字字字字字", "字字字字字", "字字字"]);
    for (const line of lines) {
      expect(emMeasure(line, font20)).toBeLessThanOrEqual(100);
    }
    expect(lines.join("")).toBe(text);
  });

  it("wraps Latin text at word boundaries and keeps words whole", () => {
    const lines = layoutQuoteLines("alpha beta gamma", 220, emMeasure, font20); // 11 chars per line
    expect(lines).toEqual(["alpha beta", "gamma"]);
  });

  it("hard-splits a lone word wider than the line", () => {
    const word = "x".repeat(12);
    const lines = layoutQuoteLines(word, 100, emMeasure, font20);
    expect(lines).toEqual(["xxxxx", "xxxxx", "xx"]);
  });

  it("keeps a Latin word intact across a mixed CJK boundary", () => {
    const lines = layoutQuoteLines("四个中文字word之后", 100, emMeasure, font20);
    expect(lines[0]).toBe("四个中文字");
    expect(lines[1]).toContain("word");
    expect(lines.join("")).toBe("四个中文字word之后");
  });

  it("pulls a forbidden line-start character up to the previous line", () => {
    // Single correction pass, no re-flow: the moved character may leave the
    // previous line slightly over-wide and later lines unchanged (plan §3.3).
    const lines = layoutQuoteLines("一二三四五。六七八九十", 100, emMeasure, font20);
    expect(lines).toEqual(["一二三四五。", "六七八九", "十"]);
  });

  it("pushes a forbidden line-end character down to the next line", () => {
    const lines = layoutQuoteLines("一二三四《五六七八九", 100, emMeasure, font20);
    expect(lines).toEqual(["一二三四", "《五六七八九"]);
  });

  it("collapses whitespace at line boundaries", () => {
    const lines = layoutQuoteLines("alpha  beta", 220, emMeasure, font20);
    expect(lines).toEqual(["alpha beta"]);
  });
});

describe("quoteFontSizePx", () => {
  it("follows the 60/160 ladder", () => {
    expect(quoteFontSizePx(1)).toBe(28);
    expect(quoteFontSizePx(60)).toBe(28);
    expect(quoteFontSizePx(61)).toBe(22);
    expect(quoteFontSizePx(160)).toBe(22);
    expect(quoteFontSizePx(161)).toBe(18);
    expect(quoteFontSizePx(2000)).toBe(18);
  });
});

describe("layoutQuoteCard", () => {
  it("applies the font ladder from the quote length", () => {
    expect(layoutQuoteCard(input("短".repeat(60)), "plain", emMeasure).quote.font.sizePx).toBe(28);
    expect(layoutQuoteCard(input("中".repeat(61)), "plain", emMeasure).quote.font.sizePx).toBe(22);
    expect(layoutQuoteCard(input("长".repeat(161)), "plain", emMeasure).quote.font.sizePx).toBe(18);
  });

  it("keeps every line inside the safety-margin wrap width", () => {
    const layout = layoutQuoteCard(input("测".repeat(150)), "plain", emMeasure);
    const wrapWidth = (CARD_WIDTH - 64 * 2) * LINE_WIDTH_SAFETY;
    for (const line of layout.quote.lines) {
      expect(emMeasure(line, layout.quote.font)).toBeLessThanOrEqual(wrapWidth);
    }
    expect(layout.truncated).toBe(false);
  });

  it("truncates layouts above the line cap and ends with the ellipsis", () => {
    // A deliberately wide measurer forces many short lines out of ≤240 chars.
    const wide: CardMeasure = (text) => [...text].length * 50;
    const layout = layoutQuoteCard(input("行".repeat(MAX_QUOTE_CHARS)), "plain", wide);
    expect(layout.truncated).toBe(true);
    expect(layout.quote.lines).toHaveLength(TRUNCATED_QUOTE_LINES);
    const lastLine = layout.quote.lines[layout.quote.lines.length - 1];
    expect(lastLine.endsWith(QUOTE_ELLIPSIS)).toBe(true);
    const wrapWidth = (CARD_WIDTH - 64 * 2) * LINE_WIDTH_SAFETY;
    for (const line of layout.quote.lines) {
      expect(wide(line, layout.quote.font)).toBeLessThanOrEqual(wrapWidth);
    }
  });

  it("clips quotes above the character cap and marks them truncated", () => {
    const layout = layoutQuoteCard(input("超".repeat(300)), "plain", emMeasure);
    expect(layout.truncated).toBe(true);
    const joined = layout.quote.lines.join("");
    expect(joined.endsWith(QUOTE_ELLIPSIS)).toBe(true);
    expect(joined.replace(QUOTE_ELLIPSIS, "").length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(layout.quote.font.sizePx).toBe(18);
  });

  it("renders a fixed placeholder line for empty or whitespace-only quotes", () => {
    for (const quote of ["", "   \n\t "]) {
      const layout = layoutQuoteCard(input(quote), "plain", emMeasure);
      expect(layout.quote.lines).toEqual([EMPTY_QUOTE_PLACEHOLDER]);
      expect(layout.truncated).toBe(false);
    }
  });

  it("ellipsizes an over-wide source title while keeping the date intact", () => {
    const layout = layoutQuoteCard(
      input("引文。", { sourceTitle: "书名".repeat(60) }),
      "plain",
      emMeasure,
    );
    const attribution = layout.attribution.lines[0];
    expect(attribution).toContain("…");
    expect(attribution.endsWith(" · 2026年8月13日")).toBe(true);
    expect(emMeasure(attribution, layout.attribution.font)).toBeLessThanOrEqual(
      CARD_WIDTH - 64 * 2,
    );
  });

  it("drops the separator when the source title is empty", () => {
    const layout = layoutQuoteCard(input("引文。", { sourceTitle: "  " }), "plain", emMeasure);
    expect(layout.attribution.lines).toEqual(["2026年8月13日"]);
  });

  it("lays out the plain(素笺) style with decoration, divider and brand", () => {
    const layout = layoutQuoteCard(input("短句。"), "plain", emMeasure);
    expect(layout.background).toBe("paper");
    expect(layout.decoration).not.toBeNull();
    expect(layout.decoration?.color).toBe("accent");
    expect(layout.divider).not.toBeNull();
    expect(layout.brand?.lines).toEqual(["Reade"]);
    expect(layout.quote.align).toBe("left");
    expect(layout.quote.font.family).toBe("sans");
    // Bottom-anchored meta row: attribution + line height + bottom padding = card height.
    expect(layout.attribution.y + 22 + 56).toBe(layout.height);
    expect(layout.divider?.y).toBe(layout.attribution.y - 18);
    // The brand mark hugs the right content edge.
    const brand = layout.brand;
    expect(brand).not.toBeNull();
    if (brand) {
      expect(brand.x + emMeasure("Reade", brand.font)).toBeLessThanOrEqual(CARD_WIDTH - 64);
    }
  });

  it("lays out the serif(衬线中轴) style centered without chrome", () => {
    const layout = layoutQuoteCard(input("居中句。"), "serif", emMeasure);
    expect(layout.background).toBe("paperRaised");
    expect(layout.decoration).toBeNull();
    expect(layout.divider).toBeNull();
    expect(layout.brand).toBeNull();
    expect(layout.quote.align).toBe("center");
    expect(layout.quote.x).toBe(CARD_WIDTH / 2);
    expect(layout.quote.font.family).toBe("serif");
    expect(layout.attribution.align).toBe("center");
    // Symmetric whitespace: the content block is vertically centered.
    const bottomGap =
      layout.height - (layout.attribution.y + layout.attribution.lineHeightPx);
    expect(Math.abs(layout.quote.y - bottomGap)).toBeLessThanOrEqual(1);
  });

  it("clamps the card height into the 480–1080 range", () => {
    const short = layoutQuoteCard(input("一句。"), "plain", emMeasure);
    expect(short.height).toBe(CARD_MIN_HEIGHT);
    const wide: CardMeasure = (text) => [...text].length * 50;
    const tall = layoutQuoteCard(input("行".repeat(MAX_QUOTE_CHARS)), "serif", wide);
    expect(tall.height).toBeGreaterThanOrEqual(CARD_MIN_HEIGHT);
    expect(tall.height).toBeLessThanOrEqual(CARD_MAX_HEIGHT);
  });

  it("keeps the card width at the fixed 720 logical pixels", () => {
    expect(layoutQuoteCard(input("宽度。"), "plain", emMeasure).width).toBe(CARD_WIDTH);
    expect(layoutQuoteCard(input("宽度。"), "serif", emMeasure).width).toBe(CARD_WIDTH);
  });
});

describe("formatCardDateLabel", () => {
  it("formats as YYYY年M月D日 without zero padding", () => {
    expect(formatCardDateLabel(new Date(2026, 7, 13))).toBe("2026年8月13日");
    expect(formatCardDateLabel(new Date(2026, 0, 5))).toBe("2026年1月5日");
  });
});
