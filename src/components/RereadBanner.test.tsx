// @vitest-environment jsdom

import "../test/setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RereadBanner } from "./RereadBanner";

describe("RereadBanner", () => {
  it("shows the message with jump and acknowledge actions", () => {
    const onJump = vi.fn();
    const onAcknowledge = vi.fn();
    render(
      <RereadBanner
        message="自上次阅读后有更新：2 段修改"
        onJump={onJump}
        onAcknowledge={onAcknowledge}
      />,
    );

    expect(screen.getByRole("status", { name: "重读提示" })).toHaveTextContent(
      "自上次阅读后有更新：2 段修改",
    );
    fireEvent.click(screen.getByRole("button", { name: "下一处" }));
    expect(onJump).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "知道了，关闭重读提示" }));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it("hides the jump button for page-level and truncated diffs", () => {
    const { container } = render(
      <RereadBanner message="自上次阅读后有大量更新" onJump={null} onAcknowledge={() => {}} />,
    );

    expect(container.querySelector(".reread-banner-jump")).not.toBeInTheDocument();
    expect(container.querySelector(".reread-banner-dismiss")).toBeInTheDocument();
  });
});
