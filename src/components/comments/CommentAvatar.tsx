import { commentAuthorColor, commentAuthorInitials } from "../../lib/comments/commentModel";

export function CommentAvatar({ name }: { name: string }) {
  const label = name.trim() || "我";
  return (
    <span
      className="pdf-comment-avatar"
      style={{ background: commentAuthorColor(label) }}
      aria-hidden="true"
    >
      {commentAuthorInitials(label)}
    </span>
  );
}
