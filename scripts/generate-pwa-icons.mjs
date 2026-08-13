/**
 * 确定性生成 Reade PWA 图标（docs/plan-web-pwa.md：图标可确定性生成）。
 *
 * 零依赖：手写 PNG 编码（filter 0 + node:zlib deflate + CRC32），像素由
 * SDF 绘制——砖红圆角底 + 白色"文档页"卡片 + 三条正文线，与应用视觉
 * 语言一致。运行 `node scripts/generate-pwa-icons.mjs` 重新生成
 * `public/reade-icon-192.png` 与 `public/reade-icon-512.png`；输出只由
 * 本文件的常量决定，多次运行字节一致。
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

// Reade 品牌色（App 侧栏 logo 的砖红）与纸感白。
const BACKGROUND = [154, 58, 42];
const PAGE = [247, 243, 234];
const LINE = [176, 90, 72];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  // level 9 确保同输入同输出(确定性)。
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 圆角矩形 SDF：中心 (cx,cy)、半宽 hw、半高 hh、圆角 r；<0 在内部。 */
function roundedRectSdf(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

function coverage(sdf) {
  // 1px 平滑边缘。
  return Math.min(1, Math.max(0, 0.5 - sdf));
}

function blend(base, over, alpha) {
  return [
    Math.round(base[0] + (over[0] - base[0]) * alpha),
    Math.round(base[1] + (over[1] - base[1]) * alpha),
    Math.round(base[2] + (over[2] - base[2]) * alpha),
  ];
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const center = size / 2;
  // maskable 安全区:主体收在中央 ~62%,四角留足裁切余量。
  const tile = size * 0.5;
  const pageHw = size * 0.19;
  const pageHh = size * 0.25;
  const lineHw = size * 0.115;
  const lineHh = size * 0.016;
  const lineGap = size * 0.085;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let color = BACKGROUND;
      // 底:整幅砖红圆角方(圆角半径 20%,铺满画布以适配 any 用途)。
      const tileAlpha = coverage(
        roundedRectSdf(px, py, center, center, center, center, size * 0.2),
      );
      // 页卡。
      const pageAlpha = coverage(
        roundedRectSdf(px, py, center, center, pageHw + tile * 0, pageHh, size * 0.045),
      );
      color = blend([0, 0, 0], BACKGROUND, tileAlpha);
      color = blend(color, PAGE, pageAlpha);
      // 三条正文线。
      for (let line = -1; line <= 1; line += 1) {
        const lineAlpha = coverage(
          roundedRectSdf(px, py, center, center + line * lineGap, lineHw, lineHh, lineHh),
        );
        color = blend(color, LINE, Math.min(lineAlpha, pageAlpha));
      }
      const offset = (y * size + x) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = Math.round(255 * tileAlpha);
    }
  }
  return encodePng(size, rgba);
}

for (const size of [192, 512]) {
  const file = resolve(OUTPUT_DIRECTORY, `reade-icon-${size}.png`);
  writeFileSync(file, renderIcon(size));
  console.log(`generated ${file}`);
}
