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
});
