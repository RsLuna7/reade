import { describe, expect, it } from "vitest";
import type { DocumentInfo } from "./backend";
import {
  buildDocumentTree,
  collectDirectoryPaths,
  flattenDocumentsInTreeOrder,
  reconcileExpandedPaths,
} from "./tree";

function document(relativePath: string, title = ""): DocumentInfo {
  return { relativePath, title, size: 1, modified: 1, format: "markdown", indexStatus: "ready", indexError: null };
}

describe("buildDocumentTree", () => {
  it("builds stable nested nodes and sorts folders before files naturally", () => {
    const tree = buildDocumentTree([
      document("第10章.md", "第10章"),
      document("附录/说明.md", "说明"),
      document("第2章.md", "第2章"),
      document("正文/第二节.md", "第二节"),
      document("正文/第一节.md", "第一节"),
    ]);

    expect(tree.map((node) => node.name)).toEqual(["附录", "正文", "第2章", "第10章"]);
    expect(tree[1]).toMatchObject({
      kind: "directory",
      id: "directory:正文",
      path: "正文",
    });

    if (tree[1].kind !== "directory") throw new Error("expected directory");
    expect(tree[1].children.map((node) => node.name)).toEqual(["第二节", "第一节"]);
  });

  it("normalizes separators for hierarchy while preserving backend paths", () => {
    const tree = buildDocumentTree([document("指南\\开始.md")]);
    expect(tree[0]).toMatchObject({ kind: "directory", path: "指南" });
    if (tree[0].kind !== "directory") throw new Error("expected directory");
    expect(tree[0].children[0]).toMatchObject({
      id: "document:指南/开始.md",
      name: "开始",
      path: "指南\\开始.md",
    });
  });
});

describe("flattenDocumentsInTreeOrder (plan-bookshelf-covers §3.3)", () => {
  it("walks the sorted tree depth-first so the shelf mirrors the tree order", () => {
    const tree = buildDocumentTree([
      document("第10章.md", "第10章"),
      document("附录/说明.md", "说明"),
      document("第2章.md", "第2章"),
      document("正文/第二节.md", "第二节"),
      document("正文/第一节.md", "第一节"),
    ]);
    expect(flattenDocumentsInTreeOrder(tree).map((entry) => entry.relativePath)).toEqual([
      "附录/说明.md",
      "正文/第二节.md",
      "正文/第一节.md",
      "第2章.md",
      "第10章.md",
    ]);
  });

  it("returns an empty list for an empty tree", () => {
    expect(flattenDocumentsInTreeOrder([])).toEqual([]);
  });
});

describe("expanded directory reconciliation", () => {
  it("retains existing directory paths and drops paths removed by refresh", () => {
    const tree = buildDocumentTree([
      document("正文/第一章.md"),
      document("附录/索引.md"),
    ]);

    expect(collectDirectoryPaths(tree)).toEqual(new Set(["正文", "附录"]));
    expect(reconcileExpandedPaths(["正文", "已删除", "正文"], tree)).toEqual(["正文"]);
  });
});
