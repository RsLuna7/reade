// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { attachPdfReadingPageNumbers, resolveDocumentFindFormat } from "./documentFindAdapters";

describe("resolveDocumentFindFormat", () => {
  it("maps content kinds and pdf modes", () => {
    expect(resolveDocumentFindFormat("markdown", null)).toBe("markdown");
    expect(resolveDocumentFindFormat("epub", null)).toBe("epub");
    expect(resolveDocumentFindFormat("pdf", "original")).toBe("pdf-original");
    expect(resolveDocumentFindFormat("pdf", "reading")).toBe("pdf-reading");
    expect(resolveDocumentFindFormat(null, null)).toBeNull();
  });
});

describe("attachPdfReadingPageNumbers", () => {
  it("maps global offsets to per-page coordinates", () => {
    const article = document.createElement("div");
    const pageOne = document.createElement("section");
    pageOne.className = "pdf-reading-page";
    pageOne.id = "pdf-page-1";
    pageOne.dataset.pageNumber = "1";
    pageOne.textContent = "abc";
    const pageTwo = document.createElement("section");
    pageTwo.className = "pdf-reading-page";
    pageTwo.id = "pdf-page-2";
    pageTwo.dataset.pageNumber = "2";
    pageTwo.textContent = "defghi";
    article.append(pageOne, pageTwo);

    const attached = attachPdfReadingPageNumbers(article, [
      { id: "0:1", start: 0, end: 1 },
      { id: "5:8", start: 5, end: 8 },
    ]);
    expect(attached[0]).toMatchObject({ pdfPage: 1, start: 0, end: 1 });
    expect(attached[1]).toMatchObject({ pdfPage: 2, start: 2, end: 5 });
  });
});
