// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  READ_MARKS_STORAGE_KEY,
  READ_MARKS_VERSION,
  isMarkedRead,
  markRead,
  readReadMarks,
  reconcileReadMarks,
  sanitizeLibraryReadMarks,
  unmarkRead,
  writeReadMarks,
} from "./readMarks";

afterEach(() => {
  localStorage.clear();
});

describe("sanitizeLibraryReadMarks", () => {
  it("keeps finite positive timestamps and drops junk paths", () => {
    expect(
      sanitizeLibraryReadMarks({
        "notes/a.md": 1_700_000_000_000,
        "../escape.md": 1_700_000_000_000,
        "": 1_700_000_000_000,
        "ok.md": 1_700_000_000,
        "bad.md": Number.NaN,
        "neg.md": -1,
      }),
    ).toEqual({
      "notes/a.md": 1_700_000_000_000,
      "ok.md": 1_700_000_000_000,
    });
  });
});

describe("markRead / unmarkRead", () => {
  it("records the first stamp and is idempotent", () => {
    const once = markRead({}, "notes/a.md", 100);
    const twice = markRead(once, "notes/a.md", 200);
    expect(once).toEqual({ "notes/a.md": 100 });
    expect(twice).toBe(once);
    expect(isMarkedRead(once, "notes/a.md")).toBe(true);
    expect(isMarkedRead(once, "notes/b.md")).toBe(false);
  });

  it("unmarks without touching other paths", () => {
    const marks = markRead(markRead({}, "a.md", 1), "b.md", 2);
    expect(unmarkRead(marks, "a.md")).toEqual({ "b.md": 2 });
    expect(unmarkRead(marks, "missing.md")).toBe(marks);
  });
});

describe("readReadMarks / writeReadMarks", () => {
  it("round-trips per library key and ignores a different folder", () => {
    writeReadMarks("D:/library", { "a.md": 1_700_000_000_000 });
    expect(readReadMarks("d:\\library\\")).toEqual({ "a.md": 1_700_000_000_000 });
    expect(readReadMarks("E:/other")).toEqual({});
    expect(JSON.parse(localStorage.getItem(READ_MARKS_STORAGE_KEY) ?? "{}")).toMatchObject({
      version: READ_MARKS_VERSION,
    });
  });

  it("drops a library key when the last mark is cleared", () => {
    writeReadMarks("D:/library", { "a.md": 1_700_000_000_000 });
    writeReadMarks("D:/library", {});
    expect(readReadMarks("D:/library")).toEqual({});
  });
});

describe("reconcileReadMarks", () => {
  it("keeps only paths still in the scan set", () => {
    expect(
      reconcileReadMarks({ "kept.md": 1, "gone.md": 2 }, [{ relativePath: "kept.md" }]),
    ).toEqual({ "kept.md": 1 });
  });
});
