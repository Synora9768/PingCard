#!/usr/bin/env node
/**
 * verify:live — 对已部署的 PingCard 做一次「只读」现场验收。
 *
 * 与 `npm run smoke`（本地、含数据库写入）不同，本脚本只做安全操作：
 * 不写入订阅、不改动模板、不真正发送推送，因此可以在生产环境随时运行。
 *
 *   npm run verify:live -- --base https://pingcard.pages.dev \
 *                          --notify-secret "$NOTIFY_SECRET" \
 *                          --admin-secret  "$ADMIN_SECRET"
 *
 * 也支持环境变量：BASE / NOTIFY_SECRET / ADMIN_SECRET。
 * 返回码 0 = 全部通过；1 = 有失败项。
 */
const args = process.argv.slice(2);
const argOf = (name) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : undefined;
};

const BASE = (argOf('base') || process.env.BASE || '').replace(/\/+$/, '');
const NOTIFY_SECRET = argOf('notify-secret') || process.env.NOTIFY_SECRET || '';
const ADMIN_SECRET = argOf('admin-secret') || process.env.ADMIN_SECRET || '';
const USER_ID = argOf('user') || process.env.USER_ID || '';
const JSON_MODE = args.includes('--json');

if (!BASE) {
  console.error(
    '用法: npm run verify:live -- --base https://你的域名 [--notify-secret …] [--admin-secret …] [--user 某个UserID] [--json]',
  );
  process.exit(2);
}
if (!/^https?:\/\//.test(BASE)) {
  console.error(`✗ --base 必须是完整地址（http:// 或 https://），当前为 "${BASE}"`);
  process.exit(2);
}

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
/** @type {Array<{name: string, status: 'pass'|'fail'|'skip'|'note', detail: string}>} */
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, status: ok ? 'pass' : 'fail', detail });
  if (ok) {
    passed += 1;
    if (!JSON_MODE) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    if (!JSON_MODE) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function skip(name, why) {
  skipped += 1;
  results.push({ name, status: 'skip', detail: why });
  if (!JSON_MODE) console.log(`  – ${name}（跳过：${why}）`);
}

/** 供人阅读的补充说明（自检警告、提示等），JSON 模式下作为 note 返回。 */
function note(text) {
  results.push({ name: text, status: 'note', detail: '' });
  if (!JSON_MODE) console.log(text);
}

function section(title) {
  if (!JSON_MODE) console.log(`\n${title}`);
}

async function getJson(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* not JSON */
  }
  return { response, body };
}

/** 按 variables_schema 构造一组能满足必填校验的测试值。 */
function sampleVariablesFromSchema(schema) {
  const out = {};
  for (const [key, definition] of Object.entries(schema || {})) {
    if (!definition || typeof definition !== 'object') continue;
    if (definition.default) out[key] = String(definition.default);
    else if (definition.type === 'image_url') continue; // 留空以便用模板自带的默认背景
    else out[key] = String(definition.sample || definition.label || key);
  }
  return out;
}

