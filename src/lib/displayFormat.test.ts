import { describe, expect, it } from "vitest";
import {
  decodePath,
  fileName,
  formatFileSize,
  formatModified,
  transferDateStamp,
} from "./displayFormat";

describe("fileName", () => {
  it("returns the last POSIX or Windows segment", () => {
    expect(fileName("notes/guide.md")).toBe("guide.md");
    expect(fileName("C:\\Books\\guide.md")).toBe("guide.md");
  });
});

describe("transferDateStamp", () => {
  it("formats a local YYYYMMDD stamp", () => {
    expect(transferDateStamp(new Date(2026, 8, 6))).toBe("20260906");
  });
});

describe("formatFileSize", () => {
  it("uses B, KiB, then MiB", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KiB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MiB");
  });
});

describe("formatModified", () => {
  it("treats small values as unix seconds", () => {
    expect(formatModified(Number.NaN)).toBe("修改时间未知");
    expect(formatModified(1_720_000_000)).toMatch(/\d/);
  });
});

describe("decodePath", () => {
  it("decodes URI components and keeps illegal sequences", () => {
    expect(decodePath("a%20b")).toBe("a b");
    expect(decodePath("%E0%A4%A")).toBe("%E0%A4%A");
  });
});
