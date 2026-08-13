// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardLayout, CardStyleId } from "../lib/quoteCardLayout";

// jsdom has no canvas: the render pipeline is mocked at the module boundary
// and the dialog is tested for wiring (preview, style switch, export flows).
vi.mock("../lib/quoteCard", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/quoteCard")>();
  return {
    ...original,
    readCardTheme: vi.fn(() => original.CARD_THEME_FALLBACK),
    renderQuoteCardDetailed: vi.fn(),
    copyImageToClipboard: vi.fn(),
    downloadBlobFile: vi.fn(),
  };
});
vi.mock("../lib/regionCard", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/regionCard")>();
  return { ...original, renderRegionCard: vi.fn() };
});

import {
  copyImageToClipboard,
  downloadBlobFile,
  renderQuoteCardDetailed,
} from "../lib/quoteCard";
import { renderRegionCard, type RegionImageSource } from "../lib/regionCard";
import { QuoteCardDialog } from "./QuoteCardDialog";

const renderCardMock = vi.mocked(renderQuoteCardDetailed);
const renderRegionMock = vi.mocked(renderRegionCard);
const copyMock = vi.mocked(copyImageToClipboard);
const downloadMock = vi.mocked(downloadBlobFile);

function fakeLayout(styleId: CardStyleId, truncated = false): CardLayout {
  return {
    styleId,
    width: 720,
    height: 480,
    background: "paper",
    truncated,
    decoration: null,
    quote: {
      lines: ["行"],
      x: 0,
      y: 0,
      font: { sizePx: 22, family: "sans" },
      lineHeightPx: 37,
      align: "left",
      color: "ink",
    },
    divider: null,
    attribution: {
      lines: ["出处"],
      x: 0,
      y: 0,
      font: { sizePx: 15, family: "sans" },
      lineHeightPx: 22,
      align: "left",
      color: "muted",
    },
    brand: null,
  };
}

const source = { quote: "把屏幕重新留给文字。", sourceTitle: "Guide" };

