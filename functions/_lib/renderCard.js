/**
 * HTML → Satori node tree → SVG → PNG, entirely inside the Worker.
 *
 * Libraries (all verified against the workerd runtime of wrangler 4.147.0):
 *   - `@cf-wasm/satori`  : satori packaged for Workers/V8 isolates. It wraps
 *     satori 0.32.0 and pre-initialises the yoga-layout WASM module through a
 *     `CompiledWasm` import, which the plain `satori@0.35` build cannot do: that
 *     version depends on `harfbuzzjs`, whose glue code calls Node's `fs`.
 *   - `satori-html`      : HTML string → satori node tree.
 *   - `@resvg/resvg-wasm`: SVG → PNG (the WASM binary is imported as a module).
 */
import satori from '@cf-wasm/satori';
import { html as parseHtml } from 'satori-html';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import { HttpError } from './errors.js';
import { loadFonts } from './fonts.js';
import { substituteInAttributes, substituteVariables } from './templateEngine.js';

export const DEFAULT_WIDTH = 1024;
export const DEFAULT_HEIGHT = 512;
export const MAX_WIDTH = 2000;
export const MAX_HEIGHT = 2000;

let wasmReady = null;

/** `initWasm()` may only run once per isolate — guard it and stay idempotent. */
async function ensureWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      try {
        await initWasm(resvgWasm);
      } catch (error) {
        if (!/already initialized/i.test(String(error?.message))) throw error;
      }
    })().catch((error) => {
      wasmReady = null;
      throw error;
    });
  }
  return wasmReady;
}

/**
 * `satori-html` already returns a single root (a 100%×100% flex column), so it
 * is normally used as-is. Anything else (a bare array, a primitive) is wrapped
 * so satori always receives one element that fills the requested canvas.
 */
function normalizeRoot(node, width, height) {
  const isSingleElement = node && !Array.isArray(node) && typeof node === 'object' && node.props;
  if (isSingleElement) return node;
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: `${width}px`,
        height: `${height}px`,
      },
      children: Array.isArray(node) ? node : [node],
    },
  };
}

/**
 * Render a card template into a PNG.
 *
 * @param {object} options
 * @param {string} options.htmlTemplate  raw template containing {{placeholders}}
 * @param {Record<string, string>} options.variables  already-validated values
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {object} options.env   Pages Functions environment (for the font fallback)
 * @param {string} [options.requestUrl]
 * @returns {Promise<{png: Uint8Array, width: number, height: number, svg: string}>}
 */
export async function renderCardToPng({ htmlTemplate, variables, width, height, env, requestUrl }) {
  const w = clampDimension(width, DEFAULT_WIDTH, 'width');
  const h = clampDimension(height, DEFAULT_HEIGHT, 'height');

  const fonts = await loadFonts(env, requestUrl);

  let svg;
  try {
    // 1. attribute values (CSS!) first — satori-html parses styles at parse time
    // 2. parse, then substitute into the tree so values can never alter markup
    const tree = substituteVariables(parseHtml(substituteInAttributes(htmlTemplate, variables)), variables);
    svg = await satori(normalizeRoot(tree, w, h), {
      width: w,
      height: h,
      fonts,
      embedFont: true,
    });
  } catch (error) {
    throw new HttpError(422, `Template render failed: ${error?.message || error}`, {
      hint: '卡片模板只支持 flexbox 布局的 CSS 子集，请检查 display / position / 标签用法。',
    });
  }

  await ensureWasm();

  try {
    const png = new Resvg(svg, {
      fitTo: { mode: 'width', value: w },
      font: { loadSystemFonts: false },
    })
      .render()
      .asPng();
    return { png, width: w, height: h, svg };
  } catch (error) {
    throw new HttpError(500, `PNG conversion failed: ${error?.message || error}`);
  }
}

/** Render template → SVG only (used by the admin preview to validate quickly). */
export async function renderCardToSvg({ htmlTemplate, variables, width, height, env, requestUrl }) {
  const w = clampDimension(width, DEFAULT_WIDTH, 'width');
  const h = clampDimension(height, DEFAULT_HEIGHT, 'height');
  const fonts = await loadFonts(env, requestUrl);
  try {
    const tree = substituteVariables(parseHtml(substituteInAttributes(htmlTemplate, variables)), variables);
    return await satori(normalizeRoot(tree, w, h), { width: w, height: h, fonts });
  } catch (error) {
    throw new HttpError(422, `Template render failed: ${error?.message || error}`);
  }
}

function clampDimension(value, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) throw new HttpError(400, `"${field}" must be a positive number`);
  const max = field === 'width' ? MAX_WIDTH : MAX_HEIGHT;
  if (num > max) throw new HttpError(400, `"${field}" must be <= ${max}`);
  return Math.round(num);
}
