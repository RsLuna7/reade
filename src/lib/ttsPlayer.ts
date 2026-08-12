/**
 * Read-aloud queue state machine (docs/plan-read-aloud.md §3.4).
 *
 * One utterance per sentence, chained on `onend` — the standard workaround
 * for Chromium's long-utterance truncation bug, and exactly the granularity
 * the follow highlight needs. The player never touches the DOM; highlight
 * and scrolling belong to the hook layer (a later wiring pass).
 *
 * Known engine pitfalls handled here (all unit-tested):
 * - GC pitfall: the handle returned by the port for the utterance in flight
 *   is retained on the player instance until it settles, so Chromium cannot
 *   collect it and silently drop its events;
 * - cancel semantics: `speechSynthesis.cancel()` fires residual
 *   `onend`/`onerror` events — a generation counter (the same pattern as the
 *   store's `librarySearchRequest`/`documentRequest`) discards callbacks
 *   from a superseded utterance;
 * - unreliable `pause()`: pausing is implemented as "remember cursor +
 *   cancel", and resume re-speaks the current sentence, giving both runtimes
 *   the same sentence-level pause semantics;
 * - single-sentence failures skip ahead; `MAX_CONSECUTIVE_UTTERANCE_FAILURES`
 *   consecutive failures halt playback.
 *
 * The speech engine is injected through `TtsSpeechPort`, so tests run against
 * a scripted double and the wiring pass adapts `window.speechSynthesis`.
 */

import type { SentenceSegment } from "./ttsSegments";

export const TTS_MIN_RATE = 0.5;
export const TTS_MAX_RATE = 2;
export const TTS_DEFAULT_RATE = 1;
export const MAX_CONSECUTIVE_UTTERANCE_FAILURES = 3;

/** Clamps a playback rate into the supported 0.5–2.0 range (NaN → 1). */
export function clampTtsRate(value: number): number {
  if (!Number.isFinite(value)) return TTS_DEFAULT_RATE;
  return Math.min(TTS_MAX_RATE, Math.max(TTS_MIN_RATE, value));
}

export type TtsPlayerStatus = "idle" | "playing" | "paused";

/** Everything the port needs to speak one sentence. */
export interface TtsSpeakRequest {
  text: string;
  rate: number;
  voice: SpeechSynthesisVoice | null;
  /** The utterance finished naturally. */
  onEnd: () => void;
  /** The utterance failed (the engine's error payload is passed through). */
  onError: (error: unknown) => void;
}

/**
 * Injected speech engine. `speak` must return the utterance (or any handle
 * tied to its lifetime); the player keeps that reference until the utterance
 * settles (Chromium GC pitfall). `cancel` stops whatever is in flight; the
 * events it triggers on a cancelled utterance are discarded by generation.
 */
export interface TtsSpeechPort {
  speak(request: TtsSpeakRequest): unknown;
  cancel(): void;
}

export interface TtsPlayerEvents {
  /**
   * Sentence boundary callback: fires with the queue index (and segment) when
   * a sentence becomes current — on speak start, and on cursor moves while
   * paused — and with `(null, null)` when playback stops or finishes.
   */
  onSentenceChange?: (index: number | null, sentence: SentenceSegment | null) => void;
  onStatusChange?: (status: TtsPlayerStatus) => void;
  /** The queue was played through to the end. */
  onFinished?: () => void;
  /** Playback halted after too many consecutive utterance failures. */
  onHalted?: (lastError: unknown) => void;
}

