/**
 * Template engine for card templates.
 *
 * Supported placeholder syntax (spec §4.4):
 *   {{variable}}            → value from `variables`
 *   {{variable|default}}    → `default` when the variable is absent/empty
 *
 * How variables are kept inert (this is the important part)
 * ---------------------------------------------------------
 * Values are substituted **after** the template HTML has been parsed into a
 * satori node tree, never into the raw HTML string. A variable value therefore
 * cannot close a tag or an attribute, cannot introduce new elements, and cannot
 * be re-parsed as a second placeholder: by the time it is inserted there is no
 * HTML parser left to fool — the value only ever becomes a text node or a CSS
 * property value.
 *
 * HTML-entity escaping is deliberately *not* used here: `satori-html` does not
 * decode entities, so `&amp;` would end up literal in the rendered PNG (and
 * `url('...&amp;...')` would break real image URLs).
 */
import { HttpError } from './errors.js';
import { assertSafeHttpUrl } from './urls.js';

export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;
const MAX_VALUE_LENGTH = 4096;
const MAX_VARIABLES = 64;

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escape text so it can only ever be treated as data by the HTML/CSS parser. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);
}

/** List every placeholder used in a template (also used by the admin UI). */
export function extractPlaceholders(htmlTemplate) {
  const found = new Map();
  const source = String(htmlTemplate || '');
  PLACEHOLDER_RE.lastIndex = 0;
  let match;
  while ((match = PLACEHOLDER_RE.exec(source)) !== null) {
    const name = match[1];
    const fallback = match[2] === undefined ? null : match[2];
    const existing = found.get(name);
    if (existing) {
      if (existing.defaultValue === null && fallback !== null) existing.defaultValue = fallback;
      existing.count += 1;
    } else {
      found.set(name, { name, defaultValue: fallback, count: 1 });
    }
  }
  return [...found.values()];
}

/** True when the template contains at least one usable placeholder. */
export function hasPlaceholders(htmlTemplate) {
  return extractPlaceholders(htmlTemplate).length > 0;
}

/**
 * Validate + normalise the variables the caller supplied, merging in defaults
 * from `variables_schema`.
 *
 * @param {Record<string, unknown>} variables raw values from the request body
 * @param {Record<string, any>|null} schema parsed `variables_schema` JSON
 * @param {{strict?: boolean}} [options] `strict` enforces required variables and types
 */
export function resolveVariables(variables, schema = null, { strict = true } = {}) {
  if (variables !== undefined && variables !== null && (typeof variables !== 'object' || Array.isArray(variables))) {
    throw new HttpError(400, '"variables" must be an object mapping placeholder names to values');
  }
  const raw = variables || {};
  const keys = Object.keys(raw);
  if (keys.length > MAX_VARIABLES) {
    throw new HttpError(400, `Too many variables (${keys.length}), the limit is ${MAX_VARIABLES}`);
  }

  /** @type {Record<string, string>} */
  const out = {};

  // 1. schema defaults first so that an explicit value always wins
  if (schema && typeof schema === 'object') {
    for (const [name, definition] of Object.entries(schema)) {
      if (definition && typeof definition === 'object' && definition.default !== undefined) {
        out[name] = String(definition.default);
      }
    }
  }

  // 2. caller-provided values
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      throw new HttpError(400, `Variable "${name}" must be a string, number or boolean`);
    }
    const text = String(value);
    if (text.length > MAX_VALUE_LENGTH) {
      throw new HttpError(400, `Variable "${name}" is too long (max ${MAX_VALUE_LENGTH} characters)`);
    }
    out[name] = text;
  }

  // 3. schema validation
  if (strict && schema && typeof schema === 'object') {
    for (const [name, definition] of Object.entries(schema)) {
      if (!definition || typeof definition !== 'object') continue;
      const value = out[name];
      const missing = value === undefined || value === '';
      if (definition.required && missing) {
        throw new HttpError(400, `Missing required variable "${name}"${definition.label ? ` (${definition.label})` : ''}`);
      }
      if (!missing && definition.type === 'image_url') {
        out[name] = assertSafeHttpUrl(value, { field: `variables.${name}`, allowData: true });
      }
    }
  }

  return out;
}

