/**
 * POST /api/subscribe
 *
 * Body: { userId, subscription: { endpoint, keys: { p256dh, auth } }, userAgent? }
 *
 * Upserts by `endpoint`, so clicking "开启通知" repeatedly (or re-subscribing
 * after a browser restart) never creates duplicate rows.
 */
import { handler, readJson, ok } from '../_lib/http.js';
import { badRequest } from '../_lib/errors.js';
import { getDb, upsertSubscription, subscriptionStatsForUser, rethrowDbError } from '../_lib/db.js';

export const USER_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;

export function assertUserId(value) {
  if (typeof value !== 'string' || !USER_ID_RE.test(value.trim())) {
    throw badRequest(
      '"userId" must be 2-64 characters using letters, digits, underscore or hyphen',
    );
  }
  return value.trim();
}

export function assertSubscription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('"subscription" must be an object');
  }
  const endpoint = value.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length < 12) {
    throw badRequest('"subscription.endpoint" is required');
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw badRequest('"subscription.endpoint" must be a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw badRequest('"subscription.endpoint" must use https');
  }
  const keys = value.keys || {};
  const p256dh = keys.p256dh;
  const auth = keys.auth;
  if (typeof p256dh !== 'string' || p256dh.length < 40) {
    throw badRequest('"subscription.keys.p256dh" is required');
  }
  if (typeof auth !== 'string' || auth.length < 12) {
    throw badRequest('"subscription.keys.auth" is required');
  }
  return { endpoint, keys: { p256dh, auth } };
}

export const onRequestPost = handler(async ({ request, env }) => {
  const body = await readJson(request);
  const userId = assertUserId(body.userId);
  const subscription = assertSubscription(body.subscription);
  const userAgent =
    typeof body.userAgent === 'string' && body.userAgent.trim()
      ? body.userAgent.trim().slice(0, 400)
      : request.headers.get('user-agent')?.slice(0, 400) || null;

  const db = getDb(env);
  try {
    await upsertSubscription(db, { userId, subscription, userAgent });
  } catch (error) {
    rethrowDbError(error);
  }

  const subscriptions = await subscriptionStatsForUser(db, userId);
  return ok({
    userId,
    deviceCount: subscriptions.length,
    message: 'Subscription stored',
  });
});
