// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentInfo } from "../lib/backend";
import { TREE_LAYOUT_ROOT } from "../lib/treeLayout";
import { useReaderStore } from "../store/useReaderStore";
import { DocumentTree } from "./DocumentTree";

vi.mock("../lib/backend", async () => {
  const actual = await vi.importActual<typeof import("../lib/backend")>("../lib/backend");
  return {
    ...actual,
    readDocument: vi.fn(async (relativePath: string) => ({
      kind: "markdown" as const,
      relativePath,
      markdown: "# Test",
    })),
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
    searchQuery: "",
    expandedPaths: [],
    loading: false,
    error: null,
  });
}

describe("DocumentTree pin and drag handles", () => {
  beforeEach(() => {
    localStorage.clear();
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    seedLibrary([documentInfo("b.md", "Beta"), documentInfo("a.md", "Alpha")]);
  });

  afterEach(() => {
    cleanup();
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