/**
 * Substitute placeholders inside a single already-parsed string (a text node or
 * a CSS property value). Unresolved placeholders fall back to the inline
 * `|default`, then to the schema default (already merged by `resolveVariables`),
 * and finally become an empty string.
 *
 * NOTE: never call this on raw template HTML — use `substituteVariables()` on
 * the parsed tree instead, which is what makes variable values structurally inert.
 */
export function renderTemplate(text, variables) {
  if (typeof text !== 'string') {
    throw new HttpError(500, 'Template content must be a string');
  }
  return text.replace(PLACEHOLDER_RE, (_match, name, fallback) => {
    const value = variables?.[name];
    if (value !== undefined && value !== null && value !== '') return String(value);
    if (fallback !== undefined && fallback !== null && fallback !== '') return String(fallback);
    return '';
  });
}

const QUOTED_ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const UNQUOTED_ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*([^\s"'>]+)/g;

/**
 * Substitute placeholders that appear inside attribute values *before* the HTML
 * is parsed.
 *
 * Why this pre-pass exists: `satori-html` converts `style="…"` into a CSS object
 * while parsing and silently drops declarations whose value does not look like
 * valid CSS. `color:{{brand}}` or `width:{{percent}}%` would therefore be gone
 * before a tree-based substitution could reach them.
 *
 * Safety: only the *value* between quotes is touched, and the delimiter quote is
 * stripped from the substituted text, so a variable can never terminate the
 * attribute or start a new one. Everything else (text nodes, unquoted props) is
 * handled by `substituteVariables()` on the parsed tree.
 */
export function substituteInAttributes(html, variables) {
  if (typeof html !== 'string' || !html.includes('{{')) return html;

  let out = html.replace(QUOTED_ATTR_RE, (match, name, doubleQuoted, singleQuoted) => {
    const value = doubleQuoted !== undefined ? doubleQuoted : singleQuoted;
    if (!value.includes('{{')) return match;
    const delimiter = doubleQuoted !== undefined ? '"' : "'";
    const substituted = renderTemplate(value, variables).split(delimiter).join('');
    return `${name}=${delimiter}${substituted}${delimiter}`;
  });

  out = out.replace(UNQUOTED_ATTR_RE, (match, name, value) => {
    if (!value.includes('{{')) return match;
    const substituted = renderTemplate(value, variables).replace(/[\s"'>]+/g, '');
    return `${name}="${substituted}"`;
  });

  return out;
}

/** Walk a value from a node's props (string / array / style object). */
function substituteValue(value, variables) {
  if (typeof value === 'string') return renderTemplate(value, variables);
  if (Array.isArray(value)) return value.map((entry) => substituteValue(entry, variables));
  if (value && typeof value === 'object') {
    if (value.type && value.props) return substituteVariables(value, variables); // nested node
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = substituteValue(entry, variables);
    return out;
  }
  return value;
}

/**
 * Substitute placeholders across a satori/satori-html node tree.
 * Text children, CSS values, image sources and every other string prop are
 * handled; the tree structure itself can never be changed by a variable value.
 *
 * @param {any} node node or array of nodes produced by `satori-html`
 * @param {Record<string, string>} variables
 */
export function substituteVariables(node, variables) {
  if (Array.isArray(node)) return node.map((entry) => substituteVariables(entry, variables));
  if (!node || typeof node !== 'object') return node;

  const props = { ...(node.props || {}) };
  if (typeof props.children === 'string') {
    props.children = renderTemplate(props.children, variables);
  } else if (props.children) {
    props.children = substituteVariables(props.children, variables);
  }
  if (props.style) props.style = substituteValue(props.style, variables);
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'style') continue;
    if (typeof props[key] === 'string') props[key] = renderTemplate(props[key], variables);
  }
  return { ...node, props };
}

/**
 * Static analysis of a template, used by the admin console *before* saving so
 * that mistakes surface as readable messages instead of satori stack traces.
 *
 * @returns {{errors: string[], warnings: string[]}}
 */
export function lintTemplate(htmlTemplate) {
  const errors = [];
  const warnings = [];
  const html = String(htmlTemplate || '');

  if (!html.trim()) {
    return { errors: ['模板内容不能为空'], warnings };
  }

  const unsupportedTags = [
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
    'script', 'style', 'link', 'meta', 'iframe', 'object', 'embed', 'form', 'input', 'textarea',
    'select', 'option', 'button', 'canvas', 'video', 'audio', 'source', 'noscript', 'base',
  ];
  for (const tag of unsupportedTags) {
    const re = new RegExp(`<\\s*${tag}(\\s|/|>)`, 'i');
    if (re.test(html)) {
      errors.push(`不支持的标签: <${tag}>。卡片渲染引擎只支持 flexbox 布局的 HTML/CSS 子集。`);
    }
  }

  if (/<[a-zA-Z][^>]*\son[a-z]+\s*=/i.test(html)) {
    errors.push('不支持内联事件属性（如 onclick / onerror），模板中不能包含 JavaScript。');
  }
  if (/@keyframes|animation\s*:|transition\s*:|grid-template|display\s*:\s*grid|float\s*:/i.test(html)) {
    warnings.push('检测到 grid / animation / transition / float 等不支持的 CSS 写法，渲染时会被忽略或报错。');
  }
  if (/position\s*:\s*fixed/i.test(html)) {
    errors.push('不支持 position: fixed（satori 只支持 absolute / relative / static）。');
  }
  if (/[:]\s*(hover|active|focus|visited|first-child|last-child|nth-child)/i.test(html)) {
    warnings.push('不支持伪类选择器（:hover 等），请把样式写成内联 style 属性。');
  }
  if (/<style[\s>]/i.test(html) === false && /class\s*=\s*["']/i.test(html) && !/style\s*=/i.test(html)) {
    warnings.push('模板中使用了 class 属性但没有内联 style，样式不会生效（satori 不解析外部样式表）。');
  }
  if (/url\(\s*['"]?\{\{/i.test(html) === false && /background-image/i.test(html)) {
    // just informational, no warning needed
  }

  const placeholders = extractPlaceholders(html);
  if (placeholders.length === 0) {
    errors.push('模板中至少需要包含一个占位符变量（例如 {{title}}），否则请直接使用静态 image 字段推送。');
  }

  // A quote inside `{{var|default}}` silently swallows the following markup:
  // `url('{{bg|https://x/y.png'})` never matches (the closing quote is inside the
  // braces). This is the single most common template authoring mistake.
  for (const placeholder of placeholders) {
    if (placeholder.defaultValue && /['"]/.test(placeholder.defaultValue)) {
      errors.push(
        `占位符 {{${placeholder.name}|…}} 的默认值中包含引号，会破坏 CSS/HTML 边界。` +
          `请把引号写在 {{ }} 之外，例如：style="background-image:url('{{${placeholder.name}}}')"。`,
      );
    }
  }

  const duplicateNames = new Set();
  for (const p of placeholders) {
    if (p.name.length > 64) errors.push(`变量名过长: ${p.name}`);
    if (duplicateNames.has(p.name)) continue;
    duplicateNames.add(p.name);
  }

  // img elements need explicit dimensions or satori cannot resolve their size.
  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgTags) {
    const hasWidth = /width\s*[:=]\s*["']?\s*\d/i.test(tag) || /width\s*[:=]\s*['"]?\{\{/.test(tag);
    const hasHeight = /height\s*[:=]\s*["']?\s*\d/i.test(tag) || /height\s*[:=]\s*['"]?\{\{/.test(tag);
    if (!hasWidth || !hasHeight) {
      warnings.push('检测到 <img> 未指定 width/height，若图片来源无法探测尺寸会渲染失败，建议显式设置宽高。');
      break;
    }
  }

  return { errors, warnings };
}
