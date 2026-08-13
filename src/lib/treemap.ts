import type { DocumentExtent, DocumentFormat, DocumentInfo } from "./backend";
import type { ReadingPosition } from "./readingPositions";
import { calendarLevel } from "./readingStats";
import { highWaterCoverage } from "./readingTimeEstimate";
import { buildDocumentTree, type DocumentTreeNode } from "./tree";

/**
 * 库覆盖率知识地图的纯函数层（docs/plan-coverage-treemap.md §3）。
 *
 * - `buildCoverageTree`：套 `buildDocumentTree` 的层级，把 extents 字符数
 *   （面积）与 readingPositions 高水位（覆盖率）聚合成一棵覆盖率树；
 *   文件夹字符数 = 子项之和，覆盖率 = 按字符数加权平均。
 * - `squarify`：手写经典 Bruls squarified treemap（零依赖），确定性布局。
 * - `coverageLevel`：覆盖率 → `--stats-scale-0..4` 五档（CT-D4，
 *   与热力图共用 `calendarLevel` 语义）。
 */

export interface CoverageNode {
  kind: "directory" | "document" | "other";
  /** 当前层内唯一键（目录/文档取规范化路径）。 */
  key: string;
  label: string;
  /** 文档为 `DocumentInfo.relativePath` 原值（selectDocument 直接可用）。 */
  path: string;
  /** 面积基数：索引文本字符数；索引未就绪回退文件字节数（CT-D1）。 */
  chars: number;
  /** 0..1 加权覆盖率（到达率语义：滚动/翻页高水位）。 */
  coverage: number;
  documentCount: number;
  format?: DocumentFormat;
  children: CoverageNode[];
}

/** 单层最多渲染的块数；超出部分聚合为"其他"块（§3.2）。 */
export const TREEMAP_MAX_TILES = 400;

function documentCoverageNode(
  node: Extract<DocumentTreeNode, { kind: "document" }>,
  extents: ReadonlyMap<string, DocumentExtent> | null,
  positions: Record<string, ReadingPosition>,
): CoverageNode {
  const extent = extents?.get(node.document.relativePath) ?? null;
  const chars =
    extent && extent.charCount > 0 ? extent.charCount : Math.max(0, node.document.size);
  const coverage =
    highWaterCoverage(positions[node.document.relativePath], extent?.segmentCount) ?? 0;
  return {
    kind: "document",
    key: node.id,
    label: node.name,
    path: node.document.relativePath,
    chars,
    coverage,
    documentCount: 1,
    format: node.document.format,
    children: [],
  };
}

function foldChildren(children: CoverageNode[]): { chars: number; coverage: number; count: number } {
  let chars = 0;
  let weighted = 0;
  let count = 0;
  for (const child of children) {
    chars += child.chars;
    weighted += child.coverage * child.chars;
    count += child.documentCount;
  }
  return { chars, coverage: chars > 0 ? weighted / chars : 0, count };
}

function directoryCoverageNode(
  node: Extract<DocumentTreeNode, { kind: "directory" }>,
  extents: ReadonlyMap<string, DocumentExtent> | null,
  positions: Record<string, ReadingPosition>,
): CoverageNode {
  const children = node.children.map((child) =>
    child.kind === "directory"
      ? directoryCoverageNode(child, extents, positions)
      : documentCoverageNode(child, extents, positions),
  );
  const { chars, coverage, count } = foldChildren(children);
  return {
    kind: "directory",
    key: node.id,
    label: node.name,
    path: node.path,
    chars,
    coverage,
    documentCount: count,
    children,
  };
}

/** 覆盖率树根节点：一级子节点 = 顶层文件夹 + 根目录散档。 */
export function buildCoverageTree(
  documents: DocumentInfo[],
  extents: ReadonlyMap<string, DocumentExtent> | null,
  positions: Record<string, ReadingPosition>,
): CoverageNode {
  const tree = buildDocumentTree(documents);
  const children = tree.map((node) =>
    node.kind === "directory"
      ? directoryCoverageNode(node, extents, positions)
      : documentCoverageNode(node, extents, positions),
  );
  const { chars, coverage, count } = foldChildren(children);
  return {
    kind: "directory",
    key: "directory:",
    label: "全部",
    path: "",
    chars,
    coverage,
    documentCount: count,
    children,
  };
}

