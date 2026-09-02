import { describe, expect, it } from "vitest";
import {
  DEFAULT_CJK_READER_FONT_ID,
  DEFAULT_LATIN_READER_FONT_ID,
  DEFAULT_READER_FONT_PAIR_ID,
  READER_CJK_FONTS,
  READER_FONTS,
  READER_FONT_PAIRS,
  READER_LATIN_FONTS,
  normalizeReaderFontId,
  normalizeReaderFontMode,
  normalizeReaderFontPairId,
  resolveReaderFontSelection,
} from "./readerFonts";

const defaults = {
  fontFamily: "system" as const,
  fontMode: "theme" as const,
  fontPairId: DEFAULT_READER_FONT_PAIR_ID,
  cjkFontId: DEFAULT_CJK_READER_FONT_ID,
  latinFontId: DEFAULT_LATIN_READER_FONT_ID,
};

describe("reader font registry", () => {
  it("exposes every curated family and pairing without duplicating ids", () => {
    expect(READER_FONTS).toHaveLength(26);
    expect(READER_CJK_FONTS).toHaveLength(10);
    expect(READER_LATIN_FONTS).toHaveLength(16);
    expect(READER_FONT_PAIRS).toHaveLength(12);
    expect(new Set(READER_FONTS.map((font) => font.id)).size).toBe(26);
    expect(new Set(READER_FONT_PAIRS.map((pair) => pair.id)).size).toBe(12);
  });

  it("keeps the existing theme stack as the default", () => {
    const resolved = resolveReaderFontSelection(defaults);
    expect(resolved.mode).toBe("theme");
    expect(resolved.fonts).toEqual([]);
    expect(resolved.cssStack).toContain("Segoe UI");
    expect(resolved.cssStack).not.toContain("Reade ");
  });

  it("puts Latin before CJK for a curated mixed-script pairing", () => {
    const resolved = resolveReaderFontSelection({ ...defaults, fontMode: "pair" });
    expect(resolved.label).toBe("现代书卷");
    expect(resolved.fonts.map((font) => font.id)).toEqual([
      "source-serif-4",
      "source-han-serif-sc",
    ]);
    expect(resolved.cssStack).toBe(
      '"Reade source-serif-4", "Reade source-han-serif-sc", serif',
    );
  });

  it("surfaces explicit warnings for unverified advanced choices", () => {
    const resolved = resolveReaderFontSelection({
      ...defaults,
      fontMode: "custom",
      cjkFontId: "misans",
      latinFontId: "atkinson-hyperlegible",
    });
    expect(resolved.warnings.join(" ")).toContain("重新分发证据未独立核实");
    expect(resolved.warnings.join(" ")).toContain("仅来自本地索引");
  });

  it("normalizes unknown persisted ids to stable defaults", () => {
    expect(normalizeReaderFontMode("unknown")).toBe("theme");
    expect(normalizeReaderFontPairId("unknown")).toBe(DEFAULT_READER_FONT_PAIR_ID);
    expect(normalizeReaderFontId("unknown", DEFAULT_CJK_READER_FONT_ID)).toBe(
      DEFAULT_CJK_READER_FONT_ID,
    );
  });
});
