import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractMarkdownTitle,
  generateWebLibrary,
  normalizedTextFingerprint,
} from "./generate-web-library.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("generateWebLibrary", () => {
  it("copies nested content and emits compatible manifest and search data", async () => {
    const root = await mkdtemp(join(tmpdir(), "reade-web-generator-"));
    temporaryDirectories.push(root);
    const source = join(root, "source");
    const output = join(root, "output");
    await mkdir(join(source, "指南", "images"), { recursive: true });
    await writeFile(join(source, "指南", "开始.md"), "# 中文开始\n\n可检索正文。\n", "utf8");
    await writeFile(join(source, "指南", "组件.mdx"), "无一级标题", "utf8");
    await writeFile(join(source, "指南", "images", "图 片.png"), new Uint8Array([1, 2, 3]));
    await writeFile(join(source, ".env"), "SECRET=must-not-be-published", "utf8");

    const result = await generateWebLibrary({
      sourceDirectory: source,
      outputDirectory: output,
      title: "测试阅读库",
      generatedAt: "2026-08-09T00:00:00.000Z",
    });

    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    const search = JSON.parse(await readFile(join(output, "search.json"), "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      title: "测试阅读库",
      generatedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(manifest.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "指南/开始.md", title: "中文开始", format: "markdown", indexStatus: "ready" }),
        expect.objectContaining({ relativePath: "指南/组件.mdx", title: "组件", format: "mdx", indexStatus: "ready" }),
      ]),
    );
    // Every document carries the reader-compatible content fingerprint used
    // for move detection (same definition as the desktop backend).
    for (const document of manifest.documents) {
      expect(document.contentHash).toMatch(/^ntxt:[0-9a-f]{64}$/);
    }
    expect(manifest.documents.find((document) => document.relativePath === "指南/开始.md").contentHash).toBe(
      normalizedTextFingerprint(Buffer.from("# 中文开始\n\n可检索正文。\n", "utf8")),
    );
    expect(search.documents).toContainEqual({
      relativePath: "指南/开始.md",
      title: "中文开始",
      content: "# 中文开始\n\n可检索正文。\n",
    });
    expect(await readFile(join(output, "library", "指南", "images", "图 片.png"))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    await expect(readFile(join(output, "library", ".env"))).rejects.toThrow();
    expect(result.copiedFileCount).toBe(3);
  });
});

describe("extractMarkdownTitle", () => {
  it("ignores headings in fences and supports setext headings", () => {
    expect(
      extractMarkdownTitle("```md\n# fake\n```\nReal title\n==========\n", "fallback.md"),
    ).toBe("Real title");
  });
});

describe("normalizedTextFingerprint", () => {
  it("strips one BOM and normalizes CRLF, keeping lone carriage returns", () => {
    const plain = normalizedTextFingerprint(Buffer.from("line1\nline2", "utf8"));
    expect(normalizedTextFingerprint(Buffer.from("line1\r\nline2", "utf8"))).toBe(plain);
    expect(
      normalizedTextFingerprint(Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("line1\r\nline2", "utf8"),
      ])),
    ).toBe(plain);
    expect(normalizedTextFingerprint(Buffer.from("line1\rline2", "utf8"))).not.toBe(plain);
  });

  it("matches the desktop implementation byte for byte", () => {
    // Pinned value shared with the Rust test
    // (user_store::normalized_text_fingerprint_strips_bom_and_normalizes_crlf)
    // so both implementations stay interchangeable.
    expect(normalizedTextFingerprint(Buffer.from("hello", "utf8"))).toBe(
      "ntxt:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
