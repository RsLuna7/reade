import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  APP_RUNTIME,
  addCollectionItem,
  listCollectionItems,
  listCollections,
  readDocumentThumbnail,
  removeCollectionItem,
  type CollectionItem,
  type CollectionSummary,
  type DocumentExtent,
  type DocumentFormat,
  type DocumentInfo,
} from "../lib/backend";
import { generatedCover, shelfProgressLabel } from "../lib/coverArt";
import { COVER_STORED_EVENT } from "../lib/coverCaptureEvent";
import {
  ALL_LIBRARY_SCOPE,
  LIBRARY_COVER_SIZE_MAX,
  LIBRARY_COVER_SIZE_MIN,
  collectScopedLibraryItems,
  filterLibraryBrowseItems,
  libraryCountLabel,
  libraryRangeTitle,
  libraryReadStatus,
  libraryStatusText,
  sortLibraryBrowseItems,
  type LibraryBrowseItem,
} from "../lib/libraryBrowse";
import { isMarkedRead } from "../lib/readMarks";
import { highWaterCoverage } from "../lib/readingTimeEstimate";
import { listLibraryReadingPositions, type ReadingPosition } from "../lib/readingPositions";
import { documentTreeName, flattenDocumentsInTreeOrder } from "../lib/tree";
import { buildLaidOutDocumentTree } from "../lib/treeLayout";
import { useReaderStore } from "../store/useReaderStore";
import { ShelvesManagerPanel } from "./CollectionsSection";

/**
 * 书库主区封面浏览。封面三来源：缓存缩略图（PDF 首页 / EPUB 封面）、
 * 生成式渐变（Markdown 与一切回落）；PDF 缩略图进入视口后串行懒渲染。
 */

