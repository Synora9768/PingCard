/**
 * GET /api/status?userId=xxx
 * Reports how many devices are currently subscribed for a User ID.
 */
import { handler, ok } from '../_lib/http.js';
import { badRequest } from '../_lib/errors.js';
import { getDb, subscriptionStatsForUser, rethrowDbError } from '../_lib/db.js';
import { assertUserId } from './subscribe.js';

/** Never leak the raw endpoint; only a short fingerprint is exposed publicly. */
function fingerprint(endpoint) {
  try {
    const host = new URL(endpoint).host;
    return `${host.slice(0, 24)}…${endpoint.slice(-6)}`;
  } catch {
    return 'unknown';
  }
}

export const onRequestGet = handler(async ({ request, env }) => {
  const userId = new URL(request.url).searchParams.get('userId');
  if (!userId) throw badRequest('Query parameter "userId" is required');
  const id = assertUserId(userId);

  const db = getDb(env);
  let rows;
  try {
    rows = await subscriptionStatsForUser(db, id);
  } catch (error) {
    rethrowDbError(error);
  }

  return ok({
    userId: id,
    deviceCount: rows.length,
    subscriptions: rows.map((row) => ({
      userAgent: row.user_agent || null,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      endpointHint: fingerprint(row.endpoint),
    })),
  });
});
