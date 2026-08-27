// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
// ImmediateIntersectionObserver:observe 即回调 isIntersecting=true。
import "../test/setup";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
import { ReadingRuler } from "../components/ReadingRuler";
import type { ReaderMotionLevel } from "./motion";
import { useFocusMode, type FocusContentKind } from "./useFocusMode";

function stubRect(element: Element, rect: { top: number; bottom: number }): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: rect.top,
    left: 0,
    right: 600,
    top: rect.top,
    bottom: rect.bottom,
    width: 600,
    height: rect.bottom - rect.top,
    toJSON: () => ({}),
  } as DOMRect);
}

function Harness({
  spotlight,
  typewriter,
  kind,
  suspended = false,
  motionLevel = "subtle",
}: {
  spotlight: boolean;
  typewriter: boolean;
  kind: FocusContentKind | null;
  suspended?: boolean;
  motionLevel?: ReaderMotionLevel;
}) {
  const readerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  useFocusMode({
    readerRef,
    articleRef,
    enabledKind: kind,
    contentKey: "doc.md::original",
    spotlight,
    typewriter,
    typewriterSuspended: suspended,
    motionLevel,
  });
  return (
    <div ref={readerRef} data-testid="reader" className="reading-scroll">
      <div ref={articleRef} data-testid="article" className="article-shell">
        <div className="annotated-markdown">
          <article className="markdown-body">
            <p data-testid="block-1">one</p>
            <p data-testid="block-2">two</p>
            <p data-testid="block-3">three</p>
          </article>
        </div>
      </div>
    </div>
  );
}

/** 视口 0–400(参考线 180);块 2 覆盖 120–260,应成为当前块。 */
function stubHarnessRects(view: ReturnType<typeof render>): void {
  stubRect(view.getByTestId("reader"), { top: 0, bottom: 400 });
  stubRect(view.getByTestId("block-1"), { top: 0, bottom: 100 });
  stubRect(view.getByTestId("block-2"), { top: 120, bottom: 260 });
  stubRect(view.getByTestId("block-3"), { top: 280, bottom: 380 });
}

describe("useFocusMode spotlight (plan-focus-mode §3.1)", () => {
  it("marks the container and the block nearest the 45% line", async () => {
    const view = render(<Harness spotlight typewriter={false} kind="markdown" />);
    stubHarnessRects(view);

    await waitFor(() =>
      expect(view.getByTestId("block-2")).toHaveAttribute("data-focus-current"),
    );
    expect(view.getByTestId("article")).toHaveClass("focus-spotlight");
    expect(
      view.container.querySelector(".markdown-body[data-focus-container]"),
    ).not.toBeNull();
    expect(view.getByTestId("block-1")).not.toHaveAttribute("data-focus-current");
    expect(view.getByTestId("block-3")).not.toHaveAttribute("data-focus-current");
  });

  it("moves the mark as the reference line crosses into another block", async () => {
    const view = render(<Harness spotlight typewriter={false} kind="markdown" />);
    stubHarnessRects(view);
    await waitFor(() =>
      expect(view.getByTestId("block-2")).toHaveAttribute("data-focus-current"),
    );

    // 模拟滚动后块 3 覆盖参考线。
    stubRect(view.getByTestId("block-2"), { top: -100, bottom: 40 });
    stubRect(view.getByTestId("block-3"), { top: 60, bottom: 360 });
    fireEvent.scroll(view.getByTestId("reader"));
    await waitFor(() =>
      expect(view.getByTestId("block-3")).toHaveAttribute("data-focus-current"),
    );
    expect(view.getByTestId("block-2")).not.toHaveAttribute("data-focus-current");
  });

  it("leaves no residual class or attributes after disabling", async () => {
    const view = render(<Harness spotlight typewriter={false} kind="markdown" />);
    stubHarnessRects(view);
    await waitFor(() =>
      expect(view.getByTestId("block-2")).toHaveAttribute("data-focus-current"),
    );

    view.rerender(<Harness spotlight={false} typewriter={false} kind="markdown" />);
    expect(view.getByTestId("article")).not.toHaveClass("focus-spotlight");
    expect(view.container.querySelector("[data-focus-container]")).toBeNull();
    expect(view.container.querySelector("[data-focus-current]")).toBeNull();
  });

  it("stays inert when the content kind is null (PDF original, FM-D4)", () => {
    const view = render(<Harness spotlight typewriter={false} kind={null} />);
    stubHarnessRects(view);
    expect(view.getByTestId("article")).not.toHaveClass("focus-spotlight");
    expect(view.container.querySelector("[data-focus-container]")).toBeNull();
  });
});

describe("useFocusMode typewriter (plan-focus-mode §3.2)", () => {
  it("snaps the active block center to the 45% line after wheel + settle", async () => {
    const view = render(
      <Harness spotlight={false} typewriter kind="markdown" motionLevel="off" />,
    );
    stubHarnessRects(view);
    const reader = view.getByTestId("reader");

    fireEvent.wheel(reader);
    fireEvent.scroll(reader);
    // 块 2 中心 190、参考线 180 → 目标 scrollTop = 0 + 10。
    await waitFor(() => expect(reader.scrollTop).toBe(10), { timeout: 1500 });
  });

  it("does not snap while suspended (自动推进让位)", async () => {
    const view = render(
      <Harness spotlight={false} typewriter suspended kind="markdown" motionLevel="off" />,
    );
    stubHarnessRects(view);
    const reader = view.getByTestId("reader");

    fireEvent.wheel(reader);
    fireEvent.scroll(reader);
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(reader.scrollTop).toBe(0);
  });

  it("ignores scrolls that were not armed by wheel or navigation keys", async () => {
    const view = render(
      <Harness spotlight={false} typewriter kind="markdown" motionLevel="off" />,
    );
    stubHarnessRects(view);
    const reader = view.getByTestId("reader");

    // 程序化滚动(位置恢复/锚点跳转)没有武装,不触发吸附。
    fireEvent.scroll(reader);
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(reader.scrollTop).toBe(0);
  });
});

describe("ReadingRuler (plan-focus-mode §3.3)", () => {
  it("follows the pointer and hides on leave", async () => {
    const reader = document.createElement("div");
    document.body.append(reader);
    stubRect(reader, { top: 0, bottom: 400 });
    const readerRef = { current: reader };

    const view = render(
      <ReadingRuler readerRef={readerRef} fontSize={17} lineHeight={1.9} />,
    );
    expect(view.queryByTestId("reading-ruler")).toBeNull();

    fireEvent.pointerMove(reader, { clientY: 200 });
    await waitFor(() => expect(view.getByTestId("reading-ruler")).toBeInTheDocument());
    const ruler = view.getByTestId("reading-ruler");
    // 带高 = round(17 × 1.9) = 32;translateY = 200 - 0 - 16 = 184。
    expect(ruler.style.height).toBe("32px");
    expect(ruler.style.transform).toBe("translateY(184px)");

    fireEvent.pointerLeave(reader);
    await waitFor(() => expect(view.queryByTestId("reading-ruler")).toBeNull());
    reader.remove();
  });
});
