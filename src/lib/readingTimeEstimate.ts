import type { DocumentExtent } from "./backend";
import type { HomeProgress } from "./homeData";
import type { ReadingPosition } from "./readingPositions";

/**
 * 阅读时间预估（plan-reading-time-estimate §3.1）。
 *
 * 个人速度 = 近 90 天会话按文档聚合后，"有效读过字符 ÷ 阅读分钟"的
 * 中位数（抗离群）再 clamp；样本不足回退默认速度。字符数来自
 * `list_document_extents`（契约与库覆盖率 treemap 共享）。全部纯函数，
 * 数据装配留在 App。
 */

/** 默认阅读速度（TE-D3）：CJK 阅读经验中值，冷启动与 Web 端使用。 */
export const DEFAULT_CHARS_PER_MINUTE = 500;
/** 个人速度 clamp 区间（TE-D1）：坏数据兜底。 */
export const READING_SPEED_MIN_CPM = 150;
export const READING_SPEED_MAX_CPM = 2000;
/** 启用个人速度所需的最少有效文档样本数。 */
export const CALIBRATION_MIN_SAMPLES = 5;
/** 单文档样本的最短累计阅读秒数（噪声过滤）。 */
export const CALIBRATION_MIN_ACTIVE_SECONDS = 120;
/** 单文档样本的最低高水位覆盖率（"翻了翻"不算读过）。 */
export const CALIBRATION_MIN_COVERAGE = 0.15;
/** needs_ocr 段占比超过此值的文档不显示预估（TE-D5：字符数失真）。 */
export const ESTIMATE_MAX_OCR_RATIO = 0.5;
/** 个人速度校准的会话回看窗口（90 天）。 */
export const CALIBRATION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export interface ReadingSpeed {
  charsPerMinute: number;
  /** 参与中位数的有效文档样本数。 */
  samples: number;
  /** true = 用个人实测速度；false = 默认速度档。 */
  calibrated: boolean;
}

export const DEFAULT_READING_SPEED: ReadingSpeed = {
  charsPerMinute: DEFAULT_CHARS_PER_MINUTE,
  samples: 0,
  calibrated: false,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 高水位覆盖率：scroll 文档取 maxScrollRatio；PDF 用 maxPage ÷ 页数
 * （extents 的 segmentCount 对 PDF 即页数）。分母未知返回 null。
 */
export function highWaterCoverage(
  position: ReadingPosition | null | undefined,
  pageCount?: number | null,
): number | null {
  if (!position) return null;
  if (position.kind === "scroll") return clamp01(position.maxScrollRatio);
  if (typeof pageCount === "number" && Number.isFinite(pageCount) && pageCount > 0) {
    return clamp01(position.maxPage / pageCount);
  }
  return null;
}

/** TE-D5：扫描版（needs_ocr 段占比 > 50%）不出预估，宁缺毋滥。 */
export function extentSupportsEstimate(
  extent: Pick<DocumentExtent, "charCount" | "segmentCount" | "needsOcrSegments">,
): boolean {
  if (extent.charCount <= 0) return false;
  if (extent.segmentCount <= 0) return false;
  return extent.needsOcrSegments / extent.segmentCount <= ESTIMATE_MAX_OCR_RATIO;
}

export type TreeEstimateKind = "time" | "unavailable";

/** 文档树右侧时长列：有字数给出「约 N 分钟」，故意不估时给出同级标签。 */
export interface TreeEstimateBadge {
  kind: TreeEstimateKind;
  label: string;
  hint?: string;
}

export const UNAVAILABLE_ESTIMATE_SCAN = "扫描版";
export const UNAVAILABLE_ESTIMATE_EMPTY = "无法估计";
export const UNAVAILABLE_ESTIMATE_SCAN_HINT = "多数页面没有文本层，无法按字数估计阅读时长";
export const UNAVAILABLE_ESTIMATE_EMPTY_HINT = "没有可统计的文本，无法估计阅读时长";

type EstimateExtent = Pick<DocumentExtent, "charCount" | "segmentCount" | "needsOcrSegments">;

function isOcrHeavy(extent: EstimateExtent): boolean {
  return (
    extent.segmentCount > 0 &&
    extent.needsOcrSegments / extent.segmentCount > ESTIMATE_MAX_OCR_RATIO
  );
}

/** 树条目徽标。无 extents（仍在索引）返回 null，不占位。 */
export function treeEstimateBadge(
  extent: EstimateExtent | null | undefined,
  charsPerMinute: number,
): TreeEstimateBadge | null {
  if (!extent) return null;
  if (extentSupportsEstimate(extent)) {
    return {
      kind: "time",
      label: formatReadingEstimate(estimateReadingMinutes(extent.charCount, charsPerMinute)),
    };
  }
  if (isOcrHeavy(extent)) {
    return {
      kind: "unavailable",
      label: UNAVAILABLE_ESTIMATE_SCAN,
      hint: UNAVAILABLE_ESTIMATE_SCAN_HINT,
    };
  }
  return {
    kind: "unavailable",
    label: UNAVAILABLE_ESTIMATE_EMPTY,
    hint: UNAVAILABLE_ESTIMATE_EMPTY_HINT,
  };
}

export interface CalibrationInput {
  /** 近 90 天会话按文档聚合的 activeSeconds。 */
  activeSecondsByPath: ReadonlyMap<string, number>;
  /** 各文档字符数（extents）。 */
  charsByPath: ReadonlyMap<string, number>;
  /** 各文档 0..1 高水位覆盖率。 */
  coverageByPath: ReadonlyMap<string, number>;
}

/**
 * 个人速度校准：每文档样本 = (chars × coverage) ÷ (activeSeconds / 60)，
 * 过滤 activeSeconds < 120、coverage < 0.15、chars ≤ 0 的噪声样本；
 * 样本 < 5 回退默认；中位数 + clamp [150, 2000] 抗离群（TE-D1/D2）。
 */
export function calibrateReadingSpeed(input: CalibrationInput): ReadingSpeed {
  const samples: number[] = [];
  for (const [path, activeSeconds] of input.activeSecondsByPath) {
    if (!Number.isFinite(activeSeconds) || activeSeconds < CALIBRATION_MIN_ACTIVE_SECONDS) {
      continue;
    }
    const chars = input.charsByPath.get(path);
    if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) continue;
    const coverage = input.coverageByPath.get(path);
    if (
      typeof coverage !== "number" ||
      !Number.isFinite(coverage) ||
      coverage < CALIBRATION_MIN_COVERAGE
    ) {
      continue;
    }
    const effectiveChars = chars * clamp01(coverage);
    const minutes = activeSeconds / 60;
    if (minutes <= 0) continue;
    samples.push(effectiveChars / minutes);
  }
  if (samples.length < CALIBRATION_MIN_SAMPLES) return { ...DEFAULT_READING_SPEED };

  samples.sort((a, b) => a - b);
  const middle = samples.length >> 1;
  const median =
    samples.length % 2 === 1 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
  const clamped = Math.min(
    READING_SPEED_MAX_CPM,
    Math.max(READING_SPEED_MIN_CPM, Math.round(median)),
  );
  return { charsPerMinute: clamped, samples: samples.length, calibrated: true };
}

