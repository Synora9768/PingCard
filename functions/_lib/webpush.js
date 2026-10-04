/**
 * Web Push (RFC 8030 / RFC 8291 / RFC 8292) implemented with the Web Crypto API
 * only — no Node.js `crypto`, no `https`, no `web-push` npm package.
 *
 * Everything below runs unchanged in the Cloudflare Workers runtime (verified
 * by `npm run smoke`, see README "Compatibility notes").
 *
 * Message layout produced for `aes128gcm` (RFC 8188):
 *
 *   +-----------+--------+-----------+----------------+-------------------+
 *   | salt (16) | rs (4) | idlen (1) | keyid (65)     | ciphertext+tag    |
 *   +-----------+--------+-----------+----------------+-------------------+
 *   keyid = our ephemeral P-256 public key (uncompressed point)
 *
 * Key derivation:
 *   ikm = HKDF-SHA256(salt = auth_secret, ikm = ECDH(as_private, ua_public),
 *                     info = "WebPush: info\0" || ua_public || as_public, 32)
 *   cek  = HKDF-SHA256(salt = salt, ikm = ikm, info = "Content-Encoding: aes128gcm\0", 16)
 *   nonce= HKDF-SHA256(salt = salt, ikm = ikm, info = "Content-Encoding: nonce\0", 12)
 */
import { concatBytes, fromBase64Url, randomBytes, toBase64Url, uint32be, utf8 } from './bytes.js';
import { HttpError } from './errors.js';

export const MAX_PAYLOAD_BYTES = 4096; // ae128gcm record size we advertise
const VAPID_TTL_SECONDS = 12 * 60 * 60;
const PUSH_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------ *
 * primitive helpers
 * ------------------------------------------------------------------ */

async function importEcdhPrivateKey(privateKeyJwk) {
  return crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ]);
}