/** 单层块数封顶：面积降序保留前 max-1 块，余量聚合为"其他"（不可下钻）。 */
export function limitTiles(children: CoverageNode[], max = TREEMAP_MAX_TILES): CoverageNode[] {
  if (children.length <= max) return children;
  const sorted = [...children].sort((a, b) => b.chars - a.chars);
  const kept = sorted.slice(0, Math.max(1, max - 1));
  const rest = sorted.slice(Math.max(1, max - 1));
  const { chars, coverage, count } = foldChildren(rest);
  kept.push({
    kind: "other",
    key: "other:aggregate",
    label: `其他 ${rest.length} 项`,
    path: "",
    chars,
    coverage,
    documentCount: count,
    children: [],
  });
  return kept;
}

export interface TreemapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedTile<T> {
  item: T;
  rect: TreemapRect;
}

interface RowState {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 经典 Bruls squarified 布局：面积降序放置、行内长宽比最优化。
 * 确定性（同输入同输出）；跳过非正值；面积按矩形总面积归一。
 */
export function squarify<T extends { chars: number }>(
  items: readonly T[],
  rect: TreemapRect,
): PlacedTile<T>[] {
  const positive = items.filter((item) => Number.isFinite(item.chars) && item.chars > 0);
  const total = positive.reduce((sum, item) => sum + item.chars, 0);
  if (total <= 0 || rect.width <= 0 || rect.height <= 0) return [];

  const sorted = [...positive].sort((a, b) => b.chars - a.chars);
  const scale = (rect.width * rect.height) / total;
  const areas = sorted.map((item) => item.chars * scale);

  const placed: PlacedTile<T>[] = [];
  const free: RowState = { ...rect };

  const worst = (row: number[], side: number): number => {
    const sum = row.reduce((value, area) => value + area, 0);
    let max = -Infinity;
    let min = Infinity;
    for (const area of row) {
      if (area > max) max = area;
      if (area < min) min = area;
    }
    const sideSquaredOverSum = (side * side) / (sum * sum);
    return Math.max(sideSquaredOverSum * max, 1 / (sideSquaredOverSum * min));
  };

  let rowStart = 0;
  let row: number[] = [];

  const layoutRow = () => {
    const rowArea = row.reduce((sum, area) => sum + area, 0);
    if (rowArea <= 0) return;
    if (free.width >= free.height) {
      // 竖直条带贴左缘，块自上而下。
      const thickness = rowArea / free.height;
      let offset = free.y;
      row.forEach((area, index) => {
        const length = area / thickness;
        placed.push({
          item: sorted[rowStart + index],
          rect: { x: free.x, y: offset, width: thickness, height: length },
        });
        offset += length;
      });
      free.x += thickness;
      free.width -= thickness;
    } else {
      // 水平条带贴上缘，块自左而右。
      const thickness = rowArea / free.width;
      let offset = free.x;
      row.forEach((area, index) => {
        const length = area / thickness;
        placed.push({
          item: sorted[rowStart + index],
          rect: { x: offset, y: free.y, width: length, height: thickness },
        });
        offset += length;
      });
      free.y += thickness;
      free.height -= thickness;
    }
    rowStart += row.length;
    row = [];
  };

  for (const area of areas) {
    const side = Math.min(free.width, free.height);
    if (row.length === 0 || worst([...row, area], side) <= worst(row, side)) {
      row.push(area);
    } else {
      layoutRow();
      row.push(area);
    }
  }
  if (row.length > 0) layoutRow();

  return placed;
}

/** 布局质量指标：所有块的最差长宽比（≥1，越接近 1 越"方"）。 */
export function worstAspectRatio(tiles: ReadonlyArray<PlacedTile<unknown>>): number {
  let worst = 1;
  for (const tile of tiles) {
    const { width, height } = tile.rect;
    if (width <= 0 || height <= 0) return Infinity;
    const ratio = Math.max(width / height, height / width);
    if (ratio > worst) worst = ratio;
  }
  return worst;
}

/** 覆盖率 → 五档色阶（0=未读 … 4=基本读完），与全产品热力语义一致。 */
export function coverageLevel(coverage: number): number {
  if (!Number.isFinite(coverage) || coverage <= 0) return 0;
  return calendarLevel(Math.min(1, coverage), 1);
}
