// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentExtent, DocumentInfo } from "../lib/backend";
import type { ReadingPosition } from "../lib/readingPositions";
import { CoverageTreemap } from "./CoverageTreemap";

afterEach(cleanup);

function documentInfo(relativePath: string, overrides: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    relativePath,
    title: "",
    size: 1000,
    modified: 1,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
    ...overrides,
  };
}

function extentsOf(entries: Array<[string, number]>): Map<string, DocumentExtent> {
  return new Map(
    entries.map(([relativePath, charCount]) => [
      relativePath,
      { relativePath, charCount, segmentCount: 1, needsOcrSegments: 0 },
    ]),
  );
}

function scrollPosition(maxScrollRatio: number): ReadingPosition {
  return { kind: "scroll", scrollRatio: maxScrollRatio, maxScrollRatio, updatedAt: 1 };
}

const LIBRARY = [
  documentInfo("正文/第一章.md", { title: "第一章" }),
  documentInfo("正文/第二章.md", { title: "第二章" }),
  documentInfo("说明.md", { title: "说明" }),
];
const EXTENTS = extentsOf([
  ["正文/第一章.md", 4000],
  ["正文/第二章.md", 2000],
  ["说明.md", 1000],
]);
const POSITIONS: Record<string, ReadingPosition> = {
  "正文/第一章.md": scrollPosition(0.9),
};

function renderMap(onOpenDocument = vi.fn()) {
  const view = render(
    <CoverageTreemap
      documents={LIBRARY}
      extents={EXTENTS}
      positions={POSITIONS}
      motionLevel="off"
      onOpenDocument={onOpenDocument}
    />,
  );
  return { view, onOpenDocument };
}

describe("CoverageTreemap (plan-coverage-treemap §3.2)", () => {
  it("renders folder and document tiles with coverage in the accessible name", () => {
    const { view } = renderMap();
    const folder = view.getByRole("button", { name: /正文 · .*覆盖率 60%.*（下钻）/ });
    expect(folder).toBeInTheDocument();
    expect(view.getByRole("button", { name: /说明 .*覆盖率 0%/ })).toBeInTheDocument();
  });

  it("drills into a folder, shows the breadcrumb and returns", () => {
    const { view } = renderMap();
    fireEvent.click(view.getByRole("button", { name: /正文 · .*（下钻）/ }));

    // 下钻后当前层是两章文档。
    expect(view.getByRole("button", { name: /第一章 .*覆盖率 90%/ })).toBeInTheDocument();
    expect(view.getByRole("button", { name: /第二章 .*覆盖率 0%/ })).toBeInTheDocument();
    const breadcrumb = view.getByRole("navigation", { name: "知识地图层级" });
    expect(within(breadcrumb).getByRole("button", { name: "正文" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(view.getByRole("button", { name: "返回上一级" }));
    expect(view.getByRole("button", { name: /正文 · .*（下钻）/ })).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "返回上一级" })).not.toBeInTheDocument();
  });

  it("opens a document tile on click and on Enter", () => {
    const { view, onOpenDocument } = renderMap();
    fireEvent.click(view.getByRole("button", { name: /说明 .*覆盖率 0%/ }));
    expect(onOpenDocument).toHaveBeenCalledWith("说明.md");

    fireEvent.click(view.getByRole("button", { name: /正文 · .*（下钻）/ }));
    fireEvent.keyDown(view.getByRole("button", { name: /第一章/ }), { key: "Enter" });
    expect(onOpenDocument).toHaveBeenCalledWith("正文/第一章.md");
  });

  it("supports keyboard drill-down with Space", () => {
    const { view } = renderMap();
    fireEvent.keyDown(view.getByRole("button", { name: /正文 · .*（下钻）/ }), { key: " " });
    expect(view.getByRole("button", { name: /第一章/ })).toBeInTheDocument();
  });

  it("shows the empty-library state", () => {
    const view = render(
      <CoverageTreemap
        documents={[]}
        extents={null}
        positions={{}}
        motionLevel="off"
        onOpenDocument={vi.fn()}
      />,
    );
    expect(view.getByRole("status")).toHaveTextContent("文档库为空");
  });

  it("shows the not-indexed state when no text data exists", () => {
    const view = render(
      <CoverageTreemap
        documents={[documentInfo("a.md", { size: 0 })]}
        extents={null}
        positions={{}}
        motionLevel="off"
        onOpenDocument={vi.fn()}
      />,
    );
    expect(view.getByRole("status")).toHaveTextContent("索引尚未产出文本数据");
  });

  it("falls back to file size for area when extents are missing", () => {
    const view = render(
      <CoverageTreemap
        documents={[documentInfo("a.md", { size: 800, title: "甲" })]}
        extents={null}
        positions={{}}
        motionLevel="off"
        onOpenDocument={vi.fn()}
      />,
    );
    expect(view.getByRole("button", { name: /甲 · 800 字/ })).toBeInTheDocument();
  });
});