async function importEcdhPublicKey(rawPoint) {
  return crypto.subtle.importKey('raw', rawPoint, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

/** HKDF-SHA256 extract+expand. */
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Normalise a VAPID key into `{ publicKeyBytes, privateKeyJwk }`.
 * Accepts:
 *   - public: base64url of the 65-byte uncompressed point (what `web-push` and
 *     our `npm run vapid:keys` emit; also what browsers want in
 *     `applicationServerKey`)
 *   - public: base64url of an SPKI PEM/DER blob
 *   - private: base64url of the raw 32-byte scalar (web-push style)
 *   - private: a JWK JSON string
 *   - private: a PKCS#8 / SEC1 PEM ("-----BEGIN PRIVATE KEY-----")
 */
export function parseVapidKeys({ publicKey, privateKey, subject }) {
  if (!privateKey) throw new Error('VAPID_PRIVATE_KEY is not configured (wrangler secret put VAPID_PRIVATE_KEY)');
  if (!publicKey) throw new Error('VAPID_PUBLIC_KEY is not configured');
  if (!subject) throw new Error('VAPID_SUBJECT is not configured (e.g. mailto:you@example.com)');

  const privateKeyJwk = parsePrivateKey(privateKey);
  const publicKeyBytes = parsePublicKey(publicKey);

  // If the private key was supplied as a JWK, its x/y must match the configured
  // public key — a mismatch means notifications will be signed with a key the
  // browser did not subscribe with.
  if (privateKeyJwk.x && privateKeyJwk.y) {
    const derived = toBase64Url(concatBytes(new Uint8Array([4]), fromBase64Url(privateKeyJwk.x), fromBase64Url(privateKeyJwk.y)));
    if (derived !== toBase64Url(publicKeyBytes)) {
      console.warn('[pingcard] VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY — check your configuration');
    }
  }

  return {
    publicKeyBytes,
    publicKeyBase64Url: toBase64Url(publicKeyBytes),
    privateKeyJwk,
    subject,
  };
}

function parsePrivateKey(privateKey) {
  const value = String(privateKey).trim();

  if (value.startsWith('{')) {
    const jwk = JSON.parse(value);
    if (jwk.kty !== 'EC' || !jwk.d) throw new Error('VAPID_PRIVATE_KEY JWK must be an EC P-256 key with "d"');
    return { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y, ext: true };
  }

  if (value.startsWith('-----BEGIN')) {
    const der = pemToDer(value);
    const offset = der.length - 32;
    if (offset < 0) throw new Error('VAPID_PRIVATE_KEY PEM looks truncated');
    // For both PKCS#8 and SEC1 EC keys the raw scalar is the trailing 32 bytes.
    return privFromScalar(toBase64Url(der.subarray(offset)));
  }

  const raw = fromBase64Url(value);
  if (raw.length !== 32) {
    throw new Error(
      `VAPID_PRIVATE_KEY must be a 32-byte base64url scalar (got ${raw.length} bytes). ` +
        'Generate a pair with `npm run vapid:keys`.',
    );
  }
  return privFromScalar(toBase64Url(raw));
}

function privFromScalar(d) {
  // x/y are filled in by the caller when a public key is available; for signing
  // (ES256) the runtime only needs d, which Web Crypto accepts.
  return { kty: 'EC', crv: 'P-256', d, ext: true };
}

function parsePublicKey(publicKey) {
  const value = String(publicKey).trim();
  let bytes;
  if (value.startsWith('-----BEGIN')) {
    bytes = pemToDer(value);
  } else {
    bytes = fromBase64Url(value);
  }
  if (bytes.length === 65 && bytes[0] === 4) return bytes;
  if (bytes.length === 91 || bytes.length === 158) {
    // SPKI DER: the uncompressed point is the trailing 65 bytes.
    const tail = bytes.subarray(bytes.length - 65);
    if (tail[0] === 4) return tail;
  }
  throw new Error(
    `VAPID_PUBLIC_KEY must be the 65-byte uncompressed P-256 point in base64url (got ${bytes.length} bytes). ` +
      'Run `npm run vapid:keys -- --from-private <VAPID_PRIVATE_KEY>` to derive it.',
  );
}

function pemToDer(pem) {
  const base64 = String(pem)
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  return fromBase64Url(base64.replace(/\+/g, '-').replace(/\//g, '_'));
}

/* ------------------------------------------------------------------ *
 * RFC 8291 payload encryption
 * ------------------------------------------------------------------ */

/**
 * Core of RFC 8188/8291: build one `aes128gcm` record from explicit key material.
 * Exposed separately so that it can be checked byte-for-byte against the
 * RFC 8291 §5 test vector (which fixes the salt and the application-server key pair).
 *
 * @param {object} options
 * @param {Uint8Array} options.body           plaintext bytes
 * @param {Uint8Array} options.uaPublicBytes  subscriber public key (65 bytes)
 * @param {Uint8Array} options.authSecret     subscriber auth secret (16 bytes)
 * @param {CryptoKey}  options.asPrivateKey   our ephemeral ECDH private key
 * @param {Uint8Array} options.asPublicBytes  our ephemeral public key (65 bytes)
 * @param {Uint8Array} options.salt           16 random bytes
 */
export async function encryptRecord({ body, uaPublicBytes, authSecret, asPrivateKey, asPublicBytes, salt }) {
  const uaPublicKey = await importEcdhPublicKey(uaPublicBytes);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, asPrivateKey, 256),
  );

  const ikm = await hkdf(
    authSecret,
    sharedSecret,
    concatBytes(utf8('WebPush: info\0'), uaPublicBytes, asPublicBytes),
    32,
  );

  // info strings per RFC 8291 §3.4 ("Content-Encoding: aes128gcm" / "…: nonce").
  const cekBytes = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const cek = await crypto.subtle.importKey('raw', cekBytes, 'AES-GCM', false, ['encrypt']);
  // Single record: plaintext || 0x02 (last-record delimiter) || zero padding.
  const record = concatBytes(body, new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cek, record),
  );

  return concatBytes(
    salt,
    uint32be(MAX_PAYLOAD_BYTES),
    new Uint8Array([asPublicBytes.length]),
    asPublicBytes,
    ciphertext,
  );
}

/**
 * Encrypt a push payload for one subscription, using a fresh key pair + salt.
 *
 * @param {Uint8Array|string} payload
 * @param {{endpoint: string, keys: { p256dh: string, auth: string }}} subscription
 */
export async function encryptPayload(payload, subscription) {
  const { keys } = subscription || {};
  if (!keys?.p256dh || !keys?.auth) {
    throw new HttpError(400, 'Subscription is missing keys.p256dh / keys.auth');
  }

  let uaPublicBytes;
  let authSecret;
  try {
    uaPublicBytes = fromBase64Url(keys.p256dh);
    authSecret = fromBase64Url(keys.auth);
  } catch {
    throw new HttpError(400, 'Subscription keys are not valid base64url');
  }
  if (uaPublicBytes.length !== 65 || uaPublicBytes[0] !== 4) {
    throw new HttpError(400, 'Subscription keys.p256dh must be an uncompressed P-256 point');
  }
  if (authSecret.length !== 16) {
    throw new HttpError(400, 'Subscription keys.auth must be 16 bytes');
  }

  const body = typeof payload === 'string' ? utf8(payload) : payload;
  if (body.byteLength > MAX_PAYLOAD_BYTES) {
    throw new HttpError(413, `Push payload is ${body.byteLength} bytes, the limit is ${MAX_PAYLOAD_BYTES}`);
  }

  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));

  return encryptRecord({
    body,
    uaPublicBytes,
    authSecret,
    asPrivateKey: asKeys.privateKey,
    asPublicBytes,
    salt: randomBytes(16),
  });
}

