import { describe, expect, it } from "vitest";
import type { Annotation, EpubDocument } from "./backend";
import { dryRunTextQuoteAnchors, flattenEpubDocumentText } from "./rebindDryRun";

function annotation(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    relativePath: "old/guide.md",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "quote",
    title: null,
    locator: { kind: "markdown", quote: "quote", prefix: "", suffix: "", headingId: null },
    sortIndex: "M|00000|00000000",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("dryRunTextQuoteAnchors (§5.6 C dry-run statistics)", () => {
  const targetText = "Intro paragraph.\n\nThe stable   quote survives edits.\nAnother line.";

  it("counts exact, normalized and fuzzy hits as anchorable", () => {
    const report = dryRunTextQuoteAnchors(
      [
        // Exact occurrence.
        annotation("exact", {
          locator: {
            kind: "markdown",
            quote: "Intro paragraph.",
            prefix: "",
            suffix: "",
            headingId: null,
          },
        }),
        // Whitespace-divergent occurrence (normalized step).
        annotation("normalized", {
          locator: {
            kind: "markdown",
            quote: "stable quote",
            prefix: "The ",
            suffix: " survives",
            headingId: null,
          },
        }),
        // One-character edit (fuzzy step; the dry run runs the loose chain).
        annotation("fuzzy", {
          locator: {
            kind: "markdown",
            quote: "Another lane.",
            prefix: "",
            suffix: "",
            headingId: null,
          },
        }),
        // Nowhere near the target text.
        annotation("missing", {
          locator: {
            kind: "markdown",
            quote: "completely unrelated content that never existed",
            prefix: "",
            suffix: "",
            headingId: null,
          },
        }),
      ],
      targetText,
    );
    expect(report).toEqual({ total: 4, anchorable: 3, skipped: 0 });
  });

  it("skips bookmarks: they carry no text quote to verify", () => {
    const report = dryRunTextQuoteAnchors(
      [
        annotation("bookmark", {
          kind: "bookmark",
          color: null,
          locator: {
            kind: "bookmark",
            target: { format: "markdown", headingId: null, scrollRatio: 0.5 },
          },
        }),
        annotation("exact", {
          locator: {
            kind: "markdown",
            quote: "Intro paragraph.",
            prefix: "",
            suffix: "",
            headingId: null,
          },
        }),
      ],
      targetText,
    );
    expect(report).toEqual({ total: 2, anchorable: 1, skipped: 1 });
  });

  it("reports zero anchorable against an empty target", () => {
    expect(dryRunTextQuoteAnchors([annotation("a")], "")).toEqual({
      total: 1,
      anchorable: 0,
      skipped: 0,
    });
  });
});

describe("flattenEpubDocumentText", () => {
  it("flattens chapters, nested blocks and inline content", () => {
    const document: EpubDocument = {
      title: "Book",
      assets: [],
      notes: [],
      chapters: [
        {
          id: "one",
          title: "第一章",
          level: 1,
          blocks: [
            {
              kind: "paragraph",
              content: [
                { kind: "text", text: "Hello ", bold: false, italic: false, strike: false, code: false },
                {
                  kind: "link",
                  content: [
                    { kind: "text", text: "world", bold: false, italic: false, strike: false, code: false },
                  ],
                  target: { kind: "anchor", value: "#a" },
                },
              ],
            },
            {
              kind: "blockQuote",
              blocks: [
                {
                  kind: "paragraph",
                  content: [
                    { kind: "text", text: "quoted", bold: false, italic: false, strike: false, code: false },
                  ],
                },
              ],
            },
            { kind: "codeBlock", language: "rust", text: "fn main() {}" },
          ],
        },
      ],
    };
    const text = flattenEpubDocumentText(document);
    expect(text).toContain("第一章");
    expect(text).toContain("Hello world");
    expect(text).toContain("quoted");
    expect(text).toContain("fn main() {}");
  });
});
