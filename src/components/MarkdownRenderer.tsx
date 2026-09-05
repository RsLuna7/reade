import {
  Children,
  createElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  MAX_MERMAID_EDGES,
  MAX_MERMAID_TEXT_SIZE,
  countMermaidEdges,
  safeUrlTransform,
} from "../lib/markdown";
import { isRemoteHttpUrl, normalizeMarkdownUrlKey, preferLinkedVideoHref } from "../lib/markdownImages";
import { sanitizeMermaidSvg } from "../lib/mermaidSvg";

export interface MarkdownRendererProps {
  content: string;
  className?: string;
  resolveImageSrc?: (source: string) => string | null;
  resolveLinkHref?: (href: string) => string | null;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * Called when the reader opts in from a blocked remote-image placeholder.
   * When omitted, remote blocks stay informational only.
   */
  onAllowRemoteImages?: () => void;
  /**
   * 悬停/聚焦意图上报(plan-hover-preview §3.2):分类与计时都在上层,
   * 渲染器只转发事件;不挂时零行为变化。
   */
  onLinkPreview?: (
    href: string,
    anchor: HTMLElement,
    trigger: "hover" | "focus",
  ) => void;
  onLinkPreviewCancel?: () => void;
  /**
   * 本地图片未命中资产表时的按需加载兜底:remark 交给 `img` 的 src 是
   * 唯一事实,预加载清单(上游正则收集)只是加速路径。上层去重,渲染器
   * 只转发;不挂时保持纯静态的拦截占位。
   */
  onLoadLocalImage?: (source: string) => void;
  /** 归一化 src → 加载失败原因;命中时占位符从"已拦截"改为具体原因。 */
  localImageErrors?: Record<string, string>;
  /**
   * 归一化 src → 已消毒的内联 SVG 标记(库内 .svg 文件经
   * sanitizeLibrarySvg 处理)。返回值直接注入 DOM,安全边界在上层消毒,
   * 不再过 safeUrlTransform——那是 URL 策略,不是标记策略。
   */
  resolveLocalSvg?: (source: string) => string | null;
}

type SourcePosition = {
  start?: { line?: number };
  end?: { line?: number };
};

type HeadingProps = ComponentPropsWithoutRef<"h1"> &
  ExtraProps & {
    node?: { position?: SourcePosition };
  };

function heading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const tag = `h${level}` as const;

  return function MarkdownHeading({ node, ...props }: HeadingProps) {
    const sourceStart = node?.position?.start?.line;
    const sourceEnd = node?.position?.end?.line;

    return createElement(tag, {
      ...props,
      "data-heading-level": level,
      "data-source": sourceStart ? `${sourceStart}:${sourceEnd ?? sourceStart}` : undefined,
      "data-source-start": sourceStart,
      "data-source-end": sourceEnd,
    });
  };
}

type SourceStampedTag = "p" | "ul" | "ol" | "blockquote" | "table";
type BlockProps = ComponentPropsWithoutRef<SourceStampedTag> &
  ExtraProps & {
    node?: { position?: SourcePosition };
  };

/**
 * 块级元素的源行号位置戳（plan-incremental-reread §8）：沿标题先例
 * 附加 data-source-start/end，供增量重读把变更段落映射回渲染 DOM。
 * 纯附加属性，无行为变化。
 */
function sourceStampedBlock(tag: SourceStampedTag) {
  return function MarkdownBlock({ node, ...props }: BlockProps) {
    return createElement(tag, {
      ...props,
      "data-source-start": node?.position?.start?.line,
      "data-source-end": node?.position?.end?.line,
    });
  };
}

function codeDetails(children: ReactNode): { code: string; language: string | null } | null {
  const child = Children.only(children);
  if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) {
    return null;
  }

  const code = String(child.props.children ?? "").replace(/\n$/, "");
  const languageMatch = /(?:^|\s)language-([\w+-]+)/.exec(child.props.className ?? "");
  return { code, language: languageMatch?.[1]?.toLowerCase() ?? null };
}

async function writeClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable");
  }

  await navigator.clipboard.writeText(text);
}

