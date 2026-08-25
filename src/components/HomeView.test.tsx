// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeView, formatRelativeTime } from "./HomeView";
import {
  listAnnotations,
  listReadingSessions,
  readDocument,
  type Annotation,
  type DocumentInfo,
  type ReadingSession,
} from "../lib/backend";
import { writeHomeBaseline } from "../lib/homeData";
import { shiftMonthsClamped } from "../lib/onThisDay";
import { writeReadingPosition } from "../lib/readingPositions";
import { DEFAULT_READING_SETTINGS, useReaderStore } from "../store/useReaderStore";

vi.mock("../lib/backend", async () => {
  const actual = await vi.importActual<typeof import("../lib/backend")>("../lib/backend");
  return {
    ...actual,
    listAnnotations: vi.fn(async () => []),
    listReadingSessions: vi.fn(async () => []),
    readDocument: vi.fn(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# Doc",
    })),
  };
});

const ROOT = "D:\\books";
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

function session(
  relativePath: string,
  endedAt: number,
  overrides: Partial<ReadingSession> = {},
): ReadingSession {
  return {
    id: `${relativePath}:${endedAt}`,
    relativePath,
    format: "markdown",
    title: null,
    startedAt: endedAt - 10 * 60 * 1000,
    endedAt,
    activeSeconds: 600,
    ...overrides,
  };
}

function setHomeState(documents: DocumentInfo[]): void {
  useReaderStore.setState({
    snapshot: { rootPath: ROOT, documents },
    documents,
    currentPath: null,
    currentContent: null,
    currentLocator: null,
    searchQuery: "",
    searchResults: [],
    readingSettings: { ...DEFAULT_READING_SETTINGS },
    motionLevel: "off",
    activeView: "home",
    dailyGoalMinutes: 0,
    loading: false,
    error: null,
  });
}

/** 目标日中午的时间戳:一年前 / 一个月前的「今天」。 */
function onThisDayStamp(deltaMonths: number): number {
  const target = shiftMonthsClamped(Date.now(), deltaMonths);
  target.setHours(12, 0, 0, 0);
  return target.getTime();
}

function memoryAnnotation(
  id: string,
  relativePath: string,
  createdAt: number,
  overrides: Partial<Annotation> = {},
): Annotation {
  return {
    id,
    relativePath,
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: `一年前划下的句子 ${id}`,
    title: null,
    locator: {
      kind: "markdown",
      quote: `一年前划下的句子 ${id}`,
      prefix: "",
      suffix: "",
      headingId: null,
    },
    sortIndex: "M|00000|00000000",
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(listAnnotations).mockReset().mockImplementation(async () => []);
  vi.mocked(listReadingSessions).mockReset().mockImplementation(async () => []);
  vi.mocked(readDocument).mockClear();
});

afterEach(cleanup);

