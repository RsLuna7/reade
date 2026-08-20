import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { buildDocumentTree, findChildNodes, parentDirectoryPath, type DocumentTreeNode } from "../lib/tree";
import {
  TREE_LAYOUT_ROOT,
  applyFolderLayout,
  folderHasCustomLayout,
  isPinnedInLayout,
  layoutNodeKey,
} from "../lib/treeLayout";
import type { TreeEstimateBadge } from "../lib/readingTimeEstimate";
import { cancelMotion, runMotion } from "../lib/motion";
import { useReaderStore } from "../store/useReaderStore";
import { OverflowMarquee, armOverflowMarquee, disarmOverflowMarquee } from "./OverflowMarquee";
import { DocumentTreeMenu } from "./DocumentTreeMenu";

interface VisibleTreeItem {
  node: DocumentTreeNode;
  parentPath: string | null;
}

interface TreeMenuState {
  x: number;
  y: number;
  parentPath: string;
  nodeKey: string;
  pinned: boolean;
}

interface DragState {
  parentPath: string;
  nodeKey: string;
  segment: "pinned" | "unpinned";
  dropIndex: number | null;
}

const DRAG_THRESHOLD_PX = 4;

function collectVisibleItems(
  nodes: DocumentTreeNode[],
  expanded: Set<string>,
  parentPath: string | null = null,
): VisibleTreeItem[] {
  const items: VisibleTreeItem[] = [];

  for (const node of nodes) {
    items.push({ node, parentPath });
    if (node.kind === "directory" && expanded.has(node.path)) {
      items.push(...collectVisibleItems(node.children, expanded, node.path));
    }
  }

  return items;
}

function layoutParentOf(item: VisibleTreeItem): string {
  return item.parentPath ?? TREE_LAYOUT_ROOT;
}

function computeDropIndex(
  clientX: number,
  clientY: number,
  dragKey: string,
  parentPath: string,
  segment: string,
): number | null {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit) return null;
  const node = hit.closest<HTMLElement>("[data-tree-key]");
  if (!node) return null;
  if (node.dataset.treeParent !== parentPath) return null;
  if (node.dataset.treeSegment !== segment) return null;
  const list = node.parentElement;
  if (!list) return null;
  const items = [...list.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.dataset.treeSegment === segment &&
      child.dataset.treeKey !== dragKey,
  );
  const overKey = node.dataset.treeKey;
  if (!overKey || overKey === dragKey) return null;
  const index = items.findIndex((item) => item.dataset.treeKey === overKey);
  if (index < 0) return null;
  const rect = node.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? index : index + 1;
}

function segmentItems(
  nodes: DocumentTreeNode[],
  parentPath: string,
  layout: Parameters<typeof isPinnedInLayout>[0],
  pinned: boolean,
  excludeKey?: string,
): DocumentTreeNode[] {
  return nodes.filter((node) => {
    const key = layoutNodeKey(node);
    if (excludeKey && key === excludeKey) return false;
    return isPinnedInLayout(layout, parentPath, key) === pinned;
  });
}

export interface DocumentTreeProps {
  /**
   * Alt+点击文档/搜索结果 → 在右侧副栏打开(plan-split-view SP-D4)。
   * 未传入时行为与传统单栏完全一致。
   */
  onOpenSecondary?: (path: string) => void;
  /**
   * 打开文档前的回调(plan-nav-history):App 借此在跳转发生前记录
   * 阅读回退栈的出发点。仅主栏切换文档时调用,Alt+副栏打开不算跳转。
   */
  onBeforeSelect?: () => void;
  /**
   * 阅读时间预估(plan-reading-time-estimate §3.3):返回时长或
   * 「扫描版/无法估计」同级标签,null 不渲染;数据装配留在 App。
   */
  estimateForPath?: (path: string) => TreeEstimateBadge | null;
}

