// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfReadingMode } from "./backend";
import { DOCUMENT_FIND_DEBOUNCE_MS } from "./documentFind";
import { useDocumentFind, type UseDocumentFindOptions } from "./useDocumentFind";

const { readPdf, scrollToMatch, paint } = vi.hoisted(() => ({
  readPdf: vi.fn(),
  scrollToMatch: vi.fn(),
  paint: vi.fn(),
}));

vi.mock("./backend", () => ({ readPdfReadingMode: readPdf }));
vi.mock("./documentFindAdapters", async (importOriginal) => ({
  ...await importOriginal<typeof import("./documentFindAdapters")>(),
  scrollToFindMatch: scrollToMatch,
  rangesForFindMatches: (_article: HTMLElement, _format: string, matches: unknown[]) =>
    matches.map(() => document.createRange()),
}));
vi.mock("./documentFindHighlight", () => ({
  applyFindHighlights: paint,
  clearFindHighlights: vi.fn(),
}));

const pdf: PdfReadingMode = {
  relativePath: "book.pdf",
  status: "ready",
  pages: [
    { page: 1, markdown: "old result", needsOcr: false, ocrReason: null },
    { page: 2, markdown: "new result", needsOcr: false, ocrReason: null },
  ],
  missingPages: [],
  warning: null,
};

function deferredPdf() {
  let resolve!: (value: PdfReadingMode) => void;
  const promise = new Promise<PdfReadingMode>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const options: UseDocumentFindOptions = {
    enabled: true,
    currentPath: "book.pdf",
    contentKind: "pdf",
    pdfMode: "original",
    readerRef: { current: document.createElement("div") },
    articleRef: { current: document.createElement("article") },
    motionLevel: "off",
  };
  return {
    ...renderHook((props) => useDocumentFind(props), { initialProps: options }),
    options,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  readPdf.mockResolvedValue(pdf);
  scrollToMatch.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDocumentFind request lifecycle", () => {
  it("invalidates the old PDF response as soon as a new query is typed", async () => {
    const pending = deferredPdf();
    readPdf.mockReturnValueOnce(pending.promise);
    const { result } = setup();
    act(() => result.current.openFind("old"));
    act(() => result.current.setQuery("new"));
    await act(async () => pending.resolve(pdf));
    expect(result.current.matches).toEqual([]);
    expect(scrollToMatch).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(DOCUMENT_FIND_DEBOUNCE_MS));
    expect(result.current.matches).toMatchObject([{ pdfPage: 2, quote: "new" }]);
  });

  it("clearing the query immediately clears results and blocks pending work", async () => {
    const { result } = setup();
    await act(async () => result.current.openFind("old"));
    expect(result.current.matches).toHaveLength(1);
    act(() => result.current.setQuery(""));
    expect(result.current.status).toBe("idle");
    expect(result.current.matches).toEqual([]);
    expect(result.current.activeIndex).toBe(-1);
  });

  it("does not paint or scroll after unmount while a PDF read is pending", async () => {
    const pending = deferredPdf();
    readPdf.mockReturnValueOnce(pending.promise);
    const { result, unmount } = setup();
    act(() => result.current.openFind("old"));
    unmount();
    await act(async () => pending.resolve(pdf));
    expect(paint).not.toHaveBeenCalled();
    expect(scrollToMatch).not.toHaveBeenCalled();
  });

  it("keeps only the latest match's scroll retry and cancels it on close", async () => {
    scrollToMatch.mockReturnValue(false);
    const { result } = setup();
    await act(async () => result.current.openFind("result"));
    act(() => result.current.nextMatch());
    scrollToMatch.mockClear();
    act(() => vi.advanceTimersByTime(120));
    expect(scrollToMatch).toHaveBeenCalledTimes(1);
    expect(scrollToMatch.mock.calls[0][3]).toMatchObject({ pdfPage: 2 });
    act(() => result.current.closeFind());
    scrollToMatch.mockClear();
    act(() => vi.advanceTimersByTime(2000));
    expect(scrollToMatch).not.toHaveBeenCalled();
  });

  it("reopening find cancels a previous debounced query", async () => {
    const { result } = setup();
    await act(async () => result.current.openFind("old"));
    act(() => result.current.setQuery("old"));
    await act(async () => result.current.openFind("new"));
    await act(async () => vi.advanceTimersByTimeAsync(DOCUMENT_FIND_DEBOUNCE_MS));
    expect(result.current.query).toBe("new");
    expect(result.current.matches).toMatchObject([{ pdfPage: 2, quote: "new" }]);
  });

  it("switching PDF mode cancels a debounce bound to the original surface", async () => {
    const { result, rerender, options } = setup();
    act(() => result.current.openFind());
    act(() => result.current.setQuery("old"));
    options.articleRef.current!.textContent = "old text on reading surface";
    rerender({ ...options, pdfMode: "reading" });
    await act(async () => vi.advanceTimersByTimeAsync(DOCUMENT_FIND_DEBOUNCE_MS));
    expect(readPdf).not.toHaveBeenCalled();
    expect(result.current.matches[0]).toMatchObject({ start: 0, end: 3 });
    expect(result.current.matches[0]?.quote).toBeUndefined();
  });

  it("disabling find blocks pending responses", async () => {
    const pending = deferredPdf();
    readPdf.mockReturnValueOnce(pending.promise);
    const { result, rerender, options } = setup();
    act(() => result.current.openFind("old"));
    rerender({ ...options, enabled: false });
    await act(async () => pending.resolve(pdf));
    expect(result.current.open).toBe(false);
    expect(result.current.matches).toEqual([]);
    expect(scrollToMatch).not.toHaveBeenCalled();
  });
});
