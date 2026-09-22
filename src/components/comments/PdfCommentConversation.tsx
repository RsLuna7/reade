import { useEffect, useMemo, useState } from "react";
import {
  defaultCommentAuthor,
  messagesForThread,
  type CommentAuthor,
  type PdfCommentMessage,
  type PdfCommentThread,
} from "../../lib/comments/commentModel";

function commentTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function PdfCommentConversation({
  thread,
  messages,
  authors,
  compact = false,
  showComposer = true,
  onSubmit,
}: {
  thread: PdfCommentThread | null;
  messages: readonly PdfCommentMessage[];
  authors: readonly CommentAuthor[];
  compact?: boolean;
  showComposer?: boolean;
  onSubmit: (body: string, authorId: string) => Promise<unknown>;
}) {
  const liveAuthors = useMemo(
    () => authors.filter((author) => author.deletedAt == null),
    [authors],
  );
  const fallbackAuthorId = defaultCommentAuthor(liveAuthors)?.id ?? "";
  const [authorId, setAuthorId] = useState(fallbackAuthorId);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orderedMessages = thread ? messagesForThread(messages, thread.id) : [];
  const authorNames = new Map(liveAuthors.map((author) => [author.id, author.name]));

  useEffect(() => {
    if (!liveAuthors.some((author) => author.id === authorId)) {
      setAuthorId(fallbackAuthorId);
    }
  }, [authorId, fallbackAuthorId, liveAuthors]);

  const submit = async () => {
    const body = draft.trim();
    if (!body) {
      setError("评论不能为空");
      return;
    }
    if (!authorId) {
      setError("请先创建一个本地评论身份");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(body, authorId);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`pdf-comment-conversation${compact ? " is-compact" : ""}`}>
      {orderedMessages.length > 0 ? (
        <ol className="pdf-comment-timeline" aria-label="评论时间线">
          {orderedMessages.map((message) => (
            <li key={message.id} className="pdf-comment-message">
              <div className="pdf-comment-message-meta">
                <strong>{authorNames.get(message.authorId) ?? "本地作者"}</strong>
                <time dateTime={new Date(message.createdAt).toISOString()}>
                  {commentTime(message.createdAt)}
                </time>
              </div>
              <p>{message.body}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {showComposer ? <div className="pdf-comment-composer">
        <div className="pdf-comment-composer-meta">
          <label>
            <span className="sr-only">评论身份</span>
            <select
              aria-label="评论身份"
              value={authorId}
              onChange={(event) => setAuthorId(event.target.value)}
              disabled={liveAuthors.length === 0}
            >
              {liveAuthors.length === 0 ? <option value="">尚无身份</option> : null}
              {liveAuthors.map((author) => (
                <option key={author.id} value={author.id}>
                  {author.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          <span className="sr-only">{thread ? "回复讨论" : "添加评论"}</span>
          <textarea
            rows={compact ? 2 : 3}
            value={draft}
            placeholder={thread ? "回复这条讨论" : "写下你的评论"}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
          />
        </label>
        {error ? <p className="pdf-comment-error" role="alert">{error}</p> : null}
        <button type="button" onClick={() => void submit()} disabled={saving || !authorId}>
          {saving ? "正在保存…" : thread ? "回复" : "添加评论"}
        </button>
      </div> : null}
    </div>
  );
}
