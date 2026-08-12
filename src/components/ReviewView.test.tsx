// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewView, type ReviewSession } from "./ReviewView";
import {
  listReviewQueue,
  recordReviewOutcome,
  type Annotation,
  type DocumentInfo,
  type ReviewQueueItem,
} from "../lib/backend";
import { localDayKey } from "../lib/readingStats";
import { useReaderStore } from "../store/useReaderStore";

vi.mock("../lib/backend", async () => {
  const actual = await vi.importActual<typeof import("../lib/backend")>("../lib/backend");
  return {
    ...actual,
    listReviewQueue: vi.fn(async () => []),
    recordReviewOutcome: vi.fn(async () => undefined),
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;
// 固定本地时钟:2026-08-12 09:00(月份参数 0 起算)。
const NOW = new Date(2026, 7, 12, 9, 0, 0).getTime();

function doc(relativePath: string, title: string): DocumentInfo {
  return {
    relativePath,
    title,
    size: 1024,
    modified: 1,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
  };
}

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "r-1",
    relativePath: "guide.md",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "第一段摘录",
    title: "第一段摘录",
    locator: { kind: "markdown", quote: "第一段摘录", prefix: "", suffix: "", headingId: null },
    sortIndex: "M|00000|00000000",
    createdAt: NOW - 10 * DAY_MS,
    updatedAt: NOW - 10 * DAY_MS,
    ...overrides,
  };
}

function queueItem(
  id: string,
  overrides: Partial<Annotation> = {},
  review: Partial<ReviewQueueItem["review"]> = {},
): ReviewQueueItem {
  return {
    annotation: annotation({ id, ...overrides }),
    review: {
      box: 0,
      dueAt: NOW - DAY_MS,
      lastReviewedAt: null,
      totalReviews: 0,
      suspended: false,
      ...review,
    },
  };
}

function Harness({
  initial = null,
  onOpenAnnotation = () => undefined,
  onExit = () => undefined,
}: {
  initial?: ReviewSession | null;
  onOpenAnnotation?: (annotation: Annotation) => void;
  onExit?: () => void;
}) {
  const [session, setSession] = useState<ReviewSession | null>(initial);
  return (
    <ReviewView
      session={session}
      onSessionChange={setSession}
      onOpenAnnotation={onOpenAnnotation}
      onExit={onExit}
      now={() => NOW}
    />
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(listReviewQueue).mockReset().mockImplementation(async () => []);
  vi.mocked(recordReviewOutcome).mockReset().mockImplementation(async () => undefined);
  useReaderStore.setState({
    documents: [doc("guide.md", "指南"), doc("other.md", "其他文档")],
    motionLevel: "off",
  });
});

afterEach(cleanup);

describe("ReviewView cards (R1)", () => {
  it("renders excerpt, note and source, then advances on 记住了 with a box upgrade", async () => {
    vi.mocked(listReviewQueue).mockResolvedValue([
      queueItem("r-1", { note: "我的想法" }, { dueAt: NOW - 2 * DAY_MS }),
      queueItem("r-2", {
        relativePath: "other.md",
        selectedText: "第二段摘录",
        title: "第二段摘录",
      }),
    ]);

    render(<Harness />);

    expect(await screen.findByText("第一段摘录")).toBeInTheDocument();
    expect(screen.getByText("我的想法")).toBeInTheDocument();
    expect(screen.getByText("指南")).toBeInTheDocument();
    expect(screen.getByText("回味你划下的段落 · 1 / 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "记住了" }));
    await waitFor(() => {
      expect(recordReviewOutcome).toHaveBeenCalledTimes(1);
    });
    // 阶梯:box 0 → 1,到期 = now + 3 天(INTERVALS[1])。
    expect(recordReviewOutcome).toHaveBeenCalledWith(
      "r-1",
      expect.objectContaining({
        box: 1,
        dueAt: NOW + 3 * DAY_MS,
        lastReviewedAt: NOW,
        suspended: false,
      }),
    );

    expect(await screen.findByText("第二段摘录")).toBeInTheDocument();
    expect(screen.getByText("回味你划下的段落 · 2 / 2")).toBeInTheDocument();
  });

  it("resets the ladder on 再看一次", async () => {
    vi.mocked(listReviewQueue).mockResolvedValue([queueItem("r-1", {}, { box: 3 })]);

    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "再看一次" }));

    await waitFor(() => {
      expect(recordReviewOutcome).toHaveBeenCalledWith(
        "r-1",
        expect.objectContaining({ box: 0, dueAt: NOW + DAY_MS }),
      );
    });
  });

  it("suspends only after the confirmation dialog", async () => {
    vi.mocked(listReviewQueue).mockResolvedValue([queueItem("r-1", {}, { box: 2 })]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "不再回顾" }));
    expect(recordReviewOutcome).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "不再回顾" }));
    await waitFor(() => {
      expect(recordReviewOutcome).toHaveBeenCalledWith(
        "r-1",
        expect.objectContaining({ box: 2, suspended: true }),
      );
    });
    // suspend 不计入今日回顾数。
    expect(await screen.findByText("今日已回顾 0 条标注。")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("skips the card silently when the outcome write fails", async () => {
    vi.mocked(listReviewQueue).mockResolvedValue([
      queueItem("r-1", {}, { dueAt: NOW - 2 * DAY_MS }),
      queueItem("r-2", {
        relativePath: "other.md",
        selectedText: "第二段摘录",
        title: "第二段摘录",
      }),
    ]);
    vi.mocked(recordReviewOutcome).mockRejectedValueOnce(new Error("annotation deleted"));

    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "记住了" }));

    // 写回失败:卡片照常前进,不弹错误。
    expect(await screen.findByText("第二段摘录")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "记住了" }));
    // 完成态只统计成功写回的那 1 条。
    expect(await screen.findByText("这批回顾完成")).toBeInTheDocument();
    expect(screen.getByText("今日已回顾 1 条标注。")).toBeInTheDocument();
  });
});

