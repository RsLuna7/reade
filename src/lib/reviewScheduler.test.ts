import { describe, expect, it } from "vitest";
import { localDayKey } from "./readingStats";
import {
  applyReviewOutcome,
  buildReviewQueue,
  DAILY_REVIEW_LIMIT,
  initialReviewState,
  isReviewableAnnotation,
  REVIEW_INTERVALS_DAYS,
  REVIEW_MAX_BOX,
  type ReviewQueueCandidate,
  type ReviewState,
} from "./reviewScheduler";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    box: 0,
    dueAt: NOW - DAY_MS,
    lastReviewedAt: null,
    totalReviews: 0,
    suspended: false,
    ...overrides,
  };
}

function candidate(
  id: string,
  relativePath: string,
  review: Partial<ReviewState> = {},
): ReviewQueueCandidate {
  return { annotation: { id, relativePath }, review: state(review) };
}

describe("state machine", () => {
  it("enrollment start state is box 0 due one day after join", () => {
    expect(initialReviewState(NOW)).toEqual({
      box: 0,
      dueAt: NOW + DAY_MS,
      lastReviewedAt: null,
      totalReviews: 0,
      suspended: false,
    });
  });

  it("remembered climbs the full ladder and caps at 60 days", () => {
    let current = initialReviewState(NOW - DAY_MS);
    // Walk box 0 → 1 → 2 → 3 → 4 → 5; each step lands on the new box's interval.
    for (let step = 1; step <= REVIEW_MAX_BOX; step += 1) {
      current = applyReviewOutcome(current, "remembered", NOW);
      expect(current.box).toBe(step);
      expect(current.dueAt).toBe(NOW + REVIEW_INTERVALS_DAYS[step] * DAY_MS);
      expect(current.lastReviewedAt).toBe(NOW);
      expect(current.totalReviews).toBe(step);
      expect(current.suspended).toBe(false);
    }
    // Remembering at the top box stays capped at the 60-day interval.
    const capped = applyReviewOutcome(current, "remembered", NOW);
    expect(capped.box).toBe(REVIEW_MAX_BOX);
    expect(capped.dueAt).toBe(NOW + 60 * DAY_MS);
    expect(capped.totalReviews).toBe(REVIEW_MAX_BOX + 1);
  });

  it("again resets any box to 0 and re-dues tomorrow", () => {
    const reset = applyReviewOutcome(
      state({ box: 4, dueAt: NOW - 3 * DAY_MS, totalReviews: 7, lastReviewedAt: NOW - DAY_MS }),
      "again",
      NOW,
    );
    expect(reset).toEqual({
      box: 0,
      dueAt: NOW + DAY_MS,
      lastReviewedAt: NOW,
      totalReviews: 8,
      suspended: false,
    });
  });

  it("suspend flips the flag, keeps counters, and clamps the due date up to now", () => {
    const overdue = applyReviewOutcome(
      state({ box: 2, dueAt: NOW - 30 * DAY_MS, totalReviews: 3, lastReviewedAt: NOW - 31 * DAY_MS }),
      "suspend",
      NOW,
    );
    // Box/counters untouched (restore stays possible, R-D4); dueAt clamped so
    // it fits the server validation window [now − 1h, now + 180d].
    expect(overdue).toEqual({
      box: 2,
      dueAt: NOW,
      lastReviewedAt: NOW - 31 * DAY_MS,
      totalReviews: 3,
      suspended: true,
    });
    const future = applyReviewOutcome(state({ dueAt: NOW + 5 * DAY_MS }), "suspend", NOW);
    expect(future.dueAt).toBe(NOW + 5 * DAY_MS);
    expect(future.suspended).toBe(true);
  });
});

describe("review pool membership", () => {
  it("accepts marks with a non-blank excerpt and rejects bookmarks and empty excerpts", () => {
    expect(isReviewableAnnotation({ kind: "highlight", selectedText: "摘录" })).toBe(true);
    expect(isReviewableAnnotation({ kind: "underline", selectedText: "excerpt" })).toBe(true);
    expect(isReviewableAnnotation({ kind: "bookmark", selectedText: "text" })).toBe(false);
    expect(isReviewableAnnotation({ kind: "highlight", selectedText: "   " })).toBe(false);
    expect(isReviewableAnnotation({ kind: "highlight", selectedText: null })).toBe(false);
    expect(isReviewableAnnotation({ kind: "highlight" })).toBe(false);
  });
});

