import { useEffect, useMemo, useRef, useState } from "react";
import {
  APP_RUNTIME,
  readDocumentThumbnail,
  type DocumentExtent,
  type DocumentInfo,
} from "../lib/backend";
import { generatedCover, shelfProgressLabel } from "../lib/coverArt";
import { capturePdfCoverThumbnail, COVER_STORED_EVENT } from "../lib/coverCapture";
import { listLibraryReadingPositions, type ReadingPosition } from "../lib/readingPositions";
import { buildDocumentTree, documentTreeName, flattenDocumentsInTreeOrder } from "../lib/tree";
import { useReaderStore } from "../store/useReaderStore";

/**
 * 书架视图（docs/plan-bookshelf-covers.md §3.3）：库 tab 的网格浏览形态。
 * 封面三来源——缓存缩略图（PDF 首页 / EPUB 封面）、生成式渐变（Markdown
 * 与一切回落）；PDF 缩略图进入视口后串行懒渲染（同一时间只解一个 PDF）。
 */

export interface BookshelfViewProps {
  /** 打开文档前的回调（阅读回退栈出发点记录，同 DocumentTree）。 */
  onBeforeSelect?: () => void;
  /** Alt+点击在右侧分栏打开（plan-split-view SP-D4），未传则忽略。 */
  onOpenSecondary?: (path: string) => void;
  /** 阅读时间预估的 extents（PDF 进度角标折算页数分母；可空）。 */
  extents?: ReadonlyMap<string, DocumentExtent> | null;
}

/** PDF 封面串行渲染队列：防止多文档同时解码的内存峰值。 */
let coverQueue: Promise<void> = Promise.resolve();
function enqueueCoverTask(task: () => Promise<void>): void {
  coverQueue = coverQueue.catch(() => undefined).then(task);
}

const FORMAT_BADGES: Record<DocumentInfo["format"], string> = {
  markdown: "MD",
  mdx: "MDX",
  pdf: "PDF",
  epub: "EPUB",
};

interface ShelfCardProps {
  document: DocumentInfo;
  position: ReadingPosition | undefined;
  extent: DocumentExtent | undefined;
  coverUrl: string | undefined;
  isCurrent: boolean;
  onVisible: (document: DocumentInfo) => void;
  onOpen: (path: string, altKey: boolean) => void;
}

