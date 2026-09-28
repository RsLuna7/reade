import { describe, expect, it } from "vitest";
import { pdfCommentErrorMessage } from "./commentErrors";

describe("pdfCommentErrorMessage", () => {
  it.each([
    ["Comment thread was not found", "这条讨论已被删除，请刷新后再试"],
    ["This annotation already has a comment thread", "这处标记已经有讨论了，请在右栏回复"],
    ["comment exceeds 20000 characters", "评论太长，最多 20000 字"],
    ["Comment author was not found", "找不到批注署名，请在阅读设置里重新填写"],
  ])("translates %s", (backend, shown) => {
    expect(pdfCommentErrorMessage(new Error(backend))).toBe(shown);
    // Tauri rejects commands with a bare string, not an Error.
    expect(pdfCommentErrorMessage(backend)).toBe(shown);
  });

  it("keeps an unknown cause readable for diagnosis", () => {
    expect(pdfCommentErrorMessage(new Error("database is locked"))).toBe(
      "批注操作失败：database is locked",
    );
    expect(pdfCommentErrorMessage("")).toBe("批注操作失败");
  });

  it("passes through messages that are already Chinese", () => {
    expect(pdfCommentErrorMessage(new Error("请先创建一个本地评论身份"))).toBe(
      "请先创建一个本地评论身份",
    );
  });
});
