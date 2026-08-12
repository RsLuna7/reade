import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const themeTokens = readFileSync(
  new URL("./styles/theme-tokens.css", import.meta.url),
  "utf8",
);

const REQUIRED_TOKENS = [
  "--theme-color",
  "--paper",
  "--paper-raised",
  "--chrome",
  "--chrome-strong",
  "--ink",
  "--ink-soft",
  "--muted",
  "--line",
  "--line-strong",
  "--accent",
  "--accent-soft",
  "--accent-ink",
  "--teal",
  "--teal-soft",
  "--selection",
  "--shadow",
  "--code-bg",
  "--code-chrome",
] as const;

describe("application CSS isolation", () => {
  it("does not expose an application-level .sidebar selector to PDF.js", () => {
    expect(css).not.toMatch(/\.sidebar(?=[\s,{:#.>])/);
    expect(css).toContain(".library-sidebar");
  });

  it("keeps motion rules away from PDF layers and EPUB body content", () => {
    const animatedSelectors = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      .filter((match) => /(?:transition|animation)\s*:/.test(match[2]))
      .map((match) => match[1].trim());

    expect(animatedSelectors.join("\n")).not.toMatch(/\.pdf-page\b|\.textLayer\b|\.pdf-text-layer\b|\.epub-reader\b|\.epub-chapter\b/);
  });

  it("uses the persisted data-motion level instead of a global media override", () => {
    expect(css).not.toContain("prefers-reduced-motion");
    expect(css).toContain(':root[data-motion="off"]');
    expect(css).toContain(':root[data-motion="subtle"]');
    expect(css).toContain(':root[data-motion="full"]');
  });

  it("keeps the library sidebar scrollable above a pinned theme footer", () => {
    expect(css).toMatch(/\.library-sidebar\s*\{[^}]*min-height:\s*0/s);
    expect(css).toMatch(/\.library-sidebar\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.sidebar-content\s*\{[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/\.sidebar-footer\s*\{[^}]*flex-shrink:\s*0/s);
  });

  it("hides library and TOC scrollbars while keeping overflow scrolling", () => {
    expect(css).toMatch(/\.sidebar-content\s*\{[^}]*scrollbar-width:\s*none/s);
    expect(css).toMatch(/\.toc-panel\s*\{[^}]*scrollbar-width:\s*none/s);
    expect(css).toMatch(
      /\.sidebar-content::-webkit-scrollbar\s*,\s*\.toc-panel::-webkit-scrollbar\s*,\s*\.toc-drawer::-webkit-scrollbar\s*\{[^}]*display:\s*none/s,
    );
  });

  it("uses dark Shiki token colors for always-dark code blocks", () => {
    expect(css).toMatch(
      /\.markdown-code-highlight \.shiki(?:\s*,\s*\.markdown-code-highlight \.shiki span)?\s*\{[^}]*color:\s*var\(--shiki-dark\)\s*!important/s,
    );
    expect(css).not.toMatch(
      /\.markdown-code-highlight \.shiki(?:\s*,\s*\.markdown-code-highlight \.shiki span)?\s*\{[^}]*color:\s*var\(--shiki-light\)\s*!important/s,
    );
  });

  it("fulfills the pdf.js text layer CSS variable contract on .pdf-page", () => {
    expect(css).toMatch(/\.pdf-page\s*\{[^}]*--scale-round-x:\s*1px/s);
    expect(css).toMatch(/\.pdf-page\s*\{[^}]*--scale-round-y:\s*1px/s);
  });

  it("does not force text layer dimensions over pdf.js setLayerDimensions", () => {
    const forcedSizeSelectors = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      .filter((match) => /(?:width|height):\s*100%\s*!important/.test(match[2]))
      .map((match) => match[1].trim());
    expect(forcedSizeSelectors.join("\n")).not.toMatch(/\.pdf-text-layer\b|\.textLayer\b/);
  });

  it("keeps semantic color tokens in theme-tokens.css for light and dark", () => {
    expect(themeTokens).toContain(":root {");
    expect(themeTokens).toContain(':root[data-theme="dark"]');
    for (const token of REQUIRED_TOKENS) {
      expect(themeTokens).toContain(`${token}:`);
    }
    expect(themeTokens).toMatch(/:root\[data-theme="dark"\][\s\S]*--paper:\s*#1a1d1b/);
    expect(themeTokens).toMatch(/:root\[data-theme="dark"\][\s\S]*--theme-color:\s*#1a1d1b/);
  });

  it("does not redefine semantic color tokens inside App.css", () => {
    expect(css).not.toMatch(/--paper:\s*#/);
    expect(css).not.toMatch(/--accent:\s*#/);
    expect(css).toContain("var(--code-bg)");
    expect(css).toContain("var(--theme-color)");
    expect(css).toContain(".theme-controls");
  });
});

describe("annotation interaction CSS", () => {
  it("keeps PDF user highlights click-through so text selection still works", () => {
    // B1 约定:命中检测走坐标包含判断,高亮层不得改为可点击。
    expect(css).toMatch(/\.pdf-user-highlight-layer\s*\{[^}]*pointer-events:\s*none/s);
    expect(css).toMatch(/\.pdf-user-highlight\s*\{[^}]*pointer-events:\s*none/s);
  });

  it("renders the annotation edit bubble as a fixed overlay above the toolbar", () => {
    expect(css).toMatch(/\.annotation-edit-bubble\s*\{[^}]*position:\s*fixed/s);
  });

  it("keeps the selection toolbar within narrow viewports", () => {
    expect(css).toMatch(/\.annotation-toolbar\s*\{[^}]*max-width/s);
    expect(css).toMatch(/\.annotation-toolbar\s*\{[^}]*flex-wrap:\s*wrap/s);
  });

  it("styles the notice action button and annotation sort toggle", () => {
    expect(css).toContain(".notice-action");
    expect(css).toContain(".annotation-sort-toggle");
    expect(css).toContain(".annotation-library-group");
  });
});