/** 全文预估分钟数：向上取整、至少 1 分钟。 */
export function estimateReadingMinutes(chars: number, charsPerMinute: number): number {
  const cpm =
    Number.isFinite(charsPerMinute) && charsPerMinute > 0
      ? charsPerMinute
      : DEFAULT_CHARS_PER_MINUTE;
  const safeChars = Number.isFinite(chars) && chars > 0 ? chars : 0;
  return Math.max(1, Math.ceil(safeChars / cpm));
}

/**
 * 继续阅读卡的剩余分钟数：chars × (1 - 覆盖率)。读完（剩余 0）或
 * 数据不可用（扫描版/无字符）返回 null，不渲染徽标。
 */
export function estimateRemainingMinutes(
  extent: Pick<DocumentExtent, "charCount" | "segmentCount" | "needsOcrSegments">,
  progress: HomeProgress | null,
  charsPerMinute: number,
): number | null {
  if (!extentSupportsEstimate(extent)) return null;
  let coverage = 0;
  if (progress?.kind === "ratio") {
    coverage = clamp01(progress.value);
  } else if (progress?.kind === "page" && extent.segmentCount > 0) {
    coverage = clamp01(progress.page / extent.segmentCount);
  }
  const remainingChars = extent.charCount * (1 - coverage);
  if (remainingChars < 1) return null;
  return estimateReadingMinutes(remainingChars, charsPerMinute);
}

/** "1 分钟内 / 约 N 分钟 / 约 N 小时"（>3 小时进小时档）。 */
export function formatReadingEstimate(minutes: number): string {
  const rounded = Math.max(0, Math.ceil(minutes));
  if (rounded <= 1) return "1 分钟内";
  if (rounded <= 180) return `约 ${rounded} 分钟`;
  return `约 ${Math.round(rounded / 60)} 小时`;
}

/** 继续阅读卡文案："剩余不足 1 分钟 / 剩余约 N 分钟 / 剩余约 N 小时"。 */
export function formatRemainingEstimate(minutes: number): string {
  const rounded = Math.max(0, Math.ceil(minutes));
  if (rounded <= 1) return "剩余不足 1 分钟";
  return `剩余${formatReadingEstimate(rounded)}`;
}

/** 会话 → 按文档聚合 activeSeconds（校准输入装配辅助）。 */
export function aggregateActiveSeconds(
  sessions: ReadonlyArray<{ relativePath: string; activeSeconds: number }>,
): Map<string, number> {
  const byPath = new Map<string, number>();
  for (const session of sessions) {
    if (!Number.isFinite(session.activeSeconds) || session.activeSeconds <= 0) continue;
    byPath.set(
      session.relativePath,
      (byPath.get(session.relativePath) ?? 0) + session.activeSeconds,
    );
  }
  return byPath;
}
