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
  /** Highlight was created only to anchor this thread. */
  anchorCreated?: boolean;
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
  anchorCreated?: boolean;
}

export interface PdfCommentDeletion {
  messageId: string;
  threadId: string;
  threadDeleted: boolean;
  removedAnnotationId: string | null;
}

export interface ReplyToPdfCommentDraft {
  messageId: string;
  threadId: string;
  authorId: string;
  body: string;
}

const AVATAR_COLORS = ["#5b5fc7", "#c43e1c", "#0f7b6c", "#b86e00", "#3d6cb3", "#8a4baf"];

/** First character for CJK names; first and last initials for Latin names. */
export function commentAuthorInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "我";
  const chars = Array.from(trimmed);
  const first = chars[0] ?? "我";
  if (/[\u3400-\u9fff]/.test(first)) return first;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const start = Array.from(words[0] ?? "")[0] ?? "";
    const end = Array.from(words[words.length - 1] ?? "")[0] ?? "";
    const initials = `${start}${end}`.toUpperCase();
    if (initials) return initials;
  }
  return first.toUpperCase();
}

export function commentAuthorColor(name: string): string {
  let hash = 0;
  const key = name.trim() || "我";
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? "#5b5fc7";
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
