#!/usr/bin/env node
/**
 * Generate the static icons (no binary assets are checked in by hand):
 *
 *   public/icons/icon-192.png   notification icon
 *   public/icons/icon-512.png   PWA / maskable icon
 *   public/icons/favicon.png    browser tab
 *   public/icons/badge-72.png   monochrome status-bar badge (white on transparent)
 *
 * The shapes are rasterised here with a tiny anti-aliased renderer (4×4
 * supersampling) and written as PNG using zlib — no image dependency needed.
 *
 * Usage: npm run icons
 */
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'icons');

/* ------------------------------------------------------------------ PNG ---- */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** @param {Uint8Array} rgba w*h*4 */
function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- rasteriser -- */

const SS = 4; // supersampling factor

function roundedRectSdf(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** A "notification card" glyph: rounded card + bell-ish dot, drawn in a 0-100 design space. */
function cardPixel(x, y) {
  const inCard = roundedRectSdf(x, y, 12, 24, 76, 54, 10) <= 0;
  // inner "text" bars
  const bar1 = roundedRectSdf(x, y, 24, 38, 30, 6, 3) <= 0;
  const bar2 = roundedRectSdf(x, y, 24, 52, 40, 6, 3) <= 0;
  // bell
  const bellBody = roundedRectSdf(x, y, 58, 8, 30, 26, 13) <= 0;
  const bellClapper = Math.hypot(x - 73, y - 40) <= 5;
  return { card: inCard, ink: bar1 || bar2 || bellBody || bellClapper };
}

function renderIcon(size, { monochrome = false, padding = 0.9 } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  const scale = (size / 100) * padding;
  const offset = (size - 100 * scale) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cardHits = 0;
      let inkHits = 0;
      let samples = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const designX = (x + (sx + 0.5) / SS - offset) / scale;
          const designY = (y + (sy + 0.5) / SS - offset) / scale;
          samples++;
          if (designX < 0 || designY < 0 || designX > 100 || designY > 100) continue;
          const hit = cardPixel(designX, designY);
          if (hit.card) cardHits++;
          if (hit.ink) inkHits++;
        }
      }
      const cardAlpha = cardHits / samples;
      const inkAlpha = inkHits / samples;
      const index = (y * size + x) * 4;

      if (monochrome) {
        // white shape on transparent background (status-bar badge)
        const alpha = Math.round(Math.min(1, cardAlpha * 1 + inkAlpha * 0.35) * 255);
        rgba[index] = 255;
        rgba[index + 1] = 255;
        rgba[index + 2] = 255;
        rgba[index + 3] = alpha;
        continue;
      }

      // vertical blue gradient background
      const t = y / size;
      const bg = [
        Math.round(37 + (99 - 37) * t),
        Math.round(99 + (102 - 99) * t),
        Math.round(235 + (241 - 235) * t),
      ];
      const cardColor = [255, 255, 255];
      const inkColor = [37, 99, 235];

      let r = bg[0];
      let g = bg[1];
      let b = bg[2];
      if (cardAlpha > 0) {
        r = Math.round(r * (1 - cardAlpha) + cardColor[0] * cardAlpha);
        g = Math.round(g * (1 - cardAlpha) + cardColor[1] * cardAlpha);
        b = Math.round(b * (1 - cardAlpha) + cardColor[2] * cardAlpha);
      }
      if (inkAlpha > 0) {
        r = Math.round(r * (1 - inkAlpha) + inkColor[0] * inkAlpha);
        g = Math.round(g * (1 - inkAlpha) + inkColor[1] * inkAlpha);
        b = Math.round(b * (1 - inkAlpha) + inkColor[2] * inkAlpha);
      }
      rgba[index] = r;
      rgba[index + 1] = g;
      rgba[index + 2] = b;
      rgba[index + 3] = 255;
    }
  }
  return encodePng(rgba, size, size);
}

fs.mkdirSync(outDir, { recursive: true });
const outputs = [
  ['icon-192.png', renderIcon(192)],
  ['icon-512.png', renderIcon(512)],
  ['favicon.png', renderIcon(64)],
  ['badge-72.png', renderIcon(72, { monochrome: true, padding: 1 })],
];
for (const [name, buffer] of outputs) {
  fs.writeFileSync(path.join(outDir, name), buffer);
  console.log(`✓ public/icons/${name} — ${(buffer.length / 1024).toFixed(1)} KiB`);
}
