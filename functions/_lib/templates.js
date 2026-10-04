/**
 * Shared validation for the template admin API (create / update / preview).
 */
import { HttpError, badRequest } from './errors.js';
import { extractPlaceholders, lintTemplate, resolveVariables } from './templateEngine.js';
import { renderCardToSvg } from './renderCard.js';
import { randomId } from './auth.js';

export const TEMPLATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const MAX_HTML_LENGTH = 100_000;

/** 1×1 solid-colour PNG used as a stand-in for image variables in previews. */
export const PLACEHOLDER_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export function assertTemplateId(value) {
  if (typeof value !== 'string' || !TEMPLATE_ID_RE.test(value)) {
    throw badRequest('"id" must be 2-64 characters using letters, digits, underscore or hyphen, and start with a letter/digit');
  }
  return value;
}

export function generateTemplateId() {
  return `t_${randomId(9)}`;
}

function assertName(value) {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest('"name" is required');
  if (value.trim().length > 80) throw badRequest('"name" must be 80 characters or fewer');
  return value.trim();
}

function assertHtml(value) {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest('"htmlTemplate" is required');
  if (value.length > MAX_HTML_LENGTH) throw badRequest(`"htmlTemplate" is too long (max ${MAX_HTML_LENGTH} characters)`);
  return value;
}

function assertDimensions(value, field, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) throw badRequest(`"${field}" must be a positive integer`);
  if (num > max) throw badRequest(`"${field}" must be <= ${max}`);
  return num;
}

function assertSchema(value) {
  if (value === undefined || value === null || value === '') return null;
  let schema = value;
  if (typeof schema === 'string') {
    try {
      schema = JSON.parse(schema);
    } catch {
      throw badRequest('"variablesSchema" must be valid JSON');
    }
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    throw badRequest('"variablesSchema" must be a JSON object keyed by variable name');
  }
  const out = {};
  for (const [key, definition] of Object.entries(schema)) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(key)) {
      throw badRequest(`variablesSchema key "${key}" is not a valid placeholder name`);
    }
    if (typeof definition === 'string') {
      // shorthand: "标题" is treated as the label
      out[key] = { type: 'string', label: definition };
      continue;
    }
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw badRequest(`variablesSchema["${key}"] must be an object`);
    }
    const type = definition.type === 'image_url' ? 'image_url' : 'string';
    out[key] = {
      type,
      required: definition.required === true,
      label: typeof definition.label === 'string' ? definition.label.slice(0, 60) : key,
      ...(definition.default !== undefined ? { default: String(definition.default) } : {}),
      ...(definition.sample !== undefined ? { sample: String(definition.sample) } : {}),
    };
  }
  return out;
}

/**
 * Validate a create/update payload.
 * @param {object} body
 * @param {{partial?: boolean}} [options]
 */
export function normalizeTemplatePayload(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') throw badRequest('Request body must be a JSON object');
  /** @type {any} */
  const out = {};
  if (body.name !== undefined || !partial) out.name = assertName(body.name);
  if (body.htmlTemplate !== undefined || !partial) out.htmlTemplate = assertHtml(body.htmlTemplate);
  if (body.variablesSchema !== undefined || body.variables_schema !== undefined) {
    out.variablesSchema = assertSchema(body.variablesSchema ?? body.variables_schema);
  } else {
    out.variablesSchema = null;
  }
  out.width = assertDimensions(body.width, 'width', 1024, 2000);
  out.height = assertDimensions(body.height, 'height', 512, 2000);
  return out;
}

/** Build preview variables from a schema (used by save-validation and preview). */
export function sampleVariablesFromSchema(schema, overrides = {}) {
  const out = { ...overrides };
  for (const [key, definition] of Object.entries(schema || {})) {
    if (out[key] !== undefined && out[key] !== '') continue;
    if (definition.default) {
      out[key] = String(definition.default);
    } else if (definition.type === 'image_url') {
      out[key] = PLACEHOLDER_IMAGE;
    } else {
      out[key] = String(definition.sample || definition.label || key);
    }
  }
  return out;
}

/**
 * Lint + really render a template so that a broken template can never be saved.
 * @returns {Promise<{warnings: string[], placeholders: Array<{name: string, defaultValue: string|null}>,
 *                    resolvedVariables: Record<string,string>, renderMs: number}>}
 * @throws {HttpError} 422 with the lint/parse errors
 */
export async function validateTemplateRender({ htmlTemplate, variablesSchema, width, height, sampleVariables, env, requestUrl }) {
  const { errors, warnings } = lintTemplate(htmlTemplate);
  if (errors.length) {
    throw new HttpError(422, `模板校验未通过：${errors[0]}`, { errors, warnings });
  }

  const resolved = resolveVariables(
    sampleVariables ?? sampleVariablesFromSchema(variablesSchema),
    variablesSchema,
    { strict: false },
  );

  const started = Date.now();
  try {
    await renderCardToSvg({
      htmlTemplate,
      variables: resolved,
      width,
      height,
      env,
      requestUrl,
    });
  } catch (error) {
    const message = String(error?.message || error);
    throw new HttpError(422, `模板渲染失败：${message}`, {
      errors: [message],
      warnings,
      resolvedVariables: resolved,
      hint: '提示：卡片模板只支持 flexbox 布局，容器需显式 display: flex，<img> 需指定宽高，不支持 grid / position: fixed。',
    });
  }

  return {
    warnings,
    placeholders: extractPlaceholders(htmlTemplate),
    resolvedVariables: resolved,
    renderMs: Date.now() - started,
  };
}
