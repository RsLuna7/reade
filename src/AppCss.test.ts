import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_IDS, THEME_META } from "./lib/themes";

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
  "--shadow-color",
  "--shadow-edge",
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

  it("pins tree-row duration in a trailing grid column so long titles cannot shove it out", () => {
    expect(css).toMatch(
      /\.document-tree__item\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto/s,
    );
    expect(css).toMatch(/\.document-tree__name\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.document-tree__estimate\s*\{[^}]*white-space:\s*nowrap/s);
  });

  it("styles tree drag handles and the context menu", () => {
    expect(css).toMatch(/\.document-tree__handle\s*\{[^}]*cursor:\s*grab/s);
    expect(css).toMatch(/\.document-tree-menu\s*\{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.document-tree-menu__item\s*\{/s);
    expect(css).toMatch(/\.document-tree__node--drop-before::before/s);
    expect(css).toMatch(/\.document-tree__node--pin-end\s*\{[^}]*border-bottom/s);
  });

  it("centers a measured article so leftover pane space is not a right-side void", () => {
    expect(css).toMatch(/\.article-shell\s*\{[^}]*margin-inline:\s*auto/s);
    expect(css).toMatch(
      /\.reading-scroll\[data-writing="vertical"\] \.article-shell\s*\{[^}]*margin-inline:\s*0/s,
    );
  });

  it("keeps the topbar seamless at rest and elevated only after scrolling", () => {
    // 滚动边缘浮起(plan B):静止态无分割线,浮起态走 data-scrolled +
    // 分层染色阴影;回归防止有人把常驻 1px 边线加回来。
    expect(css).not.toMatch(/\.topbar\s*\{[^}]*border-bottom/s);
    expect(css).toMatch(
      /\.topbar\[data-scrolled="true"\]\s*\{[^}]*box-shadow:\s*var\(--shadow-edge\)/s,
    );
    expect(css).toMatch(/\.topbar\[data-scrolled="true"\]\s*\{[^}]*backdrop-filter/s);
  });

  it("keeps reading-frame overlays from painting over top bar popovers", () => {
    // 回归:刻度层(5)、阅读标尺(6)、重读横幅(14)的祖先链上没有任何层叠
    // 上下文,z-index 直接与 .topbar(3)在根上下文比较,于是盖住了顶栏的
    // 阅读设置 popover。isolation 把它们关回正文区内部。
    expect(css).toMatch(/\.reading-frame\s*\{[^}]*isolation:\s*isolate/s);
    expect(css).toMatch(/\.topbar\s*\{[^}]*z-index:\s*3/s);
  });

  it("keeps the library sidebar scrollable above a pinned theme footer", () => {
    expect(css).toMatch(/\.library-sidebar\s*\{[^}]*min-height:\s*0/s);
    expect(css).toMatch(/\.library-sidebar\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.sidebar-content\s*\{[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/\.sidebar-footer\s*\{[^}]*flex-shrink:\s*0/s);
  });

  it("lets every sidebar footer control share the full width", () => {
    expect(css).toMatch(
      /\.theme-controls\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(0,\s*1fr\)\)/s,
    );
  });

  it("hides library and TOC scrollbars while keeping overflow scrolling", () => {
    expect(css).toMatch(/\.sidebar-content\s*\{[^}]*scrollbar-width:\s*none/s);
    expect(css).toMatch(/\.toc-panel\s*\{[^}]*scrollbar-width:\s*none/s);
    expect(css).toMatch(
      /\.sidebar-content::-webkit-scrollbar\s*,\s*\.toc-panel::-webkit-scrollbar\s*,\s*\.toc-drawer::-webkit-scrollbar\s*\{[^}]*display:\s*none/s,
    );
  });

  it("keeps the right TOC panel from clipping annotation cards horizontally", () => {
    // #1: library-group 若用 auto 轨，子项 width/max-width:100% 与内容宽度循环，
    // 卡片会撑到面板外再被 overflow-x:hidden 硬裁。
    expect(css).toMatch(/\.toc-panel\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(css).toMatch(/\.toc-panel\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.toc-panel\s*\{[^}]*padding:\s*43px\s+16px\s+28px\s+12px/s);
    expect(css).toMatch(
      /\.annotation-library-group\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    );
    expect(css).toMatch(
      /\.annotation-list-wrap\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    );
    expect(css).toMatch(/\.annotation-library-group\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.annotation-list\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.annotation-list-item\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(
      /\.annotation-list-title\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    );
    // 裁切要用换行/overflow 修，不要把主页面右侧栏加宽或改成 0.32fr。
    expect(css).toMatch(
      /\.content-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--toc-width\)/s,
    );
    expect(css).toMatch(/--toc-width:\s*200px/);
    expect(css).not.toMatch(/minmax\(var\(--toc-width\),\s*0\.32fr\)/);
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

  it("keeps semantic color tokens in theme-tokens.css for every registered theme", () => {
    // 19 tokens vary per theme (17 colors + the --shadow-color/--shadow-edge
    // pair); --code-bg/--code-chrome stay dark everywhere (D3) and live once
    // on :root, never inside a theme block.
    const perThemeTokens = REQUIRED_TOKENS.filter(
      (token) => token !== "--code-bg" && token !== "--code-chrome",
    );

    // :root carries the paper-light defaults plus the fixed code chrome.
    expect(themeTokens).toContain(":root {");
    for (const token of REQUIRED_TOKENS) {
      expect(themeTokens).toContain(`${token}:`);
    }

    for (const id of THEME_IDS) {
      const block = themeTokens.match(
        new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`),
      )?.[1];
      expect(block, `missing :root[data-theme="${id}"] block`).toBeTruthy();
      for (const token of perThemeTokens) {
        expect(block, `theme ${id} is missing ${token}`).toContain(`${token}:`);
      }
      // Registry ↔ CSS consistency: meta theme-color, mode and the picker
      // swatch colors must match the tokens the theme actually renders with.
      expect(block).toContain(`--theme-color: ${THEME_META[id].themeColor}`);
      expect(block).toContain(`color-scheme: ${THEME_META[id].mode}`);
      expect(block).toContain(`--paper: ${THEME_META[id].swatch.paper}`);
      expect(block).toContain(`--chrome: ${THEME_META[id].swatch.chrome}`);
      expect(block).toContain(`--accent: ${THEME_META[id].swatch.accent}`);
      expect(block).not.toContain("--code-bg");
      expect(block).not.toContain("--code-chrome");
    }

    expect(themeTokens).toMatch(/:root\[data-theme="paper-dark"\][\s\S]*--paper:\s*#1a1d1b/);
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

  it("keeps side panel tab labels on one line so pills never deform", () => {
    // 回归:中文标签在窄目录栏或出现计数角标时曾逐字竖排换行。
    expect(css).toMatch(/\.side-panel-tabs\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(css).toMatch(/\.side-panel-tabs button\s*\{[^}]*flex-shrink:\s*0/s);
    expect(css).toMatch(/\.side-panel-tabs button\s*\{[^}]*white-space:\s*nowrap/s);
  });
});

describe("annotation color tokens", () => {
  // UI chrome aliases --annot-* → --excerpt-*; dark mode only redefines excerpt.
  const ANNOT_TOKENS = (["yellow", "green", "blue", "pink"] as const).flatMap(
    (color) => [`--annot-${color}`, `--annot-${color}-fill`, `--annot-${color}-line`],
  );
  const EXCERPT_TOKENS = (["sand", "sage", "slate"] as const).flatMap((tone) => [
    `--excerpt-${tone}`,
    `--excerpt-${tone}-fill`,
    `--excerpt-${tone}-line`,
  ]);

  it("defines the light palette on :root and a complete dark excerpt override", () => {
    const darkBlock = css.match(/:root\[data-theme\$="-dark"\]\s*\{([^}]*)\}/)?.[1];
    expect(darkBlock, 'missing :root[data-theme$="-dark"] annotation block').toBeTruthy();
    for (const token of EXCERPT_TOKENS) {
      expect(css).toContain(`${token}:`);
      expect(darkBlock).toContain(`${token}:`);
    }
    for (const token of ANNOT_TOKENS) {
      expect(css).toMatch(new RegExp(`${token}:\\s*var\\(--excerpt-`));
    }
  });

  it("routes marks, list chips, dots, swatches and ticks through the tokens", () => {
    expect(css).toMatch(
      /\.annotation-mark--highlight\.annotation-mark--yellow,\s*\.annotation-mark--highlight\.annotation-mark--pink\s*\{\s*background:\s*var\(--excerpt-sand-fill\)/,
    );
    expect(css).toMatch(
      /\.annotation-mark--underline\.annotation-mark--yellow,\s*\.annotation-mark--underline\.annotation-mark--pink\s*\{\s*border-bottom-color:\s*var\(--excerpt-sand-line\)/,
    );
    expect(css).toMatch(
      /\.annotation-list-kind--green\s*\{\s*background:\s*var\(--annot-green-fill\)/,
    );
    expect(css).toMatch(/\.annotation-color-dot--green\s*\{\s*background:\s*var\(--annot-green\)/);
    expect(css).toMatch(/\.annotation-color-swatch--pink\s*\{\s*background:\s*var\(--annot-pink\)/);
    expect(css).toMatch(/\.scroll-map-tick--blue\s*\{\s*background:\s*var\(--annot-blue\)/);
    expect(css).toMatch(/\.annotation-tone-swatch--sand\s*\{\s*background:\s*var\(--excerpt-sand\)/);
    // 旧的单套荧光色值不得回流(暗色主题下文字对比度 2.87-3.80:1,不达标)。
    expect(css).not.toMatch(/#ffe650|#78dc8c|#78b4ff|#ff8cbe/i);
    expect(css).not.toMatch(/#efcf53|#87e2a8|#a1cfff|#ffb0ca/i);
  });

  it("keeps PDF highlights on the fixed light palette (pages stay white)", () => {
    // PDF 页面不随主题变色,若误用 --annot-* token,暗色主题会把暗色系
    // 高亮叠到白色页面上。
    const pdfRules = Array.from(css.matchAll(/\.pdf-user-highlight--[^{]+\{([^}]*)\}/g)).map(
      (match) => match[1],
    );
    expect(pdfRules.length).toBeGreaterThan(0);
    for (const body of pdfRules) {
      expect(body).not.toContain("var(--annot-");
      expect(body).not.toContain("var(--excerpt-");
    }
    expect(css).toMatch(/\.pdf-user-highlight--geometric\s*\{[^}]*outline:/s);
    expect(css).toMatch(/\.annotation-method-dot--geometric\s*\{/);
  });

  it("defines exactly three low-chroma excerpt tones for both theme modes", () => {
    for (const tone of ["sand", "sage", "slate"]) {
      expect(css).toMatch(new RegExp(`:root\\s*\\{[^}]*--excerpt-${tone}:`, "s"));
      expect(css).toMatch(
        new RegExp(`:root\\[data-theme\\$="-dark"\\]\\s*\\{[^}]*--excerpt-${tone}:`, "s"),
      );
    }
    expect(css).not.toMatch(/--excerpt-(?:pink|yellow|green|blue):/);
    const fillAlphas = [...css.matchAll(/--excerpt-(?:sand|sage|slate)-fill:\s*rgb\([^/]+\/\s*(\d+)%\)/g)]
      .map((match) => Number(match[1]));
    expect(fillAlphas).toHaveLength(6);
    expect(fillAlphas.every((alpha) => alpha <= 30)).toBe(true);
  });

  it("styles the silent markdown panel and parks the toolbar as a 44px sheet on narrow viewports", () => {
    expect(css).toContain(".document-annotations");
    expect(css).toContain(".document-annotations-section-toggle");
    expect(css).toContain(".annotation-tone-swatch--sand");
    expect(css).toMatch(/\.annotation-tone-swatch--sand\s*\{\s*background:\s*var\(--excerpt-sand\)/);
    expect(css).toMatch(
      /@media \(max-width: 640px\)\s*\{\s*\.annotation-toolbar\s*\{[^}]*bottom:/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 640px\)[\s\S]*\.annotation-toolbar button:not\(\.annotation-color-swatch\)[\s\S]*min-height:\s*44px/,
    );
  });
});
