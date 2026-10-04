/**
 * HMAC-SHA256 signing / verification for `/api/card-image`.
 *
 * The signature is only ever produced inside `/api/notify` (and by the admin
 * preview flow, which is authenticated with ADMIN_SECRET instead) — callers of
 * the notify API never need to know how it works.
 */
import { concatBytes, fromBase64Url, toBase64Url, toHex, timingSafeEqual, uint32be, utf8 } from './bytes.js';

/**
 * Canonical string that is signed.
 * `variables` is serialised with sorted keys so that two equivalent payloads
 * always produce the same signature (and therefore the same cache entry).
 */
export function canonicalCardRequest({ templateId, variables, width, height }) {
  const sortedVariables = {};
  for (const key of Object.keys(variables || {}).sort()) {
    sortedVariables[key] = variables[key];
  }
  return JSON.stringify({
    t: templateId ?? null,
    v: sortedVariables,
    w: width ?? null,
    h: height ?? null,
  });
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Raw HMAC-SHA256 digest (Uint8Array). */
export async function hmacSha256(secret, message) {
  const key = await hmacKey(secret);
  const digest = await crypto.subtle.sign('HMAC', key, typeof message === 'string' ? utf8(message) : message);
  return new Uint8Array(digest);
}

/** SHA-256 digest of a string (Uint8Array). */
export async function sha256(message) {
  const digest = await crypto.subtle.digest('SHA-256', typeof message === 'string' ? utf8(message) : message);
  return new Uint8Array(digest);
}

/** Short hex hash, handy for cache keys. */
export async function sha256Hex(message) {
  return toHex(await sha256(message));
}

/**
 * Create the `sig` value attached to a card-image URL.
 * `ts` (unix seconds) is part of the signed message so links expire.
 */
export async function signCardRequest(secret, { templateId, variables, ts, width, height }) {
  const message = `${canonicalCardRequest({ templateId, variables, width, height })}.${ts}`;
  return toBase64Url(await hmacSha256(secret, message));
}

/**
 * Verify a card-image signature and its freshness.
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function verifyCardSignature(secret, { templateId, variables, ts, width, height, sig }, { ttlSeconds = 300 } = {}) {
  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return { valid: false, reason: 'invalid_timestamp' };
  const age = Math.floor(Date.now() / 1000) - timestamp;
  if (age > ttlSeconds) return { valid: false, reason: 'expired' };
  // Small tolerance for clock skew in the other direction.
  if (age < -60) return { valid: false, reason: 'not_yet_valid' };
  if (typeof sig !== 'string' || sig.length === 0) return { valid: false, reason: 'missing_signature' };

  const expected = await signCardRequest(secret, { templateId, variables, ts: timestamp, width, height });
  // Constant-time comparison of the base64url strings would still leak length,
  // so compare the raw digests via timingSafeEqual on fixed-size arrays.
  let providedBytes;
  try {
    providedBytes = fromBase64Url(sig);
  } catch {
    return { valid: false, reason: 'malformed_signature' };
  }
  const expectedBytes = fromBase64Url(expected);
  if (providedBytes.length !== expectedBytes.length) return { valid: false, reason: 'bad_signature' };
  const valid = timingSafeEqual(toHex(providedBytes), toHex(expectedBytes));
  return valid ? { valid: true } : { valid: false, reason: 'bad_signature' };
}

/**
 * Deterministic cache key for a rendered card image.
 * Length-prefixed framing keeps `{"a":"b"}` + `"c"` distinct from `{"a":"bc"}`.
 *
 * `revision` (a template's `updated_at`) is part of the key so that editing a
 * template immediately invalidates its cached renders — the signature itself
 * never covers the revision, because notify signs *before* the template can
 * change.
 */
export async function cardCacheKey({ templateId, variables, width, height, revision }) {
  const canonical = canonicalCardRequest({ templateId, variables, width, height });
  const framed = concatBytes(
    uint32be(templateId ? templateId.length : 0),
    utf8(templateId || ''),
    uint32be(String(revision ?? '').length),
    utf8(String(revision ?? '')),
    uint32be(canonical.length),
    utf8(canonical),
  );
  return `card:${await sha256Hex(framed)}`;
}