describe("HomeView (desktop)", () => {
  it("lists recent documents with progress and reopens one on click", async () => {
    const documents = [doc("guide.md", { title: "入门指南" }), doc("other.md")];
    setHomeState(documents);
    writeReadingPosition(ROOT, "guide.md", { kind: "scroll", scrollRatio: 0.4 });
    writeReadingPosition(ROOT, "guide.md", { kind: "scroll", scrollRatio: 0.62 });
    vi.mocked(listReadingSessions).mockResolvedValue([
      session("guide.md", Date.now() - HOUR_MS),
    ]);

    render(<HomeView />);

    const title = await screen.findByText("入门指南");
    expect(screen.getByText("读到 62%")).toBeInTheDocument();
    // 「今日进度」卡在会话落在同一自然日时也会显示同样的时长文案,
    // 因此把断言限定在「继续阅读」卡内(修复对运行时刻敏感的原断言)。
    const continueCard = screen.getByRole("region", { name: "继续阅读" });
    expect(within(continueCard).getByText("10 分钟")).toBeInTheDocument();

    const row = title.closest("button");
    expect(row).not.toBeNull();
    // 卡片行是原生 button:可 Tab 聚焦、Enter 激活。
    row!.focus();
    expect(row).toHaveFocus();
    fireEvent.click(row!);

    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("guide.md");
    });
    // store 契约:从主页打开文档自动切回阅读面。
    expect(useReaderStore.getState().activeView).toBe("reader");
    expect(readDocument).toHaveBeenCalledWith("guide.md");
  });

  it("keeps continue-reading on the current library while today still counts every library", async () => {
    setHomeState([doc("guide.md", { title: "入门指南" })]);
    vi.mocked(listReadingSessions).mockResolvedValue([
      session("guide.md", Date.now() - HOUR_MS, {
        libraryRoot: "D:/other-shelf",
        title: "别的库里的同名文件",
        id: "foreign",
      }),
    ]);

    render(<HomeView />);

    expect(
      await screen.findByText("还没有阅读记录，从左侧选择一篇文档开始。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("别的库里的同名文件")).not.toBeInTheDocument();

    const today = await screen.findByRole("region", { name: "今日进度" });
    expect(within(today).getByText("10 分钟")).toBeInTheDocument();
  });

  it("appends the remaining-time estimate when the callback provides one", async () => {
    const documents = [doc("guide.md", { title: "入门指南" })];
    setHomeState(documents);
    writeReadingPosition(ROOT, "guide.md", { kind: "scroll", scrollRatio: 0.5 });
    vi.mocked(listReadingSessions).mockResolvedValue([
      session("guide.md", Date.now() - HOUR_MS),
    ]);
    const remainingEstimate = vi.fn(() => "剩余约 12 分钟");

    render(<HomeView remainingEstimate={remainingEstimate} />);

    expect(await screen.findByText("剩余约 12 分钟")).toBeInTheDocument();
    // 回调收到路径与高水位进度,由 App 侧折算剩余字符。
    expect(remainingEstimate).toHaveBeenCalledWith(
      "guide.md",
      expect.objectContaining({ kind: "ratio" }),
    );
  });

  it("shows the guidance empty state for a library without history", async () => {
    setHomeState([doc("fresh-start.md")]);

    render(<HomeView />);

    expect(
      await screen.findByText("还没有阅读记录，从左侧选择一篇文档开始。"),
    ).toBeInTheDocument();
    // 首次访问尚无 baseline:新动态卡提示下次来访生效。
    expect(
      screen.getByText("从下次来访开始，这里会列出库里新增或修改的文档。"),
    ).toBeInTheDocument();
  });

  it("hides the goal ring at goal 0 and shows it with a configured goal", async () => {
    setHomeState([doc("guide.md")]);
    vi.mocked(listReadingSessions).mockResolvedValue([
      session("guide.md", Date.now() - 5 * 60 * 1000),
    ]);

    const view = render(<HomeView />);
    await screen.findByRole("region", { name: "今日进度" });
    await waitFor(() => {
      expect(view.container.querySelector(".home-progress-value")).not.toBeNull();
    });
    expect(view.container.querySelector(".stats-goal-ring")).toBeNull();
    expect(screen.getByText(/目标|还没有开始阅读|未设定每日目标/)).toBeInTheDocument();

    useReaderStore.setState({ dailyGoalMinutes: 30 });
    await waitFor(() => {
      expect(view.container.querySelector(".stats-goal-ring")).not.toBeNull();
    });
    expect(screen.getByText(/目标 30 分 · 完成 \d+%/)).toBeInTheDocument();
  });

  it("lists documents modified after the baseline and opens them", async () => {
    const now = Date.now();
    const documents = [
      doc("changed.md", { title: "新修改的文档", modified: now - 10 * 60 * 1000 }),
      doc("old.md", { modified: now - 50 * 24 * HOUR_MS }),
    ];
    setHomeState(documents);
    writeHomeBaseline(ROOT, now - HOUR_MS);

    render(<HomeView />);

    const freshCard = await screen.findByRole("region", { name: "库内新动态" });
    expect(freshCard).toHaveTextContent("1 篇有更新");
    expect(freshCard).toHaveTextContent("新修改的文档");
    expect(freshCard).not.toHaveTextContent("old");

    fireEvent.click(screen.getByText("新修改的文档").closest("button")!);
    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("changed.md");
    });
  });

  it("never shows a due-review card on the home view", async () => {
    setHomeState([doc("guide.md")]);

    render(<HomeView />);
    await screen.findByRole("region", { name: "继续阅读" });
    expect(screen.queryByRole("region", { name: "今日回顾" })).not.toBeInTheDocument();
    expect(screen.queryByText("开始回顾")).not.toBeInTheDocument();
    expect(screen.queryByText(/待回顾/)).not.toBeInTheDocument();
  });

  it("degrades to the empty state when the session store fails", async () => {
    setHomeState([doc("guide.md")]);
    vi.mocked(listReadingSessions).mockRejectedValue(new Error("sqlite unavailable"));

    render(<HomeView />);

    expect(
      await screen.findByText("还没有阅读记录，从左侧选择一篇文档开始。"),
    ).toBeInTheDocument();
  });
});

