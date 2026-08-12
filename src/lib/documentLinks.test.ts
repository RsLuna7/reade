import { describe, expect, it } from "vitest";
import {
  buildDocumentLinks,
  extractDocumentLinks,
  LINKS_LIST_LIMIT,
  MAX_DOCUMENT_LINKS,
  resolveLibraryPath,
  resolveWikiTargets,
  WEB_LINKS_MAX_DOCUMENTS,
  type ExtractedLink,
} from "./documentLinks";

/**
 * 双端契约用例表（链接解析与提取）。编号 L01..L24 同时约束：
 * - 本文件（`resolveLibraryPath` 移植 + TS 提取器 / Web 端实现）；
 * - `src-tauri/src/links.rs` 的 Rust 测试（注释引用同一编号）。
 * 任何一端语义变化必须同步另一端（plan-backlinks §7 的最大风险项）。
 *
 * L01 同级相对 `./a.md`      L02 同级相对 `a.md`
 * L03 子目录                 L04 `../` 回退一级
 * L05 `../` 越界丢弃          L06 库根绝对 `/notes/a.md`
 * L07 `\` 分隔符             L08 percent-encoding（中文文件名）
 * L09 无效 percent 序列按原文  L10 `?query` 剥离
 * L11 `#fragment` 剥离并保留   L12 `//host` 丢弃
 * L13 绝对协议丢弃            L14 空目标 / 纯锚点丢弃
 * L15 `.` 段跳过             L16 fenced code 不提取
 * L17 inline code 不提取      L18 图片按扩展名归类（asset）
 * L19 `[[wiki|别名]]` 拆分    L20 `[[wiki#锚点]]` 拆分
 * L21 路径形 wiki stem        L22 链接文本 200 字符截断
 * L23 单文档 1000 条上限      L24 文档扩展名大小写不敏感
 */

const DOC = "notes/sub/page.md";

describe("resolveLibraryPath (verbatim App.tsx port)", () => {
  it("L01-L04: resolves same-dir, subdir and parent targets", () => {
    expect(resolveLibraryPath("./a.md", DOC)).toBe("notes/sub/a.md");
    expect(resolveLibraryPath("a.md", DOC)).toBe("notes/sub/a.md");
    expect(resolveLibraryPath("deeper/b.md", DOC)).toBe("notes/sub/deeper/b.md");
    expect(resolveLibraryPath("../c.md", DOC)).toBe("notes/c.md");
  });

  it("L05: escaping the library root resolves to null", () => {
    expect(resolveLibraryPath("../../../out.md", DOC)).toBeNull();
    expect(resolveLibraryPath("../out.md", "page.md")).toBeNull();
  });

  it("L06: a leading slash is library-root absolute", () => {
    expect(resolveLibraryPath("/notes/a.md", DOC)).toBe("notes/a.md");
  });

  it("L07: backslashes normalize in the target and the document path", () => {
    expect(resolveLibraryPath("sub\\d.md", "notes\\sub\\page.md")).toBe(
      "notes/sub/sub/d.md",
    );
  });

  it("L08/L09: percent-decodes and falls back to the raw text", () => {
    expect(resolveLibraryPath("%E4%B8%AD%E6%96%87.md", DOC)).toBe("notes/sub/中文.md");
    expect(resolveLibraryPath("bad%zz.md", DOC)).toBe("notes/sub/bad%zz.md");
  });

  it("L10/L11: strips query strings and fragments", () => {
    expect(resolveLibraryPath("a.md?x=1", DOC)).toBe("notes/sub/a.md");
    expect(resolveLibraryPath("a.md#sec", DOC)).toBe("notes/sub/a.md");
  });

  it("L12/L13: rejects protocol-relative and absolute-protocol targets", () => {
    expect(resolveLibraryPath("//host/x.md", DOC)).toBeNull();
    expect(resolveLibraryPath("\\\\host\\x.md", DOC)).toBeNull();
    for (const source of [
      "https://example.com/a.md",
      "HTTPS://example.com/a.md",
      "mailto:x@y.example",
      "file:///c:/x.md",
      "data:text/plain,hi",
    ]) {
      expect(resolveLibraryPath(source, DOC), source).toBeNull();
    }
  });

  it("L14: empty targets, pure anchors and pure queries resolve to null", () => {
    expect(resolveLibraryPath("", DOC)).toBeNull();
    expect(resolveLibraryPath("   ", DOC)).toBeNull();
    expect(resolveLibraryPath("#sec", DOC)).toBeNull();
    expect(resolveLibraryPath("?query", DOC)).toBeNull();
  });

  it("L15: skips `.` segments; a bare `.` resolves to the empty directory", () => {
    expect(resolveLibraryPath("a/./b.md", DOC)).toBe("notes/sub/a/b.md");
    expect(resolveLibraryPath(".", "page.md")).toBe("");
  });
});

