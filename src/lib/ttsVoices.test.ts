// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VOICES_CHANGED_TIMEOUT_MS,
  filterLocalVoices,
  loadVoices,
  pickDefaultVoice,
  type VoiceInfo,
  type VoiceSource,
} from "./ttsVoices";

// Compile-time check: the real SpeechSynthesis satisfies the injected shape.
(null as unknown as SpeechSynthesis) satisfies VoiceSource<SpeechSynthesisVoice>;

function voice(overrides: Partial<VoiceInfo> = {}): VoiceInfo {
  return {
    name: "Microsoft Huihui",
    lang: "zh-CN",
    localService: true,
    default: false,
    ...overrides,
  };
}

class FakeVoiceSource implements VoiceSource<VoiceInfo> {
  private listeners = new Set<() => void>();

  constructor(private voices: VoiceInfo[] = []) {}

  getVoices(): VoiceInfo[] {
    return this.voices;
  }

  setVoices(voices: VoiceInfo[]): void {
    this.voices = voices;
  }

  fireVoicesChanged(): void {
    for (const listener of [...this.listeners]) listener();
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  addEventListener(_type: "voiceschanged", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "voiceschanged", listener: () => void): void {
    this.listeners.delete(listener);
  }
}

describe("loadVoices", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when the first getVoices call is non-empty", async () => {
    const source = new FakeVoiceSource([voice()]);
    await expect(loadVoices(source)).resolves.toHaveLength(1);
    expect(source.listenerCount()).toBe(0);
  });

  it("waits for voiceschanged when the list starts empty", async () => {
    const source = new FakeVoiceSource([]);
    const promise = loadVoices(source);
    source.setVoices([voice(), voice({ name: "Microsoft Kangkang" })]);
    source.fireVoicesChanged();
    await expect(promise).resolves.toHaveLength(2);
    expect(source.listenerCount()).toBe(0);
  });

  it("keeps waiting when voiceschanged fires while the list is still empty", async () => {
    const source = new FakeVoiceSource([]);
    const promise = loadVoices(source);
    source.fireVoicesChanged();
    source.setVoices([voice()]);
    source.fireVoicesChanged();
    await expect(promise).resolves.toHaveLength(1);
  });

  it("settles with the current (possibly empty) list after the timeout", async () => {
    const source = new FakeVoiceSource([]);
    const promise = loadVoices(source);
    vi.advanceTimersByTime(VOICES_CHANGED_TIMEOUT_MS);
    await expect(promise).resolves.toEqual([]);
    expect(source.listenerCount()).toBe(0);
  });
});

describe("filterLocalVoices", () => {
  it("drops every voice whose localService flag is not true", () => {
    const local = voice({ name: "Local voice" });
    const remote = voice({ name: "Cloud voice", localService: false });
    expect(filterLocalVoices([local, remote])).toEqual([local]);
  });

  it("drops voices whose name marks them as online, even with localService true", () => {
    const suspicious = voice({ name: "Microsoft Xiaoxiao Online (Natural)" });
    const safe = voice({ name: "Microsoft Huihui Desktop" });
    expect(filterLocalVoices([suspicious, safe])).toEqual([safe]);
    // Substrings of ordinary words must not match the blacklist.
    const onliner = voice({ name: "Onliner Voice" });
    expect(filterLocalVoices([onliner])).toEqual([onliner]);
  });

  it("returns an empty list (the feature-disable signal) when nothing passes", () => {
    expect(filterLocalVoices([voice({ localService: false })])).toEqual([]);
    expect(filterLocalVoices([])).toEqual([]);
  });
});

describe("pickDefaultVoice", () => {
  it("returns null for an empty list", () => {
    expect(pickDefaultVoice([], "zh-CN")).toBeNull();
  });

  it("prefers a language-prefix match over the flagged default", () => {
    const english = voice({ name: "English default", lang: "en-US", default: true });
    const chinese = voice({ name: "Chinese", lang: "zh-CN" });
    expect(pickDefaultVoice([english, chinese], "zh")).toBe(chinese);
    expect(pickDefaultVoice([english, chinese], "zh-TW")).toBe(chinese);
  });

  it("prefers the flagged default among several language matches", () => {
    const first = voice({ name: "zh first", lang: "zh-CN" });
    const flagged = voice({ name: "zh default", lang: "zh-TW", default: true });
    expect(pickDefaultVoice([first, flagged], "zh")).toBe(flagged);
  });

  it("falls back to the flagged default, then the first voice", () => {
    const plain = voice({ name: "plain", lang: "en-GB" });
    const flagged = voice({ name: "flagged", lang: "en-US", default: true });
    expect(pickDefaultVoice([plain, flagged], "fr")).toBe(flagged);
    expect(pickDefaultVoice([plain], "fr")).toBe(plain);
    expect(pickDefaultVoice([plain, flagged])).toBe(flagged);
  });
});
