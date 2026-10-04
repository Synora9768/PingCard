#!/usr/bin/env node
/**
 * End-to-end smoke test: boots a real `wrangler pages dev` server (real Pages
 * Functions runtime + local D1) and exercises the whole product flow with HTTP
 * calls — subscription lifecycle, signed card rendering + caching, auth,
 * template CRUD and expiry handling.
 *
 *   npm run smoke            # full run
 *   npm run smoke -- --keep  # leave the server running for manual poking
 *
 * It uses an isolated persistence directory (.wrangler/smoke) and a temporary
 * `.dev.vars`, so it never touches your development data or real secrets.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const PERSIST = path.join(root, '.wrangler', 'smoke');
const DEV_VARS = path.join(root, '.dev.vars');
const KEEP = process.argv.includes('--keep');

const NOTIFY_SECRET = 'smoke-notify-secret-0123456789abcdef';
const ADMIN_SECRET = 'smoke-admin-secret-0123456789abcdef';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function jsonRequest(pathname, options = {}) {
  const response = await fetch(`${BASE}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { response, body, text };
}

/* --------------------------------------------------------------- fixtures */

function fakeSubscription(index) {
  const point = new Uint8Array(65);
  point[0] = 4;
  for (let i = 1; i < 65; i++) point[i] = (i * (index + 1)) % 256;
  const auth = new Uint8Array(16).fill(index + 3);
  return {
    endpoint: `https://push.example.com/smoke/${'endpoint'.repeat(4)}-${index}`,
    keys: {
      p256dh: Buffer.from(point).toString('base64url'),
      auth: Buffer.from(auth).toString('base64url'),
    },
  };
}

