import { beforeEach, describe, expect, it, vi } from "vitest";

// The wrappers are pure IPC plumbing; mock the Tauri modules so the tests
// can assert the exact command names and camelCase argument shapes that the
// Rust side (snake_case parameters) expects.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { detectMovedDocuments, rebindDocumentAnnotations } from "./tauriBackend";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("move detection IPC wrappers", () => {
  it("detectMovedDocuments invokes the command and passes the payload through", async () => {
    const candidates = [
      { oldPath: "old.md", newPath: "moved/new.md", annotationCount: 2, ambiguous: false },
    ];
    invokeMock.mockResolvedValueOnce(candidates);

    await expect(detectMovedDocuments()).resolves.toEqual(candidates);
    expect(invokeMock).toHaveBeenCalledWith("detect_moved_documents");
  });

  it("rebindDocumentAnnotations sends camelCase args and returns the migrated count", async () => {
    invokeMock.mockResolvedValueOnce(3);

    await expect(rebindDocumentAnnotations("old.md", "moved/new.md")).resolves.toBe(3);
    expect(invokeMock).toHaveBeenCalledWith("rebind_document_annotations", {
      oldPath: "old.md",
      newPath: "moved/new.md",
    });
  });
});
