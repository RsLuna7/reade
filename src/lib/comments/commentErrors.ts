const KNOWN_MESSAGES: ReadonlyArray<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^comment must not be empty$/i, () => "评论不能为空"],
  [/^comment exceeds (\d+) characters$/i, (match) => `评论太长，最多 ${match[1]} 字`],
  [/^comment author name must not be empty$/i, () => "署名不能为空"],
  [/^comment author name exceeds (\d+) characters$/i, (match) => `署名太长，最多 ${match[1]} 字`],
  [/^This annotation already has a comment thread$/i, () => "这处标记已经有讨论了，请在右栏回复"],
  [/^Comment thread was not found$/i, () => "这条讨论已被删除，请刷新后再试"],
  [/^Comment was not found$/i, () => "这条评论已被删除，请刷新后再试"],
  [/^Comment author was not found$/i, () => "找不到批注署名，请在阅读设置里重新填写"],
  [/^PDF annotation was not found$/i, () => "批注对应的标记已被删除"],
  [/^Comments currently support PDF annotations only$/i, () => "目前只能在 PDF 上批注"],
];

/**
 * Chinese copy for the comment commands' known errors. Anything else (disk,
 * database) keeps its original text so the cause can still be diagnosed.
 */
export function pdfCommentErrorMessage(cause: unknown): string {
  const message = (cause instanceof Error ? cause.message : String(cause)).trim();
  for (const [pattern, format] of KNOWN_MESSAGES) {
    const match = message.match(pattern);
    if (match) return format(match);
  }
  if (!message) return "批注操作失败";
  // Frontend guards already speak Chinese.
  if (/[㐀-鿿]/.test(message)) return message;
  return `批注操作失败：${message}`;
}
