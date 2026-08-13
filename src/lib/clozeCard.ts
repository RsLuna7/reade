import { extractRelatedFragments } from "./relatedFragments";

/**
 * 回顾挖空闪卡的纯函数层（docs/plan-cloze-review.md §3.1）：挖空只是
 * 回顾卡的另一种渲染档——调度、ReviewState、IPC 零改动。片段选择复用
 * 相关段落的 `extractRelatedFragments` 显著性启发（CZ-D1），挖空区间
 * 每次由本模块确定性重算，不写入任何数据（CZ-D4）。
 */

export type ReviewCardMode = "excerpt" | "cloze" | "mixed";

export const REVIEW_CARD_MODES: readonly ReviewCardMode[] = ["excerpt", "cloze", "mixed"];

/** 摘录 trim 后少于该 code point 数不挖空（CZ-D5）。 */
export const CLOZE_MIN_EXCERPT_CHARS = 12;
/** 挖空后前后文合并的非空白 code point 下限（CZ-D5）。 */
export const CLOZE_MIN_CONTEXT_CHARS = 6;

export interface ClozeCard {
  prefix: string;
  /** 被挖空的片段，即揭示后的答案。 */
  blank: string;
  suffix: string;
}

export function normalizeReviewCardMode(
  value: unknown,
  fallback: ReviewCardMode = "excerpt",
): ReviewCardMode {
  return typeof value === "string" && (REVIEW_CARD_MODES as readonly string[]).includes(value)
    ? (value as ReviewCardMode)
    : fallback;
}

/**
 * 摘录 → 三段式挖空卡；null = 回落为摘录档渲染（CZ-D5）。
 *
 * `extractRelatedFragments` 的片段是摘录的字面子串（切 run 不改写
 * 字符，去重保留首次出现的原始大小写，两端同为 2,000 字符上限），
 * 因此 `indexOf` 即为首次出现区间；未命中仅是防御分支（§8 定稿补记）。
 */
export function buildClozeCard(excerpt: string): ClozeCard | null {
  if (Array.from(excerpt.trim()).length < CLOZE_MIN_EXCERPT_CHARS) return null;
  const [top] = extractRelatedFragments(excerpt);
  if (!top) return null;
  const index = excerpt.indexOf(top);
  if (index < 0) return null;
  const prefix = excerpt.slice(0, index);
  const suffix = excerpt.slice(index + top.length);
  const contextChars = Array.from((prefix + suffix).replace(/\s+/gu, "")).length;
  if (contextChars < CLOZE_MIN_CONTEXT_CHARS) return null;
  return { prefix, blank: top, suffix };
}

/** FNV-1a（reviewScheduler 的 seededRank 同族实现，无种子）。 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 档位 → 当前卡的实际渲染档：mixed 按 annotationId 的 FNV-1a 奇偶
 * 确定性分派（偶 = 挖空，奇 = 摘录），同卡永远同档（CZ-D6）。
 */
export function clozeModeForCard(
  annotationId: string,
  mode: ReviewCardMode,
): "excerpt" | "cloze" {
  if (mode !== "mixed") return mode;
  return fnv1a(annotationId) % 2 === 0 ? "cloze" : "excerpt";
}

/**
 * 胶囊宽度近似（CZ-D8，纯展示启发）：CJK 等宽字符计 1em、其余计
 * 0.55em，钳制在 2.5–16em；只求"大致等宽"，不承诺像素精确。
 */
export function clozeBlankWidthEm(blank: string): number {
  let width = 0;
  for (const ch of Array.from(blank)) {
    width += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 1 : 0.55;
  }
  return Math.min(16, Math.max(2.5, Math.round(width * 10) / 10));
}
