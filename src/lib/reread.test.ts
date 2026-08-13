// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { ReadSnapshotDiff } from "./backend";
import {
  REREAD_MARK_ATTRIBUTE,
  applyRereadMarks,
  clearRereadMarks,
  markdownLineOffset,
  nextRereadCursor,
  rereadBannerMessage,
  rereadJumpEnabled,
  shouldCaptureOnLeave,
} from "./reread";

function diff(overrides: Partial<ReadSnapshotDiff> = {}): ReadSnapshotDiff {
  return {
    granularity: "paragraph",
    changedSegments: [],
    removedCount: 0,
    capturedAt: 1_700_000_000,
    truncated: false,
    ...overrides,
  };
}

describe("rereadBannerMessage", () => {
  it("summarizes paragraph modifications, additions and removals", () => {
    const message = rereadBannerMessage(
      diff({
        changedSegments: [
          { index: 0, kind: "modified", startLine: 1, endLine: 2 },
          { index: 3, kind: "added", startLine: 9, endLine: 9 },
          { index: 4, kind: "modified", startLine: 12, endLine: 14 },
        ],
        removedCount: 2,
      }),
    );
    expect(message).toBe("自上次阅读后有更新：2 段修改、1 段新增、2 段删除");
  });

  it("uses chapter units for EPUB and page ordinals for PDF", () => {
    expect(
      rereadBannerMessage(
        diff({
          granularity: "chapter",
          changedSegments: [{ index: 1, kind: "added", startLine: null, endLine: null }],
        }),
      ),
    ).toBe("自上次阅读后有更新：1 章新增");

    expect(
      rereadBannerMessage(
        diff({
          granularity: "page",
          changedSegments: [
            { index: 1, kind: "modified", startLine: null, endLine: null },
            { index: 4, kind: "modified", startLine: null, endLine: null },
          ],
          removedCount: 1,
        }),
      ),
    ).toBe("自上次阅读后第 2、5 页有变化，另有 1 页删除");
  });

  it("degrades to a whole-document hint when truncated", () => {
    expect(rereadBannerMessage(diff({ truncated: true }))).toBe("自上次阅读后有大量更新");
  });
});

describe("rereadJumpEnabled / nextRereadCursor", () => {
  it("offers jumping only for paragraph and chapter granularity with marks", () => {
    const segment = { index: 0, kind: "modified" as const, startLine: 1, endLine: 1 };
    expect(rereadJumpEnabled(diff({ changedSegments: [segment] }))).toBe(true);
    expect(
      rereadJumpEnabled(diff({ granularity: "chapter", changedSegments: [segment] })),
    ).toBe(true);
    expect(rereadJumpEnabled(diff({ granularity: "page", changedSegments: [segment] }))).toBe(
      false,
    );
    expect(rereadJumpEnabled(diff({ changedSegments: [segment], truncated: true }))).toBe(false);
    expect(rereadJumpEnabled(diff())).toBe(false);
  });

  it("cycles through the marks and handles empty lists", () => {
    expect(nextRereadCursor(-1, 3)).toBe(0);
    expect(nextRereadCursor(0, 3)).toBe(1);
    expect(nextRereadCursor(2, 3)).toBe(0);
    expect(nextRereadCursor(-1, 0)).toBe(-1);
  });
});

describe("shouldCaptureOnLeave", () => {
  it("captures only while the disk fingerprint is unchanged since open", () => {
    const opened = { size: 100, modified: 1000 };
    expect(shouldCaptureOnLeave(opened, { size: 100, modified: 1000 })).toBe(true);
    expect(shouldCaptureOnLeave(opened, { size: 120, modified: 1000 })).toBe(false);
    expect(shouldCaptureOnLeave(opened, { size: 100, modified: 2000 })).toBe(false);
    expect(shouldCaptureOnLeave(opened, null)).toBe(false);
  });
});

describe("markdownLineOffset", () => {
  it("counts the source lines stripped by the display transform", () => {
    const source = "\uFEFF---\ntitle: x\n---\n# 标题\n\n正文第一段。\n";
    // displayMarkdown 剥掉 frontmatter(3 行)+ H1(1 行)+ 空行(1 行)。
    expect(markdownLineOffset(source, "正文第一段。\n")).toBe(5);
    expect(markdownLineOffset("正文。\n", "正文。\n")).toBe(0);
    expect(markdownLineOffset(source, "")).toBe(0);
    expect(markdownLineOffset(source, "完全不匹配的内容")).toBe(0);
  });
});

