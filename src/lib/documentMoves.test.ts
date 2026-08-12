import { describe, expect, it } from "vitest";
import {
  detectMovedDocumentCandidates,
  type DetectMovedDocumentsInput,
} from "./documentMoves";

function input(overrides: Partial<DetectMovedDocumentsInput>): DetectMovedDocumentsInput {
  return {
    presentPaths: [],
    currentHashes: new Map(),
    storedHashes: new Map(),
    liveAnnotationCounts: new Map(),
    ...overrides,
  };
}

describe("detectMovedDocumentCandidates", () => {
  it("reports nothing while the annotated path is still present", () => {
    const result = detectMovedDocumentCandidates(
      input({
        presentPaths: ["old.md"],
        currentHashes: new Map([["old.md", "ntxt:aaaa"]]),
        storedHashes: new Map([["old.md", "ntxt:aaaa"]]),
        liveAnnotationCounts: new Map([["old.md", 2]]),
      }),
    );
    expect(result).toEqual([]);
  });

  it("pairs a vanished annotated path with the single new path sharing its hash", () => {
    const result = detectMovedDocumentCandidates(
      input({
        presentPaths: ["moved/new.md", "other.md"],
        currentHashes: new Map([
          ["moved/new.md", "ntxt:aaaa"],
          ["other.md", "ntxt:bbbb"],
        ]),
        storedHashes: new Map([
          ["old.md", "ntxt:aaaa"],
          ["other.md", "ntxt:bbbb"],
        ]),
        liveAnnotationCounts: new Map([["old.md", 3]]),
      }),
    );
    expect(result).toEqual([
      { oldPath: "old.md", newPath: "moved/new.md", annotationCount: 3, ambiguous: false },
    ]);
  });

  it("flags every pairing ambiguous when one hash matches several new paths", () => {
    const result = detectMovedDocumentCandidates(
      input({
        presentPaths: ["copy/b.md", "copy/a.md"],
        currentHashes: new Map([
          ["copy/b.md", "ntxt:aaaa"],
          ["copy/a.md", "ntxt:aaaa"],
        ]),
        storedHashes: new Map([["old.md", "ntxt:aaaa"]]),
        liveAnnotationCounts: new Map([["old.md", 1]]),
      }),
    );
    expect(result).toEqual([
      { oldPath: "old.md", newPath: "copy/a.md", annotationCount: 1, ambiguous: true },
      { oldPath: "old.md", newPath: "copy/b.md", annotationCount: 1, ambiguous: true },
    ]);
  });

  it("flags pairings ambiguous when several vanished paths collapse onto one candidate", () => {
    const result = detectMovedDocumentCandidates(
      input({
        presentPaths: ["merged.md"],
        currentHashes: new Map([["merged.md", "ntxt:aaaa"]]),
        storedHashes: new Map([
          ["old-b.md", "ntxt:aaaa"],
          ["old-a.md", "ntxt:aaaa"],
        ]),
        liveAnnotationCounts: new Map([
          ["old-b.md", 2],
          ["old-a.md", 1],
        ]),
      }),
    );
    expect(result).toEqual([
      { oldPath: "old-a.md", newPath: "merged.md", annotationCount: 1, ambiguous: true },
      { oldPath: "old-b.md", newPath: "merged.md", annotationCount: 2, ambiguous: true },
    ]);
  });

  it("skips vanished paths without a stored fingerprint or without live annotations", () => {
    const result = detectMovedDocumentCandidates(
      input({
        presentPaths: ["new.md"],
        currentHashes: new Map([["new.md", "ntxt:aaaa"]]),
        // "unhashed.md" was never fingerprinted; "tombstoned.md" has no live
        // annotations left.
        storedHashes: new Map([["tombstoned.md", "ntxt:aaaa"]]),
        liveAnnotationCounts: new Map([
          ["unhashed.md", 4],
          ["tombstoned.md", 0],
        ]),
      }),
    );
    expect(result).toEqual([]);
  });

  it("ignores stored hashes of other vanished paths when collecting candidates", () => {
    // gone.md shares the hash but is not present in the scan, so it is not a
    // rebind target.
    const result = detectMovedDocumentCandidates(
      input({
        presentPaths: ["new.md"],
        currentHashes: new Map([["new.md", "ntxt:aaaa"]]),
        storedHashes: new Map([
          ["old.md", "ntxt:aaaa"],
          ["gone.md", "ntxt:aaaa"],
        ]),
        liveAnnotationCounts: new Map([["old.md", 1]]),
      }),
    );
    expect(result).toEqual([
      { oldPath: "old.md", newPath: "new.md", annotationCount: 1, ambiguous: false },
    ]);
  });
});
