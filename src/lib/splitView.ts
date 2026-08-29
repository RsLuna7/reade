/**
 * Pure helpers for the split-view secondary pane
 * (docs/plan-split-view.md §3.1–§3.6).
 *
 * Everything here is DOM-free and unit-testable: the split-position clamp
 * for the divider, the narrow-window breakpoint, the pane content state
 * reduction (with stale-response guarding), link classification for the
 * pane's self-contained navigation, and the markdown asset/display helpers
 * the pane needs.
 *
 * The path/image/markdown helpers here are the single shared implementation
 * for both panes: `resolveLibraryRelativePath` delegates to the canonical
 * `resolveLibraryPath` in `documentLinks.ts` (contract-locked against the
 * Rust twin), and App.tsx imports `collectReferencedImages` /
 * `paneDisplayMarkdown` instead of keeping private copies (dedupe done in
 * the backlinks wiring wave).
 */

import type { DocumentContent } from "./backend";
import { resolveLibraryPath } from "./documentLinks";
import { normalizeMarkdownUrlKey } from "./markdownImages";

// ---------------------------------------------------------------------------
// Divider position (SP-D5) and narrow-window breakpoint (SP-D6)
// ---------------------------------------------------------------------------

export const SPLIT_POS_MIN = 0.3;
export const SPLIT_POS_MAX = 0.7;
export const SPLIT_POS_DEFAULT = 0.5;

/** Clamps `--split-pos` into [0.30, 0.70]; invalid input falls back to 0.5. */
export function clampSplitPos(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_POS_DEFAULT;
  return Math.min(SPLIT_POS_MAX, Math.max(SPLIT_POS_MIN, value));
}

/**
 * Below this window width the split cannot activate and an active split
 * degrades to the main pane only (1079 blocks, 1080 allows).
 */
export const SPLIT_MIN_WINDOW_WIDTH = 1080;

export function canActivateSplit(windowWidth: number): boolean {
  return Number.isFinite(windowWidth) && windowWidth >= SPLIT_MIN_WINDOW_WIDTH;
}

/** Media query for the `useMediaQuery`-style degrade/restore effect. */
export const SPLIT_MEDIA_QUERY = `(min-width: ${SPLIT_MIN_WINDOW_WIDTH}px)`;

// ---------------------------------------------------------------------------
// Pane content state (SP-D1: session-only, self-managed by the component)
// ---------------------------------------------------------------------------

export type PaneContentState =
  | { status: "loading"; path: string }
  | { status: "error"; path: string; message: string }
  | { status: "ready"; path: string; content: DocumentContent };

export type PaneContentAction =
  | { type: "load"; path: string }
  | { type: "loaded"; path: string; content: DocumentContent }
  | { type: "load-failed"; path: string; message: string };

/**
 * Content state reducer. `loaded`/`load-failed` only apply while the pane is
 * still loading that same path, so responses from a superseded request can
 * never clobber the current document (the pane's counterpart of the store's
 * `documentRequest` generation guard).
 */
export function reducePaneContent(
  state: PaneContentState | null,
  action: PaneContentAction,
): PaneContentState | null {
  switch (action.type) {
    case "load":
      return { status: "loading", path: action.path };
    case "loaded":
      if (state?.status !== "loading" || state.path !== action.path) return state;
      return { status: "ready", path: action.path, content: action.content };
    case "load-failed":
      if (state?.status !== "loading" || state.path !== action.path) return state;
      return { status: "error", path: action.path, message: action.message };
  }
}

/** True when the pane's document vanished from the library snapshot (失联态). */
export function isPaneDocumentMissing(
  path: string,
  documents: ReadonlyArray<{ relativePath: string }>,
): boolean {
  const normalized = path.replace(/\\/g, "/");
  return !documents.some((entry) => entry.relativePath.replace(/\\/g, "/") === normalized);
}

// ---------------------------------------------------------------------------
// Library path + markdown helpers (shared with the main pane)
// ---------------------------------------------------------------------------

const EXTERNAL_PROTOCOL = /^(?:https?:|mailto:)/i;

function decodePathValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolves a relative link/image source against the referencing document's
 * library path. Protocol URLs, protocol-relative URLs and parent-directory
 * escapes above the library root all resolve to null (blocked). Delegates
 * to the canonical implementation in `documentLinks.ts`.
 */
export const resolveLibraryRelativePath: (
  source: string,
  documentPath: string,
) => string | null = resolveLibraryPath;

