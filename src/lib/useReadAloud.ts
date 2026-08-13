/**
 * Read-aloud orchestration hook (docs/plan-read-aloud.md §3.2–§3.7).
 *
 * The pure engine pieces already exist — sentence segmentation
 * (`ttsSegments`), the offline voice allow-list (`ttsVoices`) and the queue
 * state machine (`ttsPlayer`). This hook wires them to the DOM:
 *
 * - reading sources come from the same roots the annotation anchors use
 *   (`.markdown-body`, `.epub-chapter`, `.pdf-reading-page .markdown-body`),
 *   flattened with `buildTextIndex` so offsets share one semantic;
 * - `pre`/`code`/KaTeX/table subtrees are punched out of the sentence
 *   candidates (§3.2 skip rule);
 * - the current sentence is painted with a CSS custom highlight
 *   (`sentenceHighlight.ts`, RA-D3 revised) and followed with in-container
 *   scrolling. The highlight never mutates the DOM: the previous
 *   `wrapRangeWithMark` mechanism displaced React-owned text nodes and made
 *   the re-render that follows every sentence crash in `insertBefore`
 *   (NotFoundError white screen) as soon as a sentence contained an inline
 *   link — see `sentenceHighlight.ts` for the full failure chain;
 * - every finished utterance reports activity (RA-D4: listening counts as
 *   engaged reading time);
 * - the speech engine is injected (`ReadAloudSpeech`) so jsdom tests run
 *   against scripted doubles; the default adapter uses
 *   `window.speechSynthesis`, and a runtime without it renders the whole
 *   feature as unsupported.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  buildTextIndex,
  collectElementText,
  elementTextOffsetInIndex,
  rangeFromOffsets,
  rangeFromTextIndex,
  type TextIndex,
} from "./annotations";
import type { ReaderMotionLevel } from "./motion";
import { applySentenceHighlight, clearSentenceHighlight } from "./sentenceHighlight";
import { segmentSentences, type SentenceSegment } from "./ttsSegments";
import {
  clampTtsRate,
  TtsQueuePlayer,
  type TtsPlayerStatus,
  type TtsSpeechPort,
} from "./ttsPlayer";
import { filterLocalVoices, loadVoices, pickDefaultVoice, type VoiceSource } from "./ttsVoices";

/**
 * Registry name of the transient current-sentence highlight (RA-D3 revised);
 * styled by `::highlight(reade-tts-active)` in App.css.
 */
export const TTS_ACTIVE_ID = "reade-tts-active";
/** Subtrees whose text never enters the sentence queue (plan §3.2). */
export const TTS_EXCLUDED_SELECTOR = "pre, code, .katex, table";

export type ReadAloudContentKind = "markdown" | "pdf" | "epub";

// ---------------------------------------------------------------------------
// Reading sources (§3.2): (DOM root, flattened text) pairs
// ---------------------------------------------------------------------------

/**
 * Reading roots in document order: markdown reads its single body, EPUB one
 * root per chapter (book-end notes excluded), PDF reading mode one root per
 * page body (OCR hints live outside `.markdown-body` and drop out for free).
 */
export function collectReadAloudRoots(
  article: HTMLElement,
  kind: ReadAloudContentKind,
): HTMLElement[] {
  if (kind === "markdown") {
    const root = article.querySelector<HTMLElement>(".markdown-body");
    return root ? [root] : [];
  }
  if (kind === "epub") {
    return Array.from(article.querySelectorAll<HTMLElement>(".epub-chapter"));
  }
  return Array.from(
    article.querySelectorAll<HTMLElement>(".pdf-reading-page .markdown-body"),
  );
}

interface OffsetInterval {
  start: number;
  end: number;
}

