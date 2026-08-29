import { describe, expect, it } from "vitest";
import type { DocumentContent } from "./backend";
import {
  PANE_BLOCKED_LINK_NOTICE,
  SPLIT_MIN_WINDOW_WIDTH,
  SPLIT_POS_DEFAULT,
  SPLIT_POS_MAX,
  SPLIT_POS_MIN,
  canActivateSplit,
  clampSplitPos,
  classifyPaneNavigation,
  collectReferencedImages,
  isPaneDocumentMissing,
  paneDisplayMarkdown,
  paneImageAssetPaths,
  reducePaneContent,
  resolveLibraryRelativePath,
  type PaneContentState,
} from "./splitView";

const markdownContent: DocumentContent = {
  kind: "markdown",
  relativePath: "notes/a.md",
  markdown: "# A\n\nbody",
};

describe("clampSplitPos", () => {
  it("clamps into [0.30, 0.70]", () => {
    expect(clampSplitPos(0.1)).toBe(SPLIT_POS_MIN);
    expect(clampSplitPos(0.95)).toBe(SPLIT_POS_MAX);
    expect(clampSplitPos(0.42)).toBe(0.42);
    expect(clampSplitPos(0.3)).toBe(0.3);
    expect(clampSplitPos(0.7)).toBe(0.7);
  });

  it("falls back to 0.5 for invalid input", () => {
    expect(clampSplitPos(Number.NaN)).toBe(SPLIT_POS_DEFAULT);
    expect(clampSplitPos(Number.POSITIVE_INFINITY)).toBe(SPLIT_POS_DEFAULT);
    expect(clampSplitPos(Number.NEGATIVE_INFINITY)).toBe(SPLIT_POS_DEFAULT);
  });
});

describe("canActivateSplit", () => {
  it("blocks at 1079 and allows at 1080 (SP-D6 boundary)", () => {
    expect(canActivateSplit(SPLIT_MIN_WINDOW_WIDTH - 1)).toBe(false);
    expect(canActivateSplit(SPLIT_MIN_WINDOW_WIDTH)).toBe(true);
    expect(canActivateSplit(1440)).toBe(true);
    expect(canActivateSplit(Number.NaN)).toBe(false);
  });
});

describe("reducePaneContent", () => {
  it("walks loading → ready for the matching path", () => {
    const loading = reducePaneContent(null, { type: "load", path: "notes/a.md" });
    expect(loading).toEqual({ status: "loading", path: "notes/a.md" });
    const ready = reducePaneContent(loading, {
      type: "loaded",
      path: "notes/a.md",
      content: markdownContent,
    });
    expect(ready).toEqual({ status: "ready", path: "notes/a.md", content: markdownContent });
  });

  it("walks loading → error on failure", () => {
    const loading = reducePaneContent(null, { type: "load", path: "notes/a.md" });
    expect(
      reducePaneContent(loading, {
        type: "load-failed",
        path: "notes/a.md",
        message: "读取失败",
      }),
    ).toEqual({ status: "error", path: "notes/a.md", message: "读取失败" });
  });

  it("ignores stale responses from a superseded request", () => {
    let state: PaneContentState | null = null;
    state = reducePaneContent(state, { type: "load", path: "notes/a.md" });
    state = reducePaneContent(state, { type: "load", path: "notes/b.md" });
    // The late answer for a.md must not clobber the b.md load.
    const afterStale = reducePaneContent(state, {
      type: "loaded",
      path: "notes/a.md",
      content: markdownContent,
    });
    expect(afterStale).toEqual({ status: "loading", path: "notes/b.md" });
    const afterStaleError = reducePaneContent(afterStale, {
      type: "load-failed",
      path: "notes/a.md",
      message: "过期错误",
    });
    expect(afterStaleError).toEqual({ status: "loading", path: "notes/b.md" });
  });
});

describe("isPaneDocumentMissing", () => {
  const documents = [{ relativePath: "docs/kept.md" }, { relativePath: "sub\\win.md" }];

  it("detects vanished documents and tolerates backslash paths", () => {
    expect(isPaneDocumentMissing("docs/kept.md", documents)).toBe(false);
    expect(isPaneDocumentMissing("sub/win.md", documents)).toBe(false);
    expect(isPaneDocumentMissing("docs/gone.md", documents)).toBe(true);
  });
});

describe("resolveLibraryRelativePath", () => {
  it("resolves relative to the referencing document's directory", () => {
    expect(resolveLibraryRelativePath("./img/a.png", "notes/doc.md")).toBe("notes/img/a.png");
    expect(resolveLibraryRelativePath("../shared/b.png", "notes/doc.md")).toBe("shared/b.png");
    expect(resolveLibraryRelativePath("/root.png", "notes/doc.md")).toBe("root.png");
  });

  it("blocks protocol URLs, protocol-relative URLs and root escapes", () => {
    expect(resolveLibraryRelativePath("https://evil.invalid/x.png", "doc.md")).toBeNull();
    expect(resolveLibraryRelativePath("//evil.invalid/x.png", "doc.md")).toBeNull();
    expect(resolveLibraryRelativePath("file:///etc/passwd", "doc.md")).toBeNull();
    expect(resolveLibraryRelativePath("../outside.png", "doc.md")).toBeNull();
    expect(resolveLibraryRelativePath("", "doc.md")).toBeNull();
  });

  it("strips queries/fragments and decodes percent escapes", () => {
    expect(resolveLibraryRelativePath("a.png?x=1#frag", "doc.md")).toBe("a.png");
    expect(resolveLibraryRelativePath("img%20dir/pic.png", "doc.md")).toBe("img dir/pic.png");
  });
});

