import { describe, expect, it } from "vitest";
import {
  extractRelatedFragments,
  RELATED_MAX_FRAGMENTS,
  RELATED_MAX_TEXT_CHARS,
} from "./relatedFragments";
import { findRelatedWebPassages, type WebSearchDocument } from "./webLibrary";

/**
 * 双端契约用例表（片段抽取）。编号 F01..F13 同时约束：
 * - 本文件（TS 契约函数 / Web 端实现的输入）；
 * - `src-tauri/src/library.rs` 的 `extract_related_fragments` Rust 测试
 *   （注释引用同一编号）。任何一端变化必须同步另一端。
 *
 * F01 24 字纯 CJK 长句 → 3 个 8 字切片
 * F02 CJK 标点切分 run
 * F03 中英混排（长度降序）
 * F04 跨换行选区与空格选区产出相同片段
 * F05 全标点输入 → 空
 * F06 全空白输入 → 空
 * F07 <3 字符片段丢弃
 * F08 大小写不敏感去重（保留首个原始大小写）
 * F09 top-6 截断（长度降序 + 位置升序）
 * F10 2,000 字符截断
 * F11 `"`/`OR`/`NEAR`/`*` 保持字面（引号本身是分隔符）
 * F12 12 字 run 保持完整；13 字 run 切为 8+5
 * F13 切片余数 <3 字符丢弃
 */

describe("extractRelatedFragments contract cases", () => {
  it("F01: a 24-char CJK run slices into three 8-char windows", () => {
    const run = "控制系统的稳定性分析需要考虑相位裕度与增益裕度一";
    expect(Array.from(run)).toHaveLength(24);
    expect(extractRelatedFragments(run)).toEqual([
      "控制系统的稳定性",
      "分析需要考虑相位",
      "裕度与增益裕度一",
    ]);
  });

  it("F02: CJK punctuation splits runs", () => {
    expect(extractRelatedFragments("时域响应，频域响应；根轨迹")).toEqual([
      "时域响应",
      "频域响应",
      "根轨迹",
    ]);
  });

  it("F03: mixed CJK and English runs, length-descending", () => {
    expect(extractRelatedFragments("傅里叶变换 Fourier transform 基础知识")).toEqual([
      "transform",
      "Fourier",
      "傅里叶变换",
      "基础知识",
    ]);
  });

  it("F04: newlines and spaces produce identical fragments", () => {
    expect(extractRelatedFragments("foo\nbar baz")).toEqual(
      extractRelatedFragments("foo bar baz"),
    );
  });

  it("F05/F06: punctuation-only and whitespace-only input is empty", () => {
    expect(extractRelatedFragments("，。！？…—·「」")).toEqual([]);
    expect(extractRelatedFragments(" \t\r\n ")).toEqual([]);
  });

  it("F07: fragments below three characters are dropped", () => {
    expect(extractRelatedFragments("ab cd 你好 ok")).toEqual([]);
  });

  it("F08: case-insensitive dedupe keeps the first casing", () => {
    expect(extractRelatedFragments("Fourier fourier FOURIER")).toEqual(["Fourier"]);
  });

  it("F09: top-6 by length descending, position ascending on ties", () => {
    expect(
      extractRelatedFragments("alpha beta gamma delta epsilon zeta theta1"),
    ).toEqual(["epsilon", "theta1", "alpha", "gamma", "delta", "beta"]);
    expect(RELATED_MAX_FRAGMENTS).toBe(6);
  });

  it("F10: input beyond 2,000 characters is ignored", () => {
    const oversized = `${"填".repeat(RELATED_MAX_TEXT_CHARS - 3)}尾巴 marker-fragment`;
    const fragments = extractRelatedFragments(oversized);
    expect(fragments).not.toContain("marker-fragment");
  });

  it("F11: FTS syntax stays literal; quotes are delimiters", () => {
    expect(extractRelatedFragments('alpha "beta" OR NEAR(gamma) *star*')).toEqual([
      "alpha",
      "gamma",
      "beta",
      "NEAR",
      "star",
    ]);
  });

  it("F12/F13: the 12-char boundary and slice remainders", () => {
    expect(extractRelatedFragments("这一段恰好十二个字符长度")).toEqual([
      "这一段恰好十二个字符长度",
    ]);
    expect(extractRelatedFragments("这一段共有十三个字符长度啊")).toEqual([
      "这一段共有十三个",
      "字符长度啊",
    ]);
    const seventeen = "一二三四五六七八九十甲乙丙丁戊己庚";
    expect(Array.from(seventeen)).toHaveLength(17);
    expect(extractRelatedFragments(seventeen)).toEqual([
      "一二三四五六七八",
      "九十甲乙丙丁戊己",
    ]);
  });
});

describe("findRelatedWebPassages (RP-D5 simplified scoring)", () => {
  const documents: WebSearchDocument[] = [
    {
      relativePath: "notes/alpha.md",
      title: "Alpha",
      content: "傅里叶变换将时域信号映射到频域进行分析，是频谱方法的基础。",
    },
    {
      relativePath: "notes/gamma.mdx",
      title: "Gamma",
      content: "本章仅提到映射到频域这一个说法，与其余片段无关。",
    },
    {
      relativePath: "notes/self.md",
      title: "Self",
      content: "傅里叶变换将时域信号映射到频域进行分析。",
    },
    {
      relativePath: "notes/other.md",
      title: "Other",
      content: "毫无关系的内容，讲的是园艺技巧与浇水频率。",
    },
  ];

  it("scores fragment hits, excludes the source document and keeps SearchResult shape", () => {
    const results = findRelatedWebPassages(
      documents,
      "傅里叶变换将时域信号\n映射到频域",
      "notes/self.md",
    );
    expect(results.map((result) => result.relativePath)).toEqual([
      "notes/alpha.md",
      "notes/gamma.mdx",
    ]);
    // Two fragments hit alpha (10 + 5 chars), one hits gamma.
    expect(results[0].score).toBe(15);
    expect(results[1].score).toBe(5);
    expect(results[0].resultId).toBe("web:notes/alpha.md");
    expect(results[0].locator).toBeNull();
    expect(results[0].format).toBe("markdown");
    expect(results[1].format).toBe("mdx");
    expect(results[0].snippet).toContain("傅里叶变换");
  });

  it("returns empty for selections that normalize to nothing", () => {
    expect(findRelatedWebPassages(documents, "，。！？", null)).toEqual([]);
    expect(findRelatedWebPassages(documents, "ab", null)).toEqual([]);
  });

  it("caps repeated hits per fragment at three and clamps the limit", () => {
    const repeated: WebSearchDocument[] = [
      {
        relativePath: "many.md",
        title: "Many",
        content: "频域分析 频域分析 频域分析 频域分析 频域分析",
      },
      { relativePath: "once.md", title: "Once", content: "频域分析只出现一次。" },
    ];
    const results = findRelatedWebPassages(repeated, "频域分析", null);
    // min(count, 3) × 4 chars = 12 vs 1 × 4 = 4.
    expect(results.map((result) => [result.relativePath, result.score])).toEqual([
      ["many.md", 12],
      ["once.md", 4],
    ]);
    expect(findRelatedWebPassages(repeated, "频域分析", null, 0)).toHaveLength(1);
    expect(findRelatedWebPassages(repeated, "频域分析", null, 1)).toHaveLength(1);
  });
});
