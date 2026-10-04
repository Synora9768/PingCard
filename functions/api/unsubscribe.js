/**
 * POST /api/unsubscribe
 * Body: { userId, endpoint }
 *
 * Removes the subscription row so the device stops receiving pushes
 * (acceptance criterion: "关闭通知后该设备不再收到推送，对应数据库记录已清理").
 */
import { handler, readJson, ok } from '../_lib/http.js';
import { badRequest } from '../_lib/errors.js';
import { getDb, deleteSubscription, subscriptionStatsForUser, rethrowDbError } from '../_lib/db.js';
import { assertUserId } from './subscribe.js';

export const onRequestPost = handler(async ({ request, env }) => {
  const body = await readJson(request);
  const userId = assertUserId(body.userId);
  const endpoint = body.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length < 12) {
    throw badRequest('"endpoint" is required');
  }

  const db = getDb(env);
  let removed = 0;
  try {
    const result = await deleteSubscription(db, { endpoint, userId });
    removed = result?.meta?.changes ?? result?.changes ?? 0;
  } catch (error) {
    rethrowDbError(error);
  }

  const subscriptions = await subscriptionStatsForUser(db, userId);
  return ok({ userId, removed, deviceCount: subscriptions.length });
});
