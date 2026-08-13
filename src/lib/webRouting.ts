import { DEEPLINK_PARSE_MAX_CHARS } from "./textLocate";

export interface WebRoute {
  documentPath: string;
  heading: string | null;
  /**
   * 段落分享深链的目标文本（`#text=<encoded>`，plan-web-text-deeplink
   * DL-D1）。与 heading 互斥：hash 以 `text=` 开头时只解析 textFragment。
   */
  textFragment: string | null;
}

export interface WebLocationLike {
  search: string;
  hash: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const PROTOCOL_OR_DRIVE = /^[a-z][a-z\d+.-]*:/i;

function safeDecode(value: string, plusAsSpace: boolean): string | null {
  try {
    return decodeURIComponent(plusAsSpace ? value.replace(/\+/g, " ") : value);
  } catch {
    return null;
  }
}

function queryValue(search: string, wantedName: string): string | null {
  const query = search.startsWith("?") ? search.slice(1) : search;

  for (const pair of query.split("&")) {
    const separator = pair.indexOf("=");
    const rawName = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? "" : pair.slice(separator + 1);
    const name = safeDecode(rawName, true);

    if (name === wantedName) {
      return safeDecode(rawValue, true);
    }
  }

  return null;
}

/**
 * Normalizes a decoded document path while keeping it relative to the library
 * root. `null` means the value must not be passed to the file backend.
 */
export function normalizeWebDocumentPath(value: string): string | null {
  if (!value || value !== value.trim() || CONTROL_CHARACTERS.test(value)) {
    return null;
  }

  const normalizedSeparators = value.replace(/\\/g, "/");
  if (
    normalizedSeparators.startsWith("/") ||
    normalizedSeparators.startsWith("//") ||
    PROTOCOL_OR_DRIVE.test(normalizedSeparators)
  ) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of normalizedSeparators.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    segments.push(segment);
  }

  return segments.length > 0 ? segments.join("/") : null;
}

function parseHeading(hash: string): { valid: boolean; value: string | null } {
  const rawHeading = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!rawHeading) {
    return { valid: true, value: null };
  }

  const heading = safeDecode(rawHeading, false);
  if (heading === null || !heading || CONTROL_CHARACTERS.test(heading)) {
    return { valid: false, value: null };
  }

  return { valid: true, value: heading };
}

const TEXT_FRAGMENT_PREFIX = "#text=";

/**
 * 解析 `#text=<encoded>` 段。前缀 `text=` 是字面量（heading 编码时 `=`
 * 会被转义为 `%3D`，两者不会撞车）。解码失败、空值、控制字符或超过
 * 200 字符时按无深链处理（不让整条路由失效）。
 */
function parseTextFragment(hash: string): string | null {
  if (!hash.startsWith(TEXT_FRAGMENT_PREFIX)) return null;
  const decoded = safeDecode(hash.slice(TEXT_FRAGMENT_PREFIX.length), false);
  if (
    decoded === null ||
    !decoded.trim() ||
    decoded.length > DEEPLINK_PARSE_MAX_CHARS ||
    CONTROL_CHARACTERS.test(decoded)
  ) {
    return null;
  }
  return decoded;
}

/** Parses `?doc=relative/path.md#heading` from a URL or `window.location`. */
export function parseWebRoute(location: WebLocationLike): WebRoute | null {
  const rawDocumentPath = queryValue(location.search, "doc");
  if (rawDocumentPath === null) {
    return null;
  }

  const documentPath = normalizeWebDocumentPath(rawDocumentPath);
  if (documentPath === null) {
    return null;
  }

  // `#text=` 与 heading hash 互斥:text 形态的 hash 永不当 heading 解析。
  if (location.hash.startsWith(TEXT_FRAGMENT_PREFIX)) {
    return { documentPath, heading: null, textFragment: parseTextFragment(location.hash) };
  }

  const heading = parseHeading(location.hash);
  if (!heading.valid) {
    return null;
  }

  return { documentPath, heading: heading.value, textFragment: null };
}

export interface WebRouteTarget {
  heading?: string | null;
  /** 段落深链文本;与 heading 同时给出时 text 优先（DL-D1 互斥规则）。 */
  text?: string | null;
}

/**
 * Builds a shareable URL while preserving unrelated query parameters.
 * The third argument accepts a plain heading string (legacy form) or a
 * `{ heading?, text? }` target. An empty or omitted target intentionally
 * clears the existing hash.
 */
export function buildWebRouteUrl(
  currentUrl: string | URL,
  documentPath: string,
  target?: string | WebRouteTarget | null,
): string {
  const normalizedPath = normalizeWebDocumentPath(documentPath);
  if (normalizedPath === null) {
    throw new TypeError("Invalid relative document path");
  }

  const heading = typeof target === "string" ? target : target?.heading ?? null;
  const text = typeof target === "string" ? null : target?.text ?? null;
  if (heading && CONTROL_CHARACTERS.test(heading)) {
    throw new TypeError("Invalid heading");
  }
  if (text && CONTROL_CHARACTERS.test(text)) {
    throw new TypeError("Invalid text fragment");
  }

  const url = new URL(currentUrl.toString());
  url.searchParams.set("doc", normalizedPath);
  url.hash = text
    ? `text=${encodeURIComponent(text)}`
    : heading
      ? encodeURIComponent(heading)
      : "";
  return url.toString();
}
