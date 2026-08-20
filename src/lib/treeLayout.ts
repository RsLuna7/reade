/**
 * 文档树每层置顶与手排（浏览偏好，不改磁盘路径）。
 *
 * localStorage `reade-tree-layout` 存版本信封
 * `{ version: 1, libraries: { [libraryKey]: { [parentPath]: FolderLayout } } }`。
 * 书库键走 `normalizeLibraryPathKey`；根层 parentPath 为 `""`。
 * 存储一律视为不可信输入：坏条目静默丢弃。
 */

import { normalizeLibraryPathKey } from "./libraryMru";
import {
  buildDocumentTree,
  compareTreeNodesDefault,
  normalizeRelativePath,
  type DocumentTreeNode,
} from "./tree";
import type { DocumentInfo } from "./backend";

export const TREE_LAYOUT_STORAGE_KEY = "reade-tree-layout";
export const TREE_LAYOUT_VERSION = 1;
/** 库根的 parentPath。 */
export const TREE_LAYOUT_ROOT = "";

export interface FolderLayout {
  /** 置顶段，从上到下。 */
  pinned: string[];
  /** 未置顶段的手排；null = 目录优先 + Collator。 */
  order: string[] | null;
}

export type LibraryTreeLayout = Record<string, FolderLayout>;

interface LayoutEnvelope {
  version: number;
  libraries: Record<string, LibraryTreeLayout>;
}

export function layoutNodeKey(node: DocumentTreeNode): string {
  return node.kind === "directory" ? node.path : normalizeRelativePath(node.path);
}

export function parentLayoutPath(node: DocumentTreeNode): string {
  const normalized = normalizeRelativePath(node.path);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? TREE_LAYOUT_ROOT : normalized.slice(0, separator);
}

export function isPinnedInLayout(
  layout: LibraryTreeLayout,
  parentPath: string,
  nodeKey: string,
): boolean {
  return Boolean(layout[parentPath]?.pinned.includes(nodeKey));
}

export function folderHasCustomLayout(
  layout: LibraryTreeLayout,
  parentPath: string,
): boolean {
  const folder = layout[parentPath];
  return Boolean(folder && (folder.pinned.length > 0 || folder.order !== null));
}

export function buildLaidOutDocumentTree(
  documents: readonly DocumentInfo[],
  layout: LibraryTreeLayout,
): DocumentTreeNode[] {
  return applyFolderLayout(buildDocumentTree([...documents]), layout);
}

export function applyFolderLayout(
  nodes: DocumentTreeNode[],
  layout: LibraryTreeLayout,
  parentPath: string = TREE_LAYOUT_ROOT,
): DocumentTreeNode[] {
  const withChildren = nodes.map((node) => {
    if (node.kind !== "directory") return node;
    return {
      ...node,
      children: applyFolderLayout(node.children, layout, node.path),
    };
  });
  return orderSiblings(withChildren, layout[parentPath]);
}

function orderSiblings(
  nodes: DocumentTreeNode[],
  folder: FolderLayout | undefined,
): DocumentTreeNode[] {
  if (!folder || (folder.pinned.length === 0 && folder.order === null)) {
    return nodes;
  }

  const byKey = new Map(nodes.map((node) => [layoutNodeKey(node), node]));
  const used = new Set<string>();
  const pinnedNodes: DocumentTreeNode[] = [];
  for (const key of folder.pinned) {
    const node = byKey.get(key);
    if (!node || used.has(key)) continue;
    pinnedNodes.push(node);
    used.add(key);
  }

  const remaining = nodes.filter((node) => !used.has(layoutNodeKey(node)));
  return [...pinnedNodes, ...orderUnpinned(remaining, folder.order)];
}

function orderUnpinned(
  nodes: DocumentTreeNode[],
  order: string[] | null,
): DocumentTreeNode[] {
  if (!order) return nodes;

  const byKey = new Map(nodes.map((node) => [layoutNodeKey(node), node]));
  const used = new Set<string>();
  const result: DocumentTreeNode[] = [];
  for (const key of order) {
    const node = byKey.get(key);
    if (!node || used.has(key)) continue;
    result.push(node);
    used.add(key);
  }
  for (const node of nodes) {
    if (used.has(layoutNodeKey(node))) continue;
    insertNodeByDefault(result, node);
  }
  return result;
}

