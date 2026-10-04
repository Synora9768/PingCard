/**
 * PingCard — 通知设置页逻辑。
 * 纯原生 JS，无构建步骤。
 */

const STORAGE_KEY = 'pingcard.userId';
const ID_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;

const el = (id) => document.getElementById(id);
const ui = {
  userId: el('userId'),
  copyBtn: el('copyBtn'),
  saveBtn: el('saveBtn'),
  statusDot: el('statusDot'),
  statusText: el('statusText'),
  permText: el('permText'),
  deviceText: el('deviceText'),
  swText: el('swText'),
  enableBtn: el('enableBtn'),
  disableBtn: el('disableBtn'),
  refreshBtn: el('refreshBtn'),
  testBtn: el('testBtn'),
  feedback: el('feedback'),
};

/** @type {{vapidPublicKey: string|null, defaultIcon: string, defaultBadge: string}} */
let config = { vapidPublicKey: null, defaultIcon: '/icons/icon-192.png', defaultBadge: '/icons/badge-72.png' };

/* ------------------------------------------------------------------ utils */

function generateUserId(length = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

function getStoredUserId() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && ID_PATTERN.test(stored)) return stored;
  } catch {
    /* localStorage may be unavailable (private mode) */
  }
  return null;
}

function storeUserId(userId) {
  try {
    localStorage.setItem(STORAGE_KEY, userId);
  } catch {
    /* ignore */
  }
}

function currentUserId() {
  const value = ui.userId.value.trim();
  return ID_PATTERN.test(value) ? value : null;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

let feedbackTimer = null;
function feedback(message, kind = 'info', { sticky = false } = {}) {
  ui.feedback.textContent = message;
  ui.feedback.className = `feedback show ${kind}`;
  clearTimeout(feedbackTimer);
  if (!sticky && kind !== 'err') {
    feedbackTimer = setTimeout(() => ui.feedback.classList.remove('show'), 6000);
  }
}

function setStatus(kind, text) {
  ui.statusDot.className = `dot ${kind}`;
  ui.statusText.textContent = text;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || (body && body.success === false)) {
    const error = new Error((body && (body.error || body.detail)) || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body || {};
}

/* ------------------------------------------------------------- environment */

function environmentReport() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  const hasNotification = 'Notification' in window;
  const hasServiceWorker = 'serviceWorker' in navigator;
  const hasPush = 'PushManager' in window;
  return { ua, isIOS, standalone, hasNotification, hasServiceWorker, hasPush };
}

function renderCapabilityHints() {
  const env = environmentReport();
  if (env.isIOS && !env.standalone) {
    feedback(
      'iOS 需要先把本页「添加到主屏幕」，再从主屏幕图标打开才能开启推送（iOS 16.4+ 才支持 Web Push）。',
      'warn',
      { sticky: true },
    );
    ui.enableBtn.disabled = true;
    return false;
  }
  if (!env.hasNotification || !env.hasServiceWorker || !env.hasPush) {
    feedback('当前浏览器不支持 Web Push（缺少 Notification / Service Worker / PushManager），请更换 Chrome、Edge、Firefox 或 Safari 16.4+。', 'warn', {
      sticky: true,
    });
    ui.enableBtn.disabled = true;
    return false;
  }
  return true;
}

/* ------------------------------------------------------------ subscription */

async function getRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.getRegistration('/') || null;
}

async function getSubscription() {
  const registration = await getRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

async function ensureServiceWorker() {
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  return registration;
}

async function enableNotifications() {
  const userId = currentUserId();
  if (!userId) {
    feedback('请先填写合法的 User ID（2–64 位字母、数字、下划线或连字符）。', 'err');
    return;
  }
  if (!config.vapidPublicKey) {
    feedback('服务端未配置 VAPID_PUBLIC_KEY，无法订阅。请参考 README 生成密钥并执行 wrangler secret put。', 'err', { sticky: true });
    return;
  }

  ui.enableBtn.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    ui.permText.textContent = permission;
    if (permission === 'denied') {
      feedback('通知权限已被拒绝。请在浏览器地址栏左侧的站点设置中重新允许通知，然后再次点击「开启通知」。', 'err', { sticky: true });
      return;
    }
    if (permission !== 'granted') {
      feedback('未获得通知权限，已取消订阅流程。', 'warn');
      return;
    }

    feedback('正在注册 Service Worker…', 'info');
    const registration = await ensureServiceWorker();

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
      });
    }

    feedback('正在同步订阅到服务器…', 'info');
    const result = await api('/api/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        userId,
        subscription: subscription.toJSON(),
        userAgent: navigator.userAgent,
      }),
    });

    // Let the service worker remember the User ID so it can transparently
    // re-register when the push service rotates the endpoint.
    navigator.serviceWorker.controller?.postMessage({ type: 'pingcard:store-user-id', userId });

    feedback(`订阅成功 ✅ 当前该 User ID 下有 ${result.deviceCount ?? 1} 台设备。`, 'ok');
    await refreshStatus();
  } catch (error) {
    console.error(error);
    feedback(`订阅失败：${error.message}`, 'err', { sticky: true });
  } finally {
    ui.enableBtn.disabled = false;
  }
}

