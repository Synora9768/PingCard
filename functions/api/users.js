/**
 * GET /api/users — admin-only overview of every User ID and its device count.
 */
import { handler, ok } from '../_lib/http.js';
import { requireAdmin } from '../_lib/auth.js';
import { getDb, listUsers, rethrowDbError } from '../_lib/db.js';

export const onRequestGet = handler(
  async ({ request, env }) => {
    await requireAdmin(request, env);
    const db = getDb(env);
    let rows;
    try {
      rows = await listUsers(db);
    } catch (error) {
      rethrowDbError(error);
    }

    const users = rows.map((row) => ({
      userId: row.user_id,
      deviceCount: Number(row.active_device_count || 0),
      totalRecords: Number(row.device_count || 0),
      firstSeenAt: row.first_seen_at,
      lastActiveAt: row.last_active_at,
    }));

    return ok({
      count: users.length,
      totalActiveDevices: users.reduce((sum, user) => sum + user.deviceCount, 0),
      users,
    });
  },
  { methods: ['GET'] },
);