function insertNodeByDefault(list: DocumentTreeNode[], node: DocumentTreeNode): void {
  let index = 0;
  while (index < list.length && compareTreeNodesDefault(list[index], node) <= 0) {
    index += 1;
  }
  list.splice(index, 0, node);
}

export function pinNode(
  layout: LibraryTreeLayout,
  parentPath: string,
  nodeKey: string,
): LibraryTreeLayout {
  const current = layout[parentPath] ?? { pinned: [], order: null };
  if (current.pinned.includes(nodeKey)) return layout;
  const pinned = [nodeKey, ...current.pinned];
  const order = current.order ? current.order.filter((key) => key !== nodeKey) : null;
  return { ...layout, [parentPath]: { pinned, order } };
}

export function unpinNode(
  layout: LibraryTreeLayout,
  parentPath: string,
  nodeKey: string,
  siblings: readonly DocumentTreeNode[],
): LibraryTreeLayout {
  const current = layout[parentPath];
  if (!current?.pinned.includes(nodeKey)) return layout;

  const pinned = current.pinned.filter((key) => key !== nodeKey);
  let order = current.order;
  if (order) {
    const byKey = new Map(siblings.map((node) => [layoutNodeKey(node), node]));
    const node = byKey.get(nodeKey);
    const kept = order.filter((key) => key !== nodeKey);
    if (node) {
      const result = kept
        .map((key) => byKey.get(key))
        .filter((item): item is DocumentTreeNode => Boolean(item));
      insertNodeByDefault(result, node);
      order = result.map(layoutNodeKey);
    } else {
      order = kept;
    }
  }

  return commitFolder(layout, parentPath, { pinned, order });
}

/**
 * `toIndex` 是同段内「移除拖动项之后」的插入下标。
 * 跨段或找不到节点时返回 null。
 */
export function moveSibling(
  layout: LibraryTreeLayout,
  parentPath: string,
  nodeKey: string,
  toIndex: number,
  siblings: readonly DocumentTreeNode[],
): LibraryTreeLayout | null {
  const pinnedSet = new Set(layout[parentPath]?.pinned ?? []);
  const isPinned = pinnedSet.has(nodeKey);
  const segmentKeys = siblings
    .filter((node) => pinnedSet.has(layoutNodeKey(node)) === isPinned)
    .map(layoutNodeKey);

  if (!segmentKeys.includes(nodeKey)) return null;

  const next = [...segmentKeys];
  const from = next.indexOf(nodeKey);
  next.splice(from, 1);
  const clamped = Math.max(0, Math.min(Math.floor(toIndex), next.length));
  next.splice(clamped, 0, nodeKey);
  if (next.every((key, index) => key === segmentKeys[index])) return layout;

  const current = layout[parentPath] ?? { pinned: [], order: null };
  if (isPinned) {
    return commitFolder(layout, parentPath, { pinned: next, order: current.order });
  }
  return commitFolder(layout, parentPath, { pinned: current.pinned, order: next });
}

export function resetFolderLayout(
  layout: LibraryTreeLayout,
  parentPath: string,
): LibraryTreeLayout {
  if (!(parentPath in layout)) return layout;
  const next = { ...layout };
  delete next[parentPath];
  return next;
}

export function reconcileTreeLayout(
  layout: LibraryTreeLayout,
  nodes: DocumentTreeNode[],
): LibraryTreeLayout {
  const next: LibraryTreeLayout = {};

  const walk = (children: DocumentTreeNode[], parentPath: string) => {
    const folder = layout[parentPath];
    if (folder) {
      const reconciled = reconcileFolder(folder, children);
      if (reconciled) next[parentPath] = reconciled;
    }
    for (const child of children) {
      if (child.kind === "directory") walk(child.children, child.path);
    }
  };

  walk(nodes, TREE_LAYOUT_ROOT);
  return next;
}

