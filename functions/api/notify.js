/**
 * POST /api/notify — the core push endpoint (requires NOTIFY_SECRET).
 *
 * Flow (spec §4.3):
 *   1. `image` given?              → use it, skip template rendering
 *      otherwise                   → templateId (or the default template) +
 *                                    variables → sign a /api/card-image URL
 *   2. resolve the target subscriptions (one user, or every active subscriber)
 *   3. encrypt + send with Web Push (VAPID) for each subscription
 *   4. purge subscriptions the push service reports as 404/410
 *   5. write a row into notify_logs
 */
import { handler, readJson, ok } from '../_lib/http.js';
import { HttpError, badRequest } from '../_lib/errors.js';
import { requireNotifySecret } from '../_lib/auth.js';
import {
  getDb,
  getDefaultTemplate,
  getTemplate,
  listActiveSubscriptions,
  deleteSubscriptionsByEndpoint,
  logNotify,
  rethrowDbError,
} from '../_lib/db.js';
import { resolveVariables } from '../_lib/templateEngine.js';
import { signCardRequest } from '../_lib/sign.js';
import { buildPushRequest, interpretPushResponse, parseVapidKeys } from '../_lib/webpush.js';
import { assertSafeHttpUrl, absoluteUrl } from '../_lib/urls.js';

const ACTION_PRESETS = {
  open: { action: 'open', title: '查看' },
  view: { action: 'open', title: '查看' },
  dismiss: { action: 'dismiss', title: '忽略' },
  close: { action: 'dismiss', title: '忽略' },
  reply: { action: 'reply', title: '回复' },
  copy: { action: 'copy', title: '复制' },
};
const MAX_ACTIONS = 2; // Chromium renders at most two action buttons
const CONCURRENCY = 20;

function normalizeActions(actions) {
  if (actions === undefined || actions === null) return undefined;
  if (!Array.isArray(actions)) throw badRequest('"actions" must be an array');
  const out = [];
  for (const entry of actions.slice(0, MAX_ACTIONS)) {
    if (typeof entry === 'string') {
      const preset = ACTION_PRESETS[entry.toLowerCase()];
      if (!preset) throw badRequest(`Unknown action preset "${entry}" (use open, dismiss, reply or copy)`);
      out.push(preset);
      continue;
    }
    if (!entry || typeof entry !== 'object') throw badRequest('Each action must be a string or an object');
    const action = String(entry.action || '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(action)) {
      throw badRequest('"action.action" must be 1-32 characters of [A-Za-z0-9_-]');
    }
    const title = String(entry.title || ACTION_PRESETS[action]?.title || action).slice(0, 40);
    const normalized = { action, title };
    if (entry.icon) normalized.icon = assertSafeHttpUrl(entry.icon, { field: 'actions[].icon' });
    out.push(normalized);
  }
  return out.length ? out : undefined;
}

