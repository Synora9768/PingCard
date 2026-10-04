/**
 * POST /api/admin/render-check
 *
 * Used by the template editor for save-time validation and for the live preview
 * panel: lints the HTML, actually parses + renders it with satori, and reports
 * every problem in plain language before anything is written to D1.
 *
 * Body: { htmlTemplate, variablesSchema?, variables?, width?, height? }
 * Response: { ok, errors, warnings, placeholders, resolvedVariables, renderMs }
 */
import { handler, ok, readJson } from '../../_lib/http.js';
import { badRequest } from '../../_lib/errors.js';
import { requireAdmin } from '../../_lib/auth.js';
import { extractPlaceholders, lintTemplate, resolveVariables } from '../../_lib/templateEngine.js';
import { renderCardToSvg } from '../../_lib/renderCard.js';
import { normalizeTemplatePayload, sampleVariablesFromSchema } from '../../_lib/templates.js';

export const onRequestPost = handler(async ({ request, env }) => {
  await requireAdmin(request, env);
  const body = await readJson(request);
  if (typeof body.htmlTemplate !== 'string') throw badRequest('"htmlTemplate" is required');

  const width = Number(body.width) || 1024;
  const height = Number(body.height) || 512;

  // Reuse the same normalisation the save endpoints apply, but tolerate partial
  // input (the editor calls this on every keystroke).
  let schema = null;
  try {
    schema = normalizeTemplatePayload({
      name: body.name || 'preview',
      htmlTemplate: body.htmlTemplate,
      variablesSchema: body.variablesSchema ?? null,
      width,
      height,
    }).variablesSchema;
  } catch (error) {
    return ok({ ok: false, errors: [String(error?.message || error)], warnings: [], placeholders: [], resolvedVariables: {} });
  }

  const { errors, warnings } = lintTemplate(body.htmlTemplate);
  const placeholders = extractPlaceholders(body.htmlTemplate);

  const resolved = resolveVariables(
    body.variables && typeof body.variables === 'object'
      ? { ...sampleVariablesFromSchema(schema, body.variables), ...body.variables }
      : sampleVariablesFromSchema(schema),
    schema,
    { strict: false },
  );

  if (errors.length) {
    return ok({ ok: false, errors, warnings, placeholders, resolvedVariables: resolved, renderMs: 0 });
  }

  const started = Date.now();
  try {
    const svg = await renderCardToSvg({
      htmlTemplate: body.htmlTemplate,
      variables: resolved,
      width,
      height,
      env,
      requestUrl: request.url,
    });
    return ok({
      ok: true,
      errors: [],
      warnings,
      placeholders,
      resolvedVariables: resolved,
      renderMs: Date.now() - started,
      svgBytes: svg.length,
    });
  } catch (error) {
    const message = String(error?.message || error);
    return ok({
      ok: false,
      errors: [message],
      warnings,
      placeholders,
      resolvedVariables: resolved,
      renderMs: Date.now() - started,
      hint: '卡片模板只支持 flexbox 布局：容器需显式 display: flex，<img> 需指定宽高，不支持 grid / position: fixed / 伪类。',
    });
  }
});
