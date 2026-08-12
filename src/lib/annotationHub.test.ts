import { describe, expect, it } from "vitest";
import type { Annotation } from "./backend";
import {
  ANNOTATION_GROUP_PREVIEW_COUNT,
  groupAnnotationsByDocument,
  previewGroupAnnotations,
} from "./annotationHub";

function makeAnnotation(
  id: string,
  relativePath: string,
  overrides: Partial<Annotation> = {},
): Annotation {
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
      prefix: "",
      suffix: "",
      headingId: null,
    },
    sortIndex: "M|00000|00000100",
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null,
    ...overrides,
  };
}

describe("groupAnnotationsByDocument", () => {
  it("sorts present groups by path and orders entries by position", () => {
    const groups = groupAnnotationsByDocument(
      [
        makeAnnotation("b-late", "b.md", { sortIndex: "M|00000|00000900" }),
        makeAnnotation("a-1", "a.md", { sortIndex: "M|00000|00000200" }),
        makeAnnotation("b-early", "b.md", { sortIndex: "M|00000|00000100" }),
        makeAnnotation("a-2", "a.md", { sortIndex: "M|00000|00000050" }),
      ],
      new Set(["a.md", "b.md"]),
    );
    expect(groups.map((group) => group.relativePath)).toEqual(["a.md", "b.md"]);
    expect(groups.every((group) => !group.missing)).toBe(true);
    expect(groups[0].annotations.map((item) => item.id)).toEqual(["a-2", "a-1"]);
    expect(groups[1].annotations.map((item) => item.id)).toEqual(["b-early", "b-late"]);
  });

  it("breaks position ties by createdAt, then id", () => {
    const groups = groupAnnotationsByDocument(
      [
        makeAnnotation("tie-b", "a.md", { createdAt: 200 }),
        makeAnnotation("tie-a", "a.md", { createdAt: 100 }),
        makeAnnotation("tie-a0", "a.md", { createdAt: 100 }),
      ],
      new Set(["a.md"]),
    );
    expect(groups[0].annotations.map((item) => item.id)).toEqual(["tie-a", "tie-a0", "tie-b"]);
  });

  it("puts missing-document groups last, flagged, in path order", () => {
    const groups = groupAnnotationsByDocument(
      [
        makeAnnotation("gone-z", "z-gone.md"),
        makeAnnotation("present", "m.md"),
        makeAnnotation("gone-a", "a-gone.md"),
      ],
      new Set(["m.md"]),
    );
    expect(groups.map((group) => [group.relativePath, group.missing])).toEqual([
      ["m.md", false],
      ["a-gone.md", true],
      ["z-gone.md", true],
    ]);
  });

  it("treats every group as missing when the document set is empty", () => {
    const groups = groupAnnotationsByDocument(
      [makeAnnotation("only", "a.md")],
      new Set<string>(),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].missing).toBe(true);
  });

  it("drops tombstones and returns no empty groups", () => {
    const groups = groupAnnotationsByDocument(
      [
        makeAnnotation("live", "a.md"),
        makeAnnotation("dead", "a.md", { deletedAt: 5_000 }),
        makeAnnotation("all-dead", "b.md", { deletedAt: 5_000 }),
      ],
      new Set(["a.md", "b.md"]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].annotations.map((item) => item.id)).toEqual(["live"]);
  });

  it("returns an empty list for no annotations", () => {
    expect(groupAnnotationsByDocument([], new Set(["a.md"]))).toEqual([]);
  });
});

describe("previewGroupAnnotations", () => {
  const items = Array.from({ length: 25 }, (_, index) =>
    makeAnnotation(`ann-${String(index).padStart(2, "0")}`, "a.md"),
  );

  it("shows the first 20 entries and counts the remainder by default", () => {
    const preview = previewGroupAnnotations(items);
    expect(preview.visible).toHaveLength(ANNOTATION_GROUP_PREVIEW_COUNT);
    expect(preview.visible[0].id).toBe("ann-00");
    expect(preview.visible[19].id).toBe("ann-19");
    expect(preview.hiddenCount).toBe(5);
  });

  it("shows everything when the group fits the limit", () => {
    const preview = previewGroupAnnotations(items.slice(0, 20));
    expect(preview.visible).toHaveLength(20);
    expect(preview.hiddenCount).toBe(0);
  });

  it("honours a custom limit", () => {
    const preview = previewGroupAnnotations(items, 3);
    expect(preview.visible.map((item) => item.id)).toEqual(["ann-00", "ann-01", "ann-02"]);
    expect(preview.hiddenCount).toBe(22);
  });
});
