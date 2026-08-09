export interface WebRoute {
  documentPath: string;
  heading: string | null;
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

/** Parses `?doc=relative/path.md#heading` from a URL or `window.location`. */
export function parseWebRoute(location: WebLocationLike): WebRoute | null {
  const rawDocumentPath = queryValue(location.search, "doc");
  if (rawDocumentPath === null) {
    return null;
  }

  const documentPath = normalizeWebDocumentPath(rawDocumentPath);
  const heading = parseHeading(location.hash);
  if (documentPath === null || !heading.valid) {
    return null;
  }

  return { documentPath, heading: heading.value };
}

/**
 * Builds a shareable URL while preserving unrelated query parameters.
 * An empty or omitted heading intentionally clears the existing hash.
 */
export function buildWebRouteUrl(
  currentUrl: string | URL,
  documentPath: string,
  heading?: string | null,
): string {
  const normalizedPath = normalizeWebDocumentPath(documentPath);
  if (normalizedPath === null) {
    throw new TypeError("Invalid relative document path");
  }

  if (heading && CONTROL_CHARACTERS.test(heading)) {
    throw new TypeError("Invalid heading");
  }

  const url = new URL(currentUrl.toString());
  url.searchParams.set("doc", normalizedPath);
  url.hash = heading ? encodeURIComponent(heading) : "";
  return url.toString();
}
