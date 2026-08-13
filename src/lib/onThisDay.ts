import type { Annotation, DocumentInfo, ReadingSession } from "./backend";
import { aggregateDayDocuments, localDayKey } from "./readingStats";

/**
 * 主页「那年今日」卡的纯数据层（docs/plan-on-this-day.md §3.1）：
 * 取一年前 / 一个月前的本地日历日窗口内创建的标注（优先）与当天
 * 读过的文档（补位），空数组 = 整卡不渲染。会话数据复用 HomeView
 * 已加载的全量 sessions（OD-D9），本模块零 IO。
 */

export const ON_THIS_DAY_MAX_ENTRIES = 3;
/** 文档补位的当日阅读时长门槛（OD-D6）。 */
export const ON_THIS_DAY_MIN_DOC_SECONDS = 300;
/** 摘录截断长度，按 code point 计（OD-D7）。 */
export const ON_THIS_DAY_EXCERPT_CHARS = 60;

export type OnThisDayEntry =
  | {
      kind: "annotation";
      /** 完整标注对象：点击行直接走既有标注跳转链（OD-D8）。 */
      annotation: Annotation;
      excerpt: string;
      docTitle: string;
    }
  | {
      kind: "document";
      relativePath: string;
      title: string;
      format: DocumentInfo["format"];
      /** 目标日内的合计阅读秒数（跨日会话已按比例裁剪）。 */
      activeSeconds: number;
    };

export interface OnThisDayGroup {
  key: "year" | "month";
  label: "一年前" | "一个月前";
  /** 目标本地日历日，YYYY-MM-DD。 */
  dayKey: string;
  entries: OnThisDayEntry[];
}

export interface OnThisDayInput {
  annotations: Annotation[];
  /** 桌面传 HomeView 已加载的全量会话；Web 无会话存储，传 []。 */
  sessions: ReadingSession[];
  documents: DocumentInfo[];
  nowMs: number;
}

/**
 * 日历月减法 + 月末钳制（OD-D4）：先锚定目标年月的 1 号，再取
 * `min(原日, 目标月天数)`。避免 `Date.setMonth` 的溢出行为
 * （3/31 减 1 月会变成 3/3），并让"一年前"（-12 个月）在闰年
 * 2/29 回落到 2/28，而不是像"减 365 天"那样跨闰日漂移一天。
 */
export function shiftMonthsClamped(sourceMs: number, deltaMonths: number): Date {
  const source = new Date(sourceMs);
  const anchor = new Date(source.getFullYear(), source.getMonth() + deltaMonths, 1);
  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  anchor.setDate(Math.min(source.getDate(), daysInMonth));
  return anchor;
}

/** 空白折叠为单空格后取前 60 个 code point，截断加省略号（OD-D7）。 */
export function onThisDayExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  const chars = Array.from(collapsed);
  if (chars.length <= ON_THIS_DAY_EXCERPT_CHARS) return collapsed;
  return `${chars.slice(0, ON_THIS_DAY_EXCERPT_CHARS).join("")}…`;
}

/** 标注档准入（OD-D5）：有摘录的高亮/下划线；书签无摘录不参与。 */
function isMemoryAnnotation(annotation: Annotation): boolean {
  if (annotation.deletedAt != null) return false;
  if (annotation.kind !== "highlight" && annotation.kind !== "underline") return false;
  return Boolean(annotation.selectedText && annotation.selectedText.trim());
}

export function buildOnThisDay(input: OnThisDayInput): OnThisDayGroup[] {
  const present = new Map(
    input.documents.map((document) => [document.relativePath, document]),
  );
  const targets = [
    { key: "year", label: "一年前", months: -12 },
    { key: "month", label: "一个月前", months: -1 },
  ] as const;

  const groups: OnThisDayGroup[] = [];
  for (const target of targets) {
    const dayKey = localDayKey(shiftMonthsClamped(input.nowMs, target.months).getTime());
    const entries: OnThisDayEntry[] = [];
    const usedPaths = new Set<string>();

    const dayAnnotations = input.annotations
      .filter(
        (annotation) =>
          isMemoryAnnotation(annotation) &&
          present.has(annotation.relativePath) &&
          localDayKey(annotation.createdAt) === dayKey,
      )
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .slice(0, ON_THIS_DAY_MAX_ENTRIES);
    for (const annotation of dayAnnotations) {
      usedPaths.add(annotation.relativePath);
      entries.push({
        kind: "annotation",
        annotation,
        excerpt: onThisDayExcerpt(annotation.selectedText ?? ""),
        docTitle: present.get(annotation.relativePath)!.title,
      });
    }

    if (entries.length < ON_THIS_DAY_MAX_ENTRIES && input.sessions.length > 0) {
      // aggregateDayDocuments 已按当日裁剪并按时长降序。
      for (const total of aggregateDayDocuments(input.sessions, dayKey)) {
        if (entries.length >= ON_THIS_DAY_MAX_ENTRIES) break;
        if (total.seconds < ON_THIS_DAY_MIN_DOC_SECONDS) break;
        const document = present.get(total.relativePath);
        if (!document || usedPaths.has(total.relativePath)) continue;
        usedPaths.add(total.relativePath);
        entries.push({
          kind: "document",
          relativePath: total.relativePath,
          title: document.title,
          format: document.format,
          activeSeconds: total.seconds,
        });
      }
    }

    if (entries.length > 0) groups.push({ key: target.key, label: target.label, dayKey, entries });
  }
  return groups;
}
