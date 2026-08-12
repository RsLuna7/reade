/**
 * 命令面板的匹配与排序纯函数（docs/plan-command-palette.md §3.1）。
 *
 * 手写零依赖：查询按空白切 token，全部 token 命中才保留条目；单 token 对
 * 单字段先试连续子串（高分），未中且为纯 ASCII 时退子序列匹配（低分），
 * 含 CJK 的 token 只接受子串命中（CP-D1：避免"数学"子序列命中
 * "数量学说"之类的假阳性）。字段权重 title ×3、keywords ×2、subtitle ×1。
 */

export type PaletteEntryKind = "document" | "collection" | "command";

export interface PaletteEntry {
  kind: PaletteEntryKind;
  /** 稳定标识：`doc:<path>` / `col:<id>` / `cmd:<key>`。 */
  id: string;
  /** 主匹配文本：文档标题、合集名、命令名。 */
  title: string;
  /** 次级文本（相对路径、命令提示），权重最低，界面里作副行展示。 */
  subtitle?: string;
  /** 隐形别名（如命令的英文关键词），可匹配但不展示。 */
  keywords?: string;
  /** 徽标文案：MD/MDX/PDF/EPUB/合集/命令。 */
  badge?: string;
}

/** 结果条数上限（CP-D4：一屏内可 ↑↓ 遍历完）。 */
export const PALETTE_RESULT_LIMIT = 12;

/** CJK 统一表意文字 + 日文假名 + 半角片假名 + CJK 兼容区。 */
const CJK_PATTERN =
  /[\u2e80-\u2eff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

export function hasCjk(text: string): boolean {
  return CJK_PATTERN.test(text);
}

/** 词界：空白、路径分隔、常见标点后的位置视为"词首"。 */
function isBoundaryChar(char: string): boolean {
  return /[\s/\\\-_.·．，。()（）\[\]【】:：]/.test(char);
}

/**
 * 连续子串打分；未命中返回 null。
 * 基础 80 分 + 前缀 40 / 词界 20 加成 − 位置惩罚（封顶 20）+ 长度加成。
 */
export function substringScore(token: string, text: string): number | null {
  const index = text.indexOf(token);
  if (index < 0) return null;
  let score = 80;
  if (index === 0) score += 40;
  else if (isBoundaryChar(text[index - 1])) score += 20;
  score -= Math.min(index, 20);
  score += Math.min(token.length * 4, 40);
  return score;
}

/**
 * ASCII 子序列打分（"rdme" 命中 "readme"）；未命中返回 null。
 * 基础 20 分，逐字符 +2，紧邻上一命中 +4，词首命中 +6，首命中位置惩罚封顶 10。
 * 基础分低于子串路径，保证"连续子串 > 子序列"的排序直觉。
 */
export function subsequenceScore(token: string, text: string): number | null {
  let score = 20;
  let searchFrom = 0;
  let previousIndex = -2;
  for (const char of token) {
    const index = text.indexOf(char, searchFrom);
    if (index < 0) return null;
    score += 2;
    if (index === previousIndex + 1) score += 4;
    if (index === 0 || isBoundaryChar(text[index - 1])) score += 6;
    if (previousIndex < 0) score -= Math.min(index, 10);
    previousIndex = index;
    searchFrom = index + 1;
  }
  return score;
}

/**
 * 单 token 对单字段：子串优先；纯 ASCII token 退子序列；CJK token 仅子串。
 */
export function tokenScore(token: string, text: string): number | null {
  const contiguous = substringScore(token, text);
  if (contiguous !== null) return contiguous;
  if (hasCjk(token)) return null;
  return subsequenceScore(token, text);
}

const FIELD_WEIGHTS = [
  ["title", 3],
  ["keywords", 2],
  ["subtitle", 1],
] as const;

const KIND_PRIORITY: Record<PaletteEntryKind, number> = {
  document: 0,
  collection: 1,
  command: 2,
};

/**
 * 条目总分：每个 token 取各字段加权分的最大值，全部 token 命中才有分；
 * 任一 token 落空返回 null（AND 语义，token 可命中不同字段）。
 */
export function entryScore(entry: PaletteEntry, tokens: readonly string[]): number | null {
  let total = 0;
  for (const token of tokens) {
    let best: number | null = null;
    for (const [field, weight] of FIELD_WEIGHTS) {
      const raw = entry[field];
      if (!raw) continue;
      const score = tokenScore(token, raw.toLowerCase());
      if (score !== null && (best === null || score * weight > best)) {
        best = score * weight;
      }
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

export function normalizePaletteQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * 过滤 + 排序。空查询按传入顺序取前 limit 条（App 的传入顺序即默认顺序：
 * 文档 → 合集 → 命令）；有查询按分数降序，平分先按 kind 优先级再按
 * 原始顺序，保证稳定可预测。
 */
export function filterPaletteEntries<T extends PaletteEntry>(
  entries: readonly T[],
  query: string,
  limit = PALETTE_RESULT_LIMIT,
): T[] {
  const tokens = normalizePaletteQuery(query);
  if (tokens.length === 0) return entries.slice(0, limit);

  const scored: Array<{ entry: T; score: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const score = entryScore(entry, tokens);
    if (score !== null) scored.push({ entry, score, index });
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const kindDelta = KIND_PRIORITY[a.entry.kind] - KIND_PRIORITY[b.entry.kind];
    if (kindDelta !== 0) return kindDelta;
    return a.index - b.index;
  });
  return scored.slice(0, limit).map(({ entry }) => entry);
}