export class TtsQueuePlayer {
  private sentences: SentenceSegment[] = [];
  private cursor = 0;
  private status: TtsPlayerStatus = "idle";
  /** Bumped by every speak/cancel transition; stale callbacks compare against it. */
  private generation = 0;
  private rate: number = TTS_DEFAULT_RATE;
  private voice: SpeechSynthesisVoice | null = null;
  /** Utterance handle in flight, retained until it settles (GC pitfall). */
  private currentHandle: unknown = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly port: TtsSpeechPort,
    private readonly events: TtsPlayerEvents = {},
  ) {}

  getStatus(): TtsPlayerStatus {
    return this.status;
  }

  /** Queue index of the current sentence (meaningful while playing/paused). */
  getCursor(): number {
    return this.cursor;
  }

  getSentenceCount(): number {
    return this.sentences.length;
  }

  getRate(): number {
    return this.rate;
  }

  getVoice(): SpeechSynthesisVoice | null {
    return this.voice;
  }

  /** True while an utterance handle is retained (also proves the GC-pitfall reference). */
  hasUtteranceInFlight(): boolean {
    return this.currentHandle !== null;
  }

  /** Starts (or restarts) playback of `sentences` from `startIndex`. */
  play(sentences: SentenceSegment[], startIndex = 0): void {
    this.invalidate();
    this.port.cancel();
    this.sentences = sentences.slice();
    this.consecutiveFailures = 0;
    if (this.sentences.length === 0) {
      this.cursor = 0;
      this.setStatus("idle");
      this.events.onSentenceChange?.(null, null);
      return;
    }
    const index = Math.min(Math.max(0, Math.floor(startIndex)), this.sentences.length - 1);
    this.setStatus("playing");
    this.speakSentence(index);
  }

  /** Stops playback and resets the queue position. */
  stop(): void {
    if (this.status === "idle") return;
    this.invalidate();
    this.port.cancel();
    this.currentHandle = null;
    this.cursor = 0;
    this.consecutiveFailures = 0;
    this.setStatus("idle");
    this.events.onSentenceChange?.(null, null);
  }

  /** Sentence-level pause: remember the cursor and cancel the utterance. */
  pause(): void {
    if (this.status !== "playing") return;
    this.invalidate();
    this.port.cancel();
    this.currentHandle = null;
    this.setStatus("paused");
  }

  /** Re-speaks the current sentence from its beginning. */
  resume(): void {
    if (this.status !== "paused") return;
    this.setStatus("playing");
    this.speakSentence(this.cursor);
  }

  next(): void {
    this.jumpBy(1);
  }

  previous(): void {
    this.jumpBy(-1);
  }

  /**
   * Applies a new rate immediately: while playing, the current sentence is
   * cancelled and re-spoken at the new rate.
   */
  setRate(value: number): void {
    const clamped = clampTtsRate(value);
    if (clamped === this.rate) return;
    this.rate = clamped;
    this.respeakCurrent();
  }

  /** Switches the voice; while playing, the current sentence restarts with it. */
  setVoice(voice: SpeechSynthesisVoice | null): void {
    if (voice === this.voice) return;
    this.voice = voice;
    this.respeakCurrent();
  }

  /** Stops playback and drops queue state; safe to call repeatedly. */
  dispose(): void {
    this.stop();
    this.sentences = [];
  }

  private invalidate(): void {
    this.generation += 1;
  }

  private setStatus(status: TtsPlayerStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.events.onStatusChange?.(status);
  }

  private respeakCurrent(): void {
    if (this.status !== "playing") return;
    this.port.cancel();
    this.speakSentence(this.cursor);
  }

  private jumpBy(delta: number): void {
    if (this.status === "idle" || this.sentences.length === 0) return;
    const target = Math.min(Math.max(0, this.cursor + delta), this.sentences.length - 1);
    if (target === this.cursor) return;
    if (this.status === "playing") {
      this.port.cancel();
      this.speakSentence(target);
      return;
    }
    // Paused: move the highlight cursor; resume() will speak it.
    this.cursor = target;
    this.events.onSentenceChange?.(target, this.sentences[target]);
  }

  private speakSentence(index: number): void {
    const sentence = this.sentences[index];
    if (!sentence) {
      this.finish();
      return;
    }
    this.cursor = index;
    this.invalidate();
    const generation = this.generation;
    this.events.onSentenceChange?.(index, sentence);
    this.currentHandle = this.port.speak({
      text: sentence.text,
      rate: this.rate,
      voice: this.voice,
      onEnd: () => this.handleUtteranceEnd(generation),
      onError: (error) => this.handleUtteranceError(generation, error),
    });
  }

  private handleUtteranceEnd(generation: number): void {
    if (generation !== this.generation || this.status !== "playing") return;
    this.currentHandle = null;
    this.consecutiveFailures = 0;
    this.advance();
  }

  private handleUtteranceError(generation: number, error: unknown): void {
    if (generation !== this.generation || this.status !== "playing") return;
    this.currentHandle = null;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_UTTERANCE_FAILURES) {
      this.halt(error);
      return;
    }
    this.advance();
  }

  private advance(): void {
    if (this.cursor + 1 < this.sentences.length) {
      this.speakSentence(this.cursor + 1);
      return;
    }
    this.finish();
  }

  private finish(): void {
    this.invalidate();
    this.currentHandle = null;
    this.cursor = 0;
    this.consecutiveFailures = 0;
    this.setStatus("idle");
    this.events.onSentenceChange?.(null, null);
    this.events.onFinished?.();
  }

  private halt(lastError: unknown): void {
    this.invalidate();
    this.port.cancel();
    this.currentHandle = null;
    this.cursor = 0;
    this.consecutiveFailures = 0;
    this.setStatus("idle");
    this.events.onSentenceChange?.(null, null);
    this.events.onHalted?.(lastError);
  }
}
