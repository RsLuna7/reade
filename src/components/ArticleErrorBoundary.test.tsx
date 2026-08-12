// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleErrorBoundary } from "./ArticleErrorBoundary";

afterEach(cleanup);

// React 会把边界捕获的错误照常打到 console.error;静音以保持测试输出干净。
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function Body({ boom }: { boom: boolean }) {
  if (boom) throw new Error("render boom");
  return <p>正文内容</p>;
}

describe("ArticleErrorBoundary", () => {
  it("renders children when nothing fails", () => {
    render(
      <ArticleErrorBoundary resetKey="a.md">
        <Body boom={false} />
      </ArticleErrorBoundary>,
    );
    expect(screen.getByText("正文内容")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("catches a rendering error and shows the recoverable card instead of unmounting", () => {
    render(
      <ArticleErrorBoundary resetKey="a.md">
        <Body boom />
      </ArticleErrorBoundary>,
    );
    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent("文档渲染出错");
    expect(screen.getByRole("button", { name: "重新载入文档" })).toBeInTheDocument();
    expect(screen.queryByText("正文内容")).not.toBeInTheDocument();
  });

  it("re-mounts the children and calls onRetry when the reload button is clicked", () => {
    const onRetry = vi.fn();
    const view = render(
      <ArticleErrorBoundary resetKey="a.md" onRetry={onRetry}>
        <Body boom />
      </ArticleErrorBoundary>,
    );
    // 模拟「重新载入后内容恢复正常」:失败态下先更新子树 props。
    view.rerender(
      <ArticleErrorBoundary resetKey="a.md" onRetry={onRetry}>
        <Body boom={false} />
      </ArticleErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新载入文档" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText("正文内容")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears a sticky error automatically when the document (resetKey) changes", () => {
    const view = render(
      <ArticleErrorBoundary resetKey="a.md">
        <Body boom />
      </ArticleErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    view.rerender(
      <ArticleErrorBoundary resetKey="b.md">
        <Body boom={false} />
      </ArticleErrorBoundary>,
    );
    expect(screen.getByText("正文内容")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the card again if the retried content still crashes", () => {
    render(
      <ArticleErrorBoundary resetKey="a.md">
        <Body boom />
      </ArticleErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "重新载入文档" }));
    // 子树仍然抛错 → 回到失败态,而不是白屏或无限循环。
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
