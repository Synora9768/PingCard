/**
 * Small binary / text encoding helpers used across the Functions.
 * Everything here relies only on standards available in the Workers runtime.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** UTF-8 encode a string into a Uint8Array. */
export function utf8(str) {
  return textEncoder.encode(str);
}

/** UTF-8 decode bytes into a string. */
export function fromUtf8(bytes) {
  return textDecoder.decode(bytes);
}

/** base64url (RFC 4648 §5, no padding) encode of bytes. */
export function toBase64Url(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url decode into a Uint8Array. Accepts padded/unpadded + standard alphabet. */
export function fromBase64Url(value) {
  if (typeof value !== 'string') throw new TypeError('base64url value must be a string');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new TypeError('invalid base64url value');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Standard base64 encode (used for inline data: URIs). */
export function toBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Concatenate any number of byte arrays. */
export function concatBytes(...chunks) {
  const parts = chunks.map((c) => (c instanceof Uint8Array ? c : new Uint8Array(c)));
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Lowercase hex string of bytes. */
export function toHex(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Cryptographically strong random bytes. */
export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Big-endian uint32 → 4 bytes. */
export function uint32be(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

/**
 * Constant-time string comparison. Used for every shared-secret check so that
 * an attacker cannot recover a secret byte-by-byte through timing.
 */
export function timingSafeEqual(a, b) {
  const left = utf8(String(a));
  const right = utf8(String(b));
  // Hash both sides first so that differing lengths cannot short-circuit.
  // (SubtleCrypto is async, so we use a fixed-cost loop below instead and
  // compare lengths in constant time as well.)
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}
