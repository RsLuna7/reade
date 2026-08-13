import { describe, expect, it } from "vitest";
import {
  CALIBRATION_MIN_SAMPLES,
  DEFAULT_CHARS_PER_MINUTE,
  READING_SPEED_MAX_CPM,
  READING_SPEED_MIN_CPM,
  aggregateActiveSeconds,
  calibrateReadingSpeed,
  estimateReadingMinutes,
  estimateRemainingMinutes,
  extentSupportsEstimate,
  formatReadingEstimate,
  formatRemainingEstimate,
  highWaterCoverage,
} from "./readingTimeEstimate";

/** N 篇同速文档的校准输入：600 秒读 5000 字 × coverage 1 → 500 字/分钟。 */
function uniformInput(count: number, charsPerMinute = 500) {
  const activeSecondsByPath = new Map<string, number>();
  const charsByPath = new Map<string, number>();
  const coverageByPath = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const path = `doc-${index}.md`;
    activeSecondsByPath.set(path, 600);
    charsByPath.set(path, charsPerMinute * 10);
    coverageByPath.set(path, 1);
  }
  return { activeSecondsByPath, charsByPath, coverageByPath };
}

describe("calibrateReadingSpeed", () => {
  it("falls back to the default speed below the sample floor", () => {
    const speed = calibrateReadingSpeed(uniformInput(CALIBRATION_MIN_SAMPLES - 1));
    expect(speed).toEqual({
      charsPerMinute: DEFAULT_CHARS_PER_MINUTE,
      samples: 0,
      calibrated: false,
    });
  });

  it("uses the per-document median once enough samples exist", () => {
    const input = uniformInput(CALIBRATION_MIN_SAMPLES, 420);
    const speed = calibrateReadingSpeed(input);
    expect(speed.calibrated).toBe(true);
    expect(speed.samples).toBe(CALIBRATION_MIN_SAMPLES);
    expect(speed.charsPerMinute).toBe(420);
  });

  it("resists outliers through the median (one idle marathon changes nothing)", () => {
    const input = uniformInput(6, 400);
    // 挂机文档:20000 秒只读了一点点 → 极低速样本。
    input.activeSecondsByPath.set("idle.md", 20_000);
    input.charsByPath.set("idle.md", 4_000);
    input.coverageByPath.set("idle.md", 1);
    const speed = calibrateReadingSpeed(input);
    expect(speed.calibrated).toBe(true);
    expect(speed.charsPerMinute).toBe(400);
  });

  it("filters noise samples: short sessions, low coverage, missing chars", () => {
    const input = uniformInput(CALIBRATION_MIN_SAMPLES, 500);
    input.activeSecondsByPath.set("short.md", 60); // < 120s
    input.charsByPath.set("short.md", 50_000);
    input.coverageByPath.set("short.md", 1);
    input.activeSecondsByPath.set("skim.md", 600); // coverage < 0.15
    input.charsByPath.set("skim.md", 50_000);
    input.coverageByPath.set("skim.md", 0.05);
    input.activeSecondsByPath.set("ghost.md", 600); // 无字符数
    const speed = calibrateReadingSpeed(input);
    expect(speed.samples).toBe(CALIBRATION_MIN_SAMPLES);
    expect(speed.charsPerMinute).toBe(500);
  });

  it("clamps absurd medians into the plausible band", () => {
    const fast = calibrateReadingSpeed(uniformInput(5, 90_000));
    expect(fast.charsPerMinute).toBe(READING_SPEED_MAX_CPM);
    const slow = calibrateReadingSpeed(uniformInput(5, 12));
    expect(slow.charsPerMinute).toBe(READING_SPEED_MIN_CPM);
  });

  it("scales effective chars by the coverage high-water mark (TE-D2)", () => {
    // 5000 字只读了一半(coverage 0.5),600 秒 → 250 字/分钟。
    const input = uniformInput(5, 500);
    for (const path of input.coverageByPath.keys()) {
      input.coverageByPath.set(path, 0.5);
    }
    expect(calibrateReadingSpeed(input).charsPerMinute).toBe(250);
  });
});

