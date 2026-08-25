// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Annotation } from "../lib/backend";
import { paintMarkdownAnnotations } from "./AnnotatedMarkdown";

function markdownMark(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann-md-1",
    relativePath: "guide.md",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "marked phrase",
    title: "marked phrase",
    locator: {
      kind: "markdown",
      quote: "marked phrase",
      prefix: "the ",
      suffix: " remains",
      headingId: "intro",
      start: 10,
      end: 23,
    },
    sortIndex: "M|00000|00000010",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("paintMarkdownAnnotations honesty", () => {
  it("reports exact when the live quote still matches", () => {
    const root = document.createElement("div");
    root.className = "markdown-body";
    root.innerHTML = `<h2 id="intro">Intro</h2><p>the marked phrase remains here</p>`;
    const painted = paintMarkdownAnnotations(root, [markdownMark()]);
    expect(painted.broken).toEqual([]);
    expect(painted.approximate).toEqual([]);
    expect(painted.resolutions).toEqual([
      { id: "ann-md-1", resolution: { status: "exact", method: "exact" } },
    ]);
  });

  it("reports detached heading fallback when the quote is gone but the heading remains", () => {
    const root = document.createElement("div");
    root.className = "markdown-body";
    root.innerHTML = `<h2 id="intro">Intro</h2><p>unrelated body</p>`;
    const painted = paintMarkdownAnnotations(root, [markdownMark()]);
    expect(painted.broken).toEqual(["ann-md-1"]);
    expect(painted.resolutions).toEqual([
      { id: "ann-md-1", resolution: { status: "detached", fallback: "heading" } },
    ]);
    expect(root.querySelector("[data-annotation-id]")).toBeNull();
  });

  it("reports detached without a heading fallback when that heading is gone too", () => {
    const root = document.createElement("div");
    root.className = "markdown-body";
    root.innerHTML = `<p>unrelated body</p>`;
    const painted = paintMarkdownAnnotations(root, [markdownMark()]);
    expect(painted.broken).toEqual(["ann-md-1"]);
    expect(painted.resolutions).toEqual([
      { id: "ann-md-1", resolution: { status: "detached", fallback: null } },
    ]);
  });
});
