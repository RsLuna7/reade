/**
 * 我的书架 UI。存储与 IPC 仍是 collections 表；面向用户的名称已迁到书架。
 *
 * - `ShelvesManagerPanel` — 书库页「管理书架」：新建/重命名/删除、成员
 *   上下移（CO-D4）与失联灰显（CO-D3）。删除书架不删文档。
 * - `CollectionMembershipPopover` — 阅读顶栏「加入书架」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { OverflowMarquee, armOverflowMarquee, disarmOverflowMarquee } from "./OverflowMarquee";
import {
  addCollectionItem,
  createCollection,
  deleteCollection,
  listCollectionItems,
  listCollections,
  removeCollectionItem,
  renameCollection,
  reorderCollectionItems,
  type CollectionItem,
  type CollectionSummary,
  type DocumentInfo,
} from "../lib/backend";
import { progressFromPosition } from "../lib/homeData";
import {
  listLibraryReadingPositions,
  type ReadingPosition,
} from "../lib/readingPositions";

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function fallbackFormatBadge(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : "?";
  return ext === "MARKDOWN" ? "MD" : ext;
}

/** "62%"(scroll); PDF 页码不在合集清单展示。无记录返回 null(徽标不渲染)。 */
export function collectionProgressLabel(
  position: ReadingPosition | undefined | null,
): string | null {
  const progress = progressFromPosition(position);
  if (progress?.kind !== "ratio") return null;
  const percent = Math.round(progress.value * 100);
  return percent > 0 ? `${percent}%` : null;
}

type CollectionsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; collections: CollectionSummary[] };

type ItemsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: CollectionItem[] };

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export interface ShelvesManagerPanelProps {
  /** 当前库根;进度徽标从 readingPositions 读取。 */
  rootPath: string;
  /** 库扫描快照:标题/格式映射与失联判定的数据源。 */
  documents: DocumentInfo[];
  /** App 在 popover 写操作后递增;已加载时随之静默重拉。 */
  refreshToken: number;
  onNotice: (message: string) => void;
  onChanged: () => void;
  onClose: () => void;
  onSelectDocument?: (relativePath: string) => void;
  onDeleted?: (collectionId: string) => void;
}

