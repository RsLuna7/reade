// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentInfo } from "../lib/backend";
import { TREE_LAYOUT_ROOT } from "../lib/treeLayout";
import { useReaderStore } from "../store/useReaderStore";
import { DocumentTree } from "./DocumentTree";

const { revealInFileManagerMock } = vi.hoisted(() => ({
  revealInFileManagerMock: vi.fn(async (_relativePath: string) => undefined),
}));

vi.mock("../lib/backend", async () => {
  const actual = await vi.importActual<typeof import("../lib/backend")>("../lib/backend");
  return {
    ...actual,
    readDocument: vi.fn(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# Test",
    })),
    revealInFileManager: revealInFileManagerMock,
  };
});

function documentInfo(relativePath: string, title: string): DocumentInfo {
  return {
    relativePath,
    title,
    size: 1,
    modified: 1,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
  };
}

function seedLibrary(documents: DocumentInfo[]) {
  useReaderStore.setState({
    snapshot: { rootPath: "D:/library", documents },
    documents,
    currentPath: null,
    treeLayout: {},
    readMarks: {},
    searchQuery: "",
    expandedPaths: [],
    loading: false,
    error: null,
  });
}

describe("DocumentTree pin and drag handles", () => {
  beforeEach(() => {
    localStorage.clear();
    revealInFileManagerMock.mockReset();
    revealInFileManagerMock.mockResolvedValue(undefined);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    seedLibrary([documentInfo("b.md", "Beta"), documentInfo("a.md", "Alpha")]);
  });

  afterEach(() => {
    cleanup();
  });

  it("marks a document as read from the context menu and can unmark it", () => {
    render(<DocumentTree />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Beta/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "已阅" }));
    expect(useReaderStore.getState().readMarks["b.md"]).toEqual(expect.any(Number));
    expect(screen.getByLabelText("已阅")).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("button", { name: /Beta/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "取消已阅" }));
    expect(useReaderStore.getState().readMarks["b.md"]).toBeUndefined();
    expect(screen.queryByLabelText("已阅")).not.toBeInTheDocument();
  });

  it("does not offer 已阅 on folders", () => {
    seedLibrary([documentInfo("notes/a.md", "Alpha")]);
    render(<DocumentTree />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /notes/ }));
    expect(screen.queryByRole("menuitem", { name: "已阅" })).not.toBeInTheDocument();
  });

  it("pins a document from the context menu and moves it to the top of its folder", () => {
    render(<DocumentTree />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Beta/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));
    expect(useReaderStore.getState().treeLayout[TREE_LAYOUT_ROOT]?.pinned).toEqual(["b.md"]);
    expect(screen.getByRole("tree").textContent).toMatch(/Beta.*Alpha/s);
    const rootNodes = screen.getByRole("tree").querySelectorAll(":scope > .document-tree__node");
    expect(rootNodes[0]).toHaveClass("document-tree__node--pin-end");
    expect(rootNodes[1]).not.toHaveClass("document-tree__node--pin-end");
  });

  it("reveals a document in the file manager from the context menu", async () => {
    render(<DocumentTree />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Beta/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "在资源管理器中显示" }));
    await waitFor(() => {
      expect(revealInFileManagerMock).toHaveBeenCalledWith("b.md");
    });
  });

  it("reveals a folder in the file manager from the context menu", async () => {
    seedLibrary([documentInfo("notes/a.md", "Alpha")]);
    render(<DocumentTree />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /notes/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "在资源管理器中显示" }));
    await waitFor(() => {
      expect(revealInFileManagerMock).toHaveBeenCalledWith("notes");
    });
  });

  it("reports a notice when revealing in the file manager fails", async () => {
    const onNotice = vi.fn();
    revealInFileManagerMock.mockRejectedValueOnce(new Error("missing"));
    render(<DocumentTree onNotice={onNotice} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Alpha/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "在资源管理器中显示" }));
    await waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith("无法在资源管理器中显示该文件");
    });
  });

  it("still opens a document when the format handle is clicked without dragging", async () => {
    render(<DocumentTree />);
    const row = screen.getByRole("button", { name: /Alpha/ });
    const handle = row.querySelector(".document-tree__handle");
    if (!(handle instanceof HTMLElement)) throw new Error("expected handle");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(row);
    await waitFor(() => {
      expect(useReaderStore.getState().currentPath).toBe("a.md");
    });
  });
});

describe("DocumentTree breadcrumb reveal", () => {
  beforeEach(() => {
    localStorage.clear();
    seedLibrary([
      documentInfo("正文/第一章/导论.md", "导论"),
      documentInfo("附录/索引.md", "索引"),
    ]);
    useReaderStore.setState({ motionLevel: "off" });
  });

  afterEach(() => {
    cleanup();
  });

  it("expands and focuses the requested directory, then clears the reveal request", async () => {
    render(<DocumentTree />);

    await act(async () => {
      useReaderStore.getState().revealInDocumentTree("正文/第一章");
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });

    await waitFor(() => {
      expect(useReaderStore.getState().treeReveal).toBeNull();
    });
    expect(useReaderStore.getState().treeScopePath).toBe("正文/第一章");
    expect(useReaderStore.getState().expandedPaths).toEqual(["正文", "正文/第一章"]);
    expect(screen.getByText("正在浏览")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部" })).toBeInTheDocument();
    // Scoped view shows the folder's children, not the folder row itself.
    expect(screen.getByRole("button", { name: /导论/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^正文$/ })).not.toBeInTheDocument();
  });
});
