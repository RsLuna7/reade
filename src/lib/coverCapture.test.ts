// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturePdfCoverThumbnail } from "./coverCapture";

const { store, renderPage, destroy } = vi.hoisted(() => ({
  store: vi.fn(), renderPage: vi.fn(), destroy: vi.fn(),
}));

vi.mock("./backend", () => ({
  APP_RUNTIME: "desktop",
  storeDocumentThumbnail: store,
  readDocumentRange: vi.fn(),
  readDocumentThumbnail: vi.fn(),
  readEpubAsset: vi.fn(),
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "fixture-worker" },
  PDFDataRangeTransport: class { abort() {} },
  getDocument: () => ({
    promise: Promise.resolve({
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
        render: () => ({ promise: renderPage() }),
      }),
    }),
    destroy,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  store.mockResolvedValue(undefined);
  destroy.mockResolvedValue(undefined);
  renderPage.mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AAAA");
});
afterEach(() => vi.restoreAllMocks());

describe("PDF cover task ownership", () => {
  it("stores a current cover and releases the PDF task", async () => {
    expect(await capturePdfCoverThumbnail("book.pdf", 1000, () => true)).toBe(true);
    expect(store).toHaveBeenCalledWith("book.pdf", "AAAA", expect.any(Number), expect.any(Number));
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("does not store into the new library when rendering finishes after a switch", async () => {
    let complete!: () => void;
    let started!: () => void;
    const rendering = new Promise<void>((resolve) => { started = resolve; });
    renderPage.mockImplementation(() => {
      started();
      return new Promise<void>((resolve) => { complete = resolve; });
    });
    let current = true;
    const pending = capturePdfCoverThumbnail("book.pdf", 1000, () => current);
    await rendering;
    current = false;
    complete();
    expect(await pending).toBe(false);
    expect(store).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