export function DocumentTree({
  onOpenSecondary,
  onBeforeSelect,
  estimateForPath,
}: DocumentTreeProps = {}) {
  const documents = useReaderStore((state) => state.documents);
  const currentPath = useReaderStore((state) => state.currentPath);
  const searchQuery = useReaderStore((state) => state.searchQuery);
  const searchResults = useReaderStore((state) => state.searchResults);
  const loading = useReaderStore((state) => state.loading);
  const motionLevel = useReaderStore((state) => state.motionLevel);
  const expandedPaths = useReaderStore((state) => state.expandedPaths);
  const treeLayout = useReaderStore((state) => state.treeLayout);
  const toggleDirectory = useReaderStore((state) => state.toggleDirectory);
  const selectDocument = useReaderStore((state) => state.selectDocument);
  const pinTreeNode = useReaderStore((state) => state.pinTreeNode);
  const unpinTreeNode = useReaderStore((state) => state.unpinTreeNode);
  const moveTreeNode = useReaderStore((state) => state.moveTreeNode);
  const resetFolderTreeLayout = useReaderStore((state) => state.resetFolderTreeLayout);

  const tree = useMemo(
    () => applyFolderLayout(buildDocumentTree(documents), treeLayout),
    [documents, treeLayout],
  );
  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const visibleItems = useMemo(
    () => collectVisibleItems(tree, expanded),
    [tree, expanded],
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<TreeMenuState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchResultsRef = useRef<HTMLUListElement>(null);
  const pendingDrag = useRef<{
    parentPath: string;
    nodeKey: string;
    segment: "pinned" | "unpinned";
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const inSearchMode = searchQuery.trim().length > 0;
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  useEffect(() => {
    const element = searchResultsRef.current;
    if (!inSearchMode || !element || searchResults.length === 0) return;
    runMotion(
      element,
      "search-results",
      motionLevel === "full"
        ? [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }]
        : [{ opacity: 0 }, { opacity: 1 }],
      {
        duration: motionLevel === "full" ? 220 : 180,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
      motionLevel,
    );
    return () => cancelMotion(element, "search-results");
  }, [inSearchMode, motionLevel, searchResults]);

  useEffect(() => {
    if (visibleItems.length === 0) {
      setFocusedId(null);
      return;
    }

    if (!focusedId || !visibleItems.some(({ node }) => node.id === focusedId)) {
      const current = visibleItems.find(
        ({ node }) => node.kind === "document" && node.path === currentPath,
      );
      setFocusedId(current?.node.id ?? visibleItems[0].node.id);
    }
  }, [currentPath, focusedId, visibleItems]);

  const focusItem = (id: string) => {
    setFocusedId(id);
    requestAnimationFrame(() => itemRefs.current.get(id)?.focus());
  };

  const openMenuForItem = (item: VisibleTreeItem, x: number, y: number) => {
    const parentPath = layoutParentOf(item);
    const nodeKey = layoutNodeKey(item.node);
    setMenu({
      x,
      y,
      parentPath,
      nodeKey,
      pinned: isPinnedInLayout(treeLayout, parentPath, nodeKey),
    });
  };

  const finishDrag = () => {
    const state = dragRef.current;
    pendingDrag.current = null;
    dragRef.current = null;
    setDrag(null);
    if (!state) return;
    suppressClick.current = true;
    if (state.dropIndex === null) return;
    moveTreeNode(state.parentPath, state.nodeKey, state.dropIndex);
  };

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLSpanElement>, item: VisibleTreeItem) => {
    if (event.button !== 0) return;
    const parentPath = layoutParentOf(item);
    const nodeKey = layoutNodeKey(item.node);
    pendingDrag.current = {
      parentPath,
      nodeKey,
      segment: isPinnedInLayout(treeLayout, parentPath, nodeKey) ? "pinned" : "unpinned",
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onHandlePointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const pending = pendingDrag.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    const dx = event.clientX - pending.x;
    const dy = event.clientY - pending.y;
    const active = dragRef.current;
    if (!active) {
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      const next: DragState = {
        parentPath: pending.parentPath,
        nodeKey: pending.nodeKey,
        segment: pending.segment,
        dropIndex: null,
      };
      dragRef.current = next;
      setDrag(next);
    }
    event.preventDefault();
    const dropIndex = computeDropIndex(
      event.clientX,
      event.clientY,
      pending.nodeKey,
      pending.parentPath,
      pending.segment,
    );
    if (dropIndex === null) return;
    const current = dragRef.current;
    if (current && current.dropIndex === dropIndex) return;
    const next: DragState = { ...(current ?? pending), dropIndex };
    dragRef.current = next;
    setDrag(next);
  };

  const onHandlePointerUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (pendingDrag.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishDrag();
  };

  const moveFocusedInSegment = (item: VisibleTreeItem, direction: -1 | 1) => {
    const parentPath = layoutParentOf(item);
    const nodeKey = layoutNodeKey(item.node);
    const pinned = isPinnedInLayout(treeLayout, parentPath, nodeKey);
    const siblings = findChildNodes(tree, parentPath) ?? [];
    const segment = siblings.filter(
      (node) => isPinnedInLayout(treeLayout, parentPath, layoutNodeKey(node)) === pinned,
    );
    const index = segment.findIndex((node) => layoutNodeKey(node) === nodeKey);
    if (index < 0) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= segment.length) return;
    moveTreeNode(parentPath, nodeKey, nextIndex);
  };

  const handleTreeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    item: VisibleTreeItem,
  ) => {
    const index = visibleItems.findIndex(({ node }) => node.id === item.node.id);
    if (index < 0) return;

    const focusAt = (nextIndex: number) => {
      const next = visibleItems[nextIndex];
      if (next) focusItem(next.node.id);
    };

    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      moveFocusedInSegment(item, event.key === "ArrowUp" ? -1 : 1);
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(Math.min(index + 1, visibleItems.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(Math.max(index - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(visibleItems.length - 1);
        break;
      case "ArrowRight":
        if (item.node.kind !== "directory") break;
        event.preventDefault();
        if (!expanded.has(item.node.path)) {
          toggleDirectory(item.node.path);
        } else {
          focusAt(index + 1);
        }
        break;
      case "ArrowLeft": {
        event.preventDefault();
        if (item.node.kind === "directory" && expanded.has(item.node.path)) {
          toggleDirectory(item.node.path);
          break;
        }
        const parentPath =
          item.parentPath ??
          (item.node.kind === "document" ? parentDirectoryPath(item.node.path) : null);
        const parent = visibleItems.find(
          ({ node }) => node.kind === "directory" && node.path === parentPath,
        );
        if (parent) focusItem(parent.node.id);
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        if (item.node.kind === "directory") toggleDirectory(item.node.path);
        else if (event.altKey && onOpenSecondary) onOpenSecondary(item.node.path);
        else {
          onBeforeSelect?.();
          void selectDocument(item.node.path);
        }
        break;
      case "ContextMenu": {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        openMenuForItem(item, rect.left, rect.bottom);
        break;
      }
      case "F10": {
        if (!event.shiftKey) break;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        openMenuForItem(item, rect.left, rect.bottom);
        break;
      }
    }
  };

  const renderNodes = (
    nodes: DocumentTreeNode[],
    parentPath: string | null = null,
  ) => {
    const layoutParent = parentPath ?? TREE_LAYOUT_ROOT;
    const pinnedKeys = nodes
      .filter((node) => isPinnedInLayout(treeLayout, layoutParent, layoutNodeKey(node)))
      .map(layoutNodeKey);
    const lastPinnedKey = pinnedKeys[pinnedKeys.length - 1];
    const showPinRule = pinnedKeys.length > 0 && pinnedKeys.length < nodes.length;
    return (
    <ul className="document-tree__group" role={parentPath ? "group" : "tree"}>
      {nodes.map((node) => {
        const isDirectory = node.kind === "directory";
        const isExpanded = isDirectory && expanded.has(node.path);
        const isCurrent = !isDirectory && node.path === currentPath;
        const estimate = !isDirectory && estimateForPath ? estimateForPath(node.path) : null;
        const item: VisibleTreeItem = { node, parentPath };
        const nodeKey = layoutNodeKey(node);
        const pinned = isPinnedInLayout(treeLayout, layoutParent, nodeKey);
        const segment = pinned ? "pinned" : "unpinned";
        const dragging = drag?.nodeKey === nodeKey && drag.parentPath === layoutParent;
        const others = drag
          ? segmentItems(nodes, layoutParent, treeLayout, pinned, drag.nodeKey)
          : [];
        const dropBefore = Boolean(
          drag &&
            drag.parentPath === layoutParent &&
            drag.segment === segment &&
            drag.dropIndex !== null &&
            others[drag.dropIndex] &&
            layoutNodeKey(others[drag.dropIndex]) === nodeKey,
        );
        const dropAfter = Boolean(
          drag &&
            drag.parentPath === layoutParent &&
            drag.segment === segment &&
            drag.dropIndex === others.length &&
            others.length > 0 &&
            layoutNodeKey(others[others.length - 1]) === nodeKey,
        );

        return (
          <li
            className={[
              `document-tree__node document-tree__node--${node.kind}`,
              dropBefore ? "document-tree__node--drop-before" : "",
              dropAfter ? "document-tree__node--drop-after" : "",
              showPinRule && nodeKey === lastPinnedKey ? "document-tree__node--pin-end" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={node.id}
            role="treeitem"
            aria-expanded={isDirectory ? isExpanded : undefined}
            aria-selected={isDirectory ? undefined : isCurrent}
            data-tree-parent={layoutParent}
            data-tree-key={nodeKey}
            data-tree-segment={segment}
          >
            <button
              className={[
                "document-tree__item",
                isCurrent ? "document-tree__item--current" : "",
                dragging ? "document-tree__item--dragging" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              type="button"
              tabIndex={focusedId === node.id ? 0 : -1}
              title={
                !isDirectory && onOpenSecondary ? "Alt+点击在右侧分栏打开" : undefined
              }
              ref={(element) => {
                if (element) itemRefs.current.set(node.id, element);
                else itemRefs.current.delete(node.id);
              }}
              onFocus={() => setFocusedId(node.id)}
              onMouseEnter={(event) => armOverflowMarquee(event.currentTarget)}
              onMouseLeave={(event) => disarmOverflowMarquee(event.currentTarget)}
              onKeyDown={(event) => handleTreeKeyDown(event, item)}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenuForItem(item, event.clientX, event.clientY);
              }}
              onClick={(event) => {
                if (suppressClick.current) {
                  event.preventDefault();
                  suppressClick.current = false;
                  return;
                }
                if (isDirectory) toggleDirectory(node.path);
                else if (event.altKey && onOpenSecondary) onOpenSecondary(node.path);
                else {
                  onBeforeSelect?.();
                  void selectDocument(node.path);
                }
              }}
            >
              {isDirectory ? (
                <span
                  className="document-tree__handle document-tree__chevron"
                  aria-hidden="true"
                  title="拖动排序"
                  onPointerDown={(event) => onHandlePointerDown(event, item)}
                  onPointerMove={onHandlePointerMove}
                  onPointerUp={onHandlePointerUp}
                  onPointerCancel={onHandlePointerUp}
                >
                  {isExpanded ? "−" : "+"}
                </span>
              ) : (
                <span
                  className={`document-tree__handle document-tree__format document-tree__format--${node.document.format}`}
                  aria-hidden="true"
                  title="拖动排序"
                  onPointerDown={(event) => onHandlePointerDown(event, item)}
                  onPointerMove={onHandlePointerMove}
                  onPointerUp={onHandlePointerUp}
                  onPointerCancel={onHandlePointerUp}
                >
                  {node.document.format === "markdown" ? "MD" : node.document.format.toUpperCase()}
                </span>
              )}
              <OverflowMarquee className="document-tree__name">{node.name}</OverflowMarquee>
              {!isDirectory && estimate && (
                <span className="document-tree__meta">
                  <span
                    className={`document-tree__estimate${
                      estimate.kind === "unavailable" ? " document-tree__estimate--unavailable" : ""
                    }`}
                    title={estimate.hint}
                    aria-label={
                      estimate.kind === "time"
                        ? `预计阅读时长 ${estimate.label}`
                        : (estimate.hint ?? estimate.label)
                    }
                  >
                    {estimate.label}
                  </span>
                </span>
              )}
            </button>
            {isDirectory && isExpanded && renderNodes(node.children, node.path)}
          </li>
        );
      })}
    </ul>
    );
  };

  if (inSearchMode) {
    return (
      <nav className="document-tree document-tree--search" aria-label="搜索结果">
        <h2 className="document-tree__label">搜索结果</h2>
        {searchResults.length > 0 ? (
          <ul className="document-tree__results" ref={searchResultsRef}>
            {searchResults.map((result) => {
              const isCurrent = result.relativePath === currentPath;
              return (
                <li className="document-tree__result" key={result.resultId}>
                  <button
                    className={`document-tree__result-button${isCurrent ? " document-tree__result-button--current" : ""}`}
                    type="button"
                    aria-current={isCurrent ? "page" : undefined}
                    title={onOpenSecondary ? "Alt+点击在右侧分栏打开" : undefined}
                    onMouseEnter={(event) => armOverflowMarquee(event.currentTarget)}
                    onMouseLeave={(event) => disarmOverflowMarquee(event.currentTarget)}
                    onClick={(event) => {
                      if (event.altKey && onOpenSecondary) {
                        onOpenSecondary(result.relativePath);
                        return;
                      }
                      onBeforeSelect?.();
                      void selectDocument(result.relativePath, result.locator);
                    }}
                  >
                    <OverflowMarquee className="document-tree__result-title">{result.title}</OverflowMarquee>
                    <span className="document-tree__result-path">{result.relativePath}</span>
                    {result.locator?.kind === "pdfPage" && <span className="document-tree__result-locator">第 {result.locator.page} 页</span>}
                    {result.locator?.kind === "epubChapter" && <span className="document-tree__result-locator">章节命中</span>}
                    {result.snippet && (
                      <span className="document-tree__result-snippet">{result.snippet}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="document-tree__empty" role="status">
            {loading ? "正在搜索…" : "没有找到匹配的文档"}
          </p>
        )}
      </nav>
    );
  }

  return (
    <nav
      className={`document-tree${drag ? " document-tree--dragging" : ""}`}
      aria-label="文档目录"
    >
      <h2 className="document-tree__label">文档</h2>
      {tree.length > 0 ? (
        renderNodes(tree)
      ) : (
        <p className="document-tree__empty" role="status">
          {loading ? "正在读取文档库…" : "选择一个文件夹开始阅读"}
        </p>
      )}
      {menu ? (
        <DocumentTreeMenu
          x={menu.x}
          y={menu.y}
          pinned={menu.pinned}
          canReset={folderHasCustomLayout(treeLayout, menu.parentPath)}
          onPin={() => pinTreeNode(menu.parentPath, menu.nodeKey)}
          onUnpin={() => unpinTreeNode(menu.parentPath, menu.nodeKey)}
          onReset={() => resetFolderTreeLayout(menu.parentPath)}
          onClose={closeMenu}
        />
      ) : null}
    </nav>
  );
}
