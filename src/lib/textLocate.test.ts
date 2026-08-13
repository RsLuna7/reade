import { describe, expect, it } from "vitest";
import {
  DEEPLINK_PARSE_MAX_CHARS,
  DEEPLINK_SHARE_MAX_CHARS,
  locateNormalizedText,
  normalizeShareText,
} from "./textLocate";

describe("normalizeShareText", () => {
  it("collapses whitespace runs and trims the edges", () => {
    expect(normalizeShareText("  三栏\n布局\t把  文档树 分开  ")).toBe(
      "三栏 布局 把 文档树 分开",
    );
  });

  it("returns an empty string for whitespace-only selections", () => {
    expect(normalizeShareText(" \n\t\u3000 ")).toBe("");
  });

  it("truncates to 120 code points without splitting surrogate pairs", () => {
    const emoji = "😀".repeat(DEEPLINK_SHARE_MAX_CHARS + 10);
    const truncated = normalizeShareText(emoji);
    expect(Array.from(truncated)).toHaveLength(DEEPLINK_SHARE_MAX_CHARS);
    // 截断结果必须仍是完整 emoji 序列(不劈代理对)。
    expect(truncated).toBe("😀".repeat(DEEPLINK_SHARE_MAX_CHARS));
  });

  it("truncates long CJK selections to the share budget", () => {
    const cjk = "汉".repeat(500);
    expect(normalizeShareText(cjk)).toBe("汉".repeat(DEEPLINK_SHARE_MAX_CHARS));
  });

  it("keeps short selections untouched", () => {
    expect(normalizeShareText("short 段落 text")).toBe("short 段落 text");
  });

  it("stays under the parse-side clamp", () => {
    expect(DEEPLINK_SHARE_MAX_CHARS).toBeLessThanOrEqual(DEEPLINK_PARSE_MAX_CHARS);
  });
});

describe("locateNormalizedText", () => {
  it("finds an exact substring and returns original offsets", () => {
    const haystack = "前言。目标段落在这里。后记。";
    const match = locateNormalizedText(haystack, "目标段落在这里");
    expect(match).toEqual({ start: 3, end: 10 });
    expect(haystack.slice(match!.start, match!.end)).toBe("目标段落在这里");
  });

  it("matches across newlines, repeated spaces and full-width spaces", () => {
    const haystack = "第一段结束。\n\n  目标\u3000句子   分了\n行。尾部。";
    const match = locateNormalizedText(haystack, "目标 句子 分了 行。");
    expect(match).not.toBeNull();
    expect(haystack.slice(match!.start, match!.end).replace(/\s+/g, " ")).toBe(
      "目标 句子 分了 行。",
    );
  });

  it("normalizes the query the same way as the haystack", () => {
    const haystack = "alpha beta gamma";
    expect(locateNormalizedText(haystack, "  alpha\nbeta ")).toEqual({
      start: 0,
      end: 10,
    });
  });

  it("returns the first occurrence when the text repeats", () => {
    const haystack = "重复句。中间。重复句。";
    expect(locateNormalizedText(haystack, "重复句")).toEqual({ start: 0, end: 3 });
  });

  it("locates emoji without corrupting surrogate offsets", () => {
    const haystack = "开头 😀🎯 结尾";
    const match = locateNormalizedText(haystack, "😀🎯");
    expect(haystack.slice(match!.start, match!.end)).toBe("😀🎯");
  });

  it("returns null when the text is missing or the query is blank", () => {
    expect(locateNormalizedText("正文内容", "不存在的句子")).toBeNull();
    expect(locateNormalizedText("正文内容", "   ")).toBeNull();
    expect(locateNormalizedText("", "任何")).toBeNull();
  });
});
