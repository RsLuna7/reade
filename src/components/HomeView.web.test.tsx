// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeView } from "./HomeView";
import { listReadingSessions, readDocument, type DocumentInfo } from "../lib/backend";
import { writeReadingPosition } from "../lib/readingPositions";
import { DEFAULT_READING_SETTINGS, useReaderStore } from "../store/useReaderStore";

// Web 构建的行为契约:APP_RUNTIME 是编译期常量,这里在模块图层面
// 把它替换为 "web",其余 backend 导出保持原样(会话接口挂上间谍)。
vi.mock("../lib/backend", async () => {
  const actual = await vi.importActual<typeof import("../lib/backend")>("../lib/backend");
  return {
    ...actual,
    APP_RUNTIME: "web" as const,
    listReadingSessions: vi.fn(async () => []),
    readDocument: vi.fn(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# Doc",
    })),
  };
});

const WEB_ROOT = "我的在线文档库";
const HOUR_MS = 60 * 60 * 1000;

function doc(relativePath: string, overrides: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    relativePath,
    title: relativePath.replace(/\.[^.]+$/, ""),
    size: 1024,
    modified: Date.now() - 40 * 24 * HOUR_MS,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(listReadingSessions).mockClear();
  vi.mocked(readDocument).mockClear();
  const documents = [doc("a.md", { title: "较早的文档" }), doc("b.md", { title: "最近的文档" })];
  useReaderStore.setState({
    snapshot: { rootPath: WEB_ROOT, documents },
    documents,
    currentPath: null,
    currentContent: null,
    currentLocator: null,
    readingSettings: { ...DEFAULT_READING_SETTINGS },
    motionLevel: "off",
    activeView: "home",
    dailyGoalMinutes: 30,
    loading: false,
    error: null,
  });
});

afterEach(cleanup);

describe("HomeView (web build)", () => {
  it("renders the position-based fallback without any session calls", async () => {
    writeReadingPosition(WEB_ROOT, "a.md", { kind: "scroll", scrollRatio: 0.3 }, Date.now() - 2 * HOUR_MS);
    writeReadingPosition(WEB_ROOT, "b.md", { kind: "scroll", scrollRatio: 0.8 }, Date.now() - HOUR_MS);

    const view = render(<HomeView />);

    await screen.findByText("最近的文档");
    // 按持久化位置 updatedAt 排序:最近的在前。
    const titles = Array.from(
      view.container.querySelectorAll(".home-continue-title"),
    ).map((node) => node.textContent);
    expect(titles.slice(0, 2)).toEqual(["最近的文档", "较早的文档"]);

    // ② 今日进度卡 Web 端不渲染,目标已设也不例外。
    expect(screen.queryByRole("region", { name: "今日进度" })).not.toBeInTheDocument();
    // Web 构建不得调用 Tauri 会话接口。
    expect(listReadingSessions).not.toHaveBeenCalled();
  });

  it("opens a document from the fallback list and returns to the reader", async () => {
    writeReadingPosition(WEB_ROOT, "b.md", { kind: "scroll", scrollRatio: 0.8 }, Date.now() - HOUR_MS);

    render(<HomeView />);

    fireEvent.click((await screen.findByText("最近的文档")).closest("button")!);
    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("b.md");
    });
    expect(useReaderStore.getState().activeView).toBe("reader");
    expect(listReadingSessions).not.toHaveBeenCalled();
  });

  it("keeps the fresh-documents card available on the web", async () => {
    render(<HomeView />);
    expect(await screen.findByRole("region", { name: "库内新动态" })).toBeInTheDocument();
  });
});