describe("coverage and extent gates", () => {
  it("derives coverage from scroll and pdf positions", () => {
    expect(
      highWaterCoverage({ kind: "scroll", scrollRatio: 0.3, maxScrollRatio: 0.62, updatedAt: 1 }),
    ).toBe(0.62);
    expect(
      highWaterCoverage(
        { kind: "pdf", page: 3, offsetRatio: 0, maxPage: 30, updatedAt: 1 },
        120,
      ),
    ).toBe(0.25);
    // PDF 无页数分母 → null;无位置 → null。
    expect(
      highWaterCoverage({ kind: "pdf", page: 3, offsetRatio: 0, maxPage: 30, updatedAt: 1 }),
    ).toBeNull();
    expect(highWaterCoverage(null)).toBeNull();
  });

  it("refuses estimates for scan-heavy or empty documents (TE-D5)", () => {
    expect(
      extentSupportsEstimate({ charCount: 9000, segmentCount: 10, needsOcrSegments: 0 }),
    ).toBe(true);
    expect(
      extentSupportsEstimate({ charCount: 9000, segmentCount: 10, needsOcrSegments: 5 }),
    ).toBe(true);
    expect(
      extentSupportsEstimate({ charCount: 9000, segmentCount: 10, needsOcrSegments: 6 }),
    ).toBe(false);
    expect(extentSupportsEstimate({ charCount: 0, segmentCount: 3, needsOcrSegments: 0 })).toBe(
      false,
    );
  });
});

describe("estimates and formatting", () => {
  it("ceils minutes and never reports zero", () => {
    expect(estimateReadingMinutes(1, 500)).toBe(1);
    expect(estimateReadingMinutes(501, 500)).toBe(2);
    expect(estimateReadingMinutes(0, 500)).toBe(1);
    // 非法速度回落默认值而不是除零。
    expect(estimateReadingMinutes(1000, 0)).toBe(2);
  });

  it("estimates the remaining minutes from the progress high-water mark", () => {
    const extent = { charCount: 5000, segmentCount: 10, needsOcrSegments: 0 };
    expect(estimateRemainingMinutes(extent, { kind: "ratio", value: 0.5 }, 500)).toBe(5);
    expect(estimateRemainingMinutes(extent, { kind: "page", page: 5 }, 500)).toBe(5);
    // 无进度 = 全文;读完 → null;扫描版 → null。
    expect(estimateRemainingMinutes(extent, null, 500)).toBe(10);
    expect(estimateRemainingMinutes(extent, { kind: "ratio", value: 1 }, 500)).toBeNull();
    expect(
      estimateRemainingMinutes(
        { charCount: 5000, segmentCount: 10, needsOcrSegments: 9 },
        null,
        500,
      ),
    ).toBeNull();
  });

  it("formats the three duration bands", () => {
    expect(formatReadingEstimate(1)).toBe("1 分钟内");
    expect(formatReadingEstimate(12)).toBe("约 12 分钟");
    expect(formatReadingEstimate(180)).toBe("约 180 分钟");
    expect(formatReadingEstimate(181)).toBe("约 3 小时");
    expect(formatReadingEstimate(300)).toBe("约 5 小时");
  });

  it("formats remaining labels with the sub-minute case", () => {
    expect(formatRemainingEstimate(1)).toBe("剩余不足 1 分钟");
    expect(formatRemainingEstimate(25)).toBe("剩余约 25 分钟");
    expect(formatRemainingEstimate(240)).toBe("剩余约 4 小时");
  });
});

describe("aggregateActiveSeconds", () => {
  it("sums sessions per document and skips non-positive values", () => {
    const byPath = aggregateActiveSeconds([
      { relativePath: "a.md", activeSeconds: 120 },
      { relativePath: "a.md", activeSeconds: 60 },
      { relativePath: "b.md", activeSeconds: 30 },
      { relativePath: "b.md", activeSeconds: 0 },
      { relativePath: "c.md", activeSeconds: Number.NaN },
    ]);
    expect(byPath.get("a.md")).toBe(180);
    expect(byPath.get("b.md")).toBe(30);
    expect(byPath.has("c.md")).toBe(false);
  });
});
