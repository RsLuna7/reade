import { describe, expect, it } from "vitest";
import { buildLibraryStatusDetail } from "./libraryStatus";

describe("buildLibraryStatusDetail", () => {
  it("prefers search over live index progress", () => {
    expect(
      buildLibraryStatusDetail({
        searchQuery: "agent",
        searchResultCount: 3,
        indexProgress: { libraryRoot: "D:/library", total: 10, completed: 4, ready: 3, partial: 1, failed: 0 },
      }),
    ).toBe("3 条搜索结果");

    expect(
      buildLibraryStatusDetail({
        searchQuery: "",
        searchResultCount: 0,
        indexProgress: { libraryRoot: "D:/library", total: 10, completed: 4, ready: 3, partial: 1, failed: 0 },
      }),
    ).toBe("索引 4/10 · 部分 1 · 失败 0");
  });

  it("stays empty when idle so the footer only shows theme controls", () => {
    expect(
      buildLibraryStatusDetail({
        searchQuery: "",
        searchResultCount: 0,
        indexProgress: null,
      }),
    ).toBe("");
  });
});
