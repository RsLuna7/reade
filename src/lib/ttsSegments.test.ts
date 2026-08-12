import { describe, expect, it } from "vitest";
import {
  MAX_SENTENCE_CHARS,
  segmentSentences,
  segmentSentencesWithRegex,
  segmentSentencesWithSegmenter,
  sentenceSegmenterAvailable,
  type SentenceSegment,
} from "./ttsSegments";

/**
 * Structural invariants shared by both segmentation paths (plan-read-aloud
 * §5 M1): ascending, non-overlapping, offset-faithful, no blank segments,
 * whitespace-only gaps, and no non-whitespace character lost.
 */
function assertSegmentInvariants(text: string, segments: SentenceSegment[]): void {
  let previousEnd = 0;
  for (const segment of segments) {
    expect(segment.start).toBeGreaterThanOrEqual(previousEnd);
    expect(segment.end).toBeGreaterThan(segment.start);
    expect(segment.text).toBe(text.slice(segment.start, segment.end));
    expect(segment.text.trim().length).toBeGreaterThan(0);
    expect(segment.end - segment.start).toBeLessThanOrEqual(MAX_SENTENCE_CHARS);
    // Gaps between segments may only contain whitespace.
    expect(text.slice(previousEnd, segment.start).trim()).toBe("");
    previousEnd = segment.end;
  }
  expect(text.slice(previousEnd).trim()).toBe("");
  const strip = (value: string) => value.replace(/\s+/g, "");
  expect(segments.map((segment) => strip(segment.text)).join("")).toBe(strip(text));
}

/** Runs the same corpus through both paths; exact assertions per path stay in the tests. */
function bothPaths(text: string): SentenceSegment[][] {
  const paths = [segmentSentencesWithRegex(text)];
  const viaSegmenter = segmentSentencesWithSegmenter(text);
  if (viaSegmenter) paths.push(viaSegmenter);
  return paths;
}

describe("segmentSentencesWithRegex", () => {
  it("splits at CJK full stops, question and exclamation marks", () => {
    const text = "第一句。第二句！第三句？第四句";
    const segments = segmentSentencesWithRegex(text);
    expect(segments.map((segment) => segment.text)).toEqual([
      "第一句。",
      "第二句！",
      "第三句？",
      "第四句",
    ]);
    assertSegmentInvariants(text, segments);
  });

  it("keeps ellipsis runs inside the sentence they terminate", () => {
    const text = "欲言又止……然后开口。";
    const segments = segmentSentencesWithRegex(text);
    expect(segments.map((segment) => segment.text)).toEqual(["欲言又止……", "然后开口。"]);
    assertSegmentInvariants(text, segments);
  });

  it("attaches closing quotes and brackets to the preceding sentence", () => {
    const text = "他说：“到此为止。”然后离开了。（完）";
    const segments = segmentSentencesWithRegex(text);
    expect(segments.map((segment) => segment.text)).toEqual([
      "他说：“到此为止。”",
      "然后离开了。",
      "（完）",
    ]);
    assertSegmentInvariants(text, segments);
  });

  it("treats an ASCII period as terminal only before whitespace or end of input", () => {
    const text = "Version 1.2 shipped today. Next release soon.";
    const segments = segmentSentencesWithRegex(text);
    expect(segments.map((segment) => segment.text)).toEqual([
      "Version 1.2 shipped today.",
      "Next release soon.",
    ]);
    assertSegmentInvariants(text, segments);
  });

  it("splits long terminator-free runs at newlines before hard-chunking", () => {
    const first = "甲".repeat(200);
    const second = "乙".repeat(200);
    const text = `${first}\n${second}`;
    const segments = segmentSentencesWithRegex(text);
    expect(segments.map((segment) => segment.text)).toEqual([first, second]);
    assertSegmentInvariants(text, segments);
  });
});

describe("both segmentation paths", () => {
  it("agrees on plain CJK terminator corpora", () => {
    const text = "第一句。第二句！第三句？最后一句。";
    const viaSegmenter = segmentSentencesWithSegmenter(text, "zh");
    expect(viaSegmenter).not.toBeNull();
    expect(viaSegmenter).toEqual(segmentSentencesWithRegex(text));
  });

  it("never yields empty segments for English abbreviations (boundaries may differ)", () => {
    // e.g./Dr. boundaries legitimately differ between the two paths
    // (Intl.Segmenter suppresses breaks before lowercase); only the shared
    // structure is asserted here — the marked boundary-difference case.
    const text = "See e.g. the manual. Dr. Smith agreed. Done.";
    for (const segments of bothPaths(text)) {
      assertSegmentInvariants(text, segments);
      expect(segments.length).toBeGreaterThan(0);
    }
  });

  it("keeps mixed CJK/Latin corpora offset-faithful", () => {
    const text = "打开 README.md 查看说明。Then run the build! 结束？";
    for (const segments of bothPaths(text)) {
      assertSegmentInvariants(text, segments);
    }
  });

  it("re-splits sentences longer than the cap at clause separators", () => {
    const clause = "这个从句很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长";
    const text = `${Array.from({ length: 8 }, () => clause).join("，")}。`;
    expect(text.length).toBeGreaterThan(MAX_SENTENCE_CHARS);
    for (const segments of bothPaths(text)) {
      assertSegmentInvariants(text, segments);
      expect(segments.length).toBeGreaterThan(1);
      // Every cut lands right after a clause separator (except the final piece).
      for (const segment of segments.slice(0, -1)) {
        expect(segment.text.endsWith("，")).toBe(true);
      }
    }
  });

  it("hard-chunks separator-free oversized runs", () => {
    const text = "长".repeat(MAX_SENTENCE_CHARS * 2 + 17);
    for (const segments of bothPaths(text)) {
      assertSegmentInvariants(text, segments);
      expect(segments.length).toBe(3);
    }
  });

  it("returns an empty list for empty and whitespace-only input", () => {
    for (const input of ["", "   \n\t  "]) {
      expect(segmentSentencesWithRegex(input)).toEqual([]);
      const viaSegmenter = segmentSentencesWithSegmenter(input);
      if (viaSegmenter) expect(viaSegmenter).toEqual([]);
    }
  });

  it("drops whitespace-only sentences between real ones", () => {
    const text = "第一句。   \n  第二句。";
    for (const segments of bothPaths(text)) {
      expect(segments.map((segment) => segment.text)).toEqual(["第一句。", "第二句。"]);
      assertSegmentInvariants(text, segments);
    }
  });
});

describe("segmentSentences", () => {
  it("prefers Intl.Segmenter when the runtime provides it", () => {
    // Node ships Intl.Segmenter, so the main entry must match that path here.
    expect(sentenceSegmenterAvailable()).toBe(true);
    const text = "第一句。第二句！Third one? 最后。";
    expect(segmentSentences(text, "zh")).toEqual(segmentSentencesWithSegmenter(text, "zh"));
  });

  it("produces flattened-text offsets usable for range construction", () => {
    const text = "开头。中间句子！结尾";
    const segments = segmentSentences(text);
    for (const segment of segments) {
      expect(text.slice(segment.start, segment.end)).toBe(segment.text);
    }
  });
});
