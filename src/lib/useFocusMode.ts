import { useEffect, type RefObject } from "react";
import {
  FOCUS_CONTAINER_ATTR,
  TYPEWRITER_ARM_WINDOW_MS,
  TYPEWRITER_MIN_DELTA_PX,
  TYPEWRITER_SETTLE_MS,
  collectFocusBlocks,
  focusReferenceLine,
  selectFocusIndex,
  type FocusContentKind,
} from "./focusMode";
import type { ReaderMotionLevel } from "./motion";

export type { FocusContentKind };
export { FOCUS_CONTAINER_ATTR };

export const FOCUS_SPOTLIGHT_CLASS = "focus-spotlight";
export const FOCUS_CURRENT_ATTR = "data-focus-current";

/** 打字机武装键：会移动阅读位置的导航键（FM 定稿 §6.1）。 */
const TYPEWRITER_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  " ",
  "Home",
  "End",
]);

function isFormField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable)
  );
}

/**
 * 段落聚焦 + 打字机滚动的共享驱动（plan-focus-mode §3.1/§3.2）。
 * 两个开关共用一次块收集、一个 IntersectionObserver 可见集与同一
 * 最近块判定；`enabledKind` 为 null（含 PDF 原版式）时整体不接线。
 */
export function useFocusMode(options: {
  readerRef: RefObject<HTMLElement | null>;
  articleRef: RefObject<HTMLElement | null>;
  /** null = 不适用（无内容 / PDF 原版式 / 非阅读视图）。 */
  enabledKind: FocusContentKind | null;
  /** 内容身份；变化时重新收集块。 */
  contentKey: string | null;
  spotlight: boolean;
  typewriter: boolean;
  /** TTS 播放中打字机让位（§3.4）。 */
  typewriterSuspended: boolean;
  motionLevel: ReaderMotionLevel;
}): void {
  const {
    readerRef,
    articleRef,
    enabledKind,
    contentKey,
    spotlight,
    typewriter,
    typewriterSuspended,
    motionLevel,
  } = options;

  useEffect(() => {
    const reader = readerRef.current;
    const article = articleRef.current;
    const active = Boolean(enabledKind && (spotlight || typewriter));
    if (!reader || !article || !active || !enabledKind) return;

    let blocks: HTMLElement[] = [];
    const visible = new Set<HTMLElement>();
    let currentBlock: HTMLElement | null = null;
    let frame: number | null = null;
    let recollectTimer: number | null = null;
    let settleTimer: number | null = null;
    let armedAt = 0;
    let scrollbarDrag = false;
    let disposed = false;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target as HTMLElement);
          else visible.delete(entry.target as HTMLElement);
        }
        scheduleUpdate();
      },
      { root: reader, threshold: 0 },
    );

    const clearCurrent = () => {
      if (currentBlock) {
        currentBlock.removeAttribute(FOCUS_CURRENT_ATTR);
        currentBlock = null;
      }
    };

    /** 可见块里距参考线最近者;可见集为空(初始/极端缩放)时不动。 */
    const nearestVisibleBlock = (): HTMLElement | null => {
      const candidates = blocks.filter((block) => visible.has(block));
      if (candidates.length === 0) return null;
      const readerRect = reader.getBoundingClientRect();
      const reference = focusReferenceLine(readerRect.top, readerRect.height);
      const index = selectFocusIndex(
        candidates.map((block) => {
          const rect = block.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        }),
        reference,
      );
      return index === null ? null : candidates[index];
    };

    const update = () => {
      frame = null;
      if (disposed || !spotlight) return;
      const next = nearestVisibleBlock();
      if (!next || next === currentBlock) return;
      clearCurrent();
      currentBlock = next;
      currentBlock.setAttribute(FOCUS_CURRENT_ATTR, "true");
    };

    const scheduleUpdate = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };

    const collect = () => {
      observer.disconnect();
      visible.clear();
      clearCurrent();
      blocks = collectFocusBlocks(article, enabledKind, { markContainers: true });
      for (const block of blocks) observer.observe(block);
    };

    // ---- 打字机滚动(§3.2) ----
    const snap = () => {
      settleTimer = null;
      if (disposed || !typewriter || typewriterSuspended || scrollbarDrag) return;
      const target = nearestVisibleBlock();
      if (!target) return;
      const readerRect = reader.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      const reference = focusReferenceLine(readerRect.top, readerRect.height);
      const delta = rect.top + rect.height / 2 - reference;
      // 吸附消费本次武装:吸附自身触发的 scroll 不再进入判定。
      armedAt = 0;
      if (Math.abs(delta) < TYPEWRITER_MIN_DELTA_PX) return;
      const top = Math.max(0, reader.scrollTop + delta);
      if (motionLevel === "off" || typeof reader.scrollTo !== "function") {
        reader.scrollTop = top;
        return;
      }
      reader.scrollTo({ top, behavior: "smooth" });
    };

    const onScroll = () => {
      scheduleUpdate();
      if (!typewriter || typewriterSuspended || scrollbarDrag) return;
      if (Date.now() - armedAt > TYPEWRITER_ARM_WINDOW_MS) return;
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(snap, TYPEWRITER_SETTLE_MS);
    };

    const arm = () => {
      armedAt = Date.now();
    };

    const onWheel = () => {
      if (!scrollbarDrag) arm();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!TYPEWRITER_KEYS.has(event.key)) return;
      if (isFormField(event.target)) return;
      arm();
    };

    // 滚动条拖拽豁免:指针落点在滚动条区(内容盒之外)时不吸附。
    const onPointerDown = (event: PointerEvent) => {
      if (event.offsetX >= reader.clientWidth) {
        scrollbarDrag = true;
        armedAt = 0;
      }
    };
    const onPointerUp = () => {
      scrollbarDrag = false;
    };

    const mutations = new MutationObserver(() => {
      if (recollectTimer !== null) window.clearTimeout(recollectTimer);
      recollectTimer = window.setTimeout(() => {
        recollectTimer = null;
        if (disposed) return;
        collect();
        scheduleUpdate();
      }, 150);
    });

    if (spotlight) article.classList.add(FOCUS_SPOTLIGHT_CLASS);
    collect();
    scheduleUpdate();
    mutations.observe(article, { childList: true, subtree: true });
    reader.addEventListener("scroll", onScroll, { passive: true });
    reader.addEventListener("wheel", onWheel, { passive: true });
    reader.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      disposed = true;
      mutations.disconnect();
      observer.disconnect();
      reader.removeEventListener("scroll", onScroll);
      reader.removeEventListener("wheel", onWheel);
      reader.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", scheduleUpdate);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (recollectTimer !== null) window.clearTimeout(recollectTimer);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      article.classList.remove(FOCUS_SPOTLIGHT_CLASS);
      clearCurrent();
      for (const container of Array.from(
        article.querySelectorAll<HTMLElement>(`[${FOCUS_CONTAINER_ATTR}]`),
      )) {
        container.removeAttribute(FOCUS_CONTAINER_ATTR);
      }
    };
  }, [
    articleRef,
    contentKey,
    enabledKind,
    motionLevel,
    readerRef,
    spotlight,
    typewriter,
    typewriterSuspended,
  ]);
}
