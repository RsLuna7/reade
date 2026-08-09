export const MAX_MERMAID_TEXT_SIZE = 50_000;
export const MAX_MERMAID_EDGES = 500;

export interface TocItem {
  id: string;
  title: string;
  level: number;
  sourceStart?: number;
  sourceEnd?: number;
}

const SAFE_REMOTE_PROTOCOL = /^(?:https?:|mailto:)/i;
const ABSOLUTE_PROTOCOL = /^[a-z][a-z\d+.-]*:/i;
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f-\u009f]/g;
const SAFE_DATA_IMAGE =
  /^data:image\/(?:avif|gif|jpeg|png|webp)(?:;[a-z\d!#$&^_.+-]+=[a-z\d!#$&^_.+/%-]+)*(?:;base64)?,[a-z\d+/=%\s._~-]*$/i;

/**
 * URL policy shared by links and images rendered from untrusted Markdown.
 *
 * Relative paths and same-document hashes are kept for the host application to
 * resolve. Protocol-relative, local file, script and arbitrary data URLs are
 * deliberately rejected. SVG data URLs are excluded because they can contain
 * active content.
 */
export function safeUrlTransform(url: string): string | null {
  const value = url.trim();

  if (!value) {
    return "";
  }

  const compact = value.replace(CONTROL_OR_SPACE, "");
  if (compact !== value && ABSOLUTE_PROTOCOL.test(compact)) {
    return null;
  }

  if (value.startsWith("#")) {
    return value;
  }

  if (value.startsWith("//") || value.startsWith("\\\\")) {
    return null;
  }

  if (SAFE_REMOTE_PROTOCOL.test(value)) {
    return value;
  }

  if (value.toLowerCase().startsWith("data:image/")) {
    return SAFE_DATA_IMAGE.test(value) ? value : null;
  }

  return ABSOLUTE_PROTOCOL.test(value) ? null : value;
}

function optionalLine(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Extracts the rendered document outline without reparsing the Markdown. */
export function extractToc(root: ParentNode): TocItem[] {
  return Array.from(root.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")).map(
    (heading) => ({
      id: heading.id,
      title: heading.textContent?.trim() ?? "",
      level: Number.parseInt(heading.tagName.slice(1), 10),
      sourceStart: optionalLine(heading.dataset.sourceStart),
      sourceEnd: optionalLine(heading.dataset.sourceEnd),
    }),
  );
}

/** A cheap guard before handing input to Mermaid's parser. */
export function countMermaidEdges(source: string): number {
  return source.match(/(?:-->|<-->|---|==>|-.->|--[ox]|->>|-->>|\)o--o\()/g)?.length ?? 0;
}
