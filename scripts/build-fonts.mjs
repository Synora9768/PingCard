#!/usr/bin/env node
/**
 * Build the Chinese font subsets used by the card renderer.
 *
 * Output: public/fonts/NotoSansSC-Regular.subset.woff
 *         public/fonts/NotoSansSC-Bold.subset.woff
 *
 * Why a subset?
 *   The full Noto Sans SC static TTF is ~10.5 MB per weight. Satori needs the
 *   real font file in memory, and Cloudflare Pages Functions have a hard
 *   bundle size limit, so we subset the font down to the characters a
 *   notification card realistically contains (GB2312 level-1 hanzi + latin +
 *   punctuation + common symbols) which brings each weight down to < 1 MB.
 *
 * Source font: Noto Sans SC (OFL-1.1) -> fetched from the npm mirror of Google
 * Fonts (@expo-google-fonts/noto-sans-sc). No external network access needed
 * beyond the npm registry. Pass FONT_SRC_DIR=/path/to/dir with
 * NotoSansSC_400Regular.ttf / NotoSansSC_700Bold.ttf inside to use local files.
 *
 * Usage: npm run build:fonts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'fonts');
const cacheDir = path.join(root, '.cache', 'fonts');

const WEIGHTS = [
  { weight: 400, file: 'NotoSansSC_400Regular.ttf', out: 'NotoSansSC-Regular.subset.woff' },
  { weight: 700, file: 'NotoSansSC_700Bold.ttf', out: 'NotoSansSC-Bold.subset.woff' },
];

/**
 * Characters kept in the subset:
 *  - ASCII printable
 *  - latin-1 supplement, general punctuation, currency, arrows, dingbats…
 *  - GB2312 level-1 (3 755 most common simplified hanzi) decoded through the
 *    built-in gbk codec so no external charset table is required.
 */
function buildCharSet() {
  const chars = new Set();
  for (let cp = 0x20; cp < 0x7f; cp++) chars.add(String.fromCharCode(cp));
  for (let cp = 0xa0; cp < 0x100; cp++) chars.add(String.fromCodePoint(cp));
  const ranges = [
    [0x2000, 0x2070], [0x20a0, 0x20c0], [0x2100, 0x2150], [0x2190, 0x2200],
    [0x2460, 0x2500], [0x25a0, 0x2600], [0x2e80, 0x2f00], [0x3000, 0x3040],
    [0x3105, 0x3130], [0x3220, 0x3300], [0xfe30, 0xfe50], [0xff00, 0xfff0],
  ];
  for (const [lo, hi] of ranges) {
    for (let cp = lo; cp <= hi; cp++) chars.add(String.fromCodePoint(cp));
  }
  const gbk = new TextDecoder('gbk');
  for (let lead = 0xb0; lead <= 0xd7; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      const ch = gbk.decode(new Uint8Array([lead, trail]));
      if (ch.length === 1 && ch !== '\uFFFD') chars.add(ch);
    }
  }
  return [...chars].sort().join('');
}

function sourceFontPath(fileName) {
  const local = process.env.FONT_SRC_DIR
    ? path.join(process.env.FONT_SRC_DIR, fileName)
    : null;
  if (local && fs.existsSync(local)) return local;

  const cached = path.join(cacheDir, fileName);
  if (fs.existsSync(cached)) return cached;

  console.log('· downloading Noto Sans SC from the npm registry (one time)…');
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pingcard-font-'));
  const tgz = execFileSync('npm', ['pack', '@expo-google-fonts/noto-sans-sc', '--silent'], {
    cwd: tmp,
    encoding: 'utf8',
  }).trim().split('\n').pop();
  execFileSync('tar', ['xzf', path.join(tmp, tgz), '-C', tmp]);
  for (const w of WEIGHTS) {
    const src = path.join(tmp, 'package', w.file.replace(/_/g, '_').replace(/^NotoSansSC_/, ''));
    const found = path.join(tmp, 'package', w.file.split('_')[1], w.file);
    const chosen = fs.existsSync(found) ? found : src;
    fs.copyFileSync(chosen, path.join(cacheDir, w.file));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return cached;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const text = buildCharSet();
  const hanzi = [...text].filter((c) => c.codePointAt(0) >= 0x4e00 && c.codePointAt(0) <= 0x9fff).length;
  console.log(`· subset charset: ${text.length} characters (${hanzi} CJK ideographs)`);

  const functionsFontDir = path.join(root, 'functions', '_lib', 'fonts');
  fs.mkdirSync(functionsFontDir, { recursive: true });

  for (const { file, out, weight } of WEIGHTS) {
    const src = fs.readFileSync(sourceFontPath(file));
    const t0 = Date.now();
    const woff = await subsetFont(src, text, { targetFormat: 'woff' });
    fs.writeFileSync(path.join(outDir, out), woff);

    // Pages Functions cannot use custom esbuild `[[rules]]`, but wrangler's
    // default rules turn `**/*.bin` into a `Data` (ArrayBuffer) module — that is
    // how the Worker gets the font without a runtime fetch.
    const binName = out.replace(/\.subset\.woff$/, '.bin');
    fs.writeFileSync(path.join(functionsFontDir, binName), woff);

    console.log(
      `✓ ${out} (weight ${weight}) — ${(woff.length / 1024).toFixed(0)} KiB ` +
        `from ${(src.length / 1024 / 1024).toFixed(1)} MiB in ${Date.now() - t0} ms` +
        ` → functions/_lib/fonts/${binName}`,
    );
  }

  const licenseSrc = path.join(root, '.cache', 'fonts', 'OFL.txt');
  if (!fs.existsSync(licenseSrc)) {
    fs.writeFileSync(licenseSrc, NOTO_OFL_NOTICE);
  }
  fs.copyFileSync(licenseSrc, path.join(outDir, 'OFL.txt'));
  fs.copyFileSync(licenseSrc, path.join(root, 'functions', '_lib', 'fonts', 'OFL.txt'));
  console.log('✓ font licence (OFL-1.1) copied next to the fonts');
}

const NOTO_OFL_NOTICE = `Noto Sans SC — Copyright 2014-2024 Adobe (http://www.adobe.com/),
with Reserved Font Name 'Source'. Noto is a trademark of Google Inc.
Licensed under the SIL Open Font License, Version 1.1.
Full licence text: https://openfontlicense.org / https://scripts.sil.org/OFL
`;

main().catch((err) => {
  console.error('✗ font build failed:', err);
  process.exit(1);
});
