// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "../test/setup";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoPace } from "./useAutoPace";
import type { FocusContentKind } from "./focusMode";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
  enabled = true,
  suspended = false,
  kind = "markdown" as FocusContentKind | null,
  bias = 1,
  onNotice,
}: {
  enabled?: boolean;
  suspended?: boolean;
  kind?: FocusContentKind | null;
  bias?: number;
  onNotice?: (message: string) => void;
}) {
  const readerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const pace = useAutoPace({
    readerRef,
    articleRef,
    enabledKind: kind,
    contentKey: "doc.md",
    enabled,
    suspended,
    charsPerMinute: 60_000,
    bias,
    motionLevel: "off",
    onNotice,
  });
  return (
    <div>
      <div data-testid="status">{pace.status}</div>
      <div data-testid="hint">{pace.paceHint}</div>
      <div data-testid="factor">{pace.sessionFactor}</div>
      <button type="button" data-testid="play" onClick={pace.play}>
        play
      </button>
      <button type="button" data-testid="pause" onClick={pace.pause}>
        pause
      </button>
      <button type="button" data-testid="toggle" onClick={pace.toggle}>
        toggle
      </button>
      <div ref={readerRef} data-testid="reader" className="reading-scroll">
        <div ref={articleRef} data-testid="article">
          <div className="annotated-markdown">
            <article className="markdown-body">
              <p data-testid="block-1">aaaa</p>
              <p data-testid="block-2">bbbb</p>
              <p data-testid="block-3">cccc</p>
            </article>
          </div>
        </div>
      </div>
    </div>
  );
}

function stubHarness(view: ReturnType<typeof render>): void {
  stubRect(view.getByTestId("reader"), { top: 0, bottom: 400 });
  stubRect(view.getByTestId("block-1"), { top: 0, bottom: 100 });
  stubRect(view.getByTestId("block-2"), { top: 120, bottom: 260 });
  stubRect(view.getByTestId("block-3"), { top: 280, bottom: 380 });
}

describe("useAutoPace", () => {
  it("arms when enabled and plays on demand", async () => {
    const view = render(<Harness />);
    stubHarness(view);
    await waitFor(() => expect(view.getByTestId("status").textContent).toBe("armed"));
    fireEvent.click(view.getByTestId("play"));
    await waitFor(() => expect(view.getByTestId("status").textContent).toBe("playing"));
  });

  it("advances to the next block after the dwell budget", async () => {
    vi.useFakeTimers();
    const view = render(<Harness />);
    stubHarness(view);
    await act(async () => {
      fireEvent.click(view.getByTestId("play"));
      await Promise.resolve();
    });
    expect(view.getByTestId("status").textContent).toBe("playing");
    const reader = view.getByTestId("reader") as HTMLDivElement;
    const before = reader.scrollTop;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(reader.scrollTop).not.toBe(before);
  });

  it("learns faster on early ArrowDown advance", async () => {
    vi.useFakeTimers();
    const view = render(<Harness />);
    stubHarness(view);
    await act(async () => {
      fireEvent.click(view.getByTestId("play"));
      await Promise.resolve();
    });
    expect(view.getByTestId("status").textContent).toBe("playing");
    const before = Number(view.getByTestId("factor").textContent);
    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowDown" });
    });
    expect(Number(view.getByTestId("factor").textContent)).toBeLessThan(before);
  });

  it("pauses when the document becomes hidden", async () => {
    const view = render(<Harness />);
    stubHarness(view);
    fireEvent.click(view.getByTestId("play"));
    await waitFor(() => expect(view.getByTestId("status").textContent).toBe("playing"));
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(view.getByTestId("status").textContent).toBe("paused"));
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("stays off when disabled", async () => {
    const view = render(<Harness enabled={false} />);
    stubHarness(view);
    expect(view.getByTestId("status").textContent).toBe("off");
    fireEvent.click(view.getByTestId("play"));
    expect(view.getByTestId("status").textContent).toBe("off");
  });
});
