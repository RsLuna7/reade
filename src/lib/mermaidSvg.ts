/**
 * Mermaid `securityLevel: "sandbox"` wraps the diagram in an iframe whose
 * `src` is a `data:text/html` document. Tauri CSP is `frame-src 'self' blob:`,
 * so WebView2/Chromium paints the "已阻止此内容" interstitial instead of the
 * chart. Unwrap that wrapper and keep a sanitized inline SVG.
 */

const FORBIDDEN_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "audio",
  "video",
  "source",
  "track",
  "applet",
  "frame",
  "frameset",
  "html",
  "head",
  "body",
  "parsererror",
]);

const URL_ATTR_NAMES = new Set(["href", "src", "xlink:href", "xlink:src", "action", "formaction", "cite", "poster"]);

const DATA_HTML_URL =
  /^data:text\/html(?:;charset=[\w-]+)?(;base64)?,([\s\S]*)$/i;

const UNSAFE_CSS = /javascript:|expression\s*\(|-moz-binding|@import/i;
const CSS_URL = /url\s*\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

function decodeBase64(payload: string): string {
  const binary = atob(payload.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Base64 → UTF-8 文本;库内 .svg 资产管线与 Mermaid 沙箱解包共用。 */
export function decodeBase64Text(payload: string): string {
  return decodeBase64(payload);
}

function decodeDataHtmlUrl(src: string): string | null {
  const match = DATA_HTML_URL.exec(src.trim());
  if (!match) {
    return null;
  }

  try {
    return match[1] ? decodeBase64(match[2]) : decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

function unwrapSandboxIframe(markup: string): string {
  const trimmed = markup.trim();
  if (!/^<iframe[\s>]/i.test(trimmed)) {
    return markup;
  }

  const parsed = new DOMParser().parseFromString(trimmed, "text/html");
  const iframe = parsed.querySelector("iframe");
  if (!iframe) {
    return markup;
  }

  const srcdoc = iframe.getAttribute("srcdoc");
  if (srcdoc) {
    return srcdoc;
  }

  const fromData = decodeDataHtmlUrl(iframe.getAttribute("src") ?? "");
  return fromData ?? markup;
}

function extractSvgMarkup(markup: string): string | null {
  const lower = markup.toLowerCase();
  const start = lower.indexOf("<svg");
  const end = lower.lastIndexOf("</svg>");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  return markup.slice(start, end + "</svg>".length);
}

function parseSvgRoot(markup: string): Element | null {
  const xml = new DOMParser().parseFromString(markup, "image/svg+xml");
  if (!xml.querySelector("parsererror")) {
    const root = xml.documentElement;
    if (root && root.localName.toLowerCase() === "svg") {
      return root;
    }
  }

  return new DOMParser().parseFromString(markup, "text/html").querySelector("svg");
}

function isSafeSvgUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function cssUrlsAreSafe(value: string): boolean {
  CSS_URL.lastIndex = 0;
  for (const match of value.matchAll(CSS_URL)) {
    if (!match[2].trim().startsWith("#")) {
      return false;
    }
  }
  return !UNSAFE_CSS.test(value);
}

function tagNameOf(element: Element): string {
  return element.localName.toLowerCase();
}

function sanitizeSvgRoot(root: Element): boolean {
  // 根元素也要过属性清洗:任意库内 SVG 可以在 <svg> 根上挂 onload,
  // querySelectorAll("*") 不含根,Mermaid 输出覆盖不到这一面。
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const element of elements) {
    if (FORBIDDEN_TAGS.has(tagNameOf(element))) {
      element.remove();
      continue;
    }

    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const local = attr.localName.toLowerCase();

      if (name.startsWith("on") || name === "srcdoc") {
        element.removeAttribute(attr.name);
        continue;
      }

      if (URL_ATTR_NAMES.has(name) || URL_ATTR_NAMES.has(local) || name.endsWith(":href") || name.endsWith(":src")) {
        if (!isSafeSvgUrl(attr.value)) {
          element.removeAttribute(attr.name);
        }
        continue;
      }

      if ((name === "style" || local === "style") && !cssUrlsAreSafe(attr.value)) {
        element.removeAttribute(attr.name);
      }
    }

    if (tagNameOf(element) === "style" && !cssUrlsAreSafe(element.textContent ?? "")) {
      element.remove();
    }
  }

  return !root.querySelector("iframe, script, object, embed");
}

/** Returns inline SVG safe to inject, or null when the diagram must be rejected. */
export function sanitizeMermaidSvg(markup: string): string | null {
  const unwrapped = unwrapSandboxIframe(markup);
  const svgMarkup = extractSvgMarkup(unwrapped);
  if (!svgMarkup) {
    return null;
  }

  const root = parseSvgRoot(svgMarkup);
  if (!root) {
    return null;
  }

  if (!sanitizeSvgRoot(root)) {
    return null;
  }

  const serialized = new XMLSerializer().serializeToString(root);
  if (/<iframe[\s>]/i.test(serialized) || /<script[\s>]/i.test(serialized)) {
    return null;
  }
  return serialized;
}

/**
 * 库内 `.svg` 文件与 Mermaid 输出走同一条消毒管线(禁脚本/事件处理器/
 * 外部引用/危险 CSS),再以内联 SVG 渲染。语义化别名,方便资产管线
 * 调用点读出信任模型。
 */
export function sanitizeLibrarySvg(markup: string): string | null {
  return sanitizeMermaidSvg(markup);
}
