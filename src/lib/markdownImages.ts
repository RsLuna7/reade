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
 * 阅读栏友好的远程缩略图宽度。博客/新闻稿常见 `mw=80` 级邮票尺寸，
 * 原样渲染会缩成豆粒；向 CDN 要更大一档即可（不改文档原文）。
 */
export const REMOTE_IMAGE_READING_WIDTH = 960;
/** 仅当 URL 明确声明小于此宽度时才抬升，避免误动已经够大的图。 */
const TINY_REMOTE_WIDTH_CEILING = 240;

/**
 * 把已知「故意写得很小」的远程缩略图 URL 抬到阅读宽度。
 * 目前覆盖 Vimeo CDN 的 `mw=`；解析失败或未知主机原样返回。
 */
export function upgradeRemoteImageUrlForReading(source: string): string {
  const trimmed = source.trim();
  if (!REMOTE_HTTPS.test(trimmed)) return source;
  try {
    const url = new URL(trimmed);
    if (!/(^|\.)vimeocdn\.com$/i.test(url.hostname)) return source;
    const raw = url.searchParams.get("mw");
    if (raw === null) return source;
    const width = Number.parseInt(raw, 10);
    if (!Number.isFinite(width) || width <= 0 || width >= TINY_REMOTE_WIDTH_CEILING) {
      return source;
    }
    url.searchParams.set("mw", String(REMOTE_IMAGE_READING_WIDTH));
    return url.toString();
  } catch {
    return source;
  }
}

/**
 * Vimeo CDN 缩略图路径形如 `/video/{id}-{privacyHash}-d`。
 * 未列出视频不能用 `vimeo.com/{id}`（404），要用带 hash 的分享链才能在浏览器里直接看。
 */
const VIMEO_CDN_THUMB =
  /\/video\/(\d+)-([a-f0-9]+)-d\/?$/i;

export function vimeoWatchUrlFromThumbnail(source: string): string | null {
  const trimmed = source.trim();
  if (!REMOTE_HTTPS.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (!/(^|\.)vimeocdn\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(VIMEO_CDN_THUMB);
    if (!match) return null;
    return `https://vimeo.com/${match[1]}/${match[2]}`;
  } catch {
    return null;
  }
}

/**
 * 图包链接常见写法：`[![...](vimeo-cdn缩略图)](文章页)`。
 * 点开只会到文章首页，视频还得往下翻；若缩略图能还原未列出观看链，则优先跳观看页。
 * 作者若已链到 vimeo.com，则尊重原文。
 */
export function preferLinkedVideoHref(
  href: string,
  imageSources: readonly string[],
): string {
  if (/vimeo\.com/i.test(href)) return href;
  for (const source of imageSources) {
    const watch = vimeoWatchUrlFromThumbnail(source);
    if (watch) return watch;
  }
  return href;
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
    if (!(allowRemoteImages && isAllowedRemoteImageUrl(source))) return null;
    return upgradeRemoteImageUrlForReading(source);
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
