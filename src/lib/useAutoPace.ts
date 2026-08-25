/**
 * 自感应按段推进驱动：块收集、停留计时、跳吸与学习信号接线。
 * 纯逻辑在 autoPace.ts；块选择器与聚焦模式共用 collectFocusBlocks。
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  IDLE_PAUSE_MS,
  SESSION_FACTOR_DEFAULT,
  applyEarlyAdvance,
  applyOverdue,
  blockCharCount,
  classifyBlockElement,
  dwellMsForBlock,
  isOverdue,
  nextAutoPaceStatus,
  paceHintLabel,
  type AutoPaceStatus,
} from "./autoPace";
import {
  TYPEWRITER_MIN_DELTA_PX,
  collectFocusBlocks,
  focusReferenceLine,
  selectFocusIndex,
  typewriterScrollTop,
  type FocusContentKind,
} from "./focusMode";
import type { ReaderMotionLevel } from "./motion";

/** 提前推进键（不含 Space：Space 留给播放/暂停）。 */
const EARLY_KEYS = new Set(["ArrowDown", "PageDown"]);
/** 回退键：学慢并绑到上一可见节奏。 */
const BACK_KEYS = new Set(["ArrowUp", "PageUp"]);

function isFormField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable)
  );
}

function selectionInside(article: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  return article.contains(range.commonAncestorContainer);
}

export interface UseAutoPaceOptions {
  readerRef: RefObject<HTMLElement | null>;
  articleRef: RefObject<HTMLElement | null>;
  enabledKind: FocusContentKind | null;
  contentKey: string | null;
  /** 设置开关；false 时整条链路 off。 */
  enabled: boolean;
  /** TTS 等外部挂起。 */
  suspended: boolean;
  charsPerMinute: number;
  bias: number;
  motionLevel: ReaderMotionLevel;
  onNotice?: (message: string) => void;
  /** 关闭条时回调（把偏好开关关掉）。 */
  onRequestDisable?: () => void;
}

export interface AutoPaceControls {
  status: AutoPaceStatus;
  sessionFactor: number;
  paceHint: string;
  /** 开关开且非 off 时显示控制条。 */
  barOpen: boolean;
  /** playing 时打字机应让位。 */
  playing: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  stop: () => void;
}

