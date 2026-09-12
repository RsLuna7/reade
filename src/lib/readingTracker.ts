import type { DocumentFormat, ReadingSession } from "./backend";
import { createAnnotationId } from "./annotations";

/**
 * Active-reading time tracker (desktop runtime only).
 *
 * Modeled after the KOReader statistics plugin: time only counts while the
 * window is focused/visible and the user interacted recently. Sessions are
 * periodically upserted under a stable id so a crash loses at most one flush
 * interval, and sessions shorter than the minimum threshold are discarded.
 *
 * D05: every session is bound to its origin on the backend at start time
 * (`bind`), so late saves stay attributed to the original library even after
 * a switch. Failed saves enter a bounded in-memory retry queue with 1/2/4/8/30s
 * backoff (same-session snapshots merge; other sessions are never dropped to
 * make room except at the hard cap, which is surfaced). `flushPending` lets
 * the close flow drain the queue with a bounded wait. A process kill before a
 * confirmed write can still lose the last unconfirmed interval — the tracker
 * only promises what the backend has acknowledged.
 */

export interface ReadingTrackerDocument {
  relativePath: string;
  format: DocumentFormat;
  title: string | null;
}

export interface ReadingTrackerOptions {
  /** Persists (upserts) the session snapshot. Failures are retried on the next flush. */
  persist: (session: ReadingSession) => Promise<void>;
  /**
   * Binds the session id to its (library, document) origin on the backend
   * before the first save. Bind failures are retried with the next persist.
   */
  bind?: (session: ReadingSession) => Promise<void>;
  /** Persist/bind failure feedback (queue keeps retrying regardless). */
  onPersistError?: (session: ReadingSession, error: unknown) => void;
  /** Wall clock in unix ms. Defaults to Date.now. */
  now?: () => number;
  /** Monotonic clock in ms. Defaults to performance.now. */
  monotonicNow?: () => number;
  /** Interaction gap after which counting pauses. Default 60s. */
  idleTimeoutMs?: number;
  /** Cadence of periodic persistence. Default 30s. */
  flushIntervalMs?: number;
  /** Sessions with less accumulated time than this are dropped. Default 5s. */
  minSessionSeconds?: number;
  /** Safety cap per session row; a new session starts beyond it. Default 24h. */
  maxSessionActiveSeconds?: number;
  /** Retry backoff schedule in ms; last entry repeats. Default 1/2/4/8/30s. */
  retryBackoffMs?: number[];
  /** Hard cap on queued sessions; overflow surfaces via onPersistError. Default 64. */
  maxPendingSessions?: number;
}

export interface ReadingTracker {
  /** Switches the tracked document. Same path is a no-op; null ends tracking. */
  openDocument(document: ReadingTrackerDocument | null): void;
  /** Marks user interaction (scroll/pointer/key/wheel). */
  recordActivity(): void;
  /** Gates counting on window focus and page visibility. */
  setWindowActive(active: boolean): void;
  /** Persists current progress immediately (fire and forget). */
  flush(): void;
  /**
   * Sends every queued write now (ignoring backoff) and resolves once the
   * queue is empty. Never rejects — the close flow bounds the wait itself.
   */
  flushPending(): Promise<void>;
  /** Final flush and timer cleanup. Safe to call more than once. */
  dispose(): void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_MIN_SESSION_SECONDS = 5;
const DEFAULT_MAX_SESSION_ACTIVE_SECONDS = 24 * 60 * 60;
const DEFAULT_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 30_000];
const DEFAULT_MAX_PENDING_SESSIONS = 64;

interface ActiveSession {
  id: string;
  document: ReadingTrackerDocument;
  startedAtWall: number;
  /** Wall timestamp of the last counted moment (excludes trailing idle). */
  lastCountedWall: number;
  accumulatedMs: number;
  /** Monotonic start of the running segment; null while paused. */
  segmentStart: number | null;
  /** Monotonic timestamp of the last interaction. */
  lastActivity: number;
  lastPersistedSeconds: number;
  lastPersistedEndedAt: number;
  /** Backend bind attempt for this session id; null until the first save. */
  bound: Promise<void> | null;
}

interface PendingWrite {
  payload: ReadingSession;
  attempts: number;
  /** Monotonic time of the next attempt. */
  nextAttemptAt: number;
  /** True while a send is in flight; the entry is skipped by drains. */
  inFlight: boolean;
}

