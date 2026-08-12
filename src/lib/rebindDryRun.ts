/**
 * Dry-run verification for the §5.6 manual document rebind flow (KOReader
 * DOM-upgrade wizard idea): before annotations are migrated to a candidate
 * document, every text quote is resolved against the candidate's body text
 * and the caller reports "M of N anchorable". Read-only — nothing is
 * migrated or rewritten here.
 */

import type { Annotation, EpubBlock, EpubDocument, EpubInline } from "./backend";
import { resolveTextQuote } from "./annotations";

export interface RebindDryRunReport {
  /** Live annotations attached to the lost path. */
  total: number;
  /** Quote-bearing annotations whose quote resolves in the target text. */
  anchorable: number;
  /** Annotations without a text quote (bookmarks): not verifiable by text. */
  skipped: number;
}

function epubInlineText(items: EpubInline[]): string {
  let text = "";
  for (const item of items) {
    switch (item.kind) {
      case "text":
        text += item.text;
        break;
      case "link":
        text += epubInlineText(item.content);
        break;
      case "image":
        text += item.alt;
        break;
      case "lineBreak":
        text += " ";
        break;
      default:
        break;
    }
  }
  return text;
}

function epubBlockText(block: EpubBlock): string {
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return epubInlineText(block.content);
    case "codeBlock":
      return block.text;
    case "blockQuote":
      return block.blocks.map(epubBlockText).join("\n");
    case "list":
      return block.items
        .map((item) => item.blocks.map(epubBlockText).join("\n"))
        .join("\n");
    case "table":
      return block.rows
        .map((row) =>
          row
            .map((slot) => (slot.kind === "cell" ? slot.blocks.map(epubBlockText).join(" ") : ""))
            .join(" "),
        )
        .join("\n");
    case "rule":
      return "";
  }
}

/** Flattens an EPUB document into plain text for quote verification. */
export function flattenEpubDocumentText(document: EpubDocument): string {
  return document.chapters
    .map((chapter) => `${chapter.title}\n${chapter.blocks.map(epubBlockText).join("\n")}`)
    .join("\n");
}

/**
 * Resolves every quote-bearing annotation against `targetText` with the
 * loose chain (whitespace-normalized + fuzzy — matching what a manual
 * relocate could recover). The verification text comes from `read_document`,
 * which for Markdown is the raw source rather than the rendered DOM text;
 * the loose chain absorbs most of that difference, so the count is a
 * predictor, not a guarantee.
 */
export function dryRunTextQuoteAnchors(
  annotations: Annotation[],
  targetText: string,
): RebindDryRunReport {
  let anchorable = 0;
  let skipped = 0;
  for (const annotation of annotations) {
    const locator = annotation.locator;
    if (locator.kind === "bookmark" || !locator.quote) {
      skipped += 1;
      continue;
    }
    const match = resolveTextQuote(targetText, locator.quote, locator.prefix, locator.suffix, {
      normalizeWhitespace: true,
      fuzzy: true,
    });
    if (match) anchorable += 1;
  }
  return { total: annotations.length, anchorable, skipped };
}
