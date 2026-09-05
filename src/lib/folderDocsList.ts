/**
 * 「本夹文档」列表：按文件夹收窄文档快照，供居中全名浏览面板使用。
 */

import type { DocumentInfo } from "./backend";
import {
  directoryAncestorPaths,
  findDirectoryNode,
  flattenDocumentsInTreeOrder,
  isDocumentUnderDirectory,
  normalizeRelativePath,
  parentDirectoryPath,
  type DocumentTreeNode,
} from "./tree";
import {
  buildLaidOutDocumentTree,
  type LibraryTreeLayout,
} from "./treeLayout";

export interface FolderDocsCrumb {
  path: string | null;
  label: string;
}

export interface FolderLevelFolder {
  path: string;
  name: string;
}

export interface FolderLevelContents {
  folders: FolderLevelFolder[];
  documents: DocumentInfo[];
}

export interface FolderDocsRailItem {
  path: string | null;
  name: string;
  depth: number;
  current: boolean;
}

export type FolderDocsRow =
  | { kind: "folder"; path: string; name: string }
  | { kind: "document"; document: DocumentInfo };

/**
 * 解析「本夹」目录：优先面包屑收窄的 treeScopePath，否则取当前文档父目录。
 * 根目录文件返回 `null`（表示书库根层）。
 */
export function resolveFolderDocsDirectory(
  treeScopePath: string | null,
  currentPath: string | null,
): string | null | undefined {
  if (treeScopePath) return normalizeRelativePath(treeScopePath) || null;
  if (!currentPath) return undefined;
  return parentDirectoryPath(currentPath);
}

export function folderDocsLabel(folderPath: string | null): string {
  if (folderPath === null) return "书库根目录";
  const segments = folderPath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? folderPath;
}

/** 是否已有可打开的本夹上下文（有作用域或当前文档在子目录中）。 */
export function canOpenFolderDocs(
  treeScopePath: string | null,
  currentPath: string | null,
): boolean {
  return resolveFolderDocsDirectory(treeScopePath, currentPath) !== undefined;
}

export function folderDocsCrumbs(
  folderPath: string | null,
  libraryLabel: string,
): FolderDocsCrumb[] {
  const rootLabel = libraryLabel.trim() || "书库";
  const crumbs: FolderDocsCrumb[] = [{ path: null, label: rootLabel }];
  if (!folderPath) return crumbs;
  const segments = normalizeRelativePath(folderPath).split("/").filter(Boolean);
  segments.forEach((label, index) => {
    crumbs.push({
      path: segments.slice(0, index + 1).join("/"),
      label,
    });
  });
  return crumbs;
}

/**
 * 按树序列出某目录下的全部文档（含子目录）。
 * `folderPath === null` 表示整库（搜索从根层出发时用）。
 */
export function listDocumentsInFolder(
  documents: readonly DocumentInfo[],
  folderPath: string | null,
  treeLayout: LibraryTreeLayout = {},
): DocumentInfo[] {
  const ordered = flattenDocumentsInTreeOrder(
    buildLaidOutDocumentTree([...documents], treeLayout),
  );
  if (folderPath === null) return ordered;
  const folder = normalizeRelativePath(folderPath);
  if (!folder) return [];
  return ordered.filter((document) =>
    isDocumentUnderDirectory(document.relativePath, folder),
  );
}

/** 当前层的子文件夹 + 本层文档（不含下层文档）。 */
export function listFolderLevel(
  documents: readonly DocumentInfo[],
  folderPath: string | null,
  treeLayout: LibraryTreeLayout = {},
): FolderLevelContents {
  const tree = buildLaidOutDocumentTree([...documents], treeLayout);
  const children: DocumentTreeNode[] =
    folderPath === null
      ? tree
      : (findDirectoryNode(tree, folderPath)?.children ?? []);
  const folders: FolderLevelFolder[] = [];
  const files: DocumentInfo[] = [];
  for (const child of children) {
    if (child.kind === "directory") {
      folders.push({ path: child.path, name: child.name });
    } else {
      files.push(child.document);
    }
  }
  return { folders, documents: files };
}

/**
 * 左侧结构树：始终展开到当前夹，并展开当前夹以露出其子文件夹。
 * `path === null` 表示书库根。
 */
export function listFolderDocsRail(
  documents: readonly DocumentInfo[],
  folderPath: string | null,
  libraryLabel: string,
  treeLayout: LibraryTreeLayout = {},
): FolderDocsRailItem[] {
  const tree = buildLaidOutDocumentTree([...documents], treeLayout);
  const expanded = new Set(
    folderPath
      ? [...directoryAncestorPaths(folderPath), normalizeRelativePath(folderPath)]
      : [],
  );
  const items: FolderDocsRailItem[] = [
    {
      path: null,
      name: libraryLabel.trim() || "书库",
      depth: 0,
      current: folderPath === null,
    },
  ];
  const walk = (nodes: DocumentTreeNode[], depth: number) => {
    for (const node of nodes) {
      if (node.kind !== "directory") continue;
      items.push({
        path: node.path,
        name: node.name,
        depth,
        current: node.path === folderPath,
      });
      if (expanded.has(node.path)) walk(node.children, depth + 1);
    }
  };
  walk(tree, 1);
  return items;
}

export function folderDocsRows(
  contents: FolderLevelContents,
  query: string,
  descendantDocuments: readonly DocumentInfo[],
): FolderDocsRow[] {
  const tokens = tokenizeFolderQuery(query);
  const folders =
    tokens.length === 0
      ? contents.folders
      : contents.folders.filter((folder) =>
          tokens.every((token) => folder.name.toLowerCase().includes(token)),
        );
  const documents =
    tokens.length === 0
      ? contents.documents
      : descendantDocuments.filter((document) => {
          const haystack = `${document.title} ${document.relativePath}`.toLowerCase();
          return tokens.every((token) => haystack.includes(token));
        });
  return [
    ...folders.map((folder) => ({ kind: "folder" as const, ...folder })),
    ...documents.map((document) => ({ kind: "document" as const, document })),
  ];
}

/** 标题 + 路径的简易多 token 子串过滤（空查询原样返回）。 */
export function filterFolderDocuments(
  documents: readonly DocumentInfo[],
  query: string,
): DocumentInfo[] {
  const tokens = tokenizeFolderQuery(query);
  if (tokens.length === 0) return [...documents];
  return documents.filter((document) => {
    const haystack = `${document.title} ${document.relativePath}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/** `modified` 为毫秒；小于 10^10 时按秒处理（与 `normalizeModifiedMs` 同一启发式）。无效值返回空串。 */
export function formatFolderDocDate(modified: number): string {
  const ms = modified > 0 && modified < 10_000_000_000 ? modified * 1000 : modified;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day}`;
}

function tokenizeFolderQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}
