/**
 * 「本夹文档」居中目录：可点路径 + 结构树 + 本层完整标题。
 * 列表数据由 folderDocsList 准备；本组件管交互与渲染。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentInfo } from "../lib/backend";
import {
  folderDocsCrumbs,
  folderDocsLabel,
  folderDocsRows,
  formatFolderDocDate,
  listDocumentsInFolder,
  listFolderDocsRail,
  listFolderLevel,
} from "../lib/folderDocsList";
import { parentDirectoryPath } from "../lib/tree";
import type { LibraryTreeLayout } from "../lib/treeLayout";

export interface FolderDocsPanelProps {
  open: boolean;
  /** `null` = 书库根层。 */
  folderPath: string | null;
  libraryLabel: string;
  documents: readonly DocumentInfo[];
  treeLayout?: LibraryTreeLayout;
  currentPath: string | null;
  onSelect: (relativePath: string) => void;
  onNavigateFolder: (folderPath: string | null) => void;
  onClose: () => void;
}

export function FolderDocsPanel({
  open,
  folderPath,
  libraryLabel,
  documents,
  treeLayout = {},
  currentPath,
  onSelect,
  onNavigateFolder,
  onClose,
}: FolderDocsPanelProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const folderLabel = folderDocsLabel(folderPath);

  const crumbs = useMemo(
    () => folderDocsCrumbs(folderPath, libraryLabel),
    [folderPath, libraryLabel],
  );
  const heading = crumbs[crumbs.length - 1]?.label ?? folderLabel;
  const rail = useMemo(
    () => listFolderDocsRail(documents, folderPath, libraryLabel, treeLayout),
    [documents, folderPath, libraryLabel, treeLayout],
  );
  const contents = useMemo(
    () => listFolderLevel(documents, folderPath, treeLayout),
    [documents, folderPath, treeLayout],
  );
  const descendants = useMemo(
    () => listDocumentsInFolder(documents, folderPath, treeLayout),
    [documents, folderPath, treeLayout],
  );
  const rows = useMemo(
    () => folderDocsRows(contents, query, descendants),
    [contents, descendants, query],
  );
  const activeRow = rows[Math.min(activeIndex, rows.length - 1)] ?? null;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setQuery("");
  }, [folderPath]);

  useEffect(() => {
    const currentIndex = rows.findIndex(
      (row) =>
        row.kind === "document" && row.document.relativePath === currentPath,
    );
    setActiveIndex(currentIndex >= 0 ? currentIndex : 0);
  }, [currentPath, rows]);

  useEffect(() => {
    if (!open || !activeRow) return;
    const key =
      activeRow.kind === "folder"
        ? activeRow.path
        : activeRow.document.relativePath;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeRow, open]);

  if (!open) return null;

  const moveActive = (delta: 1 | -1) => {
    if (rows.length === 0) return;
    setActiveIndex((current) => {
      const base = Math.min(current, rows.length - 1);
      return (base + delta + rows.length) % rows.length;
    });
  };

  const activate = (row: (typeof rows)[number]) => {
    if (row.kind === "folder") onNavigateFolder(row.path);
    else onSelect(row.document.relativePath);
  };

  const goParent = () => {
    if (!folderPath) return;
    onNavigateFolder(parentDirectoryPath(folderPath));
  };

  return (
    <>
      <button
        className="folder-docs-backdrop reade-motion-backdrop"
        type="button"
        aria-label="关闭本夹目录"
        onClick={onClose}
      />
      <div
        className="folder-docs-panel reade-motion-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`本夹目录：${heading}`}
      >
        <header className="folder-docs-header">
          <nav className="folder-docs-crumbs" aria-label="文件夹路径">
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return (
                <span className="folder-docs-crumb-wrap" key={`${crumb.path ?? ""}-${index}`}>
                  {index > 0 ? (
                    <span className="folder-docs-crumb-sep" aria-hidden="true">
                      /
                    </span>
                  ) : null}
                  {last ? (
                    <span className="folder-docs-crumb is-current">{crumb.label}</span>
                  ) : (
                    <button
                      type="button"
                      className="folder-docs-crumb"
                      onClick={() => onNavigateFolder(crumb.path)}
                    >
                      {crumb.label}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
          <h2 className="folder-docs-title">{heading}</h2>
        </header>

        <div className="folder-docs-input-row">
          <input
            ref={inputRef}
            className="folder-docs-input"
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls="folder-docs-listbox"
            aria-activedescendant={
              activeRow ? `folder-docs-option-${Math.min(activeIndex, rows.length - 1)}` : undefined
            }
            aria-label="过滤本夹文档"
            placeholder="过滤…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActive(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActive(-1);
              } else if (event.key === "ArrowLeft" && query.length === 0) {
                if (!folderPath) return;
                event.preventDefault();
                goParent();
              } else if (event.key === "ArrowRight" && activeRow?.kind === "folder") {
                event.preventDefault();
                onNavigateFolder(activeRow.path);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (activeRow) activate(activeRow);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            }}
          />
        </div>

        <div className="folder-docs-body">
          <div className="folder-docs-tree" role="tree" aria-label="文件夹">
            {rail.map((item) => (
              <button
                key={item.path ?? ""}
                type="button"
                role="treeitem"
                aria-current={item.current ? "true" : undefined}
                className={`folder-docs-tree-item${item.current ? " is-current" : ""}`}
                style={{ paddingLeft: `${8 + item.depth * 12}px` }}
                onClick={() => onNavigateFolder(item.path)}
              >
                {item.name}
              </button>
            ))}
          </div>

          <div
            className="folder-docs-pane"
            key={folderPath ?? ""}
            ref={listRef}
            role="listbox"
            id="folder-docs-listbox"
            aria-label="本夹文档列表"
          >
            {rows.length === 0 ? (
              <p className="folder-docs-empty" role="status">
                {query.trim()
                  ? "没有匹配项"
                  : contents.folders.length === 0 && contents.documents.length === 0
                    ? "此文件夹是空的"
                    : "没有匹配项"}
              </p>
            ) : (
              rows.map((row, index) => {
                const isActive = row === activeRow;
                if (row.kind === "folder") {
                  return (
                    <div
                      key={`folder:${row.path}`}
                      id={`folder-docs-option-${index}`}
                      data-row-key={row.path}
                      role="option"
                      aria-selected={isActive}
                      className={`folder-docs-row is-folder${isActive ? " is-active" : ""}`}
                      onPointerMove={() => setActiveIndex(index)}
                      onClick={() => onNavigateFolder(row.path)}
                    >
                      <span className="folder-docs-mark" aria-hidden="true">
                        ›
                      </span>
                      <span className="folder-docs-folder-name">{row.name}</span>
                    </div>
                  );
                }
                const isCurrent = row.document.relativePath === currentPath;
                const date = formatFolderDocDate(row.document.modified);
                const title = row.document.title.trim() || row.document.relativePath;
                const number = String(
                  rows
                    .slice(0, index + 1)
                    .filter((entry) => entry.kind === "document").length,
                ).padStart(2, "0");
                return (
                  <div
                    key={row.document.relativePath}
                    id={`folder-docs-option-${index}`}
                    data-row-key={row.document.relativePath}
                    role="option"
                    aria-selected={isActive}
                    className={[
                      "folder-docs-row",
                      "is-doc",
                      isActive ? "is-active" : "",
                      isCurrent ? "is-current" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onPointerMove={() => setActiveIndex(index)}
                    onClick={() => onSelect(row.document.relativePath)}
                  >
                    <span className="folder-docs-index" aria-hidden="true">
                      {number}
                    </span>
                    <span className="folder-docs-option-title">{title}</span>
                    {date ? <span className="folder-docs-date">{date}</span> : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </>
  );
}
