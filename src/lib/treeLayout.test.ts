// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { DocumentInfo } from "./backend";
import { buildDocumentTree, type DocumentTreeNode } from "./tree";
import {
  TREE_LAYOUT_ROOT,
  TREE_LAYOUT_STORAGE_KEY,
  TREE_LAYOUT_VERSION,
  applyFolderLayout,
  buildLaidOutDocumentTree,
  folderHasCustomLayout,
  isPinnedInLayout,
  layoutNodeKey,
  moveSibling,
  pinNode,
  readTreeLayout,
  reconcileTreeLayout,
  resetFolderLayout,
  sanitizeFolderLayout,
  unpinNode,
  writeTreeLayout,
} from "./treeLayout";

function document(relativePath: string, title = ""): DocumentInfo {
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

function keys(nodes: DocumentTreeNode[]): string[] {
  return nodes.map(layoutNodeKey);
}

function names(nodes: DocumentTreeNode[]): string[] {
  return nodes.map((node) => node.name);
}

afterEach(() => {
  localStorage.clear();
});

describe("pinNode / unpinNode", () => {
  const tree = buildDocumentTree([
    document("c.md", "c"),
    document("a.md", "a"),
    document("b.md", "b"),
  ]);

  it("inserts a newly pinned node at the front of the pin segment", () => {
    const once = pinNode({}, TREE_LAYOUT_ROOT, "b.md");
    const twice = pinNode(once, TREE_LAYOUT_ROOT, "c.md");
    expect(twice[TREE_LAYOUT_ROOT]?.pinned).toEqual(["c.md", "b.md"]);

    const laid = applyFolderLayout(tree, twice);
    expect(names(laid)).toEqual(["c", "b", "a"]);
  });

  it("is a no-op when the node is already pinned", () => {
    const layout = pinNode({}, TREE_LAYOUT_ROOT, "b.md");
    expect(pinNode(layout, TREE_LAYOUT_ROOT, "b.md")).toBe(layout);
  });

  it("returns an unpinned node to default collator order when order is null", () => {
    const layout = pinNode({}, TREE_LAYOUT_ROOT, "b.md");
    const next = unpinNode(layout, TREE_LAYOUT_ROOT, "b.md", tree);
    expect(next).toEqual({});
    expect(names(applyFolderLayout(tree, next))).toEqual(["a", "b", "c"]);
  });

  it("inserts an unpinned node into a custom order by default sort", () => {
    const withOrder = {
      [TREE_LAYOUT_ROOT]: { pinned: ["b.md"], order: ["c.md", "a.md"] },
    };
    const next = unpinNode(withOrder, TREE_LAYOUT_ROOT, "b.md", tree);
    expect(next[TREE_LAYOUT_ROOT]?.pinned).toEqual([]);
    expect(next[TREE_LAYOUT_ROOT]?.order).toEqual(["b.md", "c.md", "a.md"]);
  });
});

describe("moveSibling", () => {
  const tree = buildDocumentTree([
    document("a.md", "a"),
    document("b.md", "b"),
    document("c.md", "c"),
  ]);

  it("reorders within the unpinned segment and snapshots default order on first drag", () => {
    const moved = moveSibling({}, TREE_LAYOUT_ROOT, "c.md", 0, tree);
    expect(moved?.[TREE_LAYOUT_ROOT]?.order).toEqual(["c.md", "a.md", "b.md"]);
    expect(names(applyFolderLayout(tree, moved ?? {}))).toEqual(["c", "a", "b"]);
  });

  it("reorders within the pinned segment only", () => {
    const layout = pinNode(pinNode({}, TREE_LAYOUT_ROOT, "a.md"), TREE_LAYOUT_ROOT, "b.md");
    // pinned is [b, a], unpinned [c]
    const laid = applyFolderLayout(tree, layout);
    const moved = moveSibling(layout, TREE_LAYOUT_ROOT, "b.md", 1, laid);
    expect(moved?.[TREE_LAYOUT_ROOT]?.pinned).toEqual(["a.md", "b.md"]);
  });

  it("rejects a move when the node is not among the provided siblings", () => {
    expect(moveSibling({}, TREE_LAYOUT_ROOT, "missing.md", 0, tree)).toBeNull();
  });

  it("returns the same layout when the visual order does not change", () => {
    const layout = { [TREE_LAYOUT_ROOT]: { pinned: [], order: ["a.md", "b.md", "c.md"] } };
    const result = moveSibling(layout, TREE_LAYOUT_ROOT, "b.md", 1, tree);
    expect(result).toBe(layout);
  });
});

describe("applyFolderLayout mixing folders and files", () => {
  it("keeps folders first until a custom unpinned order mixes them", () => {
    const tree = buildDocumentTree([
      document("notes/一.md", "一"),
      document("z.md", "z"),
      document("a.md", "a"),
    ]);
    expect(keys(tree)).toEqual(["notes", "a.md", "z.md"]);

    const moved = moveSibling({}, TREE_LAYOUT_ROOT, "z.md", 0, tree);
    expect(keys(applyFolderLayout(tree, moved ?? {}))).toEqual(["z.md", "notes", "a.md"]);
  });

  it("pins a folder above sibling documents without leaving its parent", () => {
    const tree = buildDocumentTree([
      document("notes/一.md", "一"),
      document("a.md", "a"),
    ]);
    const layout = pinNode({}, TREE_LAYOUT_ROOT, "notes");
    expect(keys(applyFolderLayout(tree, layout))).toEqual(["notes", "a.md"]);
    expect(isPinnedInLayout(layout, TREE_LAYOUT_ROOT, "notes")).toBe(true);
  });
});

describe("reconcileTreeLayout", () => {
  it("drops deleted paths and inserts newcomers into a custom order by default sort", () => {
    const previous = buildDocumentTree([
      document("a.md", "a"),
      document("b.md", "b"),
      document("gone.md", "gone"),
    ]);
    let layout = moveSibling({}, TREE_LAYOUT_ROOT, "b.md", 0, previous) ?? {};
    layout = pinNode(layout, TREE_LAYOUT_ROOT, "gone.md");

    const nextTree = buildDocumentTree([
      document("a.md", "a"),
      document("b.md", "b"),
      document("c.md", "c"),
    ]);
    const reconciled = reconcileTreeLayout(layout, nextTree);
    expect(reconciled[TREE_LAYOUT_ROOT]?.pinned).toEqual([]);
    expect(reconciled[TREE_LAYOUT_ROOT]?.order).toEqual(["b.md", "a.md", "c.md"]);
    expect(names(applyFolderLayout(nextTree, reconciled))).toEqual(["b", "a", "c"]);
  });

  it("does not touch a nested folder when reconciling the parent", () => {
    const tree = buildDocumentTree([
      document("notes/一.md", "一"),
      document("notes/二.md", "二"),
      document("a.md", "a"),
    ]);
    const notes = tree.find((node) => node.kind === "directory" && node.path === "notes");
    if (!notes || notes.kind !== "directory") throw new Error("expected notes");
    const firstKey = layoutNodeKey(notes.children[0]);
    const nested =
      moveSibling({}, "notes", firstKey, notes.children.length - 1, notes.children) ?? {};
    const reconciled = reconcileTreeLayout(nested, tree);
    expect(reconciled.notes?.order).toEqual(notes.children.map(layoutNodeKey).reverse());
    expect(reconciled[TREE_LAYOUT_ROOT]).toBeUndefined();
  });
});

describe("resetFolderLayout", () => {
  it("clears one parent and leaves nested layouts alone", () => {
    const layout = {
      [TREE_LAYOUT_ROOT]: { pinned: ["a.md"], order: null },
      notes: { pinned: [], order: ["二.md", "一.md"] },
    };
    const next = resetFolderLayout(layout, TREE_LAYOUT_ROOT);
    expect(next[TREE_LAYOUT_ROOT]).toBeUndefined();
    expect(next.notes?.order).toEqual(["二.md", "一.md"]);
    expect(folderHasCustomLayout(next, TREE_LAYOUT_ROOT)).toBe(false);
    expect(folderHasCustomLayout(next, "notes")).toBe(true);
  });
});

describe("sanitizeFolderLayout and storage", () => {
  it("drops empty, traversal, and duplicate keys", () => {
    expect(
      sanitizeFolderLayout({
        pinned: ["a.md", "a.md", "../x.md", ""],
        order: ["b.md", "a.md", 12, "notes/../secret.md"],
      }),
    ).toEqual({ pinned: ["a.md"], order: ["b.md"] });
    expect(sanitizeFolderLayout({ pinned: [], order: null })).toBeNull();
    expect(sanitizeFolderLayout({ pinned: "a.md" })).toBeNull();
  });

  it("round-trips a library layout and ignores a bad envelope", () => {
    writeTreeLayout("D:/Lib", { [TREE_LAYOUT_ROOT]: { pinned: ["a.md"], order: ["b.md"] } });
    expect(readTreeLayout("d:\\lib\\")).toEqual({
      [TREE_LAYOUT_ROOT]: { pinned: ["a.md"], order: ["b.md"] },
    });

    localStorage.setItem(TREE_LAYOUT_STORAGE_KEY, "{not json");
    expect(readTreeLayout("D:/Lib")).toEqual({});

    localStorage.setItem(
      TREE_LAYOUT_STORAGE_KEY,
      JSON.stringify({ version: TREE_LAYOUT_VERSION + 1, libraries: { "D:/Lib": {} } }),
    );
    expect(readTreeLayout("D:/Lib")).toEqual({});
  });
});

describe("buildLaidOutDocumentTree", () => {
  it("applies layout after the default collator build", () => {
    const documents = [document("a.md", "a"), document("b.md", "b")];
    const layout = { [TREE_LAYOUT_ROOT]: { pinned: ["b.md"] as string[], order: null } };
    expect(keys(buildLaidOutDocumentTree(documents, layout))).toEqual(["b.md", "a.md"]);
  });
});
