import { useEffect, useMemo, useState } from "react";
import {
  defaultCommentAuthor,
  messagesForThread,
  type CommentAuthor,
  type PdfCommentMessage,
  type PdfCommentThread,
} from "../../lib/comments/commentModel";
import { CommentAvatar } from "./CommentAvatar";

function commentTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const datePart = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
  const timePart = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${datePart} ${timePart}`;
}

export function PdfCommentConversation({
  thread,
  messages,
  authors,
  compact = false,
  showComposer = true,
  onSubmit,
  onEditMessage,
  onDeleteMessage,
}: {
  thread: PdfCommentThread | null;
  messages: readonly PdfCommentMessage[];
  authors: readonly CommentAuthor[];
  compact?: boolean;
  showComposer?: boolean;
  onSubmit: (body: string, authorId: string) => Promise<unknown>;
  onEditMessage?: (messageId: string, body: string) => Promise<unknown>;
  onDeleteMessage?: (messageId: string) => Promise<unknown>;
}) {
  const liveAuthors = useMemo(
    () => authors.filter((author) => author.deletedAt == null),
    [authors],
  );
  const fallbackAuthorId = defaultCommentAuthor(liveAuthors)?.id ?? "";
  const [authorId, setAuthorId] = useState(fallbackAuthorId);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
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
      setError("请先在阅读设置里写上批注署名");
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
          {orderedMessages.map((message) => {
            const name = authorNames.get(message.authorId) ?? "我";
            return (
              <li key={message.id} className="pdf-comment-message">
                <CommentAvatar name={name} />
                <div className="pdf-comment-message-main">
                  <div className="pdf-comment-message-meta">
                    <strong>{name}</strong>
                    {onEditMessage || onDeleteMessage ? (
                      <div className="pdf-comment-message-actions">
                        {onEditMessage ? (
                          <button
                            type="button"
                            onClick={() => {
                              if (editingId === message.id) {
                                const next = editingBody.trim();
                                if (!next) {
                                  setError("评论不能为空");
                                  return;
                                }
                                void onEditMessage(message.id, next).then(() => setEditingId(null));
                              } else {
                                setEditingId(message.id);
                                setEditingBody(message.body);
                              }
                            }}
                          >
                            {editingId === message.id ? "保存修改" : "修改"}
                          </button>
                        ) : null}
                        {onDeleteMessage ? (
                          <button type="button" onClick={() => void onDeleteMessage(message.id)}>
                            删除
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  {editingId === message.id ? (
                    <label>
                      <span className="sr-only">修改评论</span>
                      <textarea
                        className="pdf-comment-edit"
                        rows={2}
                        value={editingBody}
                        onChange={(event) => setEditingBody(event.target.value)}
                      />
                    </label>
                  ) : (
                    <p>{message.body}</p>
                  )}
                  <time dateTime={new Date(message.createdAt).toISOString()}>
                    {commentTime(message.createdAt)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
      {showComposer ? (
        <div className="pdf-comment-composer">
          <label>
            <span className="sr-only">{thread ? "回复讨论" : "添加评论"}</span>
            <textarea
              rows={compact ? 2 : 3}
              value={draft}
              placeholder={thread ? "回复" : "写下你的评论"}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </label>
          {error ? <p className="pdf-comment-error" role="alert">{error}</p> : null}
          <button type="button" onClick={() => void submit()} disabled={saving || !authorId}>
            {saving ? "正在保存…" : "回复"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
