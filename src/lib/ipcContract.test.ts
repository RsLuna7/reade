import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  DocumentIndexEvent,
  IndexProgress,
  LocalBackupResult,
  LocalDataStatus,
  SearchResult,
} from "./backend";

function loadFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./ipc-fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

function assertCamelCaseKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertCamelCaseKeys(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      expect(key, path).toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(key, path).not.toMatch(/_/);
      assertCamelCaseKeys((value as Record<string, unknown>)[key], `${path}.${key}`);
    }
  }
}

describe("D13 IPC DTO fixtures (shared with Rust serde tests)", () => {
  it("round-trips LibraryOpenResult including Unicode paths and null indexError", () => {
    const fixture = loadFixture<{
      rootKey: string;
      documents: Array<{
        relativePath: string;
        title: string;
        size: number;
        modified: number;
        format: string;
        indexStatus: string;
        indexError: string | null;
      }>;
    }>("library-open-result.json");
    assertCamelCaseKeys(fixture);
    expect(fixture.rootKey).toContain("合成库");
    expect(fixture.documents[0]?.title).toContain("🧪");
    expect(fixture.documents[0]?.indexError).toBeNull();
    expect(fixture.documents[1]?.format).toBe("epub");
    expect(fixture.documents[1]?.indexStatus).toBe("failed");
    expect(fixture.documents[0]?.modified).toBe(1_725_600_000_000);
    const json = JSON.stringify(fixture);
    expect(JSON.parse(json)).toEqual(fixture);
  });

  it("covers SearchLocator enum casing, null locator, and scores", () => {
    const fixture = loadFixture<SearchResult[]>("search-results.json");
    assertCamelCaseKeys(fixture);
    expect(fixture[0]?.locator).toBeNull();
    expect(fixture[1]?.locator).toEqual({ kind: "pdfPage", page: 12 });
    expect(fixture[2]?.locator).toEqual({ kind: "epubChapter", chapterId: "chap-09" });
    expect(fixture[0]?.score).toBe(1.5);
  });

  it("keeps IndexProgress and DocumentIndexEvent libraryRoot identity", () => {
    const progress = loadFixture<IndexProgress>("index-progress.json");
    const event = loadFixture<DocumentIndexEvent>("document-index-event.json");
    assertCamelCaseKeys(progress);
    assertCamelCaseKeys(event);
    expect(progress.libraryRoot).toBe("C:/合成库/library-a");
    expect(event.error).toBeNull();
    expect(event.status).toBe("ready");
  });

  it("round-trips LocalDataStatus optional/null millisecond fields", () => {
    const healthy = loadFixture<LocalDataStatus>("local-data-status.json");
    const degraded = loadFixture<LocalDataStatus>("local-data-status-degraded.json");
    const backup = loadFixture<LocalBackupResult>("local-backup-result.json");
    assertCamelCaseKeys(healthy);
    assertCamelCaseKeys(degraded);
    assertCamelCaseKeys(backup);
    expect(healthy.userSchemaVersion).toBe(7);
    expect(healthy.lastBackupAtMs).toBe(1_725_600_000_000);
    expect(degraded.userSchemaVersion).toBeNull();
    expect(degraded.lastBackupAtMs).toBeNull();
    expect(degraded.userOpenError).toContain("Cannot open user database");
    expect(backup.createdAtMs).toBe(1_725_600_000_000);
  });
});
