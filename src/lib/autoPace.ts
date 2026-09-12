/**
 * 自感应按段推进纯逻辑（plan-auto-pace）：停留时长、块倍率、会话感应
 * 与状态机。DOM 计时与吸附在 useAutoPace.ts。
 */

import { DEFAULT_CHARS_PER_MINUTE } from "./readingTimeEstimate";

/** 会话感应倍率钳制。 */
export const SESSION_FACTOR_MIN = 0.5;
export const SESSION_FACTOR_MAX = 1.8;
export const SESSION_FACTOR_DEFAULT = 1;

/** 持久偏好倍率（整体偏快/偏慢）。 */
export const AUTO_PACE_BIAS_MIN = 0.5;
export const AUTO_PACE_BIAS_MAX = 2;
export const AUTO_PACE_BIAS_DEFAULT = 1;

/** 极短块下限停留，避免连跳。 */
export const DWELL_MIN_MS = 400;
/** 单段上限，防超长块卡死。 */
export const DWELL_MAX_MS = 45_000;

/** 提前推进时 sessionFactor 乘子（学快）。 */
export const EARLY_ADVANCE_FACTOR = 0.92;
/** 超预算停留时 sessionFactor 乘子（学慢）。 */
export const OVERDUE_FACTOR = 1.08;
/** 已用时长超过预算的该比例才算「明显超预算」。 */
export const OVERDUE_RATIO = 1.35;

/** 连续无交互超时后自动暂停。 */
export const IDLE_PAUSE_MS = 90_000;

export type AutoPaceStatus = "off" | "armed" | "playing" | "paused";

export type AutoPaceBlockKind =
  | "paragraph"
  | "heading"
  | "code"
  | "math"
  | "other";

/** 块类型停留倍率（轻量内容感知）。 */
export function blockMultiplier(kind: AutoPaceBlockKind): number {
  switch (kind) {
    case "heading":
      return 0.55;
    case "code":
      return 1.8;
    case "math":
      return 1.6;
    case "paragraph":
    case "other":
    default:
      return 1;
  }
}

/**
 * 从元素推断块类型：标题 / 代码 / 公式优先，其余当正文。
 * 纯 DOM 探测，便于 hook 调用；无 element 时退回 other。
 */
export function classifyBlockElement(element: Element | null | undefined): AutoPaceBlockKind {
  if (!element || !(element instanceof HTMLElement)) return "other";
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "pre") return "code";
  if (element.querySelector(":scope > pre, :scope > .katex-display")) {
    return element.querySelector(":scope > pre") ? "code" : "math";
  }
  if (element.classList.contains("katex-display")) return "math";
  if (tag === "p" || tag === "li" || tag === "blockquote") return "paragraph";
  return "other";
}

/** 统计块内可读字符数（去掉多余空白）。 */
export function blockCharCount(element: Element | null | undefined): number {
  if (!element) return 0;
  const text = element.textContent ?? "";
  const collapsed = text.replace(/\s+/gu, "").trim();
  return collapsed.length;
}

export function clampSessionFactor(value: number): number {
  if (!Number.isFinite(value)) return SESSION_FACTOR_DEFAULT;
  return Math.min(SESSION_FACTOR_MAX, Math.max(SESSION_FACTOR_MIN, value));
}

export function clampAutoPaceBias(value: number): number {
  if (!Number.isFinite(value)) return AUTO_PACE_BIAS_DEFAULT;
  return Math.min(AUTO_PACE_BIAS_MAX, Math.max(AUTO_PACE_BIAS_MIN, value));
}

export function clampCharsPerMinute(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CHARS_PER_MINUTE;
  return value;
}

/**
 * 当前块预计停留毫秒：
 * (chars / cpm) * 60000 * sessionFactor / bias * blockMult，再钳 [DWELL_MIN, DWELL_MAX]。
 * sessionFactor 是停留乘数（提前推进调小 → 更快）；bias 像语速（越大越快）。
 */
export function dwellMsForBlock(input: {
  chars: number;
  charsPerMinute: number;
  sessionFactor?: number;
  bias?: number;
  kind?: AutoPaceBlockKind;
}): number {
  const chars = Number.isFinite(input.chars) && input.chars > 0 ? input.chars : 0;
  const cpm = clampCharsPerMinute(input.charsPerMinute);
  const session = clampSessionFactor(input.sessionFactor ?? SESSION_FACTOR_DEFAULT);
  const bias = clampAutoPaceBias(input.bias ?? AUTO_PACE_BIAS_DEFAULT);
  const mult = blockMultiplier(input.kind ?? "paragraph");
  const raw =
    chars <= 0 ? DWELL_MIN_MS : ((chars / cpm) * 60_000 * session * mult) / bias;
  if (!Number.isFinite(raw) || raw <= 0) return DWELL_MIN_MS;
  return Math.min(DWELL_MAX_MS, Math.max(DWELL_MIN_MS, Math.round(raw)));
}

/** 提前推进：学快（降低停留倍率）。 */
export function applyEarlyAdvance(sessionFactor: number): number {
  return clampSessionFactor(sessionFactor * EARLY_ADVANCE_FACTOR);
}

/** 明显超预算：学慢（提高停留倍率）。 */
export function applyOverdue(sessionFactor: number): number {
  return clampSessionFactor(sessionFactor * OVERDUE_FACTOR);
}

/** 已用时长是否显著超过预算。 */
export function isOverdue(elapsedMs: number, budgetMs: number): boolean {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(budgetMs) || budgetMs <= 0) return false;
  return elapsedMs >= budgetMs * OVERDUE_RATIO;
}

/**
 * 相对速度暗示：effective = sessionFactor / bias；越小停留越短 →「偏快」。
 */
export function paceHintLabel(sessionFactor: number, bias = AUTO_PACE_BIAS_DEFAULT): string {
  const effective = clampSessionFactor(sessionFactor) / clampAutoPaceBias(bias);
  if (effective <= 0.85) return "偏快";
  if (effective >= 1.2) return "偏慢";
  return "适中";
}

/**
 * 开关 / 播放控制状态机。
 * enabled=false → off；开开关但未播 → armed；play/pause/end 在 armed/playing/paused 间切换。
 */
export function nextAutoPaceStatus(
  current: AutoPaceStatus,
  event:
    | { type: "enable" }
    | { type: "disable" }
    | { type: "play" }
    | { type: "pause" }
    | { type: "end" },
): AutoPaceStatus {
  switch (event.type) {
    case "disable":
      return "off";
    case "enable":
      return current === "off" ? "armed" : current;
    case "play":
      if (current === "off") return "off";
      return "playing";
    case "pause":
      if (current === "playing") return "paused";
      return current;
    case "end":
      if (current === "off") return "off";
      return "paused";
    default:
      return current;
  }
}