export function useAutoPace(options: UseAutoPaceOptions): AutoPaceControls {
  const latest = useRef(options);
  latest.current = options;

  const [status, setStatus] = useState<AutoPaceStatus>("off");
  const [sessionFactor, setSessionFactor] = useState(SESSION_FACTOR_DEFAULT);

  const statusRef = useRef(status);
  statusRef.current = status;
  const sessionRef = useRef(sessionFactor);
  sessionRef.current = sessionFactor;

  const blocksRef = useRef<HTMLElement[]>([]);
  const indexRef = useRef(0);
  const dwellTimerRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const blockStartedAtRef = useRef(0);
  const blockBudgetRef = useRef(0);
  /** 划词软暂停：不改 status，只停表。 */
  const softPausedRef = useRef(false);
  const softPauseElapsedRef = useRef(0);
  /** 程序化吸附武装抑制：自身 scroll 不学。 */
  const programmaticUntilRef = useRef(0);
  const disposedRef = useRef(false);
  /** 延后绑定，避免 schedule/advance 互相闭包陈旧。 */
  const advanceRef = useRef<(reason: "timer" | "early") => void>(() => {});
  const scheduleRef = useRef<() => void>(() => {});

  const clearDwell = useCallback(() => {
    if (dwellTimerRef.current !== null) {
      window.clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
  }, []);

  const bumpIdle = useCallback(() => {
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    if (statusRef.current !== "playing") return;
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      if (statusRef.current !== "playing") return;
      clearDwell();
      setStatus("paused");
    }, IDLE_PAUSE_MS);
  }, [clearDwell]);

  const snapToBlock = useCallback((block: HTMLElement) => {
    const reader = latest.current.readerRef.current;
    if (!reader) return;
    const readerRect = reader.getBoundingClientRect();
    const rect = block.getBoundingClientRect();
    const top = typewriterScrollTop({
      scrollTop: reader.scrollTop,
      blockTop: rect.top,
      blockHeight: rect.height,
      viewportTop: readerRect.top,
      viewportHeight: readerRect.height,
    });
    const delta = top - reader.scrollTop;
    if (Math.abs(delta) < TYPEWRITER_MIN_DELTA_PX) return;
    programmaticUntilRef.current = Date.now() + 600;
    if (
      latest.current.motionLevel === "off" ||
      typeof reader.scrollTo !== "function"
    ) {
      reader.scrollTop = top;
      return;
    }
    reader.scrollTo({ top, behavior: "smooth" });
  }, []);

  const nearestIndex = useCallback((): number => {
    const reader = latest.current.readerRef.current;
    const blocks = blocksRef.current;
    if (!reader || blocks.length === 0) return 0;
    const readerRect = reader.getBoundingClientRect();
    const reference = focusReferenceLine(readerRect.top, readerRect.height);
    const index = selectFocusIndex(
      blocks.map((block) => {
        const rect = block.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      }),
      reference,
    );
    return index ?? 0;
  }, []);

  const scheduleDwell = useCallback(() => {
    clearDwell();
    if (statusRef.current !== "playing") return;
    if (latest.current.suspended || softPausedRef.current) return;
    const blocks = blocksRef.current;
    const block = blocks[indexRef.current];
    if (!block || !block.isConnected) return;

    const chars = blockCharCount(block);
    const kind = classifyBlockElement(block);
    const budget = dwellMsForBlock({
      chars,
      charsPerMinute: latest.current.charsPerMinute,
      sessionFactor: sessionRef.current,
      bias: latest.current.bias,
      kind,
    });
    blockBudgetRef.current = budget;
    blockStartedAtRef.current = Date.now();
    softPauseElapsedRef.current = 0;

    dwellTimerRef.current = window.setTimeout(() => {
      dwellTimerRef.current = null;
      advanceRef.current("timer");
    }, budget);
  }, [clearDwell]);

  const advanceInternal = useCallback(
    (reason: "timer" | "early") => {
      if (statusRef.current !== "playing") return;
      clearDwell();
      const blocks = blocksRef.current;
      if (blocks.length === 0) {
        setStatus("paused");
        return;
      }

      if (reason === "early") {
        const nextFactor = applyEarlyAdvance(sessionRef.current);
        sessionRef.current = nextFactor;
        setSessionFactor(nextFactor);
      } else {
        const elapsed =
          softPauseElapsedRef.current + (Date.now() - blockStartedAtRef.current);
        if (isOverdue(elapsed, blockBudgetRef.current)) {
          const nextFactor = applyOverdue(sessionRef.current);
          sessionRef.current = nextFactor;
          setSessionFactor(nextFactor);
        }
      }

      const nextIndex = indexRef.current + 1;
      if (nextIndex >= blocks.length) {
        setStatus("paused");
        latest.current.onNotice?.("已到文末，自动推进已暂停。");
        return;
      }
      indexRef.current = nextIndex;
      const next = blocks[nextIndex];
      if (!next?.isConnected) {
        setStatus("paused");
        return;
      }
      snapToBlock(next);
      scheduleRef.current();
      bumpIdle();
    },
    [bumpIdle, clearDwell, snapToBlock],
  );

  advanceRef.current = advanceInternal;
  scheduleRef.current = scheduleDwell;

  const play = useCallback(() => {
    if (!latest.current.enabled || !latest.current.enabledKind) return;
    if (latest.current.suspended) return;
    const next = nextAutoPaceStatus(statusRef.current, { type: "play" });
    if (next !== "playing") return;
    softPausedRef.current = false;
    indexRef.current = nearestIndex();
    const block = blocksRef.current[indexRef.current];
    if (block) snapToBlock(block);
    setStatus("playing");
    // schedule after status commit via microtask
    queueMicrotask(() => {
      statusRef.current = "playing";
      scheduleRef.current();
      bumpIdle();
    });
  }, [bumpIdle, nearestIndex, snapToBlock]);

  const pause = useCallback(() => {
    clearDwell();
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    setStatus((current) => nextAutoPaceStatus(current, { type: "pause" }));
  }, [clearDwell]);

  const toggle = useCallback(() => {
    if (statusRef.current === "playing") pause();
    else play();
  }, [pause, play]);

  const stop = useCallback(() => {
    clearDwell();
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    setStatus("off");
    latest.current.onRequestDisable?.();
  }, [clearDwell]);

  // Preference enable/disable → armed / off.
  useEffect(() => {
    if (!options.enabled || !options.enabledKind) {
      clearDwell();
      setStatus("off");
      return;
    }
    setStatus((current) =>
      current === "off" ? nextAutoPaceStatus("off", { type: "enable" }) : current,
    );
  }, [clearDwell, options.enabled, options.enabledKind]);

  // TTS suspend while playing → pause.
  useEffect(() => {
    if (options.suspended && statusRef.current === "playing") {
      pause();
    }
  }, [options.suspended, pause]);

  // Collect blocks + wire events while enabled.
  useEffect(() => {
    const reader = options.readerRef.current;
    const article = options.articleRef.current;
    const kind = options.enabledKind;
    if (!reader || !article || !kind || !options.enabled) {
      blocksRef.current = [];
      return;
    }

    disposedRef.current = false;
    let recollectTimer: number | null = null;

    const collect = () => {
      blocksRef.current = collectFocusBlocks(article, kind, { markContainers: true });
      if (indexRef.current >= blocksRef.current.length) {
        indexRef.current = Math.max(0, blocksRef.current.length - 1);
      }
      // 当前块断开时重绑。
      const current = blocksRef.current[indexRef.current];
      if (statusRef.current === "playing" && (!current || !current.isConnected)) {
        indexRef.current = nearestIndex();
        scheduleRef.current();
      }
    };

    collect();

    const mutations = new MutationObserver(() => {
      if (recollectTimer !== null) window.clearTimeout(recollectTimer);
      recollectTimer = window.setTimeout(() => {
        recollectTimer = null;
        if (disposedRef.current) return;
        collect();
      }, 150);
    });
    mutations.observe(article, { childList: true, subtree: true });

    const onVisibility = () => {
      if (document.hidden && statusRef.current === "playing") {
        pause();
      }
    };

    const onBlur = () => {
      if (statusRef.current === "playing") pause();
    };

    const onSelection = () => {
      if (statusRef.current !== "playing") return;
      if (selectionInside(article)) {
        if (!softPausedRef.current) {
          softPausedRef.current = true;
          softPauseElapsedRef.current += Date.now() - blockStartedAtRef.current;
          clearDwell();
        }
        return;
      }
      if (softPausedRef.current) {
        softPausedRef.current = false;
        blockStartedAtRef.current = Date.now();
        const remaining = Math.max(
          0,
          blockBudgetRef.current - softPauseElapsedRef.current,
        );
        clearDwell();
        dwellTimerRef.current = window.setTimeout(() => {
          dwellTimerRef.current = null;
          advanceRef.current("timer");
        }, remaining || 1);
      }
    };

    let scrollbarDrag = false;

    const onPointerDown = (event: PointerEvent) => {
      if (event.offsetX >= reader.clientWidth) {
        scrollbarDrag = true;
        if (statusRef.current === "playing") pause();
      }
    };
    const onPointerUp = () => {
      scrollbarDrag = false;
    };

    const onWheel = (event: WheelEvent) => {
      if (statusRef.current !== "playing" || scrollbarDrag) return;
      if (Date.now() < programmaticUntilRef.current) return;
      bumpIdle();
      event.preventDefault();
      if (event.deltaY > 0) {
        advanceRef.current("early");
      } else if (event.deltaY < 0) {
        const prev = Math.max(0, indexRef.current - 1);
        indexRef.current = prev;
        const nextFactor = applyOverdue(sessionRef.current);
        sessionRef.current = nextFactor;
        setSessionFactor(nextFactor);
        const block = blocksRef.current[prev];
        if (block) snapToBlock(block);
        scheduleRef.current();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isFormField(event.target)) return;

      if (event.key === " " || event.key === "Spacebar") {
        if (statusRef.current === "off") return;
        event.preventDefault();
        toggle();
        return;
      }

      if (statusRef.current !== "playing") return;
      bumpIdle();

      if (EARLY_KEYS.has(event.key)) {
        event.preventDefault();
        advanceRef.current("early");
        return;
      }
      if (BACK_KEYS.has(event.key)) {
        event.preventDefault();
        const prev = Math.max(0, indexRef.current - 1);
        indexRef.current = prev;
        const nextFactor = applyOverdue(sessionRef.current);
        sessionRef.current = nextFactor;
        setSessionFactor(nextFactor);
        const block = blocksRef.current[prev];
        if (block) snapToBlock(block);
        scheduleRef.current();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    document.addEventListener("selectionchange", onSelection);
    reader.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    reader.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);

    return () => {
      disposedRef.current = true;
      mutations.disconnect();
      if (recollectTimer !== null) window.clearTimeout(recollectTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("selectionchange", onSelection);
      reader.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      reader.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      clearDwell();
    };
  }, [
    bumpIdle,
    clearDwell,
    nearestIndex,
    options.articleRef,
    options.contentKey,
    options.enabled,
    options.enabledKind,
    options.readerRef,
    pause,
    snapToBlock,
    toggle,
  ]);

  // Content change resets session index but keeps sessionFactor (plan: 换文档可保留倍率).
  useEffect(() => {
    indexRef.current = 0;
    if (statusRef.current === "playing") {
      clearDwell();
      setStatus("armed");
    }
  }, [clearDwell, options.contentKey]);

  const barOpen = options.enabled && status !== "off" && Boolean(options.enabledKind);
  const paceHint = paceHintLabel(sessionFactor, options.bias);

  return {
    status,
    sessionFactor,
    paceHint,
    barOpen,
    playing: status === "playing",
    play,
    pause,
    toggle,
    stop,
  };
}
