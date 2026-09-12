import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadingSession } from "./backend";
import { createReadingTracker, type ReadingTracker, type ReadingTrackerOptions } from "./readingTracker";

const DOC_A = { relativePath: "notes/a.md", format: "markdown" as const, title: "A" };
const DOC_B = { relativePath: "notes/b.pdf", format: "pdf" as const, title: "B" };

interface Harness {
  tracker: ReadingTracker;
  persisted: ReadingSession[];
  /** Advances wall clock, monotonic clock, and fake timers together. */
  advance: (ms: number) => void;
  /** Same as advance, but awaits timer callbacks and their microtasks. */
  advanceAsync: (ms: number) => Promise<void>;
  failNextPersist: () => void;
}

const WALL_START = 1_700_000_000_000;

function createHarness(overrides: Partial<ReadingTrackerOptions> = {}): Harness {
  let wall = WALL_START;
  let mono = 50_000;
  let failNext = false;
  const persisted: ReadingSession[] = [];
  const tracker = createReadingTracker({
    persist: (session) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("persist failed"));
      }
      persisted.push({ ...session });
      return Promise.resolve();
    },
    now: () => wall,
    monotonicNow: () => mono,
    ...overrides,
  });
  return {
    tracker,
    persisted,
    advance: (ms) => {
      wall += ms;
      mono += ms;
      vi.advanceTimersByTime(ms);
    },
    advanceAsync: async (ms) => {
      wall += ms;
      mono += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    failNextPersist: () => {
      failNext = true;
    },
  };
}

