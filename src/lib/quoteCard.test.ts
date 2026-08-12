// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CARD_EXPORT_SCALE,
  CARD_THEME_FALLBACK,
  cardFontCss,
  copyImageToClipboard,
  downloadBlobFile,
  drawQuoteCard,
  quoteCardFileName,
  readCardTheme,
  renderQuoteCard,
  type CardCanvas,
  type CardCanvasContext,
  type ResolvedCardTheme,
} from "./quoteCard";
import { layoutQuoteCard, type CardMeasure } from "./quoteCardLayout";

// Compile-time checks: the real canvas surfaces satisfy the injected shapes,
// so the wiring pass can pass them through untouched.
(null as unknown as CanvasRenderingContext2D) satisfies CardCanvasContext;
(null as unknown as HTMLCanvasElement) satisfies CardCanvas;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const theme: ResolvedCardTheme = {
  paper: "#111111",
  paperRaised: "#222222",
  ink: "#333333",
  inkSoft: "#444444",
  muted: "#555555",
  accent: "#666666",
  line: "#777777",
};

type RecordedOp = Record<string, unknown> & { op: string };

/** Recording context double (jsdom has no real canvas — plan Q0 notes this). */
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
    this.ops.push({
      op: "fillText",
      text,
      x,
      y,
      fillStyle: this.fillStyle,
      font: this.font,
      align: this.textAlign,
    });
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

describe("readCardTheme", () => {
  it("reads all seven tokens from the computed style", () => {
    const values: Record<string, string> = {
      "--paper": "#0a0a0a",
      "--paper-raised": "#0b0b0b",
      "--ink": "#0c0c0c",
      "--ink-soft": "#0d0d0d",
      "--muted": "#0e0e0e",
      "--accent": "#0f0f0f",
      "--line": "rgba(1, 2, 3, 0.5)",
    };
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => values[name] ?? "",
    } as unknown as CSSStyleDeclaration);
    expect(readCardTheme(document.documentElement)).toEqual({
      paper: "#0a0a0a",
      paperRaised: "#0b0b0b",
      ink: "#0c0c0c",
      inkSoft: "#0d0d0d",
      muted: "#0e0e0e",
      accent: "#0f0f0f",
      line: "rgba(1, 2, 3, 0.5)",
    });
  });

  it("falls back to the :root defaults for missing tokens", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => (name === "--accent" ? "#123456" : "  "),
    } as unknown as CSSStyleDeclaration);
    expect(readCardTheme(document.documentElement)).toEqual({
      ...CARD_THEME_FALLBACK,
      accent: "#123456",
    });
  });
});

describe("cardFontCss", () => {
  it("builds the shorthand with the system stacks and default weight", () => {
    expect(cardFontCss({ sizePx: 22, family: "sans" })).toMatch(/^400 22px Inter,/);
    expect(cardFontCss({ sizePx: 16, family: "serif", weight: 700 })).toMatch(
      /^700 16px "Iowan Old Style",/,
    );
  });
});

describe("drawQuoteCard", () => {
  const measure: CardMeasure = (text, font) => [...text].length * font.sizePx;
  const cardInput = { quote: "第一行文字。", sourceTitle: "文档", dateLabel: "2026年8月13日" };

  it("paints the background first, then quote, divider, attribution, brand", () => {
    const layout = layoutQuoteCard(cardInput, "plain", measure);
    const ctx = new FakeContext();
    drawQuoteCard(ctx, layout, theme);

    const first = ctx.ops[0];
    expect(first).toMatchObject({
      op: "fillRect",
      x: 0,
      y: 0,
      width: layout.width,
      height: layout.height,
      fillStyle: theme.paper,
    });
    const texts = ctx.ops.filter((op) => op.op === "fillText");
    expect(texts.some((op) => op.fillStyle === theme.accent && op.text === "\u201c")).toBe(true);
    expect(
      texts.some((op) => op.fillStyle === theme.ink && op.text === layout.quote.lines[0]),
    ).toBe(true);
    expect(
      texts.some(
        (op) => op.fillStyle === theme.muted && op.text === layout.attribution.lines[0],
      ),
    ).toBe(true);
    expect(texts.some((op) => op.fillStyle === theme.accent && op.text === "Reade")).toBe(true);
    expect(ctx.ops.some((op) => op.op === "stroke" && op.strokeStyle === theme.line)).toBe(true);
    expect(ctx.textBaseline).toBe("top");
  });

  it("uses the raised background and centered text for the serif style", () => {
    const layout = layoutQuoteCard(cardInput, "serif", measure);
    const ctx = new FakeContext();
    drawQuoteCard(ctx, layout, theme);
    expect(ctx.ops[0]).toMatchObject({ op: "fillRect", fillStyle: theme.paperRaised });
    const quoteOp = ctx.ops.find(
      (op) => op.op === "fillText" && op.text === layout.quote.lines[0],
    );
    expect(quoteOp).toMatchObject({ align: "center", x: layout.width / 2 });
    expect(ctx.ops.some((op) => op.op === "stroke")).toBe(false);
  });
});

