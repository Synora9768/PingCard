/**
 * GET  /api/admin/templates   → list every template
 * POST /api/admin/templates   → create a template (linted + dry-rendered first)
 */
import { handler, ok, readJson } from '../../../_lib/http.js';
import { HttpError, conflict } from '../../../_lib/errors.js';
import { requireAdmin } from '../../../_lib/auth.js';
import {
  countTemplates,
  getDb,
  getTemplate,
  insertTemplate,
  listTemplates,
  rethrowDbError,
  setDefaultTemplate,
} from '../../../_lib/db.js';
import { TEMPLATE_ID_RE, generateTemplateId, normalizeTemplatePayload, validateTemplateRender } from '../../../_lib/templates.js';
import { extractPlaceholders } from '../../../_lib/templateEngine.js';

export const onRequestGet = handler(
  async ({ request, env }) => {
    await requireAdmin(request, env);
    const db = getDb(env);
    let templates;
    try {
      templates = await listTemplates(db);
    } catch (error) {
      rethrowDbError(error);
    }
    return ok({
      templates: templates.map((template) => ({
        ...template,
        placeholders: extractPlaceholders(template.htmlTemplate),
      })),
    });
  },
  { methods: ['GET'] },
);

export const onRequestPost = handler(async ({ request, env }) => {
  await requireAdmin(request, env);
  const body = await readJson(request);

  const payload = normalizeTemplatePayload(body);
  const requestedId = body.id === undefined || body.id === '' ? generateTemplateId() : String(body.id);
  if (!TEMPLATE_ID_RE.test(requestedId)) {
    throw new HttpError(400, '"id" must be 2-64 characters using letters, digits, underscore or hyphen');
  }

  const db = getDb(env);
  try {
    if (await getTemplate(db, requestedId)) {
      throw conflict(`Template "${requestedId}" already exists`);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    rethrowDbError(error);
  }

  const validation = await validateTemplateRender({
    htmlTemplate: payload.htmlTemplate,
    variablesSchema: payload.variablesSchema,
    width: payload.width,
    height: payload.height,
    sampleVariables: body.sampleVariables,
    env,
    requestUrl: request.url,
  });

  const existingCount = await countTemplates(db);
  const makeDefault = body.isDefault === true || existingCount === 0;

  try {
    await insertTemplate(db, { id: requestedId, ...payload, isDefault: makeDefault });
  } catch (error) {
    rethrowDbError(error);
  }
  if (makeDefault && existingCount > 0) await setDefaultTemplate(db, requestedId);

  const created = await getTemplate(db, requestedId);
  return ok(
    {
      template: { ...created, placeholders: extractPlaceholders(created.htmlTemplate) },
      warnings: validation.warnings,
      renderMs: validation.renderMs,
    },
    201,
  );
});
