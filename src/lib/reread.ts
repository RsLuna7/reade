/**
 * 增量重读的前端纯逻辑（docs/plan-incremental-reread.md §3/§8）：
 * 横幅文案、"下一处"游标、离开捕获门与变更段落的 DOM 边缘标记。
 * diff 本体由 Rust 的 read_snapshot_diff 计算，这里只消费其结果；
 * 所有函数不持有状态，App 层负责编排。
 */

import type { ReadSnapshotDiff } from "./backend";

/** 打开后驻留满该时长即捕获一次快照（IR-D2，覆盖直接关窗场景）。 */
export const REREAD_DWELL_CAPTURE_MS = 30_000;

/** 变更块的 DOM 标记属性；CSS 依赖它画左缘 accent 线。 */
export const REREAD_MARK_ATTRIBUTE = "data-reread-changed";

/**
 * 横幅主文案。页级（PDF）只报页码不做行内标记（IR-D4）；
 * truncated 表示 diff 已降级为"整篇有更新"（IR-D3）。
 */
export function rereadBannerMessage(diff: ReadSnapshotDiff): string {
  if (diff.truncated) return "自上次阅读后有大量更新";
  const added = diff.changedSegments.filter((segment) => segment.kind === "added").length;
  const modified = diff.changedSegments.length - added;
  if (diff.granularity === "page") {
    const pages = diff.changedSegments.map((segment) => segment.index + 1);
    const label = formatOrdinalList(pages);
    const removedSuffix = diff.removedCount > 0 ? `，另有 ${diff.removedCount} 页删除` : "";
    if (label) return `自上次阅读后第 ${label} 页有变化${removedSuffix}`;
    return `自上次阅读后有 ${diff.removedCount} 页删除`;
  }
  const unit = diff.granularity === "chapter" ? "章" : "段";
  const parts: string[] = [];
  if (modified > 0) parts.push(`${modified} ${unit}修改`);
  if (added > 0) parts.push(`${added} ${unit}新增`);
  if (diff.removedCount > 0) parts.push(`${diff.removedCount} ${unit}删除`);
  if (parts.length === 0) return "自上次阅读后有更新";
  return `自上次阅读后有更新：${parts.join("、")}`;
}

/** 页码/序号列表文案，最多列 5 个，超出以"等 N 处"收尾。 */
function formatOrdinalList(ordinals: number[]): string {
  if (ordinals.length === 0) return "";
  const shown = ordinals.slice(0, 5).join("、");
  return ordinals.length > 5 ? `${shown} 等 ${ordinals.length} 处` : shown;
}

/**
 * "下一处"仅在有可跳转的行内标记时出现：markdown 段级与 EPUB 章级；
 * PDF 页级与 truncated 降级都只保留文案 + "知道了"（IR-D4/IR-D7）。
 */
export function rereadJumpEnabled(diff: ReadSnapshotDiff): boolean {
  return (
    !diff.truncated &&
    diff.changedSegments.length > 0 &&
    (diff.granularity === "paragraph" || diff.granularity === "chapter")
  );
}

/** "下一处"循环游标（初始 cursor 为 -1）。 */
export function nextRereadCursor(cursor: number, total: number): number {
  if (total <= 0) return -1;
  return (cursor + 1) % total;
}

/**
 * 离开/切换文档时的捕获门（IR-D2）：仅当磁盘指纹自打开起未变才捕获，
 * 防止把阅读期间被外部改写、用户从未看过的新版本误记为已读。
 * `latest` 为 null 表示文档已从库中消失，不捕获。
 */
export function shouldCaptureOnLeave(
  opened: { size: number; modified: number },
  latest: { size: number; modified: number } | null,
): boolean {
  return latest !== null && latest.size === opened.size && latest.modified === opened.modified;
}

/**
 * 渲染偏移：diff 的行号基于磁盘原文，而正文渲染用的是
 * `displayMarkdown(source)`（剥掉 BOM、frontmatter 和首 H1），DOM 位置戳
 * 因此整体前移。返回被剥掉的行数（displayed 第 1 行对应原文第
 * offset+1 行）；displayed 不是原文尾串时返回 0（防御，不应发生）。
 */
export function markdownLineOffset(source: string, displayed: string): number {
  if (!displayed) return 0;
  const withoutBom = source.replace(/^\uFEFF/, "");
  const index = withoutBom.indexOf(displayed);
  if (index <= 0) return 0;
  let lines = 0;
  for (let at = 0; at < index; at += 1) {
    if (withoutBom.charCodeAt(at) === 10) lines += 1;
  }
  return lines;
}

/**
 * 把 diff 的变更单元映射到 DOM 边缘标记。
 *
 * - markdown（段级）：在带 `data-source-start/end` 位置戳的块级元素上，
 *   找与变更段行号区间相交的块（DOM 行号先加 `lineOffset` 换回原文
 *   行号）；嵌套时只标最深的块（避免 blockquote 和其内段落双线）。
 * - EPUB（章级）：按序号标 `.epub-chapter` 容器（§8 定稿收窄）。
 * - PDF（页级）与 truncated：不做行内标记，返回空数组。
 *
 * 返回按文档顺序排列的被标记元素，供"下一处"循环跳转。
 */
export function applyRereadMarks(
  root: ParentNode,
  diff: ReadSnapshotDiff,
  lineOffset = 0,
): HTMLElement[] {
  clearRereadMarks(root);
  if (diff.truncated || diff.granularity === "page") return [];

  if (diff.granularity === "chapter") {
    const chapters = Array.from(root.querySelectorAll<HTMLElement>(".epub-chapter"));
    const marked: HTMLElement[] = [];
    for (const segment of diff.changedSegments) {
      const chapter = chapters[segment.index];
      if (chapter && !marked.includes(chapter)) {
        chapter.setAttribute(REREAD_MARK_ATTRIBUTE, segment.kind);
        marked.push(chapter);
      }
    }
    return marked;
  }

  const anchors = diff.changedSegments
    .filter((segment) => segment.startLine !== null)
    .map((segment) => ({
      start: segment.startLine as number,
      end: segment.endLine ?? (segment.startLine as number),
      kind: segment.kind,
    }));
  if (anchors.length === 0) return [];

  const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-source-start]"));
  const candidates = new Map<HTMLElement, string>();
  for (const block of blocks) {
    const domStart = Number.parseInt(block.getAttribute("data-source-start") ?? "", 10);
    if (!Number.isFinite(domStart)) continue;
    const domEnd = Number.parseInt(block.getAttribute("data-source-end") ?? "", 10);
    const start = domStart + lineOffset;
    const end = (Number.isFinite(domEnd) ? domEnd : domStart) + lineOffset;
    const anchor = anchors.find((range) => start <= range.end && end >= range.start);
    if (anchor) candidates.set(block, anchor.kind);
  }
  // 嵌套去重：候选块若包含另一个候选块，只保留后者（最深的块）。
  const marked: HTMLElement[] = [];
  for (const [block, kind] of candidates) {
    const containsAnother = Array.from(candidates.keys()).some(
      (other) => other !== block && block.contains(other),
    );
    if (!containsAnother) {
      block.setAttribute(REREAD_MARK_ATTRIBUTE, kind);
      marked.push(block);
    }
  }
  return marked;
}

/** 清掉全部边缘标记（横幅关闭、文档切换或重渲染前）。 */
export function clearRereadMarks(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll(`[${REREAD_MARK_ATTRIBUTE}]`))) {
    element.removeAttribute(REREAD_MARK_ATTRIBUTE);
  }
}
