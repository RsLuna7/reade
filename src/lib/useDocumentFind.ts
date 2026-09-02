import { useCallback, useEffect, useRef, useState } from "react";
import type { PdfPageContent } from "./backend";
import { readPdfReadingMode } from "./backend";
import {
  attachPdfReadingPageNumbers,
  rangeForFindMatch,
  resolveDocumentFindFormat,
  scrollToFindMatch,
  searchDomSurface,
  searchPdfOriginalSurface,
  type DocumentFindFormat,
} from "./documentFindAdapters";
import {
  DOCUMENT_FIND_DEBOUNCE_MS,
  nextFindIndex,
  previousFindIndex,
  type DocumentFindMatch,
} from "./documentFind";
import { applyFindHighlights, clearFindHighlights } from "./documentFindHighlight";
import type { ReaderMotionLevel } from "./motion";

export type DocumentFindStatus = "idle" | "searching" | "ready" | "empty" | "truncated";

export interface UseDocumentFindOptions {
  enabled: boolean;
  currentPath: string | null;
  contentKind: "markdown" | "pdf" | "epub" | null;
  pdfMode: "original" | "reading" | null;
  readerRef: React.RefObject<HTMLElement | null>;
  articleRef: React.RefObject<HTMLElement | null>;
  motionLevel: ReaderMotionLevel;
  jumpToPage?: (page: number) => void;
}

function selectionSeed(): string {
  const selection = globalThis.getSelection();
  if (!selection || selection.isCollapsed) return "";
  return selection.toString().replace(/\s+/g, " ").trim();
}