describe("HomeView 那年今日 (plan-on-this-day)", () => {
  it("keeps the card out of the tree when no target day has traces", async () => {
    setHomeState([doc("guide.md")]);
    vi.mocked(listAnnotations).mockResolvedValue([
      // 昨天的标注不属于任何目标日。
      memoryAnnotation("recent", "guide.md", Date.now() - 24 * HOUR_MS),
    ]);

    render(<HomeView />);

    await screen.findByRole("region", { name: "继续阅读" });
    await waitFor(() => {
      expect(listAnnotations).toHaveBeenCalled();
    });
    expect(screen.queryByRole("region", { name: "那年今日" })).not.toBeInTheDocument();
  });

  it("renders year-ago annotations and hands clicks to the annotation jump chain", async () => {
    const documents = [doc("guide.md", { title: "入门指南" })];
    setHomeState(documents);
    const yearAgo = onThisDayStamp(-12);
    const target = memoryAnnotation("y-1", "guide.md", yearAgo);
    vi.mocked(listAnnotations).mockResolvedValue([target]);
    const onOpenAnnotation = vi.fn();

    render(<HomeView onOpenAnnotation={onOpenAnnotation} />);

    const card = await screen.findByRole("region", { name: "那年今日" });
    expect(within(card).getByText("一年前的今天")).toBeInTheDocument();
    expect(within(card).getByText("高亮")).toBeInTheDocument();
    expect(within(card).getByText("入门指南")).toBeInTheDocument();

    fireEvent.click(within(card).getByText("一年前划下的句子 y-1").closest("button")!);
    expect(onOpenAnnotation).toHaveBeenCalledWith(expect.objectContaining({ id: "y-1" }));
    // 跳转链由 App 负责,这里不应产生兜底的文档切换。
    expect(readDocument).not.toHaveBeenCalled();
  });

  it("falls back to opening the document when no jump chain is provided", async () => {
    setHomeState([doc("guide.md", { title: "入门指南" })]);
    vi.mocked(listAnnotations).mockResolvedValue([
      memoryAnnotation("y-1", "guide.md", onThisDayStamp(-12)),
    ]);

    render(<HomeView />);

    const card = await screen.findByRole("region", { name: "那年今日" });
    fireEvent.click(within(card).getByText("一年前划下的句子 y-1").closest("button")!);
    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("guide.md");
    });
  });

  it("fills the month-ago group with ≥5min documents and opens them on click", async () => {
    const documents = [doc("guide.md", { title: "入门指南" }), doc("novel.md", { title: "长篇" })];
    setHomeState(documents);
    const monthAgoNoon = onThisDayStamp(-1);
    vi.mocked(listReadingSessions).mockResolvedValue([
      session("novel.md", monthAgoNoon, {
        startedAt: monthAgoNoon - 900 * 1000,
        endedAt: monthAgoNoon,
        activeSeconds: 900,
      }),
    ]);

    render(<HomeView />);

    const card = await screen.findByRole("region", { name: "那年今日" });
    expect(within(card).getByText("一个月前的今天")).toBeInTheDocument();
    expect(within(card).getByText("当天读了 15 分钟")).toBeInTheDocument();

    fireEvent.click(within(card).getByText("长篇").closest("button")!);
    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("novel.md");
    });
  });

  it("hides the card when the annotation store fails", async () => {
    setHomeState([doc("guide.md")]);
    vi.mocked(listAnnotations).mockRejectedValue(new Error("store unavailable"));

    render(<HomeView />);

    await screen.findByRole("region", { name: "继续阅读" });
    expect(screen.queryByRole("region", { name: "那年今日" })).not.toBeInTheDocument();
  });
});

describe("formatRelativeTime", () => {
  it("buckets recent stamps into human-readable steps", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 20_000, now)).toBe("刚刚");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(formatRelativeTime(now - 3 * HOUR_MS, now)).toBe("3 小时前");
    expect(formatRelativeTime(now - 30 * HOUR_MS, now)).toBe("昨天");
    expect(formatRelativeTime(now - 6 * 24 * HOUR_MS, now)).toBe("6 天前");
  });
});
