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

    expect(screen.getByText("script").closest("a")).toBeNull();
    expect(screen.getByText("file").closest("a")).toBeNull();
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("href", "https://example.com");
    expect(screen.getByRole("link", { name: "local" })).toHaveAttribute("href", "./next.md");
    expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");

    expect(safeUrlTransform("java\nscript:alert(1)")).toBeNull();
    expect(safeUrlTransform("//example.com/path")).toBeNull();
    expect(safeUrlTransform("data:image/svg+xml,<svg onload=alert(1) />")).toBeNull();
    expect(safeUrlTransform("mailto:reader@example.com")).toBe("mailto:reader@example.com");
    expect(safeUrlTransform("#section")).toBe("#section");
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