const languageLoaders = {
  bash: () => import("shiki/langs/bash.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
} as const;

const languageAliases: Record<string, keyof typeof languageLoaders> = {
  "c#": "csharp",
  "c++": "cpp",
  cs: "csharp",
  htm: "html",
  js: "javascript",
  md: "markdown",
  py: "python",
  ps1: "powershell",
  rs: "rust",
  sh: "shellscript",
  shell: "shellscript",
  ts: "typescript",
  yml: "yaml",
};

async function createCoreHighlighter() {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
    await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark.mjs"),
    ]);

  return createHighlighterCore({
    themes: [light.default, dark.default],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
}

let coreHighlighter: ReturnType<typeof createCoreHighlighter> | undefined;
const languageLoads = new Map<string, Promise<void>>();

async function highlightCode(code: string, requestedLanguage: string | null) {
  if (!requestedLanguage) return null;
  const language =
    languageAliases[requestedLanguage] ??
    (requestedLanguage in languageLoaders
      ? (requestedLanguage as keyof typeof languageLoaders)
      : null);
  if (!language) return null;

  const highlighter = await (coreHighlighter ??= createCoreHighlighter());
  let load = languageLoads.get(language);
  if (!load) {
    load = languageLoaders[language]().then(async ({ default: registration }) => {
      await highlighter.loadLanguage(registration);
    });
    languageLoads.set(language, load);
  }
  await load;

  return highlighter.codeToHtml(code, {
    lang: language,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
}

function CodeBlock({
  code,
  language,
  sourceStart,
  sourceEnd,
}: {
  code: string;
  language: string | null;
  sourceStart?: number;
  sourceEnd?: number;
}) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    let cancelled = false;
    setHighlightedHtml(null);

    void highlightCode(code, language)
      .then((html) => {
        if (!cancelled && html) {
          setHighlightedHtml(html);
        }
      })
      .catch(() => {
        // Unknown grammars and loading failures intentionally keep plain code.
      });

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const copy = async () => {
    try {
      await writeClipboard(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <figure
      className="markdown-code-block"
      data-language={language ?? "text"}
      data-source-start={sourceStart}
      data-source-end={sourceEnd}
    >
      <figcaption className="markdown-code-toolbar">
        <span className="markdown-code-language">{language ?? "text"}</span>
        <button className="markdown-code-copy" type="button" onClick={copy} aria-label="复制代码">
          {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}
        </button>
      </figcaption>
      {highlightedHtml ? (
        <div className="markdown-code-highlight" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
      ) : (
        <pre className="markdown-code-plain">
          <code className={language ? `language-${language}` : undefined}>{code}</code>
        </pre>
      )}
    </figure>
  );
}

let mermaidLoader: Promise<(typeof import("mermaid"))["default"]> | undefined;

function loadMermaid() {
  mermaidLoader ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // Inline SVG + DOMPurify. Sandbox iframes use data: URLs that Tauri CSP
      // `frame-src` blocks, which WebView2 renders as "已阻止此内容".
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: MAX_MERMAID_TEXT_SIZE,
      maxEdges: MAX_MERMAID_EDGES,
      deterministicIds: true,
      htmlLabels: false,
    });
    return mermaid;
  });
  return mermaidLoader;
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "图表语法无效";
  return message.replace(/\s+/g, " ").slice(0, 240);
}

