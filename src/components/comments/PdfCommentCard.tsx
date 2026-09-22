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
  onEditMessage,
  onDeleteMessage,
}: {
  thread: PdfCommentThread;
  page: number;
  messages: readonly PdfCommentMessage[];
  authors: readonly CommentAuthor[];
  active: boolean;
  onActivate: () => void;
  onReply: (body: string, authorId: string) => Promise<unknown>;
  onEditMessage?: (messageId: string, body: string) => Promise<unknown>;
  onDeleteMessage?: (messageId: string) => Promise<unknown>;
}) {
  return (
    <article
      className={`pdf-comment-card${active ? " is-active" : ""}`}
      data-comment-thread-id={thread.id}
      data-annotation-id={thread.annotationId}
      aria-label={`第 ${page} 页的批注`}
      onClick={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("button, textarea, input, a")) return;
        onActivate();
      }}
    >
      <PdfCommentConversation
        thread={thread}
        messages={messages}
        authors={authors}
        compact
        showComposer={active}
        onSubmit={onReply}
        onEditMessage={active ? onEditMessage : undefined}
        onDeleteMessage={active ? onDeleteMessage : undefined}
      />
    </article>
  );
}
