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
