import type { Annotation } from "./backend";
import { annotationKindLabel } from "./annotations";

/**
 * 位置排序键:按元素逐位比较的数字元组。
 * 约定按文档格式取值(同一文档内格式一致,因此可比):
 * - pdf:[页码]
 * - epub:[章节序, 段落序, 起始偏移]
 * - markdown:[全文文本偏移](需调用方结合 DOM 解析后传入)
 */
export type AnnotationSortKey = readonly number[];

/** 比较两个排序键;空键(无法解析位置)排最后。 */
export function compareAnnotationSortKeys(
  a: AnnotationSortKey | null | undefined,
  b: AnnotationSortKey | null | undefined,
): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * 仅凭 locator 推导排序键的兜底策略(不依赖 DOM):
 * pdf 用页码;epub 正文标注用段落序与偏移;markdown 引文与
 * epub/markdown 书签无法离线定位,返回 null 由调用方排最后。
 */
export function locatorSortKey(annotation: Annotation): AnnotationSortKey | null {
  const locator = annotation.locator;
  if (locator.kind === "pdf") return [locator.page, 0, 0];
  if (locator.kind === "epub") return [locator.blockIndex, locator.startOffset];
  if (locator.kind === "bookmark" && locator.target.format === "pdf") {
    return [locator.target.page, 0, 0];
  }
  return null;
}

/** 标注的位置元信息文案(页码/章节/heading),没有可展示信息时返回 null。 */
export function annotationPositionLabel(annotation: Annotation): string | null {
  const locator = annotation.locator;
  if (locator.kind === "pdf") {
    return `第 ${locator.page} 页${locator.view === "reading" ? "(阅读视图)" : ""}`;
  }
  if (locator.kind === "epub") return `章节 ${locator.chapterId}`;
  if (locator.kind === "markdown") {
    return locator.headingId ? `标题 ${locator.headingId}` : null;
  }
  const target = locator.target;
  if (target.format === "pdf") return `第 ${target.page} 页`;
  if (target.format === "epub") {
    return target.headingId ? `标题 ${target.headingId}` : `章节 ${target.chapterId}`;
  }
  return target.headingId
    ? `标题 ${target.headingId}`
    : `进度 ${Math.round(target.scrollRatio * 100)}%`;
}

function defaultFormatDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface BuildAnnotationsMarkdownOptions {
  /** relativePath → 文档标题;缺失时直接使用路径。 */
  documentTitles?: ReadonlyMap<string, string>;
  /** annotation id → 位置排序键;缺失的条目退回 locator 推导,再失败排最后。 */
  sortKeys?: ReadonlyMap<string, AnnotationSortKey>;
  /** 顶层标题;传 null 省略,默认 "标注摘录"。 */
  heading?: string | null;
  /** 日期格式化,默认本地时区 YYYY-MM-DD;测试可注入固定实现。 */
  formatDate?: (timestamp: number) => string;
}

/**
 * 把标注数组导出为 Markdown 摘录:按文档分组(组间按路径排序),
 * 组内尽量按位置排序(无法解析的排最后,再按创建时间);每条包含
 * 类型徽标、`> 摘录文本`、笔记、位置元信息与日期。
 */
export function buildAnnotationsMarkdown(
  annotations: readonly Annotation[],
  options: BuildAnnotationsMarkdownOptions = {},
): string {
  if (!annotations.length) return "";
  const formatDate = options.formatDate ?? defaultFormatDate;

  const groups = new Map<string, Annotation[]>();
  for (const annotation of annotations) {
    const list = groups.get(annotation.relativePath);
    if (list) list.push(annotation);
    else groups.set(annotation.relativePath, [annotation]);
  }
  const sortedPaths = Array.from(groups.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const lines: string[] = [];
  if (options.heading !== null) {
    lines.push(`# ${options.heading ?? "标注摘录"}`, "");
  }

  for (const path of sortedPaths) {
    const items = groups.get(path) ?? [];
    const title = options.documentTitles?.get(path) ?? path;
    lines.push(`## ${title}(${items.length} 条)`, "");

    const sorted = [...items].sort((a, b) => {
      const keyA = options.sortKeys?.get(a.id) ?? locatorSortKey(a);
      const keyB = options.sortKeys?.get(b.id) ?? locatorSortKey(b);
      return (
        compareAnnotationSortKeys(keyA, keyB) ||
        a.createdAt - b.createdAt ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );
    });

    for (const annotation of sorted) {
      const meta = [`**${annotationKindLabel(annotation.kind)}**`];
      const position = annotationPositionLabel(annotation);
      if (position) meta.push(position);
      const date = formatDate(annotation.updatedAt);
      if (date) meta.push(date);
      lines.push(`- ${meta.join(" · ")}`, "");

      const excerpt = annotation.selectedText?.trim() ?? "";
      if (excerpt) {
        for (const line of excerpt.split(/\r?\n/)) {
          lines.push(`  > ${line}`);
        }
        lines.push("");
      } else if (annotation.kind === "bookmark" && annotation.title?.trim()) {
        lines.push(`  ${annotation.title.trim()}`, "");
      }

      const note = annotation.note?.trim() ?? "";
      if (note) {
        lines.push(`  笔记:${note}`, "");
      }
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
