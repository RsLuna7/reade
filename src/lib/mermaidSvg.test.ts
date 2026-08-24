// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { sanitizeMermaidSvg } from "./mermaidSvg";

function sandboxIframe(svg: string): string {
  const encoded = btoa(`<body style="margin:0">${svg}</body>`);
  return `<iframe style="width:100%;height:100%;border:0;margin:0;" src="data:text/html;charset=UTF-8;base64,${encoded}" sandbox="allow-top-navigation-by-user-activation allow-popups"></iframe>`;
}

const DIAGRAM = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><text>ok</text></svg>`;

describe("sanitizeMermaidSvg", () => {
  it("keeps a well-formed inline SVG", () => {
    const sanitized = sanitizeMermaidSvg(DIAGRAM);
    expect(sanitized).toContain("<svg");
    expect(sanitized).toContain("ok");
    expect(sanitized).not.toContain("iframe");
  });

  it("unwraps mermaid sandbox data-URL iframes into inline SVG", () => {
    const sanitized = sanitizeMermaidSvg(sandboxIframe(DIAGRAM));
    expect(sanitized).toContain("<svg");
    expect(sanitized).toContain("ok");
    expect(sanitized?.toLowerCase()).not.toContain("<iframe");
  });

  it("unwraps srcdoc sandbox iframes", () => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("srcdoc", `<svg xmlns="http://www.w3.org/2000/svg"><text>srcdoc</text></svg>`);
    iframe.setAttribute("sandbox", "");
    const sanitized = sanitizeMermaidSvg(iframe.outerHTML);
    expect(sanitized).toContain("srcdoc");
    expect(sanitized?.toLowerCase()).not.toContain("<iframe");
  });

  it("strips scripts, event handlers, and javascript URLs", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><a href="javascript:alert(1)" onclick="alert(1)"><text>x</text></a></svg>`;
    const sanitized = sanitizeMermaidSvg(dirty);
    expect(sanitized?.toLowerCase()).not.toContain("script");
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).not.toContain("onclick");
    expect(sanitized).toContain(">x</text>");
  });

  it("keeps fragment references used by mermaid markers", () => {
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><marker id="arrow"/></defs><use href="#arrow" xlink:href="#arrow"/></svg>`;
    const sanitized = sanitizeMermaidSvg(markup);
    expect(sanitized).toContain("#arrow");
  });

  it("drops remote and data URLs inside the SVG", () => {
    const markup = `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.invalid/x.png"/><image href="data:image/svg+xml,<svg>"/></svg>`;
    const sanitized = sanitizeMermaidSvg(markup);
    expect(sanitized).not.toContain("https://");
    expect(sanitized).not.toContain("data:image");
  });

  it("rejects markup that is not an SVG diagram", () => {
    expect(sanitizeMermaidSvg("<p>nope</p>")).toBeNull();
    expect(sanitizeMermaidSvg("<iframe src='about:blank'></iframe>")).toBeNull();
  });
});