function MermaidBlock({
  source,
  sourceStart,
  sourceEnd,
}: {
  source: string;
  sourceStart?: number;
  sourceEnd?: number;
}) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const target = containerRef.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }

    if (source.length > MAX_MERMAID_TEXT_SIZE) {
      setError(`图表超过 ${MAX_MERMAID_TEXT_SIZE.toLocaleString()} 字符限制`);
      return;
    }

    if (countMermaidEdges(source) > MAX_MERMAID_EDGES) {
      setError(`图表超过 ${MAX_MERMAID_EDGES} 条连线限制`);
      return;
    }

    let cancelled = false;
    const target = containerRef.current;
    const renderHost = document.createElement("div");
    renderHost.className = "markdown-mermaid-render-host";
    target?.append(renderHost);

    void loadMermaid()
      .then((mermaid) => mermaid.render(id, source, renderHost))
      .then(({ svg: renderedSvg }) => {
        if (cancelled) {
          return;
        }
        const safeSvg = sanitizeMermaidSvg(renderedSvg);
        if (safeSvg) {
          setSvg(safeSvg);
          setError(null);
        } else {
          setSvg(null);
          setError("图表输出未通过安全检查");
        }
      })
      .catch((renderError: unknown) => {
        if (!cancelled) {
          setSvg(null);
          setError(readableError(renderError));
        }
      })
      .finally(() => {
        renderHost.remove();
      });

    return () => {
      cancelled = true;
      renderHost.remove();
    };
  }, [id, source, visible]);

  return (
    <div
      className="markdown-mermaid"
      ref={containerRef}
      data-source-start={sourceStart}
      data-source-end={sourceEnd}
    >
      {error ? (
        <div className="markdown-mermaid-error" role="alert">
          <strong>Mermaid 图表无法渲染</strong>
          <span>{error}</span>
        </div>
      ) : svg ? (
        <div
          className="markdown-mermaid-diagram"
          role="img"
          aria-label="Mermaid 图表"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="markdown-mermaid-loading" aria-live="polite">
          正在渲染图表…
        </div>
      )}
    </div>
  );
}

function MarkdownPre({
  children,
  sourceStart,
  sourceEnd,
}: {
  children?: ReactNode;
  sourceStart?: number;
  sourceEnd?: number;
}) {
  // pre 链（普通 pre / 代码块 figure / Mermaid 容器）与其他块级元素
  // 一样带源行号位置戳（plan-incremental-reread §8）。
  const stamp = { "data-source-start": sourceStart, "data-source-end": sourceEnd };
  const details = codeDetails(children);
  if (!details) {
    return <pre {...stamp}>{children}</pre>;
  }

  if (details.language === "mermaid") {
    return <MermaidBlock source={details.code} sourceStart={sourceStart} sourceEnd={sourceEnd} />;
  }

  return <CodeBlock {...details} sourceStart={sourceStart} sourceEnd={sourceEnd} />;
}

function resolvedUrl(value: string, resolver?: (value: string) => string | null): string | null {
  const initiallySafe = safeUrlTransform(value);
  if (initiallySafe === null) {
    return null;
  }

  const resolved = resolver ? resolver(initiallySafe) : initiallySafe;
  return resolved === null ? null : safeUrlTransform(resolved);
}

/** 从 react-markdown 交给 `a` 的 hast 节点里收集所含 `img` 的原始 src。 */
function imageSourcesFromLinkNode(node: unknown): string[] {
  const sources: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const element = value as {
      type?: string;
      tagName?: string;
      properties?: { src?: unknown };
      children?: unknown[];
    };
    if (
      element.type === "element" &&
      element.tagName === "img" &&
      typeof element.properties?.src === "string" &&
      element.properties.src
    ) {
      sources.push(element.properties.src);
    }
    if (Array.isArray(element.children)) {
      for (const child of element.children) visit(child);
    }
  };
  visit(node);
  return sources;
}

/**
 * 库内 .svg 资产:上层已经 sanitizeLibrarySvg 消毒,这里只负责以
 * 行内元素承载(Mermaid 图表同一信任模型),不经过 URL 策略。
 */
