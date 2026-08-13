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

function sortNodes(nodes: DocumentTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }

    return pathCollator.compare(left.name, right.name);
  });

  for (const node of nodes) {
    if (node.kind === "directory") {
      sortNodes(node.children);
    }
  }
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