function relative(
  targetPath: string,
  targetKind: "document" | "asset",
  linkText: string,
  fragment: string | null = null,
): ExtractedLink {
  return { kind: "relative", targetPath, targetKind, linkText, fragment };
}

describe("extractDocumentLinks", () => {
  it("extracts standard links, images and wiki links in source order", () => {
    const markdown = [
      "# Title",
      "",
      "Read [the guide](./guide.md '快速上手') and [spec](../spec/rules.pdf).",
      "![diagram](assets/flow.png) plus [[Wiki Note#设计|别名]] and [[Concepts/Deep Idea]].",
      "External [site](https://example.com) is skipped, so is [broken](../../../nope.md).",
      "Anchor [here](#local) too, and [empty]().",
    ].join("\n");
    expect(extractDocumentLinks("notes/sub/page.md", markdown)).toEqual([
      relative("notes/sub/guide.md", "document", "the guide"),
      relative("notes/spec/rules.pdf", "document", "spec"),
      // L18: image targets keep their extension-derived kind
      relative("notes/sub/assets/flow.png", "asset", "diagram"),
      // L19/L20: wiki alias + anchor split
      { kind: "wiki", stem: "wiki note", linkText: "别名", fragment: "设计" },
      // L21: path-form wiki stem
      { kind: "wiki", stem: "concepts/deep idea", linkText: "Concepts/Deep Idea", fragment: null },
    ]);
  });

  it("L11: keeps the percent-decoded fragment of resolved targets", () => {
    expect(extractDocumentLinks("page.md", "[a](notes/a.md#%E7%AB%A0%E8%8A%82)")).toEqual([
      relative("notes/a.md", "document", "a", "章节"),
    ]);
    expect(extractDocumentLinks("page.md", "[a](notes/a.md#)")).toEqual([
      relative("notes/a.md", "document", "a", null),
    ]);
  });

  it("L16/L17: skips fenced code blocks and inline code spans", () => {
    const fenced =
      "```md\n[hidden](a.md)\n```\n[visible](b.md)\n~~~\n[also hidden](c.md)\n~~~\n";
    expect(extractDocumentLinks("page.md", fenced)).toEqual([
      relative("b.md", "document", "visible"),
    ]);
    const inline = "`[a](x.md)` stays code, ``[b](y.md)`` too, [c](z.md) does not.";
    expect(extractDocumentLinks("page.md", inline)).toEqual([
      relative("z.md", "document", "c"),
    ]);
    expect(extractDocumentLinks("page.md", "` lone backtick [d](w.md)")).toEqual([
      relative("w.md", "document", "d"),
    ]);
  });

  it("supports quoted titles and rejects unquoted embedded spaces", () => {
    expect(
      extractDocumentLinks("page.md", "[a](x.md \"标题\") [b](y.md '单引号')"),
    ).toEqual([relative("x.md", "document", "a"), relative("y.md", "document", "b")]);
    expect(extractDocumentLinks("page.md", "[a](two words.md)")).toEqual([]);
  });

  it("L22/L23: truncates link text and caps the per-document count", () => {
    const long = `[${"字".repeat(300)}](a.md)`;
    const [link] = extractDocumentLinks("page.md", long);
    expect(link.kind).toBe("relative");
    expect(Array.from(link.linkText)).toHaveLength(200);

    const bomb = Array.from({ length: 1_001 }, (_, index) => `[t](file-${index}.md)`).join(
      "\n",
    );
    expect(extractDocumentLinks("page.md", bomb)).toHaveLength(MAX_DOCUMENT_LINKS);
  });

  it("L24: classifies document extensions case-insensitively", () => {
    const markdown =
      "[a](a.MD) [b](b.markdown) [c](c.mdx) [d](d.PDF) [e](e.epub) [f](f.png) [g](g.txt)";
    const kinds = extractDocumentLinks("page.md", markdown).map((link) =>
      link.kind === "relative" ? link.targetKind : "wiki",
    );
    expect(kinds).toEqual([
      "document",
      "document",
      "document",
      "document",
      "document",
      "asset",
      "asset",
    ]);
  });

  it("drops empty and bracketed wiki stems, normalizes backslashes", () => {
    expect(extractDocumentLinks("page.md", "[[]] [[   ]] [[#only-anchor]]")).toEqual([]);
    expect(extractDocumentLinks("page.md", "[[bad[stem]]]")).toEqual([]);
    expect(extractDocumentLinks("page.md", "[[Dir\\Sub Note]]")).toEqual([
      { kind: "wiki", stem: "dir/sub note", linkText: "Dir\\Sub Note", fragment: null },
    ]);
  });
});

