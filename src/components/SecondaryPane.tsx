/**
 * Split-view secondary pane (docs/plan-split-view.md §3.2–§3.5, decision
 * SP-D1): a self-contained, deliberately degraded reading surface.
 *
 * The pane owns its document state end to end — it calls `readDocument`
 * itself (never the store's `selectDocument`, which would steal the main
 * pane), keeps a session-only scroll memory, resolves its own markdown image
 * assets, and self-navigates on in-library links. Nothing here touches the
 * store, the tracker, TOC, or the persisted reading positions; those stay
 * main-pane-only by design (SP-D2/SP-D3, §3.5).
 *
 * Structure contract: the scroll container carries `.reading-scroll` and the
 * body sits in an `.article-shell`, because the PDF and EPUB readers locate
 * their scroll root via `closest(".reading-scroll")` (PdfReader
 * `findReadingRoot`, EpubReader's chapter tracking) — this is what lets both
 * renderers work in the pane without modification.
 *
 * Session memory can be owned by the caller (`scrollMemory` /
 * `pdfPositionMemory` props): the narrow-window degrade unmounts the pane
 * while App keeps `splitState`, so App-owned maps let the restored pane come
 * back at the same position (SP-D6). PDF positions ride the
 * `PdfReaderHandle` (page + offset), not the container scrollTop.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import {
  assetDataUrl,
  openExternalLink,
  readAsset,
  readDocument,
  type Annotation,
  type DocumentInfo,
} from "../lib/backend";
import type { ReaderMotionLevel } from "../lib/motion";
import { scrollElementWithinContainer } from "../lib/scroll";
import {
  classifyPaneNavigation,
  isPaneDocumentMissing,
  paneDisplayMarkdown,
  paneImageAssetPaths,
  reducePaneContent,
} from "../lib/splitView";
import { EpubReader } from "./EpubReader";
import { MarkdownRenderer } from "./MarkdownRenderer";
import type { PdfPagePosition, PdfReaderHandle } from "./PdfReader";

const PdfReader = lazy(() =>
  import("./PdfReader").then((module) => ({ default: module.PdfReader })),
);

/** SP-D2: the pane renders no annotations; a stable empty array avoids repaint churn. */
const EMPTY_ANNOTATIONS: Annotation[] = [];
/** Stable no-op handlers so the readers' effects never re-run on pane renders. */
const NOOP_TOC_CHANGE = () => undefined;
const NOOP_ACTIVE_CHANGE = () => undefined;
const NOTICE_TIMEOUT_MS = 4000;
const EXTERNAL_PROTOCOL = /^(?:https?:|mailto:)/i;

function paneFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export interface SecondaryPaneProps {
  /** Requested document (App's `splitState.path`); changes reset self-navigation. */
  path: string;
  /** Current library snapshot — used for titles, PDF metadata and the 失联 check. */
  documents: DocumentInfo[];
  motionLevel: ReaderMotionLevel;
  onClose: () => void;
  /** Fired when the pane self-navigates, so the owner can keep its state in sync. */
  onPathChange?: (path: string) => void;
  /** Caller-owned session scroll memory (survives degrade/restore unmounts). */
  scrollMemory?: Map<string, number>;
  /** Caller-owned session PDF positions (page + offset via PdfReaderHandle). */
  pdfPositionMemory?: Map<string, PdfPagePosition>;
}

