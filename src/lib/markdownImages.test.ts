import { describe, expect, it } from "vitest";
import {
  describeAssetLoadFailure,
  isAllowedRemoteImageUrl,
  isRemoteHttpUrl,
  isSafeImageMimeType,
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

describe("isSafeImageMimeType / describeAssetLoadFailure", () => {
  it("mirrors the SAFE_DATA_IMAGE type whitelist", () => {
    expect(isSafeImageMimeType("image/png")).toBe(true);
    expect(isSafeImageMimeType("image/jpeg")).toBe(true);
    expect(isSafeImageMimeType("image/svg+xml")).toBe(false);
    expect(isSafeImageMimeType("image/bmp")).toBe(false);
  });

  it("maps read_asset failures to readable placeholder reasons", () => {
    expect(describeAssetLoadFailure("Asset is too large (99999999 bytes)")).toBe(
      "文件超过 25 MiB 上限",
    );
    expect(describeAssetLoadFailure("Cannot read asset: no such file")).toBe(
      "文件不存在或无法读取",
    );
    expect(describeAssetLoadFailure("Asset resolved outside the library")).toBe(
      "路径越出文档库边界",
    );
    expect(describeAssetLoadFailure("something odd")).toBe("读取失败：something odd");
    expect(describeAssetLoadFailure(undefined)).toBe("读取失败");
  });
});
