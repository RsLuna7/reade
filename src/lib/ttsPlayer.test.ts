import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  MAX_CONSECUTIVE_UTTERANCE_FAILURES,
  TTS_DEFAULT_RATE,
  TTS_MAX_RATE,
  TTS_MIN_RATE,
  TtsQueuePlayer,
  clampTtsRate,
  type TtsSpeakRequest,
  type TtsSpeechPort,
} from "./ttsPlayer";
import type { SentenceSegment } from "./ttsSegments";

function sentences(...texts: string[]): SentenceSegment[] {
  let offset = 0;
  return texts.map((text) => {
    const segment = { start: offset, end: offset + text.length, text };
    offset += text.length;
    return segment;
  });
}

/**
 * Scripted speechSynthesis double: records every speak request and lets the
 * test fire `onend`/`onerror` explicitly — including on stale (cancelled)
 * utterances, which is exactly the residual-event behaviour of the real
 * engine that the generation guard must absorb.
 */
class FakeSpeechPort implements TtsSpeechPort {
  requests: TtsSpeakRequest[] = [];
  cancelCount = 0;

  speak(request: TtsSpeakRequest): unknown {
    this.requests.push(request);
    return { text: request.text };
  }

  cancel(): void {
    this.cancelCount += 1;
  }

  last(): TtsSpeakRequest {
    const request = this.requests[this.requests.length - 1];
    if (!request) throw new Error("no utterance spoken yet");
    return request;
  }

  spokenTexts(): string[] {
    return this.requests.map((request) => request.text);
  }
}

describe("clampTtsRate", () => {
  it("clamps into the 0.5–2.0 range and maps invalid input to 1", () => {
    expect(clampTtsRate(0.1)).toBe(TTS_MIN_RATE);
    expect(clampTtsRate(5)).toBe(TTS_MAX_RATE);
    expect(clampTtsRate(1.5)).toBe(1.5);
    expect(clampTtsRate(Number.NaN)).toBe(TTS_DEFAULT_RATE);
    expect(clampTtsRate(Number.POSITIVE_INFINITY)).toBe(TTS_DEFAULT_RATE);
  });
});

