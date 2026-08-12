import { describe, expect, it } from "vitest";
import type { DocumentInfo } from "./backend";
import { buildLibraryStatusDetail } from "./libraryStatus";

function doc(
  format: DocumentInfo["format"],
  indexStatus: DocumentInfo["indexStatus"] = "ready",
): DocumentInfo {
  return {
    relativePath: `${format}-${indexStatus}-${Math.random()}.bin`,
    title: format,
    size: 1,
    modified: 1,
    format,
    indexStatus,
    indexError: null,
  };
}

describe("buildLibraryStatusDetail", () => {
  it("prefers search and live index progress over idle stats", () => {
    expect(
      buildLibraryStatusDetail({
        isWeb: false,
        searchQuery: "agent",
        searchResultCount: 3,
        indexProgress: { total: 10, completed: 4, ready: 3, partial: 1, failed: 0 },
        documents: [doc("markdown"), doc("pdf")],
      }),
    ).toBe("3 条搜索结果");

    expect(
      buildLibraryStatusDetail({
        isWeb: false,
        searchQuery: "",
        searchResultCount: 0,
        indexProgress: { total: 10, completed: 4, ready: 3, partial: 1, failed: 0 },
        documents: [doc("markdown"), doc("pdf")],
      }),
    ).toBe("索引 4/10 · 部分 1 · 失败 0");
  });

  it("stays empty when idle so only the document count shows", () => {
    expect(
      buildLibraryStatusDetail({
        isWeb: false,
        searchQuery: "",
        searchResultCount: 0,
        indexProgress: null,
        documents: [
          doc("markdown"),
          doc("mdx"),
          doc("pdf", "partial"),
          doc("epub", "failed"),
        ],
      }),
    ).toBe("");
  });

  it("prompts to open a library when empty on desktop", () => {
    expect(
      buildLibraryStatusDetail({
        isWeb: false,
        searchQuery: "",
        searchResultCount: 0,
        indexProgress: null,
        documents: [],
      }),
    ).toBe("选择文件夹开始阅读");
  });
});
