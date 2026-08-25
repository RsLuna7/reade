// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  AUTO_PACE_BIAS_DEFAULT,
  AUTO_PACE_BIAS_MAX,
  AUTO_PACE_BIAS_MIN,
  DWELL_MAX_MS,
  DWELL_MIN_MS,
  SESSION_FACTOR_DEFAULT,
  SESSION_FACTOR_MAX,
  SESSION_FACTOR_MIN,
  applyEarlyAdvance,
  applyOverdue,
  blockCharCount,
  blockMultiplier,
  classifyBlockElement,
  clampAutoPaceBias,
  clampSessionFactor,
  dwellMsForBlock,
  isOverdue,
  nextAutoPaceStatus,
  paceHintLabel,
} from "./autoPace";
import { DEFAULT_CHARS_PER_MINUTE } from "./readingTimeEstimate";

describe("blockMultiplier", () => {
  it("returns content-aware multipliers", () => {
    expect(blockMultiplier("heading")).toBe(0.55);
    expect(blockMultiplier("code")).toBe(1.8);
    expect(blockMultiplier("math")).toBe(1.6);
    expect(blockMultiplier("paragraph")).toBe(1);
    expect(blockMultiplier("other")).toBe(1);
  });
});

describe("classifyBlockElement", () => {
  it("classifies headings, code, math, and paragraphs", () => {
    const heading = document.createElement("h2");
    expect(classifyBlockElement(heading)).toBe("heading");

    const pre = document.createElement("pre");
    expect(classifyBlockElement(pre)).toBe("code");

    const math = document.createElement("div");
    math.className = "katex-display";
    expect(classifyBlockElement(math)).toBe("math");

    const paragraph = document.createElement("p");
    expect(classifyBlockElement(paragraph)).toBe("paragraph");

    expect(classifyBlockElement(null)).toBe("other");
  });
});

describe("blockCharCount", () => {
  it("counts non-whitespace characters", () => {
    const p = document.createElement("p");
    p.textContent = "你好  world\n\n";
    expect(blockCharCount(p)).toBe(7);
    expect(blockCharCount(null)).toBe(0);
  });
});

describe("clamp helpers", () => {
  it("clamps session factor and bias", () => {
    expect(clampSessionFactor(0.1)).toBe(SESSION_FACTOR_MIN);
    expect(clampSessionFactor(9)).toBe(SESSION_FACTOR_MAX);
    expect(clampSessionFactor(Number.NaN)).toBe(SESSION_FACTOR_DEFAULT);
    expect(clampAutoPaceBias(0.1)).toBe(AUTO_PACE_BIAS_MIN);
    expect(clampAutoPaceBias(9)).toBe(AUTO_PACE_BIAS_MAX);
    expect(clampAutoPaceBias(Number.NaN)).toBe(AUTO_PACE_BIAS_DEFAULT);
  });
});

describe("dwellMsForBlock", () => {
  it("scales with char count at default speed", () => {
    // 100 chars / 500 cpm = 0.2 minute = 12000ms
    expect(
      dwellMsForBlock({
        chars: 100,
        charsPerMinute: DEFAULT_CHARS_PER_MINUTE,
      }),
    ).toBe(12_000);
  });

  it("applies session factor, bias, and block kind", () => {
    const base = dwellMsForBlock({
      chars: 100,
      charsPerMinute: 500,
      sessionFactor: 1,
      bias: 1,
      kind: "paragraph",
    });
    const slowerSession = dwellMsForBlock({
      chars: 100,
      charsPerMinute: 500,
      sessionFactor: 1.5,
      bias: 1,
      kind: "paragraph",
    });
    const fasterBias = dwellMsForBlock({
      chars: 100,
      charsPerMinute: 500,
      sessionFactor: 1,
      bias: 1.5,
      kind: "paragraph",
    });
    const heading = dwellMsForBlock({
      chars: 100,
      charsPerMinute: 500,
      kind: "heading",
    });
    expect(slowerSession).toBeGreaterThan(base);
    expect(fasterBias).toBeLessThan(base);
    expect(heading).toBeLessThan(base);
  });

  it("clamps short and long blocks", () => {
    expect(dwellMsForBlock({ chars: 1, charsPerMinute: 500 })).toBe(DWELL_MIN_MS);
    expect(dwellMsForBlock({ chars: 100_000, charsPerMinute: 100 })).toBe(DWELL_MAX_MS);
  });
});

describe("learning signals", () => {
  it("early advance makes the next dwell shorter (factor down)", () => {
    const next = applyEarlyAdvance(1);
    expect(next).toBeLessThan(1);
    expect(next).toBeGreaterThanOrEqual(SESSION_FACTOR_MIN);
  });

  it("overdue makes the next dwell longer (factor up)", () => {
    const next = applyOverdue(1);
    expect(next).toBeGreaterThan(1);
    expect(next).toBeLessThanOrEqual(SESSION_FACTOR_MAX);
  });

  it("detects overdue past the ratio threshold", () => {
    expect(isOverdue(1350, 1000)).toBe(true);
    expect(isOverdue(1200, 1000)).toBe(false);
  });
});

describe("paceHintLabel", () => {
  it("labels relative pace", () => {
    expect(paceHintLabel(0.7)).toBe("偏快");
    expect(paceHintLabel(1)).toBe("适中");
    expect(paceHintLabel(1.4)).toBe("偏慢");
  });
});

describe("nextAutoPaceStatus", () => {
  it("walks enable → play → pause → end → disable", () => {
    expect(nextAutoPaceStatus("off", { type: "enable" })).toBe("armed");
    expect(nextAutoPaceStatus("armed", { type: "play" })).toBe("playing");
    expect(nextAutoPaceStatus("playing", { type: "pause" })).toBe("paused");
    expect(nextAutoPaceStatus("paused", { type: "play" })).toBe("playing");
    expect(nextAutoPaceStatus("playing", { type: "end" })).toBe("paused");
    expect(nextAutoPaceStatus("paused", { type: "disable" })).toBe("off");
  });

  it("ignores play while off", () => {
    expect(nextAutoPaceStatus("off", { type: "play" })).toBe("off");
  });
});
