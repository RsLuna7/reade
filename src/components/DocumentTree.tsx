import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { buildDocumentTree, parentDirectoryPath, type DocumentTreeNode } from "../lib/tree";
import { useReaderStore } from "../store/useReaderStore";

interface VisibleTreeItem {
  node: DocumentTreeNode;
  parentPath: string | null;
}

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

export function DocumentTree() {
  const documents = useReaderStore((state) => state.documents);
  const currentPath = useReaderStore((state) => state.currentPath);
  const searchQuery = useReaderStore((state) => state.searchQuery);
  const searchResults = useReaderStore((state) => state.searchResults);
  const loading = useReaderStore((state) => state.loading);
  const expandedPaths = useReaderStore((state) => state.expandedPaths);
  const toggleDirectory = useReaderStore((state) => state.toggleDirectory);
  const selectDocument = useReaderStore((state) => state.selectDocument);

  const tree = useMemo(() => buildDocumentTree(documents), [documents]);
  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const visibleItems = useMemo(
    () => collectVisibleItems(tree, expanded),
    [tree, expanded],
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const inSearchMode = searchQuery.trim().length > 0;

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
        else void selectDocument(item.node.path);
        break;
    }
  };

  const renderNodes = (
    nodes: DocumentTreeNode[],
    parentPath: string | null = null,
  ) => (
    <ul className="document-tree__group" role={parentPath ? "group" : "tree"}>
      {nodes.map((node) => {
        const isDirectory = node.kind === "directory";
        const isExpanded = isDirectory && expanded.has(node.path);
        const isCurrent = !isDirectory && node.path === currentPath;
        const item: VisibleTreeItem = { node, parentPath };

        return (
          <li
            className={`document-tree__node document-tree__node--${node.kind}`}
            key={node.id}
            role="treeitem"
            aria-expanded={isDirectory ? isExpanded : undefined}
            aria-selected={isDirectory ? undefined : isCurrent}
          >
            <button
              className={`document-tree__item${isCurrent ? " document-tree__item--current" : ""}`}
              type="button"
              tabIndex={focusedId === node.id ? 0 : -1}
              ref={(element) => {
                if (element) itemRefs.current.set(node.id, element);
                else itemRefs.current.delete(node.id);
              }}
              onFocus={() => setFocusedId(node.id)}
              onKeyDown={(event) => handleTreeKeyDown(event, item)}
              onClick={() => {
                if (isDirectory) toggleDirectory(node.path);
                else void selectDocument(node.path);
              }}
            >
              {isDirectory ? (
                <span className="document-tree__chevron" aria-hidden="true">
                  {isExpanded ? "−" : "+"}
                </span>
              ) : (
                <span className="document-tree__file-mark" aria-hidden="true" />
              )}
              <span className="document-tree__name">{node.name}</span>
            </button>
            {isDirectory && isExpanded && renderNodes(node.children, node.path)}
          </li>
        );
      })}
    </ul>
  );

  if (inSearchMode) {
    return (
      <nav className="document-tree document-tree--search" aria-label="搜索结果">
        <h2 className="document-tree__label">搜索结果</h2>
        {searchResults.length > 0 ? (
          <ul className="document-tree__results">
            {searchResults.map((result) => {
              const isCurrent = result.relativePath === currentPath;
              return (
                <li className="document-tree__result" key={result.relativePath}>
                  <button
                    className={`document-tree__result-button${isCurrent ? " document-tree__result-button--current" : ""}`}
                    type="button"
                    aria-current={isCurrent ? "page" : undefined}
                    onClick={() => void selectDocument(result.relativePath)}
                  >
                    <span className="document-tree__result-title">{result.title}</span>
                    <span className="document-tree__result-path">{result.relativePath}</span>
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
    <nav className="document-tree" aria-label="文档目录">
      <h2 className="document-tree__label">文档</h2>
      {tree.length > 0 ? (
        renderNodes(tree)
      ) : (
        <p className="document-tree__empty" role="status">
          {loading ? "正在读取文档库…" : "选择一个文件夹开始阅读"}
        </p>
      )}
    </nav>
  );
}
