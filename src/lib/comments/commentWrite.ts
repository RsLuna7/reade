import type { CommentPlacement } from "./commentPlacement";

export interface PdfCommentWriter {
  reply: (threadId: string, body: string) => Promise<unknown>;
  createThread: (annotationId: string, body: string, anchorCreated: boolean) => Promise<unknown>;
  /** Saves the highlight a comment needs when the selection has no mark. Returns its id. */
  createAnchor: () => Promise<string>;
  /** Silently removes a highlight made by `createAnchor`. */
  removeAnchor: (annotationId: string) => Promise<unknown>;
}

/**
 * Writes a comment for a selection placed by `commentTargetForSelection` and
 * returns the annotation it hangs on: a reply on an existing thread, a new
 * thread on an existing mark, or a new highlight plus thread. When the thread
 * fails after its highlight was made, the highlight is removed again; kept
 * alone it would be an auto-highlight that comment delete and clear miss.
 */
export async function writePdfComment(
  target: CommentPlacement | null,
  body: string,
  writer: PdfCommentWriter,
): Promise<string> {
  if (target?.threadId) {
    await writer.reply(target.threadId, body);
    return target.annotationId;
  }
  if (target) {
    await writer.createThread(target.annotationId, body, false);
    return target.annotationId;
  }
  const annotationId = await writer.createAnchor();
  try {
    await writer.createThread(annotationId, body, true);
  } catch (cause) {
    await writer.removeAnchor(annotationId).catch(() => undefined);
    throw cause;
  }
  return annotationId;
}
