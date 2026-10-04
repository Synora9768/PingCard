/**
 * GET /api/admin/checklist — setup preflight for a fresh deployment.
 *
 * Verifies configuration, database, rendering pipeline and signing in one shot
 * so that "why doesn't my notification arrive" is answered by a single request
 * instead of a debugging session.
 */
import { handler, ok } from '../../_lib/http.js';
import { requireAdmin } from '../../_lib/auth.js';
import { getDb, listTemplates } from '../../_lib/db.js';
import { loadFonts } from '../../_lib/fonts.js';
import { renderCardToPng } from '../../_lib/renderCard.js';
import { cardCacheKey, signCardRequest, verifyCardSignature } from '../../_lib/sign.js';
import { parseVapidKeys } from '../../_lib/webpush.js';

const REQUIRED_TABLES = ['subscriptions', 'templates', 'notify_logs'];

/** @returns {Promise<Array<{id: string, label: string, status: 'ok'|'warn'|'fail', detail: string}>>} */
async function runChecks(env, requestUrl) {
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  const attempt = async (id, label, fn) => {
    try {
      const result = await fn();
      if (typeof result === 'string') add(id, label, 'ok', result);
      else if (result) add(id, label, result.status || 'ok', result.detail || '');
      else add(id, label, 'ok', '');
    } catch (error) {
      add(id, label, 'fail', String(error?.message || error).slice(0, 400));
    }
  };

  /* ----------------------------- configuration ---------------------------- */
  await attempt('vapid_keys', 'VAPID 密钥对', () => {
    const keys = parseVapidKeys({
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    });
    return `公钥 ${keys.publicKeyBase64Url.length} 字符，主体 ${keys.subject}`;
  });

  await attempt('vapid_subject', 'VAPID_SUBJECT 格式', () => {
    const subject = String(env.VAPID_SUBJECT || '');
    if (!subject) return { status: 'fail', detail: '未配置（需形如 mailto:you@example.com）' };
    if (!/^(mailto:|https:\/\/)/.test(subject)) {
      return { status: 'warn', detail: '建议使用 mailto: 或 https:// 前缀，部分推送服务会拒绝其它格式' };
    }
    return subject;
  });

  await attempt('notify_secret', 'NOTIFY_SECRET', () => {
    const secret = String(env.NOTIFY_SECRET || '');
    if (!secret) return { status: 'fail', detail: '未配置，/api/notify 将无法鉴权' };
    if (secret.length < 24) return { status: 'warn', detail: `长度 ${secret.length}，建议使用 32 位以上随机字符串` };
    return `已配置（${secret.length} 字符）`;
  });

  await attempt('admin_secret', 'ADMIN_SECRET', () => {
    const secret = String(env.ADMIN_SECRET || '');
    if (!secret) return { status: 'fail', detail: '未配置，无法登录后台' };
    if (secret.length < 16) return { status: 'warn', detail: `长度 ${secret.length}，建议使用更长的随机字符串` };
    return `已配置（${secret.length} 字符）`;
  });

  await attempt('defaults', '默认图标 / 角标', () => {
    const missing = ['DEFAULT_ICON_URL', 'DEFAULT_BADGE_URL'].filter((key) => !env[key]);
    if (missing.length) return { status: 'warn', detail: `${missing.join('、')} 未配置，将使用内置默认值` };
    return '已配置';
  });

  /* -------------------------------- database ------------------------------ */
  await attempt('d1_binding', 'D1 绑定 (env.DB)', () => {
    const db = getDb(env);
    if (!db) throw new Error('DB 绑定缺失');
    return '已绑定';
  });

  let db = null;
  try {
    db = getDb(env);
  } catch {
    /* reported above */
  }

  if (db) {
    await attempt('d1_tables', '数据表结构', async () => {
      const { results } = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all();
      const names = new Set((results || []).map((row) => row.name));
      const missing = REQUIRED_TABLES.filter((table) => !names.has(table));
      if (missing.length) {
        return {
          status: 'fail',
          detail: `缺少表 ${missing.join(', ')} — 请执行：wrangler d1 execute <数据库名> --file=./schema.sql`,
        };
      }
      return `已创建 ${REQUIRED_TABLES.length} 张表`;
    });

    await attempt('templates', '模板配置', async () => {
      const templates = await listTemplates(db);
      if (templates.length === 0) {
        return { status: 'warn', detail: '还没有任何模板 — 可在 /admin/templates 创建，或执行 seed 模板 SQL' };
      }
      const def = templates.find((t) => t.isDefault);
      return `${templates.length} 个模板，默认模板：${def ? def.name : '（未设置）'}`;
    });

    await attempt('subscriptions', '订阅记录', async () => {
      const row = await db
        .prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active FROM subscriptions')
        .first();
      return `共 ${Number(row?.total || 0)} 条记录，其中活跃 ${Number(row?.active || 0)} 条`;
    });
  }

  /* -------------------------------- rendering ----------------------------- */
  await attempt('fonts', '中文字体子集', async () => {
    const fonts = await loadFonts(env, requestUrl);
    const total = fonts.reduce((sum, font) => {
      const size = font.data.byteLength ?? font.data.length ?? 0;
      return sum + size;
    }, 0);
    return `${fonts.length} 个字重，共 ${(total / 1024).toFixed(0)} KiB`;
  });

  await attempt('render_pipeline', '渲染链路 (satori → PNG)', async () => {
    const started = Date.now();
    const { png } = await renderCardToPng({
      htmlTemplate:
        '<div style="display:flex;flex-direction:column;width:320px;height:160px;background:#111827;justify-content:center;align-items:center;font-family:\'Noto Sans SC\'"><div style="display:flex;font-size:28px;color:#fff">{{title}}</div><div style="display:flex;font-size:16px;color:#9ca3af;margin-top:6px">预检 pingcard</div></div>',
      variables: { title: '自检通过 ✅' },
      width: 320,
      height: 160,
      env,
      requestUrl,
    });
    if (png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
      return { status: 'fail', detail: '输出不是合法 PNG' };
    }
    return `PNG ${png.byteLength} 字节，耗时 ${Date.now() - started} ms`;
  });

  /* --------------------------------- signing ------------------------------ */
  await attempt('signature', '卡片签名与时效', async () => {
    const secret = env.NOTIFY_SECRET;
    if (!secret) throw new Error('NOTIFY_SECRET 未配置');
    const payload = { templateId: 't_check', variables: { title: '签名自检' }, width: 1024, height: 512 };
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signCardRequest(secret, { ...payload, ts });
    const good = await verifyCardSignature(secret, { ...payload, ts, sig }, { ttlSeconds: 300 });
    if (!good.valid) throw new Error('有效签名未通过校验');
    const tampered = await verifyCardSignature(
      secret,
      { ...payload, variables: { title: '被篡改' }, ts, sig },
      { ttlSeconds: 300 },
    );
    if (tampered.valid) throw new Error('被篡改的签名竟然通过了校验');
    const expired = await verifyCardSignature(secret, { ...payload, ts: ts - 3600, sig }, { ttlSeconds: 300 });
    if (expired.valid) throw new Error('过期签名竟然通过了校验');
    return '签名生成 / 篡改拒绝 / 过期拒绝 全部通过';
  });

  await attempt('cache_key', '渲染缓存键', async () => {
    const key = await cardCacheKey({ templateId: 't_check', variables: { a: '1', b: '2' }, width: 1024, height: 512, revision: 'rev1' });
    const same = await cardCacheKey({ templateId: 't_check', variables: { b: '2', a: '1' }, width: 1024, height: 512, revision: 'rev1' });
    const other = await cardCacheKey({ templateId: 't_check', variables: { a: '12', b: '2' }, width: 1024, height: 512, revision: 'rev1' });
    if (key !== same) throw new Error('相同参数未生成相同缓存键');
    if (key === other) throw new Error('不同参数生成了相同缓存键');
    return key;
  });

  return checks;
}

export const onRequestGet = handler(
  async ({ request, env }) => {
    await requireAdmin(request, env);
    const checks = await runChecks(env, request.url);
    const failed = checks.filter((check) => check.status === 'fail');
    const warned = checks.filter((check) => check.status === 'warn');
    return ok({
      ok: failed.length === 0,
      summary: { total: checks.length, failed: failed.length, warned: warned.length },
      checks,
    });
  },
  { methods: ['GET'] },
);
