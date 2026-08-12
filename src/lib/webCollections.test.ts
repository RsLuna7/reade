import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import type { Annotation } from "./backend";
import {
  listWebAnnotations,
  rebindWebDocumentAnnotations,
  resetWebAnnotationStoreForTests,
  upsertWebAnnotation,
} from "./webAnnotations";
import {
  addWebCollectionItem,
  createWebCollection,
  deleteWebCollection,
  listWebCollectionItems,
  listWebCollections,
  removeWebCollectionItem,
  renameWebCollection,
  reorderWebCollectionItems,
} from "./webCollections";

const DB_NAME = "reade-annotations";

function makeAnnotation(id: string, relativePath: string): Annotation {
  return {
    id,
    relativePath,
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "hello world",
    title: null,
    locator: {
      kind: "markdown",
      quote: "hello world",
      prefix: "say ",
      suffix: " today",
      headingId: null,
    },
    sortIndex: "M|00000|00000000",
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null,
  };
}

/** Hand-builds the pre-collections v4 database shape. */
function buildV4Database(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 4);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore("annotations", { keyPath: "id" });
      store.createIndex("relativePath", "relativePath", { unique: false });
      db.createObjectStore("documents", { keyPath: "relativePath" });
      db.createObjectStore("annotationReviews", { keyPath: "annotationId" });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("annotations", "readwrite");
      tx.objectStore("annotations").put(makeAnnotation("ann-v4", "notes/a.md"));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error ?? new Error("cannot seed v4 database"));
    };
    request.onerror = () => reject(request.error ?? new Error("cannot build v4 database"));
  });
}

function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("cannot open raw db"));
  });
}

beforeEach(() => {
  resetWebAnnotationStoreForTests();
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = new IDBFactory();
});

describe("v4 → v5 upgrade", () => {
  it("adds the collection stores while keeping v4 data readable", async () => {
    await buildV4Database();

    // Any module call opens the database at version 5 and runs the step.
    const annotations = await listWebAnnotations(null);
    expect(annotations.map((annotation) => annotation.id)).toEqual(["ann-v4"]);

    const collection = await createWebCollection("col-1", "升级后可写", 1_000);
    expect(collection).toEqual({
      id: "col-1",
      name: "升级后可写",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    resetWebAnnotationStoreForTests();
    const db = await openRaw();
    expect(db.version).toBe(5);
    expect(Array.from(db.objectStoreNames).sort()).toEqual([
      "annotationReviews",
      "annotations",
      "collectionItems",
      "collections",
      "documents",
    ]);
    db.close();
  });
});

describe("collection CRUD", () => {
  const present = new Set(["a.md", "b.md", "sub/c.md"]);

  it("validates ids, names, presence and duplicate ids", async () => {
    await expect(createWebCollection("bad id!", "名单")).rejects.toThrow();
    await expect(createWebCollection("x".repeat(65), "名单")).rejects.toThrow();
    await expect(createWebCollection("col-1", "")).rejects.toThrow();
    await expect(createWebCollection("col-1", "名".repeat(101))).rejects.toThrow();

    await createWebCollection("col-1", " 考研数学 ", 1_000);
    await expect(createWebCollection("col-1", "重复")).rejects.toThrow(
      "Collection id already exists",
    );

    await expect(renameWebCollection("col-missing", "新名")).rejects.toThrow(
      "Collection was not found",
    );
    await expect(deleteWebCollection("col-missing")).rejects.toThrow();
    await expect(listWebCollectionItems("col-missing", present)).rejects.toThrow();

    await expect(
      addWebCollectionItem("col-1", "../outside.md", present),
    ).rejects.toThrow();
    await expect(addWebCollectionItem("col-1", "missing.md", present)).rejects.toThrow(
      "Document is not in the current library",
    );
    await expect(
      addWebCollectionItem("col-missing", "a.md", present),
    ).rejects.toThrow("Collection was not found");
  });

  it("appends positions, stays idempotent and reorders with the exact-set gate", async () => {
    await createWebCollection("col-1", "清单", 1_000);
    const first = await addWebCollectionItem("col-1", "a.md", present, 2_000);
    expect(first).toEqual({ relativePath: "a.md", position: 0, addedAt: 2_000, present: true });
    await addWebCollectionItem("col-1", "b.md", present, 2_100);
    await addWebCollectionItem("col-1", "sub/c.md", present, 2_200);

    const repeat = await addWebCollectionItem("col-1", "a.md", present, 9_000);
    expect(repeat).toEqual({ relativePath: "a.md", position: 0, addedAt: 2_000, present: true });
    const summariesAfterRepeat = await listWebCollections(present);
    expect(summariesAfterRepeat[0].updatedAt).toBe(2_200);

    await expect(reorderWebCollectionItems("col-1", ["a.md", "b.md"])).rejects.toThrow();
    await expect(
      reorderWebCollectionItems("col-1", ["a.md", "b.md", "sub/c.md", "d.md"]),
    ).rejects.toThrow();
    await expect(
      reorderWebCollectionItems("col-1", ["a.md", "a.md", "b.md"]),
    ).rejects.toThrow();
    await reorderWebCollectionItems("col-1", ["sub/c.md", "a.md", "b.md"], 3_000);
    const ordered = await listWebCollectionItems("col-1", present);
    expect(ordered.map((item) => [item.relativePath, item.position])).toEqual([
      ["sub/c.md", 0],
      ["a.md", 1],
      ["b.md", 2],
    ]);

    await expect(removeWebCollectionItem("col-1", "missing.md")).rejects.toThrow(
      "Collection item was not found",
    );
    await removeWebCollectionItem("col-1", "b.md", 4_000);
    expect(await listWebCollectionItems("col-1", present)).toHaveLength(2);

    // presentCount reflects the passed snapshot, itemCount the stored rows.
    const summaries = await listWebCollections(new Set(["a.md"]));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ itemCount: 2, presentCount: 1, updatedAt: 4_000 });
  });

  it("deletes a collection without touching annotations", async () => {
    await upsertWebAnnotation(makeAnnotation("ann-keep", "a.md"));
    await createWebCollection("col-del", "要删除", 1_000);
    await addWebCollectionItem("col-del", "a.md", present, 2_000);

    await deleteWebCollection("col-del");

    expect(await listWebCollections(present)).toEqual([]);
    await expect(listWebCollectionItems("col-del", present)).rejects.toThrow();
    // The direct assertion behind "deleting a list never deletes documents".
    expect((await listWebAnnotations("a.md")).map((annotation) => annotation.id)).toEqual([
      "ann-keep",
    ]);
  });

  it("migrates membership through the rebind transaction (CO-D3)", async () => {
    const rebindPresent = new Set(["old.md", "other.md", "moved/new.md"]);
    await upsertWebAnnotation(makeAnnotation("ann-old", "old.md"));
    await createWebCollection("col-a", "清单甲", 1_000);
    await addWebCollectionItem("col-a", "old.md", rebindPresent, 2_000);
    await addWebCollectionItem("col-a", "other.md", rebindPresent, 2_100);
    await createWebCollection("col-b", "清单乙", 1_100);
    await addWebCollectionItem("col-b", "moved/new.md", rebindPresent, 2_200);
    await addWebCollectionItem("col-b", "old.md", rebindPresent, 2_300);

    await expect(rebindWebDocumentAnnotations("old.md", "moved/new.md")).resolves.toBe(1);

    const colA = await listWebCollectionItems("col-a", rebindPresent);
    expect(colA.map((item) => [item.relativePath, item.position])).toEqual([
      ["moved/new.md", 0],
      ["other.md", 1],
    ]);
    // col-b already contained the target: the stale row is gone, the
    // existing row is kept, nothing duplicates.
    const colB = await listWebCollectionItems("col-b", rebindPresent);
    expect(colB).toHaveLength(1);
    expect(colB[0]).toMatchObject({ relativePath: "moved/new.md", addedAt: 2_200 });
  });
});

