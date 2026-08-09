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

export interface MarkdownRendererProps {
  content: string;
  className?: string;
  resolveImageSrc?: (source: string) => string | null;
  resolveLinkHref?: (href: string) => string | null;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
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

function CodeBlock({ code, language }: { code: string; language: string | null }) {
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
    <figure className="markdown-code-block" data-language={language ?? "text"}>
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
      securityLevel: "sandbox",
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

function MermaidBlock({ source }: { source: string }) {
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
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
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
    <div className="markdown-mermaid" ref={containerRef}>
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

function MarkdownPre({ children }: { children?: ReactNode }) {
  const details = codeDetails(children);
  if (!details) {
    return <pre>{children}</pre>;
  }

  if (details.language === "mermaid") {
    return <MermaidBlock source={details.code} />;
  }

  return <CodeBlock {...details} />;
}

function resolvedUrl(value: string, resolver?: (value: string) => string | null): string | null {
  const initiallySafe = safeUrlTransform(value);
  if (initiallySafe === null) {
    return null;
  }

  const resolved = resolver ? resolver(initiallySafe) : initiallySafe;
  return resolved === null ? null : safeUrlTransform(resolved);
}

export function MarkdownRenderer({
  content,
  className,
  resolveImageSrc,
  resolveLinkHref,
  onNavigate,
}: MarkdownRendererProps) {
  const components: Components = {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    code: ({ node, ...props }) => {
      void node;
      return <code {...props} />;
    },
    pre: ({ node, ...props }) => {
      void node;
      return <MarkdownPre {...props} />;
    },
    a: ({ node, href, children, ...props }) => {
      void node;
      const resolved = typeof href === "string" ? resolvedUrl(href, resolveLinkHref) : null;
      if (resolved === null) {
        return <span className="markdown-link-blocked">{children}</span>;
      }

      return (
        <a
          {...props}
          href={resolved}
          rel={/^https?:/i.test(resolved) ? "noopener noreferrer" : props.rel}
          onClick={(event) => {
            if (onNavigate) {
              event.preventDefault();
              onNavigate(resolved, event);
            }
          }}
        >
          {children}
        </a>
      );
    },
    img: ({ node, src, alt, ...props }) => {
      void node;
      const resolved = typeof src === "string" ? resolvedUrl(src, resolveImageSrc) : null;
      if (resolved === null) {
        return <span className="markdown-image-blocked">{alt || "图片已拦截"}</span>;
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
