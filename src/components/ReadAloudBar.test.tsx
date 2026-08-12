// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadAloudBar } from "./ReadAloudBar";

afterEach(cleanup);

const baseProps = {
  status: "playing" as const,
  sentenceIndex: 2,
  sentenceCount: 40,
  rate: 1.2,
  voices: [
    { name: "Huihui", lang: "zh-CN" },
    { name: "Zira", lang: "en-US" },
  ],
  voiceName: "Huihui",
  onToggle: vi.fn(),
  onPrevious: vi.fn(),
  onNext: vi.fn(),
  onRestart: vi.fn(),
  onRateChange: vi.fn(),
  onVoiceChange: vi.fn(),
  onStop: vi.fn(),
};

describe("ReadAloudBar", () => {
  it("drives the transport controls and announces progress politely", () => {
    const onToggle = vi.fn();
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const onRestart = vi.fn();
    const onStop = vi.fn();
    const view = render(
      <ReadAloudBar
        {...baseProps}
        onToggle={onToggle}
        onPrevious={onPrevious}
        onNext={onNext}
        onRestart={onRestart}
        onStop={onStop}
      />,
    );

    expect(screen.getByRole("toolbar", { name: "朗读控制" })).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "暂停朗读" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "上一句" }));
    fireEvent.click(screen.getByRole("button", { name: "下一句" }));
    fireEvent.click(screen.getByRole("button", { name: "从头朗读" }));
    fireEvent.click(screen.getByRole("button", { name: "停止朗读并关闭" }));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);

    const progress = view.container.querySelector(".read-aloud-progress");
    expect(progress).toHaveAttribute("aria-live", "polite");
    expect(progress).toHaveTextContent("第 3 / 40 句");
  });

  it("shows the play affordance and pause label while paused", () => {
    render(<ReadAloudBar {...baseProps} status="paused" sentenceIndex={null} />);
    const toggle = screen.getByRole("button", { name: "继续朗读" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("已暂停")).toBeInTheDocument();
  });

  it("changes rate and voice through the labelled controls", () => {
    const onRateChange = vi.fn();
    const onVoiceChange = vi.fn();
    render(
      <ReadAloudBar {...baseProps} onRateChange={onRateChange} onVoiceChange={onVoiceChange} />,
    );

    fireEvent.change(screen.getByRole("slider", { name: "朗读语速" }), {
      target: { value: "1.5" },
    });
    expect(onRateChange).toHaveBeenCalledWith(1.5);

    const select = screen.getByRole("combobox", { name: "朗读语音" });
    expect(select).toHaveValue("Huihui");
    fireEvent.change(select, { target: { value: "Zira" } });
    expect(onVoiceChange).toHaveBeenCalledWith("Zira");
  });
});
