/**
 * GET /api/card-image?templateId=&variables=<urlencoded JSON>&ts=&sig=
 *
 * Renders the card PNG on the fly. Two ways in (spec §4.5):
 *   1. a valid HMAC signature (`sig`/`ts`, produced only by /api/notify)
 *   2. an authenticated admin session (the /admin/templates live preview)
 *
 * Results are cached in the Cloudflare Cache API keyed by the *content*
 * (template id + template revision + variables + size), so the same card is
 * only rendered once.
 */
import { handler } from '../_lib/http.js';
import { HttpError, badRequest } from '../_lib/errors.js';
import { requireAdmin } from '../_lib/auth.js';
import { cardCacheKey, verifyCardSignature } from '../_lib/sign.js';
import { getDb, getDefaultTemplate, getTemplate, rethrowDbError } from '../_lib/db.js';
import { resolveVariables } from '../_lib/templateEngine.js';
import { renderCardToPng, DEFAULT_WIDTH, DEFAULT_HEIGHT } from '../_lib/renderCard.js';

const SIGNATURE_TTL_SECONDS = 300; // 5 minutes (spec §4.4)
const CACHE_SECONDS = 60 * 60 * 24;
const BYPASS_HEADER = 'x-pingcard-cache';

export const onRequestGet = handler(
  async (context) => {
    const { request, env, waitUntil } = context;
    const url = new URL(request.url);

    // Duplicate parameters would be ambiguous (different layers could pick
    // different values), so they are rejected outright.
    for (const name of ['templateId', 'variables', 'ts', 'sig']) {
      if (url.searchParams.getAll(name).length > 1) {
        throw badRequest(`Query parameter "${name}" must not be repeated`);
      }
    }

    const templateId = url.searchParams.get('templateId') || undefined;
    const variablesParam = url.searchParams.get('variables');
    const ts = url.searchParams.get('ts');
    const sig = url.searchParams.get('sig');
    const width = url.searchParams.get('w') || url.searchParams.get('width') || undefined;
    const height = url.searchParams.get('h') || url.searchParams.get('height') || undefined;
    const forceFresh = url.searchParams.get('fresh') === '1';

    /** @type {Record<string, unknown>|undefined} */
    let variables;
    if (variablesParam !== null && variablesParam !== '') {
      try {
        variables = JSON.parse(variablesParam);
      } catch {
        throw badRequest('Query parameter "variables" must be URL-encoded JSON');
      }
      if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
        throw badRequest('Query parameter "variables" must be a JSON object');
      }
    }

    /* ----------------------------- 1. authorise ---------------------------- */

    let verifiedBy = null;
    let signatureReason = 'missing_signature';

    if (sig && ts) {
      if (!env.NOTIFY_SECRET) throw new Error('NOTIFY_SECRET is not configured');
      const check = await verifyCardSignature(
        env.NOTIFY_SECRET,
        { templateId, variables, ts, sig },
        { ttlSeconds: SIGNATURE_TTL_SECONDS },
      );
      if (check.valid) verifiedBy = 'signature';
      else signatureReason = check.reason;
    }

    let adminView = false;
    if (!verifiedBy) {
      try {
        await requireAdmin(request, env);
        verifiedBy = 'admin';
        adminView = true;
      } catch {
        // fall through to the 403 below
      }
    }

    if (!verifiedBy) {
      throw new HttpError(
        403,
        signatureReason === 'expired'
          ? 'Link expired: card-image signatures are valid for 5 minutes'
          : 'Signature check failed — /api/card-image can only be called with a valid signature or an admin session',
        { reason: signatureReason },
      );
    }

    /* ---------------------------- 2. load template ------------------------- */

    const db = getDb(env);
    let template;
    try {
      template = templateId ? await getTemplate(db, templateId) : await getDefaultTemplate(db);
    } catch (error) {
      rethrowDbError(error);
    }
    if (!template) {
      throw new HttpError(404, templateId ? `Template "${templateId}" not found` : 'No default template configured');
    }

    // strict validation guarantees the canonical variable set matches the one
    // /api/notify signed (schema defaults + image URL normalisation included).
    const resolved = resolveVariables(variables, template.variablesSchema, { strict: !adminView });

    // Signed requests always render at the template's own size; only the admin
    // preview (cookie-authenticated) may override it, e.g. for thumbnails.
    const renderWidth = adminView && width ? Number(width) : template.width || DEFAULT_WIDTH;
    const renderHeight = adminView && height ? Number(height) : template.height || DEFAULT_HEIGHT;

    /* ------------------------------ 3. caching ----------------------------- */

    const cacheKeyHash = await cardCacheKey({
      templateId: template.id,
      variables: resolved,
      width: renderWidth,
      height: renderHeight,
      revision: template.updatedAt,
    });
    const cacheKey = new Request(`${url.origin}/__pingcard-cache/${cacheKeyHash}`, { method: 'GET' });
    const cache = typeof caches !== 'undefined' ? caches.default : null;

    if (cache && !forceFresh) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const response = new Response(hit.body, hit);
        response.headers.set(BYPASS_HEADER, 'HIT');
        response.headers.set('x-pingcard-render-ms', '0');
        return response;
      }
    }

    /* ------------------------------ 4. render ------------------------------ */

    const started = Date.now();
    const { png, width: outWidth, height: outHeight } = await renderCardToPng({
      htmlTemplate: template.htmlTemplate,
      variables: resolved,
      width: renderWidth,
      height: renderHeight,
      env,
      requestUrl: request.url,
    });
    const renderMs = Date.now() - started;

    const response = new Response(png, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(png.byteLength),
        'cache-control': `public, max-age=${CACHE_SECONDS}`,
        'x-pingcard-template': template.id,
        'x-pingcard-size': `${outWidth}x${outHeight}`,
        'x-pingcard-render-ms': String(renderMs),
        'x-pingcard-verified-by': verifiedBy,
        [BYPASS_HEADER]: forceFresh ? 'BYPASS' : 'MISS',
      },
    });

    if (cache) {
      // Ignore cache errors: rendering already succeeded.
      waitUntil(cache.put(cacheKey, response.clone()).catch((error) => {
        console.error('[pingcard] cache.put failed:', error);
      }));
    }

    return response;
  },
  { methods: ['GET'] },
);

/** Exported for tests / docs. */
export { SIGNATURE_TTL_SECONDS, CACHE_SECONDS };
