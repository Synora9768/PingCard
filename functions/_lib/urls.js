/**
 * URL validation.
 *
 * Used for the admin checklist and for every user-supplied image URL so that
 * the renderer can never be pointed at internal network resources (SSRF).
 */
import { HttpError } from './errors.js';

/** Hosts/patterns that must never be fetched from the Worker. */
export function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;

  // IPv4 literal
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6 literal (URL hostnames keep the brackets stripped here)
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // unique local
    return false;
  }
  return false;
}

/**
 * Assert that `value` is an absolute http(s) URL pointing at a public host.
 * @returns {string} the normalised URL
 */
export function assertSafeHttpUrl(value, { field = 'url', allowData = false, maxLength = 2048 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `"${field}" must be a non-empty string`);
  }
  const raw = value.trim();
  if (raw.length > maxLength) throw new HttpError(400, `"${field}" is too long (max ${maxLength} characters)`);
  if (allowData && raw.startsWith('data:image/')) {
    if (!/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(raw)) {
      throw new HttpError(400, `"${field}" contains an unsupported data: URI`);
    }
    return raw;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `"${field}" must be a valid absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, `"${field}" must use http or https`);
  }
  if (isBlockedHost(url.hostname)) {
    throw new HttpError(400, `"${field}" points at a private or reserved host, which is not allowed`);
  }
  return url.toString();
}

/** Make a URL absolute against a base (used for the default icon/badge). */
export function absoluteUrl(value, base) {
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}
