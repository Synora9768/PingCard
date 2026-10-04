/**
 * GET    /api/admin/templates/:id  → template detail (+placeholders)
 * PUT    /api/admin/templates/:id  → update (linted + dry-rendered first)
 * DELETE /api/admin/templates/:id  → delete (refuses to remove the last default)
 */
import { handler, ok, readJson } from '../../../_lib/http.js';
import { HttpError, notFound } from '../../../_lib/errors.js';
import { requireAdmin } from '../../../_lib/auth.js';
import { getDb, getTemplate, updateTemplate, deleteTemplate, listTemplates, rethrowDbError } from '../../../_lib/db.js';
import { normalizeTemplatePayload, validateTemplateRender } from '../../../_lib/templates.js';
import { extractPlaceholders } from '../../../_lib/templateEngine.js';

async function loadTemplate(db, id) {
  let template;
  try {
    template = await getTemplate(db, id);
  } catch (error) {
    rethrowDbError(error);
  }
  if (!template) throw notFound(`Template "${id}" not found`);
  return template;
}

export const onRequestGet = handler(
  async ({ request, env, params }) => {
    await requireAdmin(request, env);
    const template = await loadTemplate(getDb(env), params.id);
    return ok({ template: { ...template, placeholders: extractPlaceholders(template.htmlTemplate) } });
  },
  { methods: ['GET'] },
);

export const onRequestPut = handler(
  async ({ request, env, params }) => {
    await requireAdmin(request, env);
    const db = getDb(env);
    const existing = await loadTemplate(db, params.id);
    const body = await readJson(request);

    const payload = normalizeTemplatePayload(
      {
        name: body.name ?? existing.name,
        htmlTemplate: body.htmlTemplate ?? existing.htmlTemplate,
        variablesSchema: body.variablesSchema ?? body.variables_schema ?? existing.variablesSchema,
        width: body.width ?? existing.width,
        height: body.height ?? existing.height,
      },
      { partial: false },
    );

    const validation = await validateTemplateRender({
      htmlTemplate: payload.htmlTemplate,
      variablesSchema: payload.variablesSchema,
      width: payload.width,
      height: payload.height,
      sampleVariables: body.sampleVariables,
      env,
      requestUrl: request.url,
    });

    try {
      await updateTemplate(db, params.id, payload);
    } catch (error) {
      rethrowDbError(error);
    }

    const updated = await loadTemplate(db, params.id);
    return ok({
      template: { ...updated, placeholders: extractPlaceholders(updated.htmlTemplate) },
      warnings: validation.warnings,
      renderMs: validation.renderMs,
    });
  },
  { methods: ['PUT', 'PATCH'] },
);

export const onRequestDelete = handler(
  async ({ request, env, params }) => {
    await requireAdmin(request, env);
    const db = getDb(env);
    const template = await loadTemplate(db, params.id);

    // Boundary protection: never delete the only default template.
    if (template.isDefault) {
      const all = await listTemplates(db);
      const defaults = all.filter((entry) => entry.isDefault);
      if (defaults.length <= 1) {
        throw new HttpError(
          409,
          'Refusing to delete the only default template. Mark another template as default first, or create a replacement.',
        );
      }
    }

    try {
      await deleteTemplate(db, params.id);
    } catch (error) {
      rethrowDbError(error);
    }
    return ok({ deleted: template.id, name: template.name });
  },
  { methods: ['DELETE'] },
);
