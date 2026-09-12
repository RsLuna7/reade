import { describe, expect, it } from "vitest";
import {
  canonicalizeLibraryPath,
  normalizeLibraryKey,
  stripWindowsVerbatimPrefix,
} from "./libraryKey";

describe("normalizeLibraryKey", () => {
  it("collapses separator, trailing-separator, and case variants", () => {
    const key = normalizeLibraryKey("D:\\books");
    expect(normalizeLibraryKey("D:/books")).toBe(key);
    expect(normalizeLibraryKey("d:\\BOOKS")).toBe(key);
    expect(normalizeLibraryKey("D:\\books\\")).toBe(key);
    expect(normalizeLibraryKey("D:\\")).toBe(normalizeLibraryKey("d:/"));
  });

  it("applies case-insensitivity only to Windows drive and UNC roots", () => {
    expect(normalizeLibraryKey("d:\\books")).toBe(normalizeLibraryKey("D:\\books"));
    expect(normalizeLibraryKey("//server/share/Lib")).toBe(
      normalizeLibraryKey("//server/share/lib"),
    );
    expect(normalizeLibraryKey("/home/A")).not.toBe(normalizeLibraryKey("/home/a"));
  });

  it("is a no-op for relative paths and leaves their casing alone", () => {
    expect(normalizeLibraryKey("Notes/Vault")).toBe("Notes/Vault");
  });

  it("collapses the canonicalize verbatim prefix in either spelling", () => {
    const key = normalizeLibraryKey("D:\\books");
    expect(normalizeLibraryKey("\\\\?\\D:\\books")).toBe(key);
    expect(normalizeLibraryKey("//?/D:/books")).toBe(key);
    expect(normalizeLibraryKey("//?/D:/E-Libaray/.New")).toBe(
      normalizeLibraryKey("D:\\E-Libaray\\.New"),
    );
  });

  it("keeps genuinely different libraries apart", () => {
    expect(normalizeLibraryKey("D:\\books")).not.toBe(normalizeLibraryKey("D:\\books2"));
    expect(normalizeLibraryKey("D:\\a\\b")).not.toBe(normalizeLibraryKey("D:\\a"));
    // POSIX paths are case-sensitive: A and a are different directories.
    expect(normalizeLibraryKey("/home/A")).not.toBe(normalizeLibraryKey("/home/a"));
    expect(normalizeLibraryKey("/home/a")).not.toBe(normalizeLibraryKey("/home/a/b"));
  });

  it("never maps a degenerate all-separator input onto the empty key", () => {
    expect(normalizeLibraryKey("\\\\")).not.toBe("");
    expect(normalizeLibraryKey("   ")).toBe("");
  });
});

describe("canonicalizeLibraryPath", () => {
  it("preserves casing for display while normalizing separators", () => {
    expect(canonicalizeLibraryPath("D:/E-Libaray/.New/")).toBe("D:/E-Libaray/.New");
    expect(canonicalizeLibraryPath("\\\\?\\C:\\Books")).toBe("C:/Books");
  });
});

describe("stripWindowsVerbatimPrefix", () => {
  it("unwraps drive and UNC prefixes", () => {
    expect(stripWindowsVerbatimPrefix("//?/C:/foo")).toBe("C:/foo");
    expect(stripWindowsVerbatimPrefix("//?/unc/server/share")).toBe("//server/share");
    expect(stripWindowsVerbatimPrefix("C:/foo")).toBe("C:/foo");
  });
});