function ShelfCard({
  document,
  position,
  extent,
  coverUrl,
  isCurrent,
  onVisible,
  onOpen,
}: ShelfCardProps) {
  const cardRef = useRef<HTMLButtonElement>(null);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  const name = documentTreeName(document);
  const cover = useMemo(() => generatedCover(name), [name]);
  const progress = shelfProgressLabel(position, extent?.segmentCount);

  useEffect(() => {
    const element = cardRef.current;
    if (!element) return;
    // jsdom 与老环境没有 IntersectionObserver：直接视为可见。
    if (typeof IntersectionObserver === "undefined") {
      onVisibleRef.current(document);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          onVisibleRef.current(document);
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [document]);

  return (
    <button
      className={`bookshelf__card${isCurrent ? " bookshelf__card--current" : ""}`}
      type="button"
      ref={cardRef}
      aria-current={isCurrent ? "page" : undefined}
      aria-label={progress ? `${name}，已读 ${progress}` : name}
      title={document.relativePath}
      onClick={(event) => onOpen(document.relativePath, event.altKey)}
    >
      <span className="bookshelf__cover" aria-hidden="true">
        {coverUrl ? (
          <img className="bookshelf__cover-image" src={coverUrl} alt="" loading="lazy" />
        ) : (
          <span
            className="bookshelf__cover-art"
            style={{
              background: `linear-gradient(${cover.angle}deg, ${cover.from}, ${cover.to})`,
            }}
          >
            <span className="bookshelf__cover-initial">{cover.initial}</span>
          </span>
        )}
        <span className={`bookshelf__format bookshelf__format--${document.format}`}>
          {FORMAT_BADGES[document.format]}
        </span>
        {progress && (
          <span className="bookshelf__progress" aria-hidden="true">
            {progress}
          </span>
        )}
      </span>
      <span className="bookshelf__title" aria-hidden="true">
        {name}
      </span>
    </button>
  );
}

export function BookshelfView({ onBeforeSelect, onOpenSecondary, extents }: BookshelfViewProps) {
  const documents = useReaderStore((state) => state.documents);
  const snapshot = useReaderStore((state) => state.snapshot);
  const currentPath = useReaderStore((state) => state.currentPath);
  const loading = useReaderStore((state) => state.loading);
  const selectDocument = useReaderStore((state) => state.selectDocument);

  const ordered = useMemo(
    () => flattenDocumentsInTreeOrder(buildDocumentTree(documents)),
    [documents],
  );
  const rootPath = snapshot?.rootPath ?? null;
  const positions = useMemo(
    () => (rootPath ? listLibraryReadingPositions(rootPath) : {}),
    // documents 变化（打开/刷新库、索引完成）时重读一次进度快照。
    [rootPath, documents],
  );

  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const requestedRef = useRef(new Set<string>());
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 换库时清空封面状态：相对路径只对当前库有意义。
  useEffect(() => {
    requestedRef.current = new Set();
    setCoverUrls({});
  }, [rootPath]);

  const applyThumbnail = (path: string, png: string) => {
    if (!aliveRef.current) return;
    setCoverUrls((current) =>
      current[path] ? current : { ...current, [path]: `data:image/png;base64,${png}` },
    );
  };

  const loadCover = (document: DocumentInfo) => {
    if (APP_RUNTIME === "web") return;
    if (document.format !== "pdf" && document.format !== "epub") return;
    const path = document.relativePath;
    if (requestedRef.current.has(path)) return;
    requestedRef.current.add(path);
    void readDocumentThumbnail(path)
      .then((thumbnail) => {
        if (thumbnail) {
          applyThumbnail(path, thumbnail.png);
          return;
        }
        if (document.format !== "pdf") return;
        // 未命中缓存的 PDF：串行渲染首页（懒加载 + 单并发）。
        enqueueCoverTask(async () => {
          if (!aliveRef.current) return;
          try {
            const stored = await capturePdfCoverThumbnail(path, document.size);
            if (!stored || !aliveRef.current) return;
            const refreshed = await readDocumentThumbnail(path);
            if (refreshed) applyThumbnail(path, refreshed.png);
          } catch {
            // 渲染失败保持生成式封面；下次挂载会重试。
            requestedRef.current.delete(path);
          }
        });
      })
      .catch(() => {
        requestedRef.current.delete(path);
      });
  };

  // EPUB 打开时捕获封面后的即时刷新通知（coverCapture.ts）。
  useEffect(() => {
    const handler = (event: Event) => {
      const path = (event as CustomEvent<string>).detail;
      if (typeof path !== "string" || !path) return;
      requestedRef.current.delete(path);
      void readDocumentThumbnail(path)
        .then((thumbnail) => {
          if (thumbnail) applyThumbnail(path, thumbnail.png);
        })
        .catch(() => undefined);
    };
    window.addEventListener(COVER_STORED_EVENT, handler);
    return () => window.removeEventListener(COVER_STORED_EVENT, handler);
  }, []);

  const openDocument = (path: string, altKey: boolean) => {
    if (altKey && onOpenSecondary) {
      onOpenSecondary(path);
      return;
    }
    onBeforeSelect?.();
    void selectDocument(path);
  };

  return (
    <nav className="bookshelf" aria-label="书架">
      <h2 className="document-tree__label">书架</h2>
      {ordered.length > 0 ? (
        <div className="bookshelf__grid">
          {ordered.map((document) => (
            <ShelfCard
              key={document.relativePath}
              document={document}
              position={positions[document.relativePath]}
              extent={extents?.get(document.relativePath)}
              coverUrl={coverUrls[document.relativePath]}
              isCurrent={document.relativePath === currentPath}
              onVisible={loadCover}
              onOpen={openDocument}
            />
          ))}
        </div>
      ) : (
        <p className="document-tree__empty" role="status">
          {loading ? "正在读取文档库…" : "选择一个文件夹开始阅读"}
        </p>
      )}
    </nav>
  );
}
