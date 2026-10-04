/**
 * POST /api/admin/preview — WYSIWYG preview for the template editor.
 *
 * Renders *unsaved* HTML (plus the admin's test variables) straight to PNG, so
 * the editor can show the exact result before anything is written to D1.
 * Returns `image/png` on success and JSON with the errors on failure.
 */
import { json, readJson } from '../../_lib/http.js';
import { requireAdmin } from '../../_lib/auth.js';
import { normalizeTemplatePayload, sampleVariablesFromSchema } from '../../_lib/templates.js';
import { resolveVariables, lintTemplate } from '../../_lib/templateEngine.js';
import { renderCardToPng } from '../../_lib/renderCard.js';

export const onRequestPost = (function () {
  return async (context) => {
    const { request, env } = context;
    try {
      await requireAdmin(request, env);
    } catch (error) {
      return json({ success: false, error: error.message }, error.status || 403);
    }

    let body;
    try {
      body = await readJson(request, { maxBytes: 512 * 1024 });
    } catch (error) {
      return json({ success: false, error: error.message }, error.status || 400);
    }

    if (typeof body.htmlTemplate !== 'string' || body.htmlTemplate.trim() === '') {
      return json({ success: false, error: '"htmlTemplate" is required' }, 400);
    }

    let payload;
    try {
      payload = normalizeTemplatePayload({
        name: body.name || 'preview',
        htmlTemplate: body.htmlTemplate,
        variablesSchema: body.variablesSchema ?? null,
        width: body.width ?? 1024,
        height: body.height ?? 512,
      });
    } catch (error) {
      return json({ success: false, error: error.message }, error.status || 400);
    }

    const { errors, warnings } = lintTemplate(payload.htmlTemplate);
    if (errors.length) {
      return json({ success: false, error: errors[0], errors, warnings }, 422);
    }

    let resolved;
    try {
      resolved = resolveVariables(
        body.variables && typeof body.variables === 'object'
          ? { ...sampleVariablesFromSchema(payload.variablesSchema), ...body.variables }
          : sampleVariablesFromSchema(payload.variablesSchema),
        payload.variablesSchema,
        { strict: false },
      );
    } catch (error) {
      return json({ success: false, error: error.message }, error.status || 400);
    }

    const started = Date.now();
    try {
      const { png, width, height } = await renderCardToPng({
        htmlTemplate: payload.htmlTemplate,
        variables: resolved,
        width: payload.width,
        height: payload.height,
        env,
        requestUrl: request.url,
      });
      return new Response(png, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'x-pingcard-size': `${width}x${height}`,
          'x-pingcard-render-ms': String(Date.now() - started),
          'x-pingcard-warnings': String(warnings.length),
        },
      });
    } catch (error) {
      return json(
        {
          success: false,
          error: error.message,
          errors: error.details?.errors || [error.message],
          warnings,
          hint: error.details?.hint,
        },
        error.status || 500,
      );
    }
  };
})();
