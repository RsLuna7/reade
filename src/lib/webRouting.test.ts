import { describe, expect, it } from "vitest";
import {
  buildWebRouteUrl,
  normalizeWebDocumentPath,
  parseWebRoute,
} from "./webRouting";

describe("parseWebRoute", () => {
  it("decodes a Chinese document path and heading", () => {
    expect(
      parseWebRoute({
        search: "?theme=dark&doc=%E6%8C%87%E5%8D%97%2F%E5%BC%80%E5%A7%8B.md",
        hash: "#%E5%AE%89%E8%A3%85%E6%AD%A5%E9%AA%A4",
      }),
    ).toEqual({ documentPath: "指南/开始.md", heading: "安装步骤", textFragment: null });
  });

  it("normalizes Windows separators and dot segments", () => {
    expect(parseWebRoute({ search: "?doc=notes%5C.%5Cintro.md", hash: "" })).toEqual({
      documentPath: "notes/intro.md",
      heading: null,
      textFragment: null,
    });
  });

  it("decodes a #text= fragment and keeps it exclusive with heading", () => {
    expect(
      parseWebRoute({
        search: "?doc=readme.md",
        hash: `#text=${encodeURIComponent("阅读器的 核心目标 🎯")}`,
      }),
    ).toEqual({
      documentPath: "readme.md",
      heading: null,
      textFragment: "阅读器的 核心目标 🎯",
    });
  });

  it("treats an oversized, malformed or empty #text= fragment as absent", () => {
    const tooLong = encodeURIComponent("长".repeat(201));
    expect(
      parseWebRoute({ search: "?doc=readme.md", hash: `#text=${tooLong}` }),
    ).toEqual({ documentPath: "readme.md", heading: null, textFragment: null });
    expect(
      parseWebRoute({ search: "?doc=readme.md", hash: "#text=%E0%A4%A" }),
    ).toEqual({ documentPath: "readme.md", heading: null, textFragment: null });
    expect(
      parseWebRoute({ search: "?doc=readme.md", hash: "#text=" }),
    ).toEqual({ documentPath: "readme.md", heading: null, textFragment: null });
    expect(
      parseWebRoute({ search: "?doc=readme.md", hash: "#text=bad%00text" }),
    ).toEqual({ documentPath: "readme.md", heading: null, textFragment: null });
  });

  it("never treats a heading that literally reads text= as a fragment", () => {
    // buildWebRouteUrl 编码 heading 时 `=` 会转义为 %3D:两种 hash 形态不撞车。
    expect(
      parseWebRoute({ search: "?doc=readme.md", hash: "#text%3Dheading" }),
    ).toEqual({ documentPath: "readme.md", heading: "text=heading", textFragment: null });
  });

  it("ignores #text= when the doc query is missing", () => {
    expect(parseWebRoute({ search: "", hash: "#text=abc" })).toBeNull();
  });

  it.each([
    "",
    "?doc=",
    "?doc=%20%20",
    "?doc=%20https%3A%2F%2Fexample.com%2Fdoc.md",
    "?doc=%2Fetc%2Fpasswd",
    "?doc=%2F%2Fserver%2Fshare.md",
    "?doc=..%2Fsecret.md",
    "?doc=docs%2F..%2Fsecret.md",
    "?doc=https%3A%2F%2Fexample.com%2Fdoc.md",
    "?doc=file%3A%2F%2F%2FC%3A%2Fsecret.md",
    "?doc=C%3A%5Csecret.md",
    "?doc=docs%2Fbad%00name.md",
    "?doc=%E0%A4%A",
  ])("rejects an unsafe or malformed document query: %s", (search) => {
    expect(parseWebRoute({ search, hash: "" })).toBeNull();
  });

  it("rejects malformed and control-character headings", () => {
    expect(parseWebRoute({ search: "?doc=readme.md", hash: "#%E0%A4%A" })).toBeNull();
    expect(parseWebRoute({ search: "?doc=readme.md", hash: "#bad%00heading" })).toBeNull();
  });
});

describe("buildWebRouteUrl", () => {
  it("preserves unrelated query parameters and correctly encodes Chinese values", () => {
    const result = new URL(
      buildWebRouteUrl(
        "https://reader.example/app?theme=dark&panel=toc#old",
        "指南\\开始.md",
        "安装 步骤",
      ),
    );

    expect(result.searchParams.get("theme")).toBe("dark");
    expect(result.searchParams.get("panel")).toBe("toc");
    expect(result.searchParams.get("doc")).toBe("指南/开始.md");
    expect(result.search).toContain("doc=%E6%8C%87%E5%8D%97%2F%E5%BC%80%E5%A7%8B.md");
    expect(result.hash).toBe("#%E5%AE%89%E8%A3%85%20%E6%AD%A5%E9%AA%A4");
  });

  it.each([undefined, null, ""])("clears an existing hash when heading is %s", (heading) => {
    const result = new URL(buildWebRouteUrl("https://reader.example/?mode=read#old", "README.md", heading));
    expect(result.hash).toBe("");
    expect(result.searchParams.get("mode")).toBe("read");
    expect(result.searchParams.get("doc")).toBe("README.md");
  });

  it("throws instead of generating URLs for unsafe input", () => {
    expect(() => buildWebRouteUrl("https://reader.example/", "../secret.md", "title")).toThrow(TypeError);
    expect(() => buildWebRouteUrl("https://reader.example/", "https://evil.test/a.md", "title")).toThrow(
      TypeError,
    );
    expect(() => buildWebRouteUrl("https://reader.example/", "ok.md", "bad\u0000heading")).toThrow(TypeError);
    expect(() =>
      buildWebRouteUrl("https://reader.example/", "ok.md", { text: "bad\u0000text" }),
    ).toThrow(TypeError);
  });

  it("builds a #text= hash that round-trips through parseWebRoute", () => {
    const text = "三栏布局 把文档树、正文 和目录分开 🎯";
    const url = new URL(
      buildWebRouteUrl("https://reader.example/app?theme=dark#old", "指南/开始.md", { text }),
    );
    expect(url.searchParams.get("theme")).toBe("dark");
    expect(url.hash.startsWith("#text=")).toBe(true);
    expect(parseWebRoute({ search: url.search, hash: url.hash })).toEqual({
      documentPath: "指南/开始.md",
      heading: null,
      textFragment: text,
    });
  });

  it("prefers text over heading when both are provided", () => {
    const url = new URL(
      buildWebRouteUrl("https://reader.example/", "ok.md", { heading: "章节", text: "目标段落" }),
    );
    expect(url.hash).toBe(`#text=${encodeURIComponent("目标段落")}`);
  });

  it("keeps accepting the legacy plain-heading argument", () => {
    const url = new URL(buildWebRouteUrl("https://reader.example/", "ok.md", "安装"));
    expect(url.hash).toBe(`#${encodeURIComponent("安装")}`);
  });
});

describe("normalizeWebDocumentPath", () => {
  it("uses forward slashes without permitting root traversal", () => {
    expect(normalizeWebDocumentPath("folder\\chapter.md")).toBe("folder/chapter.md");
    expect(normalizeWebDocumentPath("folder/../chapter.md")).toBeNull();
  });
});
