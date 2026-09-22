// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommentAuthor, PdfCommentMessage, PdfCommentThread } from "../../lib/comments/commentModel";
import { PdfCommentConversation } from "./PdfCommentConversation";

const thread: PdfCommentThread = {
  id: "thread-1",
  annotationId: "mark-1",
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};
const authors: CommentAuthor[] = [
  { id: "me", name: "ZJX", isDefault: true, createdAt: 1, updatedAt: 1, deletedAt: null },
];
const messages: PdfCommentMessage[] = [
  { id: "root", threadId: "thread-1", authorId: "me", body: "缺失如此", createdAt: 1, updatedAt: 1, deletedAt: null },
  { id: "reply", threadId: "thread-1", authorId: "me", body: "我我", createdAt: 2, updatedAt: 2, deletedAt: null },
];

afterEach(() => {
  cleanup();
});

function renderThread(onEditMessage = vi.fn(async () => undefined)) {
  render(
    <PdfCommentConversation
      thread={thread}
      messages={messages}
      authors={authors}
      onSubmit={vi.fn(async () => undefined)}
      onEditMessage={onEditMessage}
      onDeleteMessage={vi.fn(async () => undefined)}
    />,
  );
  return onEditMessage;
}

describe("PdfCommentConversation", () => {
  it("nests replies under the root comment", () => {
    renderThread();
    const replies = document.querySelector(".pdf-comment-replies");
    expect(replies?.querySelector(".pdf-comment-message.is-reply")).toHaveTextContent("我我");
    expect(document.querySelector(".pdf-comment-timeline > .pdf-comment-message")).not.toHaveClass("is-reply");
    expect(document.querySelector(".pdf-comment-timeline > .pdf-comment-message")).toHaveTextContent("缺失如此");
  });

  it("opens an edit field that can be saved or closed", async () => {
    const onEditMessage = renderThread();
    fireEvent.click(screen.getAllByRole("button", { name: "修改" })[1]!);
    const field = screen.getByRole("textbox", { name: "修改评论" });
    expect(field).toHaveValue("我我");
    expect(screen.queryByRole("button", { name: "保存修改" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消修改" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消修改" }));
    expect(screen.queryByRole("textbox", { name: "修改评论" })).not.toBeInTheDocument();
    expect(onEditMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "修改" })[1]!);
    fireEvent.change(screen.getByRole("textbox", { name: "修改评论" }), { target: { value: "改过" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(onEditMessage).toHaveBeenCalledWith("reply", "改过");
  });

  it("keeps the editor open when the draft is empty and closes it with Escape", () => {
    const onEditMessage = renderThread();
    fireEvent.click(screen.getAllByRole("button", { name: "修改" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "修改评论" }), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(screen.getByRole("alert")).toHaveTextContent("评论不能为空");
    expect(onEditMessage).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "修改评论" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "修改评论" })).not.toBeInTheDocument();
  });
});
