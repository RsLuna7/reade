// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpubDocument } from "../lib/backend";
import { EpubReader } from "./EpubReader";

class TestIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
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
      chapters: [{ id: "one", title: "第一章", blocks: [] }, { id: "two", title: "第二章", blocks: [] }],
    };
    render(<EpubReader relativePath="book.epub" document={document} locator={{ kind: "epubChapter", chapterId: "two" }} motionLevel="subtle" onTocChange={onTocChange} onActiveChange={() => undefined} />);
    expect(onTocChange).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ title: "第一章" }), expect.objectContaining({ title: "第二章" })]));
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
      chapters: [{ id: "one", title: "第一章", blocks: [] }, { id: "two", title: "第二章", blocks: [] }],
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
});
