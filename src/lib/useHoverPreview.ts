/**
 * Hover preview state machine (docs/plan-hover-preview.md §3.2).
 *
 * Owns the intent timers (hover 400ms / focus 600ms, HP-D4), the 200ms
 * leave grace, the in-memory LRU (20 entries / 60s, never persisted) and
 * the stale-response guard. Link classification is strict: only targets
 * that resolve through `resolveLibraryPath` into the *current scan set*
 * ever trigger a request; external links, plain anchors and assets never
 * do (HP-D5) — hovering an `http:` link performs no network activity.
 *
 * Footnote references (`#user-content-fn-*`) preview from the already
 * rendered DOM with zero IPC. Everything shown by the card is plain text.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  readDocumentPreview,
  type DocumentFormat,
  type DocumentInfo,
  type DocumentPreview,
  type IndexStatus,
} from "./backend";
import { resolveLibraryPath } from "./documentLinks";
import { PREVIEW_EXCERPT_MAX_CHARS } from "./previewExcerpt";

export const HOVER_PREVIEW_DELAY_MS = 400;
export const FOCUS_PREVIEW_DELAY_MS = 600;
export const HOVER_PREVIEW_CLOSE_GRACE_MS = 200;
export const HOVER_PREVIEW_CACHE_LIMIT = 20;
export const HOVER_PREVIEW_CACHE_TTL_MS = 60_000;

const FOOTNOTE_PREFIX = "#user-content-fn-";
const PROTOCOL_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const CARD_WIDTH = 360;
const CARD_CLEARANCE = 300;
const VIEWPORT_PADDING = 12;

export type HoverPreviewTrigger = "hover" | "focus";

export type HoverPreviewData =
  | { kind: "footnote"; text: string }
  | {
      kind: "document";
      status: "loading" | "ready" | "error";
      targetPath: string;
      fragment: string | null;
      /** The original href, replayed through `onNavigate` by the 打开 row. */
      href: string;
      title: string;
      format: DocumentFormat | null;
      excerpt: string;
      pdfPages: number | null;
      indexStatus: IndexStatus | null;
      error: string | null;
    };

export interface HoverPreviewState {
  data: HoverPreviewData;
  x: number;
  y: number;
  placement: "below" | "above";
}

interface PendingIntent {
  timer: number;
  fire: () => void;
}

function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Fixed-position card anchor derived from the link rect (clamped). */
function cardPosition(anchor: HTMLElement): Pick<HoverPreviewState, "x" | "y" | "placement"> {
  const rect = anchor.getBoundingClientRect();
  const x = Math.min(
    Math.max(VIEWPORT_PADDING, rect.left),
    Math.max(VIEWPORT_PADDING, window.innerWidth - CARD_WIDTH - VIEWPORT_PADDING),
  );
  const below = rect.bottom + CARD_CLEARANCE <= window.innerHeight || rect.top < CARD_CLEARANCE;
  return below
    ? { x, y: rect.bottom + 8, placement: "below" }
    : { x, y: Math.max(VIEWPORT_PADDING, rect.top - 8), placement: "above" };
}

