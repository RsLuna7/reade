import type {
  CommentAuthor,
  PdfCommentMessage,
  PdfCommentThread,
} from "../../lib/comments/commentModel";
import { PdfCommentConversation } from "./PdfCommentConversation";

export function PdfCommentCard({
  thread,
  page,
  messages,
  authors,
  active,
  onActivate,
  onReply,
}: {
  thread: PdfCommentThread;
  page: number;
  messages: readonly PdfCommentMessage[];
  authors: readonly CommentAuthor[];
  active: boolean;
  onActivate: () => void;
  onReply: (body: string, authorId: string) => Promise<unknown>;
}) {
  return (
    <article
      className={`pdf-comment-card${active ? " is-active" : ""}`}
      data-comment-thread-id={thread.id}
      data-annotation-id={thread.annotationId}
    >
      <button type="button" className="pdf-comment-card-jump" onClick={onActivate}>
        <span>讨论</span>
        <span>第 {page} 页</span>
      </button>
      <PdfCommentConversation
        thread={thread}
        messages={messages}
        authors={authors}
        compact
        showComposer={active}
        onSubmit={onReply}
      />
    </article>
  );
}
