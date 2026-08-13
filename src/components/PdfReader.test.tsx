// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
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

import { readPdfReadingMode } from "../lib/backend";
import {
  PdfReader,
  PdfSessionLifecycle,
  calculatePdfRestoreScrollTop,
  capturePdfPagePosition,
  computePdfTotalScaleFactor,
  disposePdfSession,
  flattenPdfOutline,
  selectCurrentPdfPage,
  type PdfReaderHandle,
} from "./PdfReader";

class TestIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class TestResizeObserver {
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
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
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

describe("PdfReaderHandle mode switching", () => {
  it("switches modes through setMode and treats same-mode calls as no-ops", async () => {
    vi.mocked(readPdfReadingMode).mockReset();
    vi.mocked(readPdfReadingMode).mockResolvedValue({
      relativePath: "A.pdf",
      status: "ready",
      pages: [{ page: 1, markdown: "hello", needsOcr: false, ocrReason: null }],
      missingPages: [],
      warning: null,
    });
    const readerRef = { current: null as PdfReaderHandle | null };
    const view = render(<PdfReader
      relativePath="A.pdf"
      size={100}
      modified={1}
      indexStatus="ready"
      indexError={null}
      locator={null}
      motionLevel="subtle"
      readerRef={readerRef}
      onTocChange={vi.fn()}
      onActiveChange={vi.fn()}
    />);
    await waitFor(() => expect(readerRef.current).not.toBeNull());
    expect(readerRef.current!.getMode()).toBe("original");

    act(() => readerRef.current!.setMode("original"));
    expect(readPdfReadingMode).not.toHaveBeenCalled();
    expect(readerRef.current!.getMode()).toBe("original");

    await act(async () => readerRef.current!.setMode("reading"));
    expect(readerRef.current!.getMode()).toBe("reading");
    expect(readPdfReadingMode).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.container.querySelector(".pdf-reading-page")).not.toBeNull());

    await act(async () => readerRef.current!.setMode("reading"));
    expect(readPdfReadingMode).toHaveBeenCalledTimes(1);

    act(() => readerRef.current!.setMode("original"));
    expect(readerRef.current!.getMode()).toBe("original");
    expect(view.container.querySelector(".pdf-reading-mode")).toBeNull();

    act(() => view.unmount());
  });
});