async function disableNotifications() {
  const userId = currentUserId();
  try {
    const subscription = await getSubscription();
    if (!subscription) {
      feedback('本设备当前没有有效的推送订阅。', 'warn');
      await refreshStatus();
      return;
    }
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    if (userId) {
      await api('/api/unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ userId, endpoint }),
      });
    }
    feedback('已关闭通知，并已从服务器删除该设备的订阅记录。', 'ok');
    await refreshStatus();
  } catch (error) {
    console.error(error);
    feedback(`关闭通知失败：${error.message}`, 'err');
  }
}

/**
 * 本地自测：直接通过 Service Worker 弹一条通知，验证「浏览器能否正常展示通知」。
 * 这不经过服务器，所以不需要 NOTIFY_SECRET；真实推送请用 curl 调用 /api/notify。
 */
async function sendTestNotification() {
  const registration = await getRegistration();
  if (!registration) {
    feedback('请先点击「开启通知」注册 Service Worker，然后再测试。', 'warn');
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    feedback('通知权限尚未授予，请先点击「开启通知」。', 'warn');
    return;
  }
  ui.testBtn.disabled = true;
  try {
    await registration.showNotification('PingCard 测试通知', {
      body: `本地自测成功 ✅ 你的 User ID 是 ${currentUserId() || '（未设置）'}`,
      icon: config.defaultIcon,
      badge: config.defaultBadge,
      tag: 'pingcard-selftest',
      data: { url: '/', selftest: true },
    });
    feedback('已弹出本地测试通知。如果能看到它，说明通知展示链路正常（真正的推送由 /api/notify 触发）。', 'ok');
  } catch (error) {
    feedback(`测试通知失败：${error.message}`, 'err');
  } finally {
    ui.testBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ status */

async function refreshStatus() {
  const userId = currentUserId();
  ui.permText.textContent = 'Notification' in window ? Notification.permission : '不支持';

  const registration = await getRegistration();
  ui.swText.textContent = registration ? (registration.active ? '已激活' : registration.installing ? '安装中' : '已注册') : '未注册';

  if (!userId) {
    ui.deviceText.textContent = '—';
    setStatus('off', 'User ID 无效');
    return;
  }

  const subscription = await getSubscription();
  try {
    const status = await api(`/api/status?userId=${encodeURIComponent(userId)}`);
    ui.deviceText.textContent = String(status.deviceCount ?? 0);
    if (subscription) {
      setStatus('on', `本设备已开启通知 · 该 ID 共 ${status.deviceCount ?? 0} 台设备`);
    } else if ((status.deviceCount ?? 0) > 0) {
      setStatus('warn', `本设备未开启通知 · 该 ID 在其它 ${status.deviceCount} 台设备上已订阅`);
    } else {
      setStatus('off', '尚未开启通知');
    }
  } catch (error) {
    setStatus('warn', `状态查询失败：${error.message}`);
  }
}

/* -------------------------------------------------------------------- init */

async function init() {
  // 1. User ID: reuse or generate
  let userId = getStoredUserId();
  if (!userId) {
    userId = generateUserId();
    storeUserId(userId);
  }
  ui.userId.value = userId;

  // 2. Public config
  try {
    config = { ...config, ...(await api('/api/config')) };
  } catch (error) {
    feedback(`读取服务端配置失败：${error.message}`, 'err');
  }

  // 3. UI wiring
  ui.userId.addEventListener('change', () => {
    const value = ui.userId.value.trim();
    if (!ID_PATTERN.test(value)) {
      feedback('ID 不合法：仅支持 2–64 位字母、数字、下划线或连字符。', 'err');
      ui.userId.value = getStoredUserId() || '';
      return;
    }
    storeUserId(value);
    feedback('User ID 已保存到本设备。若此前已订阅，点击「开启通知」可将该设备的订阅迁移到新 ID。', 'info');
    refreshStatus();
  });

  ui.saveBtn.addEventListener('click', () => ui.userId.dispatchEvent(new Event('change')));

  ui.copyBtn.addEventListener('click', async () => {
    const value = ui.userId.value.trim();
    try {
      await navigator.clipboard.writeText(value);
      feedback(`已复制：${value}`, 'ok');
    } catch {
      ui.userId.select();
      document.execCommand?.('copy');
      feedback('已尝试复制，若失败请手动长按选择复制。', 'warn');
    }
  });

  ui.enableBtn.addEventListener('click', enableNotifications);
  ui.disableBtn.addEventListener('click', disableNotifications);
  ui.refreshBtn.addEventListener('click', refreshStatus);
  ui.testBtn.addEventListener('click', sendTestNotification);

  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'pingcard:subscription-changed') {
      feedback('浏览器已更新推送订阅，正在同步到服务器…', 'info');
      refreshStatus();
    }
  });

  renderCapabilityHints();
  ui.permText.textContent = 'Notification' in window ? Notification.permission : '不支持';
  await refreshStatus();
}

init().catch((error) => {
  console.error(error);
  feedback(`初始化失败：${error.message}`, 'err', { sticky: true });
});
