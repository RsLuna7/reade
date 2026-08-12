// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Annotation } from "./backend";
import {
  applyRelocatedAnnotation,
  captureRelocatedSelection,
  findRelocationRange,
  isRelocatableAnnotation,
} from "./annotationRelocate";

function markdownAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann-1",
    relativePath: "guide.md",
    kind: "highlight",
    color: "yellow",
    note: "keep me",
    selectedText: "old quote",
    title: "old quote",
    locator: {
      kind: "markdown",
      quote: "old quote",
      prefix: "before ",
      suffix: " after",
      headingId: null,
      start: 10,
      end: 19,
    },
    sortIndex: "M|00000|00000010",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("isRelocatableAnnotation", () => {
  it("accepts quote-bearing marks and rejects bookmarks", () => {
    expect(isRelocatableAnnotation(markdownAnnotation())).toBe(true);
    expect(
      isRelocatableAnnotation(
        markdownAnnotation({
          kind: "bookmark",
          color: null,
          locator: {
            kind: "bookmark",
            target: { format: "markdown", headingId: null, scrollRatio: 0 },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("findRelocationRange", () => {
  it("finds an edited quote through the loose chain and reports the method", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>The document body changed but the marked pasage survives here.</p>";
    // One-character typo relative to the live text: only fuzzy can hit.
    const match = findRelocationRange([root], {
      kind: "markdown",
      quote: "marked passage",
      prefix: "the ",
      suffix: " survives",
      headingId: null,
    });
    expect(match).not.toBeNull();
    expect(match!.method).toBe("fuzzy");
    expect(match!.range.toString()).toBe("marked pasage");
  });

  it("returns null when nothing similar exists in any root", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>entirely unrelated content</p>";
    const match = findRelocationRange([root], {
      kind: "markdown",
      quote: "the quick brown fox jumps over the lazy dog",
      prefix: "",
      suffix: "",
      headingId: null,
    });
    expect(match).toBeNull();
  });

  it("tries roots in order and resolves in the first matching one", () => {
    const empty = document.createElement("div");
    empty.innerHTML = "<p>nothing here</p>";
    const hit = document.createElement("div");
    hit.innerHTML = "<p>alpha beta gamma</p>";
    const match = findRelocationRange([empty, hit], {
      kind: "markdown",
      quote: "beta",
      prefix: "alpha ",
      suffix: " gamma",
      headingId: null,
    });
    expect(match).not.toBeNull();
    expect(match!.root).toBe(hit);
    expect(match!.method).toBe("exact");
  });
});

describe("captureRelocatedSelection", () => {
  it("re-collects the full markdown locator from a resolved range", () => {
    const readerRoot = document.createElement("div");
    readerRoot.innerHTML =
      '<div class="markdown-body"><h2 id="section">Section</h2><p>fresh paragraph with the moved quote inside</p></div>';
    const markdownBody = readerRoot.querySelector<HTMLElement>(".markdown-body")!;
    const paragraphText = markdownBody.querySelector("p")!.firstChild as Text;
    const range = document.createRange();
    const start = paragraphText.data.indexOf("moved quote");
    range.setStart(paragraphText, start);
    range.setEnd(paragraphText, start + "moved quote".length);
    range.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    const captured = captureRelocatedSelection({
      readerRoot,
      kind: "markdown",
      range,
    });
    expect(captured).not.toBeNull();
    expect(captured!.text).toBe("moved quote");
    expect(captured!.locator).toMatchObject({
      kind: "markdown",
      quote: "moved quote",
      headingId: "section",
    });
    if (captured!.locator.kind !== "markdown") throw new Error("expected markdown locator");
    // Full re-collection: fresh context and a fresh position hint.
    expect(captured!.locator.prefix.endsWith("the ")).toBe(true);
    expect(captured!.locator.suffix.startsWith(" inside")).toBe(true);
    expect(captured!.locator.start).toBeGreaterThan(0);
    expect(captured!.locator.end).toBe(captured!.locator.start! + "moved quote".length);
  });
});

describe("applyRelocatedAnnotation", () => {
  const captured = {
    text: "new quote",
    locator: {
      kind: "markdown" as const,
      quote: "new quote",
      prefix: "fresh ",
      suffix: " context",
      headingId: "h1",
      start: 4_242,
      end: 4_251,
    },
    rect: { left: 0, top: 0, width: 0, height: 0 },
  };

  it("rewrites locator, selectedText and sortIndex only after confirmation", () => {
    const original = markdownAnnotation();
    const updated = applyRelocatedAnnotation(original, captured, 9_000);
    // The original object is untouched (cancel keeps it byte-for-byte).
    expect(original.locator).toMatchObject({ quote: "old quote", start: 10 });
    expect(updated.locator).toEqual(captured.locator);
    expect(updated.selectedText).toBe("new quote");
    expect(updated.sortIndex).toBe("M|00000|00004242");
    expect(updated.updatedAt).toBe(9_000);
    expect(updated.id).toBe(original.id);
    expect(updated.note).toBe("keep me");
  });

  it("refreshes an auto-derived title but preserves a user-edited one", () => {
    const autoTitled = applyRelocatedAnnotation(markdownAnnotation(), captured, 9_000);
    expect(autoTitled.title).toBe("new quote");

    const userTitled = applyRelocatedAnnotation(
      markdownAnnotation({ title: "我的重点" }),
      captured,
      9_000,
    );
    expect(userTitled.title).toBe("我的重点");
  });
});
