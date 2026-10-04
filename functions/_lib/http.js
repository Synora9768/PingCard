/**
 * Tiny HTTP helpers: JSON responses, typed errors, body parsing.
 * Every route funnels its errors through `errorResponse` so that no handler
 * can leak an uncaught exception (requirement 8.4 of the spec).
 */
import { HttpError } from './errors.js';

/**
 * @param {unknown} data
 * @param {number|ResponseInit} [init]
 */
export function json(data, init = 200) {
  const responseInit = typeof init === 'number' ? { status: init } : init;
  const headers = new Headers(responseInit.headers || {});
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data ?? null), { ...responseInit, headers });
}

/** Successful API envelope. */
export function ok(data = {}, init = 200) {
  return json({ success: true, ...data }, init);
}

/** Error envelope: `{ success: false, error: '...' }`. */
export function errorResponse(error) {
  if (error instanceof HttpError) {
    return json(
      { success: false, error: error.message, ...(error.details ? { details: error.details } : {}) },
      error.status,
    );
  }
  // Anything unexpected is a 500 — but we still return JSON, never a stack dump
  // aimed at the client (the stack is logged for `wrangler pages deployment tail`).
  console.error('[pingcard] unhandled error:', error && (error.stack || error));
  return json(
    { success: false, error: 'Internal server error', detail: String(error?.message || error) },
    500,
  );
}

/** Wrap a Pages Function handler with method checks + error funneling. */
export function handler(fn, { methods } = {}) {
  return async function onRequest(context) {
    try {
      if (methods && !methods.includes(context.request.method)) {
        throw new HttpError(405, `Method ${context.request.method} not allowed (expected ${methods.join(', ')})`);
      }
      return await fn(context);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** Read + parse a JSON body with a size guard. */
export async function readJson(request, { maxBytes = 256 * 1024, required = true } = {}) {
  const raw = await request.text();
  if (!raw.trim()) {
    if (required) throw new HttpError(400, 'Request body must be JSON');
    return null;
  }
  if (raw.length > maxBytes) {
    throw new HttpError(413, `Request body too large (limit ${maxBytes} bytes)`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'Request body must be a valid JSON object');
  }
}

/** Parse a cookie header into a plain object. */
export function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  /** @type {Record<string,string>} */
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

/** Build a Set-Cookie string. */
export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Strict'}`);
  return parts.join('; ');
}
