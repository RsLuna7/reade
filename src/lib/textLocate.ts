/**
 * 深链文本定位纯函数（docs/plan-web-text-deeplink.md §3.2）。
 *
 * 分享与定位两侧使用同一套空白归一：任意空白串折叠为单个空格并去首尾。
 * 定位时对正文全文做带偏移映射的归一，再用 indexOf 找首个匹配，把归一
 * 偏移映射回原始文本偏移，供 `rangeFromTextIndex` 建 Range。
 */

/** 复制段落链接时截取的最大字符数（DL-D2，按 Unicode code point 计）。 */
export const DEEPLINK_SHARE_MAX_CHARS = 120;

/** 解析 `#text=` 时接受的最大长度（DL-D2；超长丢弃，防 URL 武器化）。 */
export const DEEPLINK_PARSE_MAX_CHARS = 200;

/**
 * 分享侧文本处理：空白归一 + 按 code point 截断（避免劈开 emoji 代理对）。
 * 返回空串表示选区没有可分享的文本。
 */
export function normalizeShareText(
  text: string,
  maxChars = DEEPLINK_SHARE_MAX_CHARS,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const points = Array.from(normalized);
  if (points.length <= maxChars) return normalized;
  return points.slice(0, maxChars).join("").trimEnd();
}

interface NormalizedHaystack {
  /** 归一后的文本（空白串 → 单空格，无首尾空白）。 */
  text: string;
  /** offsets[i] = 归一文本第 i 个 UTF-16 码元在原始文本中的偏移。 */
  offsets: number[];
}

function normalizeWithOffsets(value: string): NormalizedHaystack {
  let text = "";
  const offsets: number[] = [];
  let pendingSpaceOffset = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (/\s/.test(character)) {
      // 空白串折叠为一个空格,记录首个空白字符的位置;行首空白直接丢弃。
      if (text && pendingSpaceOffset < 0) pendingSpaceOffset = index;
      continue;
    }
    if (pendingSpaceOffset >= 0) {
      text += " ";
      offsets.push(pendingSpaceOffset);
      pendingSpaceOffset = -1;
    }
    text += character;
    offsets.push(index);
  }
  return { text, offsets };
}

export interface TextLocateMatch {
  /** 原始文本中的起止偏移（UTF-16 码元，可直接喂 rangeFromTextIndex）。 */
  start: number;
  end: number;
}

/**
 * 在 `haystack`（正文扁平化全文）中定位空白归一后的 `query` 首个匹配。
 * 未命中返回 null——调用方给降级提示，绝不静默（DL-D4）。
 */
export function locateNormalizedText(
  haystack: string,
  query: string,
): TextLocateMatch | null {
  const needle = query.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  const normalized = normalizeWithOffsets(haystack);
  const index = normalized.text.indexOf(needle);
  if (index < 0) return null;
  const start = normalized.offsets[index];
  const end = normalized.offsets[index + needle.length - 1] + 1;
  return { start, end };
}
