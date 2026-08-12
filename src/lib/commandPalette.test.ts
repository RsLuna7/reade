import { describe, expect, it } from "vitest";
import {
  PALETTE_RESULT_LIMIT,
  entryScore,
  filterPaletteEntries,
  hasCjk,
  normalizePaletteQuery,
  subsequenceScore,
  substringScore,
  tokenScore,
  type PaletteEntry,
} from "./commandPalette";

function entry(overrides: Partial<PaletteEntry> = {}): PaletteEntry {
  return {
    kind: "document",
    id: "doc:notes/readme.md",
    title: "README",
    subtitle: "notes/readme.md",
    ...overrides,
  };
}

describe("hasCjk", () => {
  it("detects CJK and kana, ignores pure ASCII", () => {
    expect(hasCjk("数学")).toBe(true);
    expect(hasCjk("かな")).toBe(true);
    expect(hasCjk("readme.md")).toBe(false);
    expect(hasCjk("pdf数学")).toBe(true);
  });
});

describe("substringScore", () => {
  it("scores prefix > word boundary > mid-word, misses return null", () => {
    const prefix = substringScore("rea", "readme");
    const boundary = substringScore("rea", "notes/readme");
    const midWord = substringScore("adm", "readme");
    expect(prefix).not.toBeNull();
    expect(boundary).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(prefix!).toBeGreaterThan(boundary!);
    expect(boundary!).toBeGreaterThan(midWord!);
    expect(substringScore("zzz", "readme")).toBeNull();
  });

  it("matches CJK substrings", () => {
    expect(substringScore("链接", "链接图谱")).not.toBeNull();
    expect(substringScore("图谱", "链接图谱")).not.toBeNull();
    expect(substringScore("谱图", "链接图谱")).toBeNull();
  });
});

describe("subsequenceScore", () => {
  it("matches in-order subsequences and rejects out-of-order ones", () => {
    expect(subsequenceScore("rdme", "readme")).not.toBeNull();
    expect(subsequenceScore("emdr", "readme")).toBeNull();
  });

  it("rewards consecutive runs over scattered hits", () => {
    const consecutive = subsequenceScore("read", "readme");
    const scattered = subsequenceScore("rm", "readme");
    expect(consecutive!).toBeGreaterThan(scattered!);
  });
});

describe("tokenScore", () => {
  it("prefers contiguous substring over subsequence", () => {
    const contiguous = tokenScore("read", "readme")!;
    const subsequence = subsequenceScore("read", "readme")!;
    expect(contiguous).toBeGreaterThan(subsequence);
  });

  it("falls back to subsequence for ASCII tokens only", () => {
    expect(tokenScore("rdme", "readme")).not.toBeNull();
    // CJK token 不做子序列（CP-D1）："数学" 不得命中 "数量学说"。
    expect(tokenScore("数学", "数量学说")).toBeNull();
    expect(tokenScore("数学", "考研数学一")).not.toBeNull();
  });
});

describe("entryScore", () => {
  it("requires every token to match somewhere (AND across fields)", () => {
    const item = entry({ title: "考研数学一", subtitle: "math/exam.pdf" });
    expect(entryScore(item, ["数学", "exam"])).not.toBeNull();
    expect(entryScore(item, ["数学", "zzz"])).toBeNull();
  });

  it("weights title over keywords over subtitle", () => {
    const titleHit = entryScore(entry({ title: "alpha", subtitle: "x", keywords: "" }), ["alpha"]);
    const keywordHit = entryScore(
      entry({ title: "x", subtitle: "y", keywords: "alpha" }),
      ["alpha"],
    );
    const subtitleHit = entryScore(entry({ title: "x", subtitle: "alpha" }), ["alpha"]);
    expect(titleHit!).toBeGreaterThan(keywordHit!);
    expect(keywordHit!).toBeGreaterThan(subtitleHit!);
  });

  it("matches case-insensitively against lowercased tokens", () => {
    expect(entryScore(entry({ title: "README" }), ["readme"])).not.toBeNull();
  });
});

describe("normalizePaletteQuery", () => {
  it("trims, lowercases and splits on whitespace", () => {
    expect(normalizePaletteQuery("  数学   PDF ")).toEqual(["数学", "pdf"]);
    expect(normalizePaletteQuery("   ")).toEqual([]);
  });
});

describe("filterPaletteEntries", () => {
  const documents: PaletteEntry[] = [
    entry({ id: "doc:a", title: "长文阅读", subtitle: "guides/长文阅读.md" }),
    entry({ id: "doc:b", title: "链接图谱", subtitle: "guides/链接图谱.md" }),
    entry({ id: "doc:c", title: "README", subtitle: "README.md" }),
  ];
  const collection: PaletteEntry = {
    kind: "collection",
    id: "col:1",
    title: "考研数学",
    badge: "合集",
  };
  const command: PaletteEntry = {
    kind: "command",
    id: "cmd:theme",
    title: "切换浅色/深色主题",
    keywords: "theme dark light",
    badge: "命令",
  };
  const all = [...documents, collection, command];

  it("returns entries in input order for an empty query", () => {
    expect(filterPaletteEntries(all, "").map((item) => item.id)).toEqual([
      "doc:a",
      "doc:b",
      "doc:c",
      "col:1",
      "cmd:theme",
    ]);
    expect(filterPaletteEntries(all, "   ", 2).map((item) => item.id)).toEqual([
      "doc:a",
      "doc:b",
    ]);
  });

  it("filters by CJK substring and drops misses", () => {
    expect(filterPaletteEntries(all, "图谱").map((item) => item.id)).toEqual(["doc:b"]);
    expect(filterPaletteEntries(all, "不存在")).toEqual([]);
  });

  it("matches commands through keywords", () => {
    expect(filterPaletteEntries(all, "dark").map((item) => item.id)).toEqual(["cmd:theme"]);
  });

  it("ranks title prefix hits above path-only hits", () => {
    const ranked = filterPaletteEntries(
      [
        entry({ id: "doc:path-only", title: "另一篇", subtitle: "readme/notes.md" }),
        entry({ id: "doc:title", title: "readme", subtitle: "misc/x.md" }),
      ],
      "readme",
    );
    expect(ranked.map((item) => item.id)).toEqual(["doc:title", "doc:path-only"]);
  });

  it("breaks ties by kind priority (document > collection > command)", () => {
    const tied: PaletteEntry[] = [
      { kind: "command", id: "cmd:x", title: "同名" },
      { kind: "collection", id: "col:x", title: "同名" },
      { kind: "document", id: "doc:x", title: "同名" },
    ];
    expect(filterPaletteEntries(tied, "同名").map((item) => item.id)).toEqual([
      "doc:x",
      "col:x",
      "cmd:x",
    ]);
  });

  it("caps results at the default limit", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      entry({ id: `doc:${index}`, title: `笔记 ${index}` }),
    );
    expect(filterPaletteEntries(many, "笔记")).toHaveLength(PALETTE_RESULT_LIMIT);
    expect(filterPaletteEntries(many, "笔记", 5)).toHaveLength(5);
  });

  it("supports mixed CJK + ASCII multi-token queries across fields", () => {
    const item = entry({
      id: "doc:mixed",
      title: "考研数学一真题",
      subtitle: "math/2026.pdf",
    });
    expect(filterPaletteEntries([item, ...documents], "数学 pdf").map((i) => i.id)).toEqual([
      "doc:mixed",
    ]);
  });
});
