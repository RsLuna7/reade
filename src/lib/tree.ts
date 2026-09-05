import type { DocumentInfo } from "./backend";

export interface DirectoryTreeNode {
  kind: "directory";
  id: string;
  name: string;
  path: string;
  children: DocumentTreeNode[];
}

export interface FileTreeNode {
  kind: "document";
  id: string;
  name: string;
  path: string;
  document: DocumentInfo;
}

export type DocumentTreeNode = DirectoryTreeNode | FileTreeNode;

/**
 * 文档树与"读完接着读"的同文件夹回落共用这一个 collator
 * （plan-read-next §3.1），防止两处排序漂移。
 */
export const treePathCollator = new Intl.Collator(["zh-CN", "en"], {
  numeric: true,
  sensitivity: "base",
});

const pathCollator = treePathCollator;

export function normalizeRelativePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function fallbackDocumentName(relativePath: string): string {
  const segments = normalizeRelativePath(relativePath).split("/");
  const fileName = segments[segments.length - 1] ?? relativePath;
  return fileName.replace(/\.md(?:own)?$/i, "");
}

/** 树节点显示名:标题优先,空标题回落文件名(与 buildDocumentTree 同源)。 */
export function documentTreeName(document: DocumentInfo): string {
  return document.title.trim() || fallbackDocumentName(document.relativePath);
}

/** 默认树序：目录优先，再按显示名 Collator。置顶/手排套在这之上。 */
export function compareTreeNodesDefault(
  left: DocumentTreeNode,
  right: DocumentTreeNode,
): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return pathCollator.compare(left.name, right.name);
}

function sortNodes(nodes: DocumentTreeNode[]): void {
  nodes.sort(compareTreeNodesDefault);

  for (const node of nodes) {
    if (node.kind === "directory") {
      sortNodes(node.children);
    }
  }
}

/** 根用 `""`；找不到父目录时返回 null。 */
export function findChildNodes(
  nodes: DocumentTreeNode[],
  parentPath: string,
): DocumentTreeNode[] | null {
  if (!parentPath) return nodes;

  const visit = (items: DocumentTreeNode[]): DocumentTreeNode[] | null => {
    for (const item of items) {
      if (item.kind !== "directory") continue;
      if (item.path === parentPath) return item.children;
      const nested = visit(item.children);
      if (nested) return nested;
    }
    return null;
  };

  return visit(nodes);
}

export function buildDocumentTree(documents: DocumentInfo[]): DocumentTreeNode[] {
  const root: DocumentTreeNode[] = [];
  const directories = new Map<string, DirectoryTreeNode>();

  for (const document of documents) {
    const normalizedPath = normalizeRelativePath(document.relativePath);
    if (!normalizedPath) continue;

    const segments = normalizedPath.split("/");
    const fileSegment = segments.pop();
    if (!fileSegment) continue;

    let children = root;
    let parentPath = "";

    for (const segment of segments) {
      const directoryPath = parentPath ? `${parentPath}/${segment}` : segment;
      let directory = directories.get(directoryPath);

      if (!directory) {
        directory = {
          kind: "directory",
          id: `directory:${directoryPath}`,
          name: segment,
          path: directoryPath,
          children: [],
        };
        directories.set(directoryPath, directory);
        children.push(directory);
      }

      children = directory.children;
      parentPath = directoryPath;
    }

    children.push({
      kind: "document",
      id: `document:${normalizedPath}`,
      name: document.title.trim() || fallbackDocumentName(normalizedPath),
      path: document.relativePath,
      document,
    });
  }

  sortNodes(root);
  return root;
}

/**
 * 树序展平的文档列表（plan-bookshelf-covers §3.3）：书架网格沿用文档树的
 * 目录优先 + Collator 排序，避免两种浏览形态各排各的。
 */
export function flattenDocumentsInTreeOrder(nodes: DocumentTreeNode[]): DocumentInfo[] {
  const documents: DocumentInfo[] = [];
  const visit = (items: DocumentTreeNode[]) => {
    for (const item of items) {
      if (item.kind === "document") documents.push(item.document);
      else visit(item.children);
    }
  };
  visit(nodes);
  return documents;
}

export function collectDirectoryPaths(nodes: DocumentTreeNode[]): Set<string> {
  const paths = new Set<string>();

  const visit = (items: DocumentTreeNode[]) => {
    for (const item of items) {
      if (item.kind === "directory") {
        paths.add(item.path);
        visit(item.children);
      }
    }
  };

  visit(nodes);
  return paths;
}

export function reconcileExpandedPaths(
  expandedPaths: Iterable<string>,
  nodes: DocumentTreeNode[],
): string[] {
  const available = collectDirectoryPaths(nodes);
  return [...new Set(expandedPaths)].filter((path) => available.has(path));
}

export function parentDirectoryPath(path: string): string | null {
  const normalized = normalizeRelativePath(path);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? null : normalized.slice(0, separator);
}

/**
 * 目录路径的全部祖先（含自身），用于在文档树中展开并定位某一文件夹。
 * 例：`正文/第一章` → `["正文", "正文/第一章"]`。
 */
export function directoryAncestorPaths(directoryPath: string): string[] {
  const normalized = normalizeRelativePath(directoryPath);
  if (!normalized) return [];
  const segments = normalized.split("/");
  const paths: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    paths.push(segments.slice(0, index + 1).join("/"));
  }
  return paths;
}

/** 按相对路径查找目录节点；找不到返回 null。 */
export function findDirectoryNode(
  nodes: DocumentTreeNode[],
  directoryPath: string,
): DirectoryTreeNode | null {
  const normalized = normalizeRelativePath(directoryPath);
  if (!normalized) return null;

  const visit = (items: DocumentTreeNode[]): DirectoryTreeNode | null => {
    for (const item of items) {
      if (item.kind !== "directory") continue;
      if (item.path === normalized) return item;
      const nested = visit(item.children);
      if (nested) return nested;
    }
    return null;
  };

  return visit(nodes);
}

/** 文档是否位于某目录之下（不含目录路径本身撞名的同级文件）。 */
export function isDocumentUnderDirectory(
  relativePath: string,
  directoryPath: string,
): boolean {
  const file = normalizeRelativePath(relativePath);
  const directory = normalizeRelativePath(directoryPath);
  if (!file || !directory) return false;
  return file.startsWith(`${directory}/`);
}
