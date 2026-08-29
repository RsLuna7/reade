/**
 * Markdown image source helpers shared by the main pane, secondary pane,
 * and MarkdownRenderer: key normalisation, remote-vs-local classification,
 * and the resolve step that turns a markdown `src` into a renderable URL.
 */

const REMOTE_HTTP = /^https?:\/\//i;
const REMOTE_HTTPS = /^https:\/\//i;

/**
 * Stabilise percent-encoding so asset-map keys match what remark /
 * react-markdown pass as `img` src (spaces → `%20`; Unicode left as-is).
 */
export function normalizeMarkdownUrlKey(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return trimmed;
  try {
    return encodeURI(decodeURI(trimmed));
  } catch {
    return trimmed;
  }
}

export function isRemoteHttpUrl(source: string): boolean {
  return REMOTE_HTTP.test(source.trim());
}

/** Remote images only load over HTTPS when the preference is on. */
export function isAllowedRemoteImageUrl(source: string): boolean {
  return REMOTE_HTTPS.test(source.trim());
}

/**
 * Resolve a markdown image source against the local asset map and the
 * remote-image preference. Data URLs pass through; http(s) URLs require
 * `allowRemoteImages` and HTTPS; everything else looks up the asset map
 * under a normalised key.
 */
export function resolveMarkdownImageSrc(
  source: string,
  assetUrls: Record<string, string>,
  allowRemoteImages: boolean,
): string | null {
  if (source.startsWith("data:image/")) return source;
  if (isRemoteHttpUrl(source)) {
    return allowRemoteImages && isAllowedRemoteImageUrl(source) ? source : null;
  }
  const key = normalizeMarkdownUrlKey(source);
  return assetUrls[key] ?? assetUrls[source] ?? null;
}

/**
 * 与 `safeUrlTransform` 的 SAFE_DATA_IMAGE 白名单同一组类型；资产读取在
 * 生成 data URL 前先按 MIME 过滤，避免把注定被拦截的大字符串塞进状态。
 * base64 字符集由 Rust 侧编码保证，无需整串校验。
 */
const SAFE_ASSET_MIME = /^image\/(?:avif|gif|jpeg|png|webp)$/i;

export function isSafeImageMimeType(mimeType: string): boolean {
  return SAFE_ASSET_MIME.test(mimeType.trim());
}

/** 把 readAsset 的失败转成占位符能直接展示的短句；未知错误保留原文片段。 */
export function describeAssetLoadFailure(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error ?? "")).trim();
  if (/too large/i.test(raw)) return "文件超过 25 MiB 上限";
  if (/outside the library|outside|denied|forbidden|escape/i.test(raw)) {
    return "路径越出文档库边界";
  }
  if (/cannot (read|inspect|find|open|resolve)|no such|not (a )?(file|exist)|does not point/i.test(raw)) {
    return "文件不存在或无法读取";
  }
  return raw ? `读取失败：${raw.slice(0, 120)}` : "读取失败";
}
