/** Local-only identity used to author PDF comment messages. */
export interface CommentAuthor {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** One discussion attached to one PDF excerpt/annotation. */
export interface PdfCommentThread {
  id: string;
  annotationId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** Flat chronological reply; PR1 deliberately has no nested reply graph. */
export interface PdfCommentMessage {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface PdfCommentMutation {
  thread: PdfCommentThread;
  message: PdfCommentMessage;
}

export interface CommentAuthorDraft {
  id: string;
  name: string;
  makeDefault: boolean;
}

export interface CreatePdfCommentDraft {
  threadId: string;
  messageId: string;
  annotationId: string;
  authorId: string;
  body: string;
}

export interface ReplyToPdfCommentDraft {
  messageId: string;
  threadId: string;
  authorId: string;
  body: string;
}

export function defaultCommentAuthor(
  authors: readonly CommentAuthor[],
): CommentAuthor | null {
  return (
    authors.find((author) => author.deletedAt == null && author.isDefault) ??
    authors.find((author) => author.deletedAt == null) ??
    null
  );
}

export function messagesForThread(
  messages: readonly PdfCommentMessage[],
  threadId: string,
): PdfCommentMessage[] {
  return messages
    .filter((message) => message.threadId === threadId && message.deletedAt == null)
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
}
