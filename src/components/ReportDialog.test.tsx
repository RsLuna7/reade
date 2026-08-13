// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadingSession } from "../lib/backend";

// jsdom 无 canvas:出卡管线与出口在模块边界 mock,对话框只测接线
// (范围档禁用、卡片切换、复制/下载/全部下载)。
vi.mock("../lib/reportCards", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/reportCards")>();
  return { ...original, renderReportCards: vi.fn() };
});
vi.mock("../lib/quoteCard", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/quoteCard")>();
  return {
    ...original,
    readCardTheme: vi.fn(() => original.CARD_THEME_FALLBACK),
    copyImageToClipboard: vi.fn(),
    downloadBlobFile: vi.fn(),
  };
});

import { copyImageToClipboard, downloadBlobFile } from "../lib/quoteCard";
import { renderReportCards, type RenderedReportCard } from "../lib/reportCards";
import { ReportDialog } from "./ReportDialog";

const renderCardsMock = vi.mocked(renderReportCards);
const copyMock = vi.mocked(copyImageToClipboard);
const downloadMock = vi.mocked(downloadBlobFile);

function fakeCards(): RenderedReportCard[] {
  return [
    { id: "overview", title: "总览", fileName: "reade-report-2026-总览.png", blob: new Blob(["a"], { type: "image/png" }) },
    { id: "habit", title: "习惯", fileName: "reade-report-2026-习惯.png", blob: new Blob(["bb"], { type: "image/png" }) },
    { id: "books", title: "书单", fileName: "reade-report-2026-书单.png", blob: new Blob(["ccc"], { type: "image/png" }) },
  ];
}

/** 今年 8 个活跃日(满足 ≥7 门槛);本月只有 3 个活跃日(禁用)。 */
function sessions(): ReadingSession[] {
  const year = new Date().getFullYear();
  const make = (id: string, month: number, day: number): ReadingSession => {
    const startedAt = new Date(year, month, day, 10, 0, 0).getTime();
    return {
      id,
      relativePath: "docs/a.md",
      format: "markdown",
      title: "文档 A",
      startedAt,
      endedAt: startedAt + 30 * 60_000,
      activeSeconds: 1800,
    };
  };
  const now = new Date();
  // 另一个同年月份(避开当前月,防止跑在 1 月时两组落进同月)。
  const otherMonth = now.getMonth() === 0 ? 5 : 0;
  return [
    // 当前月 3 天(不足) + 其他月 5 天,合计今年 8 个活跃日。
    make("m1", now.getMonth(), 1),
    make("m2", now.getMonth(), 2),
    make("m3", now.getMonth(), 3),
    make("j1", otherMonth, 10),
    make("j2", otherMonth, 11),
    make("j3", otherMonth, 12),
    make("j4", otherMonth, 13),
    make("j5", otherMonth, 14),
  ];
}

beforeEach(() => {
  renderCardsMock.mockReset().mockResolvedValue(fakeCards());
  copyMock.mockReset().mockResolvedValue(true);
  downloadMock.mockReset();
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => `blob:report-${blob.size}`),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDialog(onClose = () => undefined) {
  return render(
    <ReportDialog
      sessions={sessions()}
      documents={[]}
      onClose={onClose}
      loadAnnotations={() => Promise.resolve([])}
    />,
  );
}

describe("ReportDialog", () => {
  it("defaults to the year range, renders cards and previews the first one", async () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "阅读报告" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "今年" })).toHaveAttribute("aria-pressed", "true");

    const preview = await screen.findByRole("img", { name: "总览卡片预览" });
    expect(preview).toHaveAttribute("src", expect.stringContaining("blob:report-"));
    expect(renderCardsMock).toHaveBeenCalledTimes(1);
    // 数据聚合真实跑过(未 mock readingReport),8 个活跃日通过门槛。
    expect(renderCardsMock.mock.calls[0][0].activeDays).toBe(8);
  });

  it("disables ranges below the active-day threshold with a hint", async () => {
    renderDialog();
    await screen.findByRole("img", { name: "总览卡片预览" });
    const month = screen.getByRole("button", { name: "本月" });
    expect(month).toBeDisabled();
    expect(month).toHaveAttribute("title", expect.stringContaining("不足 7 天"));
    expect(screen.getByRole("button", { name: "上一年" })).toBeDisabled();
  });

  it("switches the previewed card through the thumbnail strip", async () => {
    renderDialog();
    await screen.findByRole("img", { name: "总览卡片预览" });
    fireEvent.click(screen.getByRole("button", { name: "书单" }));
    expect(await screen.findByRole("img", { name: "书单卡片预览" })).toBeInTheDocument();
  });

  it("copies the active card and reports the result inline", async () => {
    renderDialog();
    await screen.findByRole("img", { name: "总览卡片预览" });
    fireEvent.click(screen.getByRole("button", { name: "复制本张" }));
    await waitFor(() => expect(copyMock).toHaveBeenCalledTimes(1));
    expect(copyMock.mock.calls[0][0].size).toBe(1);
    expect(await screen.findByText(/已复制「总览」/)).toBeInTheDocument();
  });

  it("keeps the dialog usable when the clipboard fails", async () => {
    copyMock.mockResolvedValue(false);
    renderDialog();
    await screen.findByRole("img", { name: "总览卡片预览" });
    fireEvent.click(screen.getByRole("button", { name: "复制本张" }));
    expect(await screen.findByText(/复制失败/)).toBeInTheDocument();
  });

  it("downloads the active card and all cards through the shared exit", async () => {
    renderDialog();
    await screen.findByRole("img", { name: "总览卡片预览" });
    fireEvent.click(screen.getByRole("button", { name: "下载本张" }));
    expect(downloadMock).toHaveBeenCalledWith("reade-report-2026-总览.png", expect.any(Blob));

    fireEvent.click(screen.getByRole("button", { name: "全部下载" }));
    expect(downloadMock).toHaveBeenCalledTimes(4);
    expect(await screen.findByText(/已开始下载全部 3 张/)).toBeInTheDocument();
  });

  it("shows the insufficient state instead of cards for a data-poor period", async () => {
    render(
      <ReportDialog
        sessions={[]}
        documents={[]}
        onClose={() => undefined}
        loadAnnotations={() => Promise.resolve([])}
      />,
    );
    expect(await screen.findByText(/活跃阅读日不足 7 天/)).toBeInTheDocument();
    expect(renderCardsMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "复制本张" })).toBeDisabled();
  });
});
