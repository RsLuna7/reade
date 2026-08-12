/**
 * Pure document-link logic for the read-only backlinks feature
 * (`docs/plan-backlinks.md`): target resolution, markdown link
 * extraction, query-time wiki resolution and the web-runtime aggregation
 * that mirrors the desktop `list_document_links` command.
 *
 * `resolveLibraryPath` is the verbatim move of the function of the same
 * name in `src/App.tsx` (App keeps its own copy until the UI wiring wave
 * switches its import; behaviour is identical by contract). The Rust twin
 * lives in `src-tauri/src/links.rs`; the numbered cases L01.. in
 * `documentLinks.test.ts` are mirrored by its tests — any change here
 * must update both ends together.
 *
 * Deliberately unsupported CommonMark forms (contract-fixed; a missed
 * link only loses an edge, never safety): reference-style links,
 * autolinks, `<>`-wrapped destinations, nested brackets/parentheses and
 * links spanning multiple source lines.
 */

/** Hard per-document cap so a link bomb cannot bloat extraction. */
export const MAX_DOCUMENT_LINKS = 1_000;
export const MAX_LINK_TEXT_CHARS = 200;
/** `list_document_links` truncates each list to this many entries. */
export const LINKS_LIST_LIMIT = 500;
/**
 * BL-D4 degradation: the web runtime computes links on the client from
 * `search.json` and disables the feature beyond this document count.
 */
export const WEB_LINKS_MAX_DOCUMENTS = 500;
export const WEB_LINKS_DISABLED_MESSAGE = "库过大，链接视图未启用";

const DOCUMENT_EXTENSIONS = new Set(["md", "markdown", "mdx", "pdf", "epub"]);
const ABSOLUTE_PROTOCOL = /^[a-z][a-z\d+.-]*:/i;

export type LinkTargetKind = "document" | "asset";

/**
 * One extracted library link. Out-of-library targets (`..` escapes,
 * absolute protocols, `//` prefixes, empty paths) are dropped at
 * extraction time, matching the frontend's blocked-navigation semantics.
 */
export type ExtractedLink =
  | {
      kind: "relative";
      targetPath: string;
      targetKind: LinkTargetKind;
      linkText: string;
      fragment: string | null;
    }
  | {
      /** `[[wiki]]`: only the normalized stem is stored; resolution against the live document set happens at query time (BL-D1). */
      kind: "wiki";
      stem: string;
      linkText: string;
      fragment: string | null;
    };

/** Aggregated backlink row (serde camelCase twin of `BacklinkEntry`). */
export interface BacklinkEntry {
  sourcePath: string;
  sourceTitle: string;
  linkText: string;
  count: number;
}

export interface OutgoingEntry {
  kind: "document" | "asset" | "wiki";
  /** Resolved library path; also filled for uniquely resolved wiki links. */
  targetPath: string | null;
  /** Display form: the stored path for standard links, the stem for wiki links. */
  rawTarget: string;
  linkText: string;
  /** Target is in the present set (wiki: uniquely resolved). Asset existence is never checked. */
  present: boolean;
  /** Wiki candidate count when ambiguous (> 1); 0 otherwise. */
  ambiguousCount: number;
}

