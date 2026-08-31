// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType, ReactNode } from "react";
import { StatsView } from "./StatsView";
import {
  listAnnotations,
  listDocumentExtents,
  type Annotation,
  type DocumentInfo,
  type ReadingSession,
} from "../lib/backend";
import { writeReadingPosition } from "../lib/readingPositions";
import { DEFAULT_READING_SETTINGS, useReaderStore } from "../store/useReaderStore";

vi.mock("../lib/backend", async () => {
  const actual = await vi.importActual<typeof import("../lib/backend")>("../lib/backend");
  return {
    ...actual,
    listAnnotations: vi.fn(async () => []),
    listDocumentExtents: vi.fn(async () => []),
  };
});

// 图表与热力图依赖 ResizeObserver,在 jsdom 中以空组件替身;
// 本测试只覆盖阅读足迹卡片的数字与交互。
vi.mock("recharts", () => {
  const Noop = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Null = () => null;
  const stub: Record<string, ComponentType<{ children?: ReactNode }>> = {
    ResponsiveContainer: Noop,
    AreaChart: Noop,
    BarChart: Noop,
    ComposedChart: Noop,
    Area: Null,
    Bar: Null,
    Line: Null,
    Cell: Null,
    XAxis: Null,
    YAxis: Null,
    CartesianGrid: Null,
    Tooltip: Null,
    ReferenceLine: Null,
  };
  return stub;
});
vi.mock("react-activity-calendar", () => ({ ActivityCalendar: () => null }));
vi.mock("./CoverageTreemap", () => ({ CoverageTreemap: () => null }));

const ROOT = "D:\\books";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function doc(relativePath: string, overrides: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    relativePath,
    title: relativePath.replace(/\.[^.]+$/, ""),
    size: 1024,
    modified: Date.now() - 3 * DAY_MS,
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

function annotation(id: string, relativePath: string): Annotation {
  return {
    id,
    relativePath,
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: `句子 ${id}`,
    title: null,
    locator: {
      kind: "markdown",
      quote: `句子 ${id}`,
      prefix: "",
      suffix: "",
      headingId: null,
    },
    sortIndex: "M|00000|00000000",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
  };
}

function setStatsState(documents: DocumentInfo[]): void {
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
    activeView: "stats",
    dailyGoalMinutes: 0,
    loading: false,
    error: null,
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(listAnnotations).mockReset().mockImplementation(async () => []);
  vi.mocked(listDocumentExtents).mockReset().mockImplementation(async () => []);
});

afterEach(cleanup);

