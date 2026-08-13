import { describe, expect, it } from "vitest";
import {
  buildClozeCard,
  clozeBlankWidthEm,
  clozeModeForCard,
  normalizeReviewCardMode,
} from "./clozeCard";

describe("buildClozeCard (CZ-D1/CZ-D5)", () => {
  it("blanks the top-1 fragment of CJK prose and reassembles to the original", () => {
    const excerpt = "左侧文档树负责建立位置感，中间只承担阅读，右侧目录负责长文导航";
    const card = buildClozeCard(excerpt);
    expect(card).not.toBeNull();
    // extractRelatedFragments 的 top-1:最长 run(12 字)。
    expect(card!.blank).toBe("左侧文档树负责建立位置感");
    expect(card!.prefix).toBe("");
    expect(card!.suffix).toBe("，中间只承担阅读，右侧目录负责长文导航");
    expect(card!.prefix + card!.blank + card!.suffix).toBe(excerpt);
  });

  it("handles English text, keeping the first longest word as the blank", () => {
    const excerpt = "The quick brown fox jumps over the lazy dog";
    const card = buildClozeCard(excerpt);
    expect(card).not.toBeNull();
    // quick/brown/jumps 同长,稳定排序保留文本序的第一个。
    expect(card!.blank).toBe("quick");
    expect(card!.prefix).toBe("The ");
    expect(card!.prefix + card!.blank + card!.suffix).toBe(excerpt);
  });

  it("handles mixed CJK/Latin text", () => {
    const excerpt = "控制系统的 bandwidth 决定响应速度上限";
    const card = buildClozeCard(excerpt);
    expect(card).not.toBeNull();
    expect(card!.blank).toBe("bandwidth");
    expect(card!.prefix + card!.blank + card!.suffix).toBe(excerpt);
  });

  it("preserves newlines and full-width spaces in the untouched segments", () => {
    const multiline = "第一行有一些内容\n第二行也有更多内容";
    const multilineCard = buildClozeCard(multiline);
    expect(multilineCard).not.toBeNull();
    expect(multilineCard!.prefix + multilineCard!.blank + multilineCard!.suffix).toBe(multiline);

    const fullWidth = "甲乙丙丁戊己庚\u3000辛壬癸子丑寅卯辰";
    const fullWidthCard = buildClozeCard(fullWidth);
    expect(fullWidthCard).not.toBeNull();
    expect(fullWidthCard!.blank).toBe("辛壬癸子丑寅卯辰");
    expect(fullWidthCard!.prefix).toBe("甲乙丙丁戊己庚\u3000");
    expect(fullWidthCard!.prefix + fullWidthCard!.blank + fullWidthCard!.suffix).toBe(fullWidth);
  });

  it("blanks the first occurrence when the fragment repeats", () => {
    const excerpt = "重复片段甲乙丙丁，中间，重复片段甲乙丙丁";
    const card = buildClozeCard(excerpt);
    expect(card).not.toBeNull();
    expect(card!.prefix).toBe("");
    expect(card!.suffix).toBe("，中间，重复片段甲乙丙丁");
  });

  it("falls back (null) for blank or short excerpts", () => {
    expect(buildClozeCard("")).toBeNull();
    expect(buildClozeCard("   \n  ")).toBeNull();
    // trim 后 11 个 code point < 12。
    expect(buildClozeCard("十一个字符的摘录不够长")).toBeNull();
  });

  it("falls back when the remaining context would be too thin", () => {
    // 13 字单 run 切成 8+5:挖掉 8 字后仅剩 5 个非空白字符 < 6。
    expect(buildClozeCard("一二三四五六七八九十甲乙丙")).toBeNull();
    // 摘录恰好是单一片段:挖空后上下文为空。
    expect(buildClozeCard("整段都是一个长词没有分隔")).toBeNull();
  });
});

describe("clozeModeForCard (CZ-D6)", () => {
  it("passes through the explicit modes", () => {
    expect(clozeModeForCard("any-id", "excerpt")).toBe("excerpt");
    expect(clozeModeForCard("any-id", "cloze")).toBe("cloze");
  });

  it("maps mixed deterministically by FNV-1a parity", () => {
    // FNV-1a("") = 0x811c9dc5,奇数 → 摘录(锚定具体值防实现漂移)。
    expect(clozeModeForCard("", "mixed")).toBe("excerpt");
    const ids = Array.from({ length: 26 }, (_, i) => `id-${String.fromCharCode(97 + i)}`);
    const first = ids.map((id) => clozeModeForCard(id, "mixed"));
    const second = ids.map((id) => clozeModeForCard(id, "mixed"));
    expect(second).toEqual(first);
    expect(first).toContain("cloze");
    expect(first).toContain("excerpt");
  });
});

describe("clozeBlankWidthEm (CZ-D8)", () => {
  it("approximates CJK at 1em and Latin at 0.55em with clamping", () => {
    expect(clozeBlankWidthEm("左侧文档树负责建")).toBe(8);
    expect(clozeBlankWidthEm("quick")).toBe(2.8);
    expect(clozeBlankWidthEm("字")).toBe(2.5);
    expect(clozeBlankWidthEm("字".repeat(30))).toBe(16);
  });
});

describe("normalizeReviewCardMode (CZ-D9)", () => {
  it("keeps valid modes and falls back on junk", () => {
    expect(normalizeReviewCardMode("cloze")).toBe("cloze");
    expect(normalizeReviewCardMode("mixed")).toBe("mixed");
    expect(normalizeReviewCardMode("excerpt")).toBe("excerpt");
    expect(normalizeReviewCardMode("bogus")).toBe("excerpt");
    expect(normalizeReviewCardMode(42, "mixed")).toBe("mixed");
    expect(normalizeReviewCardMode(undefined)).toBe("excerpt");
  });
});