describe("two-end contract fixture CC01..CC13", () => {
  // Replayed by `collections_contract_fixture_matches_the_web_snapshots`
  // in src-tauri/src/user_store.rs; both sides must produce these exact
  // snapshots. Keep the numbering in sync.
  it("produces the pinned snapshots after the shared operation sequence", async () => {
    const presentAll = new Set([
      "math/真题.pdf",
      "notes/错题.md",
      "notes/公式.md",
      "papers/robot.epub",
    ]);
    const presentFinal = new Set(["math/真题.pdf", "notes/错题.md", "papers/robot.epub"]);

    await createWebCollection("col-a", " 考研数学 ", 1_000); // CC01
    await createWebCollection("col-b", "组会论文", 2_000); // CC02
    await addWebCollectionItem("col-a", "math/真题.pdf", presentAll, 3_000); // CC03
    await addWebCollectionItem("col-a", "notes/错题.md", presentAll, 4_000); // CC04
    await addWebCollectionItem("col-a", "notes/公式.md", presentAll, 5_000); // CC05
    await addWebCollectionItem("col-b", "papers/robot.epub", presentAll, 6_000); // CC06
    await addWebCollectionItem("col-b", "notes/错题.md", presentAll, 7_000); // CC07
    // CC08: idempotent re-add leaves every timestamp alone.
    const repeat = await addWebCollectionItem("col-a", "notes/错题.md", presentAll, 8_000);
    expect([repeat.position, repeat.addedAt]).toEqual([1, 4_000]);
    // CC09: manual reorder of col-a.
    await reorderWebCollectionItems(
      "col-a",
      ["notes/公式.md", "math/真题.pdf", "notes/错题.md"],
      9_000,
    );
    await removeWebCollectionItem("col-b", "papers/robot.epub", 10_000); // CC10
    await deleteWebCollection("col-b"); // CC11

    // CC12: the summary snapshot.
    expect(await listWebCollections(presentFinal)).toEqual([
      {
        id: "col-a",
        name: "考研数学",
        createdAt: 1_000,
        updatedAt: 9_000,
        itemCount: 3,
        presentCount: 2,
      },
    ]);
    // CC13: the item snapshot.
    expect(await listWebCollectionItems("col-a", presentFinal)).toEqual([
      { relativePath: "notes/公式.md", position: 0, addedAt: 5_000, present: false },
      { relativePath: "math/真题.pdf", position: 1, addedAt: 3_000, present: true },
      { relativePath: "notes/错题.md", position: 2, addedAt: 4_000, present: true },
    ]);
    await expect(listWebCollectionItems("col-b", presentFinal)).rejects.toThrow();
  });
});