describe("ReviewView keyboard (R2)", () => {
  it("maps 1 / Enter / 2 / Esc to the review actions", async () => {
    const onOpenAnnotation = vi.fn();
    const onExit = vi.fn();
    vi.mocked(listReviewQueue).mockResolvedValue([
      queueItem("r-1", {}, { dueAt: NOW - 2 * DAY_MS }),
      queueItem("r-2", {
        relativePath: "other.md",
        selectedText: "第二段摘录",
        title: "第二段摘录",
      }),
    ]);

    render(<Harness onOpenAnnotation={onOpenAnnotation} onExit={onExit} />);
    await screen.findByText("第一段摘录");

    fireEvent.keyDown(window, { key: "1" });
    await waitFor(() => {
      expect(recordReviewOutcome).toHaveBeenCalledTimes(1);
    });
    await screen.findByText("第二段摘录");

    fireEvent.keyDown(window, { key: "Enter" });
    expect(onOpenAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r-2" }),
    );

    fireEvent.keyDown(window, { key: "2" });
    await waitFor(() => {
      expect(recordReviewOutcome).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(recordReviewOutcome).mock.calls[1][1]).toMatchObject({ box: 0 });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("leaves Space and Enter to native activation while a button is focused", async () => {
    const onOpenAnnotation = vi.fn();
    vi.mocked(listReviewQueue).mockResolvedValue([queueItem("r-1")]);

    render(<Harness onOpenAnnotation={onOpenAnnotation} />);
    const remember = await screen.findByRole("button", { name: "记住了" });
    remember.focus();

    // 全局监听必须忽略按钮上的 Space/Enter(原生 click 是唯一触发路径),
    // 否则一次按键会触发两次动作。
    fireEvent.keyDown(remember, { key: " " });
    fireEvent.keyDown(remember, { key: "Enter" });
    expect(recordReviewOutcome).not.toHaveBeenCalled();
    expect(onOpenAnnotation).not.toHaveBeenCalled();

    // 数字键不受焦点位置影响。
    fireEvent.keyDown(remember, { key: "1" });
    await waitFor(() => {
      expect(recordReviewOutcome).toHaveBeenCalledTimes(1);
    });
  });
});

describe("ReviewView queue states", () => {
  it("shows the empty state with the next due date", async () => {
    vi.mocked(listReviewQueue).mockImplementation(async (nowMs: number) =>
      nowMs > NOW
        ? [queueItem("future-1", {}, { dueAt: NOW + 3 * DAY_MS })]
        : [],
    );

    render(<Harness />);

    expect(await screen.findByText("今天没有待回顾的标注。")).toBeInTheDocument();
    // NOW = 8 月 12 日,+3 天 → 8 月 15 日。
    expect(screen.getByText("下次最早到期：8月15日")).toBeInTheDocument();
  });

  it("guides the user towards highlighting when the pool is empty", async () => {
    vi.mocked(listReviewQueue).mockResolvedValue([]);
    render(<Harness />);
    expect(
      await screen.findByText("在正文中划几条高亮或下划线，明天就会出现在这里。"),
    ).toBeInTheDocument();
  });

  it("continues a same-day session without refetching", async () => {
    const session: ReviewSession = {
      dayKey: localDayKey(NOW),
      queue: [queueItem("r-1")],
      cursor: 0,
      reviewedCount: 2,
    };
    render(<Harness initial={session} />);

    expect(screen.getByText("第一段摘录")).toBeInTheDocument();
    expect(listReviewQueue).not.toHaveBeenCalled();
  });

  it("fetches another batch from the completion state, keeping the daily count", async () => {
    const session: ReviewSession = {
      dayKey: localDayKey(NOW),
      queue: [queueItem("r-1")],
      cursor: 1,
      reviewedCount: 4,
    };
    vi.mocked(listReviewQueue).mockResolvedValue([
      queueItem("r-9", { selectedText: "新一批摘录", title: "新一批摘录" }),
    ]);

    render(<Harness initial={session} />);
    expect(screen.getByText("这批回顾完成")).toBeInTheDocument();
    expect(screen.getByText("今日已回顾 4 条标注。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "再来一批" }));
    expect(await screen.findByText("新一批摘录")).toBeInTheDocument();

    // 新一批完成后,今日计数在旧基数上继续累计。
    fireEvent.click(screen.getByRole("button", { name: "记住了" }));
    expect(await screen.findByText("今日已回顾 5 条标注。")).toBeInTheDocument();
  });
});