describe("PDF region capture mode (plan-pdf-region-card)", () => {
  /** 解析出带 getPage/getOutline 的最小 pdf 双身,让 PdfPage 挂载。 */
  function fakePdf(numPages = 1) {
    return {
      numPages,
      getOutline: vi.fn().mockResolvedValue(null),
      // getViewport 永不 resolve 的渲染路径:renderNearby 页停在 getPage,
      // 不触发 canvas 渲染(jsdom 无 2d 上下文)。
      getPage: vi.fn().mockReturnValue(new Promise(() => undefined)),
    };
  }

  const common = {
    relativePath: "A.pdf",
    size: 100,
    modified: 1,
    indexStatus: "ready" as const,
    indexError: null,
    locator: null,
    motionLevel: "subtle" as const,
    onTocChange: vi.fn(),
    onActiveChange: vi.fn(),
  };

  it("stays hidden without the onRegionCard callback", async () => {
    const view = render(<PdfReader {...common} />);
    await act(async () => {
      pdfMocks.tasks[0].resolve(fakePdf());
      await Promise.resolve();
    });
    expect(view.queryByRole("button", { name: /截取引用/ })).toBeNull();
    act(() => view.unmount());
  });

  it("toggles the crosshair mode, mounts per-page layers and exits on Escape", async () => {
    const view = render(<PdfReader {...common} onRegionCard={vi.fn()} />);
    await act(async () => {
      pdfMocks.tasks[0].resolve(fakePdf(2));
      await Promise.resolve();
    });
    const toggle = await view.findByRole("button", { name: "截取引用" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(view.container.querySelector(".pdf-region-layer")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(view.container.querySelector(".pdf-reader")).toHaveClass("pdf-region-select-active");
    // 初始 renderNearby 只覆盖前两页,两页各挂一层。
    expect(view.container.querySelectorAll(".pdf-region-layer")).toHaveLength(2);
    expect(view.getByRole("status")).toHaveTextContent("拖出一个矩形");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(view.container.querySelector(".pdf-region-layer")).toBeNull();
    expect(view.container.querySelector(".pdf-region-select-active")).toBeNull();
    act(() => view.unmount());
  });

  it("draws the drag rectangle while selecting", async () => {
    const view = render(<PdfReader {...common} onRegionCard={vi.fn()} />);
    await act(async () => {
      pdfMocks.tasks[0].resolve(fakePdf(1));
      await Promise.resolve();
    });
    fireEvent.click(await view.findByRole("button", { name: "截取引用" }));
    const layer = view.getByTestId("pdf-region-layer-1");
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(layer, { button: 0, clientX: 100, clientY: 120, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 300, clientY: 360, pointerId: 1 });
    const rect = view.container.querySelector<HTMLElement>(".pdf-region-rect");
    expect(rect).not.toBeNull();
    expect(rect!.style.left).toBe("100px");
    expect(rect!.style.width).toBe("200px");
    expect(rect!.style.height).toBe("240px");

    fireEvent.pointerUp(layer, { clientX: 300, clientY: 360, pointerId: 1 });
    expect(view.container.querySelector(".pdf-region-rect")).toBeNull();
    act(() => view.unmount());
  });

  it("leaves the mode when switching to reading view", async () => {
    vi.mocked(readPdfReadingMode).mockReset();
    vi.mocked(readPdfReadingMode).mockResolvedValue({
      relativePath: "A.pdf",
      status: "ready",
      pages: [{ page: 1, markdown: "hello", needsOcr: false, ocrReason: null }],
      missingPages: [],
      warning: null,
    });
    const readerRef = { current: null as PdfReaderHandle | null };
    const view = render(<PdfReader {...common} onRegionCard={vi.fn()} readerRef={readerRef} />);
    await act(async () => {
      pdfMocks.tasks[0].resolve(fakePdf(1));
      await Promise.resolve();
    });
    fireEvent.click(await view.findByRole("button", { name: "截取引用" }));
    await act(async () => readerRef.current!.setMode("reading"));
    expect(view.queryByRole("button", { name: "截取引用" })).toBeNull();

    act(() => readerRef.current!.setMode("original"));
    const toggle = await view.findByRole("button", { name: "截取引用" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    act(() => view.unmount());
  });
});

describe("PDF outline TOC levels", () => {
  it("preserves nested outline indentation like Markdown headings", () => {
    expect(
      flattenPdfOutline([
        {
          title: "第一卷",
          page: 1,
          items: [
            { title: "第一章", page: 3 },
            { title: "第二章", page: 8, items: [{ title: "小节", page: 9 }] },
          ],
        },
        { title: "第二卷", page: 20 },
      ]),
    ).toEqual([
      { id: "pdf-page-1", title: "第一卷", level: 1 },
      { id: "pdf-page-3", title: "第一章", level: 2 },
      { id: "pdf-page-8", title: "第二章", level: 2 },
      { id: "pdf-page-9", title: "小节", level: 3 },
      { id: "pdf-page-20", title: "第二卷", level: 1 },
    ]);
  });
});

describe("pdf.js text layer scale-factor contract", () => {
  // A4: rawDims.pageWidth = 595.28pt; viewport.width = 595.28 × scale × userUnit.
  it("derives the factor from the measured page-box width", () => {
    expect(computePdfTotalScaleFactor(779.8168, { width: 779.8168, scale: 1.31, userUnit: 1 })).toBeCloseTo(1.31, 6);
  });

  it("follows the page box when min(--pdf-page-width, 100%) clamps it", () => {
    expect(computePdfTotalScaleFactor(400, { width: 779.8168, scale: 1.31, userUnit: 1 })).toBeCloseTo(400 / 595.28, 6);
  });

  it("uses the same formula for rotated pages and honors userUnit", () => {
    // /Rotate 90: viewport.width is already the rotated (landscape) dimension.
    expect(computePdfTotalScaleFactor(1102.8759, { width: 1102.8759, scale: 1.31, userUnit: 1 })).toBeCloseTo(1.31, 6);
    expect(computePdfTotalScaleFactor(1190.56, { width: 1190.56, scale: 1, userUnit: 2 })).toBeCloseTo(2, 6);
  });

  it("rejects degenerate measurements instead of emitting a broken factor", () => {
    expect(computePdfTotalScaleFactor(0, { width: 779.8168, scale: 1.31, userUnit: 1 })).toBeNull();
    expect(computePdfTotalScaleFactor(Number.NaN, { width: 779.8168, scale: 1.31, userUnit: 1 })).toBeNull();
    expect(computePdfTotalScaleFactor(500, { width: 0, scale: 1, userUnit: 1 })).toBeNull();
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