function reconcileFolder(
  folder: FolderLayout,
  children: DocumentTreeNode[],
): FolderLayout | null {
  const byKey = new Map(children.map((node) => [layoutNodeKey(node), node]));
  const pinned: string[] = [];
  const pinnedSeen = new Set<string>();
  for (const key of folder.pinned) {
    if (!byKey.has(key) || pinnedSeen.has(key)) continue;
    pinned.push(key);
    pinnedSeen.add(key);
  }

  let order = folder.order;
  if (order) {
    const kept: DocumentTreeNode[] = [];
    const keptSet = new Set<string>();
    for (const key of order) {
      if (pinnedSeen.has(key) || keptSet.has(key)) continue;
      const node = byKey.get(key);
      if (!node) continue;
      kept.push(node);
      keptSet.add(key);
    }
    for (const child of children) {
      const key = layoutNodeKey(child);
      if (pinnedSeen.has(key) || keptSet.has(key)) continue;
      insertNodeByDefault(kept, child);
    }
    order = kept.map(layoutNodeKey);
  }

  if (pinned.length === 0 && order === null) return null;
  return { pinned, order };
}

function commitFolder(
  layout: LibraryTreeLayout,
  parentPath: string,
  folder: FolderLayout,
): LibraryTreeLayout {
  if (folder.pinned.length === 0 && folder.order === null) {
    if (!(parentPath in layout)) return layout;
    const next = { ...layout };
    delete next[parentPath];
    return next;
  }
  return { ...layout, [parentPath]: folder };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function sanitizeKeyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const key = normalizeRelativePath(item);
    if (!key || key.split("/").includes("..") || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function sanitizeParentPath(key: string): string | null {
  if (key === TREE_LAYOUT_ROOT) return TREE_LAYOUT_ROOT;
  const normalized = normalizeRelativePath(key);
  if (!normalized || normalized.split("/").includes("..")) return null;
  return normalized;
}

export function sanitizeFolderLayout(value: unknown): FolderLayout | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const pinned = sanitizeKeyList(raw.pinned);
  let order: string[] | null = null;
  if (raw.order === null || raw.order === undefined) {
    order = null;
  } else if (Array.isArray(raw.order)) {
    const pinSet = new Set(pinned);
    order = sanitizeKeyList(raw.order).filter((key) => !pinSet.has(key));
  } else {
    return null;
  }
  if (pinned.length === 0 && order === null) return null;
  return { pinned, order };
}

function sanitizeLibraryLayout(value: unknown): LibraryTreeLayout {
  if (!value || typeof value !== "object") return {};
  const result: LibraryTreeLayout = {};
  for (const [parent, folder] of Object.entries(value as Record<string, unknown>)) {
    const parentPath = sanitizeParentPath(parent);
    if (parentPath === null) continue;
    const sanitized = sanitizeFolderLayout(folder);
    if (sanitized) result[parentPath] = sanitized;
  }
  return result;
}

function loadEnvelope(): LayoutEnvelope {
  const empty: LayoutEnvelope = { version: TREE_LAYOUT_VERSION, libraries: {} };
  const store = storage();
  if (!store) return empty;

  let parsed: unknown;
  try {
    const raw = store.getItem(TREE_LAYOUT_STORAGE_KEY);
    if (!raw) return empty;
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const envelope = parsed as Partial<LayoutEnvelope>;
  if (envelope.version !== TREE_LAYOUT_VERSION) return empty;
  if (!envelope.libraries || typeof envelope.libraries !== "object") return empty;

  const libraries: Record<string, LibraryTreeLayout> = {};
  for (const [root, folders] of Object.entries(envelope.libraries)) {
    if (typeof root !== "string" || !root.trim()) continue;
    const libKey = normalizeLibraryPathKey(root);
    const sanitized = sanitizeLibraryLayout(folders);
    if (Object.keys(sanitized).length > 0) libraries[libKey] = sanitized;
  }
  return { version: TREE_LAYOUT_VERSION, libraries };
}

function saveEnvelope(envelope: LayoutEnvelope): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(TREE_LAYOUT_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // 配额/隐私模式只丢浏览顺序，不影响打开书库。
  }
}

export function readTreeLayout(libraryRoot: string): LibraryTreeLayout {
  if (!libraryRoot.trim()) return {};
  return loadEnvelope().libraries[normalizeLibraryPathKey(libraryRoot)] ?? {};
}

export function writeTreeLayout(libraryRoot: string, layout: LibraryTreeLayout): void {
  if (!libraryRoot.trim()) return;
  const envelope = loadEnvelope();
  const libKey = normalizeLibraryPathKey(libraryRoot);
  const cleaned = sanitizeLibraryLayout(layout);
  if (Object.keys(cleaned).length === 0) delete envelope.libraries[libKey];
  else envelope.libraries[libKey] = cleaned;
  saveEnvelope(envelope);
}
