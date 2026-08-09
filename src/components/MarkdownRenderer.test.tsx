// @vitest-environment jsdom

import "../test/setup";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { extractToc, safeUrlTransform } from "../lib/markdown";
import { MarkdownRenderer } from "./MarkdownRenderer";

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
});