describe("StatsView footprint card", () => {
  it("counts documents read, finished, active days and notes", async () => {
    setStatsState([doc("a.md"), doc("b.md"), doc("c.md")]);
    // a.md 高水位 0.99 → 读完;b.md 0.5 → 只算读过。
    writeReadingPosition(ROOT, "a.md", { kind: "scroll", scrollRatio: 0.99 });
    writeReadingPosition(ROOT, "b.md", { kind: "scroll", scrollRatio: 0.5 });
    vi.mocked(listAnnotations).mockResolvedValue([
      annotation("1", "a.md"),
      annotation("2", "a.md"),
      annotation("3", "b.md"),
    ]);
    const now = Date.now();
    const loadSessions = vi.fn(async () => [
      session("a.md", now - HOUR_MS),
      session("b.md", now - DAY_MS),
    ]);

    render(<StatsView loadSessions={loadSessions} />);

    const card = await screen.findByRole("region", { name: "阅读足迹" });
    await waitFor(() => {
      expect(within(card).getByText("笔记").parentElement).toHaveTextContent("笔记3条");
    });
    expect(within(card).getByText("读过").parentElement).toHaveTextContent("读过2篇");
    expect(within(card).getByText("读完").parentElement).toHaveTextContent("读完1篇");
    expect(within(card).getByText("阅读").parentElement).toHaveTextContent("阅读2天");
    expect(within(card).getByText(/与 Reade 相伴/)).toBeInTheDocument();
  });

  it("opens the finished-documents drawer with coverage rows", async () => {
    setStatsState([doc("a.md", { title: "读完的书" }), doc("b.md")]);
    writeReadingPosition(ROOT, "a.md", { kind: "scroll", scrollRatio: 1 });
    const now = Date.now();
    const loadSessions = vi.fn(async () => [session("a.md", now - HOUR_MS)]);

    render(<StatsView loadSessions={loadSessions} />);

    const card = await screen.findByRole("region", { name: "阅读足迹" });
    fireEvent.click(within(card).getByRole("button", { name: /读完/ }));

    const drawer = await screen.findByRole("dialog", { name: "读完的文档" });
    expect(within(drawer).getByText("读完的书")).toBeInTheDocument();
    expect(within(drawer).getByText("100%")).toBeInTheDocument();
  });

  it("navigates to the annotation hub from the notes entry", async () => {
    setStatsState([doc("a.md")]);
    vi.mocked(listAnnotations).mockResolvedValue([annotation("1", "a.md")]);
    const now = Date.now();
    const loadSessions = vi.fn(async () => [session("a.md", now - HOUR_MS)]);

    render(<StatsView loadSessions={loadSessions} />);

    const card = await screen.findByRole("region", { name: "阅读足迹" });
    await waitFor(() => {
      expect(within(card).getByRole("button", { name: /笔记/ })).toBeEnabled();
    });
    fireEvent.click(within(card).getByRole("button", { name: /笔记/ }));
    expect(useReaderStore.getState().activeView).toBe("annotations");
  });

  it("lists other-library documents in the ranking but does not let them open", async () => {
    setStatsState([doc("a.md", { title: "当前库" })]);
    const now = Date.now();
    const loadSessions = vi.fn(async () => [
      session("a.md", now - HOUR_MS, { libraryRoot: ROOT, title: "当前库", id: "cur" }),
      session("a.md", now - 2 * HOUR_MS, {
        libraryRoot: "D:/papers",
        title: "另一库",
        id: "oth",
      }),
    ]);

    render(<StatsView loadSessions={loadSessions} />);

    const ranking = await screen.findByRole("region", { name: "文档时长排行" });
    expect(within(ranking).getByTitle("打开 a.md")).toBeEnabled();
    const foreign = within(ranking).getByTitle("来自文档库「papers」· 打开该库后可跳转");
    expect(foreign).toBeDisabled();
    expect(within(ranking).getByText("（papers）")).toBeInTheDocument();
  });

  it("treats Windows canonicalize-prefixed sessions as openable in the current library", async () => {
    setStatsState([doc("a.md", { title: "当前库" })]);
    const now = Date.now();
    const loadSessions = vi.fn(async () => [
      session("a.md", now - HOUR_MS, {
        libraryRoot: "//?/D:/books",
        title: "当前库",
        id: "verbatim",
      }),
    ]);

    render(<StatsView loadSessions={loadSessions} />);

    const ranking = await screen.findByRole("region", { name: "文档时长排行" });
    expect(within(ranking).getByTitle("打开 a.md")).toBeEnabled();
    expect(within(ranking).queryByText("（books）")).not.toBeInTheDocument();
    expect(
      screen.queryByTitle("来自文档库「books」· 打开该库后可跳转"),
    ).not.toBeInTheDocument();
  });

  it("renders weekly reading windows as a Gantt instead of a punch grid", async () => {
    setStatsState([doc("a.md")]);
    const monday = new Date(2026, 7, 10, 19, 0, 0, 0).getTime();
    const loadSessions = vi.fn(async () => [
      session("a.md", monday, {
        startedAt: monday - 2 * HOUR_MS,
        activeSeconds: 4_800,
      }),
    ]);

    render(<StatsView loadSessions={loadSessions} />);

    const section = await screen.findByRole("region", { name: "星期与时段阅读习惯" });
    expect(within(section).getByText("各日阅读时段")).toBeInTheDocument();
    expect(within(section).getByText(/高峰在/)).toBeInTheDocument();
    expect(within(section).getByTitle(/周一 .* · /)).toBeInTheDocument();
    expect(within(section).queryByLabelText("按星期与小时分布的阅读习惯网格")).not.toBeInTheDocument();
  });

  it("replaces format share with sitting-depth bands", async () => {
    setStatsState([doc("a.md")]);
    const now = Date.now();
    const loadSessions = vi.fn(async () => [
      session("a.md", now - HOUR_MS, { id: "short", activeSeconds: 120 }),
      session("a.md", now - 2 * HOUR_MS, { id: "mid", activeSeconds: 12 * 60 }),
      session("a.md", now - 3 * HOUR_MS, { id: "deep", activeSeconds: 40 * 60 }),
    ]);

    render(<StatsView loadSessions={loadSessions} />);

    const card = await screen.findByRole("region", { name: "阅读节奏" });
    expect(within(card).getByText("短读")).toBeInTheDocument();
    expect(within(card).getByText("中读")).toBeInTheDocument();
    expect(within(card).getByText("沉浸")).toBeInTheDocument();
    expect(within(card).getByText("长读")).toBeInTheDocument();
    expect(within(card).getByText(/中位单次/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "格式占比" })).not.toBeInTheDocument();
  });
});