describe("collectReferencedImages / paneImageAssetPaths", () => {
  it("collects unique markdown image sources", () => {
    const markdown = '![a](./a.png)\n![b](<b-file.png> "title")\n![a again](./a.png)';
    expect(collectReferencedImages(markdown)).toEqual(["./a.png", "b-file.png"]);
  });

  it("collects angle-bracket destinations that contain spaces", () => {
    const markdown = "![diagram](<./assets/my diagram.png>)";
    expect(collectReferencedImages(markdown)).toEqual([
      "./assets/my%20diagram.png",
    ]);
    expect(paneImageAssetPaths(markdown, "notes/doc.md")).toEqual([
      {
        source: "./assets/my%20diagram.png",
        relativePath: "notes/assets/my diagram.png",
      },
    ]);
  });

  it("resolves local sources and drops data/external/out-of-library ones", () => {
    const markdown = [
      "![ok](./img/ok.png)",
      "![data](data:image/png;base64,AAAA)",
      "![remote](https://cdn.invalid/pic.png)",
      "![escape](../../nope.png)",
    ].join("\n");
    expect(paneImageAssetPaths(markdown, "notes/doc.md")).toEqual([
      { source: "./img/ok.png", relativePath: "notes/img/ok.png" },
    ]);
  });

  it("resolves reference-style images through their definitions", () => {
    const markdown = [
      "![hero][full]",
      "![shot.png][]",
      "![shortcut]",
      "",
      "[full]: ./img/hero.png",
      "[shot.png]: ./img/shot.png",
      "[shortcut]: ./img/shortcut.png",
    ].join("\n");
    expect(collectReferencedImages(markdown)).toEqual([
      "./img/hero.png",
      "./img/shot.png",
      "./img/shortcut.png",
    ]);
    expect(paneImageAssetPaths(markdown, "notes/doc.md")).toEqual([
      { source: "./img/hero.png", relativePath: "notes/img/hero.png" },
      { source: "./img/shot.png", relativePath: "notes/img/shot.png" },
      { source: "./img/shortcut.png", relativePath: "notes/img/shortcut.png" },
    ]);
  });

  it("handles reference labels case-insensitively and keeps the first definition", () => {
    const markdown = [
      "![a][Logo]",
      "![b][logo]",
      "",
      "[Logo]: ./first.png",
      "[logo]: ./second.png",
    ].join("\n");
    expect(collectReferencedImages(markdown)).toEqual(["./first.png"]);
  });

  it("supports angle-bracket and titled reference definitions", () => {
    const markdown = ["![x][space]", "", "[space]: <./my file.png> \"title\""].join("\n");
    expect(collectReferencedImages(markdown)).toEqual(["./my%20file.png"]);
  });

  it("does not mistake inline image alt text for a reference label", () => {
    const markdown = ["![Logo](./inline.png)", "", "[Logo]: ./definition.png"].join("\n");
    expect(collectReferencedImages(markdown)).toEqual(["./inline.png"]);
  });

  it("ignores reference usages without a definition", () => {
    expect(collectReferencedImages("![missing][ref]")).toEqual([]);
  });
});

describe("paneDisplayMarkdown", () => {
  it("strips BOM, YAML frontmatter and the leading H1", () => {
    const raw = "\uFEFF---\ntitle: X\n---\n# Heading\n\nBody text";
    expect(paneDisplayMarkdown(raw)).toBe("Body text");
  });

  it("keeps bodies without frontmatter or title intact", () => {
    expect(paneDisplayMarkdown("plain body")).toBe("plain body");
  });
});

describe("classifyPaneNavigation", () => {
  const documents = [
    { relativePath: "notes/target.md" },
    { relativePath: "win\\style.md" },
  ];

  it("classifies same-document anchors", () => {
    expect(classifyPaneNavigation("#sec%20one", "notes/doc.md", documents)).toEqual({
      kind: "anchor",
      id: "sec one",
    });
  });

  it("classifies external links for the confirm flow", () => {
    expect(
      classifyPaneNavigation("https://example.com/a", "notes/doc.md", documents),
    ).toEqual({ kind: "external", href: "https://example.com/a" });
    expect(classifyPaneNavigation("mailto:x@y.z", "notes/doc.md", documents)).toEqual({
      kind: "external",
      href: "mailto:x@y.z",
    });
  });

  it("routes in-library documents to pane self-navigation with the hash", () => {
    expect(
      classifyPaneNavigation("./target.md#part%201", "notes/doc.md", documents),
    ).toEqual({ kind: "document", path: "notes/target.md", hash: "part 1" });
    // Backslash-stored paths resolve too and keep their stored form.
    expect(classifyPaneNavigation("/win/style.md", "notes/doc.md", documents)).toEqual({
      kind: "document",
      path: "win\\style.md",
      hash: null,
    });
  });

  it("blocks documents outside the library with the standard notice", () => {
    expect(classifyPaneNavigation("./missing.md", "notes/doc.md", documents)).toEqual({
      kind: "blocked",
      reason: PANE_BLOCKED_LINK_NOTICE,
    });
    expect(classifyPaneNavigation("../../escape.md", "notes/doc.md", documents)).toEqual({
      kind: "blocked",
      reason: PANE_BLOCKED_LINK_NOTICE,
    });
  });
});