/** Merged flattened-offset intervals covered by excluded subtrees. */
function excludedIntervals(root: HTMLElement, index: TextIndex): OffsetInterval[] {
  const intervals: OffsetInterval[] = [];
  for (const element of Array.from(
    root.querySelectorAll<HTMLElement>(TTS_EXCLUDED_SELECTOR),
  )) {
    const start = elementTextOffsetInIndex(index, element);
    if (start === null) continue;
    const length = collectElementText(element).length;
    if (length > 0) intervals.push({ start, end: start + length });
  }
  intervals.sort((a, b) => a.start - b.start);
  const merged: OffsetInterval[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

export interface ReadAloudSource {
  root: HTMLElement;
  index: TextIndex;
}

export interface ReadAloudSentence extends SentenceSegment {
  /** Which entry of `ReadAloudQueue.sources` the offsets belong to. */
  sourceIndex: number;
}

export interface ReadAloudQueue {
  sources: ReadAloudSource[];
  sentences: ReadAloudSentence[];
}

/**
 * Builds the sentence queue for the current article: one flattened index per
 * reading root, excluded subtrees punched out, sentences segmented inside
 * the remaining intervals so no sentence ever crosses a hole.
 */
export function buildReadAloudQueue(
  article: HTMLElement,
  kind: ReadAloudContentKind,
): ReadAloudQueue {
  const sources: ReadAloudSource[] = [];
  const sentences: ReadAloudSentence[] = [];
  for (const root of collectReadAloudRoots(article, kind)) {
    const index = buildTextIndex(root);
    if (!index.text.trim()) continue;
    const sourceIndex = sources.length;
    sources.push({ root, index });
    const pushInterval = (start: number, end: number) => {
      if (end <= start) return;
      for (const segment of segmentSentences(index.text.slice(start, end))) {
        sentences.push({
          start: segment.start + start,
          end: segment.end + start,
          text: segment.text,
          sourceIndex,
        });
      }
    };
    let cursor = 0;
    for (const hole of excludedIntervals(root, index)) {
      pushInterval(cursor, hole.start);
      cursor = Math.max(cursor, hole.end);
    }
    pushInterval(cursor, index.text.length);
  }
  return { sources, sentences };
}

const VIEWPORT_BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote";

/**
 * First line box of the sentence range — the scroll anchor (mirrors the old
 * first-mark-element anchor). Null in layout-free runtimes (jsdom lacks
 * Range rect APIs), which also disables scroll-follow there.
 */
function rangeFirstRect(range: Range): DOMRect | null {
  if (typeof range.getClientRects === "function") {
    const rects = range.getClientRects();
    if (rects.length > 0) return rects[0];
  }
  return typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect()
    : null;
}

/**
 * Default start position (§3.2): the first sentence at or after the first
 * block element visible in the reader viewport; 0 when nothing matches
 * (e.g. layout-free test environments).
 */
export function firstSentenceIndexInView(
  queue: ReadAloudQueue,
  reader: HTMLElement | null,
): number {
  if (!reader || queue.sentences.length === 0) return 0;
  const readerRect = reader.getBoundingClientRect();
  for (let sourceIndex = 0; sourceIndex < queue.sources.length; sourceIndex += 1) {
    const { root, index } = queue.sources[sourceIndex];
    for (const block of Array.from(
      root.querySelectorAll<HTMLElement>(VIEWPORT_BLOCK_SELECTOR),
    )) {
      const rect = block.getBoundingClientRect();
      if (rect.height === 0 || rect.bottom <= readerRect.top) continue;
      const offset = elementTextOffsetInIndex(index, block);
      if (offset === null) continue;
      const sentenceIndex = queue.sentences.findIndex(
        (sentence) => sentence.sourceIndex === sourceIndex && sentence.end > offset,
      );
      if (sentenceIndex >= 0) return sentenceIndex;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Speech adapter (injected; the real one wraps window.speechSynthesis)
// ---------------------------------------------------------------------------

export interface ReadAloudSpeech {
  /** Voice enumeration source for `loadVoices`. */
  voices: VoiceSource;
  /** Utterance channel for the queue player. */
  port: TtsSpeechPort;
}

/** `window.speechSynthesis` adapter; null when the runtime lacks the API. */
export function defaultReadAloudSpeech(): ReadAloudSpeech | null {
  if (
    typeof window === "undefined" ||
    !("speechSynthesis" in window) ||
    typeof SpeechSynthesisUtterance !== "function"
  ) {
    return null;
  }
  const synth = window.speechSynthesis;
  return {
    voices: synth,
    port: {
      speak(request) {
        const utterance = new SpeechSynthesisUtterance(request.text);
        utterance.rate = request.rate;
        if (request.voice) {
          utterance.voice = request.voice;
          utterance.lang = request.voice.lang;
        }
        utterance.onend = () => request.onEnd();
        utterance.onerror = (event) => request.onError(event.error ?? event);
        synth.speak(utterance);
        // The player retains this handle until the utterance settles
        // (Chromium GC pitfall, see ttsPlayer.ts).
        return utterance;
      },
      cancel() {
        synth.cancel();
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseReadAloudOptions {
  articleRef: RefObject<HTMLElement | null>;
  readerRef: RefObject<HTMLElement | null>;
  contentKind: ReadAloudContentKind | null;
  /** Document identity (currentPath); any change stops playback. */
  contentKey: string | null;
  /** Reading surface visible; false stops playback (leaving the reader view). */
  active: boolean;
  motionLevel: ReaderMotionLevel;
  /** Persisted preferences (store-owned). */
  rate: number;
  voiceName: string | null;
  /** Language hint for the default voice pick (e.g. navigator.language). */
  languageHint?: string | null;
  /** Fired when an utterance finishes (RA-D4 `recordActivity` hook-up). */
  onSentenceEnd?: () => void;
  /** Playback problems surface through the app notice channel. */
  onNotice?: (message: string) => void;
  /** Injected speech engine; omit for `window.speechSynthesis`, null = unsupported. */
  speech?: ReadAloudSpeech | null;
}

export interface ReadAloudControls {
  /** The runtime offers speech synthesis at all. */
  supported: boolean;
  /** Offline allow-listed voices (RA-D1); empty = feature disabled. */
  voices: SpeechSynthesisVoice[];
  voicesReady: boolean;
  /** Effective voice (named preference when it matches, default pick otherwise). */
  voice: SpeechSynthesisVoice | null;
  status: TtsPlayerStatus;
  /** The control bar is visible (playing or paused). */
  barOpen: boolean;
  sentenceIndex: number | null;
  sentenceCount: number;
  /**
   * First line box of the currently highlighted sentence, or null when
   * idle / the range went stale — the scroll-map tick anchor (RS-D8).
   */
  getActiveSentenceRect: () => DOMRect | null;
  /** Starts from the sentence nearest the viewport and opens the bar. */
  start: () => void;
  /** Starts from the first sentence. */
  startFromTop: () => void;
  /** Play/pause toggle (starts playback when idle). */
  toggle: () => void;
  /** Stops playback, clears the mark and closes the bar. */
  stop: () => void;
  next: () => void;
  previous: () => void;
}

export function useReadAloud(options: UseReadAloudOptions): ReadAloudControls {
  const { rate, voiceName, languageHint, contentKind, contentKey, active } = options;

  // Latest-value refs so the imperative callbacks stay identity-stable.
  const latest = useRef(options);
  latest.current = options;

  const speechRef = useRef<ReadAloudSpeech | null | undefined>(undefined);
  if (speechRef.current === undefined) {
    speechRef.current =
      options.speech !== undefined ? options.speech : defaultReadAloudSpeech();
  }
  const speech = speechRef.current;

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voicesReady, setVoicesReady] = useState(!speech);
  const [status, setStatus] = useState<TtsPlayerStatus>("idle");
  const [barOpen, setBarOpen] = useState(false);
  const [sentenceIndex, setSentenceIndex] = useState<number | null>(null);
  const [sentenceCount, setSentenceCount] = useState(0);

  const queueRef = useRef<ReadAloudQueue | null>(null);
  /** Last painted sentence range, for the scroll-map tick (RS-D8). */
  const activeRangeRef = useRef<Range | null>(null);

  /** Clears the previous sentence highlight and paints/scrolls the new one. */
  const applyHighlight = useCallback((index: number | null) => {
    clearSentenceHighlight(TTS_ACTIVE_ID);
    activeRangeRef.current = null;
    if (index === null) return;
    const queue = queueRef.current;
    const sentence = queue?.sentences[index];
    if (!queue || !sentence) return;
    const source = queue.sources[sentence.sourceIndex];
    if (!source || !source.root.isConnected) return;
    // Cached index first; annotation repaints, Shiki swaps and React remounts
    // can replace text nodes mid-playback, so validate the hit and fall back
    // to a fresh DOM walk when it went stale.
    let range = rangeFromTextIndex(source.index, sentence.start, sentence.end);
    if (
      !range ||
      !source.root.contains(range.startContainer) ||
      range.toString() !== sentence.text
    ) {
      range = rangeFromOffsets(source.root, sentence.start, sentence.end);
    }
    if (!range) return;
    // Zero-DOM-mutation paint (RA-D3 revised): React re-renders cannot
    // conflict with the highlight. Runtimes without the Highlight API keep
    // playing with scroll-follow only — never the DOM-wrapping fallback.
    applySentenceHighlight(TTS_ACTIVE_ID, range);
    activeRangeRef.current = range;
    const reader = latest.current.readerRef.current;
    if (!reader) return;
    const rect = rangeFirstRect(range);
    if (!rect || rect.height <= 0) return;
    const readerRect = reader.getBoundingClientRect();
    // Only scroll when the sentence left the viewport (avoids per-sentence jitter).
    if (rect.top >= readerRect.top && rect.bottom <= readerRect.bottom) return;
    const top = Math.max(0, reader.scrollTop + rect.top - readerRect.top);
    if (latest.current.motionLevel !== "off" && typeof reader.scrollTo === "function") {
      reader.scrollTo({ top, behavior: "smooth" });
    } else {
      reader.scrollTop = top;
    }
  }, []);

  const playerRef = useRef<TtsQueuePlayer | null>(null);
  if (!playerRef.current && speech) {
    const basePort = speech.port;
    const port: TtsSpeechPort = {
      speak: (request) =>
        basePort.speak({
          ...request,
          onEnd: () => {
            // RA-D4: every finished sentence counts as reading activity.
            latest.current.onSentenceEnd?.();
            request.onEnd();
          },
        }),
      cancel: () => basePort.cancel(),
    };
    playerRef.current = new TtsQueuePlayer(port, {
      onStatusChange: setStatus,
      onSentenceChange: (index) => {
        setSentenceIndex(index);
        applyHighlight(index);
      },
      onHalted: () => {
        setBarOpen(false);
        latest.current.onNotice?.("朗读连续失败，已停止；可尝试更换语音后重试。");
      },
    });
  }

  // Voice enumeration (async getVoices timing handled by loadVoices).
  useEffect(() => {
    if (!speech) return;
    let cancelled = false;
    void loadVoices(speech.voices).then((list) => {
      if (cancelled) return;
      setVoices(filterLocalVoices(list));
      setVoicesReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [speech]);

  const voice = useMemo(() => {
    if (voices.length === 0) return null;
    const named = voiceName
      ? voices.find((candidate) => candidate.name === voiceName)
      : undefined;
    return named ?? pickDefaultVoice(voices, languageHint);
  }, [voices, voiceName, languageHint]);

  // Preference changes apply immediately (the player re-speaks mid-sentence).
  useEffect(() => {
    playerRef.current?.setRate(clampTtsRate(rate));
  }, [rate]);
  useEffect(() => {
    playerRef.current?.setVoice(voice);
  }, [voice]);

  const stop = useCallback(() => {
    playerRef.current?.stop();
    setBarOpen(false);
    // The player already cleared the highlight via onSentenceChange(null);
    // clear again defensively in case playback never started.
    clearSentenceHighlight(TTS_ACTIVE_ID);
  }, []);

  const startAt = useCallback(
    (position: "viewport" | "top") => {
      const player = playerRef.current;
      const { articleRef, readerRef, contentKind: kind, onNotice } = latest.current;
      const article = articleRef.current;
      if (!player || !article || !kind) return;
      const queue = buildReadAloudQueue(article, kind);
      queueRef.current = queue;
      setSentenceCount(queue.sentences.length);
      if (queue.sentences.length === 0) {
        onNotice?.("当前文档没有可朗读的正文。");
        return;
      }
      setBarOpen(true);
      player.play(
        queue.sentences,
        position === "top" ? 0 : firstSentenceIndexInView(queue, readerRef.current),
      );
    },
    [],
  );

  const start = useCallback(() => startAt("viewport"), [startAt]);
  const startFromTop = useCallback(() => startAt("top"), [startAt]);

  const toggle = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    const current = player.getStatus();
    if (current === "playing") player.pause();
    else if (current === "paused") player.resume();
    else startAt("viewport");
  }, [startAt]);

  const next = useCallback(() => playerRef.current?.next(), []);
  const previous = useCallback(() => playerRef.current?.previous(), []);

  const getActiveSentenceRect = useCallback((): DOMRect | null => {
    const range = activeRangeRef.current;
    if (!range || !range.startContainer.isConnected) return null;
    return rangeFirstRect(range);
  }, []);

  // Document switch, library switch or leaving the reader view stop playback.
  useEffect(() => {
    if (playerRef.current?.getStatus() !== "idle") stop();
    // The bar never survives a document/view change either.
    setBarOpen(false);
  }, [contentKey, contentKind, active, stop]);

  // Unmount: dispose the player and drop any leftover sentence highlight.
  useEffect(
    () => () => {
      playerRef.current?.dispose();
      clearSentenceHighlight(TTS_ACTIVE_ID);
    },
    [],
  );

  return {
    supported: speech !== null,
    voices,
    voicesReady,
    voice,
    status,
    barOpen,
    sentenceIndex,
    sentenceCount,
    getActiveSentenceRect,
    start,
    startFromTop,
    toggle,
    stop,
    next,
    previous,
  };
}