/** Plain text of a rendered footnote, back-reference arrows stripped. */
export function extractFootnoteText(article: HTMLElement | null, href: string): string | null {
  if (!article || !href.startsWith(FOOTNOTE_PREFIX)) return null;
  const id = decodeFragment(href.slice(1));
  let target: Element | null;
  try {
    target = article.querySelector(`#${CSS.escape(id)}`);
  } catch {
    target = null;
  }
  if (!target) return null;
  const text = (target.textContent ?? "")
    .replace(/[\u21A9\uFE0E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > PREVIEW_EXCERPT_MAX_CHARS
    ? `${chars.slice(0, PREVIEW_EXCERPT_MAX_CHARS).join("")}…`
    : text;
}

export interface UseHoverPreviewOptions {
  /** Hover-capable pointer and no competing overlay (HP-D8). */
  enabled: boolean;
  currentPath: string | null;
  documents: DocumentInfo[];
  articleRef: RefObject<HTMLElement | null>;
  /** Injected for tests; defaults to the shared backend wrapper. */
  loadPreview?: (relativePath: string, fragment: string | null) => Promise<DocumentPreview>;
}

export interface HoverPreviewControls {
  preview: HoverPreviewState | null;
  /** Article `<a>` entry point: classifies the href itself. */
  previewLink: (href: string, anchor: HTMLElement, trigger: HoverPreviewTrigger) => void;
  /** Side-panel entry point for already-resolved targets (HP-D5). */
  previewTarget: (
    relativePath: string,
    fragment: string | null,
    anchor: HTMLElement,
    trigger: HoverPreviewTrigger,
  ) => void;
  /** Pointer/focus left the link: cancel intent, close after the grace. */
  cancelPreview: () => void;
  /** Pointer entered the card: keep it open. */
  holdPreview: () => void;
  closePreview: () => void;
}

export function useHoverPreview(options: UseHoverPreviewOptions): HoverPreviewControls {
  const { enabled, currentPath, documents } = options;
  const latest = useRef(options);
  latest.current = options;

  const [preview, setPreview] = useState<HoverPreviewState | null>(null);
  const pendingRef = useRef<PendingIntent | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  const cacheRef = useRef(new Map<string, { at: number; preview: DocumentPreview }>());

  const clearPending = useCallback(() => {
    if (pendingRef.current !== null) {
      window.clearTimeout(pendingRef.current.timer);
      pendingRef.current = null;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closePreview = useCallback(() => {
    clearPending();
    clearCloseTimer();
    requestRef.current += 1;
    setPreview(null);
  }, [clearCloseTimer, clearPending]);

  const armIntent = useCallback(
    (trigger: HoverPreviewTrigger, fire: () => void) => {
      clearPending();
      clearCloseTimer();
      const delay = trigger === "focus" ? FOCUS_PREVIEW_DELAY_MS : HOVER_PREVIEW_DELAY_MS;
      const timer = window.setTimeout(() => {
        pendingRef.current = null;
        fire();
      }, delay);
      pendingRef.current = { timer, fire };
    },
    [clearCloseTimer, clearPending],
  );

  const cachedPreview = useCallback((key: string): DocumentPreview | null => {
    const cache = cacheRef.current;
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > HOVER_PREVIEW_CACHE_TTL_MS) {
      cache.delete(key);
      return null;
    }
    // Refresh recency (Map keeps insertion order).
    cache.delete(key);
    cache.set(key, entry);
    return entry.preview;
  }, []);

  const storePreview = useCallback((key: string, value: DocumentPreview) => {
    const cache = cacheRef.current;
    cache.delete(key);
    cache.set(key, { at: Date.now(), preview: value });
    while (cache.size > HOVER_PREVIEW_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }, []);

  const openDocumentPreview = useCallback(
    (targetPath: string, fragment: string | null, href: string, anchor: HTMLElement) => {
      const position = cardPosition(anchor);
      const key = `${targetPath}#${fragment ?? ""}`;
      const base = {
        kind: "document" as const,
        targetPath,
        fragment,
        href,
      };
      const cached = cachedPreview(key);
      if (cached) {
        setPreview({
          data: {
            ...base,
            status: "ready",
            title: cached.title,
            format: cached.format,
            excerpt: cached.excerpt,
            pdfPages: cached.pdfPages,
            indexStatus: cached.indexStatus,
            error: null,
          },
          ...position,
        });
        return;
      }
      const request = ++requestRef.current;
      const fallbackTitle =
        latest.current.documents.find((document) => document.relativePath === targetPath)?.title ??
        targetPath;
      setPreview({
        data: {
          ...base,
          status: "loading",
          title: fallbackTitle,
          format: null,
          excerpt: "",
          pdfPages: null,
          indexStatus: null,
          error: null,
        },
        ...position,
      });
      const load = latest.current.loadPreview ?? readDocumentPreview;
      load(targetPath, fragment).then(
        (result) => {
          if (requestRef.current !== request) return;
          storePreview(key, result);
          setPreview((current) => {
            if (current?.data.kind !== "document" || current.data.targetPath !== targetPath) {
              return current;
            }
            return {
              ...current,
              data: {
                ...base,
                status: "ready",
                title: result.title,
                format: result.format,
                excerpt: result.excerpt,
                pdfPages: result.pdfPages,
                indexStatus: result.indexStatus,
                error: null,
              },
            };
          });
        },
        (cause: unknown) => {
          if (requestRef.current !== request) return;
          setPreview((current) => {
            if (current?.data.kind !== "document" || current.data.targetPath !== targetPath) {
              return current;
            }
            return {
              ...current,
              data: {
                ...base,
                status: "error",
                title: fallbackTitle,
                format: null,
                excerpt: "",
                pdfPages: null,
                indexStatus: null,
                error: cause instanceof Error ? cause.message : "预览加载失败",
              },
            };
          });
        },
      );
    },
    [cachedPreview, storePreview],
  );

  const previewTarget = useCallback(
    (
      relativePath: string,
      fragment: string | null,
      anchor: HTMLElement,
      trigger: HoverPreviewTrigger,
    ) => {
      if (!latest.current.enabled) return;
      const present = latest.current.documents.some(
        (document) => document.relativePath.replace(/\\/g, "/") === relativePath,
      );
      if (!present) return;
      // 侧栏目标已是库内路径:href 用「/库根路径」形态,回放进
      // handleNavigate 时经 resolveLibraryPath 的根锚定分支还原。
      armIntent(trigger, () =>
        openDocumentPreview(relativePath, fragment, `/${relativePath}`, anchor),
      );
    },
    [armIntent, openDocumentPreview],
  );

  const previewLink = useCallback(
    (href: string, anchor: HTMLElement, trigger: HoverPreviewTrigger) => {
      if (!latest.current.enabled) return;
      if (href.startsWith(FOOTNOTE_PREFIX)) {
        armIntent(trigger, () => {
          const text = extractFootnoteText(latest.current.articleRef.current, href);
          if (!text) return;
          setPreview({ data: { kind: "footnote", text }, ...cardPosition(anchor) });
        });
        return;
      }
      // Same-document anchors and every protocol URL (http/https/mailto/
      // anything else) never preview — no request, no card (HP-D5).
      if (href.startsWith("#") || href.startsWith("//") || PROTOCOL_PATTERN.test(href)) return;
      const path = latest.current.currentPath;
      if (!path) return;
      const [pathPart, hash] = href.split("#", 2);
      const targetPath = resolveLibraryPath(pathPart, path);
      if (!targetPath) return;
      const target = latest.current.documents.find(
        (document) => document.relativePath.replace(/\\/g, "/") === targetPath,
      );
      if (!target) return;
      const fragment = hash ? decodeFragment(hash) : null;
      armIntent(trigger, () =>
        openDocumentPreview(target.relativePath, fragment, href, anchor),
      );
    },
    [armIntent, openDocumentPreview],
  );

  const cancelPreview = useCallback(() => {
    clearPending();
    if (closeTimerRef.current !== null) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      closePreview();
    }, HOVER_PREVIEW_CLOSE_GRACE_MS);
  }, [clearPending, closePreview]);

  const holdPreview = useCallback(() => {
    clearCloseTimer();
  }, [clearCloseTimer]);

  // 移开或滚动即消失;Esc 关闭(可达性)。滚动用捕获监听,覆盖阅读容器
  // 与页面内的一切滚动面。
  useEffect(() => {
    if (!preview) return;
    const onScroll = () => closePreview();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePreview();
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [preview, closePreview]);

  // 文档切换或浮层竞争(HP-D8)时立即收起并停止计时。
  useEffect(() => {
    if (!enabled) closePreview();
  }, [enabled, closePreview]);
  useEffect(() => {
    closePreview();
  }, [currentPath, closePreview]);
  useEffect(() => {
    cacheRef.current.clear();
  }, [documents]);
  useEffect(
    () => () => {
      clearPending();
      clearCloseTimer();
    },
    [clearCloseTimer, clearPending],
  );

  return { preview, previewLink, previewTarget, cancelPreview, holdPreview, closePreview };
}
