import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
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
  const editFieldRef = useRef<HTMLTextAreaElement>(null);
  const orderedMessages = thread ? messagesForThread(messages, thread.id) : [];
  const authorNames = new Map(liveAuthors.map((author) => [author.id, author.name]));

  useEffect(() => {
    if (!liveAuthors.some((author) => author.id === authorId)) {
      setAuthorId(fallbackAuthorId);
    }
  }, [authorId, fallbackAuthorId, liveAuthors]);

  useEffect(() => {
    if (!editingId) return;
    editFieldRef.current?.focus();
  }, [editingId]);

  const cancelEdit = () => {
    setEditingId(null);
    setEditingBody("");
    setError(null);
  };

  const saveEdit = async () => {
    if (!editingId || !onEditMessage) return;
    const next = editingBody.trim();
    if (!next) {
      setError("评论不能为空");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onEditMessage(editingId, next);
      setEditingId(null);
      setEditingBody("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

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

  const [rootMessage, ...replyMessages] = orderedMessages;
  const renderMessage = (message: PdfCommentMessage, reply: boolean) => {
    const name = authorNames.get(message.authorId) ?? "我";
    const editing = editingId === message.id;
    return (
      <li key={message.id} className={`pdf-comment-message${reply ? " is-reply" : ""}`}>
        <CommentAvatar name={name} />
        <div className="pdf-comment-message-main">
          <div className="pdf-comment-message-meta">
            <strong>{name}</strong>
            {onEditMessage || onDeleteMessage ? (
              <div className="pdf-comment-message-actions">
                {onEditMessage && !editing ? (
                  <button
                    type="button"
                    className="pdf-comment-icon-button"
                    aria-label="修改"
                    title="修改"
                    onClick={() => {
                      setEditingId(message.id);
                      setEditingBody(message.body);
                      setError(null);
                    }}
                  >
                    <Pencil aria-hidden="true" />
                  </button>
                ) : null}
                {onDeleteMessage ? (
                  <button
                    type="button"
                    className="pdf-comment-icon-button"
                    aria-label="删除"
                    title="删除"
                    onClick={() => void onDeleteMessage(message.id)}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          {editing ? (
            <div className="pdf-comment-edit-panel">
              <label>
                <span className="sr-only">修改评论</span>
                <textarea
                  ref={editFieldRef}
                  className="pdf-comment-edit"
                  rows={2}
                  value={editingBody}
                  onChange={(event) => setEditingBody(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelEdit();
                    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void saveEdit();
                    }
                  }}
                />
              </label>
              {error ? <p className="pdf-comment-error" role="alert">{error}</p> : null}
              <div className="pdf-comment-edit-actions">
                <button
                  type="button"
                  className="pdf-comment-edit-confirm"
                  aria-label="保存修改"
                  title="保存修改"
                  disabled={saving}
                  onClick={() => void saveEdit()}
                >
                  <Check aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="pdf-comment-edit-cancel"
                  aria-label="取消修改"
                  title="取消修改"
                  disabled={saving}
                  onClick={cancelEdit}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : (
            <p>{message.body}</p>
          )}
          {editing ? null : (
            <time dateTime={new Date(message.createdAt).toISOString()}>
              {commentTime(message.createdAt)}
            </time>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className={`pdf-comment-conversation${compact ? " is-compact" : ""}`}>
      {rootMessage ? (
        <ol className="pdf-comment-timeline" aria-label="评论时间线">
          {renderMessage(rootMessage, false)}
          {replyMessages.length > 0 ? (
            <li className="pdf-comment-replies">
              <ol className="pdf-comment-reply-list" aria-label="回复">
                {replyMessages.map((message) => renderMessage(message, true))}
              </ol>
            </li>
          ) : null}
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
          {!editingId && error ? <p className="pdf-comment-error" role="alert">{error}</p> : null}
          <button type="button" onClick={() => void submit()} disabled={saving || !authorId}>
            {saving ? "正在保存…" : "回复"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
