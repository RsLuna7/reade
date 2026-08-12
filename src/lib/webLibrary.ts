import type {
  AssetPayload,
  DocumentContent,
  DocumentInfo,
  SearchResult,
} from "./backend";
import {
  buildDocumentLinks,
  extractDocumentLinks,
  WEB_LINKS_DISABLED_MESSAGE,
  WEB_LINKS_MAX_DOCUMENTS,
  type DocumentLinks,
  type ExtractedLink,
} from "./documentLinks";
import {
  extractRelatedFragments,
  RELATED_DEFAULT_LIMIT,
  RELATED_MAX_LIMIT,
} from "./relatedFragments";

// Relative to the document so GitHub project pages (/owner/repo/) and user
// pages (/owner/) resolve the same generated library directory correctly.
export const DEFAULT_WEB_LIBRARY_BASE_URL = "./reade-web/";
export const WEB_LIBRARY_SCHEMA_VERSION = 2 as const;

/**
 * Manifest document entry: `DocumentInfo` plus the optional content
 * fingerprint the generator emits (`ntxt:` normalized-text SHA-256, same
 * definition as the desktop backend). Older generated libraries lack the
 * field; move detection then simply finds no candidates.
 */
export interface WebManifestDocument extends DocumentInfo {
  contentHash?: string;
}

export interface WebLibraryManifest {
  schemaVersion: typeof WEB_LIBRARY_SCHEMA_VERSION;
  title: string;
  generatedAt: string;
  documents: WebManifestDocument[];
}

export interface WebSearchDocument {
  relativePath: string;
  title: string;
  content: string;
}

export interface WebSearchIndex {
  schemaVersion: typeof WEB_LIBRARY_SCHEMA_VERSION;
  documents: WebSearchDocument[];
}

export interface WebLibraryClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

export class WebLibraryRequestError extends Error {
  readonly url: string;
  readonly status: number | null;

  constructor(message: string, url: string, status: number | null = null) {
    super(message);
    this.name = "WebLibraryRequestError";
    this.url = url;
    this.status = status;
  }
}

const searchCollator = new Intl.Collator(["zh-CN", "en"], {
  numeric: true,
  sensitivity: "base",
});

export function validateLibraryRelativePath(relativePath: string): string {
  if (!relativePath || relativePath.includes("\0")) {
    throw new Error("文档路径不能为空");
  }
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(relativePath)
  ) {
    throw new Error("只允许文档库内的相对路径");
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("文档路径包含不安全的路径片段");
  }
  return relativePath;
}

