import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { extractMarkdownTitle, generateWebLibrary } from "./generate-web-library.mjs";

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
      schemaVersion: 1,
      title: "测试阅读库",
      generatedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(manifest.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "指南/开始.md", title: "中文开始", isMdx: false }),
        expect.objectContaining({ relativePath: "指南/组件.mdx", title: "组件", isMdx: true }),
      ]),
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