/* ------------------------------------------------------------------ *
 * RFC 8292 VAPID
 * ------------------------------------------------------------------ */

/** Build the `Authorization: vapid …` header (exported for tests). */
export async function vapidAuthorizationHeader(keys, endpoint, now = Date.now()) {
  const audience = new URL(endpoint).origin;
  const header = toBase64Url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(
    utf8(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(now / 1000) + VAPID_TTL_SECONDS,
        sub: keys.subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;

  const publicKeyBytes = keys.publicKeyBytes;
  const jwk = {
    ...keys.privateKeyJwk,
    x: toBase64Url(publicKeyBytes.subarray(1, 33)),
    y: toBase64Url(publicKeyBytes.subarray(33, 65)),
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
  // Web Crypto produces the IEEE-P1363 (r||s) signature that JWS ES256 expects.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(signingInput)),
  );
  return `vapid t=${signingInput}.${toBase64Url(signature)}, k=${keys.publicKeyBase64Url}`;
}

/* ------------------------------------------------------------------ *
 * request builder
 * ------------------------------------------------------------------ */

/**
 * Build the signed + encrypted POST request for one subscription.
 * @returns {Promise<Request>}
 */
export async function buildPushRequest({
  subscription,
  payload,
  vapid,
  ttl = 4 * 7 * 24 * 60 * 60,
  urgency = 'normal',
  topic,
}) {
  const endpoint = subscription?.endpoint;
  if (!endpoint || typeof endpoint !== 'string') throw new HttpError(400, 'Subscription endpoint is missing');
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpError(400, 'Subscription endpoint is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'Subscription endpoint must use https');

  const body = await encryptPayload(payload, subscription);
  const headers = new Headers({
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    'content-length': String(body.byteLength),
    ttl: String(Math.max(0, Math.floor(ttl))),
    urgency,
    authorization: await vapidAuthorizationHeader(vapid, endpoint),
  });
  if (topic && /^[A-Za-z0-9_\-]{1,32}$/.test(topic)) headers.set('topic', topic);

  return new Request(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
}

/** True when the push service tells us the subscription is dead and must be purged. */
export function isExpiredPushStatus(status) {
  return status === 404 || status === 410;
}

/**
 * Interpret the push service response.
 * @returns {{status: number, ok: boolean, expired: boolean, retryable: boolean, detail?: string}}
 */
export async function interpretPushResponse(response) {
  const status = response.status;
  const ok = status >= 200 && status < 300;
  let detail;
  if (!ok) {
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      detail = undefined;
    }
  }
  return {
    status,
    ok,
    expired: isExpiredPushStatus(status),
    retryable: status === 429 || status === 500 || status === 502 || status === 503 || status === 504,
    detail: ok ? undefined : `HTTP ${status}${detail ? `: ${detail}` : ''}`,
  };
}