export function encodeLibraryRelativePath(relativePath: string): string {
  return validateLibraryRelativePath(relativePath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function normalizeWebLibraryBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (!normalized || normalized.startsWith("//")) {
    throw new Error("Web 文档库地址无效");
  }
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

export function webLibraryUrl(
  relativePath: string,
  baseUrl = DEFAULT_WEB_LIBRARY_BASE_URL,
): string {
  return `${normalizeWebLibraryBaseUrl(baseUrl)}library/${encodeLibraryRelativePath(relativePath)}`;
}

function metadataUrl(fileName: "manifest.json" | "search.json", baseUrl: string): string {
  return `${normalizeWebLibraryBaseUrl(baseUrl)}${fileName}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    validateLibraryRelativePath(value);
    return true;
  } catch {
    return false;
  }
}

const CONTENT_HASH_PATTERN = /^ntxt:[0-9a-f]{64}$/;

function isDocumentInfo(value: unknown): value is WebManifestDocument {
  if (!isRecord(value)) return false;
  return (
    hasSafeRelativePath(value.relativePath) &&
    typeof value.title === "string" &&
    typeof value.size === "number" &&
    Number.isFinite(value.size) &&
    value.size >= 0 &&
    typeof value.modified === "number" &&
    Number.isFinite(value.modified) &&
    (value.format === "markdown" || value.format === "mdx") &&
    value.indexStatus === "ready" &&
    value.indexError === null &&
    (value.contentHash === undefined ||
      (typeof value.contentHash === "string" && CONTENT_HASH_PATTERN.test(value.contentHash)))
  );
}

function parseManifest(value: unknown, url: string): WebLibraryManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== WEB_LIBRARY_SCHEMA_VERSION ||
    typeof value.title !== "string" ||
    typeof value.generatedAt !== "string" ||
    Number.isNaN(Date.parse(value.generatedAt)) ||
    !Array.isArray(value.documents) ||
    !value.documents.every(isDocumentInfo)
  ) {
    throw new WebLibraryRequestError("Web 文档库 manifest 格式无效", url);
  }
  return value as unknown as WebLibraryManifest;
}

function isSearchDocument(value: unknown): value is WebSearchDocument {
  return (
    isRecord(value) &&
    hasSafeRelativePath(value.relativePath) &&
    typeof value.title === "string" &&
    typeof value.content === "string"
  );
}

function parseSearchIndex(value: unknown, url: string): WebSearchIndex {
  if (
    !isRecord(value) ||
    value.schemaVersion !== WEB_LIBRARY_SCHEMA_VERSION ||
    !Array.isArray(value.documents) ||
    !value.documents.every(isSearchDocument)
  ) {
    throw new WebLibraryRequestError("Web 文档库搜索索引格式无效", url);
  }
  return value as unknown as WebSearchIndex;
}

async function checkedResponse(
  fetcher: typeof fetch,
  url: string,
  accept: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: { Accept: accept } });
  } catch {
    throw new WebLibraryRequestError("无法连接 Web 文档库", url);
  }
  if (!response.ok) {
    throw new WebLibraryRequestError(
      `Web 文档库请求失败（HTTP ${response.status}）`,
      url,
      response.status,
    );
  }
  return response;
}

async function checkedJson(
  fetcher: typeof fetch,
  url: string,
): Promise<unknown> {
  const response = await checkedResponse(fetcher, url, "application/json");
  try {
    return await response.json();
  } catch {
    throw new WebLibraryRequestError("Web 文档库返回了无效 JSON", url, response.status);
  }
}

function countMatches(haystack: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) >= 0) {
    count += 1;
    cursor += Math.max(needle.length, 1);
  }
  return count;
}

function searchSnippet(content: string, terms: string[], maximumLength = 180): string {
  const plain = content.replace(/\s+/g, " ").trim();
  const normalized = plain.toLocaleLowerCase("zh-CN");
  const firstMatch = terms.reduce((earliest, term) => {
    const index = normalized.indexOf(term);
    return index >= 0 && (earliest < 0 || index < earliest) ? index : earliest;
  }, -1);
  const center = firstMatch < 0 ? 0 : firstMatch;
  const start = Math.max(0, center - Math.floor(maximumLength / 3));
  const end = Math.min(plain.length, start + maximumLength);
  return `${start > 0 ? "…" : ""}${plain.slice(start, end)}${end < plain.length ? "…" : ""}`;
}

export function searchWebDocuments(
  documents: WebSearchDocument[],
  query: string,
  limit = 30,
): SearchResult[] {
  const terms = [...new Set(
    query
      .trim()
      .toLocaleLowerCase("zh-CN")
      .split(/\s+/)
      .filter(Boolean),
  )];
  if (terms.length === 0) return [];

  const resultLimit = Number.isFinite(limit)
    ? Math.max(0, Math.min(100, Math.trunc(limit)))
    : 30;
  if (resultLimit === 0) return [];

  return documents
    .flatMap((document): SearchResult[] => {
      const title = document.title.toLocaleLowerCase("zh-CN");
      const path = document.relativePath.toLocaleLowerCase("zh-CN");
      const content = document.content.toLocaleLowerCase("zh-CN");
      if (!terms.every((term) => title.includes(term) || path.includes(term) || content.includes(term))) {
        return [];
      }

      const score = terms.reduce(
        (total, term) =>
          total +
          countMatches(title, term) * 8 +
          countMatches(path, term) * 3 +
          Math.min(countMatches(content, term), 20),
        0,
      );
      return [{
        resultId: `web:${document.relativePath}`,
        relativePath: document.relativePath,
        title: document.title,
        snippet: searchSnippet(document.content, terms),
        score,
        format: document.relativePath.toLocaleLowerCase("en").endsWith(".mdx")
          ? "mdx"
          : "markdown",
        locator: null,
      }];
    })
    .sort((left, right) => right.score - left.score || searchCollator.compare(left.title, right.title))
    .slice(0, resultLimit);
}

function compareRelativePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Web twin of `find_related_passages` (RP-D5): the shared fragment
 * contract feeds a lowercase substring count — `score = Σ min(count, 3) ×
 * fragment length` — over `search.json` contents. Substring semantics
 * match the desktop trigram index; only the scoring formula differs (a
 * documented divergence, like library search itself). Locators are always
 * null (web markdown has no finer segments).
 */
export function findRelatedWebPassages(
  documents: WebSearchDocument[],
  text: string,
  excludePath: string | null = null,
  limit = RELATED_DEFAULT_LIMIT,
): SearchResult[] {
  const fragments = extractRelatedFragments(text);
  if (fragments.length === 0) return [];
  const resultLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), RELATED_MAX_LIMIT)
    : RELATED_DEFAULT_LIMIT;
  const lowered = fragments.map((fragment) => ({
    fragment: fragment.toLowerCase(),
    length: Array.from(fragment).length,
  }));
  return documents
    .flatMap((document): SearchResult[] => {
      if (document.relativePath === excludePath) return [];
      const content = document.content.toLowerCase();
      let score = 0;
      const matched: string[] = [];
      for (const { fragment, length } of lowered) {
        const count = countMatches(content, fragment);
        if (count > 0) {
          score += Math.min(count, 3) * length;
          matched.push(fragment);
        }
      }
      if (score <= 0) return [];
      return [{
        resultId: `web:${document.relativePath}`,
        relativePath: document.relativePath,
        title: document.title,
        snippet: searchSnippet(document.content, matched),
        score,
        format: document.relativePath.toLocaleLowerCase("en").endsWith(".mdx")
          ? "mdx"
          : "markdown",
        locator: null,
      }];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareRelativePaths(left.relativePath, right.relativePath),
    )
    .slice(0, resultLimit);
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const chunks: string[] = [];
  let chunk = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    chunk += alphabet[(triple >> 18) & 63];
    chunk += alphabet[(triple >> 12) & 63];
    chunk += second === undefined ? "=" : alphabet[(triple >> 6) & 63];
    chunk += third === undefined ? "=" : alphabet[triple & 63];

    if (chunk.length >= 16_384) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.join("");
}

export class WebLibraryClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private manifest: WebLibraryManifest | null = null;
  private searchIndex: WebSearchIndex | null = null;
  /** Extracted links per source, cached per search index (BL-D4). */
  private linksIndex: {
    source: WebSearchIndex;
    links: Map<string, ExtractedLink[]>;
  } | null = null;

  constructor(options: WebLibraryClientOptions = {}) {
    this.baseUrl = normalizeWebLibraryBaseUrl(
      options.baseUrl ?? DEFAULT_WEB_LIBRARY_BASE_URL,
    );
    const fetcher = options.fetcher ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      throw new Error("当前环境不支持 Fetch API");
    }
    this.fetcher = fetcher.bind(globalThis);
  }

  async loadManifest(force = false): Promise<WebLibraryManifest> {
    if (this.manifest && !force) return this.manifest;
    const url = metadataUrl("manifest.json", this.baseUrl);
    this.manifest = parseManifest(await checkedJson(this.fetcher, url), url);
    return this.manifest;
  }

  async loadDocument(relativePath: string): Promise<DocumentContent> {
    const url = webLibraryUrl(relativePath, this.baseUrl);
    const response = await checkedResponse(this.fetcher, url, "text/markdown, text/plain");
    return { kind: "markdown", relativePath, markdown: await response.text() };
  }

  async loadAsset(relativePath: string): Promise<AssetPayload> {
    const url = webLibraryUrl(relativePath, this.baseUrl);
    const response = await checkedResponse(this.fetcher, url, "*/*");
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim()
      || "application/octet-stream";
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { relativePath, mimeType, data: bytesToBase64(bytes) };
  }

  async loadSearchIndex(force = false): Promise<WebSearchIndex> {
    if (this.searchIndex && !force) return this.searchIndex;
    const url = metadataUrl("search.json", this.baseUrl);
    this.searchIndex = parseSearchIndex(await checkedJson(this.fetcher, url), url);
    return this.searchIndex;
  }

  async search(query: string, limit = 30): Promise<SearchResult[]> {
    const index = await this.loadSearchIndex();
    return searchWebDocuments(index.documents, query, limit);
  }

  /**
   * Web twin of `list_document_links`: runs the shared extractor over the
   * full `search.json` corpus (cached until the next refresh) and
   * aggregates with `buildDocumentLinks`. Libraries beyond
   * `WEB_LINKS_MAX_DOCUMENTS` documents throw the exported degradation
   * message instead of computing (BL-D4).
   */
  async documentLinks(relativePath: string): Promise<DocumentLinks> {
    const index = await this.loadSearchIndex();
    if (index.documents.length > WEB_LINKS_MAX_DOCUMENTS) {
      throw new Error(WEB_LINKS_DISABLED_MESSAGE);
    }
    if (!this.linksIndex || this.linksIndex.source !== index) {
      const links = new Map<string, ExtractedLink[]>();
      for (const document of index.documents) {
        links.set(
          document.relativePath,
          extractDocumentLinks(document.relativePath, document.content),
        );
      }
      this.linksIndex = { source: index, links };
    }
    return buildDocumentLinks(relativePath, this.linksIndex.links, index.documents);
  }

  /** Web twin of `find_related_passages` over the search index. */
  async relatedPassages(
    text: string,
    excludePath: string | null = null,
    limit = RELATED_DEFAULT_LIMIT,
  ): Promise<SearchResult[]> {
    const index = await this.loadSearchIndex();
    return findRelatedWebPassages(index.documents, text, excludePath, limit);
  }

  clearCache(): void {
    this.manifest = null;
    this.searchIndex = null;
    this.linksIndex = null;
  }
}
