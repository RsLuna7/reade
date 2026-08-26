import { describe, expect, it } from "vitest";
import {
  isAllowedRemoteImageUrl,
  isRemoteHttpUrl,
  normalizeMarkdownUrlKey,
  resolveMarkdownImageSrc,
} from "./markdownImages";

describe("normalizeMarkdownUrlKey", () => {
  it("percent-encodes spaces the way remark does for angle-bracket destinations", () => {
    expect(normalizeMarkdownUrlKey("./assets/my diagram.png")).toBe(
      "./assets/my%20diagram.png",
    );
    expect(normalizeMarkdownUrlKey("./assets/my%20diagram.png")).toBe(
      "./assets/my%20diagram.png",
    );
  });

  it("canonicalises unicode paths to a single percent-encoded form", () => {
    expect(normalizeMarkdownUrlKey("assets/图.png")).toBe("assets/%E5%9B%BE.png");
    expect(normalizeMarkdownUrlKey("assets/%E5%9B%BE.png")).toBe(
      "assets/%E5%9B%BE.png",
    );
  });
});

describe("resolveMarkdownImageSrc", () => {
  const png = "data:image/png;base64,AAAA";

  it("passes data URLs and looks up normalised local keys", () => {
    expect(resolveMarkdownImageSrc(png, {}, false)).toBe(png);
    expect(
      resolveMarkdownImageSrc("./a.png", { "./a.png": png }, false),
    ).toBe(png);
    expect(
      resolveMarkdownImageSrc("./my%20a.png", { "./my%20a.png": png }, false),
    ).toBe(png);
    expect(
      resolveMarkdownImageSrc("./my a.png", { "./my%20a.png": png }, false),
    ).toBe(png);
  });

  it("blocks remote images until the preference is on, and only allows https", () => {
    const https = "https://cdn.example/a.png";
    const http = "http://cdn.example/a.png";
    expect(isRemoteHttpUrl(https)).toBe(true);
    expect(isAllowedRemoteImageUrl(http)).toBe(false);
    expect(resolveMarkdownImageSrc(https, {}, false)).toBeNull();
    expect(resolveMarkdownImageSrc(https, {}, true)).toBe(https);
    expect(resolveMarkdownImageSrc(http, {}, true)).toBeNull();
  });
});