function InlineSvgImage({ markup, alt }: { markup: string; alt?: string }) {
  return (
    <span
      className="markdown-image-svg"
      role="img"
      aria-label={alt || "库内 SVG 图像"}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

/**
 * 未命中资产表的本地图片占位:挂载即把 remark 交来的真实 src 上报给
 * 上层按需读取,读取成功后资产表更新、本组件被真正的 img 替换。
 * 读取失败(文件缺失/越界/超限)则停在与远程拦截一致的占位样式。
 */
function BlockedLocalImage({
  source,
  alt,
  failure,
  onLoadLocalImage,
}: {
  source: string;
  alt?: string;
  failure?: string;
  onLoadLocalImage: (source: string) => void;
}) {
  useEffect(() => {
    onLoadLocalImage(source);
  }, [source, onLoadLocalImage]);

  return (
    <span className="markdown-image-blocked">
      <span>{failure ? `图片加载失败：${failure}` : (alt || "图片已拦截")}</span>
    </span>
  );
}

export function MarkdownRenderer({
  content,
  className,
  resolveImageSrc,
  resolveLinkHref,
  onNavigate,
  onAllowRemoteImages,
  onLinkPreview,
  onLinkPreviewCancel,
  onLoadLocalImage,
  localImageErrors,
  resolveLocalSvg,
}: MarkdownRendererProps) {
  const components: Components = {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    p: sourceStampedBlock("p"),
    ul: sourceStampedBlock("ul"),
    ol: sourceStampedBlock("ol"),
    blockquote: sourceStampedBlock("blockquote"),
    table: sourceStampedBlock("table"),
    code: ({ node, ...props }) => {
      void node;
      return <code {...props} />;
    },
    pre: ({ node, ...props }) => {
      const position = (node as { position?: SourcePosition } | undefined)?.position;
      return (
        <MarkdownPre
          {...props}
          sourceStart={position?.start?.line}
          sourceEnd={position?.end?.line}
        />
      );
    },
    a: ({ node, href, children, ...props }) => {
      const resolved = typeof href === "string" ? resolvedUrl(href, resolveLinkHref) : null;
      if (resolved === null) {
        return <span className="markdown-link-blocked">{children}</span>;
      }

      // 图包链接：若内含 Vimeo CDN 缩略图，优先跳未列出观看页，而不是文章首页。
      const target = preferLinkedVideoHref(resolved, imageSourcesFromLinkNode(node));

      return (
        <a
          {...props}
          href={target}
          rel={/^https?:/i.test(target) ? "noopener noreferrer" : props.rel}
          onClick={(event) => {
            if (onNavigate) {
              event.preventDefault();
              onNavigate(target, event);
            }
          }}
          onMouseEnter={
            onLinkPreview
              ? (event) => onLinkPreview(target, event.currentTarget, "hover")
              : undefined
          }
          onMouseLeave={onLinkPreviewCancel}
          onFocus={
            onLinkPreview
              ? (event) => onLinkPreview(target, event.currentTarget, "focus")
              : undefined
          }
          onBlur={onLinkPreviewCancel}
        >
          {children}
        </a>
      );
    },
    img: ({ node, src, alt, ...props }) => {
      void node;
      const resolved = typeof src === "string" ? resolvedUrl(src, resolveImageSrc) : null;
      if (resolved === null) {
        const remote = typeof src === "string" && isRemoteHttpUrl(src);
        const localCandidate =
          !remote && typeof src === "string" && !!src && !src.startsWith("data:");
        if (localCandidate) {
          const initiallySafe = safeUrlTransform(src);
          if (initiallySafe !== null) {
            const svg = resolveLocalSvg?.(initiallySafe) ?? null;
            if (svg) {
              return <InlineSvgImage markup={svg} alt={alt} />;
            }
          }
          if (onLoadLocalImage) {
            return (
              <BlockedLocalImage
                source={src}
                alt={alt}
                failure={localImageErrors?.[normalizeMarkdownUrlKey(src)]}
                onLoadLocalImage={onLoadLocalImage}
              />
            );
          }
        }
        return (
          <span className="markdown-image-blocked">
            <span>{alt || (remote ? "远程图片已拦截" : "图片已拦截")}</span>
            {remote && onAllowRemoteImages ? (
              <button
                type="button"
                className="markdown-image-blocked-action"
                onClick={(event) => {
                  // 占位可能包在 [![...](img)](url) 的 <a> 里；阻止冒泡，
                  // 避免「允许加载」同时触发外链确认。
                  event.preventDefault();
                  event.stopPropagation();
                  onAllowRemoteImages();
                }}
              >
                允许加载
              </button>
            ) : null}
          </span>
        );
      }

      return <img {...props} src={resolved} alt={alt ?? ""} loading="lazy" decoding="async" />;
    },
  };

  return (
    <article className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeSlug, rehypeKatex]}
        skipHtml
        urlTransform={(url) => safeUrlTransform(url)}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}

export default MarkdownRenderer;
