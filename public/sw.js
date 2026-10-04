/* PingCard service worker — receives Web Push messages and shows rich cards. */
/* eslint-env serviceworker */

const CACHE_NAME = 'pingcard-v1';
const USER_ID_CACHE_KEY = '/__pingcard_user_id';
const DEFAULT_URL = '/';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/* --------------------------------------------------------------- *
 * push
 * --------------------------------------------------------------- */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    if (event.data) {
      const text = event.data.text();
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { title: 'PingCard', body: text };
      }
    }
  } catch (error) {
    payload = { title: 'PingCard', body: '收到一条无法解析的通知' };
  }

  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'PingCard';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    icon: payload.icon || undefined,
    badge: payload.badge || undefined,
    image: payload.image || undefined,
    data: {
      url: payload.url || DEFAULT_URL,
      ...(payload.data && typeof payload.data === 'object' ? payload.data : {}),
      receivedAt: Date.now(),
    },
    tag: payload.tag || undefined,
    renotify: Boolean(payload.tag) && payload.renotify !== false,
    requireInteraction: payload.requireInteraction === true,
    silent: payload.silent === true,
  };

  // Notification actions are only honoured by Chromium-based browsers; iOS
  // ignores them, so the payload is still fully usable without them.
  if (Array.isArray(payload.actions) && payload.actions.length) {
    options.actions = payload.actions
      .filter((action) => action && typeof action.action === 'string')
      .slice(0, 2)
      .map((action) => ({ action: action.action, title: action.title || action.action, icon: action.icon }));
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

/* --------------------------------------------------------------- *
 * notificationclick
 * --------------------------------------------------------------- */

async function focusOrOpen(url) {
  const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of allClients) {
    try {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === new URL(url, self.location.origin).origin) {
        await client.focus();
        if ('navigate' in client && client.url !== url) {
          await client.navigate(url).catch(() => {});
        }
        return;
      }
    } catch {
      /* ignore malformed client urls */
    }
  }
  await self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const data = (notification && notification.data) || {};
  const target = data.url || DEFAULT_URL;
  notification.close();

  // "忽略" / dismiss branch: just close the notification.
  if (event.action === 'dismiss') return;

  const action = event.action || 'open';
  let url = target;
  try {
    const parsed = new URL(target, self.location.origin);
    parsed.searchParams.set('pc_action', action);
    url = parsed.toString();
  } catch {
    url = DEFAULT_URL;
  }

  event.waitUntil(focusOrOpen(url));
});

self.addEventListener('notificationclose', () => {
  /* analytics hook — intentionally empty */
});

/* --------------------------------------------------------------- *
 * pushsubscriptionchange — the push service rotated the endpoint
 * --------------------------------------------------------------- */

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const subscription =
          event.newSubscription ||
          (await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: event.oldSubscription?.options?.applicationServerKey,
          }));

        const cache = await caches.open(CACHE_NAME);
        const stored = await cache.match(USER_ID_CACHE_KEY);
        const userId = stored ? await stored.text() : null;
        const oldEndpoint = event.oldSubscription?.endpoint;

        if (userId) {
          if (oldEndpoint) {
            await fetch('/api/unsubscribe', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ userId, endpoint: oldEndpoint }),
            }).catch(() => {});
          }
          await fetch('/api/subscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              userId,
              subscription: subscription.toJSON(),
              userAgent: self.navigator?.userAgent || undefined,
            }),
          });
        }

        // Ask any open tab to refresh its status display.
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clients) client.postMessage({ type: 'pingcard:subscription-changed' });
      } catch (error) {
        console.error('[pingcard/sw] pushsubscriptionchange failed', error);
      }
    })(),
  );
});

/* --------------------------------------------------------------- *
 * page → worker channel (lets the page remember the User ID for
 * pushsubscriptionchange handling)
 * --------------------------------------------------------------- */

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'pingcard:store-user-id' && typeof data.userId === 'string') {
    event.waitUntil(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.put(USER_ID_CACHE_KEY, new Response(data.userId)))
        .catch(() => {}),
    );
  }
});
