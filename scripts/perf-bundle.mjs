#!/usr/bin/env node
/**
 * D10 前端产物基线统计（可重复，无运行时依赖）。
 *
 * 前置：先运行 `pnpm build`（桌面构建）生成 dist/。
 * 用法：node scripts/perf-bundle.mjs [--out output/hardening/perf/bundle-baseline.json]
 * 输出：控制台摘要 + JSON（每 chunk 原始/gzip 字节、入口 chunk、>500 KiB 清单）。
 * 平台要求：Node 18+（fs/zlib）。清理范围：仅写 --out 指定文件。
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : "output/hardening/perf/bundle-baseline.json";

const distDir = path.resolve(process.cwd(), "dist");
const assetsDir = path.join(distDir, "assets");
if (!fs.existsSync(assetsDir)) {
  console.error("perf-bundle: dist/assets 不存在。先运行 `pnpm build` 再执行本脚本。");
  process.exit(1);
}

function fail(message) {
  console.error(`perf-bundle: ${message}`);
  process.exit(1);
}

const files = fs
  .readdirSync(assetsDir)
  .filter((name) => /\.(js|css)$/.test(name))
  .map((name) => {
    const data = fs.readFileSync(path.join(assetsDir, name));
    const gz = gzipSync(data);
    return { name, raw: data.length, gzip: gz.length, sha256: createHash("sha256").update(data).digest("hex").slice(0, 16) };
  })
  .sort((a, b) => b.gzip - a.gzip);

const indexHtml = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
const entryScripts = [...indexHtml.matchAll(/src="\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
const entryStyles = [...indexHtml.matchAll(/href="\/?(assets\/[^"]+\.css)"/g)].map((m) => m[1]);
const initialNames = new Set([...entryScripts, ...entryStyles].map((p) => path.basename(p)));
const initial = files.filter((file) => initialNames.has(file.name));

const totalGzip = files.reduce((sum, file) => sum + file.gzip, 0);
const initialGzip = initial.reduce((sum, file) => sum + file.gzip, 0);
const heavy = files.filter((file) => file.raw > 500 * 1024);

const report = {
  generatedAt: new Date().toISOString(),
  build: "pnpm build (desktop frontend)",
  chunks: files,
  entry: { scripts: entryScripts, styles: entryStyles },
  totals: {
    files: files.length,
    rawBytes: files.reduce((sum, file) => sum + file.raw, 0),
    gzipBytes: totalGzip,
    initialGzipBytes: initialGzip,
  },
  heavyOver500KiBRaw: heavy.map((file) => ({ name: file.name, rawKiB: Math.round(file.raw / 1024) })),
};

if (outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
}

console.log(`perf-bundle: ${files.length} chunks, total gzip ${Math.round(totalGzip / 1024)} KiB, initial-entry gzip ${Math.round(initialGzip / 1024)} KiB`);
for (const file of files.slice(0, 10)) {
  console.log(`  ${file.name}: raw ${Math.round(file.raw / 1024)} KiB, gzip ${Math.round(file.gzip / 1024)} KiB`);
}
if (heavy.length > 0) {
  console.log(`perf-bundle: ${heavy.length} chunk(s) over 500 KiB raw:`);
  for (const file of heavy) {
    console.log(`  ${file.name}: raw ${Math.round(file.raw / 1024)} KiB`);
  }
}
if (outPath) {
  console.log(`perf-bundle: report written to ${path.resolve(outPath)}`);
}