export function createReadingTracker(options: ReadingTrackerOptions): ReadingTracker {
  const now = options.now ?? (() => Date.now());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const minSessionSeconds = options.minSessionSeconds ?? DEFAULT_MIN_SESSION_SECONDS;
  const maxSessionActiveSeconds =
    options.maxSessionActiveSeconds ?? DEFAULT_MAX_SESSION_ACTIVE_SECONDS;
  const retryBackoff = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const maxPendingSessions = options.maxPendingSessions ?? DEFAULT_MAX_PENDING_SESSIONS;
  const backoffFor = (attempts: number) =>
    retryBackoff[Math.min(attempts, retryBackoff.length - 1)] ?? retryBackoff[0];

  let session: ActiveSession | null = null;
  let windowActive = true;
  let disposed = false;
  const flushTimer = setInterval(() => performFlush(), flushIntervalMs);
  /** Unconfirmed snapshots by session id (D05 retry queue). */
  const pendingWrites = new Map<string, PendingWrite>();
  const pendingEmptyWaiters: Array<() => void> = [];
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function startSession(document: ReadingTrackerDocument): void {
    const wall = now();
    const mono = monotonicNow();
    session = {
      id: createAnnotationId(),
      document,
      startedAtWall: wall,
      lastCountedWall: wall,
      accumulatedMs: 0,
      segmentStart: windowActive ? mono : null,
      lastActivity: mono,
      lastPersistedSeconds: 0,
      lastPersistedEndedAt: 0,
      bound: null,
    };
  }

  /** Ends the running segment, capping counted time at lastActivity + idle timeout. */
  function closeSegment(): void {
    if (!session || session.segmentStart === null) return;
    const mono = monotonicNow();
    const wall = now();
    const segmentEnd = Math.min(mono, session.lastActivity + idleTimeoutMs);
    if (segmentEnd > session.segmentStart) {
      session.accumulatedMs += segmentEnd - session.segmentStart;
      const trailingIdleMs = Math.max(0, mono - segmentEnd);
      session.lastCountedWall = Math.max(session.startedAtWall, wall - trailingIdleMs);
    }
    session.segmentStart = null;
  }

  function resumeSegmentIfEngaged(): void {
    if (!session || session.segmentStart !== null || !windowActive) return;
    const mono = monotonicNow();
    if (mono - session.lastActivity <= idleTimeoutMs) {
      session.segmentStart = mono;
    }
  }

  function snapshot(current: ActiveSession): ReadingSession {
    const activeSeconds = Math.round(current.accumulatedMs / 1000);
    return {
      id: current.id,
      relativePath: current.document.relativePath,
      format: current.document.format,
      title: current.document.title,
      startedAt: current.startedAtWall,
      endedAt: Math.max(current.lastCountedWall, current.startedAtWall),
      activeSeconds,
    };
  }

  function bindSessionOnce(current: ActiveSession): Promise<void> {
    if (!options.bind) return Promise.resolve();
    if (current.bound) return current.bound;
    // Re-bind on the next save if this attempt fails (e.g. backend busy).
    const payload = snapshot(current);
    current.bound = options
      .bind(payload)
      .catch((error: unknown) => {
        current.bound = null;
        throw error;
      });
    return current.bound;
  }

  function enqueuePending(payload: ReadingSession, error: unknown): void {
    const existing = pendingWrites.get(payload.id);
    if (existing) {
      // Same-session merge: only the freshest snapshot is kept, attempts and
      // the backoff schedule continue.
      existing.payload = payload;
      existing.attempts += 1;
      existing.nextAttemptAt = monotonicNow() + backoffFor(existing.attempts);
    } else {
      if (pendingWrites.size >= maxPendingSessions) {
        // Hard cap: surface instead of silently dropping another session.
        options.onPersistError?.(
          payload,
          new Error(
            "Reading statistics retry queue is full; the oldest unconfirmed session was dropped",
          ),
        );
        let oldestId: string | null = null;
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [id, entry] of pendingWrites) {
          if (entry.nextAttemptAt < oldestAt) {
            oldestAt = entry.nextAttemptAt;
            oldestId = id;
          }
        }
        if (oldestId) pendingWrites.delete(oldestId);
      }
      pendingWrites.set(payload.id, {
        payload,
        attempts: 1,
        nextAttemptAt: monotonicNow() + backoffFor(0),
        inFlight: false,
      });
    }
    options.onPersistError?.(payload, error);
    scheduleRetryDrain(0);
  }

  function drainDuePending(): void {
    retryTimer = null;
    if (pendingWrites.size === 0) {
      resolveEmptyWaiters();
      return;
    }
    const due: PendingWrite[] = [];
    for (const entry of pendingWrites.values()) {
      if (!entry.inFlight && entry.nextAttemptAt <= monotonicNow()) due.push(entry);
    }
    for (const entry of due) {
      entry.inFlight = true;
      // Re-affirm the binding before every queued send: the backend accepts
      // idempotent rebinds, so a save that failed while its library was not
      // the current one recovers automatically.
      const send = options.bind
        ? options.bind(entry.payload).then(() => options.persist(entry.payload))
        : options.persist(entry.payload);
      void send
        .then(() => {
          pendingWrites.delete(entry.payload.id);
          resolveEmptyWaitersIfEmpty();
        })
        .catch((error: unknown) => {
          entry.attempts += 1;
          entry.nextAttemptAt = monotonicNow() + backoffFor(entry.attempts);
          options.onPersistError?.(entry.payload, error);
        })
        .finally(() => {
          entry.inFlight = false;
          scheduleRetryDrain(0);
        });
    }
    scheduleRetryDrain(0);
  }

  function scheduleRetryDrain(previous: number): void {
    void previous;
    if (retryTimer !== null || disposed) return;
    if (pendingWrites.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of pendingWrites.values()) {
      // In-flight entries reschedule themselves when they settle.
      if (!entry.inFlight) earliest = Math.min(earliest, entry.nextAttemptAt);
    }
    if (!Number.isFinite(earliest)) return;
    const delay = Math.max(0, earliest - monotonicNow());
    retryTimer = setTimeout(() => {
      retryTimer = null;
      drainDuePending();
    }, delay);
  }

  function resolveEmptyWaitersIfEmpty(): void {
    if (pendingWrites.size === 0) resolveEmptyWaiters();
  }

  function resolveEmptyWaiters(): void {
    while (pendingEmptyWaiters.length > 0) {
      const resolve = pendingEmptyWaiters.pop();
      resolve?.();
    }
  }

  function persistIfWorthwhile(current: ActiveSession): void {
    const payload = snapshot(current);
    if (payload.activeSeconds < minSessionSeconds) return;
    if (
      payload.activeSeconds === current.lastPersistedSeconds &&
      payload.endedAt === current.lastPersistedEndedAt &&
      !pendingWrites.has(payload.id)
    ) {
      return;
    }

    const handleResult = (promise: Promise<void>): void => {
      promise
        .then(() => {
          current.lastPersistedSeconds = payload.activeSeconds;
          current.lastPersistedEndedAt = payload.endedAt;
          pendingWrites.delete(payload.id);
          resolveEmptyWaitersIfEmpty();
          scheduleRetryDrain(0);
        })
        .catch((error: unknown) => {
          // Keep accumulating; the freshest numbers stay queued for retry.
          enqueuePending(payload, error);
        });
    };

    // Without a bind option the persist call stays synchronous (legacy
    // behavior, and flush() remains a synchronous entry point for tests);
    // with binding, the save waits for the backend bind first.
    if (!options.bind) {
      handleResult(options.persist(payload));
      return;
    }
    void bindSessionOnce(current)
      .then(() => handleResult(options.persist(payload)))
      .catch((error: unknown) => {
        enqueuePending(payload, error);
      });
  }

  function performFlush(): void {
    if (!session) return;
    closeSegment();
    persistIfWorthwhile(session);
    if (session.accumulatedMs / 1000 >= maxSessionActiveSeconds) {
      // Roll over so no single row grows without bound.
      const document = session.document;
      session = null;
      startSession(document);
      return;
    }
    resumeSegmentIfEngaged();
  }

  function endSession(): void {
    if (!session) return;
    closeSegment();
    persistIfWorthwhile(session);
    session = null;
  }

  return {
    openDocument(document) {
      if (disposed) return;
      if (document && session && session.document.relativePath === document.relativePath) {
        // Same document (e.g. metadata refresh): keep the running session.
        session.document = document;
        return;
      }
      endSession();
      if (document) startSession(document);
    },

    recordActivity() {
      if (disposed || !session) return;
      const mono = monotonicNow();
      if (session.segmentStart !== null && mono - session.lastActivity > idleTimeoutMs) {
        // Returned from an idle gap: close the capped segment before resuming.
        closeSegment();
      }
      session.lastActivity = mono;
      if (session.segmentStart === null && windowActive) {
        session.segmentStart = mono;
      }
    },

    setWindowActive(active) {
      if (disposed || windowActive === active) {
        windowActive = active;
        return;
      }
      windowActive = active;
      if (!session) return;
      if (active) {
        // Focus itself is an interaction.
        session.lastActivity = monotonicNow();
        resumeSegmentIfEngaged();
      } else {
        closeSegment();
        persistIfWorthwhile(session);
      }
    },

    flush() {
      if (disposed) return;
      performFlush();
    },

    flushPending() {
      if (pendingWrites.size === 0) return Promise.resolve();
      // Force-send everything now (the close flow bounds the wait itself).
      for (const entry of pendingWrites.values()) {
        entry.nextAttemptAt = monotonicNow();
      }
      return new Promise<void>((resolve) => {
        pendingEmptyWaiters.push(resolve);
        drainDuePending();
      });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(flushTimer);
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      endSession();
    },
  };
}
