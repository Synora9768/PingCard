/**
 * D1 access helpers + the queries used by the API routes.
 */
import { HttpError } from './errors.js';

/** Fetch the D1 binding or fail with an actionable message. */
export function getDb(env) {
  if (!env?.DB || typeof env.DB.prepare !== 'function') {
    throw new Error(
      'D1 binding "DB" is missing. Add it to wrangler.toml (`[[d1_databases]]`, binding = "DB") ' +
        'and apply schema.sql to the database.',
    );
  }
  return env.DB;
}

/* ------------------------------- subscriptions ------------------------------ */

/** Insert or refresh a subscription, keyed by endpoint (requirement 8.2). */
export async function upsertSubscription(db, { userId, subscription, userAgent }) {
  const statement = db
    .prepare(
      `INSERT INTO subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id        = excluded.user_id,
         p256dh         = excluded.p256dh,
         auth           = excluded.auth,
         user_agent     = excluded.user_agent,
         is_active      = 1,
         last_active_at = datetime('now')`,
    )
    .bind(
      userId,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      userAgent || null,
    );
  return statement.run();
}

export async function deleteSubscription(db, { endpoint, userId }) {
  if (userId) {
    return db
      .prepare('DELETE FROM subscriptions WHERE endpoint = ?1 AND user_id = ?2')
      .bind(endpoint, userId)
      .run();
  }
  return db.prepare('DELETE FROM subscriptions WHERE endpoint = ?1').bind(endpoint).run();
}

export async function deleteSubscriptionsByEndpoint(db, endpoint) {
  return db.prepare('DELETE FROM subscriptions WHERE endpoint = ?1').bind(endpoint).run();
}

export async function listActiveSubscriptions(db, userId) {
  if (userId) {
    const { results } = await db
      .prepare('SELECT * FROM subscriptions WHERE is_active = 1 AND user_id = ?1 ORDER BY id ASC')
      .bind(userId)
      .all();
    return results || [];
  }
  const { results } = await db
    .prepare('SELECT * FROM subscriptions WHERE is_active = 1 ORDER BY id ASC')
    .all();
  return results || [];
}

export async function subscriptionStatsForUser(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT id, user_agent, created_at, last_active_at, endpoint
         FROM subscriptions
        WHERE user_id = ?1 AND is_active = 1
        ORDER BY created_at ASC`,
    )
    .bind(userId)
    .all();
  return results || [];
}

export async function listUsers(db) {
  const { results } = await db
    .prepare(
      `SELECT user_id,
              COUNT(*)                                   AS device_count,
              SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_device_count,
              MIN(created_at)                            AS first_seen_at,
              MAX(last_active_at)                        AS last_active_at
         FROM subscriptions
        GROUP BY user_id
        ORDER BY active_device_count DESC, last_active_at DESC`,
    )
    .all();
  return results || [];
}

/* --------------------------------- templates -------------------------------- */

export function rowToTemplate(row) {
  if (!row) return null;
  let schema = null;
  if (row.variables_schema) {
    try {
      schema = JSON.parse(row.variables_schema);
    } catch {
      schema = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    htmlTemplate: row.html_template,
    variablesSchema: schema,
    width: row.width,
    height: row.height,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listTemplates(db) {
  const { results } = await db
    .prepare('SELECT * FROM templates ORDER BY is_default DESC, created_at ASC')
    .all();
  return (results || []).map(rowToTemplate);
}

export async function getTemplate(db, id) {
  const row = await db.prepare('SELECT * FROM templates WHERE id = ?1').bind(id).first();
  return rowToTemplate(row);
}

export async function getDefaultTemplate(db) {
  const row = await db
    .prepare('SELECT * FROM templates WHERE is_default = 1 ORDER BY updated_at DESC LIMIT 1')
    .first();
  return rowToTemplate(row);
}

export async function countTemplates(db) {
  const row = await db.prepare('SELECT COUNT(*) AS total FROM templates').first();
  return Number(row?.total || 0);
}

export async function insertTemplate(db, template) {
  await db
    .prepare(
      `INSERT INTO templates (id, name, html_template, variables_schema, width, height, is_default)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      template.id,
      template.name,
      template.htmlTemplate,
      template.variablesSchema ? JSON.stringify(template.variablesSchema) : null,
      template.width,
      template.height,
      template.isDefault ? 1 : 0,
    )
    .run();
}

export async function updateTemplate(db, id, patch) {
  return db
    .prepare(
      `UPDATE templates
          SET name             = ?2,
              html_template    = ?3,
              variables_schema = ?4,
              width            = ?5,
              height           = ?6,
              updated_at       = datetime('now')
        WHERE id = ?1`,
    )
    .bind(
      id,
      patch.name,
      patch.htmlTemplate,
      patch.variablesSchema ? JSON.stringify(patch.variablesSchema) : null,
      patch.width,
      patch.height,
    )
    .run();
}

export async function deleteTemplate(db, id) {
  return db.prepare('DELETE FROM templates WHERE id = ?1').bind(id).run();
}

/** Atomically make `id` the only default template. */
export async function setDefaultTemplate(db, id) {
  await db.batch([
    db.prepare('UPDATE templates SET is_default = 0, updated_at = datetime(\'now\') WHERE is_default = 1'),
    db.prepare('UPDATE templates SET is_default = 1, updated_at = datetime(\'now\') WHERE id = ?1').bind(id),
  ]);
}

/* ------------------------------- notify logs -------------------------------- */

export async function logNotify(db, { targetUserId, templateId, payload, sentCount, failedCount }) {
  try {
    await db
      .prepare(
        `INSERT INTO notify_logs (target_user_id, template_id, payload, sent_count, failed_count)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(
        targetUserId || null,
        templateId || null,
        JSON.stringify(payload ?? null).slice(0, 8000),
        sentCount,
        failedCount,
      )
      .run();
  } catch (error) {
    // Logging must never break a delivery that already happened.
    console.error('[pingcard] failed to write notify_logs row:', error);
  }
}

/** Assert a D1 error is a "table missing" style error and rethrow as HTTP 500. */
export function rethrowDbError(error) {
  const message = String(error?.message || error);
  if (/no such table/i.test(message)) {
    throw new HttpError(
      500,
      'Database schema is missing. Run: wrangler d1 execute pingcard --file=./schema.sql',
      { detail: message },
    );
  }
  throw new HttpError(500, `Database error: ${message}`);
}
