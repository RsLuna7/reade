import type { Annotation } from "./backend";
import { annotationKindLabel } from "./annotations";
import { annotationPositionLabel } from "./annotationExport";
import { buildTocAttributor, type TocAttributorInput } from "./tocHeat";

/**
 * 全书回顾编纂（docs/plan-book-digest.md §3.1）——纯函数：把单文档的全部
 * 摘录类标注按 TOC 结构穿插成"读书报告"分组，章节归因与 tocHeat 共用
 * `buildTocAttributor`（BD-D2）；书签与空摘录跳过并计数（BD-D4）。
 */

export interface DigestSection {
  /** null = 末尾"未归属"节（文首选区、改名章节、无 TOC 文档）。 */
  tocId: string | null;
  heading: string;
  /** TocItem.level（1..6）；未归属节固定 1。 */
  level: number;
  items: Annotation[];
}

export interface BookDigest {
  sections: DigestSection[];
  /** 进入编纂的摘录条数。 */
  excerptCount: number;
  /** 其中带笔记的条数。 */
  noteCount: number;
  /** 被跳过的书签条数（BD-D4 计数注明）。 */
  skippedBookmarks: number;
  /** TOC 为空时为 true：报告退化为无章节的平铺列表。 */
  flat: boolean;
}

export const DIGEST_UNASSIGNED_HEADING = "未归属章节";

export interface BuildBookDigestInput extends TocAttributorInput {
  annotations: Annotation[];
}

function compareInSection(a: Annotation, b: Annotation): number {
  // sortIndex 是后端校验过的定宽位置键（字符串序 = 文档序），首选；
  // 相同（如同点多笔）回落创建时间与 id，保证确定性。
  if (a.sortIndex < b.sortIndex) return -1;
  if (a.sortIndex > b.sortIndex) return 1;
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** 按 TOC 顺序编纂章节分组；无标注章节跳过，未归属置尾。 */
export function buildBookDigest(input: BuildBookDigestInput): BookDigest {
  const resolve = buildTocAttributor(input);

  const grouped = new Map<string | null, Annotation[]>();
  let excerptCount = 0;
  let noteCount = 0;
  let skippedBookmarks = 0;
  for (const annotation of input.annotations) {
    if (annotation.deletedAt != null) continue;
    if (annotation.kind === "bookmark") {
      skippedBookmarks += 1;
      continue;
    }
    if (!annotation.selectedText?.trim()) continue;
    excerptCount += 1;
    if (annotation.note?.trim()) noteCount += 1;
    const tocId = resolve(annotation.locator);
    const list = grouped.get(tocId);
    if (list) list.push(annotation);
    else grouped.set(tocId, [annotation]);
  }

  const sections: DigestSection[] = [];
  for (const item of input.items) {
    const items = grouped.get(item.id);
    if (!items) continue;
    grouped.delete(item.id);
    sections.push({
      tocId: item.id,
      heading: item.title,
      level: item.level,
      items: items.sort(compareInSection),
    });
  }
  const unassigned = grouped.get(null);
  if (unassigned) {
    sections.push({
      tocId: null,
      heading: DIGEST_UNASSIGNED_HEADING,
      level: 1,
      items: unassigned.sort(compareInSection),
    });
  }

  return {
    sections,
    excerptCount,
    noteCount,
    skippedBookmarks,
    flat: input.items.length === 0,
  };
}

function defaultFormatDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface BuildDigestMarkdownOptions {
  /** 日期格式化，默认本地 YYYY-MM-DD；测试可注入固定实现。 */
  formatDate?: (timestamp: number) => string;
}

/** 编纂统计行文案（视图与导出共用同一措辞）。 */
export function digestStatsLine(digest: BookDigest): string {
  const parts = [`${digest.excerptCount} 条摘录`, `${digest.noteCount} 条笔记`];
  if (digest.skippedBookmarks > 0) parts.push(`已略过 ${digest.skippedBookmarks} 条书签`);
  return parts.join(" · ");
}

/**
 * 导出为 Markdown（BD-D3：前端下载通道）：`#` 文档标题、`##`+ 章节（按
 * TocItem.level 加深、钳制到 ######）、`>` 摘录、笔记行与位置元信息。
 * TOC 为空时退化为无章节标题的平铺列表。
 */
export function buildDigestMarkdown(
  digest: BookDigest,
  title: string,
  options: BuildDigestMarkdownOptions = {},
): string {
  const formatDate = options.formatDate ?? defaultFormatDate;
  const lines: string[] = [`# ${title} · 读书报告`, "", digestStatsLine(digest), ""];

  for (const section of digest.sections) {
    if (!digest.flat) {
      const depth = Math.min(6, Math.max(2, section.level + 1));
      lines.push(`${"#".repeat(depth)} ${section.heading}`, "");
    }
    for (const annotation of section.items) {
      const excerpt = annotation.selectedText?.trim() ?? "";
      for (const line of excerpt.split(/\r?\n/)) {
        lines.push(`> ${line}`);
      }
      lines.push("");
      const note = annotation.note?.trim() ?? "";
      if (note) lines.push(`笔记：${note}`, "");
      const meta = [annotationKindLabel(annotation.kind)];
      const position = annotationPositionLabel(annotation);
      if (position) meta.push(position);
      const date = formatDate(annotation.createdAt);
      if (date) meta.push(date);
      lines.push(`— ${meta.join(" · ")}`, "");
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** 下载文件名：非法文件名字符替换为 -。 */
export function digestFileName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || "文档";
  return `reade-读书报告-${safe}.md`;
}
