import { beforeEach, describe, expect, it, vi } from "vitest";

// The wrappers are pure IPC plumbing; mock the Tauri modules so the tests
// can assert the exact command names and camelCase argument shapes that the
// Rust side (snake_case parameters) expects.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import {
  addCollectionItem,
  createCollection,
  deleteCollection,
  detectMovedDocuments,
  findRelatedPassages,
  listCollectionItems,
  listCollections,
  listDocumentLinks,
  readDocumentPreview,
  rebindDocumentAnnotations,
  removeCollectionItem,
  renameCollection,
  reorderCollectionItems,
} from "./tauriBackend";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("move detection IPC wrappers", () => {
  it("detectMovedDocuments invokes the command and passes the payload through", async () => {
    const candidates = [
      { oldPath: "old.md", newPath: "moved/new.md", annotationCount: 2, ambiguous: false },
    ];
    invokeMock.mockResolvedValueOnce(candidates);

    await expect(detectMovedDocuments()).resolves.toEqual(candidates);
    expect(invokeMock).toHaveBeenCalledWith("detect_moved_documents");
  });

  it("rebindDocumentAnnotations sends camelCase args and returns the migrated count", async () => {
    invokeMock.mockResolvedValueOnce(3);

    await expect(rebindDocumentAnnotations("old.md", "moved/new.md")).resolves.toBe(3);
    expect(invokeMock).toHaveBeenCalledWith("rebind_document_annotations", {
      oldPath: "old.md",
      newPath: "moved/new.md",
    });
  });
});

describe("document link and related passage IPC wrappers", () => {
  it("listDocumentLinks sends the camelCase path key", async () => {
    const links = { backlinks: [], outgoing: [], brokenCount: 0 };
    invokeMock.mockResolvedValueOnce(links);

    await expect(listDocumentLinks("notes/a.md")).resolves.toEqual(links);
    expect(invokeMock).toHaveBeenCalledWith("list_document_links", {
      relativePath: "notes/a.md",
    });
  });

  it("findRelatedPassages sends text, excludePath and limit", async () => {
    invokeMock.mockResolvedValueOnce([]);

    await expect(findRelatedPassages("选中的文字", "notes/self.md", 12)).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("find_related_passages", {
      text: "选中的文字",
      excludePath: "notes/self.md",
      limit: 12,
    });
  });

  it("readDocumentPreview sends the camelCase path and fragment keys", async () => {
    const preview = {
      title: "目标文档",
      format: "markdown",
      excerpt: "首段",
      pdfPages: null,
      indexStatus: "ready",
    };
    invokeMock.mockResolvedValueOnce(preview);

    await expect(readDocumentPreview("notes/a.md", "安装步骤")).resolves.toEqual(preview);
    expect(invokeMock).toHaveBeenCalledWith("read_document_preview", {
      relativePath: "notes/a.md",
      fragment: "安装步骤",
    });

    invokeMock.mockResolvedValueOnce(preview);
    await readDocumentPreview("notes/a.md", null);
    expect(invokeMock).toHaveBeenLastCalledWith("read_document_preview", {
      relativePath: "notes/a.md",
      fragment: null,
    });
  });
});

describe("collection IPC wrappers (snake_case commands, camelCase keys)", () => {
  it("covers all eight collection commands", async () => {
    invokeMock.mockResolvedValue(undefined);

    await listCollections();
    expect(invokeMock).toHaveBeenCalledWith("list_collections");

    await createCollection("col-1", "考研数学");
    expect(invokeMock).toHaveBeenCalledWith("create_collection", {
      id: "col-1",
      name: "考研数学",
    });

    await renameCollection("col-1", "数学一");
    expect(invokeMock).toHaveBeenCalledWith("rename_collection", {
      id: "col-1",
      name: "数学一",
    });

    await deleteCollection("col-1");
    expect(invokeMock).toHaveBeenCalledWith("delete_collection", { id: "col-1" });

    await listCollectionItems("col-1");
    expect(invokeMock).toHaveBeenCalledWith("list_collection_items", {
      collectionId: "col-1",
    });

    await addCollectionItem("col-1", "notes/a.md");
    expect(invokeMock).toHaveBeenCalledWith("add_collection_item", {
      collectionId: "col-1",
      relativePath: "notes/a.md",
    });

    await removeCollectionItem("col-1", "notes/a.md");
    expect(invokeMock).toHaveBeenCalledWith("remove_collection_item", {
      collectionId: "col-1",
      relativePath: "notes/a.md",
    });

    await reorderCollectionItems("col-1", ["b.md", "a.md"]);
    expect(invokeMock).toHaveBeenCalledWith("reorder_collection_items", {
      collectionId: "col-1",
      orderedPaths: ["b.md", "a.md"],
    });
  });
});