export function useDocumentFind(options: UseDocumentFindOptions) {
  const {
    enabled,
    currentPath,
    contentKind,
    pdfMode,
    readerRef,
    articleRef,
    motionLevel,
    jumpToPage,
  } = options;

  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [matches, setMatches] = useState<DocumentFindMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [status, setStatus] = useState<DocumentFindStatus>("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<number | null>(null);
  const searchGeneration = useRef(0);
  const pdfPagesCache = useRef<{ path: string; pages: PdfPageContent[] } | null>(null);
  const scrollRetryTimer = useRef<number | null>(null);

  const format = resolveDocumentFindFormat(contentKind, pdfMode);

  const clearHighlights = useCallback(() => {
    clearFindHighlights();
  }, []);

  const reset = useCallback(() => {
    searchGeneration.current += 1;
    if (debounceTimer.current !== null) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (scrollRetryTimer.current !== null) {
      window.clearTimeout(scrollRetryTimer.current);
      scrollRetryTimer.current = null;
    }
    setOpen(false);
    setQueryState("");
    setMatches([]);
    setActiveIndex(-1);
    setStatus("idle");
    clearHighlights();
  }, [clearHighlights]);

  const paintAndScroll = useCallback(
    (nextMatches: DocumentFindMatch[], index: number, nextFormat: DocumentFindFormat | null) => {
      const article = articleRef.current;
      const reader = readerRef.current;
      const match = index >= 0 ? nextMatches[index] ?? null : null;

      if (!article || !reader || !nextFormat || !match) {
        clearHighlights();
        return;
      }

      const attempt = (round: number) => {
        scrollRetryTimer.current = null;
        const ranges: Range[] = [];
        let activeRangeIndex = -1;
        for (let matchIndex = 0; matchIndex < nextMatches.length; matchIndex += 1) {
          const range = rangeForFindMatch(article, nextFormat, nextMatches[matchIndex] ?? null);
          if (!range) continue;
          if (matchIndex === index) activeRangeIndex = ranges.length;
          ranges.push(range);
        }
        if (ranges.length > 0) {
          applyFindHighlights(ranges, activeRangeIndex);
        } else {
          clearHighlights();
        }
        const scrolled = scrollToFindMatch(
          reader,
          article,
          nextFormat,
          match,
          motionLevel,
          jumpToPage,
        );
        if (scrolled || round >= 8) return;
        scrollRetryTimer.current = window.setTimeout(() => attempt(round + 1), 120);
      };
      attempt(0);
    },
    [articleRef, clearHighlights, jumpToPage, motionLevel, readerRef],
  );

  const runSearch = useCallback(
    async (rawQuery: string, nextFormat: DocumentFindFormat | null) => {
      const trimmed = rawQuery.trim();
      if (!trimmed || !nextFormat || !enabled || !currentPath) {
        setMatches([]);
        setActiveIndex(-1);
        setStatus(trimmed ? "empty" : "idle");
        clearHighlights();
        return;
      }

      const generation = ++searchGeneration.current;
      setStatus("searching");

      const article = articleRef.current;
      if (!article) {
        if (generation === searchGeneration.current) setStatus("empty");
        return;
      }

      let resultMatches: DocumentFindMatch[] = [];
      let truncated = false;

      if (nextFormat === "pdf-original") {
        let pages = pdfPagesCache.current;
        if (!pages || pages.path !== currentPath) {
          try {
            const document = await readPdfReadingMode(currentPath);
            if (generation !== searchGeneration.current) return;
            pages = { path: currentPath, pages: document.pages };
            pdfPagesCache.current = pages;
          } catch {
            if (generation !== searchGeneration.current) return;
            setMatches([]);
            setActiveIndex(-1);
            setStatus("empty");
            clearHighlights();
            return;
          }
        }
        const result = searchPdfOriginalSurface(pages.pages, trimmed);
        resultMatches = result.matches;
        truncated = result.truncated;
      } else {
        const result = searchDomSurface(article, nextFormat, trimmed);
        resultMatches = result.matches;
        truncated = result.truncated;
        if (nextFormat === "pdf-reading") {
          resultMatches = attachPdfReadingPageNumbers(article, resultMatches);
        }
      }

      if (generation !== searchGeneration.current) return;

      if (resultMatches.length === 0) {
        setMatches([]);
        setActiveIndex(-1);
        setStatus("empty");
        clearHighlights();
        return;
      }

      setMatches(resultMatches);
      setActiveIndex(0);
      setStatus(truncated ? "truncated" : "ready");
      paintAndScroll(resultMatches, 0, nextFormat);
    },
    [articleRef, clearHighlights, currentPath, enabled, paintAndScroll],
  );

  const setQuery = useCallback(
    (value: string) => {
      setQueryState(value);
      if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
      debounceTimer.current = window.setTimeout(() => {
        debounceTimer.current = null;
        void runSearch(value, format);
      }, DOCUMENT_FIND_DEBOUNCE_MS);
    },
    [format, runSearch],
  );

  const openFind = useCallback(
    (seed?: string) => {
      if (!enabled || !format) return;
      const initial = (seed ?? selectionSeed()).trim();
      setOpen(true);
      setQueryState(initial);
      window.requestAnimationFrame(() => {
        const input = inputRef.current;
        input?.focus();
        input?.select();
      });
      void runSearch(initial, format);
    },
    [enabled, format, runSearch],
  );

  const closeFind = useCallback(() => {
    reset();
  }, [reset]);

  const goToMatch = useCallback(
    (index: number) => {
      if (matches.length === 0 || !format) return;
      const next = ((index % matches.length) + matches.length) % matches.length;
      setActiveIndex(next);
      paintAndScroll(matches, next, format);
    },
    [format, matches, paintAndScroll],
  );

  const nextMatch = useCallback(() => {
    goToMatch(nextFindIndex(activeIndex, matches.length));
  }, [activeIndex, goToMatch, matches.length]);

  const previousMatch = useCallback(() => {
    goToMatch(previousFindIndex(activeIndex, matches.length));
  }, [activeIndex, goToMatch, matches.length]);

  useEffect(() => {
    reset();
    pdfPagesCache.current = null;
  }, [currentPath, reset]);

  const previousFormat = useRef(format);
  useEffect(() => {
    if (previousFormat.current === format) return;
    previousFormat.current = format;
    pdfPagesCache.current = null;
    if (open && query.trim()) void runSearch(query, format);
  }, [format, open, query, runSearch]);

  useEffect(() => {
    if (!enabled && open) reset();
  }, [enabled, open, reset]);

  useEffect(
    () => () => {
      if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
      if (scrollRetryTimer.current !== null) window.clearTimeout(scrollRetryTimer.current);
      clearFindHighlights();
    },
    [],
  );

  return {
    open,
    query,
    matches,
    activeIndex,
    status,
    format,
    inputRef,
    openFind,
    closeFind,
    setQuery,
    nextMatch,
    previousMatch,
    selectMatch: goToMatch,
  };
}
