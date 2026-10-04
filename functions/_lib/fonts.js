/**
 * CJK fonts for the card renderer.
 *
 * How the fonts reach the Worker
 * ------------------------------
 * Cloudflare Pages Functions cannot use custom esbuild `[[rules]]` from
 * wrangler.toml (verified against wrangler 4.147.0: `buildFunctions()` never
 * forwards `rules` to the bundler). They *do* apply wrangler's default module
 * rules, one of which maps `**\/*.bin` to a `Data` (ArrayBuffer) module — so the
 * subsets are shipped as `functions/_lib/fonts/*.bin` and imported statically.
 *
 * `env.ASSETS` is used as a fallback so the same code also works when the file
 * is only available as a static asset (e.g. a different bundling setup or a
 * hand-assembled deployment). Both paths were smoke-tested on `wrangler pages dev`.
 *
 * The generated subsets (`npm run build:fonts`) contain GB2312 level-1 hanzi
 * (3 755 glyphs) + latin + common punctuation/symbols and weigh ~850 KB each.
 */
import regularBin from './fonts/NotoSansSC-Regular.bin';
import boldBin from './fonts/NotoSansSC-Bold.bin';

export const FONT_FAMILY = 'Noto Sans SC';

const FONT_FILES = [
  { weight: 400, bin: regularBin, asset: '/fonts/NotoSansSC-Regular.subset.woff' },
  { weight: 700, bin: boldBin, asset: '/fonts/NotoSansSC-Bold.subset.woff' },
];

/** @type {Promise<Array<{name: string, data: ArrayBuffer|Uint8Array, weight: number, style: string}>>|null} */
let fontsPromise = null;

function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return null;
}

/**
 * Resolve the font buffers, preferring the bundled `.bin` modules.
 * Cached for the lifetime of the isolate (the buffers are reused by satori's
 * internal font cache, which keeps repeated renders cheap).
 *
 * @param {{ASSETS?: {fetch: (input: RequestInfo|URL) => Promise<Response>}}} env
 * @param {string} [requestUrl]
 */
export function loadFonts(env, requestUrl) {
  if (fontsPromise) return fontsPromise;
  fontsPromise = (async () => {
    const fonts = [];
    for (const { weight, bin, asset } of FONT_FILES) {
      let data = toArrayBuffer(bin);
      if (!data && env?.ASSETS?.fetch && requestUrl) {
        const response = await env.ASSETS.fetch(new URL(asset, requestUrl));
        if (!response.ok) {
          throw new Error(
            `Font asset ${asset} could not be loaded (HTTP ${response.status}). ` +
              'Run `npm run build:fonts` and redeploy.',
          );
        }
        data = await response.arrayBuffer();
      }
      if (!data) {
        throw new Error(
          `Font ${asset} is not available. Run \`npm run build:fonts\` so that ` +
            'functions/_lib/fonts/*.bin and public/fonts/*.woff exist, then redeploy.',
        );
      }
      fonts.push({ name: FONT_FAMILY, data, weight, style: 'normal' });
    }
    return fonts;
  })().catch((error) => {
    fontsPromise = null; // allow a retry on the next request
    throw error;
  });
  return fontsPromise;
}