beforeEach(() => {
  renderCardMock.mockReset().mockImplementation(async (_input, styleId) => ({
    blob: new Blob([styleId], { type: "image/png" }),
    layout: fakeLayout(styleId),
  }));
  renderRegionMock.mockReset().mockResolvedValue({
    blob: new Blob(["region"], { type: "image/png" }),
    layout: {
      width: 720,
      height: 480,
      image: { x: 56, y: 56, width: 608, height: 300 },
      divider: { x1: 56, x2: 664, y: 400 },
      attribution: {
        lines: ["《书》 · 第 3 页"],
        x: 56,
        y: 418,
        font: { sizePx: 15, family: "sans" },
        lineHeightPx: 22,
        align: "left",
        color: "muted",
      },
      brand: {
        lines: ["Reade"],
        x: 620,
        y: 418,
        font: { sizePx: 16, family: "serif", weight: 600 },
        lineHeightPx: 22,
        align: "left",
        color: "accent",
      },
    },
  });
  copyMock.mockReset().mockResolvedValue(true);
  downloadMock.mockReset();
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => `blob:card-${blob.size}`),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("QuoteCardDialog", () => {
  it("renders the preview image from the rendered blob and re-renders on style switch", async () => {
    render(
      <QuoteCardDialog source={source} onClose={() => undefined} onNotice={() => undefined} />,
    );

    expect(screen.getByRole("dialog", { name: "金句卡片" })).toBeInTheDocument();
    const image = await screen.findByRole("img", { name: "金句卡片预览" });
    expect(image).toHaveAttribute("src", expect.stringContaining("blob:card-"));
    expect(renderCardMock).toHaveBeenCalledTimes(1);
    expect(renderCardMock.mock.calls[0][1]).toBe("plain");
    // 出处行日期是生成当日(plan §3.3),引文与标题原样传入。
    expect(renderCardMock.mock.calls[0][0]).toMatchObject({
      quote: source.quote,
      sourceTitle: source.sourceTitle,
    });

    fireEvent.click(screen.getByRole("button", { name: "衬线中轴" }));
    await waitFor(() => {
      expect(renderCardMock).toHaveBeenCalledTimes(2);
    });
    expect(renderCardMock.mock.calls[1][1]).toBe("serif");
    expect(screen.getByRole("button", { name: "衬线中轴" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("copies the PNG, notifies and closes on success", async () => {
    const onClose = vi.fn();
    const onNotice = vi.fn();
    render(<QuoteCardDialog source={source} onClose={onClose} onNotice={onNotice} />);
    await screen.findByRole("img", { name: "金句卡片预览" });

    fireEvent.click(screen.getByRole("button", { name: "复制图片" }));
    await waitFor(() => {
      expect(copyMock).toHaveBeenCalledTimes(1);
    });
    expect(onNotice).toHaveBeenCalledWith("卡片已复制，可直接粘贴到聊天或笔记应用。");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open with a download hint when the clipboard fails", async () => {
    copyMock.mockResolvedValue(false);
    const onClose = vi.fn();
    render(<QuoteCardDialog source={source} onClose={onClose} onNotice={() => undefined} />);
    await screen.findByRole("img", { name: "金句卡片预览" });

    fireEvent.click(screen.getByRole("button", { name: "复制图片" }));
    expect(await screen.findByText(/可改用「下载 PNG」/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "下载 PNG" }));
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(downloadMock.mock.calls[0][0]).toMatch(/^reade-quote-\d{8}\.png$/);
  });

  it("surfaces the truncation hint when the layout was cut", async () => {
    renderCardMock.mockImplementation(async (_input, styleId) => ({
      blob: new Blob(["x"], { type: "image/png" }),
      layout: fakeLayout(styleId, true),
    }));
    render(
      <QuoteCardDialog source={source} onClose={() => undefined} onNotice={() => undefined} />,
    );
    expect(await screen.findByText("引文过长，已截断。")).toBeInTheDocument();
  });

  it("shows the error state when rendering fails", async () => {
    renderCardMock.mockRejectedValue(new Error("canvas 不可用"));
    render(
      <QuoteCardDialog source={source} onClose={() => undefined} onNotice={() => undefined} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("canvas 不可用");
    expect(screen.getByRole("button", { name: "复制图片" })).toBeDisabled();
  });
});

describe("QuoteCardDialog region variant (plan-pdf-region-card RG-D3)", () => {
  const image = { width: 800, height: 400 } as unknown as RegionImageSource;
  const regionSource = {
    kind: "region" as const,
    image,
    sourceTitle: "矩阵分析",
    page: 12,
  };

  it("renders through renderRegionCard, retitles the dialog and hides the style toggle", async () => {
    render(
      <QuoteCardDialog source={regionSource} onClose={() => undefined} onNotice={() => undefined} />,
    );
    expect(screen.getByRole("dialog", { name: "引用卡片" })).toBeInTheDocument();
    await screen.findByRole("img", { name: "引用卡片预览" });
    expect(renderRegionMock).toHaveBeenCalledTimes(1);
    expect(renderRegionMock.mock.calls[0][0]).toBe(image);
    expect(renderRegionMock.mock.calls[0][1]).toMatchObject({ sourceTitle: "矩阵分析", page: 12 });
    expect(renderCardMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "卡片版式" })).not.toBeInTheDocument();
  });

  it("downloads with the region file name and copies through the shared exit", async () => {
    render(
      <QuoteCardDialog source={regionSource} onClose={() => undefined} onNotice={() => undefined} />,
    );
    await screen.findByRole("img", { name: "引用卡片预览" });
    fireEvent.click(screen.getByRole("button", { name: "下载 PNG" }));
    expect(downloadMock.mock.calls[0][0]).toBe("reade-引用-矩阵分析-p12.png");

    fireEvent.click(screen.getByRole("button", { name: "复制图片" }));
    await waitFor(() => expect(copyMock).toHaveBeenCalledTimes(1));
  });
});
