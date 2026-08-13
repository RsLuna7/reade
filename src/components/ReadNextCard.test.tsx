// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadNextCard } from "./ReadNextCard";

afterEach(cleanup);

describe("ReadNextCard (plan-read-next §3.2)", () => {
  it("shows the reason badge, title, format and estimate", () => {
    const view = render(
      <ReadNextCard
        title="第二章"
        format="pdf"
        reason="collection"
        estimate="约 4 分钟"
        motionLevel="off"
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(view.getByText("合集顺序")).toBeInTheDocument();
    expect(view.getByText("第二章")).toBeInTheDocument();
    expect(view.getByText("PDF")).toBeInTheDocument();
    expect(view.getByText("约 4 分钟")).toBeInTheDocument();
  });

  it("labels the folder and backlink tiers distinctly", () => {
    const view = render(
      <ReadNextCard
        title="下一篇"
        format="markdown"
        reason="folder"
        estimate={null}
        motionLevel="off"
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(view.getByText("同文件夹")).toBeInTheDocument();
    expect(view.getByText("MD")).toBeInTheDocument();

    view.rerender(
      <ReadNextCard
        title="下一篇"
        format="markdown"
        reason="backlinks"
        estimate={null}
        motionLevel="off"
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(view.getByText("关联最多")).toBeInTheDocument();
  });

  it("fires open and dismiss callbacks", () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    const view = render(
      <ReadNextCard
        title="第二章"
        format="epub"
        reason="folder"
        estimate={null}
        motionLevel="off"
        onOpen={onOpen}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: /第二章/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: /关闭推荐/ }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