/**
 * Image sources referenced by a markdown body (dedup, declaration order).
 * Angle-bracket destinations may contain spaces; bare destinations may not.
 * Keys are normalised to match remark / react-markdown `img` src values.
 *
 * Also resolves reference-style images (`![alt][label]`, `![label][]`,
 * `![label]`) through their `[label]: destination` definitions: remark
 * renders them into `img` elements, so they must be preloaded just like
 * inline images or they show up as blocked.
 */
export function collectReferencedImages(markdown: string): string[] {
  const sources = new Set<string>();
  const imagePattern =
    /!\[[^\]]*]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const match of markdown.matchAll(imagePattern)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (raw) sources.add(normalizeMarkdownUrlKey(raw));
  }

  const definitions = new Map<string, string>();
  const definitionPattern =
    /^[ \t]{0,3}\[([^\]\n]+)]:[ \t]*(?:<([^>\n]*)>|([^\s]+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)\n]*\)))?[ \t]*$/gm;
  for (const match of markdown.matchAll(definitionPattern)) {
    const label = match[1].trim().toLowerCase();
    const destination = (match[2] ?? match[3] ?? "").trim();
    if (label && destination && !definitions.has(label)) definitions.set(label, destination);
  }

  if (definitions.size > 0) {
    // `(?!\()` skips inline images `![alt](url)` so their alt text is never
    // mistaken for a reference label. Full form uses the second bracket;
    // collapsed (`![label][]`) and shortcut (`![label]`) fall back to the
    // alt text as the label, matching CommonMark.
    const referencePattern = /!\[([^\]]*)](?!\()(?:\[([^\]\n]*)])?/g;
    for (const match of markdown.matchAll(referencePattern)) {
      const label = (match[2] || match[1] || "").trim().toLowerCase();
      if (!label) continue;
      const destination = definitions.get(label);
      if (destination) sources.add(normalizeMarkdownUrlKey(destination));
    }
  }
  return [...sources];
}

/**
 * Local image sources of a markdown document resolved to library paths;
 * data URLs, external URLs and out-of-library references are dropped.
 */
export function paneImageAssetPaths(
  markdown: string,
  documentPath: string,
): Array<{ source: string; relativePath: string }> {
  const entries: Array<{ source: string; relativePath: string }> = [];
  for (const source of collectReferencedImages(markdown)) {
    if (source.startsWith("data:") || EXTERNAL_PROTOCOL.test(source)) continue;
    const relativePath = resolveLibraryRelativePath(source, documentPath);
    if (relativePath) {
      entries.push({ source: normalizeMarkdownUrlKey(source), relativePath });
    }
  }
  return entries;
}

/**
 * Display form of a markdown body: strips the BOM, a leading YAML
 * frontmatter block, and the leading H1 (the pane header already shows the
 * document title) — mirrors the main pane's presentation.
 */
export function paneDisplayMarkdown(markdown: string): string {
  let content = markdown.replace(/^\uFEFF/, "");
  content = content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
  return content.replace(/^\s*#\s+[^\r\n]+(?:\r?\n|$)/, "").trimStart();
}

// ---------------------------------------------------------------------------
// Pane-internal navigation (§3.3: in-library links switch the pane itself)
// ---------------------------------------------------------------------------

export const PANE_BLOCKED_LINK_NOTICE = "目标不在当前 Markdown 文档库中，已阻止打开。";

export type PaneNavigation =
  | { kind: "anchor"; id: string }
  | { kind: "external"; href: string }
  | { kind: "document"; path: string; hash: string | null }
  | { kind: "blocked"; reason: string };

/**
 * Classifies a link click inside the pane: same-document anchors scroll the
 * pane, external links go through the confirm + `openExternalLink` flow,
 * in-library documents navigate the pane itself (never `selectDocument`),
 * and everything else is blocked with the main pane's wording.
 */
export function classifyPaneNavigation(
  href: string,
  paneDocumentPath: string,
  documents: ReadonlyArray<{ relativePath: string }>,
): PaneNavigation {
  if (href.startsWith("#")) {
    return { kind: "anchor", id: decodePathValue(href.slice(1)) };
  }
  if (EXTERNAL_PROTOCOL.test(href)) {
    return { kind: "external", href };
  }
  const [pathPart, hash] = href.split("#", 2);
  const targetPath = resolveLibraryRelativePath(pathPart, paneDocumentPath);
  const target = targetPath
    ? documents.find((entry) => entry.relativePath.replace(/\\/g, "/") === targetPath)
    : undefined;
  if (!target) {
    return { kind: "blocked", reason: PANE_BLOCKED_LINK_NOTICE };
  }
  return {
    kind: "document",
    path: target.relativePath,
    hash: hash ? decodePathValue(hash) : null,
  };
}
