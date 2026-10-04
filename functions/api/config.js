/**
 * GET /api/config — public runtime configuration for the browser clients.
 * Only non-sensitive values are exposed (the VAPID *public* key is meant to be
 * public: browsers need it to subscribe).
 */
import { handler, ok } from '../_lib/http.js';
import { absoluteUrl } from '../_lib/urls.js';
import { MAX_PAYLOAD_BYTES } from '../_lib/webpush.js';

export const onRequestGet = handler(
  async ({ request, env }) => {
    const origin = new URL(request.url).origin;
    return ok({
      vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
      defaultIcon: absoluteUrl(env.DEFAULT_ICON_URL || '/icons/icon-192.png', origin),
      defaultBadge: absoluteUrl(env.DEFAULT_BADGE_URL || '/icons/badge-72.png', origin),
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
      userIdPattern: '^[A-Za-z0-9_-]{2,64}$',
    });
  },
  { methods: ['GET'] },
);
