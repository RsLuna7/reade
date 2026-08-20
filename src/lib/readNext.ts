import type {
  CollectionItem,
  CollectionSummary,
  DocumentExtent,
  DocumentInfo,
  DocumentLinks,
} from "./backend";
import { highWaterCoverage } from "./readingTimeEstimate";
import type { ReadingPosition } from "./readingPositions";
import { findChildNodes, normalizeRelativePath, parentDirectoryPath, treePathCollator, type FileTreeNode } from "./tree";
import { buildLaidOutDocumentTree, type LibraryTreeLayout } from "./treeLayout";

/**
 * 读完接着读（plan-read-next）：三级回落的"下一篇"推荐纯逻辑。
 * ① 合集顺位 → ② 同文件夹树序 → ③ 反链热度；全空返回 null。
 * 数据全部来自既有 IPC/存储，本模块自身零副作用。
 */

export type ReadNextReason = "collection" | "folder" | "backlinks";

export interface ReadNextSuggestion {
  relativePath: string;
  reason: ReadNextReason;
}

/** 触发条件（RN-D2）：哨兵可见 且 滚动高水位 ≥ 0.98。 */
export const READ_NEXT_MIN_SCROLL_RATIO = 0.98;
/** 末尾驻留 800ms 后才浮现，防误触。 */
export const READ_NEXT_DWELL_MS = 800;
/** 反链档的"未读完"阈值：覆盖率 < 0.98 才推荐。 */
export const READ_NEXT_UNREAD_COVERAGE = 0.98;

export function shouldTriggerReadNext(sentinelVisible: boolean, scrollRatio: number): boolean {
  return sentinelVisible && scrollRatio >= READ_NEXT_MIN_SCROLL_RATIO;
}

/** ①合集内下一条：跳过失联条目；末条不回环（RN-D1）。 */
export function pickNextInCollection(
  items: readonly CollectionItem[],
  currentPath: string,
): string | null {
  const index = items.findIndex((item) => item.relativePath === currentPath);
  if (index < 0) return null;
  for (let cursor = index + 1; cursor < items.length; cursor += 1) {
    if (items[cursor].present) return items[cursor].relativePath;
  }
  return null;
}

/**
 * ②同文件夹下一篇：与文档树同一套置顶/手排后的树序；
 * 当前已是末篇时不跨文件夹（跨目录跳跃突兀）。
 */
export function pickNextInFolder(
  documents: readonly DocumentInfo[],
  currentPath: string,
  layout: LibraryTreeLayout = {},
): string | null {
  const current = documents.find((document) => document.relativePath === currentPath);
  if (!current) return null;
  const parent = parentDirectoryPath(currentPath) ?? "";
  const children = findChildNodes(buildLaidOutDocumentTree(documents, layout), parent) ?? [];
  const siblings = children.filter((node): node is FileTreeNode => node.kind === "document");
  const currentKey = normalizeRelativePath(currentPath);
  const index = siblings.findIndex(
    (node) => normalizeRelativePath(node.path) === currentKey,
  );
  if (index < 0 || index + 1 >= siblings.length) return null;
  return siblings[index + 1].path;
}

export interface BacklinkCandidateContext {
  documents: readonly DocumentInfo[];
  positions: Record<string, ReadingPosition>;
  extents: ReadonlyMap<string, DocumentExtent> | null;
}

/**
 * ③反链热度：与当前文档互链的邻居里，取链接次数最高且未读完者；
 * 并列按 collator 比较 relativePath（树序的可接受近似，定稿 §6.1）。
 */
export function pickByBacklinks(
  links: DocumentLinks,
  currentPath: string,
  context: BacklinkCandidateContext,
): string | null {
  const present = new Map(
    context.documents.map((document) => [document.relativePath, document]),
  );
  const weights = new Map<string, number>();
  for (const backlink of links.backlinks) {
    if (!present.has(backlink.sourcePath)) continue;
    weights.set(
      backlink.sourcePath,
      (weights.get(backlink.sourcePath) ?? 0) + Math.max(1, backlink.count),
    );
  }
  for (const outgoing of links.outgoing) {
    if (outgoing.kind === "asset") continue;
    const target = outgoing.targetPath;
    if (!target || !present.has(target)) continue;
    weights.set(target, (weights.get(target) ?? 0) + 1);
  }
  weights.delete(currentPath);

  let best: { path: string; weight: number } | null = null;
  for (const [path, weight] of weights) {
    const coverage = highWaterCoverage(
      context.positions[path] ?? null,
      context.extents?.get(path)?.segmentCount ?? null,
    );
    // 无阅读记录视为未读;已读完(≥0.98)的邻居不再推荐。
    if (coverage !== null && coverage >= READ_NEXT_UNREAD_COVERAGE) continue;
    if (
      !best ||
      weight > best.weight ||
      (weight === best.weight && treePathCollator.compare(path, best.path) < 0)
    ) {
      best = { path, weight };
    }
  }
  return best?.path ?? null;
}

export interface ResolveReadNextInput extends BacklinkCandidateContext {
  currentPath: string;
  listCollections: () => Promise<CollectionSummary[]>;
  listCollectionItems: (collectionId: string) => Promise<CollectionItem[]>;
  listDocumentLinks: (relativePath: string) => Promise<DocumentLinks>;
  /** 同文件夹档与文档树共用的置顶/手排；缺省为默认 Collator 序。 */
  treeLayout?: LibraryTreeLayout;
}

/**
 * 三级回落编排：①合集（属多个时取 updatedAt 最新者）→ ②同文件夹 →
 * ③反链热度。任何一级的数据获取失败都静默滑向下一级；反链 IPC 只在
 * 前两档落空时发生（§3.3 数据成本）。
 */
export async function resolveReadNextSuggestion(
  input: ResolveReadNextInput,
): Promise<ReadNextSuggestion | null> {
  const { currentPath } = input;
  try {
    const collections = [...(await input.listCollections())].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
    for (const collection of collections) {
      const items = await input.listCollectionItems(collection.id);
      if (!items.some((item) => item.relativePath === currentPath)) continue;
      // 当前文档属于该合集(updatedAt 最新的归属):只在这一个合集里找
      // 下一条,找不到(末条/后续全失联)则进入②,不再看更旧的合集。
      const next = pickNextInCollection(items, currentPath);
      if (next) return { relativePath: next, reason: "collection" };
      break;
    }
  } catch {
    // 合集读取失败 → 静默进入②。
  }

  const folderNext = pickNextInFolder(input.documents, currentPath, input.treeLayout ?? {});
  if (folderNext) return { relativePath: folderNext, reason: "folder" };

  try {
    const links = await input.listDocumentLinks(currentPath);
    const linked = pickByBacklinks(links, currentPath, input);
    if (linked) return { relativePath: linked, reason: "backlinks" };
  } catch {
    // Web 端超 500 篇禁用或桌面读取失败 → 无推荐。
  }
  return null;
}

export const READ_NEXT_REASON_LABEL: Record<ReadNextReason, string> = {
  collection: "合集顺序",
  folder: "同文件夹",
  backlinks: "关联最多",
};