describe("buildReviewQueue", () => {
  it("keeps only due, unsuspended candidates", () => {
    const queue = buildReviewQueue(
      [
        candidate("due", "a.md", { dueAt: NOW }),
        candidate("future", "a.md", { dueAt: NOW + 1 }),
        candidate("suspended", "a.md", { dueAt: NOW - DAY_MS, suspended: true }),
      ],
      NOW,
    );
    expect(queue.map((item) => item.annotation.id)).toEqual(["due"]);
  });

  it("is byte-stable for the same inputs and seed, and defaults to the local day key", () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate(`ann-${index}`, `doc-${index % 3}.md`, { dueAt: NOW - DAY_MS }),
    );
    const first = buildReviewQueue(candidates, NOW, 10, "2026-08-10");
    const second = buildReviewQueue(candidates, NOW, 10, "2026-08-10");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const defaulted = buildReviewQueue(candidates, NOW, 10);
    const explicit = buildReviewQueue(candidates, NOW, 10, localDayKey(NOW));
    expect(defaulted).toEqual(explicit);
  });

  it("reshuffles ties on a new day seed", () => {
    // Identical due dates in a single document isolate the seeded tiebreak.
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate(`ann-${index}`, "doc.md", { dueAt: NOW - DAY_MS }),
    );
    const monday = buildReviewQueue(candidates, NOW, 12, "2026-08-10");
    const tuesday = buildReviewQueue(candidates, NOW, 12, "2026-08-11");
    expect(monday.map((item) => item.annotation.id)).not.toEqual(
      tuesday.map((item) => item.annotation.id),
    );
    // Same membership either day; only the order moves.
    expect([...monday].map((item) => item.annotation.id).sort()).toEqual(
      [...tuesday].map((item) => item.annotation.id).sort(),
    );
  });

  it("puts the most overdue candidate first", () => {
    const queue = buildReviewQueue(
      [
        candidate("recent", "a.md", { dueAt: NOW - 1 }),
        candidate("oldest", "b.md", { dueAt: NOW - 9 * DAY_MS }),
        candidate("middle", "c.md", { dueAt: NOW - 2 * DAY_MS }),
      ],
      NOW,
      3,
      "seed",
    );
    expect(queue.map((item) => item.annotation.id)).toEqual(["oldest", "middle", "recent"]);
  });

  it("rotates documents so no title appears twice in a row (3 docs × 10 marks)", () => {
    const candidates: ReviewQueueCandidate[] = [];
    for (const doc of ["a.md", "b.md", "c.md"]) {
      for (let index = 0; index < 10; index += 1) {
        candidates.push(
          candidate(`${doc}-${index}`, doc, { dueAt: NOW - (index + 1) * 60_000 }),
        );
      }
    }
    const queue = buildReviewQueue(candidates, NOW, DAILY_REVIEW_LIMIT, "2026-08-10");
    expect(queue).toHaveLength(10);
    for (let index = 1; index < queue.length; index += 1) {
      // Acceptance bound is "no more than 2 consecutive"; strict round-robin
      // over three documents never repeats at all.
      expect(queue[index].annotation.relativePath).not.toBe(
        queue[index - 1].annotation.relativePath,
      );
    }
    const documents = new Set(queue.map((item) => item.annotation.relativePath));
    expect(documents.size).toBe(3);
  });

  it("trims to the limit and returns everything when the limit exceeds the pool", () => {
    const candidates = Array.from({ length: 30 }, (_, index) =>
      candidate(`ann-${index}`, `doc-${index % 3}.md`, { dueAt: NOW - DAY_MS }),
    );
    expect(buildReviewQueue(candidates, NOW, 10, "seed")).toHaveLength(10);
    expect(buildReviewQueue(candidates, NOW, 100, "seed")).toHaveLength(30);
    expect(buildReviewQueue(candidates, NOW, 0, "seed")).toEqual([]);
  });
});
