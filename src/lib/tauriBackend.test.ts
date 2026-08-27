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

describe("v6 annotation IPC wrappers", () => {
  it("sends camelCase keys for every new command", async () => {
    invokeMock.mockResolvedValue({});
    const draft = {
      id: "ex-1",
      relativePath: "notes/a.md",
      sourceText: "hello",
      anchor: {
        format: "markdown" as const,
        quote: { exact: "hello", prefix: "", suffix: "" },
        headingId: null,
      },
      appearance: { style: "highlight" as const, tone: "sand" as const },
      sortIndex: "M|00000|00000000",
    };

    const { clearDocumentAnnotations, createExcerpt, createReadingPlace, deleteAnnotationEntry, deleteReflection, listDocumentAnnotations, restoreAnnotationEntry, restoreDocumentAnnotations, setReviewEnrollment, updateExcerptAppearance, upsertReflection } = await import("./tauriBackend");

    await listDocumentAnnotations("notes/a.md");
    expect(invokeMock).toHaveBeenCalledWith("list_document_annotations", {
      relativePath: "notes/a.md",
    });

    await createExcerpt(draft, null);
    expect(invokeMock).toHaveBeenCalledWith("create_excerpt", { draft, reflectionBody: null });

    const snapshot = {
      excerpts: [],
      places: [],
      reflections: [],
      reviewEnrollments: [],
    };
    await clearDocumentAnnotations("notes/a.md");
    expect(invokeMock).toHaveBeenCalledWith("clear_document_annotations", {
      relativePath: "notes/a.md",
    });
    await restoreDocumentAnnotations("notes/a.md", snapshot);
    expect(invokeMock).toHaveBeenCalledWith("restore_document_annotations", {
      relativePath: "notes/a.md",
      snapshot,
    });

    await updateExcerptAppearance("ex-1", { style: "underline", tone: "sage" });
    expect(invokeMock).toHaveBeenCalledWith("update_excerpt_appearance", {
      id: "ex-1",
      appearance: { style: "underline", tone: "sage" },
    });

    await createReadingPlace({
      id: "pl-1",
      relativePath: "notes/a.md",
      title: "here",
      target: { format: "markdown", headingId: null, scrollRatio: 0.2 },
      sortIndex: "M|00000|20000000",
    });
    expect(invokeMock).toHaveBeenCalledWith("create_reading_place", {
      draft: {
        id: "pl-1",
        relativePath: "notes/a.md",
        title: "here",
        target: { format: "markdown", headingId: null, scrollRatio: 0.2 },
        sortIndex: "M|00000|20000000",
      },
    });

    await upsertReflection("ex-1", "excerpt", "感悟");
    expect(invokeMock).toHaveBeenCalledWith("upsert_reflection", {
      entryId: "ex-1",
      entryKind: "excerpt",
      body: "感悟",
    });

    await deleteReflection("ex-1");
    expect(invokeMock).toHaveBeenCalledWith("delete_reflection", { entryId: "ex-1" });

    await deleteAnnotationEntry("ex-1", "excerpt");
    expect(invokeMock).toHaveBeenCalledWith("delete_annotation_entry", {
      id: "ex-1",
      entryKind: "excerpt",
    });

    await restoreAnnotationEntry("ex-1", "excerpt");
    expect(invokeMock).toHaveBeenCalledWith("restore_annotation_entry", {
      id: "ex-1",
      entryKind: "excerpt",
    });

    await setReviewEnrollment("ex-1", true);
    expect(invokeMock).toHaveBeenCalledWith("set_review_enrollment", {
      excerptId: "ex-1",
      enabled: true,
    });

    const { recordExcerptReviewOutcome, searchAnnotationEntries } = await import("./tauriBackend");
    await searchAnnotationEntries("hello", 50);
    expect(invokeMock).toHaveBeenCalledWith("search_annotation_entries", {
      query: "hello",
      limit: 50,
    });
    await recordExcerptReviewOutcome("ex-1", {
      box: 1,
      dueAt: 2,
      lastReviewedAt: 1,
      totalReviews: 1,
      suspended: false,
    });
    expect(invokeMock).toHaveBeenCalledWith("record_excerpt_review_outcome", {
      annotationId: "ex-1",
      boxLevel: 1,
      dueAt: 2,
      lastReviewedAt: 1,
      suspended: false,
    });
  });
});

describe("IPC command name parity with Rust generate_handler", () => {
  it("keeps tauriBackend invoke names equal to lib.rs handler names", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = resolve(import.meta.dirname, "../..");
    const rust = await readFile(resolve(root, "src-tauri/src/lib.rs"), "utf8");
    const ts = await readFile(resolve(root, "src/lib/tauriBackend.ts"), "utf8");

    const handlerBlock = rust.match(/tauri::generate_handler!\s*\[\s*([\s\S]*?)\]/);
    expect(handlerBlock).not.toBeNull();
    const rustCommands = [
      ...(handlerBlock?.[1].matchAll(/^\s*([a-z][a-z0-9_]*)\s*,?\s*(?:\/\/.*)?$/gm) ?? []),
    ].map((match) => match[1]);
    const tsCommands = [...ts.matchAll(/invoke\(\s*"([a-z][a-z0-9_]*)"/g)].map(
      (match) => match[1],
    );

    expect([...new Set(tsCommands)].sort()).toEqual([...new Set(rustCommands)].sort());
    expect(new Set(tsCommands).size).toBe(56);
  });
});
