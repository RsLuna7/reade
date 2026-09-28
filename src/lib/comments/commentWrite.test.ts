import { describe, expect, it, vi } from "vitest";
import { writePdfComment, type PdfCommentWriter } from "./commentWrite";

function writer(overrides: Partial<PdfCommentWriter> = {}) {
  return {
    reply: vi.fn(async () => undefined),
    createThread: vi.fn(async () => undefined),
    createAnchor: vi.fn(async () => "auto-mark"),
    removeAnchor: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("writePdfComment", () => {
  it("replies on the thread the selection already has", async () => {
    const calls = writer();
    await expect(
      writePdfComment({ annotationId: "mark", threadId: "thread" }, "回复", calls),
    ).resolves.toBe("mark");
    expect(calls.reply).toHaveBeenCalledWith("thread", "回复");
    expect(calls.createThread).not.toHaveBeenCalled();
    expect(calls.createAnchor).not.toHaveBeenCalled();
  });

  it("starts a thread on an existing mark without an auto-highlight", async () => {
    const calls = writer();
    await expect(
      writePdfComment({ annotationId: "mark", threadId: null }, "新讨论", calls),
    ).resolves.toBe("mark");
    expect(calls.createThread).toHaveBeenCalledWith("mark", "新讨论", false);
    expect(calls.createAnchor).not.toHaveBeenCalled();
  });

  it("adds a highlight marked as the comment anchor when nothing is marked", async () => {
    const calls = writer();
    await expect(writePdfComment(null, "批注", calls)).resolves.toBe("auto-mark");
    expect(calls.createThread).toHaveBeenCalledWith("auto-mark", "批注", true);
    expect(calls.removeAnchor).not.toHaveBeenCalled();
  });

  it("removes the auto-highlight again when its thread cannot be saved", async () => {
    const failure = new Error("thread failed");
    const calls = writer({
      createThread: vi.fn(async () => {
        throw failure;
      }),
      removeAnchor: vi.fn(async () => {
        throw new Error("cleanup failed too");
      }),
    });
    await expect(writePdfComment(null, "批注", calls)).rejects.toBe(failure);
    expect(calls.removeAnchor).toHaveBeenCalledWith("auto-mark");
  });

  it("leaves an existing mark alone when its thread cannot be saved", async () => {
    const calls = writer({
      createThread: vi.fn(async () => {
        throw new Error("thread failed");
      }),
    });
    await expect(
      writePdfComment({ annotationId: "mark", threadId: null }, "批注", calls),
    ).rejects.toThrow("thread failed");
    expect(calls.removeAnchor).not.toHaveBeenCalled();
  });
});