describe("resolveWikiTargets (BL-D1)", () => {
  const present = ["notes/Target.md", "x/Dup.md", "y/DUP.md", "guides/Deep Idea.mdx"];

  it("resolves unique file-name stems case-insensitively", () => {
    const resolved = resolveWikiTargets(["target"], present);
    expect(resolved.get("target")).toEqual({
      targetPath: "notes/Target.md",
      candidateCount: 1,
    });
  });

  it("reports ambiguity without building an edge", () => {
    const resolved = resolveWikiTargets(["dup"], present);
    expect(resolved.get("dup")).toEqual({ targetPath: null, candidateCount: 2 });
  });

  it("matches path-form stems against extension-less full paths", () => {
    const resolved = resolveWikiTargets(["guides/deep idea", "nowhere"], present);
    expect(resolved.get("guides/deep idea")).toEqual({
      targetPath: "guides/Deep Idea.mdx",
      candidateCount: 1,
    });
    expect(resolved.get("nowhere")).toEqual({ targetPath: null, candidateCount: 0 });
  });
});

describe("buildDocumentLinks (web twin of list_document_links)", () => {
  const documents = [
    { relativePath: "notes/target.md", title: "目标" },
    { relativePath: "a.md", title: "文档 A" },
    { relativePath: "b.md", title: "文档 B" },
    { relativePath: "c.md", title: "文档 C" },
    { relativePath: "x/Dup.md", title: "副本一" },
    { relativePath: "y/DUP.md", title: "副本二" },
  ];
  const linksBySource = new Map<string, ExtractedLink[]>([
    [
      "a.md",
      [
        relative("notes/target.md", "document", "去目标"),
        relative("notes/target.md", "document", "再一次"),
        { kind: "wiki", stem: "target", linkText: "wiki 指向", fragment: null },
      ],
    ],
    ["b.md", [{ kind: "wiki", stem: "target", linkText: "另一个 wiki", fragment: null }]],
    [
      "c.md",
      [
        relative("missing.md", "document", "断链"),
        relative("img.png", "asset", "图"),
        { kind: "wiki", stem: "nowhere", linkText: "无目标", fragment: null },
        { kind: "wiki", stem: "dup", linkText: "歧义", fragment: null },
      ],
    ],
  ]);

  it("aggregates backlinks per source with counts and first excerpts", () => {
    const links = buildDocumentLinks("notes/target.md", linksBySource, documents);
    expect(links.backlinks).toEqual([
      { sourcePath: "a.md", sourceTitle: "文档 A", linkText: "去目标", count: 3 },
      { sourcePath: "b.md", sourceTitle: "文档 B", linkText: "另一个 wiki", count: 1 },
    ]);
    expect(links.outgoing).toEqual([]);
    expect(links.brokenCount).toBe(0);
  });

  it("classifies outgoing entries and counts broken document targets", () => {
    const links = buildDocumentLinks("c.md", linksBySource, documents);
    expect(links.outgoing).toEqual([
      {
        kind: "document",
        targetPath: "missing.md",
        rawTarget: "missing.md",
        linkText: "断链",
        present: false,
        ambiguousCount: 0,
      },
      {
        kind: "asset",
        targetPath: "img.png",
        rawTarget: "img.png",
        linkText: "图",
        present: false,
        ambiguousCount: 0,
      },
      {
        kind: "wiki",
        targetPath: null,
        rawTarget: "nowhere",
        linkText: "无目标",
        present: false,
        ambiguousCount: 0,
      },
      {
        kind: "wiki",
        targetPath: null,
        rawTarget: "dup",
        linkText: "歧义",
        present: false,
        ambiguousCount: 2,
      },
    ]);
    expect(links.brokenCount).toBe(2);
  });

  it("resolves former ambiguity as soon as the document set changes", () => {
    const shrunk = documents.filter((document) => document.relativePath !== "y/DUP.md");
    const links = buildDocumentLinks("c.md", linksBySource, shrunk);
    const dup = links.outgoing.find((entry) => entry.rawTarget === "dup");
    expect(dup).toMatchObject({ targetPath: "x/Dup.md", present: true, ambiguousCount: 0 });
    const backlinks = buildDocumentLinks("x/Dup.md", linksBySource, shrunk);
    expect(backlinks.backlinks).toEqual([
      { sourcePath: "c.md", sourceTitle: "文档 C", linkText: "歧义", count: 1 },
    ]);
  });

  it("truncates both lists at the shared limit", () => {
    const manySources = Array.from({ length: 600 }, (_, index) => ({
      relativePath: `src-${String(index).padStart(3, "0")}.md`,
      title: `S${index}`,
    }));
    const map = new Map<string, ExtractedLink[]>(
      manySources.map((source) => [
        source.relativePath,
        [relative("hub.md", "document", "hub")],
      ]),
    );
    const hubDocuments = [...manySources, { relativePath: "hub.md", title: "Hub" }];
    const links = buildDocumentLinks("hub.md", map, hubDocuments);
    expect(links.backlinks).toHaveLength(LINKS_LIST_LIMIT);
    expect(WEB_LINKS_MAX_DOCUMENTS).toBe(500);
  });
});
