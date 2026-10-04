/**
 * POST /api/admin/templates/:id/set-default
 * Makes `:id` the single default template (used when /api/notify omits templateId).
 */
import { handler, ok } from '../../../../_lib/http.js';
import { notFound } from '../../../../_lib/errors.js';
import { requireAdmin } from '../../../../_lib/auth.js';
import { getDb, getTemplate, listTemplates, setDefaultTemplate, rethrowDbError } from '../../../../_lib/db.js';

export const onRequestPost = handler(
  async ({ request, env, params }) => {
    await requireAdmin(request, env);
    const db = getDb(env);

    let template;
    try {
      template = await getTemplate(db, params.id);
    } catch (error) {
      rethrowDbError(error);
    }
    if (!template) throw notFound(`Template "${params.id}" not found`);

    try {
      await setDefaultTemplate(db, params.id);
    } catch (error) {
      rethrowDbError(error);
    }

    const templates = await listTemplates(db);
    return ok({
      defaultTemplateId: params.id,
      templates: templates.map(({ id, name, isDefault, updatedAt }) => ({ id, name, isDefault, updatedAt })),
    });
  },
  { methods: ['POST'] },
);
