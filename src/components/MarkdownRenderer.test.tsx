// @vitest-environment jsdom

import "../test/setup";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { extractToc, safeUrlTransform } from "../lib/markdown";
import { MarkdownRenderer } from "./MarkdownRenderer";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

describe("MarkdownRenderer", () => {
  it("renders GFM features and footnotes", () => {
    const { container } = render(
      <MarkdownRenderer
        content={`~~removed~~\n\n- [x] finished\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nFootnote[^1]\n\n[^1]: Footnote body`}
      />,
    );

    expect(container.querySelector("del")).toHaveTextContent("removed");
    expect(container.querySelector('input[type="checkbox"]')).toBeChecked();
    expect(within(container.querySelector("table")!).getByText("A")).toBeInTheDocument();
    expect(container.querySelector("sup a")).toHaveAttribute("href", "#user-content-fn-1");
    expect(container.querySelector("section[data-footnotes]")).toHaveTextContent("Footnote body");
  });

  it("drops raw HTML instead of injecting or executing it", () => {
    const { container } = render(
      <MarkdownRenderer
        content={'Before <img src="x" onerror="window.__rawHtmlRan=true"> <script>window.__rawHtmlRan=true</script> After'}
      />,
    );

    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain("onerror");
    expect((window as Window & { __rawHtmlRan?: boolean }).__rawHtmlRan).toBeUndefined();
    expect(screen.getByText(/Before/)).toHaveTextContent("Before window.__rawHtmlRan=true After");
  });

  it("blocks dangerous URLs and keeps explicitly allowed URL classes", () => {
    const { container } = render(
      <MarkdownRenderer
        content={`[script](javascript:alert(1)) [file](file:///C:/secret.txt) [web](https://example.com) [local](./next.md)\n\n![pixel](data:image/png;base64,iVBORw0KGgo=)`}
      />,
    );

    expect(screen.getByText("script")).toHaveClass("markdown-link-blocked");
    expect(screen.getByText("file")).toHaveClass("markdown-link-blocked");
    expect(container.querySelector('a[href="https://example.com"]')).toBeInTheDocument();
    expect(container.querySelector('a[href="./next.md"]')).toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    expect(safeUrlTransform("java\nscript:alert(1)")).toBeNull();
    expect(safeUrlTransform("//example.com/path")).toBeNull();
    expect(safeUrlTransform("data:image/svg+xml,<svg onload=alert(1) />")).toBeNull();
    expect(safeUrlTransform("mailto:reader@example.com")).toBe("mailto:reader@example.com");
    expect(safeUrlTransform("#section")).toBe("#section");
  });

  it("labels remote image blocks and offers an allow action", () => {
    const onAllowRemoteImages = vi.fn();
    render(
      <MarkdownRenderer
        content={"![](https://cdn.example/diagram.png)"}
        resolveImageSrc={() => null}
        onAllowRemoteImages={onAllowRemoteImages}
      />,
    );

    expect(screen.getByText("远程图片已拦截")).toBeInTheDocument();
    screen.getByRole("button", { name: "允许加载" }).click();
    expect(onAllowRemoteImages).toHaveBeenCalledTimes(1);
  });

  it("reports blocked local images for on-demand loading instead of staying static", () => {
    const onLoadLocalImage = vi.fn();
    const { container, rerender } = render(
      <MarkdownRenderer
        content={"![esc](./d\\(1\\).png)\n\n![](https://cdn.example/diagram.png)"}
        resolveImageSrc={() => null}
        onLoadLocalImage={onLoadLocalImage}
      />,
    );

    // Only the local image is reported, with remark's exact (unescaped) src.
    expect(onLoadLocalImage).toHaveBeenCalledTimes(1);
    expect(onLoadLocalImage).toHaveBeenCalledWith("./d(1).png");

    // Once the asset map resolves the src, the real img replaces the block.
    rerender(
      <MarkdownRenderer
        content={"![esc](./d\\(1\\).png)\n\n![](https://cdn.example/diagram.png)"}
        resolveImageSrc={(source) => (source === "./d(1).png" ? "data:image/png;base64,AAAA" : null)}
        onLoadLocalImage={onLoadLocalImage}
      />,
    );
    expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AAAA");
  });

  it("keeps blocked local images informational without the on-demand loader", () => {
    render(
      <MarkdownRenderer content={"![](./missing.png)"} resolveImageSrc={() => null} />,
    );

    expect(screen.getByText("图片已拦截")).toBeInTheDocument();
  });

  it("shows the concrete failure reason on blocked local images", () => {
    const { container } = render(
      <MarkdownRenderer
        content={"![](./missing.png)"}
        resolveImageSrc={() => null}
        onLoadLocalImage={vi.fn()}
        localImageErrors={{ "./missing.png": "文件超过 25 MiB 上限" }}
      />,
    );

    expect(container.textContent).toContain("图片加载失败：文件超过 25 MiB 上限");
  });

  it("renders sanitized library SVGs inline without going through the URL policy", () => {
    const { container } = render(
      <MarkdownRenderer
        content={"![图](<./diagram file.svg>)"}
        resolveImageSrc={() => null}
        resolveLocalSvg={(source) =>
          source === "./diagram%20file.svg" ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : null
        }
      />,
    );

    const holder = container.querySelector("span.markdown-image-svg");
    expect(holder).toHaveAttribute("role", "img");
    expect(holder?.querySelector("svg")).toBeInTheDocument();
  });

  it("keeps SVG data URLs written in markdown text blocked, never inline", () => {
    const onLoadLocalImage = vi.fn();
    const resolveLocalSvg = vi.fn(() => "<svg/>");
    const { container } = render(
      <MarkdownRenderer
        content={
          "![](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+)"
        }
        resolveImageSrc={() => null}
        onLoadLocalImage={onLoadLocalImage}
        resolveLocalSvg={resolveLocalSvg}
      />,
    );

    expect(container.querySelector("span.markdown-image-svg")).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(onLoadLocalImage).not.toHaveBeenCalled();
    expect(resolveLocalSvg).not.toHaveBeenCalled();
    expect(container.querySelector(".markdown-image-blocked")).toBeInTheDocument();
  });

  it("renders remote https images when the resolver allows them", () => {
    const { container } = render(
      <MarkdownRenderer
        content={"![](https://cdn.example/diagram.png)"}
        resolveImageSrc={(source) => source}
      />,
    );

    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", "https://cdn.example/diagram.png");
    expect(image).toHaveAttribute("draggable", "false");
  });

  it("opens the wrapping link when a linked thumbnail is activated", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <MarkdownRenderer
        content={
          "[![发布短片缩略图](https://i.vimeocdn.com/video/2195538769-a8d89ce5bda40fc4f6d23dbd38955486f8c618e58119473b72b45b341e1f1663-d?mw=80&q=85)](https://openai.com/index/gpt-6-astra/)"
        }
        resolveImageSrc={(source) => source}
        onNavigate={onNavigate}
      />,
    );

    const watch =
      "https://vimeo.com/2195538769/a8d89ce5bda40fc4f6d23dbd38955486f8c618e58119473b72b45b341e1f1663";
    const anchor = container.querySelector("a");
    expect(anchor).toHaveAttribute("href", watch);
    expect(container.querySelector("img")).toHaveAttribute("draggable", "false");
    anchor?.click();
    expect(onNavigate).toHaveBeenCalledWith(watch, expect.any(Object));
  });

  it("keeps allow-remote action from also opening the wrapping link", () => {
    const onNavigate = vi.fn();
    const onAllowRemoteImages = vi.fn();
    const { container } = render(
      <MarkdownRenderer
        content={"[![thumb](https://cdn.example/a.png)](https://example.com/video)"}
        resolveImageSrc={() => null}
        onNavigate={onNavigate}
        onAllowRemoteImages={onAllowRemoteImages}
      />,
    );

    within(container).getByRole("button", { name: "允许加载" }).click();
    expect(onAllowRemoteImages).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("adds stable unique heading ids and exposes source lines for TOC extraction", () => {
    const { container } = render(<MarkdownRenderer content={"# Same\n\nText\n\n## Same"} />);
    const headings = container.querySelectorAll("h1, h2");

    expect(headings[0]).toHaveAttribute("id", "same");
    expect(headings[1]).toHaveAttribute("id", "same-1");
    expect(headings[0]).toHaveAttribute("data-source-start", "1");
    expect(headings[1]).toHaveAttribute("data-source-start", "5");

    expect(extractToc(container)).toEqual([
      { id: "same", title: "Same", level: 1, sourceStart: 1, sourceEnd: 1 },
      { id: "same-1", title: "Same", level: 2, sourceStart: 5, sourceEnd: 5 },
    ]);
  });

  it("stamps block elements with source line positions for reread marks", () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          "First paragraph",
          "",
          "- item one",
          "- item two",
          "",
          "> quoted",
          "",
          "| A |",
          "| - |",
          "| 1 |",
          "",
          "```js",
          "code();",
          "```",
        ].join("\n")}
      />,
    );

    expect(container.querySelector("p")).toHaveAttribute("data-source-start", "1");
    expect(container.querySelector("ul")).toHaveAttribute("data-source-start", "3");
    expect(container.querySelector("ul")).toHaveAttribute("data-source-end", "4");
    expect(container.querySelector("blockquote")).toHaveAttribute("data-source-start", "6");
    expect(container.querySelector("table")).toHaveAttribute("data-source-start", "8");
    expect(container.querySelector(".markdown-code-block")).toHaveAttribute(
      "data-source-start",
      "12",
    );
    expect(container.querySelector(".markdown-code-block")).toHaveAttribute(
      "data-source-end",
      "14",
    );
  });

  it("renders mermaid sandbox iframes as inline SVG instead of blocked frames", async () => {
    const mermaid = await import("mermaid");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><text>flow</text></svg>`;
    const encoded = btoa(`<body style="margin:0">${svg}</body>`);
    vi.mocked(mermaid.default.render).mockResolvedValue({
      svg: `<iframe src="data:text/html;charset=UTF-8;base64,${encoded}" sandbox="allow-popups"></iframe>`,
      diagramType: "flowchart-v2",
    });

    const { container } = render(
      <MarkdownRenderer content={"```mermaid\nflowchart LR\n  A --> B\n```"} />,
    );

    await waitFor(() => {
      expect(container.querySelector(".markdown-mermaid svg")).toHaveTextContent("flow");
    });
    expect(container.querySelector("iframe")).toBeNull();
  });
});
