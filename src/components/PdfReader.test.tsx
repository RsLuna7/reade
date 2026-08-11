// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pdfMocks = vi.hoisted(() => ({
  tasks: [] as Array<{
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    destroy: ReturnType<typeof vi.fn>;
    onPassword?: () => void;
  }>,
  getDocument: vi.fn(),
}));

vi.mock("pdfjs-dist", () => {
  class TestRangeTransport {
    constructor(_length: number, _initialData: null, _progressiveDone: boolean) {}
    onDataRange() {}
    abort() {}
  }
  return {
    AnnotationMode: { DISABLE: 0 },
    GlobalWorkerOptions: { workerSrc: "" },
    PDFDataRangeTransport: TestRangeTransport,
    TextLayer: class {
      render() { return Promise.resolve(); }
      cancel() {}
    },
    getDocument: pdfMocks.getDocument,
  };
});

vi.mock("../lib/backend", () => ({
  openExternalLink: vi.fn(),
  readDocumentRange: vi.fn().mockResolvedValue(new Uint8Array()),
  readPdfReadingMode: vi.fn(),
}));

import {
  PdfReader,
  PdfSessionLifecycle,
  calculatePdfRestoreScrollTop,
  capturePdfPagePosition,
  disposePdfSession,
  selectCurrentPdfPage,
} from "./PdfReader";

class TestIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  pdfMocks.tasks.length = 0;
  pdfMocks.getDocument.mockReset();
  pdfMocks.getDocument.mockImplementation(() => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>((fulfill) => {
      resolve = fulfill;
    });
    const task = { promise, resolve, destroy: vi.fn().mockResolvedValue(undefined), onPassword: undefined };
    pdfMocks.tasks.push(task);
    return task;
  });
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});

describe("PDF session lifecycle", () => {
  it("cancels every page task before transport abort and document destroy", async () => {
    const events: string[] = [];
    const lifecycle = new PdfSessionLifecycle(7, "book.pdf\u0000100");
    lifecycle.registerPageTask(() => events.push("cancel-page-1"));
    lifecycle.registerPageTask(() => events.push("cancel-page-2"));

    await disposePdfSession(
      lifecycle,
      () => events.push("abort-range"),
      () => { events.push("destroy-document"); },
    );
    await disposePdfSession(
      lifecycle,
      () => events.push("abort-again"),
      () => { events.push("destroy-again"); },
    );

    expect(events).toEqual(["cancel-page-1", "cancel-page-2", "abort-range", "destroy-document"]);
    expect(lifecycle.isActive()).toBe(false);
  });

  it("immediately cancels tasks registered after the generation was disposed", () => {
    const lifecycle = new PdfSessionLifecycle(1, "old.pdf\u00001");
    lifecycle.deactivateAndCancelPages();
    const cancel = vi.fn();
    lifecycle.registerPageTask(cancel);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("creates a fresh loading task and Range transport for A to B to A", async () => {
    const common = {
      modified: 1,
      indexStatus: "pending" as const,
      indexError: null,
      locator: null,
      motionLevel: "subtle" as const,
      onTocChange: vi.fn(),
      onActiveChange: vi.fn(),
    };
    const view = render(<PdfReader relativePath="A.pdf" size={100} {...common} />);
    await waitFor(() => expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1));

    view.rerender(<PdfReader relativePath="B.pdf" size={200} {...common} />);
    await waitFor(() => expect(pdfMocks.getDocument).toHaveBeenCalledTimes(2));
    expect(pdfMocks.tasks[0].destroy).toHaveBeenCalledOnce();
    await act(async () => {
      pdfMocks.tasks[0].resolve({ numPages: 99 });
      await Promise.resolve();
    });
    expect(view.container).not.toHaveTextContent("/ 99");

    view.rerender(<PdfReader relativePath="A.pdf" size={100} {...common} />);
    await waitFor(() => expect(pdfMocks.getDocument).toHaveBeenCalledTimes(3));
    expect(pdfMocks.tasks[1].destroy).toHaveBeenCalledOnce();
    expect(pdfMocks.getDocument.mock.calls[0][0].range).not.toBe(pdfMocks.getDocument.mock.calls[2][0].range);

    act(() => view.unmount());
    expect(pdfMocks.tasks[2].destroy).toHaveBeenCalledOnce();
  });

  it("restarts the session when file state changes without a size change", async () => {
    const common = {
      relativePath: "A.pdf",
      size: 100,
      indexStatus: "pending" as const,
      indexError: null,
      locator: null,
      motionLevel: "subtle" as const,
      onTocChange: vi.fn(),
      onActiveChange: vi.fn(),
    };
    const view = render(<PdfReader {...common} modified={1} />);
    await waitFor(() => expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1));

    view.rerender(<PdfReader {...common} modified={2} />);
    await waitFor(() => expect(pdfMocks.getDocument).toHaveBeenCalledTimes(2));
    expect(pdfMocks.tasks[0].destroy).toHaveBeenCalledOnce();
  });
});

describe("PDF current page selection", () => {
  const pages = [
    { page: 1, top: -500, bottom: 90 },
    { page: 2, top: 110, bottom: 710 },
    { page: 3, top: 730, bottom: 1330 },
  ];

  it("chooses the visible page containing the toolbar reference line", () => {
    expect(selectCurrentPdfPage(pages, 240, 0, 800)).toBe(2);
  });

  it("uses nearest distance and a stable page-number tie break in a page gap", () => {
    expect(selectCurrentPdfPage(pages, 100, 0, 800)).toBe(1);
  });

  it("never selects a closer page that is outside the scroll viewport", () => {
    expect(selectCurrentPdfPage(pages, 725, 0, 720)).toBe(2);
  });
});

describe("PDF page position preservation", () => {
  it("captures a clamped page-relative offset", () => {
    expect(capturePdfPagePosition(4, 100, 400, 260)).toEqual({ page: 4, offsetRatio: .4 });
    expect(capturePdfPagePosition(4, 100, 400, 20).offsetRatio).toBe(0);
    expect(capturePdfPagePosition(4, 100, 400, 900).offsetRatio).toBe(1);
  });

  it("restores the same ratio against a differently sized target page", () => {
    const position = capturePdfPagePosition(4, 100, 400, 260);
    expect(calculatePdfRestoreScrollTop(600, 80, 1000, 200, position.offsetRatio)).toBe(880);
  });
});
