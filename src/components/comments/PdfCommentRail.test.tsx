// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, useRef } from "react";
import type { Annotation } from "../../lib/backend";
import { PdfCommentRail } from "./PdfCommentRail";

const threads = [
  { id: "thread-a", annotationId: "a", createdAt: 1, updatedAt: 1, deletedAt: null },
  { id: "thread-b", annotationId: "b", createdAt: 2, updatedAt: 2, deletedAt: null },
  { id: "thread-missing", annotationId: "missing", createdAt: 3, updatedAt: 3, deletedAt: null },
];
const messages = [
  { id: "message-a", threadId: "thread-a", authorId: "local-me", body: "甲评论", createdAt: 1, updatedAt: 1, deletedAt: null },
  { id: "message-b", threadId: "thread-b", authorId: "local-me", body: "乙评论", createdAt: 2, updatedAt: 2, deletedAt: null },
];
const authors = [
  { id: "local-me", name: "我", isDefault: true, createdAt: 1, updatedAt: 1, deletedAt: null },
];
const annotations: Annotation[] = [
  {
    id: "a",
    relativePath: "paper.pdf",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "A",
    title: null,
    locator: { kind: "pdf", page: 2, view: "original", quote: "A", prefix: "", suffix: "", rects: [] },
    sortIndex: "P|00002|00000000",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "b",
    relativePath: "paper.pdf",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "B",
    title: null,
    locator: { kind: "pdf", page: 2, view: "original", quote: "B", prefix: "", suffix: "", rects: [] },
    sortIndex: "P|00002|00000001",
    createdAt: 2,
    updatedAt: 2,
  },
];

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    if (!(target instanceof HTMLElement) || !target.classList.contains("pdf-comment-card-position")) return;
    const height = target.dataset.annotationId === "a" ? 80 : 100;
    this.callback(
      [{ target, contentRect: { height } as DOMRectReadOnly }] as unknown as ResizeObserverEntry[],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

function Harness({
  active = "a",
  reflowKey = "test",
  onActivate = vi.fn(),
  onReply = vi.fn(async () => undefined),
}: {
  active?: string | null;
  reflowKey?: string;
  onActivate?: (annotationId: string) => void;
  onReply?: (threadId: string, body: string, authorId: string) => Promise<unknown>;
}) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={layoutRef} className="test-layout">
      <div ref={anchorRef}>
        <span className="pdf-user-highlight pdf-user-highlight--lead" data-annotation-id="a" />
        <span className="pdf-user-highlight" data-annotation-id="a" />
        <span className="pdf-user-highlight pdf-user-highlight--lead" data-annotation-id="b" />
      </div>
      <PdfCommentRail
        anchorRootRef={anchorRef}
        layoutRootRef={layoutRef}
        threads={threads}
        messages={messages}
        authors={authors}
        annotations={annotations}
        activeAnnotationId={active}
        reflowKey={reflowKey}
        onActivate={onActivate}
        onReply={onReply}
      />
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return [{ top: 0 }] as unknown as DOMRectList;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("test-layout")) return { top: 100 } as DOMRect;
    if (this.dataset.annotationId === "a" && this.classList.contains("pdf-user-highlight")) {
      return { top: this.classList.contains("pdf-user-highlight--lead") ? 220 : 280 } as DOMRect;
    }
    if (this.dataset.annotationId === "b" && this.classList.contains("pdf-user-highlight")) {
      return { top: 250 } as DOMRect;
    }
    return { top: 0 } as DOMRect;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PdfCommentRail", () => {
  it("lays out after a StrictMode effect remount", async () => {
    // Regression: the reflow cleanup cancelled its rAF without clearing the
    // slot, so after StrictMode's double-mount every later scheduleReflow()
    // saw a pending frame and the rail stayed permanently empty.
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    await waitFor(() => expect(document.querySelectorAll(".pdf-comment-card")).toHaveLength(2));
  });

  it("renders anchored threads, omits missing anchors, and stacks measured cards", async () => {
    render(<Harness />);
    await waitFor(() => expect(document.querySelectorAll(".pdf-comment-card")).toHaveLength(2));
    expect(screen.getByText("甲评论")).toBeInTheDocument();
    expect(screen.getByText("乙评论")).toBeInTheDocument();
    expect(document.querySelector('[data-comment-thread-id="thread-missing"]')).toBeNull();
    await waitFor(() => {
      const first = document.querySelector<HTMLElement>('.pdf-comment-card-position[data-annotation-id="a"]');
      const second = document.querySelector<HTMLElement>('.pdf-comment-card-position[data-annotation-id="b"]');
      expect(first).toHaveStyle({ top: "120px" });
      expect(second).toHaveStyle({ top: "212px" });
    });
    expect(document.querySelector('[data-comment-thread-id="thread-a"]')).toHaveClass("is-active");
  });

  it("keeps laid-out cards when zoom preview collapses every highlight", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const view = render(<Harness />);
    await waitFor(() => expect(document.querySelectorAll(".pdf-comment-card")).toHaveLength(2));
    rect.mockImplementation(() => ({ top: 0, width: 0, height: 0 }) as DOMRect);
    view.rerender(<Harness reflowKey="zoom-preview" />);
    await waitFor(() => expect(document.querySelectorAll(".pdf-comment-card")).toHaveLength(2));
    expect(document.querySelector<HTMLElement>('.pdf-comment-card-position[data-annotation-id="a"]'))
      .toHaveStyle({ top: "120px" });
  });

  it("activates from the card and submits replies with the annotation mapping intact", async () => {
    const onActivate = vi.fn();
    const onReply = vi.fn(async () => undefined);
    render(<Harness onActivate={onActivate} onReply={onReply} />);
    await waitFor(() => expect(screen.getByText("甲评论")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: /讨论第 2 页/ })[0]!);
    expect(onActivate).toHaveBeenCalledWith("a");
    fireEvent.change(screen.getByRole("textbox", { name: "回复讨论" }), {
      target: { value: "一条回复" },
    });
    fireEvent.click(screen.getByRole("button", { name: "回复" }));
    expect(onReply).toHaveBeenCalledWith("thread-a", "一条回复", "local-me");
  });
});
