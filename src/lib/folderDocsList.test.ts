import { describe, expect, it } from "vitest";
import type { DocumentInfo } from "./backend";
import {
  canOpenFolderDocs,
  filterFolderDocuments,
  folderDocsCrumbs,
  folderDocsLabel,
  folderDocsRows,
  formatFolderDocDate,
  listDocumentsInFolder,
  listFolderDocsRail,
  listFolderLevel,
  resolveFolderDocsDirectory,
} from "./folderDocsList";

function doc(relativePath: string, title: string, modified = 1): DocumentInfo {
  return {
    relativePath,
    title,
    size: 1,
    modified,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
  };
}

const documents = [
  doc("library/zh/agents/one.md", "第一篇很长的标题"),
  doc("library/zh/agents/two.md", "第二篇"),
  doc("library/zh/short.md", "短名"),
  doc("library/en/a.md", "English"),
  doc("readme.md", "根说明"),
];

describe("resolveFolderDocsDirectory", () => {
  it("prefers the tree scope over the current document parent", () => {
    expect(resolveFolderDocsDirectory("library/zh", "library/zh/agents/a.md")).toBe(
      "library/zh",
    );
  });

  it("falls back to the parent of the current document", () => {
    expect(resolveFolderDocsDirectory(null, "library/zh/a.md")).toBe("library/zh");
    expect(resolveFolderDocsDirectory(null, "root.md")).toBeNull();
    expect(resolveFolderDocsDirectory(null, null)).toBeUndefined();
  });
});

describe("listFolderLevel", () => {
  it("lists only direct child folders and this-level documents", () => {
    const level = listFolderLevel(documents, "library/zh");
    expect(level.folders.map((folder) => folder.path)).toEqual(["library/zh/agents"]);
    expect(level.documents.map((entry) => entry.relativePath)).toEqual(["library/zh/short.md"]);
  });

  it("lists root-level folders and files when folderPath is null", () => {
    const level = listFolderLevel(documents, null);
    expect(level.folders.map((folder) => folder.path)).toEqual(["library"]);
    expect(level.documents.map((entry) => entry.relativePath)).toEqual(["readme.md"]);
  });
});

describe("listDocumentsInFolder", () => {
  it("lists every document under the folder, including nested ones", () => {
    expect(
      listDocumentsInFolder(documents, "library/zh").map((entry) => entry.relativePath).sort(),
    ).toEqual(
      ["library/zh/agents/one.md", "library/zh/agents/two.md", "library/zh/short.md"].sort(),
    );
  });

  it("lists the whole library when folderPath is null", () => {
    expect(
      listDocumentsInFolder(documents, null).map((entry) => entry.relativePath).sort(),
    ).toEqual(
      [
        "library/en/a.md",
        "library/zh/agents/one.md",
        "library/zh/agents/two.md",
        "library/zh/short.md",
        "readme.md",
      ].sort(),
    );
  });
});

describe("folderDocsCrumbs and listFolderDocsRail", () => {
  it("builds crumbs from the library label through each path segment", () => {
    expect(folderDocsCrumbs("library/zh", "Demo")).toEqual([
      { path: null, label: "Demo" },
      { path: "library", label: "library" },
      { path: "library/zh", label: "zh" },
    ]);
    expect(folderDocsCrumbs(null, "  ")).toEqual([{ path: null, label: "书库" }]);
  });

  it("expands ancestors and the current folder in the rail", () => {
    const rail = listFolderDocsRail(documents, "library/zh", "Demo");
    expect(rail[0]).toMatchObject({ path: null, name: "Demo", depth: 0, current: false });
    expect(rail.find((item) => item.path === "library/zh")).toMatchObject({
      depth: 2,
      current: true,
    });
    expect(rail.find((item) => item.path === "library/zh/agents")).toMatchObject({
      depth: 3,
      current: false,
    });
    expect(rail.some((item) => item.path === "library/en")).toBe(true);
    expect(rail.some((item) => item.path?.includes(".md"))).toBe(false);
  });
});

describe("folderDocsRows", () => {
  const contents = listFolderLevel(documents, "library/zh");
  const descendants = listDocumentsInFolder(documents, "library/zh");

  it("shows this-level folders then documents when the query is empty", () => {
    expect(
      folderDocsRows(contents, "", descendants).map((row) =>
        row.kind === "folder" ? row.path : row.document.relativePath,
      ),
    ).toEqual(["library/zh/agents", "library/zh/short.md"]);
  });

  it("matches current-level folders and descendant titles when filtering", () => {
    expect(
      folderDocsRows(contents, "第一篇", descendants).map((row) =>
        row.kind === "folder" ? row.name : row.document.title,
      ),
    ).toEqual(["第一篇很长的标题"]);
    expect(
      folderDocsRows(contents, "agents", descendants).map((row) =>
        row.kind === "folder" ? row.name : row.document.title,
      ),
    ).toEqual(["agents", "第二篇", "第一篇很长的标题"]);
  });
});

describe("filterFolderDocuments", () => {
  const sample = [
    doc("a.md", "面向企业各业务线的代理方案"),
    doc("b.md", "2026 年提示词指南"),
  ];

  it("keeps all rows for an empty query and filters by title tokens", () => {
    expect(filterFolderDocuments(sample, "  ").map((entry) => entry.title)).toEqual([
      "面向企业各业务线的代理方案",
      "2026 年提示词指南",
    ]);
    expect(filterFolderDocuments(sample, "企业 代理").map((entry) => entry.title)).toEqual([
      "面向企业各业务线的代理方案",
    ]);
  });
});

describe("folderDocsLabel and canOpenFolderDocs", () => {
  it("labels the leaf folder name and detects openable context", () => {
    expect(folderDocsLabel("library/zh")).toBe("zh");
    expect(folderDocsLabel(null)).toBe("书库根目录");
    expect(canOpenFolderDocs("zh", null)).toBe(true);
    expect(canOpenFolderDocs(null, "zh/a.md")).toBe(true);
    expect(canOpenFolderDocs(null, "a.md")).toBe(true);
    expect(canOpenFolderDocs(null, null)).toBe(false);
  });
});

describe("formatFolderDocDate", () => {
  it("formats unix seconds and milliseconds as MM-DD", () => {
    expect(formatFolderDocDate(1_704_067_200)).toBe(formatFolderDocDate(1_704_067_200_000));
    expect(formatFolderDocDate(1_704_067_200_000)).toMatch(/^\d{2}-\d{2}$/);
  });

  it("returns an empty string for invalid values", () => {
    expect(formatFolderDocDate(0)).toBe("");
    expect(formatFolderDocDate(Number.NaN)).toBe("");
  });
});
