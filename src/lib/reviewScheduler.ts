import { localDayKey } from "./readingStats";

/**
 * Fixed-ladder Leitner scheduling for the annotation review flow
 * (`docs/plan-annotation-review.md` §3.2). These pure functions are the
 * single source of truth for both backends: the desktop SQLite commands in
 * `src-tauri/src/user_store.rs` and the IndexedDB implementation in
 * `src/lib/webAnnotations.ts` must stay behaviourally identical to them.
 */

/** Review intervals in days for boxes 0..5 (decision R-D1: fixed ladder). */
export const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30, 60] as const;
/** Highest Leitner box; `remembered` caps here (60-day interval). */
export const REVIEW_MAX_BOX = REVIEW_INTERVALS_DAYS.length - 1;
/** Default cards per daily batch (decision R-D2; constant, not a setting). */
export const DAILY_REVIEW_LIMIT = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReviewState {
  /** Leitner box, 0..5. */
  box: number;
  /** Unix ms at which the annotation becomes due for review. */
  dueAt: number;
  /** Unix ms of the last remembered/again outcome; null before the first. */
  lastReviewedAt: number | null;
  /** Count of remembered/again outcomes (suspending does not count). */
  totalReviews: number;
  /** Suspended annotations never enter the queue ("不再回顾"). */
  suspended: boolean;
}

export type ReviewOutcome = "remembered" | "again" | "suspend";

/**
 * Implicit state for annotations without a stored review row (lazy
 * initialisation): box 0, first due one day after creation (decision R-D3).
 * The desktop mirrors this as SQL `COALESCE(due_at, created_at + 86400000)`.
 */
export function initialReviewState(createdAtMs: number): ReviewState {
  return {
    box: 0,
    dueAt: createdAtMs + DAY_MS,
    lastReviewedAt: null,
    totalReviews: 0,
    suspended: false,
  };
}

/**
 * Review-pool membership (§3.1): only highlights/underlines whose excerpt is
 * non-blank; bookmarks and empty selections never enter the pool. Tombstone
 * filtering is the storage layer's job and happens before this check.
 */
export function isReviewableAnnotation(annotation: {
  kind: string;
  selectedText?: string | null;
}): boolean {
  if (annotation.kind !== "highlight" && annotation.kind !== "underline") return false;
  return Boolean(annotation.selectedText && annotation.selectedText.trim());
}

/**
 * State transition table (§3.2):
 * - remembered: climb one box (capped), due after that box's interval;
 * - again: back to box 0, due tomorrow;
 * - suspend: only flips the flag — box and counters stay so the state is
 *   intact if a future release adds a restore entry (decision R-D4). The due
 *   date is clamped up to `nowMs` so a long-overdue card still passes the
 *   server-side `due_at ∈ [now − 1h, now + 180d]` validation window.
 * Both graded outcomes stamp `lastReviewedAt` and bump `totalReviews`.
 */
export function applyReviewOutcome(
  state: ReviewState,
  outcome: ReviewOutcome,
  nowMs: number,
): ReviewState {
  if (outcome === "suspend") {
    return { ...state, dueAt: Math.max(state.dueAt, nowMs), suspended: true };
  }
  const box = outcome === "remembered" ? Math.min(state.box + 1, REVIEW_MAX_BOX) : 0;
  return {
    box,
    dueAt: nowMs + REVIEW_INTERVALS_DAYS[box] * DAY_MS,
    lastReviewedAt: nowMs,
    totalReviews: state.totalReviews + 1,
    suspended: false,
  };
}

/** Minimal candidate shape; `ReviewQueueItem` from backend.ts satisfies it. */
export interface ReviewQueueCandidate {
  annotation: { id: string; relativePath: string };
  review: ReviewState;
}

/**
 * FNV-1a hash over `seed + id`: the deterministic per-day tiebreaker that
 * shuffles equal due dates without any stored randomness.
 */
function seededRank(seed: string, id: string): number {
  let hash = 0x811c9dc5;
  const input = `${seed}\u0000${id}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Builds the daily review batch from due candidates:
 * 1. keep due (`dueAt ≤ nowMs`) and not suspended;
 * 2. order by overdue-ness (oldest due first), ties broken by the seeded
 *    day hash, then by id — same inputs and seed always produce the same
 *    queue, a new day reshuffles the ties;
 * 3. round-robin across documents (in first-appearance order of the sorted
 *    list) so one long book cannot fill the whole batch;
 * 4. trim to `limit`.
 */
export function buildReviewQueue<T extends ReviewQueueCandidate>(
  candidates: readonly T[],
  nowMs: number,
  limit: number = DAILY_REVIEW_LIMIT,
  seed: string = localDayKey(nowMs),
): T[] {
  if (limit <= 0) return [];
  const sorted = candidates
    .filter((candidate) => !candidate.review.suspended && candidate.review.dueAt <= nowMs)
    .sort(
      (a, b) =>
        a.review.dueAt - b.review.dueAt ||
        seededRank(seed, a.annotation.id) - seededRank(seed, b.annotation.id) ||
        compareIds(a.annotation.id, b.annotation.id),
    );
  const groups = new Map<string, T[]>();
  for (const candidate of sorted) {
    const group = groups.get(candidate.annotation.relativePath);
    if (group) group.push(candidate);
    else groups.set(candidate.annotation.relativePath, [candidate]);
  }
  const queue: T[] = [];
  const buckets = [...groups.values()];
  while (queue.length < limit) {
    let picked = false;
    for (const bucket of buckets) {
      if (queue.length >= limit) break;
      const next = bucket.shift();
      if (next) {
        queue.push(next);
        picked = true;
      }
    }
    if (!picked) break;
  }
  return queue;
}
