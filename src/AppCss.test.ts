import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");

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
});