export interface BookshelfViewProps {
  /** 打开文档前的回调（阅读回退栈出发点记录，同 DocumentTree）。 */
  onBeforeSelect?: () => void;
  /** Alt+点击在右侧分栏打开（plan-split-view SP-D4），未传则忽略。 */
  onOpenSecondary?: (path: string) => void;
  /** 阅读时间预估的 extents（PDF 进度角标折算页数分母；可空）。 */
  extents?: ReadonlyMap<string, DocumentExtent> | null;
  onNotice?: (message: string) => void;
  /** 合集写操作后递增，驱动书架下拉与成员重拉。 */
  refreshToken?: number;
  onCollectionsChanged?: () => void;
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

function folderLabel(path: string): string {
  return path.split("/").filter(Boolean).join(" / ");
}

interface ShelfCardProps {
  item: LibraryBrowseItem;
  position: ReadingPosition | undefined;
  extent: DocumentExtent | undefined;
  coverUrl: string | undefined;
  isCurrent: boolean;
  markedRead: boolean;
  onVisible: (document: DocumentInfo) => void;
  onOpen: (path: string, altKey: boolean) => void;
  onMenu: (item: LibraryBrowseItem) => void;
  onNotice?: (message: string) => void;
}

function ShelfCard({
  item,
  position,
  extent,
  coverUrl,
  isCurrent,
  markedRead,
  onVisible,
  onOpen,
  onMenu,
  onNotice,
}: ShelfCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  const { document, present } = item;
  const name = documentTreeName(document);
  const cover = useMemo(() => generatedCover(name), [name]);
  const progress = present
    ? shelfProgressLabel(position, extent?.segmentCount, markedRead)
    : "失联";
  const status = present
    ? libraryReadStatus(markedRead, position, extent?.segmentCount)
    : "new";
  const statusText = present ? libraryStatusText(status, progress) : "失联";
  const coverage = present ? highWaterCoverage(position, extent?.segmentCount) : null;
  const openLabel = present
    ? status === "read"
      ? `${name}，已读`
      : progress
        ? `${name}，已读 ${progress}`
        : name
    : `${name}，文档已不在当前书库`;

  useEffect(() => {
    const element = cardRef.current;
    if (!element || !present) return;
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
  }, [document, present]);

  return (
    <article
      className={`library-card${isCurrent ? " library-card--current" : ""}${
        present ? "" : " library-card--missing"
      }`}
      ref={cardRef}
    >
      <button
        className="library-card__open"
        type="button"
        aria-current={isCurrent ? "page" : undefined}
        aria-label={openLabel}
        title={present ? document.relativePath : `${document.relativePath}（文档已移动或删除）`}
        disabled={!present}
        onClick={(event) => {
          if (!present) {
            onNotice?.("这篇文档已不在当前书库中，原文件未被删除。");
            return;
          }
          onOpen(document.relativePath, event.altKey);
        }}
      >
        <span className="library-card__cover" aria-hidden="true">
          <span className="library-card__cover-face">
            {coverUrl ? (
              <img className="library-card__cover-image" src={coverUrl} alt="" loading="lazy" />
            ) : (
              <span
                className={`library-card__cover-art library-card__cover-art--${cover.density}`}
                style={{
                  background: `linear-gradient(${cover.angle}deg, ${cover.from}, ${cover.to})`,
                }}
              >
                <span className="library-card__cover-title">{cover.headline}</span>
              </span>
            )}
          </span>
          <span className={`library-card__format library-card__format--${document.format}`}>
            {FORMAT_BADGES[document.format]}
          </span>
        </span>
        <span className="library-card__title" title={name}>
          {name}
        </span>
      </button>
      <div className="library-card__meta">
        <span className="library-card__status">{statusText}</span>
        {present ? (
          <button
            className="library-card__menu"
            type="button"
            aria-label={`管理 ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              onMenu(item);
            }}
          >
            ···
          </button>
        ) : null}
      </div>
      <div className="library-card__track" aria-hidden="true">
        <i style={{ width: coverage !== null ? `${Math.round(coverage * 100)}%` : "0%" }} />
      </div>
    </article>
  );
}

export function BookshelfView({
  onBeforeSelect,
  onOpenSecondary,
  extents,
  onNotice,
  refreshToken = 0,
  onCollectionsChanged,
}: BookshelfViewProps) {
  const documents = useReaderStore((state) => state.documents);
  const treeLayout = useReaderStore((state) => state.treeLayout);
  const snapshot = useReaderStore((state) => state.snapshot);
  const currentPath = useReaderStore((state) => state.currentPath);
  const loading = useReaderStore((state) => state.loading);
  const selectDocument = useReaderStore((state) => state.selectDocument);
  const readMarks = useReaderStore((state) => state.readMarks);
  const markDocumentRead = useReaderStore((state) => state.markDocumentRead);
  const unmarkDocumentRead = useReaderStore((state) => state.unmarkDocumentRead);
  const coverSize = useReaderStore((state) => state.libraryCoverSize);
  const setLibraryCoverSize = useReaderStore((state) => state.setLibraryCoverSize);
  const scope = useReaderStore((state) => state.libraryBrowseScope);
  const setLibraryBrowseScope = useReaderStore((state) => state.setLibraryBrowseScope);
  const titleQuery = useReaderStore((state) => state.libraryTitleQuery);
  const setLibraryTitleQuery = useReaderStore((state) => state.setLibraryTitleQuery);
  const formatFilter = useReaderStore((state) => state.libraryFormatFilter);
  const setLibraryFormatFilter = useReaderStore((state) => state.setLibraryFormatFilter);
  const statusFilter = useReaderStore((state) => state.libraryStatusFilter);
  const setLibraryStatusFilter = useReaderStore((state) => state.setLibraryStatusFilter);
  const sortKey = useReaderStore((state) => state.librarySort);
  const setLibrarySort = useReaderStore((state) => state.setLibrarySort);
  const libraryScrollTop = useReaderStore((state) => state.libraryScrollTop);
  const setLibraryScrollTop = useReaderStore((state) => state.setLibraryScrollTop);

  const ordered = useMemo(
    () => flattenDocumentsInTreeOrder(buildLaidOutDocumentTree(documents, treeLayout)),
    [documents, treeLayout],
  );
  const rootPath = snapshot?.rootPath ?? null;
  const positions = useMemo(
    () => (rootPath ? listLibraryReadingPositions(rootPath) : {}),
    [rootPath, documents],
  );

  const [shelves, setShelves] = useState<CollectionSummary[]>([]);
  const [shelfItems, setShelfItems] = useState<CollectionItem[] | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [menu, setMenu] = useState<{
    item: LibraryBrowseItem;
    membership: Array<{ summary: CollectionSummary; member: boolean }>;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scopeKey =
    scope.kind === "folder"
      ? `folder:${scope.path}`
      : scope.kind === "shelf"
        ? `shelf:${scope.id}`
        : "all";

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = libraryScrollTop;
    // Restore once per mount or scope change; scrollTop in the store is zeroed
    // when the user picks a new folder/shelf.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, rootPath]);

  useEffect(() => {
    return () => {
      const node = scrollRef.current;
      if (node) useReaderStore.getState().setLibraryScrollTop(node.scrollTop);
    };
  }, []);

  const reloadShelves = useCallback(async () => {
    try {
      setShelves(await listCollections());
    } catch {
      setShelves([]);
    }
  }, []);

  useEffect(() => {
    void reloadShelves();
  }, [reloadShelves, refreshToken, rootPath]);

  useEffect(() => {
    if (scope.kind !== "shelf") {
      setShelfItems(null);
      return;
    }
    const id = scope.id;
    let cancelled = false;
    setShelfItems(null);
    void listCollectionItems(id).then(
      (items) => {
        if (!cancelled) setShelfItems(items);
      },
      () => {
        if (!cancelled) setShelfItems([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scope, refreshToken, rootPath]);

  useEffect(() => {
    if (scope.kind !== "shelf") return;
    if (shelves.some((shelf) => shelf.id === scope.id)) return;
    if (shelves.length === 0) return;
    setLibraryBrowseScope(ALL_LIBRARY_SCOPE);
  }, [scope, shelves, setLibraryBrowseScope]);

  const scoped = useMemo(
    () => collectScopedLibraryItems(ordered, scope, scope.kind === "shelf" ? shelfItems : null),
    [ordered, scope, shelfItems],
  );
  const visible = useMemo(
    () =>
      filterLibraryBrowseItems(scoped, {
        titleQuery,
        format: formatFilter,
        status: statusFilter,
        readMarks,
        positions,
        segmentCount: (path) => extents?.get(path)?.segmentCount,
      }),
    [scoped, titleQuery, formatFilter, statusFilter, readMarks, positions, extents],
  );
  const displayed = useMemo(
    () =>
      sortLibraryBrowseItems(visible, {
        sort: sortKey,
        positions,
        segmentCount: (path) => extents?.get(path)?.segmentCount,
      }),
    [visible, sortKey, positions, extents],
  );

  const shelfName =
    scope.kind === "shelf" ? (shelves.find((shelf) => shelf.id === scope.id)?.name ?? null) : null;
  const rangeTitle = libraryRangeTitle(
    scope,
    scope.kind === "folder" ? folderLabel(scope.path) : null,
    shelfName,
  );

  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const requestedRef = useRef(new Set<string>());
  const aliveRef = useRef(true);
  const libraryTokenRef = useRef({ rootPath, generation: 0 });
  if (libraryTokenRef.current.rootPath !== rootPath) {
    libraryTokenRef.current = { rootPath, generation: libraryTokenRef.current.generation + 1 };
    requestedRef.current = new Set();
  }
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    setCoverUrls({});
  }, [rootPath]);

  const applyThumbnail = (path: string, png: string, generation: number) => {
    if (!aliveRef.current || generation !== libraryTokenRef.current.generation) return;
    setCoverUrls((current) =>
      current[path] ? current : { ...current, [path]: `data:image/png;base64,${png}` },
    );
  };

  const loadCover = (document: DocumentInfo) => {
    if (APP_RUNTIME === "web") return;
    if (document.format !== "pdf" && document.format !== "epub") return;
    const path = document.relativePath;
    const generation = libraryTokenRef.current.generation;
    const isCurrent = () => aliveRef.current && generation === libraryTokenRef.current.generation;
    if (requestedRef.current.has(path)) return;
    requestedRef.current.add(path);
    void readDocumentThumbnail(path)
      .then((thumbnail) => {
        if (thumbnail) {
          applyThumbnail(path, thumbnail.png, generation);
          return;
        }
        if (document.format !== "pdf") return;
        enqueueCoverTask(async () => {
          if (!isCurrent()) return;
          try {
            const { capturePdfCoverThumbnail } = await import("../lib/coverCapture");
            if (!isCurrent()) return;
            const stored = await capturePdfCoverThumbnail(path, document.size, isCurrent);
            if (!stored || !isCurrent()) return;
            const refreshed = await readDocumentThumbnail(path);
            if (refreshed) applyThumbnail(path, refreshed.png, generation);
          } catch {
            if (isCurrent()) requestedRef.current.delete(path);
          }
        });
      })
      .catch(() => {
        if (isCurrent()) requestedRef.current.delete(path);
      });
  };

  useEffect(() => {
    const handler = (event: Event) => {
      const generation = libraryTokenRef.current.generation;
      const path = (event as CustomEvent<string>).detail;
      if (typeof path !== "string" || !path) return;
      requestedRef.current.delete(path);
      void readDocumentThumbnail(path)
        .then((thumbnail) => {
          if (thumbnail) applyThumbnail(path, thumbnail.png, generation);
        })
        .catch(() => undefined);
    };
    window.addEventListener(COVER_STORED_EVENT, handler);
    return () => window.removeEventListener(COVER_STORED_EVENT, handler);
  }, []);

  const saveScroll = () => {
    const node = scrollRef.current;
    if (node) setLibraryScrollTop(node.scrollTop);
  };

  const openDocument = (path: string, altKey: boolean) => {
    if (altKey && onOpenSecondary) {
      onOpenSecondary(path);
      return;
    }
    saveScroll();
    onBeforeSelect?.();
    void selectDocument(path);
  };

  const handleScopeChange = (value: string) => {
    if (!value) setLibraryBrowseScope(ALL_LIBRARY_SCOPE);
    else if (value.startsWith("folder:")) {
      setLibraryBrowseScope({ kind: "folder", path: value.slice("folder:".length) });
    } else setLibraryBrowseScope({ kind: "shelf", id: value });
  };

  const openMenu = async (item: LibraryBrowseItem) => {
    try {
      const summaries = shelves.length > 0 ? shelves : await listCollections();
      const membership = await Promise.all(
        summaries.map(async (summary) => {
          const items = await listCollectionItems(summary.id);
          return {
            summary,
            member: items.some((entry) => entry.relativePath === item.document.relativePath),
          };
        }),
      );
      setMenu({ item, membership });
    } catch (cause) {
      onNotice?.(cause instanceof Error ? cause.message : "书架读取失败");
    }
  };

  const toggleMembership = async (collectionId: string, relativePath: string, member: boolean) => {
    try {
      if (member) await removeCollectionItem(collectionId, relativePath);
      else await addCollectionItem(collectionId, relativePath);
      onCollectionsChanged?.();
      setMenu((current) => {
        if (!current) return current;
        return {
          ...current,
          membership: current.membership.map((entry) =>
            entry.summary.id === collectionId ? { ...entry, member: !member } : entry,
          ),
        };
      });
    } catch (cause) {
      onNotice?.(cause instanceof Error ? cause.message : member ? "移出书架失败" : "加入书架失败");
    }
  };

  const filtersActive = Boolean(titleQuery.trim() || formatFilter || statusFilter);
  const emptyMessage = loading
    ? "正在读取文档库…"
    : scoped.length === 0
      ? documents.length === 0
        ? "文档库为空。"
        : scope.kind === "folder"
          ? "此文件夹下没有文档"
          : scope.kind === "shelf"
            ? "这个书架还没有文档"
            : "没有符合条件的文档"
      : "没有符合条件的文档";

  return (
    <div
      className="library-browser"
      ref={scrollRef}
      style={{ ["--library-cover-size" as string]: `${coverSize}px` }}
    >
      <div className="library-toolbar">
        <select
          aria-label="书库范围"
          value={
            scope.kind === "folder"
              ? `folder:${scope.path}`
              : scope.kind === "shelf"
                ? scope.id
                : ""
          }
          onChange={(event) => handleScopeChange(event.target.value)}
        >
          <option value="">全部图书</option>
          {scope.kind === "folder" ? (
            <option value={`folder:${scope.path}`}>文件夹 · {scope.path.split("/").pop()}</option>
          ) : null}
          {shelves.length > 0 ? (
            <optgroup label="我的书架">
              {shelves.map((shelf) => (
                <option key={shelf.id} value={shelf.id}>
                  {shelf.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <input
          type="search"
          value={titleQuery}
          placeholder="搜索书名…"
          aria-label="搜索书名"
          onChange={(event) => setLibraryTitleQuery(event.target.value)}
        />
        <select
          aria-label="格式"
          value={formatFilter}
          onChange={(event) => setLibraryFormatFilter(event.target.value as DocumentFormat | "")}
        >
          <option value="">全部格式</option>
          <option value="pdf">PDF</option>
          <option value="epub">EPUB</option>
          <option value="markdown">MD</option>
          <option value="mdx">MDX</option>
        </select>
        <select
          aria-label="阅读状态"
          value={statusFilter}
          onChange={(event) => setLibraryStatusFilter(event.target.value as typeof statusFilter)}
        >
          <option value="">全部状态</option>
          <option value="new">未开始</option>
          <option value="reading">阅读中</option>
          <option value="read">已读</option>
        </select>
        <select
          aria-label="排序"
          value={sortKey}
          onChange={(event) => setLibrarySort(event.target.value as typeof sortKey)}
        >
          <option value="recent">最近阅读</option>
          <option value="title">标题顺序</option>
          <option value="progress">阅读进度</option>
        </select>
      </div>

      <div className="library-range">
        <h1>{rangeTitle}</h1>
        {scope.kind !== "all" ? (
          <button
            type="button"
            className="library-quiet"
            onClick={() => setLibraryBrowseScope(ALL_LIBRARY_SCOPE)}
          >
            返回全部
          </button>
        ) : null}
        <button
          type="button"
          className="library-quiet"
          style={{ marginLeft: "auto" }}
          onClick={() => setManageOpen(true)}
        >
          管理书架
        </button>
      </div>

      <div className="library-subtools">
        <span aria-live="polite">{libraryCountLabel(displayed.length, documents.length)}</span>
        <label className="library-size">
          封面大小
          <input
            aria-label="封面大小"
            type="range"
            min={LIBRARY_COVER_SIZE_MIN}
            max={LIBRARY_COVER_SIZE_MAX}
            value={coverSize}
            onChange={(event) => setLibraryCoverSize(Number(event.target.value))}
          />
        </label>
      </div>

      {displayed.length > 0 ? (
        <section className="library-grid" aria-label="书籍封面">
          {displayed.map((item) => (
            <ShelfCard
              key={item.document.relativePath}
              item={item}
              position={positions[item.document.relativePath]}
              extent={extents?.get(item.document.relativePath)}
              coverUrl={coverUrls[item.document.relativePath]}
              isCurrent={item.present && item.document.relativePath === currentPath}
              markedRead={isMarkedRead(readMarks, item.document.relativePath)}
              onVisible={loadCover}
              onOpen={openDocument}
              onMenu={openMenu}
              onNotice={onNotice}
            />
          ))}
        </section>
      ) : (
        <div className="library-empty" role="status">
          <p>{emptyMessage}</p>
          {filtersActive && documents.length > 0 ? (
            <button
              type="button"
              className="library-quiet"
              onClick={() => {
                setLibraryTitleQuery("");
                setLibraryFormatFilter("");
                setLibraryStatusFilter("");
              }}
            >
              清除搜索与筛选
            </button>
          ) : null}
        </div>
      )}

      {manageOpen && rootPath ? (
        <ShelvesManagerPanel
          rootPath={rootPath}
          documents={documents}
          refreshToken={refreshToken}
          onNotice={onNotice ?? (() => undefined)}
          onChanged={() => {
            void reloadShelves();
            onCollectionsChanged?.();
          }}
          onClose={() => setManageOpen(false)}
          onSelectDocument={(path) => {
            setManageOpen(false);
            openDocument(path, false);
          }}
          onDeleted={(id) => {
            if (scope.kind === "shelf" && scope.id === id) {
              setLibraryBrowseScope(ALL_LIBRARY_SCOPE);
            }
          }}
        />
      ) : null}

      {menu ? (
        <div
          className="library-menu"
          role="dialog"
          aria-label={`管理 ${documentTreeName(menu.item.document)}`}
        >
          <div className="settings-heading">
            <span>{documentTreeName(menu.item.document)}</span>
            <button type="button" className="icon-button" aria-label="关闭" onClick={() => setMenu(null)}>
              ×
            </button>
          </div>
          {isMarkedRead(readMarks, menu.item.document.relativePath) ? (
            <button
              type="button"
              onClick={() => {
                unmarkDocumentRead(menu.item.document.relativePath);
                onNotice?.("已取消已读标记");
              }}
            >
              取消已读标记
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                markDocumentRead(menu.item.document.relativePath);
                onNotice?.("已标记为已读，阅读位置保持不变");
              }}
            >
              标记为已读
            </button>
          )}
          <p className="shelves-panel__hint">加入书架</p>
          {menu.membership.length === 0 ? (
            <p className="collections-empty">还没有书架。请先打开「管理书架」。</p>
          ) : (
            menu.membership.map((entry) => (
              <label key={entry.summary.id}>
                <input
                  type="checkbox"
                  checked={entry.member}
                  onChange={() =>
                    void toggleMembership(
                      entry.summary.id,
                      menu.item.document.relativePath,
                      entry.member,
                    )
                  }
                />{" "}
                {entry.summary.name}
              </label>
            ))
          )}
          <button type="button" onClick={() => setMenu(null)}>
            完成
          </button>
        </div>
      ) : null}
    </div>
  );
}