export function ShelvesManagerPanel({
  rootPath,
  documents,
  refreshToken,
  onNotice,
  onChanged,
  onClose,
  onSelectDocument,
  onDeleted,
}: ShelvesManagerPanelProps) {
  const [state, setState] = useState<CollectionsState>({ status: "idle" });
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const [itemsById, setItemsById] = useState<Record<string, ItemsState>>({});
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [positions, setPositions] = useState<Record<string, ReadingPosition>>({});
  const loadedOnce = useRef(false);

  const documentInfoByPath = useMemo(
    () => new Map(documents.map((document) => [document.relativePath, document])),
    [documents],
  );

  const reloadCollections = useCallback(async () => {
    setState((current) =>
      current.status === "ready" ? current : { status: "loading" },
    );
    try {
      const collections = await listCollections();
      loadedOnce.current = true;
      setState({ status: "ready", collections });
    } catch (cause) {
      setState({ status: "error", message: errorText(cause, "书架读取失败") });
    }
  }, []);

  const reloadItems = useCallback(async (collectionId: string) => {
    setItemsById((current) => ({
      ...current,
      [collectionId]: current[collectionId] ?? { status: "loading" },
    }));
    try {
      const items = await listCollectionItems(collectionId);
      setItemsById((current) => ({
        ...current,
        [collectionId]: { status: "ready", items },
      }));
    } catch (cause) {
      setItemsById((current) => ({
        ...current,
        [collectionId]: { status: "error", message: errorText(cause, "清单读取失败") },
      }));
    }
  }, []);

  const refreshPositions = useCallback(() => {
    setPositions(listLibraryReadingPositions(rootPath));
  }, [rootPath]);

  // 打开面板即加载;进度徽标同时刷新。
  useEffect(() => {
    if (state.status !== "idle") return;
    refreshPositions();
    void reloadCollections();
  }, [refreshPositions, reloadCollections, state.status]);

  // popover 写操作 → App 递增 refreshToken → 已加载时静默重拉。
  useEffect(() => {
    if (refreshToken === 0 || !loadedOnce.current) return;
    void reloadCollections();
    setItemsById((current) => {
      for (const id of Object.keys(current)) void reloadItems(id);
      return current;
    });
  }, [refreshToken, reloadCollections, reloadItems]);

  const toggleOpen = (collectionId: string) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(collectionId)) {
        next.delete(collectionId);
      } else {
        next.add(collectionId);
        if (!itemsById[collectionId]) {
          setItemsById((states) => ({
            ...states,
            [collectionId]: { status: "loading" },
          }));
          refreshPositions();
          void reloadItems(collectionId);
        }
      }
      return next;
    });
    setRenamingId(null);
  };

  const handleCreate = async () => {
    const name = draftName.trim();
    if (!name) return;
    if (
      state.status === "ready" &&
      state.collections.some((collection) => collection.name === name)
    ) {
      onNotice(`已存在同名书架「${name}」，已再建一个。`);
    }
    try {
      await createCollection(crypto.randomUUID(), name);
      setDraftName("");
      setCreating(false);
      await reloadCollections();
      onChanged();
    } catch (cause) {
      onNotice(errorText(cause, "新建书架失败"));
    }
  };

  const handleRename = async (collection: CollectionSummary) => {
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!name || name === collection.name) return;
    try {
      await renameCollection(collection.id, name);
      await reloadCollections();
      onChanged();
    } catch (cause) {
      onNotice(errorText(cause, "重命名失败"));
    }
  };

  const handleDelete = async (collection: CollectionSummary) => {
    const confirmed = window.confirm(
      `删除书架「${collection.name}」？清单内 ${collection.itemCount} 篇文档本身不会被删除。`,
    );
    if (!confirmed) return;
    try {
      await deleteCollection(collection.id);
      setOpenIds((current) => {
        const next = new Set(current);
        next.delete(collection.id);
        return next;
      });
      setItemsById((current) => {
        const next = { ...current };
        delete next[collection.id];
        return next;
      });
      await reloadCollections();
      onDeleted?.(collection.id);
      onChanged();
      onNotice(`已删除书架「${collection.name}」，文档未受影响。`);
    } catch (cause) {
      onNotice(errorText(cause, "删除书架失败"));
    }
  };

  const handleRemoveItem = async (collectionId: string, relativePath: string) => {
    try {
      await removeCollectionItem(collectionId, relativePath);
      await Promise.all([reloadItems(collectionId), reloadCollections()]);
      onChanged();
    } catch (cause) {
      onNotice(errorText(cause, "移出书架失败"));
    }
  };

  /** 上移/下移:整序提交(CO-D4);乐观更新,失败重拉恢复。 */
  const handleMoveItem = async (
    collectionId: string,
    items: CollectionItem[],
    index: number,
    delta: -1 | 1,
  ) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const reordered = [...items];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    setItemsById((current) => ({
      ...current,
      [collectionId]: {
        status: "ready",
        items: reordered.map((item, position) => ({ ...item, position })),
      },
    }));
    try {
      await reorderCollectionItems(
        collectionId,
        reordered.map((item) => item.relativePath),
      );
      onChanged();
    } catch (cause) {
      onNotice(errorText(cause, "调整顺序失败"));
      void reloadItems(collectionId);
    }
  };

  const collectionCount = state.status === "ready" ? state.collections.length : null;

  return (
    <section className="shelves-panel reade-motion-panel" aria-label="我的书架">
      <div className="settings-heading">
        <span>我的书架</span>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label="关闭书架管理"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <p className="shelves-panel__hint">书架保存文档引用，不会移动或删除原文件。</p>
      <div className="collections-header">
        <span className="shelves-panel__count">
          {collectionCount !== null ? `${collectionCount} 个书架` : "我的书架"}
        </span>
        <button
          type="button"
          className="icon-button collections-create"
          aria-label="新建书架"
          title="新建书架"
          onClick={() => setCreating(true)}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>

      {creating && (
        <div className="collections-create-row">
          <input
            type="text"
            value={draftName}
            autoFocus
            placeholder="例如：这个月想读"
            aria-label="书架名称"
            maxLength={100}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleCreate();
              if (event.key === "Escape") {
                event.stopPropagation();
                setCreating(false);
                setDraftName("");
              }
            }}
          />
          <button type="button" onClick={() => void handleCreate()}>
            创建
          </button>
        </div>
      )}

      {state.status === "loading" && (
        <p className="collections-empty" role="status">
          正在读取书架…
        </p>
      )}
      {state.status === "error" && (
        <p className="collections-empty" role="status">
          {state.message}
        </p>
      )}
      {state.status === "ready" && state.collections.length === 0 && !creating && (
        <p className="collections-empty">还没有书架。点「+」新建一个跨文件夹的阅读清单。</p>
      )}

      {state.status === "ready" && state.collections.length > 0 && (
        <ul className="collections-list">
          {state.collections.map((collection) => {
            const open = openIds.has(collection.id);
            const itemsState = itemsById[collection.id];
            return (
              <li key={collection.id} className="collection-block">
                <div className="collection-row">
                  <button
                    type="button"
                    className="collection-name"
                    aria-expanded={open}
                    onClick={() => toggleOpen(collection.id)}
                  >
                    {open ? (
                      <ChevronDown size={12} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={12} aria-hidden="true" />
                    )}
                    <span className="collection-title">{collection.name}</span>
                    <span
                      className="collection-health"
                      title={`${collection.presentCount} 篇在库 / 共 ${collection.itemCount} 篇`}
                    >
                      {collection.presentCount}/{collection.itemCount}
                    </span>
                  </button>
                </div>

                {open && renamingId === collection.id && (
                  <div className="collections-create-row">
                    <input
                      type="text"
                      value={renameDraft}
                      autoFocus
                      aria-label="书架新名称"
                      maxLength={100}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void handleRename(collection);
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          setRenamingId(null);
                        }
                      }}
                    />
                    <button type="button" onClick={() => void handleRename(collection)}>
                      确定
                    </button>
                  </div>
                )}

                {open && renamingId !== collection.id && (
                  <div className="collection-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(collection.id);
                        setRenameDraft(collection.name);
                      }}
                    >
                      重命名
                    </button>
                    <button type="button" onClick={() => void handleDelete(collection)}>
                      删除
                    </button>
                  </div>
                )}

                {open && (!itemsState || itemsState.status === "loading") && (
                  <p className="collections-empty" role="status">
                    正在读取清单…
                  </p>
                )}
                {open && itemsState?.status === "error" && (
                  <p className="collections-empty" role="status">
                    {itemsState.message}
                  </p>
                )}
                {open && itemsState?.status === "ready" && itemsState.items.length === 0 && (
                  <p className="collections-empty">
                    清单为空。打开文档后用顶部「加入书架」收录。
                  </p>
                )}
                {open && itemsState?.status === "ready" && itemsState.items.length > 0 && (
                  <ol className="collection-items">
                    {itemsState.items.map((item, index) => {
                      const info = documentInfoByPath.get(item.relativePath);
                      const missing = !item.present;
                      const title = info?.title ?? fileName(item.relativePath);
                      const badge = info
                        ? info.format === "markdown"
                          ? "MD"
                          : info.format.toUpperCase()
                        : fallbackFormatBadge(item.relativePath);
                      const progress = collectionProgressLabel(
                        positions[item.relativePath],
                      );
                      return (
                        <li
                          key={item.relativePath}
                          className={`collection-item${missing ? " collection-item--missing" : ""}`}
                        >
                          <button
                            type="button"
                            className="collection-item-main"
                            disabled={missing}
                            title={
                              missing
                                ? `${item.relativePath}（文档已移动或删除）`
                                : item.relativePath
                            }
                            onMouseEnter={(event) => armOverflowMarquee(event.currentTarget)}
                            onMouseLeave={(event) => disarmOverflowMarquee(event.currentTarget)}
                            onClick={() => onSelectDocument?.(item.relativePath)}
                          >
                            <span
                              className={`document-tree__format${info ? ` document-tree__format--${info.format}` : ""}`}
                              aria-hidden="true"
                            >
                              {badge}
                            </span>
                            <OverflowMarquee className="collection-item-title">{title}</OverflowMarquee>
                            {progress && !missing ? (
                              <span className="collection-item-progress">{progress}</span>
                            ) : null}
                          </button>
                          <span className="collection-item-actions">
                            <button
                              type="button"
                              aria-label={`上移 ${title}`}
                              disabled={index === 0}
                              onClick={() =>
                                void handleMoveItem(collection.id, itemsState.items, index, -1)
                              }
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              aria-label={`下移 ${title}`}
                              disabled={index === itemsState.items.length - 1}
                              onClick={() =>
                                void handleMoveItem(collection.id, itemsState.items, index, 1)
                              }
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              aria-label={`把 ${title} 移出书架`}
                              onClick={() =>
                                void handleRemoveItem(collection.id, item.relativePath)
                              }
                            >
                              <X size={11} aria-hidden="true" />
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Topbar membership popover (CO-D2)
// ---------------------------------------------------------------------------

interface MembershipEntry {
  summary: CollectionSummary;
  member: boolean;
}

type MembershipState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: MembershipEntry[] };

export interface CollectionMembershipPopoverProps {
  currentPath: string;
  onClose: () => void;
  /** 任一写操作成功后触发,让书库页重拉书架。 */
  onChanged: () => void;
  onNotice: (message: string) => void;
}

export function CollectionMembershipPopover({
  currentPath,
  onClose,
  onChanged,
  onNotice,
}: CollectionMembershipPopoverProps) {
  const [state, setState] = useState<MembershipState>({ status: "loading" });
  const [draftName, setDraftName] = useState("");
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const collections = await listCollections();
      const entries = await Promise.all(
        collections.map(async (summary) => {
          const items = await listCollectionItems(summary.id);
          return {
            summary,
            member: items.some((item) => item.relativePath === currentPath),
          };
        }),
      );
      setState({ status: "ready", entries });
    } catch (cause) {
      setState({ status: "error", message: errorText(cause, "书架读取失败") });
    }
  }, [currentPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const setBusy = (id: string, busy: boolean) => {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleToggle = async (entry: MembershipEntry) => {
    const { summary, member } = entry;
    setBusy(summary.id, true);
    try {
      if (member) {
        await removeCollectionItem(summary.id, currentPath);
      } else {
        await addCollectionItem(summary.id, currentPath);
      }
      setState((current) => {
        if (current.status !== "ready") return current;
        return {
          status: "ready",
          entries: current.entries.map((candidate) =>
            candidate.summary.id === summary.id
              ? {
                  summary: {
                    ...candidate.summary,
                    itemCount: candidate.summary.itemCount + (member ? -1 : 1),
                    presentCount: candidate.summary.presentCount + (member ? -1 : 1),
                  },
                  member: !member,
                }
              : candidate,
          ),
        };
      });
      onChanged();
    } catch (cause) {
      onNotice(errorText(cause, member ? "移出书架失败" : "加入书架失败"));
    } finally {
      setBusy(summary.id, false);
    }
  };

  const handleCreateAndAdd = async () => {
    const name = draftName.trim();
    if (!name) return;
    try {
      const collection = await createCollection(crypto.randomUUID(), name);
      await addCollectionItem(collection.id, currentPath);
      setDraftName("");
      await load();
      onChanged();
      onNotice(`已加入新书架「${name}」`);
    } catch (cause) {
      onNotice(errorText(cause, "新建书架失败"));
    }
  };

  return (
    <div
      className="collections-popover reade-motion-panel"
      role="dialog"
      aria-label="加入书架"
    >
      <div className="settings-heading">
        <span>加入书架</span>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label="关闭加入书架"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      {state.status === "loading" && (
        <p className="collections-empty" role="status">
          正在读取书架…
        </p>
      )}
      {state.status === "error" && (
        <p className="collections-empty" role="alert">
          {state.message}
        </p>
      )}
      {state.status === "ready" && (
        <>
          {state.entries.length === 0 ? (
            <p className="collections-empty">还没有书架，在下方直接新建并加入。</p>
          ) : (
            <ul className="collections-membership">
              {state.entries.map((entry) => (
                <li key={entry.summary.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={entry.member}
                      disabled={busyIds.has(entry.summary.id)}
                      onChange={() => void handleToggle(entry)}
                    />
                    <span className="collection-title">{entry.summary.name}</span>
                    <span className="collection-health">
                      {entry.summary.itemCount} 篇
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="collections-create-row">
            <input
              type="text"
              value={draftName}
              placeholder="新建书架并加入"
              aria-label="新建书架并加入"
              maxLength={100}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleCreateAndAdd();
              }}
            />
            <button type="button" onClick={() => void handleCreateAndAdd()}>
              新建并加入
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default ShelvesManagerPanel;