describe("renderQuoteCard", () => {
  const cardInput = { quote: "渲染冒烟。", sourceTitle: "文档", dateLabel: "2026年8月13日" };

  it("renders at the constant 2x scale and resolves the PNG blob", async () => {
    const created: FakeCanvas[] = [];
    const createCanvas = (width: number, height: number) => {
      const canvas = new FakeCanvas(width, height);
      created.push(canvas);
      return canvas;
    };
    const blob = await renderQuoteCard(cardInput, "plain", theme, { createCanvas });
    expect(blob.type).toBe("image/png");

    // First canvas is the measurement probe, second the card surface.
    expect(created).toHaveLength(2);
    const card = created[1];
    const expectedLayout = layoutQuoteCard(cardInput, "plain", (text) => [...text].length * 10);
    expect(card.width).toBe(expectedLayout.width * CARD_EXPORT_SCALE);
    expect(card.height).toBe(expectedLayout.height * CARD_EXPORT_SCALE);
    expect(card.ctx.ops[0]).toEqual({
      op: "scale",
      x: CARD_EXPORT_SCALE,
      y: CARD_EXPORT_SCALE,
    });
    expect(card.ctx.ops[1]).toMatchObject({ op: "fillRect", fillStyle: theme.paper });
  });

  it("rejects when the canvas cannot produce a blob", async () => {
    const createCanvas = (width: number, height: number) =>
      new FakeCanvas(width, height, null);
    await expect(
      renderQuoteCard(cardInput, "serif", theme, { createCanvas }),
    ).rejects.toThrow(/toBlob/);
  });
});

describe("copyImageToClipboard", () => {
  const pngBlob = new Blob(["png"], { type: "image/png" });

  class FakeClipboardItem {
    constructor(readonly items: Record<string, Blob>) {}
  }

  it("writes one ClipboardItem carrying image/png and reports success", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const ok = await copyImageToClipboard(pngBlob, {
      clipboard: { write },
      clipboardItem: FakeClipboardItem as unknown as typeof ClipboardItem,
    });
    expect(ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0][0][0] as FakeClipboardItem;
    expect(item.items["image/png"]).toBe(pngBlob);
  });

  it("returns false without throwing when ClipboardItem is unavailable", async () => {
    await expect(
      copyImageToClipboard(pngBlob, { clipboard: { write: vi.fn() }, clipboardItem: null }),
    ).resolves.toBe(false);
    await expect(
      copyImageToClipboard(pngBlob, {
        clipboard: null,
        clipboardItem: FakeClipboardItem as unknown as typeof ClipboardItem,
      }),
    ).resolves.toBe(false);
  });

  it("returns false when the write is rejected (permission, clipboard managers)", async () => {
    const write = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    await expect(
      copyImageToClipboard(pngBlob, {
        clipboard: { write },
        clipboardItem: FakeClipboardItem as unknown as typeof ClipboardItem,
      }),
    ).resolves.toBe(false);
  });

  it("honours a supports() probe that rejects image/png", async () => {
    const write = vi.fn();
    class Unsupported extends FakeClipboardItem {
      static supports(type: string): boolean {
        return type !== "image/png";
      }
    }
    await expect(
      copyImageToClipboard(pngBlob, {
        clipboard: { write },
        clipboardItem: Unsupported as unknown as typeof ClipboardItem,
      }),
    ).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("downloadBlobFile", () => {
  it("clicks a transient anchor pointing at the blob and revokes the URL", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => "blob:fake-card");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    downloadBlobFile("reade-quote-20260813.png", new Blob(["png"], { type: "image/png" }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector("a")).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-card");
  });
});

describe("quoteCardFileName", () => {
  it("stamps the generation day", () => {
    expect(quoteCardFileName(new Date(2026, 7, 13))).toBe("reade-quote-20260813.png");
  });
});
