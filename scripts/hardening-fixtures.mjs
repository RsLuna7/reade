#!/usr/bin/env node
/**
 * Hardening 合成夹具生成器（D00/D10）。
 *
 * 产出（默认全部在 output/hardening/fixtures/ 下，已被 .gitignore 覆盖）：
 *   library-a/            测试书库 A：MD（中英文/公式/代码/图片/重复锚点/[[wiki]]）+ 最小 PDF + 最小 EPUB
 *   library-b/            测试书库 B：与 A 同相对路径、不同字节内容；不同图片
 * 用法：
 *   node scripts/hardening-fixtures.mjs                 # 生成 A/B
 *   node scripts/hardening-fixtures.mjs --large N       # 另生成 large-library/（N 篇合成 MD，默认 5000，D10 用）
 *
 * 平台要求：Node 18+（仅用 fs/path/zlib，无第三方依赖）。
 * 清理范围：整目录删除 output/hardening/fixtures 即可，无持久副作用。
 * 契约：任何写入失败即非零退出；不写 fixtures 之外的路径。
 */

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(process.cwd(), "output", "hardening", "fixtures");

function fail(message) {
  console.error(`hardening-fixtures: ${message}`);
  process.exit(1);
}

function write(outDir, relativePath, data) {
  const target = path.join(outDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}

// ---------------------------------------------------------------------------
// ZIP（stored/deflate）最小实现 —— EPUB 合成用
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** entries: [{ name: string, data: Uint8Array, compress?: boolean }] */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const method = entry.compress ? 8 : 0;
    let payload = entry.data;
    let compressedSize = entry.data.length;
    if (entry.compress) {
      payload = deflateRawSync(entry.data);
      compressedSize = payload.length;
    }
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2100, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    locals.push(local, Buffer.from(payload));

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2100, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + payload.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

// ---------------------------------------------------------------------------
// 最小 PDF（一页，可提取文本）
// ---------------------------------------------------------------------------

function buildMinimalPdf(lines) {
  const textOps = lines
    .map((line, index) => {
      const escaped = line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      return `BT /F1 14 Tf 50 ${740 - index * 24} Td (${escaped}) Tj ET`;
    })
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${textOps.length} >>\nstream\n${textOps}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// ---------------------------------------------------------------------------
// 最小 EPUB（两章 + 一张图 + 脚注锚点）
// ---------------------------------------------------------------------------

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function buildEpub(title, chapterBodies, imageSeed) {
  const chapters = chapterBodies.map((body, index) => ({
    id: `chapter${index + 1}`,
    href: `chapter${index + 1}.xhtml`,
    xhtml: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title} — ${index + 1}</title></head>
<body><h1 id="chapter${index + 1}">${title} 第 ${index + 1} 章</h1>${body}</body>
</html>`,
  }));
  const opfItems = chapters
    .map(
      (chapter) =>
        `<item id="c-${chapter.id}" href="${chapter.href}" media-type="application/xhtml+xml"/>`,
    )
    .join("\n    ");
  const spineRefs = chapters.map((chapter) => `<itemref idref="c-${chapter.id}"/>`).join("\n    ");
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${createHash("sha256").update(title).digest("hex").slice(0, 32)}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="pic" href="images/pic1.png" media-type="image/png"/>
    ${opfItems}
  </manifest>
  <spine>
    ${spineRefs}
  </spine>
</package>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
${chapters.map((chapter) => `<li><a href="${chapter.href}">第 ${chapter.id.slice(-1)} 章</a></li>`).join("\n")}
</ol></nav></body></html>`;
  const image = Buffer.from(TINY_PNG);
  image.writeUInt32LE(imageSeed, image.length - 8);
  const entries = [
    { name: "mimetype", data: Buffer.from("application/epub+zip", "utf8") },
    {
      name: "META-INF/container.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
        "utf8",
      ),
    },
    { name: "OEBPS/content.opf", data: Buffer.from(opf, "utf8"), compress: true },
    { name: "OEBPS/nav.xhtml", data: Buffer.from(nav, "utf8"), compress: true },
    { name: "OEBPS/images/pic1.png", data: image },
    ...chapters.map((chapter) => ({
      name: `OEBPS/${chapter.href}`,
      data: Buffer.from(chapter.xhtml, "utf8"),
      compress: true,
    })),
  ];
  return buildZip(entries);
}

// ---------------------------------------------------------------------------
// 书库 A / B
// ---------------------------------------------------------------------------

function mdGuideA() {
  return `# 阅读指南 A

中英混排与公式：质能方程 $E = mc^2$，以及行间公式：

$$\\\\int_0^1 x^2\\\\,dx = \\\\frac{1}{3}$$

## 重复锚点标题

这一段在库 A 中存在，用于同路径跨库内容校验。

\`\`\`rust
fn main() {
    println!("library A");
}
\`\`\`

![配图](assets/pic.png)

链接到 [[same-name]] 与 [[notes/blank]]。

## 结论

库 A 独有的结论段落。
`;
}

function mdGuideB() {
  return `# 阅读指南 B

Library B uses the same relative path with different bytes.

## 重复锚点标题

This paragraph exists only in library B.

\`\`\`python
print("library B")
\`\`\`

![配图](assets/pic.png)

链接到 [[same-name]]。

## 结语

库 B 独有的结语段落。
`;
}

function generateBaseLibraries() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });

  const libraries = {
    "library-a": {
      guide: mdGuideA(),
      sameName: `# 同名文档（A）

A 库的同名文档内容，用于跨库竞态与资产校验。

- 条目 1（A）
- 条目 2（A）
`,
      wikiTarget: `# 空白笔记

被 [[notes/blank]] 引用的目标（A 库版本）。
`,
      pdfText: ["Library A — synthetic PDF", "Page one of library A sample."],
      pdfAlt: ["Library A — alternate PDF", "Used for same-name cross-library range checks."],
      epubTitle: "合成书 A",
      epubChapter2:
        '<p id="note-anchor">带脚注的段落<sup><a epub:type="noteref" href="#fn1" id="fnref1">1</a></sup>。</p><img src="images/pic1.png" alt="图"/>',
      imageSeed: 0x00000a0a,
    },
    "library-b": {
      guide: mdGuideB(),
      sameName: `# 同名文档（B）

B 库的同名文档内容完全不同。

- 条目 1（B）
- 条目 2（B）
- 条目 3（B）
`,
      wikiTarget: `# 空白笔记

B 库版本的目标文档。
`,
      pdfText: ["Library B — synthetic PDF", "Different bytes at the same relative path."],
      pdfAlt: ["Library B — alternate PDF", "Range bytes must never cross libraries."],
      epubTitle: "合成书 B",
      epubChapter2:
        '<p id="note-anchor">另一本同章节名书籍的脚注段落<sup><a epub:type="noteref" href="#fn1" id="fnref1">1</a></sup>。</p><img src="images/pic1.png" alt="图"/>',
      imageSeed: 0x00000b0b,
    },
  };

  for (const [dirName, spec] of Object.entries(libraries)) {
    const outDir = path.join(ROOT, dirName);
    fs.mkdirSync(outDir, { recursive: true });
    write(outDir, "guide.md", spec.guide);
    write(outDir, "notes/same-name.md", spec.sameName);
    write(outDir, "notes/blank.md", spec.wikiTarget);
    // 重复标题锚点：同文档两个同名标题（rehype-slug 会生成 -1 后缀）
    write(
      outDir,
      "docs/duplicate-anchors.md",
      `# 重复锚点\n\n## 小节\n\n第一次出现。\n\n## 小节\n\n第二次出现。\n`,
    );
    write(
      outDir,
      "assets/pic.png",
      (() => {
        const png = Buffer.from(TINY_PNG);
        png.writeUInt32LE(spec.imageSeed, png.length - 8);
        return png;
      })(),
    );
    write(outDir, "papers/sample.pdf", buildMinimalPdf(spec.pdfText));
    write(outDir, "papers/alt.pdf", buildMinimalPdf(spec.pdfAlt));
    write(
      outDir,
      "books/sample.epub",
      buildEpub(
        spec.epubTitle,
        [
          '<p>第一章开头。这张图来自本书资产：<img src="images/pic1.png" alt="章节图"/></p>',
          spec.epubChapter2,
        ],
        spec.imageSeed,
      ),
    );
  }
  console.log(`fixtures: wrote library-a and library-b under ${ROOT}`);
}