export interface DocumentLinks {
  backlinks: BacklinkEntry[];
  outgoing: OutgoingEntry[];
  /** Missing document targets (unresolved wiki stems included, ambiguous ones excluded); assets never count. */
  brokenCount: number;
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolves a markdown link target against the library, mirroring
 * `resolveLibraryPath` in `src/App.tsx` line for line: strip `?`/`#` →
 * percent-decode (fall back to the raw text) → trim → `\` → `/` → reject
 * empty / `//` prefixes / absolute protocols → resolve `.`/`..` against
 * the document directory (or the library root for a leading `/`), where
 * popping past the root returns null.
 */
export function resolveLibraryPath(source: string, documentPath: string): string | null {
  const pathOnly = decodePath(source.split(/[?#]/, 1)[0] ?? "")
    .trim()
    .replace(/\\/g, "/");
  if (!pathOnly || pathOnly.startsWith("//") || ABSOLUTE_PROTOCOL.test(pathOnly)) {
    return null;
  }

  const base = pathOnly.startsWith("/")
    ? []
    : documentPath.replace(/\\/g, "/").split("/").slice(0, -1);

  for (const segment of pathOnly.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (base.length === 0) return null;
      base.pop();
    } else {
      base.push(segment);
    }
  }

  return base.join("/");
}

/** Cuts the extension off a file name; a leading dot is part of the name. */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Lowercased file-name stem (`notes/Note A.md` → `note a`), the BL-D1 lookup key for stems without a `/`. */
export function wikiFileStem(path: string): string {
  const segments = path.split("/");
  return stripExtension(segments[segments.length - 1] ?? path).toLowerCase();
}

/** Lowercased extension-less full path (`notes/Note A.md` → `notes/note a`), the lookup key for stems containing `/`. */
export function wikiPathStem(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return stripExtension(path).toLowerCase();
  return `${path.slice(0, slash)}/${stripExtension(path.slice(slash + 1))}`.toLowerCase();
}

function hasDocumentExtension(path: string): boolean {
  const segments = path.split("/");
  const fileName = segments[segments.length - 1] ?? path;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return false;
  return DOCUMENT_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase());
}

function truncateChars(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

/**
 * Extracts library links from one markdown document. Fenced code blocks
 * (``` / ~~~, the `extract_title` flip logic) and inline code spans are
 * skipped; the output is capped at {@link MAX_DOCUMENT_LINKS}.
 */
export function extractDocumentLinks(sourcePath: string, markdown: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    extractLineLinks(sourcePath, line, links);
    if (links.length >= MAX_DOCUMENT_LINKS) break;
  }
  return links.slice(0, MAX_DOCUMENT_LINKS);
}

function extractLineLinks(sourcePath: string, line: string, links: ExtractedLink[]): void {
  const chars = Array.from(line);
  maskCodeSpans(chars);
  const length = chars.length;
  let position = 0;
  while (position < length && links.length < MAX_DOCUMENT_LINKS) {
    if (chars[position] !== "[") {
      position += 1;
      continue;
    }
    const scan =
      position + 1 < length && chars[position + 1] === "["
        ? scanWiki(chars, position)
        : scanInline(sourcePath, chars, position);
    if (scan === null) {
      position += 1;
      continue;
    }
    if (scan.link) links.push(scan.link);
    position = scan.next;
  }
}

/**
 * Blanks inline code spans in place: a backtick run closes at the next
 * run of the same length (CommonMark's core rule); unmatched runs stay
 * literal. Blanking preserves indices for the link scanner.
 */
function maskCodeSpans(chars: string[]): void {
  const runs: Array<{ start: number; length: number }> = [];
  let index = 0;
  while (index < chars.length) {
    if (chars[index] === "`") {
      const start = index;
      while (index < chars.length && chars[index] === "`") index += 1;
      runs.push({ start, length: index - start });
    } else {
      index += 1;
    }
  }
  let runIndex = 0;
  while (runIndex < runs.length) {
    const { start, length } = runs[runIndex];
    let closing = -1;
    for (let candidate = runIndex + 1; candidate < runs.length; candidate += 1) {
      if (runs[candidate].length === length) {
        closing = candidate;
        break;
      }
    }
    if (closing >= 0) {
      const end = runs[closing].start + runs[closing].length;
      for (let slot = start; slot < end; slot += 1) chars[slot] = " ";
      runIndex = closing + 1;
    } else {
      runIndex += 1;
    }
  }
}

/** `null` = not link syntax (advance one char); `link: null` = consumed syntax without a library link. */
interface LinkScan {
  next: number;
  link: ExtractedLink | null;
}

function scanWiki(chars: readonly string[], open: number): LinkScan | null {
  const length = chars.length;
  let close = -1;
  for (let cursor = open + 2; cursor + 1 < length; cursor += 1) {
    if (chars[cursor] === "]" && chars[cursor + 1] === "]") {
      close = cursor;
      break;
    }
  }
  if (close < 0) return null;
  const inner = chars.slice(open + 2, close).join("");
  if (inner.includes("[") || inner.includes("]")) return { next: open + 2, link: null };
  const next = close + 2;
  const pipe = inner.indexOf("|");
  const targetPart = pipe >= 0 ? inner.slice(0, pipe) : inner;
  const aliasPart = pipe >= 0 ? inner.slice(pipe + 1) : null;
  const hash = targetPart.indexOf("#");
  const stemRaw = hash >= 0 ? targetPart.slice(0, hash) : targetPart;
  const fragmentRaw = hash >= 0 ? targetPart.slice(hash + 1) : null;
  const stem = stemRaw.trim().replace(/\\/g, "/").toLowerCase();
  if (!stem) return { next, link: null };
  const alias = aliasPart?.trim() || null;
  const linkText = truncateChars(alias ?? targetPart.trim(), MAX_LINK_TEXT_CHARS);
  const fragment = fragmentRaw?.trim() || null;
  return { next, link: { kind: "wiki", stem, linkText, fragment } };
}

function scanInline(
  sourcePath: string,
  chars: readonly string[],
  open: number,
): LinkScan | null {
  const length = chars.length;
  let textClose = -1;
  for (let cursor = open + 1; cursor < length; cursor += 1) {
    if (chars[cursor] === "]") {
      textClose = cursor;
      break;
    }
  }
  if (textClose < 0) return null;
  if (textClose + 1 >= length || chars[textClose + 1] !== "(") return null;
  let destinationClose = -1;
  for (let cursor = textClose + 2; cursor < length; cursor += 1) {
    if (chars[cursor] === ")") {
      destinationClose = cursor;
      break;
    }
  }
  if (destinationClose < 0) return null;
  const next = destinationClose + 1;
  const rawDestination = chars.slice(textClose + 2, destinationClose).join("");
  const destination = splitDestination(rawDestination);
  if (destination === null) return { next, link: null };
  // The fragment mirrors handleNavigate: the text between the first and
  // the second `#`, percent-decoded for display and anchor jumps.
  let fragment: string | null = null;
  const hash = destination.indexOf("#");
  if (hash >= 0) {
    const value = destination.slice(hash + 1).split("#", 1)[0] ?? "";
    fragment = value ? decodePath(value) : null;
  }
  const targetPath = resolveLibraryPath(destination, sourcePath);
  if (targetPath === null || targetPath === "") return { next, link: null };
  const text = chars.slice(open + 1, textClose).join("");
  return {
    next,
    link: {
      kind: "relative",
      targetPath,
      targetKind: hasDocumentExtension(targetPath) ? "document" : "asset",
      linkText: truncateChars(text.trim(), MAX_LINK_TEXT_CHARS),
      fragment,
    },
  };
}

/**
 * Trims the destination and cuts an optional quoted title. A destination
 * with embedded whitespace and no quoted title is not a link (CommonMark
 * requires `<>` there, which the extractor does not support).
 */
function splitDestination(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const whitespace = /\s/u.exec(trimmed);
  if (!whitespace) return trimmed;
  const head = trimmed.slice(0, whitespace.index);
  const rest = trimmed.slice(whitespace.index).trimStart();
  return rest.startsWith('"') || rest.startsWith("'") ? head : null;
}

// ---- Query-time wiki resolution and web aggregation (BL-D1/BL-D4) ----

export interface WikiResolution {
  /** Filled only for a unique hit; ambiguity never builds an edge. */
  targetPath: string | null;
  candidateCount: number;
}

interface WikiIndexMaps {
  byName: Map<string, string[]>;
  byPath: Map<string, string[]>;
}

function buildWikiIndexMaps(paths: Iterable<string>): WikiIndexMaps {
  const byName = new Map<string, string[]>();
  const byPath = new Map<string, string[]>();
  for (const path of paths) {
    const name = wikiFileStem(path);
    const nameBucket = byName.get(name);
    if (nameBucket) nameBucket.push(path);
    else byName.set(name, [path]);
    const pathStem = wikiPathStem(path);
    const pathBucket = byPath.get(pathStem);
    if (pathBucket) pathBucket.push(path);
    else byPath.set(pathStem, [path]);
  }
  return { byName, byPath };
}

function resolveStem(maps: WikiIndexMaps, stem: string): WikiResolution {
  const candidates = stem.includes("/") ? maps.byPath.get(stem) : maps.byName.get(stem);
  if (!candidates || candidates.length === 0) return { targetPath: null, candidateCount: 0 };
  return {
    targetPath: candidates.length === 1 ? candidates[0] : null,
    candidateCount: candidates.length,
  };
}

/**
 * Resolves wiki stems against the present document set: file-name stems
 * for plain stems, extension-less full paths for stems containing `/`,
 * both case-insensitive. Unique hit → edge; ambiguity → candidate count
 * only (BL-D1).
 */
export function resolveWikiTargets(
  stems: Iterable<string>,
  presentPaths: Iterable<string>,
): Map<string, WikiResolution> {
  const maps = buildWikiIndexMaps(presentPaths);
  const resolutions = new Map<string, WikiResolution>();
  for (const stem of stems) {
    if (!resolutions.has(stem)) resolutions.set(stem, resolveStem(maps, stem));
  }
  return resolutions;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface DocumentLinkSource {
  relativePath: string;
  title: string;
}

/**
 * Web-runtime twin of the desktop `list_document_links` aggregation: same
 * backlink grouping (per source, first link text as excerpt, path order),
 * same outgoing rows and the same broken counting.
 */
export function buildDocumentLinks(
  relativePath: string,
  linksBySource: ReadonlyMap<string, readonly ExtractedLink[]>,
  documents: readonly DocumentLinkSource[],
): DocumentLinks {
  const maps = buildWikiIndexMaps(documents.map((document) => document.relativePath));
  const present = new Set(documents.map((document) => document.relativePath));
  const titles = new Map(
    documents.map((document) => [document.relativePath, document.title] as const),
  );

  const mentions: Array<{ sourcePath: string; ordinal: number; linkText: string }> = [];
  for (const document of documents) {
    const links = linksBySource.get(document.relativePath);
    if (!links) continue;
    links.forEach((link, ordinal) => {
      const resolved =
        link.kind === "relative" ? link.targetPath : resolveStem(maps, link.stem).targetPath;
      if (resolved === relativePath) {
        mentions.push({ sourcePath: document.relativePath, ordinal, linkText: link.linkText });
      }
    });
  }
  mentions.sort(
    (a, b) => compareStrings(a.sourcePath, b.sourcePath) || a.ordinal - b.ordinal,
  );
  const backlinks: BacklinkEntry[] = [];
  for (const mention of mentions) {
    const last = backlinks[backlinks.length - 1];
    if (last && last.sourcePath === mention.sourcePath) {
      last.count += 1;
    } else {
      backlinks.push({
        sourcePath: mention.sourcePath,
        sourceTitle: titles.get(mention.sourcePath) ?? mention.sourcePath,
        linkText: mention.linkText,
        count: 1,
      });
    }
  }

  const outgoing: OutgoingEntry[] = [];
  let brokenCount = 0;
  for (const link of linksBySource.get(relativePath) ?? []) {
    if (link.kind === "wiki") {
      const resolution = resolveStem(maps, link.stem);
      if (resolution.candidateCount === 0) brokenCount += 1;
      outgoing.push({
        kind: "wiki",
        targetPath: resolution.targetPath,
        rawTarget: link.stem,
        linkText: link.linkText,
        present: resolution.targetPath !== null,
        ambiguousCount: resolution.candidateCount > 1 ? resolution.candidateCount : 0,
      });
    } else {
      const isPresent = present.has(link.targetPath);
      if (link.targetKind === "document" && !isPresent) brokenCount += 1;
      outgoing.push({
        kind: link.targetKind,
        targetPath: link.targetPath,
        rawTarget: link.targetPath,
        linkText: link.linkText,
        present: isPresent,
        ambiguousCount: 0,
      });
    }
  }

  return {
    backlinks: backlinks.slice(0, LINKS_LIST_LIMIT),
    outgoing: outgoing.slice(0, LINKS_LIST_LIMIT),
    brokenCount,
  };
}
