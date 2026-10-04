-- PingCard — Cloudflare D1 schema
-- Apply with:  wrangler d1 execute pingcard --remote --file=./schema.sql
-- Local dev:   wrangler d1 execute pingcard --local  --file=./schema.sql

-- ---------------------------------------------------------------- subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT NOT NULL,
  endpoint       TEXT NOT NULL UNIQUE,          -- one row per browser subscription
  p256dh         TEXT NOT NULL,
  auth           TEXT NOT NULL,
  user_agent     TEXT,
  is_active      INTEGER DEFAULT 1,
  created_at     TEXT DEFAULT (datetime('now')),
  last_active_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id   ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_is_active ON subscriptions(is_active);

-- -------------------------------------------------------------------- templates
CREATE TABLE IF NOT EXISTS templates (
  id               TEXT PRIMARY KEY,            -- short slug or generated id
  name             TEXT NOT NULL,
  html_template    TEXT NOT NULL,               -- inline-CSS HTML with {{placeholders}}
  variables_schema TEXT,                        -- JSON: { name: { type, required, label, default } }
  width            INTEGER DEFAULT 1024,
  height           INTEGER DEFAULT 512,
  is_default       INTEGER DEFAULT 0,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_templates_is_default ON templates(is_default);

-- ----------------------------------------------------------------- notify_logs
CREATE TABLE IF NOT EXISTS notify_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  target_user_id TEXT,                          -- NULL = broadcast
  template_id    TEXT,
  payload        TEXT,                          -- full JSON snapshot of the notification
  sent_count     INTEGER,
  failed_count   INTEGER,
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notify_logs_created_at ON notify_logs(created_at);

-- ------------------------------------------------------- seed: default template
-- Optional starter template so a fresh deployment can push immediately.
-- Delete this block if you prefer to create templates from the admin console.
INSERT INTO templates (id, name, html_template, variables_schema, width, height, is_default)
SELECT
  't_demo',
  '默认卡片（示例）',
  '<div style="display:flex;flex-direction:column;width:1024px;height:512px;padding:56px;justify-content:space-between;background-image:url({{bgImage|https://images.unsplash.com/photo-1518770660439-4636190af475?w=1024}});background-size:cover;background-color:#0f172a;font-family:''Noto Sans SC''">
  <div style="display:flex;flex-direction:column">
    <div style="display:flex;font-size:20px;letter-spacing:2px;color:#93c5fd;text-transform:uppercase">{{kicker|系统通知}}</div>
    <div style="display:flex;font-size:58px;font-weight:700;color:#ffffff;margin-top:14px;line-height:1.15">{{title}}</div>
    <div style="display:flex;font-size:30px;color:#e2e8f0;margin-top:18px">{{body}}</div>
  </div>
  <div style="display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;font-size:24px;color:#cbd5e1">{{footer|来自 PingCard}}</div>
    <div style="display:flex;padding:10px 22px;border-radius:999px;background-color:#2563eb;color:#ffffff;font-size:24px">{{cta|查看详情}}</div>
  </div>
</div>',
  '{"kicker":{"type":"string","required":false,"label":"小标题","default":"系统通知"},"title":{"type":"string","required":true,"label":"标题","sample":"服务器告警"},"body":{"type":"string","required":true,"label":"正文","sample":"CPU 使用率超过 90%，请立即处理"},"bgImage":{"type":"image_url","required":false,"label":"背景图"},"footer":{"type":"string","required":false,"label":"底部文字","default":"来自 PingCard"},"cta":{"type":"string","required":false,"label":"按钮文字","default":"查看详情"}}',
  1024,
  512,
  1
WHERE NOT EXISTS (SELECT 1 FROM templates WHERE id = 't_demo');