// ---------------------------------------------------------------------------
// D10 大书库（--large N）
// ---------------------------------------------------------------------------

function generateLargeLibrary(count) {
  if (!Number.isInteger(count) || count < 1 || count > 50_000) {
    fail("--large N requires an integer 1..50000");
  }
  const outDir = path.join(ROOT, "large-library");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const paragraph = "长文合成段落，用于扫描与索引预算测量，包含中文、English、与 inline code。".repeat(
    12,
  );
  // ~20 KiB/file ≈ 5000 * 20 KiB ≈ 100 MiB（计划 §4 D10 样本表）
  const paragraphsPerFile = 24;
  for (let i = 0; i < count; i += 1) {
    const folder = `batch-${Math.floor(i / 500)}`;
    const body = Array.from(
      { length: paragraphsPerFile },
      (_, p) => `## 第 ${p + 1} 节\n\n文档 ${i} 的${paragraph}\n`,
    ).join("\n");
    write(outDir, `${folder}/doc-${String(i).padStart(5, "0")}.md`, `# 合成文档 ${i}\n\n${body}`);
  }
  console.log(`fixtures: wrote large-library (${count} files) under ${ROOT}`);
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args[0] === "--large") {
  const count = args[1] ? Number(args[1]) : 5000;
  try {
    generateLargeLibrary(count);
  } catch (error) {
    fail(`large generation failed: ${error?.message ?? error}`);
  }
} else {
  try {
    generateBaseLibraries();
  } catch (error) {
    fail(`generation failed: ${error?.message ?? error}`);
  }
}
