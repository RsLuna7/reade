import { describe, expect, it } from "vitest";
import {
  buildPreviewExcerpt,
  PREVIEW_EXCERPT_MAX_CHARS,
  previewSlug,
} from "./previewExcerpt";

// Numbered contract cases PE01.. — mirrored one-to-one by the Rust twin
// tests of `build_preview_excerpt` in `src-tauri/src/library.rs`
// (docs/plan-hover-preview.md HP-D7). Keep inputs and expectations in
// sync when editing either side.
describe("buildPreviewExcerpt (contract cases)", () => {
  it("PE01 strips block and inline markers into plain text", () => {
    const content = [
      "# Guide Title",
      "",
      "Some **bold** text with a [link](./other.md) and `code`.",
      "",
      "- item one",
      "- [x] item two",
    ].join("\n");
    expect(buildPreviewExcerpt(content)).toEqual({
      excerpt: "Guide Title\n\nSome bold text with a link and code.\n\nitem one\nitem two",
      matchedFragment: false,
    });
  });

  it("PE02 starts after a CJK heading matched by text", () => {
    const content = [
      "# 文档",
      "",
      "开头段落。",
      "",
      "## 安装步骤",
      "",
      "第一步。",
      "",
      "## 使用",
    ].join("\n");
    expect(buildPreviewExcerpt(content, "安装步骤")).toEqual({
      excerpt: "第一步。\n\n使用",
      matchedFragment: true,
    });
  });

  it("PE03 matches an English heading through its slug", () => {
    const content = "## Getting Started\n\nWelcome aboard.";
    expect(buildPreviewExcerpt(content, "getting-started")).toEqual({
      excerpt: "Welcome aboard.",
      matchedFragment: true,
    });
  });

  it("PE04 falls back to the top when the fragment matches nothing", () => {
    const content = "# Top\n\nBody text.";
    expect(buildPreviewExcerpt(content, "missing-section")).toEqual({
      excerpt: "Top\n\nBody text.",
      matchedFragment: false,
    });
  });

  it("PE05 caps at 600 code points with an ellipsis; exact fit stays untouched", () => {
    const long = "字".repeat(700);
    const capped = buildPreviewExcerpt(long);
    expect(capped.excerpt).toBe(`${"字".repeat(PREVIEW_EXCERPT_MAX_CHARS)}…`);
    expect(Array.from(capped.excerpt).length).toBe(PREVIEW_EXCERPT_MAX_CHARS + 1);

    const exact = buildPreviewExcerpt("字".repeat(PREVIEW_EXCERPT_MAX_CHARS));
    expect(exact.excerpt).toBe("字".repeat(PREVIEW_EXCERPT_MAX_CHARS));
  });

  it("PE06 returns an empty excerpt for empty or whitespace-only content", () => {
    expect(buildPreviewExcerpt("")).toEqual({ excerpt: "", matchedFragment: false });
    expect(buildPreviewExcerpt("  \n\n\t\n")).toEqual({
      excerpt: "",
      matchedFragment: false,
    });
  });

  it("PE07 drops fence marker lines but keeps fenced content as text", () => {
    const content = [
      "Before fence.",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "After fence.",
    ].join("\n");
    expect(buildPreviewExcerpt(content).excerpt).toBe(
      "Before fence.\n\nconst x = 1;\n\nAfter fence.",
    );
  });

  it("PE08 collapses blank runs and trims leading/trailing blanks", () => {
    const content = "\n\n\nFirst para.\n\n\n\nSecond para.\n\n\n";
    expect(buildPreviewExcerpt(content).excerpt).toBe("First para.\n\nSecond para.");
  });

  it("PE09 resolves wiki links and images to their display text", () => {
    const content = "看 [[notes/目标|别名]] 与 [[另一篇]]，配图 ![替代文本](./img.png)。";
    expect(buildPreviewExcerpt(content).excerpt).toBe("看 别名 与 另一篇，配图 替代文本。");
  });

  it("PE10 never matches setext headings and drops their underlines", () => {
    const content = "标题甲\n===\n\n正文。";
    expect(buildPreviewExcerpt(content, "标题甲")).toEqual({
      excerpt: "标题甲\n\n正文。",
      matchedFragment: false,
    });
  });

  it("PE11 yields an empty excerpt when the matched heading ends the document", () => {
    expect(buildPreviewExcerpt("## 结尾", "结尾")).toEqual({
      excerpt: "",
      matchedFragment: true,
    });
  });
});

describe("previewSlug", () => {
  it("lowercases, hyphenates spaces and keeps CJK", () => {
    expect(previewSlug("Getting Started")).toBe("getting-started");
    expect(previewSlug("安装 步骤")).toBe("安装-步骤");
    expect(previewSlug("A.B/C?D！")).toBe("abcd");
    expect(previewSlug("under_score-dash")).toBe("under_score-dash");
  });
});
