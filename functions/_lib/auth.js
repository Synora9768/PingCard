/**
 * Authentication helpers.
 *
 * Two credentials exist:
 *  - NOTIFY_SECRET : bearer token for `POST /api/notify`
 *  - ADMIN_SECRET  : the admin console password, exchanged for a short-lived
 *                    HMAC session cookie so the operator does not have to
 *                    paste the secret on every click.
 */
import { hmacSha256, sha256 } from './sign.js';
import { fromBase64Url, randomBytes, toBase64Url, toHex, utf8 } from './bytes.js';
import { parseCookies } from './http.js';
import { forbidden, unauthorized } from './errors.js';

export const ADMIN_COOKIE = 'pc_admin';
export const ADMIN_SESSION_TTL = 60 * 60 * 12; // 12 hours

/** Compare a candidate secret with the configured one in constant time. */
export async function secretMatches(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = await sha256(candidate);
  const b = await sha256(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Extract a bearer token (`Authorization: Bearer xxx`). */
export function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Guard a notify endpoint. Throws 401/500. */
export async function requireNotifySecret(request, env) {
  if (!env.NOTIFY_SECRET) {
    throw new Error('NOTIFY_SECRET is not configured (wrangler secret put NOTIFY_SECRET)');
  }
  const token = bearerToken(request) || request.headers.get('x-notify-secret');
  if (!token) throw unauthorized('Missing Authorization: Bearer <NOTIFY_SECRET> header');
  if (!(await secretMatches(token, env.NOTIFY_SECRET))) throw unauthorized('Invalid NOTIFY_SECRET');
}

/* ------------------------------------------------------------------ *
 * Admin session cookie: value = base64url(expiry|hmac(expiry))
 * ------------------------------------------------------------------ */

async function sessionSignature(secret, expiry) {
  return toHex(await hmacSha256(secret, `pingcard-admin-session:${expiry}`));
}

export async function createAdminSession(env, { ttl = ADMIN_SESSION_TTL } = {}) {
  if (!env.ADMIN_SECRET) throw new Error('ADMIN_SECRET is not configured');
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const signature = await sessionSignature(env.ADMIN_SECRET, expiry);
  return { token: `${expiry}.${signature}`, expiresAt: expiry, maxAge: ttl };
}

export async function verifyAdminSession(env, token) {
  if (!env.ADMIN_SECRET || typeof token !== 'string' || !token.includes('.')) return false;
  const [expiryRaw, signature] = token.split('.');
  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry < Math.floor(Date.now() / 1000)) return false;
  const expected = await sessionSignature(env.ADMIN_SECRET, expiry);
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Accepts, in order: cached session cookie, `Authorization: Bearer ADMIN_SECRET`
 * or `X-Admin-Secret: ADMIN_SECRET` (the last two are what curl examples use).
 * @returns {Promise<{via: 'cookie'|'bearer'|'header'}>}
 */
export async function requireAdmin(request, env) {
  if (!env.ADMIN_SECRET) {
    throw new Error('ADMIN_SECRET is not configured (wrangler secret put ADMIN_SECRET)');
  }
  const cookies = parseCookies(request);
  if (await verifyAdminSession(env, cookies[ADMIN_COOKIE])) return { via: 'cookie' };

  const headerSecret = request.headers.get('x-admin-secret');
  if (headerSecret && (await secretMatches(headerSecret, env.ADMIN_SECRET))) return { via: 'header' };

  const token = bearerToken(request);
  if (token && (await secretMatches(token, env.ADMIN_SECRET))) return { via: 'bearer' };

  const cookiesPresent = Object.keys(cookies).length > 0;
  throw forbidden(
    cookiesPresent
      ? 'Admin session expired or invalid — log in again at /admin/templates'
      : 'Admin authentication required (session cookie, X-Admin-Secret header or Bearer ADMIN_SECRET)',
  );
}

/** Random, URL-safe identifier (used for template ids and User IDs). */
export function randomId(length = 10, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789') {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
