// @vitest-environment jsdom

const backendMocks = vi.hoisted(() => ({
  readEpubAsset: vi.fn(),
  openExternalLink: vi.fn(),
}));

vi.mock("../lib/backend", () => ({
  readEpubAsset: backendMocks.readEpubAsset,
  openExternalLink: backendMocks.openExternalLink,
}));
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation, EpubDocument } from "../lib/backend";

let ioInstances: TestIntersectionObserver[] = [];
import { EpubReader, buildEpubToc, epubChapterTocId } from "./EpubReader";

class TestIntersectionObserver {
  callback: (entries: Array<{ isIntersecting: boolean }>) => void;
  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    this.callback = callback;
    ioInstances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** D11 测试辅助：手动触发所有已注册观察器的进入视口事件。 */
function triggerAllIntersections(): void {
  const instances = ioInstances;
  ioInstances = [];
  for (const instance of instances) instance.callback([{ isIntersecting: true }]);
}

beforeEach(() => {
  ioInstances = [];
  backendMocks.readEpubAsset.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

describe("EpubReader", () => {
  it("renders only semantic DTO nodes and never turns text into executable HTML", () => {
    const document: EpubDocument = {
      title: "Safe Book",
      assets: [],
      notes: [],
      chapters: [{
        id: "chapter.xhtml",
        title: "安全章节",
        level: 1,
        blocks: [
          { kind: "paragraph", content: [{ kind: "text", text: "<script>window.pwned=true</script>", bold: false, italic: false, strike: false, code: false }] },
          { kind: "paragraph", content: [{ kind: "image", alt: "remote", source: { kind: "externalBlocked", value: "https://tracker.invalid/a.png" } }] },
        ],
      }],
    };

    const { container } = render(<EpubReader relativePath="safe.epub" document={document} locator={null} motionLevel="subtle" onTocChange={() => undefined} onActiveChange={() => undefined} />);
    expect(screen.getByText("<script>window.pwned=true</script>")).toBeInTheDocument();
    expect(screen.getByText("远程或不安全资源已拦截")).toBeInTheDocument();
    expect(container.querySelector("script, iframe, object, form, audio, video, img")).toBeNull();
    expect(container.innerHTML).not.toContain("tracker.invalid");
  });

  it("exposes chapter navigation without raw EPUB markup", () => {
    const onTocChange = vi.fn();
    const document: EpubDocument = {
      title: "Book",
      assets: [],
      notes: [],
      chapters: [{ id: "one", title: "第一章", level: 1, blocks: [] }, { id: "two", title: "第二章", level: 1, blocks: [] }],
    };
    render(<EpubReader relativePath="book.epub" document={document} locator={{ kind: "epubChapter", chapterId: "two" }} motionLevel="subtle" onTocChange={onTocChange} onActiveChange={() => undefined} />);
    expect(onTocChange).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ title: "第一章" }), expect.objectContaining({ title: "第二章" })]));
  });

  it("indents TOC entries from chapter levels and nested headings", () => {
    const document: EpubDocument = {
      title: "Book",
      assets: [],
      notes: [],
      chapters: [
        {
          id: "vol.xhtml",
          title: "第一卷",
          level: 1,
          blocks: [{ kind: "heading", level: 1, anchor: "vol.xhtml", content: [{ kind: "text", text: "第一卷", bold: false, italic: false, strike: false, code: false }] }],
        },
        {
          id: "c1.xhtml",
          title: "第一章",
          level: 2,
          blocks: [
            { kind: "heading", level: 1, anchor: "c1.xhtml", content: [{ kind: "text", text: "第一章", bold: false, italic: false, strike: false, code: false }] },
            { kind: "heading", level: 3, anchor: "c1.xhtml#section", content: [{ kind: "text", text: "小节", bold: false, italic: false, strike: false, code: false }] },
          ],
        },
      ],
    };

    expect(buildEpubToc(document)).toEqual([
      expect.objectContaining({ title: "第一卷", level: 1 }),
      expect.objectContaining({ title: "第一章", level: 2 }),
      expect.objectContaining({ title: "小节", level: 3 }),
    ]);
  });

  it("keeps epubChapterTocId in lockstep with the chapter-level ids of buildEpubToc", () => {
    const document: EpubDocument = {
      title: "Book",
      assets: [],
      notes: [],
      chapters: [
        {
          id: "OEBPS/part-1/ch-01.xhtml",
          title: "第一章",
          level: 1,
          blocks: [
            {
              kind: "heading",
              level: 2,
              anchor: "ch1-s1",
              content: [{ kind: "text", text: "小节", bold: false, italic: false, strike: false, code: false }],
            },
          ],
        },
        { id: "OEBPS/part-1/ch-02.xhtml", title: "第二章", level: 2, blocks: [] },
      ],
    };

    const toc = buildEpubToc(document);
    expect(toc.map((item) => item.title)).toEqual(["第一章", "小节", "第二章"]);
    // Round trip: the exported wrapper reproduces exactly the chapter-level
    // TOC ids, so annotation heat can map locator.chapterId → TOC entry.
    expect(toc[0].id).toBe(epubChapterTocId("OEBPS/part-1/ch-01.xhtml"));
    expect(toc[2].id).toBe(epubChapterTocId("OEBPS/part-1/ch-02.xhtml"));
    // Stable across calls, and never colliding with in-chapter anchor ids.
    expect(epubChapterTocId("OEBPS/part-1/ch-01.xhtml")).toBe(epubChapterTocId("OEBPS/part-1/ch-01.xhtml"));
    expect(toc[1].id).not.toBe(epubChapterTocId("ch1-s1"));
  });

  it("jumps instantly and highlights only the React-rendered locator marker", async () => {
    const animatedElements: Element[] = [];
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: vi.fn(function (this: HTMLElement) {
        animatedElements.push(this);
        return {
          addEventListener: vi.fn(),
          cancel: vi.fn(),
          finished: new Promise<void>(() => undefined),
        };
      }),
    });
    const document: EpubDocument = {
      title: "Book",
      assets: [],
      notes: [],
      chapters: [{ id: "one", title: "第一章", level: 1, blocks: [] }, { id: "two", title: "第二章", level: 1, blocks: [] }],
    };

    const view = render(<div className="reading-scroll"><EpubReader relativePath="book.epub" document={document} locator={{ kind: "epubChapter", chapterId: "two" }} motionLevel="full" onTocChange={() => undefined} onActiveChange={() => undefined} /></div>);

    const scrollRoot = view.container.querySelector<HTMLElement>(".reading-scroll");
    const targetChapter = view.container.querySelector<HTMLElement>('[data-chapter-id="two"]');
    expect(scrollRoot).not.toBeNull();
    expect(targetChapter).not.toBeNull();
    if (!scrollRoot || !targetChapter) return;
    scrollRoot.scrollTop = 25;
    vi.spyOn(scrollRoot, "getBoundingClientRect").mockReturnValue({ top: 50 } as DOMRect);
    vi.spyOn(targetChapter, "getBoundingClientRect").mockReturnValue({ top: 250 } as DOMRect);
    animationFrames.splice(0).forEach((callback) => callback(0));

    await waitFor(() => expect(animatedElements.length).toBe(1));
    expect(scrollRoot.scrollTop).toBe(225);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(animatedElements[0]).toBe(targetChapter?.querySelector(".reade-motion-locator-highlight"));
    expect(animatedElements[0]).not.toBe(targetChapter);
  });

  it("paints repeated quotes at the occurrence pointed to by startOffset", () => {
    const document: EpubDocument = {
      title: "Book",
      assets: [],
      notes: [],
      chapters: [{
        id: "c1",
        title: "第一章",
        level: 1,
        blocks: [
          {
            kind: "paragraph",
            content: [{ kind: "text", text: "A. 正确 tail A. 正确 tail", bold: false, italic: false, strike: false, code: false }],
          },
        ],
      }],
    };
    // Both occurrences share the same context; startOffset points at the
    // second one ("A. 正确" at offset 11).
    const annotation: Annotation = {
      id: "ann-epub-1",
      relativePath: "book.epub",
      kind: "highlight",
      color: "yellow",
      note: null,
      selectedText: "A. 正确",
      title: "A. 正确",
      locator: {
        kind: "epub",
        chapterId: "c1",
        blockIndex: 0,
        startOffset: 11,
        endOffset: 16,
        quote: "A. 正确",
        prefix: "",
        suffix: " tail",
      },
      sortIndex: "E|00000|00000011",
      createdAt: 1,
      updatedAt: 1,
    };

    const view = render(<EpubReader relativePath="book.epub" document={document} locator={null} motionLevel="subtle" annotations={[annotation]} onTocChange={() => undefined} onActiveChange={() => undefined} />);
    const mark = view.container.querySelector('[data-annotation-id="ann-epub-1"]');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe("A. 正确");
    expect((mark!.previousSibling as Text).data).toBe("A. 正确 tail ");
  });

  it("retries a stale blockIndex inside the chapter and reports it as approximate", async () => {
    const document: EpubDocument = {
      title: "Book",
      assets: [],
      notes: [],
      chapters: [{
        id: "c1",
        title: "第一章",
        level: 1,
        blocks: [
          {
            kind: "paragraph",
            content: [{ kind: "text", text: "unrelated paragraph", bold: false, italic: false, strike: false, code: false }],
          },
          {
            kind: "paragraph",
            content: [{ kind: "text", text: "the quoted phrase lives here", bold: false, italic: false, strike: false, code: false }],
          },
        ],
      }],
    };
    const annotation: Annotation = {
      id: "ann-epub-stale-block",
      relativePath: "book.epub",
      kind: "highlight",
      color: "yellow",
      note: null,
      selectedText: "quoted phrase",
      title: "quoted phrase",
      locator: {
        kind: "epub",
        chapterId: "c1",
        blockIndex: 0,
        startOffset: 0,
        endOffset: 13,
        quote: "quoted phrase",
        prefix: "the ",
        suffix: " lives",
      },
      sortIndex: "E|00000|00000000",
      createdAt: 1,
      updatedAt: 1,
    };
    const onBroken = vi.fn();
    const onApproximate = vi.fn();
    const view = render(
      <EpubReader
        relativePath="book.epub"
        document={document}
        locator={null}
        motionLevel="subtle"
        annotations={[annotation]}
        onBrokenAnnotationsChange={onBroken}
        onApproximateAnnotationsChange={onApproximate}
        onTocChange={() => undefined}
        onActiveChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(view.container.querySelector('[data-annotation-id="ann-epub-stale-block"]')).not.toBeNull();
    });
    const mark = view.container.querySelector('[data-annotation-id="ann-epub-stale-block"]');
    expect(mark!.textContent).toBe("quoted phrase");
    expect(mark!.classList.contains("annotation-mark--approx")).toBe(true);
    expect(onBroken.mock.calls[onBroken.mock.calls.length - 1]?.[0]).toEqual([]);
    expect(onApproximate.mock.calls[onApproximate.mock.calls.length - 1]?.[0]).toEqual(["ann-epub-stale-block"]);
  });

  // ---- D07: 同书双开的 DOM id 实例隔离 ----

  it("scopes in-book anchor and note ids per reader instance", () => {
    const document: EpubDocument = {
      title: "Dual Book",
      assets: [],
      notes: [{ id: "fn1", kind: "footnote", blocks: [{ kind: "paragraph", content: [{ kind: "text", text: "脚注内容", bold: false, italic: false, strike: false, code: false }] }] }],
      chapters: [{
        id: "one",
        title: "第一章",
        level: 1,
        blocks: [
          { kind: "paragraph", content: [
            { kind: "noteRef", id: "fn1" },
            { kind: "anchor", id: "target" },
            { kind: "link", content: [{ kind: "text", text: "跳转", bold: false, italic: false, strike: false, code: false }], target: { kind: "anchor", value: "target" } },
          ] },
        ],
      }],
    };

    const first = render(<EpubReader relativePath="dual.epub" document={document} locator={null} motionLevel="subtle" onTocChange={() => undefined} onActiveChange={() => undefined} />);
    const second = render(<EpubReader relativePath="dual.epub" document={document} locator={null} motionLevel="subtle" onTocChange={() => undefined} onActiveChange={() => undefined} />);

    const firstNote = first.container.querySelector("aside.epub-notes aside, .epub-notes aside") as HTMLElement | null;
    const secondNote = second.container.querySelector(".epub-notes aside") as HTMLElement | null;
    expect(firstNote).not.toBeNull();
    expect(secondNote).not.toBeNull();
    // 同一注释 id 在两个实例中渲染为不同 DOM id（命名空间互不冲突）。
    expect(firstNote!.id).not.toBe(secondNote!.id);
    // 每个实例内部的 noteRef href 指向自己实例的注释元素。
    const firstRef = first.container.querySelector<HTMLAnchorElement>("a.epub-note-ref")!;
    expect(first.container.querySelector(`#${CSS.escape(firstRef.getAttribute("href")!.slice(1))}`)).not.toBeNull();
    expect(second.container.querySelector(`#${CSS.escape(firstRef.getAttribute("href")!.slice(1))}`)).toBeNull();

    // 书内锚点链接在自己实例内解析目标，而不是全局第一个匹配。
    const secondInstanceLink = second.container.querySelector<HTMLAnchorElement>("a[href^='#epub-anchor']")!;
    const secondInstanceRoot = second.container.querySelector<HTMLElement>(".epub-reader")!;
    const targetInSecond = secondInstanceRoot.querySelector(`#${CSS.escape(secondInstanceLink.getAttribute("href")!.slice(1))}`);
    expect(targetInSecond).not.toBeNull();
    // 链接 click 不逃逸出实例（handleSelect 使用 closest(".epub-reader")）。
    fireEvent.click(secondInstanceLink);
    first.unmount();
    second.unmount();
  });

  // ---- D11: 图片资产按需加载 / 请求合并 / 引用计数释放 ----

  it("delays asset IPC until the image nears the viewport and merges duplicate requests", async () => {
    const document: EpubDocument = {
      title: "Lazy Book",
      assets: [{ id: 0, mediaType: "image/png", allowed: true, alt: "图" }],
      notes: [],
      chapters: [{
        id: "one",
        title: "第一章",
        level: 1,
        blocks: [
          { kind: "paragraph", content: [{ kind: "image", alt: "a", source: { kind: "asset", value: 0 } }] },
          { kind: "paragraph", content: [{ kind: "image", alt: "b", source: { kind: "asset", value: 0 } }] },
        ],
      }],
    };
    const view = render(<EpubReader relativePath="lazy.epub" document={document} locator={null} motionLevel="subtle" onTocChange={() => undefined} onActiveChange={() => undefined} />);
    // 可控 IO 未触发：不发生任何 IPC 读取（首屏不读全书图片）。
    expect(backendMocks.readEpubAsset).not.toHaveBeenCalled();

    triggerAllIntersections();
    await waitFor(() => expect(backendMocks.readEpubAsset).toHaveBeenCalledTimes(1));
    // 两个消费者共享一次读取。
    expect(view.container.querySelectorAll("img.epub-image")).toHaveLength(2);
    const firstSrc = view.container.querySelector("img.epub-image")!.getAttribute("src");
    expect(view.container.querySelectorAll("img.epub-image[src='" + firstSrc + "']")).toHaveLength(2);
    view.unmount();
  });

  it("revokes the shared blob url after the last consumer unmounts", async () => {
    const document: EpubDocument = {
      title: "Revoke Book",
      assets: [{ id: 0, mediaType: "image/png", allowed: true, alt: "图" }],
      notes: [],
      chapters: [{ id: "one", title: "第一章", level: 1, blocks: [{ kind: "paragraph", content: [{ kind: "image", alt: "a", source: { kind: "asset", value: 0 } }] }] }],
    };
    const createObjectURL = vi.fn(() => "blob:shared");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const first = render(<EpubReader relativePath="revoke.epub" document={document} locator={null} motionLevel="subtle" onTocChange={() => undefined} onActiveChange={() => undefined} />);
    const second = render(<EpubReader relativePath="revoke.epub" document={document} locator={null} motionLevel="subtle" onTocChange={() => undefined} onActiveChange={() => undefined} />);
    triggerAllIntersections();
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(backendMocks.readEpubAsset).toHaveBeenCalledTimes(1);

    first.unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    second.unmount();
    // 最后一个消费者卸载后才撤销。
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:shared");
  });
});