/**
 * /api/admin/session — exchange ADMIN_SECRET for a short-lived session cookie.
 *
 *   POST   { "secret": "..." }  → logs in, sets the `pc_admin` cookie
 *   GET                          → reports whether the cookie is valid
 *   DELETE                       → logs out
 */
import { handler, ok, json, readJson, serializeCookie, parseCookies } from '../../_lib/http.js';
import { badRequest } from '../../_lib/errors.js';
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL,
  createAdminSession,
  requireAdmin,
  secretMatches,
  verifyAdminSession,
} from '../../_lib/auth.js';

export const onRequestPost = handler(async ({ request, env }) => {
  if (!env.ADMIN_SECRET) {
    throw new Error('ADMIN_SECRET is not configured (wrangler secret put ADMIN_SECRET)');
  }
  const body = await readJson(request);
  const secret = typeof body.secret === 'string' ? body.secret : '';
  if (!secret) throw badRequest('"secret" is required');
  if (!(await secretMatches(secret, env.ADMIN_SECRET))) {
    return json({ success: false, error: 'Invalid ADMIN_SECRET' }, 401);
  }

  const session = await createAdminSession(env);
  const response = ok({
    authenticated: true,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
    ttlSeconds: ADMIN_SESSION_TTL,
  });
  response.headers.append(
    'set-cookie',
    serializeCookie(ADMIN_COOKIE, session.token, {
      maxAge: session.maxAge,
      path: '/',
      sameSite: 'Strict',
      httpOnly: true,
      secure: true,
    }),
  );
  return response;
});

export const onRequestGet = handler(async ({ request, env }) => {
  const cookies = parseCookies(request);
  const authenticated = await verifyAdminSession(env, cookies[ADMIN_COOKIE]);
  return ok({ authenticated });
});

export const onRequestDelete = handler(async ({ request, env }) => {
  try {
    await requireAdmin(request, env);
  } catch {
    /* logging out is always allowed */
  }
  const response = ok({ authenticated: false });
  response.headers.append(
    'set-cookie',
    serializeCookie(ADMIN_COOKIE, '', { maxAge: 0, path: '/', sameSite: 'Strict', httpOnly: true, secure: true }),
  );
  return response;
});