async function main() {
  if (!JSON_MODE) {
    console.log(`PingCard 线上验收 — ${BASE}`);
    console.log('='.repeat(60));
  }

  /* --------------------------------------------------------- 静态与配置 */
  section('1. 站点与配置');
  const index = await fetch(`${BASE}/`);
  const indexHtml = await index.text().catch(() => '');
  check('GET / 返回设置页', index.status === 200 && indexHtml.includes('我的 User ID'), `HTTP ${index.status}`);

  const sw = await fetch(`${BASE}/sw.js`);
  const swText = await sw.text().catch(() => '');
  check('GET /sw.js 可用', sw.status === 200 && swText.includes('notificationclick'));

  const font = await fetch(`${BASE}/fonts/NotoSansSC-Regular.subset.woff`);
  const fontBytes = font.ok ? (await font.arrayBuffer()).byteLength : 0;
  check('中文字体子集已部署', fontBytes > 700_000, `${(fontBytes / 1024).toFixed(0)} KiB`);

  const config = await getJson('/api/config');
  const vapid = config.body?.vapidPublicKey || '';
  check('GET /api/config 返回 VAPID 公钥', config.response.ok && vapid.length > 80, `${vapid.slice(0, 12)}…`);
  check('VAPID 公钥是 65 字节 P-256 点', (() => {
    try {
      return Buffer.from(vapid.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length === 65;
    } catch {
      return false;
    }
  })());

  const adminPage = await fetch(`${BASE}/admin/templates`);
  check('管理后台页面可访问', adminPage.status === 200);

  /* --------------------------------------------------------------- 鉴权 */
  section('2. 接口鉴权（必须拒绝未授权调用）');
  const noAuth = await getJson('/api/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  check('POST /api/notify 无 Authorization → 401', noAuth.response.status === 401, String(noAuth.body?.error || ''));

  const badAuth = await getJson('/api/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer definitely-wrong' },
    body: '{}',
  });
  check('POST /api/notify 错误密钥 → 401', badAuth.response.status === 401);

  const unsignedCard = await fetch(`${BASE}/api/card-image?templateId=t_demo`);
  check('GET /api/card-image 无签名/无会话 → 403', unsignedCard.status === 403);

  const usersNoAuth = await getJson('/api/users');
  check('GET /api/users 无鉴权 → 403', usersNoAuth.response.status === 403);

  /* ------------------------------------------------------------ 管理员 */
  section('3. 管理员自检（需要 --admin-secret）');
  let defaultTemplate = null;
  if (!ADMIN_SECRET) {
    skip('运行环境自检', '未提供 --admin-secret');
    skip('默认模板与卡片渲染', '未提供 --admin-secret');
  } else {
    const checklist = await getJson('/api/admin/checklist', { headers: { 'x-admin-secret': ADMIN_SECRET } });
    if (checklist.response.status === 403) {
      check('ADMIN_SECRET 有效', false, '服务端返回 403，请核对密钥');
    } else {
      check('ADMIN_SECRET 有效', checklist.response.ok === true, `HTTP ${checklist.response.status}`);
      const rows = checklist.body?.checks || [];
      const bad = rows.filter((row) => row.status === 'fail');
      check(
        '自检全部通过（无 fail 项）',
        bad.length === 0,
        bad.length ? bad.map((row) => `${row.label}: ${row.detail}`).join(' | ') : `${rows.length} 项`,
      );
      for (const row of rows.filter((entry) => entry.status === 'warn')) {
        note(`    ⚠ ${row.label} — ${row.detail}`);
      }
    }

    const templates = await getJson('/api/admin/templates', { headers: { 'x-admin-secret': ADMIN_SECRET } });
    const list = templates.body?.templates || [];
    const fallback = list.find((template) => template.isDefault) || list[0];
    defaultTemplate = fallback || null;
    check('至少存在一个模板', list.length > 0, list.map((template) => template.id).join(', '));
    check('默认模板已设置', Boolean(list.find((template) => template.isDefault)), fallback?.name || '');
  }

  /* --------------------------------------------- 签名卡片（dryRun，不发推送） */
  section('4. 动态卡片渲染链路（dryRun，不发送任何推送）');
  if (!NOTIFY_SECRET) {
    skip('签名链接与 PNG 渲染', '未提供 --notify-secret');
  } else {
    const baseBody = { dryRun: true, variables: {} };
    if (defaultTemplate) baseBody.templateId = defaultTemplate.id;
    if (USER_ID) baseBody.userId = USER_ID;

    const callNotify = (payload) =>
      getJson('/api/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
        body: JSON.stringify(payload),
      });

    // 401/403 才说明密钥有问题；400 说明鉴权已通过，只是缺少模板要求的变量。
    let dry = await callNotify(baseBody);
    if ((dry.response.status === 400 || dry.response.status === 422) && defaultTemplate) {
      const samples = sampleVariablesFromSchema(defaultTemplate.variablesSchema);
      if (Object.keys(samples).length) {
        note(`    ℹ 首次 dryRun 返回 ${dry.response.status}（${dry.body?.error || ''}），改用模板 schema 生成的测试变量重试`);
        dry = await callNotify({ ...baseBody, variables: samples });
      }
    }

    if (dry.response.status === 401 || dry.response.status === 403) {
      check('NOTIFY_SECRET 有效', false, `${dry.response.status} ${dry.body?.error || ''}`);
    } else if (dry.response.status !== 200) {
      check(
        'NOTIFY_SECRET 有效',
        true,
        `鉴权通过（dryRun 返回 ${dry.response.status}：${dry.body?.error || '未知原因'}）`,
      );
      check('dryRun 生成了签名卡片链接', false, '无法自动构造模板变量，请用 --user 指定一个已订阅用户后复测');
    } else {
      check(
        'NOTIFY_SECRET 有效',
        true,
        `dryRun 通过，目标设备 ${dry.body?.total ?? 0} 台${USER_ID ? `（userId=${USER_ID}）` : ''}`,
      );
      if (!USER_ID) {
        note('    ℹ 未提供 --user，目标数是广播口径；加 --user <ID> 可验证定向推送');
      }

      const imageUrl = String(dry.body?.imageUrl || '');
      if (imageUrl.includes('sig=')) {
        check('dryRun 生成了签名卡片链接', true);

        const card = await fetch(imageUrl);
        const bytes = card.ok ? Buffer.from(await card.arrayBuffer()) : Buffer.alloc(0);
        const isPng = bytes.length > 8 && bytes.subarray(1, 4).toString() === 'PNG';
        check(
          '签名链接可渲染出 PNG',
          card.ok && isPng,
          card.ok ? `${bytes.length} 字节 · ${card.headers.get('x-pingcard-size')}` : `HTTP ${card.status}`,
        );
        check(
          '渲染耗时已上报',
          Boolean(card.headers.get('x-pingcard-render-ms')),
          `${card.headers.get('x-pingcard-render-ms')} ms`,
        );

        const cached = await fetch(imageUrl);
        await cached.arrayBuffer();
        check(
          '重复请求命中缓存',
          cached.headers.get('x-pingcard-cache') === 'HIT',
          `cache=${cached.headers.get('x-pingcard-cache')} · render-ms=${cached.headers.get('x-pingcard-render-ms')}`,
        );

        const expired = new URL(imageUrl);
        expired.searchParams.set('ts', String(Math.floor(Date.now() / 1000) - 4000));
        const expiredResponse = await fetch(expired);
        check('过期签名被拒绝 → 403', expiredResponse.status === 403);
      } else {
        check(
          'dryRun 生成了签名卡片链接',
          false,
          dry.body?.error || `imageUrl=${imageUrl || '(空)'}（可能模板未配置默认值/变量不满足校验）`,
        );
      }
    }
  }

  /* ------------------------------------------------------ 定向用户（只读） */
  section('5. 订阅数据（只读）');
  if (!USER_ID) {
    skip('GET /api/status 定向查询', '未提供 --user');
  } else {
    const status = await getJson(`/api/status?userId=${encodeURIComponent(USER_ID)}`);
    check(
      `GET /api/status?userId=${USER_ID} 可用`,
      status.response.ok && typeof status.body?.deviceCount === 'number',
      `deviceCount=${status.body?.deviceCount}`,
    );
    check('status 不泄露原始 endpoint', !JSON.stringify(status.body || {}).includes('https://'), '');
  }

  if (ADMIN_SECRET) {
    const users = await getJson('/api/users', { headers: { 'x-admin-secret': ADMIN_SECRET } });
    check('GET /api/users 可用', users.response.ok, `用户 ${users.body?.count ?? '?'} 个 / 活跃设备 ${users.body?.totalActiveDevices ?? '?'}`);
  } else {
    skip('GET /api/users', '未提供 --admin-secret');
  }

  /* ------------------------------------------------------------- 汇总 */
  if (JSON_MODE) {
    console.log(
      JSON.stringify(
        {
          base: BASE,
          ok: failed === 0,
          passed,
          failed,
          skipped,
          results,
          failures,
          skippedChecks: results.filter((row) => row.status === 'skip').map((row) => row.name),
        },
        null,
        2,
      ),
    );
    return failed === 0 ? 0 : 1;
  }

  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 存在失败项'} — 通过 ${passed}，失败 ${failed}${skipped ? `，跳过 ${skipped}` : ''}`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const failure of failures) console.log(`  · ${failure}`);
  }
  if (skipped) {
    console.log('\n提示：提供 --notify-secret / --admin-secret / --user 可覆盖被跳过的检查项。');
  }
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error('\n验收脚本异常终止：', error);
    process.exit(1);
  },
);