export function SecondaryPane({
  path,
  documents,
  motionLevel,
  onClose,
  onPathChange,
  scrollMemory: scrollMemoryProp,
  pdfPositionMemory: pdfPositionMemoryProp,
}: SecondaryPaneProps) {
  const [activePath, setActivePath] = useState(path);
  const [pane, dispatchPane] = useReducer(reducePaneContent, null);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const articleRef = useRef<HTMLDivElement | null>(null);
  /** Session-only scroll memory (§3.5) — never written to readingPositions. */
  const internalScrollMemory = useRef(new Map<string, number>());
  const scrollMemory = scrollMemoryProp ?? internalScrollMemory.current;
  const internalPdfMemory = useRef(new Map<string, PdfPagePosition>());
  const pdfPositionMemory = pdfPositionMemoryProp ?? internalPdfMemory.current;
  const pdfHandleRef = useRef<PdfReaderHandle | null>(null);
  const pendingHash = useRef<string | null>(null);

  // A new request from the owner overrides any self-navigation.
  useEffect(() => {
    setActivePath(path);
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    dispatchPane({ type: "load", path: activePath });
    readDocument(activePath)
      .then((content) => {
        if (!cancelled) dispatchPane({ type: "loaded", path: activePath, content });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          dispatchPane({
            type: "load-failed",
            path: activePath,
            message: error instanceof Error ? error.message : "文档读取失败",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  // Markdown image pipeline, scoped to the pane's own document (§3.3 last row).
  // The reset bails out when the map is already empty: a fresh object here
  // would re-render with a new `resolveImageSrc` identity, and the markdown
  // subtree (inline component map) would remount its DOM for nothing.
  const resetAssetUrls = () =>
    setAssetUrls((current) => (Object.keys(current).length === 0 ? current : {}));
  useEffect(() => {
    if (pane?.status !== "ready" || pane.content.kind !== "markdown") {
      resetAssetUrls();
      return;
    }
    let cancelled = false;
    resetAssetUrls();
    for (const { source, relativePath } of paneImageAssetPaths(
      pane.content.markdown,
      pane.path,
    )) {
      void readAsset(relativePath)
        .then((asset) => {
          if (!cancelled) {
            setAssetUrls((current) => ({ ...current, [source]: assetDataUrl(asset) }));
          }
        })
        .catch(() => {
          // Missing and out-of-library images stay visibly blocked.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [pane]);

  // Session scroll restore; explicit hash targets take priority below.
  useLayoutEffect(() => {
    if (pane?.status !== "ready") return;
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = scrollMemory.get(pane.path) ?? 0;
  }, [pane, scrollMemory]);

  // PDF position restore rides the PdfReaderHandle (page + offset): canvas
  // pages mount lazily/asynchronously, so retry until restorePosition lands
  // (same bounded-retry pattern as the main pane's H0 restore).
  useEffect(() => {
    if (pane?.status !== "ready" || pane.content.kind !== "pdf") return;
    const stored = pdfPositionMemory.get(pane.path);
    if (!stored) return;
    let cancelled = false;
    let timer: number | null = null;
    const MAX_ROUNDS = 20;
    const attempt = (round: number) => {
      timer = null;
      if (cancelled) return;
      const restored = pdfHandleRef.current?.restorePosition(stored) ?? false;
      if (restored || round >= MAX_ROUNDS) return;
      timer = window.setTimeout(() => attempt(round + 1), 200);
    };
    attempt(0);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pane, pdfPositionMemory]);

  useEffect(() => {
    if (pane?.status !== "ready" || !pendingHash.current) return;
    const id = pendingHash.current;
    pendingHash.current = null;
    const frame = requestAnimationFrame(() => {
      const target = articleRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      scrollElementWithinContainer(
        scrollRef.current,
        target ?? null,
        motionLevel === "off" ? "auto" : "smooth",
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [pane, motionLevel]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const paneIsPdf = pane?.status === "ready" && pane.content.kind === "pdf";
  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (container) scrollMemory.set(activePath, container.scrollTop);
    if (paneIsPdf) {
      const position = pdfHandleRef.current?.getPosition();
      if (position) pdfPositionMemory.set(activePath, position);
    }
  }, [activePath, paneIsPdf, pdfPositionMemory, scrollMemory]);

  const resolveImageSrc = useCallback(
    (source: string) => {
      if (source.startsWith("data:image/")) return source;
      if (EXTERNAL_PROTOCOL.test(source)) return null;
      return assetUrls[source] ?? null;
    },
    [assetUrls],
  );

  const handleNavigate = useCallback(
    (href: string) => {
      const navigation = classifyPaneNavigation(href, activePath, documents);
      if (navigation.kind === "anchor") {
        const target =
          articleRef.current?.querySelector<HTMLElement>(`#${CSS.escape(navigation.id)}`) ??
          null;
        scrollElementWithinContainer(
          scrollRef.current,
          target,
          motionLevel === "off" ? "auto" : "smooth",
        );
        return;
      }
      if (navigation.kind === "external") {
        if (window.confirm(`将在系统应用中打开外部链接：\n\n${navigation.href}\n\n是否继续？`)) {
          void openExternalLink(navigation.href).catch((error: unknown) => {
            setNotice(error instanceof Error ? error.message : "外部链接打开失败");
          });
        }
        return;
      }
      if (navigation.kind === "blocked") {
        setNotice(navigation.reason);
        return;
      }
      // In-library document: the pane navigates itself (never selectDocument).
      const container = scrollRef.current;
      if (container) scrollMemory.set(activePath, container.scrollTop);
      pendingHash.current = navigation.hash;
      setActivePath(navigation.path);
      onPathChange?.(navigation.path);
    },
    [activePath, documents, motionLevel, onPathChange, scrollMemory],
  );

  const documentInfo =
    documents.find((entry) => entry.relativePath === activePath) ?? null;
  const missing = isPaneDocumentMissing(activePath, documents);
  const title = documentInfo?.title ?? paneFileName(activePath);
  const contentKind = pane?.status === "ready" ? pane.content.kind : null;

  const renderBody = () => {
    if (missing) {
      return (
        <div className="secondary-pane-state" role="status">
          <p>文档已不在当前文档库中，可能被移动、重命名或删除。</p>
          <button type="button" onClick={onClose}>
            关闭副栏
          </button>
        </div>
      );
    }
    if (!pane || pane.status === "loading") {
      return (
        <div className="secondary-pane-state" role="status">
          <span className="spinner" aria-hidden="true" />
          正在加载文档…
        </div>
      );
    }
    if (pane.status === "error") {
      return (
        <div className="secondary-pane-state secondary-pane-state--error" role="alert">
          <p>文档读取失败：{pane.message}</p>
        </div>
      );
    }
    const loaded = pane.content;
    if (loaded.kind === "markdown") {
      return (
        <MarkdownRenderer
          content={paneDisplayMarkdown(loaded.markdown)}
          resolveImageSrc={resolveImageSrc}
          onNavigate={(href) => handleNavigate(href)}
        />
      );
    }
    if (loaded.kind === "epub") {
      return (
        <EpubReader
          relativePath={loaded.relativePath}
          document={loaded.document}
          locator={null}
          motionLevel={motionLevel}
          annotations={EMPTY_ANNOTATIONS}
          onTocChange={NOOP_TOC_CHANGE}
          onActiveChange={NOOP_ACTIVE_CHANGE}
        />
      );
    }
    return (
      <Suspense
        fallback={
          <div className="secondary-pane-state" role="status">
            <span className="spinner" aria-hidden="true" />
            正在加载 PDF 阅读器…
          </div>
        }
      >
        <PdfReader
          relativePath={loaded.relativePath}
          size={loaded.size}
          modified={documentInfo?.modified ?? 0}
          indexStatus={loaded.indexStatus}
          indexError={loaded.indexError}
          locator={null}
          motionLevel={motionLevel}
          annotations={EMPTY_ANNOTATIONS}
          readerRef={pdfHandleRef}
          onTocChange={NOOP_TOC_CHANGE}
          onActiveChange={NOOP_ACTIVE_CHANGE}
        />
      </Suspense>
    );
  };

  return (
    <section className="secondary-pane" aria-label="副栏阅读">
      <header className="secondary-pane-header">
        <span className="secondary-pane-title" title={activePath}>
          {title}
        </span>
        <button
          type="button"
          className="secondary-pane-close"
          aria-label="关闭副栏"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {notice && (
        <div className="secondary-pane-notice" role="status">
          {notice}
        </div>
      )}
      <div
        className="reading-scroll secondary-pane-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        <div
          className={`article-shell${contentKind ? ` article-shell--${contentKind}` : ""} secondary-pane-article`}
          ref={articleRef}
        >
          {renderBody()}
        </div>
      </div>
    </section>
  );
}

export default SecondaryPane;