/** Pick a string from the request body with a fallback chain. */
function pick(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

export const onRequestPost = handler(async ({ request, env, waitUntil }) => {
  await requireNotifySecret(request, env);

  const body = await readJson(request);
  const db = getDb(env);
  const origin = new URL(request.url).origin;

  const dryRun = body.dryRun === true;
  const userId = pick(body.userId);
  if (userId && !/^[A-Za-z0-9_-]{2,64}$/.test(userId)) {
    throw badRequest('"userId" must be 2-64 characters using letters, digits, underscore or hyphen');
  }

  /* ---------------- 1/2. build the notification image ---------------- */

  let template = null;
  let resolvedVariables = null;
  let imageUrl;

  if (pick(body.image)) {
    imageUrl = assertSafeHttpUrl(body.image, { field: 'image' });
  } else {
    const requestedTemplateId = pick(body.templateId);
    try {
      template = requestedTemplateId ? await getTemplate(db, requestedTemplateId) : await getDefaultTemplate(db);
    } catch (error) {
      rethrowDbError(error);
    }
    if (!template) {
      throw badRequest(
        requestedTemplateId
          ? `Template "${requestedTemplateId}" was not found`
          : 'No default template configured and no static "image" provided. Create a template in /admin/templates or pass "image".',
      );
    }

    resolvedVariables = resolveVariables(body.variables, template.variablesSchema, { strict: true });
    const ts = Math.floor(Date.now() / 1000);
    // The signature covers templateId + resolved variables + timestamp; the
    // render size always comes from the template record (so it cannot be
    // altered in the URL).
    const sig = await signCardRequest(env.NOTIFY_SECRET, {
      templateId: template.id,
      variables: resolvedVariables,
      ts,
    });
    const cardUrl = new URL('/api/card-image', origin);
    cardUrl.searchParams.set('templateId', template.id);
    cardUrl.searchParams.set('variables', JSON.stringify(resolvedVariables));
    cardUrl.searchParams.set('ts', String(ts));
    cardUrl.searchParams.set('sig', sig);
    imageUrl = cardUrl.toString();
  }

  /* --------------------- 3. resolve the recipients -------------------- */

  let subscriptions;
  try {
    subscriptions = await listActiveSubscriptions(db, userId);
  } catch (error) {
    rethrowDbError(error);
  }

  const title = pick(body.title, resolvedVariables?.title, template?.name) || 'PingCard';
  const description = pick(body.body, body.description, resolvedVariables?.body, resolvedVariables?.description) || '';
  const icon = pick(body.icon)
    ? assertSafeHttpUrl(body.icon, { field: 'icon' })
    : absoluteUrl(env.DEFAULT_ICON_URL || '/icons/icon-192.png', origin) || `${origin}/icons/icon-192.png`;
  const badge = pick(body.badge)
    ? assertSafeHttpUrl(body.badge, { field: 'badge' })
    : absoluteUrl(env.DEFAULT_BADGE_URL || '/icons/badge-72.png', origin) || `${origin}/icons/badge-72.png`;
  const url = absoluteUrl(pick(body.url) || '/', origin);
  const actions = normalizeActions(body.actions);
  const ttl = Number.isFinite(Number(body.ttl)) ? Number(body.ttl) : undefined;

  const payload = {
    title,
    body: description,
    icon,
    badge,
    image: imageUrl,
    url,
    actions,
    ts: Date.now(),
  };

  if (!subscriptions.length) {
    await logNotify(db, {
      targetUserId: userId,
      templateId: template?.id,
      payload,
      sentCount: 0,
      failedCount: 0,
    });
    return ok({
      sent: 0,
      failed: 0,
      cleaned: 0,
      total: 0,
      templateId: template?.id ?? null,
      imageUrl,
      message: userId
        ? `No active subscription for user "${userId}"`
        : 'No active subscriptions at all',
    });
  }

  if (dryRun) {
    return ok({
      dryRun: true,
      sent: 0,
      failed: 0,
      cleaned: 0,
      total: subscriptions.length,
      templateId: template?.id ?? null,
      imageUrl,
      payload,
    });
  }

  /* ----------------------- 4. send + clean up --------------------------- */

  const vapid = parseVapidKeys({
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  });

  let sent = 0;
  let failed = 0;
  let cleaned = 0;
  const failures = [];
  const expiredEndpoints = [];

  for (let i = 0; i < subscriptions.length; i += CONCURRENCY) {
    const batch = subscriptions.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (record) => {
        const subscription = { endpoint: record.endpoint, keys: { p256dh: record.p256dh, auth: record.auth } };
        const pushRequest = await buildPushRequest({ subscription, payload, vapid, ttl });
        const response = await fetch(pushRequest);
        return { record, outcome: await interpretPushResponse(response) };
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        failed += 1;
        failures.push({ status: 'error', detail: String(result.reason?.message || result.reason).slice(0, 200) });
        continue;
      }
      const { record, outcome } = result.value;
      if (outcome.ok) {
        sent += 1;
      } else if (outcome.expired) {
        cleaned += 1;
        expiredEndpoints.push(record.endpoint);
      } else {
        failed += 1;
        failures.push({ endpoint: record.endpoint.slice(-12), status: outcome.status, detail: outcome.detail });
      }
    }
  }

  // 5. purge the dead subscriptions (requirement 8.1)
  for (const endpoint of expiredEndpoints) {
    try {
      await deleteSubscriptionsByEndpoint(db, endpoint);
    } catch (error) {
      console.error('[pingcard] failed to clean up expired subscription:', error);
    }
  }

  waitUntil(
    logNotify(db, {
      targetUserId: userId,
      templateId: template?.id,
      payload,
      sentCount: sent,
      failedCount: failed,
    }),
  );

  const response = ok({
    sent,
    failed,
    cleaned,
    total: subscriptions.length,
    templateId: template?.id ?? null,
    imageUrl,
  });
  if (failures.length) {
    response.headers.set('x-pingcard-warnings', String(failures.length));
  }
  if (failures.length && body.debug === true) {
    return ok({ sent, failed, cleaned, total: subscriptions.length, templateId: template?.id ?? null, imageUrl, failures });
  }
  return response;
});