describe("applyRereadMarks", () => {
  it("shifts DOM line stamps by the display offset before matching", () => {
    const root = document.createElement("div");
    // 渲染层的行号从 1 起(剥掉 2 行后),原文变更在第 4 行。
    root.innerHTML =
      '<p data-source-start="1" data-source-end="1">a</p>' +
      '<p data-source-start="2" data-source-end="2">b</p>';

    const marked = applyRereadMarks(
      root,
      diff({ changedSegments: [{ index: 1, kind: "modified", startLine: 4, endLine: 4 }] }),
      2,
    );

    expect(marked).toHaveLength(1);
    expect(root.children[0]?.hasAttribute(REREAD_MARK_ATTRIBUTE)).toBe(false);
    expect(root.children[1]?.getAttribute(REREAD_MARK_ATTRIBUTE)).toBe("modified");
  });

  it("marks markdown blocks whose source range intersects a changed paragraph", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      '<p data-source-start="1" data-source-end="2">intro</p>',
      '<p data-source-start="4" data-source-end="4">changed</p>',
      '<ul data-source-start="6" data-source-end="8"><li>x</li></ul>',
    ].join("");

    const marked = applyRereadMarks(
      root,
      diff({
        changedSegments: [
          { index: 1, kind: "modified", startLine: 4, endLine: 4 },
          { index: 2, kind: "added", startLine: 7, endLine: 7 },
        ],
      }),
    );

    expect(marked).toHaveLength(2);
    expect(root.querySelectorAll(`[${REREAD_MARK_ATTRIBUTE}]`)).toHaveLength(2);
    expect(root.children[0]?.hasAttribute(REREAD_MARK_ATTRIBUTE)).toBe(false);
    expect(root.children[1]?.getAttribute(REREAD_MARK_ATTRIBUTE)).toBe("modified");
    expect(root.children[2]?.getAttribute(REREAD_MARK_ATTRIBUTE)).toBe("added");
  });

  it("keeps only the deepest block for nested structures", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<blockquote data-source-start="1" data-source-end="3">' +
      '<p data-source-start="2" data-source-end="2">inner</p>' +
      "</blockquote>";

    const marked = applyRereadMarks(
      root,
      diff({ changedSegments: [{ index: 0, kind: "modified", startLine: 2, endLine: 2 }] }),
    );

    expect(marked).toHaveLength(1);
    expect(root.querySelector("blockquote")?.hasAttribute(REREAD_MARK_ATTRIBUTE)).toBe(false);
    expect(root.querySelector("p")?.getAttribute(REREAD_MARK_ATTRIBUTE)).toBe("modified");
  });

  it("marks EPUB chapters by ordinal and skips pages plus truncated diffs", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<section class="epub-chapter">a</section>' +
      '<section class="epub-chapter">b</section>';

    const marked = applyRereadMarks(
      root,
      diff({
        granularity: "chapter",
        changedSegments: [{ index: 1, kind: "modified", startLine: null, endLine: null }],
      }),
    );
    expect(marked).toHaveLength(1);
    expect(root.children[1]?.getAttribute(REREAD_MARK_ATTRIBUTE)).toBe("modified");

    // Page-level diffs and truncated diffs both clear existing marks and add none.
    expect(
      applyRereadMarks(
        root,
        diff({
          granularity: "page",
          changedSegments: [{ index: 0, kind: "modified", startLine: null, endLine: null }],
        }),
      ),
    ).toHaveLength(0);
    expect(root.querySelectorAll(`[${REREAD_MARK_ATTRIBUTE}]`)).toHaveLength(0);
  });

  it("clearRereadMarks removes every mark", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p ${REREAD_MARK_ATTRIBUTE}="modified">x</p><p ${REREAD_MARK_ATTRIBUTE}="added">y</p>`;
    clearRereadMarks(root);
    expect(root.querySelectorAll(`[${REREAD_MARK_ATTRIBUTE}]`)).toHaveLength(0);
  });
});