describe("readingTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accumulates active time and upserts the same session on each flush", () => {
    const { tracker, persisted, advance } = createHarness();
    tracker.openDocument(DOC_A);
    advance(30_000);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      relativePath: "notes/a.md",
      format: "markdown",
      title: "A",
      startedAt: WALL_START,
      activeSeconds: 30,
    });

    tracker.recordActivity();
    advance(30_000);
    expect(persisted).toHaveLength(2);
    expect(persisted[1].id).toBe(persisted[0].id);
    expect(persisted[1].activeSeconds).toBe(60);
    expect(persisted[1].endedAt).toBe(WALL_START + 60_000);
  });

  it("stops counting one idle timeout after the last interaction", () => {
    const { tracker, persisted, advance } = createHarness();
    tracker.openDocument(DOC_A);
    for (let i = 0; i < 6; i += 1) advance(30_000);

    const last = persisted[persisted.length - 1];
    expect(last.activeSeconds).toBe(60);
    expect(last.endedAt).toBe(WALL_START + 60_000);

    tracker.recordActivity();
    advance(30_000);
    expect(persisted[persisted.length - 1].activeSeconds).toBe(90);
  });

  it("drops sessions shorter than the minimum threshold", () => {
    const { tracker, persisted, advance } = createHarness();
    tracker.openDocument(DOC_A);
    advance(3_000);
    tracker.openDocument(DOC_B);
    expect(persisted).toHaveLength(0);

    tracker.recordActivity();
    advance(30_000);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].relativePath).toBe("notes/b.pdf");
  });

  it("pauses on blur and resumes on focus", () => {
    const { tracker, persisted, advance } = createHarness();
    tracker.openDocument(DOC_A);
    advance(10_000);
    tracker.setWindowActive(false);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].activeSeconds).toBe(10);

    advance(120_000);
    const persistedWhileHidden = persisted.length;
    tracker.setWindowActive(true);
    advance(20_000);

    const last = persisted[persisted.length - 1];
    expect(last.activeSeconds).toBe(30);
    expect(persisted.length).toBeGreaterThanOrEqual(persistedWhileHidden);
  });

  it("finalizes the previous session when switching documents", () => {
    const { tracker, persisted, advance } = createHarness();
    tracker.openDocument(DOC_A);
    advance(10_000);
    tracker.openDocument(DOC_B);
    advance(30_000);

    const forA = persisted.filter((session) => session.relativePath === "notes/a.md");
    const forB = persisted.filter((session) => session.relativePath === "notes/b.pdf");
    expect(forA).toHaveLength(1);
    expect(forA[0].activeSeconds).toBe(10);
    expect(forB.length).toBeGreaterThanOrEqual(1);
    expect(forB[0].id).not.toBe(forA[0].id);
  });

  it("keeps the running session when the same document is re-opened", () => {
    const { tracker, persisted, advance } = createHarness();
    tracker.openDocument(DOC_A);
    advance(10_000);
    tracker.openDocument({ ...DOC_A, title: "A refreshed" });
    advance(20_000);

    expect(persisted.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(persisted.map((session) => session.id));
    expect(ids.size).toBe(1);
    expect(persisted[persisted.length - 1].activeSeconds).toBe(30);
    expect(persisted[persisted.length - 1].title).toBe("A refreshed");
  });

  it("flushes on dispose and stops afterwards", () => {
    const { tracker, persisted, advance } = createHarness();
    tracker.openDocument(DOC_A);
    advance(10_000);
    tracker.dispose();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].activeSeconds).toBe(10);

    advance(120_000);
    tracker.recordActivity();
    tracker.flush();
    expect(persisted).toHaveLength(1);
  });

  it("retries after a failed persist", async () => {
    const { tracker, persisted, advance, failNextPersist } = createHarness();
    tracker.openDocument(DOC_A);
    failNextPersist();
    advance(30_000);
    expect(persisted).toHaveLength(0);
    await Promise.resolve();
    await Promise.resolve();

    tracker.flush();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].activeSeconds).toBe(30);
  });

  it("rolls over to a fresh session id beyond the active-time cap", () => {
    const { tracker, persisted, advance } = createHarness({ maxSessionActiveSeconds: 45 });
    tracker.openDocument(DOC_A);
    advance(30_000);
    tracker.recordActivity();
    advance(30_000);
    tracker.recordActivity();
    advance(30_000);

    const ids = [...new Set(persisted.map((session) => session.id))];
    expect(ids.length).toBe(2);
    const lastOfFirst = persisted.filter((session) => session.id === ids[0]).pop();
    expect(lastOfFirst?.activeSeconds).toBe(60);
  });

  // ---- D05: 保存失败退避重试、队列合并与关窗排空 ----

  it("retries a failed save with backoff and drops the queued copy once a newer save confirms", async () => {
    const { tracker, persisted, failNextPersist, advanceAsync } = createHarness({
      retryBackoffMs: [10],
    });
    tracker.openDocument(DOC_A);
    // async 推进按 30s 步进（单次长推进不会逐次触发 interval），每步交互续期。
    tracker.recordActivity();
    await advanceAsync(30_000);
    tracker.recordActivity();
    await advanceAsync(30_000);
    expect(persisted).toHaveLength(2);

    tracker.recordActivity();
    failNextPersist();
    await advanceAsync(30_000);
    expect(persisted).toHaveLength(2);
    // 10ms 退避后队列重试，送达失败时刻的 90s 快照。
    await advanceAsync(10);
    expect(persisted).toHaveLength(3);
    expect(persisted[2].activeSeconds).toBe(90);

    // 退避长于刷新间隔时的合并语义：新快照确认后，队列中的旧快照被清掉。
    const merged = createHarness({ retryBackoffMs: [60_000] });
    merged.tracker.openDocument(DOC_A);
    merged.tracker.recordActivity();
    await merged.advanceAsync(30_000);
    merged.tracker.recordActivity();
    await merged.advanceAsync(30_000);
    merged.tracker.recordActivity();
    merged.failNextPersist();
    await merged.advanceAsync(30_000);
    expect(merged.persisted).toHaveLength(2);
    merged.tracker.recordActivity();
    await merged.advanceAsync(30_000);
    expect(merged.persisted).toHaveLength(3);
    expect(merged.persisted[2].activeSeconds).toBe(120);
    expect(merged.persisted.some((session) => session.activeSeconds === 90)).toBe(false);
    tracker.dispose();
    merged.tracker.dispose();
  });

  it("flushPending drains queued writes immediately for the close flow", async () => {
    const { tracker, persisted, failNextPersist, advanceAsync } = createHarness({
      retryBackoffMs: [60_000],
    });
    tracker.openDocument(DOC_A);
    tracker.recordActivity();
    await advanceAsync(30_000);
    tracker.recordActivity();
    await advanceAsync(30_000);
    tracker.recordActivity();
    failNextPersist();
    await advanceAsync(30_000);
    expect(persisted).toHaveLength(2);

    // 不等待 60s 退避：关窗路径立即排空。
    await tracker.flushPending();
    expect(persisted).toHaveLength(3);
    expect(persisted[2].activeSeconds).toBe(90);
    tracker.dispose();
  });

  it("keeps saves queued until the session bind succeeds", async () => {
    let wall = WALL_START;
    let mono = 50_000;
    let failBind = true;
    let bindAttempts = 0;
    const persisted: ReadingSession[] = [];
    const binds: ReadingSession[] = [];
    const tracker = createReadingTracker({
      persist: (session) => {
        persisted.push({ ...session });
        return Promise.resolve();
      },
      bind: (session) => {
        bindAttempts += 1;
        binds.push({ ...session });
        if (failBind) return Promise.reject(new Error("database busy"));
        return Promise.resolve();
      },
      now: () => wall,
      monotonicNow: () => mono,
      retryBackoffMs: [10],
    });
    const advanceAsync = async (ms: number) => {
      wall += ms;
      mono += ms;
      await vi.advanceTimersByTimeAsync(ms);
    };

    tracker.openDocument(DOC_A);
    await advanceAsync(70_000);
    // bind 未成功前不会有任何保存落地。
    expect(persisted).toHaveLength(0);
    expect(bindAttempts).toBeGreaterThanOrEqual(2);

    failBind = false;
    await advanceAsync(10);
    expect(persisted).toHaveLength(1);
    // 队列里合并出的最新快照被送达，且 id 与 bind 一致。
    expect(persisted[0].id).toBe(binds[0].id);
    expect(persisted[0].relativePath).toBe(DOC_A.relativePath);
    tracker.dispose();
  });
});
