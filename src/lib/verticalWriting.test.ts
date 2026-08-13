// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  VERTICAL_WRITING_LIBRARY_LIMIT,
  VERTICAL_WRITING_STORAGE_KEY,
  readVerticalPreference,
  verticalScrollRatio,
  verticalWritingUnavailableReason,
  writeVerticalPreference,
} from "./verticalWriting";

const ROOT = "D:\\library";

beforeEach(() => {
  localStorage.clear();
});

describe("verticalWritingUnavailableReason (VW-D1 支持矩阵)", () => {
  it("allows markdown and epub only", () => {
    expect(verticalWritingUnavailableReason("markdown")).toBeNull();
    expect(verticalWritingUnavailableReason("epub")).toBeNull();
    expect(verticalWritingUnavailableReason("pdf")).toMatch(/PDF/);
    expect(verticalWritingUnavailableReason("mdx")).toMatch(/MDX/);
    expect(verticalWritingUnavailableReason(null)).toMatch(/打开文档/);
  });
});

describe("per-document preference storage", () => {
  it("round-trips the enabled flag per library and path", () => {
    expect(readVerticalPreference(ROOT, "poem.md")).toBe(false);
    writeVerticalPreference(ROOT, "poem.md", true);
    expect(readVerticalPreference(ROOT, "poem.md")).toBe(true);
    // 库间隔离:另一书库同路径不受影响。
    expect(readVerticalPreference("E:\\other", "poem.md")).toBe(false);
    writeVerticalPreference(ROOT, "poem.md", false);
    expect(readVerticalPreference(ROOT, "poem.md")).toBe(false);
    // 关闭即删除条目,信封不留空库。
    expect(localStorage.getItem(VERTICAL_WRITING_STORAGE_KEY)).toBe(
      JSON.stringify({ version: 1, libraries: {} }),
    );
  });

  it("evicts the oldest entries beyond the per-library limit", () => {
    for (let index = 0; index < VERTICAL_WRITING_LIBRARY_LIMIT + 5; index += 1) {
      writeVerticalPreference(ROOT, `doc-${index}.md`, true, 1_000 + index);
    }
    expect(readVerticalPreference(ROOT, "doc-0.md")).toBe(false);
    expect(readVerticalPreference(ROOT, "doc-4.md")).toBe(false);
    expect(readVerticalPreference(ROOT, "doc-5.md")).toBe(true);
    expect(
      readVerticalPreference(ROOT, `doc-${VERTICAL_WRITING_LIBRARY_LIMIT + 4}.md`),
    ).toBe(true);
  });

  it("drops malformed storage content silently", () => {
    localStorage.setItem(VERTICAL_WRITING_STORAGE_KEY, "{not json");
    expect(readVerticalPreference(ROOT, "poem.md")).toBe(false);

    localStorage.setItem(
      VERTICAL_WRITING_STORAGE_KEY,
      JSON.stringify({ version: 99, libraries: { [ROOT]: { "poem.md": { updatedAt: 1 } } } }),
    );
    expect(readVerticalPreference(ROOT, "poem.md")).toBe(false);

    localStorage.setItem(
      VERTICAL_WRITING_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        libraries: {
          [ROOT]: {
            "bad.md": { updatedAt: "yesterday" },
            "good.md": { updatedAt: 5 },
            "null.md": null,
          },
        },
      }),
    );
    expect(readVerticalPreference(ROOT, "bad.md")).toBe(false);
    expect(readVerticalPreference(ROOT, "null.md")).toBe(false);
    expect(readVerticalPreference(ROOT, "good.md")).toBe(true);
  });
});

describe("verticalScrollRatio", () => {
  it("uses the absolute scrollLeft against the range", () => {
    // Chromium 规范行为:vertical-rl 容器 scrollLeft ∈ [-max, 0]。
    expect(verticalScrollRatio(-500, 1000)).toBe(0.5);
    expect(verticalScrollRatio(0, 1000)).toBe(0);
    expect(verticalScrollRatio(-1200, 1000)).toBe(1);
    // 史遗正值实现同样成立。
    expect(verticalScrollRatio(250, 1000)).toBe(0.25);
    expect(verticalScrollRatio(-500, 0)).toBe(0);
    expect(verticalScrollRatio(Number.NaN, 1000)).toBe(0);
  });
});