function generateVapidPair() {
  const result = spawnSync('node', [path.join(root, 'scripts', 'vapid-keys.mjs'), '--json'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`vapid-keys.mjs failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/* ------------------------------------------------------------- environment */

function writeDevVars(vapid) {
  const existed = fs.existsSync(DEV_VARS);
  const previous = existed ? fs.readFileSync(DEV_VARS, 'utf8') : null;
  fs.writeFileSync(
    DEV_VARS,
    [
      `VAPID_PUBLIC_KEY=${vapid.VAPID_PUBLIC_KEY}`,
      `VAPID_PRIVATE_KEY=${vapid.VAPID_PRIVATE_KEY}`,
      'VAPID_SUBJECT=mailto:smoke@example.com',
      `NOTIFY_SECRET=${NOTIFY_SECRET}`,
      `ADMIN_SECRET=${ADMIN_SECRET}`,
      'DEFAULT_ICON_URL=/icons/icon-192.png',
      'DEFAULT_BADGE_URL=/icons/badge-72.png',
      '',
    ].join('\n'),
  );
  return () => {
    if (previous !== null) fs.writeFileSync(DEV_VARS, previous);
    else fs.rmSync(DEV_VARS, { force: true });
  };
}

function wrangler(args, options = {}) {
  return spawnSync('npx', ['wrangler', ...args], {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
}

async function waitForServer(timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/api/config`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

/* -------------------------------------------------------------------- run */

async function main() {
  console.log('PingCard smoke test');
  console.log('===================');

  const vapid = generateVapidPair();
  const restoreDevVars = writeDevVars(vapid);

  section('· preparing local D1 (schema.sql)');
  fs.mkdirSync(PERSIST, { recursive: true });
  const dbInit = wrangler(['d1', 'execute', 'pingcard', '--local', '--persist-to', PERSIST, '--file=./schema.sql']);
  check('schema applied to local D1', dbInit.status === 0, (dbInit.stderr || '').trim().split('\n').pop() || '');

  section('· starting wrangler pages dev');
  const server = spawn(
    'npx',
    ['wrangler', 'pages', 'dev', 'public', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', PERSIST],
    // `detached` puts wrangler + workerd in their own process group so the whole
    // group can be terminated at the end (killing npx alone would leave workerd
    // running and hold the pipes open).
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let serverLog = '';
  server.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });

  const stopServer = () => {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      try {
        server.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };

  const cleanup = () => {
    if (!KEEP) stopServer();
    restoreDevVars();
  };

  try {
    const up = await waitForServer();
    check('dev server is up', up, `${BASE}/api/config`);
    if (!up) throw new Error(`server did not start:\n${serverLog.slice(-2000)}`);

    /* ------------------------------------------------------------ static */
    section('1. static assets & public config');
    const config = await jsonRequest('/api/config');
    check('GET /api/config returns the VAPID public key', config.body?.vapidPublicKey === vapid.VAPID_PUBLIC_KEY);
    check('GET /api/config exposes default icon', typeof config.body?.defaultIcon === 'string');

    const index = await fetch(`${BASE}/`);
    const indexHtml = await index.text();
    check('GET / serves the subscription page', index.status === 200 && indexHtml.includes('我的 User ID'));

    const sw = await fetch(`${BASE}/sw.js`);
    const swText = await sw.text();
    check(
      'GET /sw.js serves the service worker',
      sw.status === 200 && swText.includes('notificationclick') && swText.includes('pushsubscriptionchange'),
    );

    const font = await fetch(`${BASE}/fonts/NotoSansSC-Regular.subset.woff`);
    const fontBytes = (await font.arrayBuffer()).byteLength;
    check('Chinese font subset is served', font.status === 200 && fontBytes > 700_000, `${fontBytes} bytes`);

    const adminPage = await fetch(`${BASE}/admin/templates.html`);
    check('admin console page is served', adminPage.status === 200);

    for (const asset of ['/app.js', '/admin/admin.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-72.png']) {
      const response = await fetch(`${BASE}${asset}`);
      check(`static asset ${asset}`, response.status === 200, response.headers.get('content-type') || '');
    }

    /* ------------------------------------------------------- subscription */
    section('2. subscription lifecycle');
    const deviceA = fakeSubscription(0);
    const deviceB = fakeSubscription(1);
    const userId = `smoke${Date.now().toString(36)}`;

    const subscribeA = await jsonRequest('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, subscription: deviceA, userAgent: 'SmokeTest/A' }),
    });
    check('POST /api/subscribe stores device A', subscribeA.body?.deviceCount === 1);

    const subscribeAgain = await jsonRequest('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, subscription: deviceA, userAgent: 'SmokeTest/A' }),
    });
    check('re-subscribing the same endpoint does not duplicate', subscribeAgain.body?.deviceCount === 1);

    await jsonRequest('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, subscription: deviceB, userAgent: 'SmokeTest/B' }),
    });
    const status = await jsonRequest(`/api/status?userId=${userId}`);
    check('GET /api/status reports 2 devices', status.body?.deviceCount === 2);
    check('status entries never expose raw endpoints', !JSON.stringify(status.body).includes(deviceA.endpoint));

    const badSubscribe = await jsonRequest('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'bad id!', subscription: deviceA }),
    });
    check('invalid User ID is rejected with 400', badSubscribe.response.status === 400);

    /* ------------------------------------------------------------- notify */
    section('3. notify authentication');
    const noAuth = await jsonRequest('/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variables: { title: 'x' } }),
    });
    check('POST /api/notify without Authorization → 401', noAuth.response.status === 401, noAuth.body?.error);

    const wrongAuth = await jsonRequest('/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify({}),
    });
    check('POST /api/notify with a wrong secret → 401', wrongAuth.response.status === 401);

    section('4. notify + dynamic card rendering');
    const dryRun = await jsonRequest('/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
      body: JSON.stringify({
        userId,
        templateId: 't_demo',
        variables: { title: '预览', body: 'dry run' },
        dryRun: true,
      }),
    });
    check('dryRun resolves the two target devices', dryRun.body?.total === 2, `total=${dryRun.body?.total}`);
    check('dryRun returns a signed card-image URL', String(dryRun.body?.imageUrl || '').includes('sig='));

    const notify = await jsonRequest('/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
      body: JSON.stringify({
        userId,
        templateId: 't_demo',
        variables: {
          title: '服务器告警',
          body: 'CPU 使用率超过 90%',
          footer: '来自监控系统',
          // hostile value: must not break the template or inject markup
          cta: '查看详情</div><script>alert(1)</script>{{body}}',
        },
      }),
    });
    check('POST /api/notify returns counts', typeof notify.body?.sent === 'number' && typeof notify.body?.failed === 'number', JSON.stringify(notify.body && { sent: notify.body.sent, failed: notify.body.failed, cleaned: notify.body.cleaned }));
    check(
      'all targeted devices are accounted for',
      (notify.body?.sent ?? 0) + (notify.body?.failed ?? 0) + (notify.body?.cleaned ?? 0) === 2,
    );

    section('5. card-image: rendering, signature, caching');
    const imageUrl = notify.body?.imageUrl;
    const first = await fetch(imageUrl);
    const firstBytes = Buffer.from(await first.arrayBuffer());
    check('signed card-image renders a PNG', first.status === 200 && firstBytes.subarray(1, 4).toString() === 'PNG', `${firstBytes.length} bytes`);
    check('PNG has the template dimensions', first.headers.get('x-pingcard-size') === '1024x512', first.headers.get('x-pingcard-size'));
    check('render is attributed to the signature', first.headers.get('x-pingcard-verified-by') === 'signature');
    const firstMs = Number(first.headers.get('x-pingcard-render-ms'));

    const second = await fetch(imageUrl);
    await second.arrayBuffer();
    check('repeat request hits the render cache', second.headers.get('x-pingcard-cache') === 'HIT', `cache=${second.headers.get('x-pingcard-cache')}`);
    check('cached response is fast', Number(second.headers.get('x-pingcard-render-ms')) === 0, `first render ${firstMs} ms`);

    const unsigned = await fetch(`${BASE}/api/card-image?templateId=t_demo&variables=%7B%7D`);
    check('card-image without a signature → 403', unsigned.status === 403);
    check('403 body explains the reason', (await unsigned.json()).error.includes('Signature'));

    // Tampering = changing a signed part of the request.
    const tamperedVars = new URL(imageUrl);
    tamperedVars.searchParams.set('variables', JSON.stringify({ title: 'tampered', body: 'x' }));
    const tampered = await fetch(tamperedVars);
    check('card-image with tampered variables → 403', tampered.status === 403, String((await tampered.json()).error).slice(0, 60));

    const tamperedTemplate = new URL(imageUrl);
    tamperedTemplate.searchParams.set('templateId', 'some_other_template');
    const tamperedTpl = await fetch(tamperedTemplate);
    check('card-image with a swapped templateId → 403', tamperedTpl.status === 403);

    const duplicated = await fetch(`${imageUrl}&variables=%7B%7D`);
    check('card-image with a duplicated parameter → 400', duplicated.status === 400);

    const url = new URL(imageUrl);
    url.searchParams.set('ts', String(Math.floor(Date.now() / 1000) - 4000));
    const expired = await fetch(url);
    const expiredBody = await expired.json();
    check('expired signature → 403 with reason=expired', expired.status === 403 && expiredBody?.details?.reason === 'expired');

    /* -------------------------------------------------------- admin/login */
    section('6. admin console API');
    const login = await jsonRequest('/api/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: ADMIN_SECRET }),
    });
    const cookie = (login.response.headers.get('set-cookie') || '').split(';')[0];
    check('admin login sets a session cookie', login.response.status === 200 && cookie.startsWith('pc_admin='));

    const badLogin = await jsonRequest('/api/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'wrong' }),
    });
    check('admin login with a wrong secret → 401', badLogin.response.status === 401);

    const sessionCheck = await jsonRequest('/api/admin/session', { headers: { cookie } });
    check('session cookie is accepted', sessionCheck.body?.authenticated === true);

    const noAdmin = await jsonRequest('/api/admin/templates');
    check('GET /api/admin/templates without auth → 403', noAdmin.response.status === 403);

    const list = await jsonRequest('/api/admin/templates', { headers: { cookie } });
    check('admin can list templates (seeded t_demo is default)', list.body?.templates?.some((t) => t.id === 't_demo' && t.isDefault));

    const checklist = await jsonRequest('/api/admin/checklist', { headers: { cookie } });
    check('preflight checklist passes', checklist.body?.ok === true, `${checklist.body?.checks?.length} checks, ${checklist.body?.summary?.failed} failed`);

    section('7. template validation');
    const badTemplate = await jsonRequest('/api/admin/templates', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'unsupported',
        htmlTemplate: '<div style="display:flex"><table><tr><td>{{a}}</td></tr></table></div>',
      }),
    });
    check('template with <table> is rejected → 422', badTemplate.response.status === 422, badTemplate.body?.error);

    const noVars = await jsonRequest('/api/admin/templates', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'no placeholders', htmlTemplate: '<div style="display:flex">static</div>' }),
    });
    check('template without placeholders is rejected → 422', noVars.response.status === 422, noVars.body?.error);

    const brokenCss = await jsonRequest('/api/admin/templates', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'grid',
        htmlTemplate: '<div style="display:grid;width:100px;height:100px">{{a}}</div>',
      }),
    });
    check('template using display:grid is rejected → 422', brokenCss.response.status === 422, String(brokenCss.body?.error).slice(0, 80));

    section('8. template CRUD');
    const newTemplate = {
      id: 'smoke_card',
      name: '冒烟测试卡片',
      htmlTemplate:
        '<div style="display:flex;flex-direction:column;width:800px;height:400px;background-color:#111827;padding:40px;justify-content:space-between;font-family:\'Noto Sans SC\'"><div style="display:flex;flex-direction:column"><div style="display:flex;font-size:40px;font-weight:700;color:#ffffff">{{title}}</div><div style="display:flex;font-size:24px;color:#cbd5e1;margin-top:12px">{{body}}</div></div><div style="display:flex;font-size:20px;color:#94a3b8">{{footer|来自 PingCard}}</div></div>',
      variablesSchema: {
        title: { type: 'string', required: true, label: '标题', sample: '冒烟通过 ✅' },
        body: { type: 'string', required: true, label: '正文', sample: '模板 CRUD 正常' },
        footer: { type: 'string', required: false, label: '底部', default: '来自 PingCard' },
      },
      width: 800,
      height: 400,
    };
    const created = await jsonRequest('/api/admin/templates', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(newTemplate),
    });
    check('POST /api/admin/templates creates a template', created.response.status === 201, created.body?.template?.id);
    check('create response reports placeholders', created.body?.template?.placeholders?.length === 3);

    const createdRenderCheck = await jsonRequest('/api/admin/render-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        htmlTemplate: newTemplate.htmlTemplate,
        variablesSchema: newTemplate.variablesSchema,
        width: 800,
        height: 400,
      }),
    });
    check('render-check validates a good template', createdRenderCheck.body?.ok === true, `${createdRenderCheck.body?.renderMs} ms`);

    const gridCheck = await jsonRequest('/api/admin/render-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ htmlTemplate: '<div style="display:grid">{{a}}</div>' }),
    });
    check('render-check reports unsupported CSS', gridCheck.body?.ok === false && gridCheck.body?.errors?.length > 0);

    const missingRequired = await jsonRequest('/api/admin/render-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        htmlTemplate: '<div style="display:flex">{{title}}</div>',
        variablesSchema: { title: { type: 'string', required: true, label: '标题' } },
      }),
    });
    check('render-check still renders with sample values for required vars', missingRequired.body?.ok === true);

    const preview = await fetch(`${BASE}/api/admin/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        htmlTemplate: newTemplate.htmlTemplate,
        variablesSchema: newTemplate.variablesSchema,
        variables: { title: '预览标题', body: '预览正文' },
        width: 800,
        height: 400,
      }),
    });
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    check('POST /api/admin/preview returns a PNG for unsaved HTML', preview.status === 200 && previewBytes.subarray(1, 4).toString() === 'PNG', `${previewBytes.length} bytes`);

    fs.writeFileSync(path.join(root, '.wrangler', 'smoke-card.png'), previewBytes);

    const updated = await jsonRequest('/api/admin/templates/smoke_card', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: '冒烟测试卡片（已更新）' }),
    });
    check('PUT /api/admin/templates/:id updates a template', updated.body?.template?.name === '冒烟测试卡片（已更新）', updated.body?.template?.name);

    const setDefault = await jsonRequest('/api/admin/templates/smoke_card/set-default', {
      method: 'POST',
      headers: { cookie },
    });
    check('POST /api/admin/templates/:id/set-default switches the default', setDefault.body?.defaultTemplateId === 'smoke_card');

    const staticImage = await jsonRequest('/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
      body: JSON.stringify({
        userId,
        image: 'https://cdn.example.com/static-big-picture.png',
        variables: { title: '静态图', body: '跳过模板渲染' },
        dryRun: true,
      }),
    });
    check(
      'a static "image" skips template rendering',
      staticImage.body?.imageUrl === 'https://cdn.example.com/static-big-picture.png' &&
        staticImage.body?.templateId === null,
      String(staticImage.body?.imageUrl),
    );

    const blockedImage = await jsonRequest('/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
      body: JSON.stringify({ userId, image: 'http://169.254.169.254/latest/meta-data/', dryRun: true }),
    });
    check('an internal image URL is rejected (SSRF guard)', blockedImage.response.status === 400, blockedImage.body?.error);

    const defaultCard = await jsonRequest('/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
      body: JSON.stringify({ userId, variables: { title: '默认模板', body: '未指定 templateId' }, dryRun: true, debug: false }),
    });
    check('notify without templateId uses the new default', defaultCard.body?.templateId === 'smoke_card');

    const deleteDefault = await jsonRequest('/api/admin/templates/smoke_card', { method: 'DELETE', headers: { cookie } });
    check('deleting the only default template is refused → 409', deleteDefault.response.status === 409, deleteDefault.body?.error);

    await jsonRequest('/api/admin/templates/t_demo/set-default', { method: 'POST', headers: { cookie } });
    const deleted = await jsonRequest('/api/admin/templates/smoke_card', { method: 'DELETE', headers: { cookie } });
    check('template can be deleted once another is default', deleted.body?.deleted === 'smoke_card');

    const missing = await jsonRequest('/api/admin/templates/smoke_card', { headers: { cookie } });
    check('deleted template is gone (404)', missing.response.status === 404);

    /* ------------------------------------------------------ unsubscribe */
    section('9. unsubscribe');
    const unsubscribeB = await jsonRequest('/api/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, endpoint: deviceB.endpoint }),
    });
    check('POST /api/unsubscribe removes one device', unsubscribeB.body?.deviceCount === 1, `removed=${unsubscribeB.body?.removed}`);

    await jsonRequest('/api/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, endpoint: deviceA.endpoint }),
    });
    const finalStatus = await jsonRequest(`/api/status?userId=${userId}`);
    check('all devices removed', finalStatus.body?.deviceCount === 0);

    const notifyNone = await jsonRequest('/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
      body: JSON.stringify({ userId, variables: { title: 'x', body: 'y' } }),
    });
    check('notify with no active subscription reports sent=0', notifyNone.body?.sent === 0 && notifyNone.body?.total === 0);

    /* -------------------------------------------------------------- logs */
    section('10. database side effects');
    const rows = wrangler([
      'd1', 'execute', 'pingcard', '--local', '--persist-to', PERSIST,
      '--command', 'SELECT (SELECT COUNT(*) FROM notify_logs) AS logs, (SELECT COUNT(*) FROM subscriptions) AS subs',
      '--json',
    ]);
    let logCount = null;
    try {
      const parsed = JSON.parse(rows.stdout.slice(rows.stdout.indexOf('[')));
      logCount = parsed[0]?.results?.[0]?.logs ?? null;
    } catch {
      /* ignore */
    }
    check('notify_logs rows were written (dry runs are not logged)', Number(logCount) >= 2, `logs=${logCount}`);

    const logout = await jsonRequest('/api/admin/session', { method: 'DELETE', headers: { cookie } });
    check('admin logout clears the cookie', (logout.response.headers.get('set-cookie') || '').includes('pc_admin='));
  } finally {
    if (!KEEP) cleanup();
    else console.log(`\n(--keep) server still running at ${BASE} — stop it with Ctrl+C / kill`);
  }

  console.log(`\n${failed === 0 ? '✅ PASS' : '❌ FAIL'} — ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  · ${failure}`);
  }
  return failed > 0 ? 1 : 0;
}

const exitCode = main().then(
  (code) => code,
  (error) => {
    console.error('\nSmoke test crashed:', error);
    return 1;
  },
);

// The dev server is gone by now; exit explicitly so lingering pipes from the
// child process cannot keep the event loop alive.
exitCode.then((code) => process.exit(code));
