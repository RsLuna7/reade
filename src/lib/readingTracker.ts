import type { DocumentFormat, ReadingSession } from "./backend";
import { createAnnotationId } from "./annotations";

/**
 * Active-reading time tracker (desktop runtime only).
 *
 * Modeled after the KOReader statistics plugin: time only counts while the
 * window is focused/visible and the user interacted recently. Sessions are
 * periodically upserted under a stable id so a crash loses at most one flush
 * interval, and sessions shorter than the minimum threshold are discarded.
 */

export interface ReadingTrackerDocument {
  relativePath: string;
  format: DocumentFormat;
  title: string | null;
}

export interface ReadingTrackerOptions {
  /** Persists (upserts) the session snapshot. Failures are retried on the next flush. */
  persist: (session: ReadingSession) => Promise<void>;
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
  /** Final flush and timer cleanup. Safe to call more than once. */
  dispose(): void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_MIN_SESSION_SECONDS = 5;
const DEFAULT_MAX_SESSION_ACTIVE_SECONDS = 24 * 60 * 60;

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
}

export function createReadingTracker(options: ReadingTrackerOptions): ReadingTracker {
  const now = options.now ?? (() => Date.now());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const minSessionSeconds = options.minSessionSeconds ?? DEFAULT_MIN_SESSION_SECONDS;
  const maxSessionActiveSeconds =
    options.maxSessionActiveSeconds ?? DEFAULT_MAX_SESSION_ACTIVE_SECONDS;

  let session: ActiveSession | null = null;
  let windowActive = true;
  let disposed = false;
  const flushTimer = setInterval(() => performFlush(), flushIntervalMs);

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

  function persistIfWorthwhile(current: ActiveSession): void {
    const payload = snapshot(current);
    if (payload.activeSeconds < minSessionSeconds) return;
    if (
      payload.activeSeconds === current.lastPersistedSeconds &&
      payload.endedAt === current.lastPersistedEndedAt
    ) {
      return;
    }
    current.lastPersistedSeconds = payload.activeSeconds;
    current.lastPersistedEndedAt = payload.endedAt;
    options.persist(payload).catch(() => {
      // Keep accumulating; the next flush retries with fresher numbers.
      current.lastPersistedSeconds = 0;
      current.lastPersistedEndedAt = 0;
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

    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(flushTimer);
      endSession();
    },
  };
}