describe("TtsQueuePlayer", () => {
  type BoundaryHandler = (index: number | null, sentence: SentenceSegment | null) => void;
  type StatusHandler = (status: "idle" | "playing" | "paused") => void;
  let port: FakeSpeechPort;
  let boundary: Mock<BoundaryHandler>;
  let statusChange: Mock<StatusHandler>;
  let finished: Mock<() => void>;
  let halted: Mock<(lastError: unknown) => void>;
  let player: TtsQueuePlayer;

  beforeEach(() => {
    port = new FakeSpeechPort();
    boundary = vi.fn<BoundaryHandler>();
    statusChange = vi.fn<StatusHandler>();
    finished = vi.fn<() => void>();
    halted = vi.fn<(lastError: unknown) => void>();
    player = new TtsQueuePlayer(port, {
      onSentenceChange: boundary,
      onStatusChange: statusChange,
      onFinished: finished,
      onHalted: halted,
    });
  });

  it("speaks sentences sequentially, advancing the cursor on each onend", () => {
    const queue = sentences("一。", "二。", "三。");
    player.play(queue);
    expect(player.getStatus()).toBe("playing");
    expect(player.hasUtteranceInFlight()).toBe(true);
    expect(port.spokenTexts()).toEqual(["一。"]);
    expect(boundary).toHaveBeenLastCalledWith(0, queue[0]);

    port.last().onEnd();
    expect(port.spokenTexts()).toEqual(["一。", "二。"]);
    expect(player.getCursor()).toBe(1);
    expect(boundary).toHaveBeenLastCalledWith(1, queue[1]);

    port.last().onEnd();
    expect(port.spokenTexts()).toEqual(["一。", "二。", "三。"]);

    port.last().onEnd();
    expect(player.getStatus()).toBe("idle");
    expect(boundary).toHaveBeenLastCalledWith(null, null);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(halted).not.toHaveBeenCalled();
    expect(player.hasUtteranceInFlight()).toBe(false);
  });

  it("starts from the requested index and clamps it into the queue", () => {
    const queue = sentences("一。", "二。", "三。");
    player.play(queue, 1);
    expect(port.spokenTexts()).toEqual(["二。"]);
    player.play(queue, 99);
    expect(port.last().text).toBe("三。");
  });

  it("stays idle without speaking for an empty queue", () => {
    player.play([]);
    expect(player.getStatus()).toBe("idle");
    expect(port.requests).toEqual([]);
    expect(finished).not.toHaveBeenCalled();
  });

  it("skips to the next sentence on a single utterance error", () => {
    player.play(sentences("一。", "二。"));
    port.last().onError(new Error("synthesis-failed"));
    expect(port.spokenTexts()).toEqual(["一。", "二。"]);
    expect(player.getStatus()).toBe("playing");
    expect(halted).not.toHaveBeenCalled();
  });

  it("halts after three consecutive failures without speaking further", () => {
    const queue = sentences("一。", "二。", "三。", "四。", "五。");
    player.play(queue);
    for (let count = 0; count < MAX_CONSECUTIVE_UTTERANCE_FAILURES; count += 1) {
      port.last().onError(new Error(`fail-${count}`));
    }
    expect(port.spokenTexts()).toEqual(["一。", "二。", "三。"]);
    expect(player.getStatus()).toBe("idle");
    expect(halted).toHaveBeenCalledTimes(1);
    expect(boundary).toHaveBeenLastCalledWith(null, null);
    expect(finished).not.toHaveBeenCalled();
  });

  it("resets the consecutive-failure counter on a successful sentence", () => {
    const queue = sentences("一。", "二。", "三。", "四。", "五。", "六。");
    player.play(queue);
    port.last().onError("e1"); // 一 fails
    port.last().onEnd(); // 二 succeeds, counter resets
    port.last().onError("e2"); // 三 fails
    port.last().onError("e3"); // 四 fails
    expect(player.getStatus()).toBe("playing");
    expect(halted).not.toHaveBeenCalled();
    port.last().onError("e4"); // 五 fails → third consecutive failure
    expect(halted).toHaveBeenCalledTimes(1);
    expect(port.spokenTexts()).toEqual(["一。", "二。", "三。", "四。", "五。"]);
  });

  it("discards stale onend callbacks after stop (generation guard)", () => {
    player.play(sentences("一。", "二。"));
    const stale = port.last();
    player.stop();
    expect(port.cancelCount).toBeGreaterThan(0);
    expect(player.getStatus()).toBe("idle");
    stale.onEnd(); // residual event from the cancelled utterance
    expect(port.spokenTexts()).toEqual(["一。"]);
    expect(player.getStatus()).toBe("idle");
    expect(finished).not.toHaveBeenCalled();
  });

  it("pauses by remembering the cursor and cancelling, resumes by re-speaking", () => {
    const queue = sentences("一。", "二。", "三。");
    player.play(queue);
    port.last().onEnd(); // now speaking 二
    const cancelsBefore = port.cancelCount;
    player.pause();
    expect(port.cancelCount).toBe(cancelsBefore + 1);
    expect(player.getStatus()).toBe("paused");
    expect(player.getCursor()).toBe(1);

    const stale = port.last();
    stale.onError("interrupted"); // residual cancel event must be ignored
    expect(player.getStatus()).toBe("paused");

    player.resume();
    expect(player.getStatus()).toBe("playing");
    // The current sentence restarts from its beginning (sentence-level pause).
    expect(port.spokenTexts()).toEqual(["一。", "二。", "二。"]);
  });

  it("re-speaks the current sentence at the new rate on setRate", () => {
    player.play(sentences("一。", "二。"));
    expect(port.last().rate).toBe(TTS_DEFAULT_RATE);
    player.setRate(1.5);
    expect(port.spokenTexts()).toEqual(["一。", "一。"]);
    expect(port.last().rate).toBe(1.5);
    // Clamped values apply too.
    player.setRate(99);
    expect(port.last().rate).toBe(TTS_MAX_RATE);
  });

  it("stores the rate without speaking while paused", () => {
    player.play(sentences("一。"));
    player.pause();
    const spoken = port.requests.length;
    player.setRate(0.75);
    expect(port.requests.length).toBe(spoken);
    player.resume();
    expect(port.last().rate).toBe(0.75);
  });

  it("passes the selected voice through and restarts on voice change while playing", () => {
    const voiceA = { name: "Voice A" } as unknown as SpeechSynthesisVoice;
    const voiceB = { name: "Voice B" } as unknown as SpeechSynthesisVoice;
    player.setVoice(voiceA);
    player.play(sentences("一。", "二。"));
    expect(port.last().voice).toBe(voiceA);
    player.setVoice(voiceB);
    expect(port.spokenTexts()).toEqual(["一。", "一。"]);
    expect(port.last().voice).toBe(voiceB);
  });

  it("jumps forward and backward while playing", () => {
    const queue = sentences("一。", "二。", "三。");
    player.play(queue);
    player.next();
    expect(port.last().text).toBe("二。");
    player.previous();
    expect(port.last().text).toBe("一。");
    // Boundary clamping: previous at 0 and next at the end are no-ops.
    const spoken = port.requests.length;
    player.previous();
    expect(port.requests.length).toBe(spoken);
    player.next();
    player.next();
    player.next();
    expect(port.last().text).toBe("三。");
  });

  it("moves the cursor without speaking when jumping while paused", () => {
    const queue = sentences("一。", "二。", "三。");
    player.play(queue);
    player.pause();
    const spoken = port.requests.length;
    player.next();
    expect(player.getCursor()).toBe(1);
    expect(port.requests.length).toBe(spoken);
    expect(boundary).toHaveBeenLastCalledWith(1, queue[1]);
    player.resume();
    expect(port.last().text).toBe("二。");
  });

  it("ignores jumps while idle", () => {
    player.next();
    player.previous();
    expect(port.requests).toEqual([]);
    expect(player.getStatus()).toBe("idle");
  });

  it("reports status transitions once per change", () => {
    player.play(sentences("一。"));
    player.pause();
    player.pause();
    player.resume();
    port.last().onEnd();
    expect(statusChange.mock.calls.map(([status]) => status)).toEqual([
      "playing",
      "paused",
      "playing",
      "idle",
    ]);
  });

  it("dispose stops playback and clears the queue", () => {
    player.play(sentences("一。", "二。"));
    player.dispose();
    expect(player.getStatus()).toBe("idle");
    expect(player.getSentenceCount()).toBe(0);
    expect(player.hasUtteranceInFlight()).toBe(false);
  });
});
