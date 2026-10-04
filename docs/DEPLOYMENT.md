# PingCard 部署作业指导书（Deployment Runbook）

> **读者**：具备 Cloudflare 完整权限的部署 Agent（或运维人员）。
> **目标**：把本仓库部署为可用的 PingCard 实例，并通过第 8 节的全部验收检查。
> **形式**：命令优先、每步给出「期望输出」与「失败处置」。所有步骤**可重复执行（幂等）**。

---

## 0. Agent 契约（先读这一节）

### 你必须达成的结果

1. 一个 Cloudflare **Pages 项目**，产物来自本仓库 `public/` + `functions/`
2. 一个 **D1 数据库**，已执行 `schema.sql`（3 张表 + 1 个默认模板）
3. 5 个 **Pages 项目密钥**（`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`/`NOTIFY_SECRET`/`ADMIN_SECRET`）
4. 生产域名可访问，`npm run verify:live` **`ok: true, failed: 0`**
5. 把第 8 节的验收证据（JSON 输出 + 推送接口响应）回报给人类

### 明确禁止（Stop Conditions）

| 禁止 | 原因 |
|---|---|
| 把任何密钥写入 git 跟踪的文件并提交 | 密钥一旦进仓库即视为泄露，必须轮换 |
| **轮换 `VAPID_PRIVATE_KEY`**（已有用户订阅后） | 浏览器上的订阅与公钥绑定，换键会让**所有存量订阅失效**，用户必须重新授权 |
| 删除/重建一个已有活跃订阅的 D1 数据库 | 同上，所有订阅记录丢失 |
| 修改 `functions/_lib/webpush.js` 的加密常量 | 已通过与 RFC 参考实现逐字节一致的测试，改动会破坏兼容 |
| 用 `wrangler secret put` 给 **Worker**（非 Pages）写密钥 | 本项目是 Pages，命令必须是 `wrangler pages secret ...` |

### 需要的最小权限

- Cloudflare API Token（或 `wrangler login` 的 OAuth 会话）
- 权限建议：**Account → Cloudflare Pages: Edit**、**Account → D1: Edit**、**Account → Account Settings: Read**
- 拿到 token 后：`export CLOUDFLARE_API_TOKEN=...`、`export CLOUDFLARE_ACCOUNT_ID=...`

---

## 1. 填写部署参数表

执行前先把这张表填好，后续命令全部引用这些变量：

```bash
# ── 填写区 ────────────────────────────────────────────────
export PROJECT_NAME="pingcard"        # Pages 项目名（决定默认域名 https://<name>.pages.dev）
export DB_NAME="pingcard"             # D1 数据库名（若改动，需同步改 wrangler.toml 的 database_name）
export PRODUCTION_BRANCH="main"       # Pages 生产分支
export VAPID_SUBJECT="mailto:you@example.com"   # 必须是 mailto: 或 https:// 前缀
export D1_LOCATION="apac"             # 就近区域：apac | wnam | enam | weur | eeur | oc
# ─────────────────────────────────────────────────────────
export REPO_DIR="/path/to/PingCard"   # 仓库绝对路径
cd "$REPO_DIR"
```

> 如需自定义域名（如 `push.example.com`），见 [附录 A](#附录-a-自定义域名与-https)。

---

## 2. 预检（Preflight）

```bash
node -v                 # 期望 ≥ v20
npm -v                  # 期望 ≥ 10
npx wrangler --version  # 期望 4.x

npx wrangler whoami     # 期望：打印邮箱 + Account ID；失败 → token/OAuth 未配置
```

安装依赖并跑本地测试：

```bash
npm ci
npm test                # 期望：# tests 21 / # pass 21 / # fail 0
```

**关键产物检查**（缺了会导致线上卡片渲染 500）：

```bash
ls -la functions/_lib/fonts/   # 期望：NotoSansSC-Regular.bin（847304 字节）、NotoSansSC-Bold.bin（859136 字节）
ls -la public/fonts/           # 期望：两个 .subset.woff 与上面同尺寸
git check-ignore .dev.vars && echo "OK: .dev.vars 已被忽略"
```

若 `.bin` 缺失（例如首次克隆未包含二进制）：

```bash
npm run build:fonts     # 期望：每个字重 ~830 KiB，写出 functions/_lib/fonts/*.bin
```

可选：本地端到端自测（会在 `.wrangler/smoke` 建临时库，不碰线上，结束自动清理）：

```bash
npm run smoke           # 期望：✅ PASS — 63 passed, 0 failed
```

> ⚠️ 受限网络环境中 `smoke` 中「真实发送」相关断言不会失败（该步骤只统计 `sent/failed` 数量），
> 但若出现 `fetch failed` 属正常——投递需要出站访问 FCM/APNs。

---

## 3. 创建 Cloudflare 资源

### 3.1 Pages 项目

```bash
# 已存在则跳过（幂等）
npx wrangler pages project list | grep -w "$PROJECT_NAME" || \
  npx wrangler pages project create "$PROJECT_NAME" --production-branch "$PRODUCTION_BRANCH"
```

**期望输出**：`✨ Successfully created the 'pingcard' project. It will be available at https://pingcard.pages.dev/.`

失败处置：
- `A project with this name already exists` → 正常，继续
- `Authentication error` → 回到第 2 节检查 `whoami`

### 3.2 D1 数据库

```bash
# 已存在则跳过
npx wrangler d1 list | grep -w "$DB_NAME" || \
  npx wrangler d1 create "$DB_NAME" --binding DB --location "$D1_LOCATION" --update-config
```

**期望输出**：包含 `database_id = "<uuid>"`，并且 `--update-config` 会把真实 UUID 写进 `wrangler.toml`。

**必须校验**（占位符没被替换是最常见的部署失败原因）：

```bash
grep -A3 '\[\[d1_databases\]\]' wrangler.toml
# 期望：database_name = "pingcard"、database_id = "xxxxxxxx-xxxx-..."（不再是 00000000-0000-...）
grep -q '00000000-0000-0000-0000-000000000000' wrangler.toml && echo "❌ database_id 仍是占位符" || echo "✅ database_id 已替换"
```

若数据库名不是 `pingcard`，手动把 `wrangler.toml` 的 `database_name` 与 `database_id` 都改成实际值。

> `database_id` **不是机密**，可以提交到仓库（建议提交到部署分支，便于复现）；密钥则绝不可以。

---

## 4. 初始化数据库结构

```bash
npx wrangler d1 execute "$DB_NAME" --remote --file=./schema.sql -y
```

**期望**：多条 `🚣 Executed ... queries`，退出码 0。

**必须校验**：

```bash
npx wrangler d1 execute "$DB_NAME" --remote --json \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('subscriptions','templates','notify_logs')" \
  | grep -c '"name"'
# 期望：3

npx wrangler d1 execute "$DB_NAME" --remote --json \
  --command "SELECT id, is_default FROM templates" 
# 期望：含 { "id": "t_demo", "is_default": 1 }
```

失败处置：
- `no such table: subscriptions`（后续接口报错时）→ 本条命令没执行成功，重跑
- `You need to be authenticated` → 检查 token
- 重复执行是安全的：`schema.sql` 用 `CREATE TABLE IF NOT EXISTS` + `INSERT ... WHERE NOT EXISTS`

---

## 5. 生成并写入密钥

### 5.1 生成 5 个密钥（非交互）

```bash
# VAPID 键对（脚本自带，输出与 web-push 官方 CLI 同格式）
node scripts/vapid-keys.mjs --json > /tmp/vapid.json
export VAPID_PUBLIC_KEY=$(node -p "require('/tmp/vapid.json').VAPID_PUBLIC_KEY")
export VAPID_PRIVATE_KEY=$(node -p "require('/tmp/vapid.json').VAPID_PRIVATE_KEY")

# 两个随机口令（48 字节 → URL 安全 base64）
export NOTIFY_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
export ADMIN_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
```

### 5.2 落盘为 `.dev.vars`（已被 `.gitignore` 忽略）

```bash
umask 077
cat > .dev.vars <<EOF
VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY
VAPID_SUBJECT=$VAPID_SUBJECT
NOTIFY_SECRET=$NOTIFY_SECRET
ADMIN_SECRET=$ADMIN_SECRET
DEFAULT_ICON_URL=/icons/icon-192.png
DEFAULT_BADGE_URL=/icons/badge-72.png
EOF
git check-ignore .dev.vars   # 必须输出 .dev.vars；若无输出 → 停止，不要继续
```

### 5.3 上传到 Pages 项目

```bash
npx wrangler pages secret bulk .dev.vars --project-name "$PROJECT_NAME"
```

**期望**：`🌀 Creating the secrets for the Pages project "pingcard" (production)` + `✨ Successfully created secrets`

**必须校验**：

```bash
npx wrangler pages secret list --project-name "$PROJECT_NAME"
# 期望至少包含：VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT / NOTIFY_SECRET / ADMIN_SECRET
```

> 上传后 **密钥不可再读出**（只能覆盖）。请把 `NOTIFY_SECRET`、`ADMIN_SECRET`、`VAPID_PRIVATE_KEY`
> 交给人类妥善保存（例如密码管理器）；`VAPID_PRIVATE_KEY` 丢失会导致无法再向存量订阅推送。
>
> 单条写入也可用：`echo "$VALUE" | npx wrangler pages secret put NAME --project-name "$PROJECT_NAME"`（支持管道/交互两种方式）

---

## 6. 部署

```bash
npx wrangler pages deploy public \
  --project-name "$PROJECT_NAME" \
  --branch "$PRODUCTION_BRANCH" \
  --commit-hash "$(git rev-parse HEAD)" \
  --commit-message "$(git log -1 --pretty=%s)" \
  --commit-dirty=true
```

**期望输出**（关键行）：

```
✨ Compiled Worker successfully
Uploading... (N/M)
✨ Success! Uploaded N files
🌎 Deploying...
✨ Deployment complete! Take a peek over at https://<hash>.<project>.pages.dev
```

**生产地址**：`https://<PROJECT_NAME>.pages.dev`

> `--commit-dirty=true` 是必要的：`--update-config` 刚改过 `wrangler.toml`，工作区是 dirty 的。

失败处置：
- `Could not resolve "fs"` → 依赖被换成了官方 `satori`；必须使用 `@cf-wasm/satori`（见 README §10.3）
- 打包体积超限 → 确认 `functions/_lib/fonts/*.bin` 是子集（每个 ~830 KiB），而非完整 10 MB TTF
- `Failed to build Functions` → 本地先跑 `npx wrangler pages functions build --outdir=/tmp/fn` 看具体报错

---

## 7. 绑定检查（按部署方式二选一）

| 部署方式 | D1 绑定来源 | 动作 |
|---|---|---|
| **本节的 `wrangler pages deploy`（直接上传）** | `wrangler.toml` 的 `[[d1_databases]]` | 第 3.2 节已通过 `--update-config` 写好，**无需额外操作** |
| **Git 集成（Dashboard 连仓库自动构建）** | 必须在 Dashboard 配置 | Settings → **Functions** → *D1 database bindings* → 变量名填 **`DB`**，选择对应数据库 → Save → 重新部署 |

Git 集成还需要在 Settings → Builds & deployments 设置：

- Build command：`npm run build:fonts`（仓库已包含 `.bin`，此步可选但安全）
- Build output directory：`public`

**校验绑定是否生效**（不依赖任何密钥）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://$PROJECT_NAME.pages.dev/api/notify" \
  -H 'content-type: application/json' -d '{}'
# 期望：401（= 鉴权先于数据库，函数已正常加载）
# 若 500 且 error 提到 D1 binding → 绑定没生效
```

---

## 8. 验收（Definition of Done，必须全绿）

### 8.1 自动化验收（机器判读）

```bash
export BASE="https://$PROJECT_NAME.pages.dev"

npm run verify:live -- \
  --base "$BASE" \
  --notify-secret "$NOTIFY_SECRET" \
  --admin-secret "$ADMIN_SECRET" \
  --json | tee /tmp/verify-live.json

node -e "const r=require('/tmp/verify-live.json'); console.log(r.ok?'✅ ok':'❌ '+r.failures.join(' | '), 'passed='+r.passed, 'failed='+r.failed, 'skipped='+r.skipped)"
```

**通过标准（此时还没有真实订阅者）**：

```
✅ ok passed=21 failed=0 skipped=1
```

> 唯一被 skip 的是 `GET /api/status 定向查询`——它需要一个真实 User ID，而 User ID 只有用户的浏览器订阅成功后才会生成（见 8.3）。
> 第 8.3 步拿到 User ID 后**再跑一次**，加上 `--user "<User ID>"`，此时应得到 `ok=true, passed=23, failed=0, skipped=0`。

逐项期望值（共 24 行结果 + 1 行 `note` 诊断信息）：

| 检查项 | 期望 |
|---|---|
| `GET / 返回设置页` | pass（HTTP 200） |
| `GET /sw.js 可用` | pass |
| `中文字体子集已部署` | pass，**827 KiB** 量级 |
| `GET /api/config 返回 VAPID 公钥` | pass |
| `VAPID 公钥是 65 字节 P-256 点` | pass |
| `管理后台页面可访问` | pass |
| `POST /api/notify 无 Authorization → 401` | pass |
| `POST /api/notify 错误密钥 → 401` | pass |
| `GET /api/card-image 无签名/无会话 → 403` | pass |
| `GET /api/users 无鉴权 → 403` | pass |
| `ADMIN_SECRET 有效` | pass |
| `自检全部通过（无 fail 项）` | pass，**13 项** |
| `至少存在一个模板` | pass（`t_demo`） |
| `默认模板已设置` | pass |
| `NOTIFY_SECRET 有效` | pass（`dryRun 通过，目标设备 N 台`） |
| `dryRun 生成了签名卡片链接` | pass（含 `sig=`） |
| `签名链接可渲染出 PNG` | pass，**200 image/png · 1024x512** |
| `渲染耗时已上报` | pass（`X-PingCard-Render-Ms` 存在；首次冷渲染几十~几百 ms） |
| `重复请求命中缓存` | pass，**`cache=HIT` 且 `render-ms=0`** |
| `过期签名被拒绝 → 403` | pass |
| `GET /api/status?userId=… 可用` | 有 `--user` 时 pass |
| `status 不泄露原始 endpoint` | 有 `--user` 时 pass（只回 `endpointHost`） |
| `GET /api/users 可用` | 有 `--user` 时 pass（`用户 N 个 / 活跃设备 M`） |

若 `failed > 0`：退出码为 1，`failures[]` 里给出每项的判定详情 → 查第 9 节。

> 该脚本是**只读**的：不会写入订阅、不会改模板、不会真发推送（`dryRun: true`）。
> 可安全地对生产环境反复执行。

### 8.2 交付前自证「能发推送」

```bash
curl -s -X POST "$BASE/api/notify" \
  -H "Authorization: Bearer $NOTIFY_SECRET" \
  -H 'content-type: application/json' \
  -d '{"dryRun":true,"templateId":"t_demo","variables":{"title":"部署自检","body":"卡片渲染链路"}}' \
  | tee /tmp/dryrun.json
# 期望：{"success":true,"dryRun":true,...,"templateId":"t_demo","imageUrl":"https://.../api/card-image?...sig=..."}

# 顺带确认这张卡片能出图
node -e "
const j=require('/tmp/dryrun.json');
fetch(j.imageUrl).then(async r=>console.log('card-image:',r.status,r.headers.get('content-type'),(await r.arrayBuffer()).byteLength,'bytes', 'cache='+r.headers.get('x-pingcard-cache')));"
# 期望：card-image: 200 image/png <字节数> bytes cache=HIT
```

### 8.3 需要人类在真机上完成的三项（Agent 无法代劳）

把下面这段**原样**交给人类执行，并请他把输出贴回：

````
1) 手机端（Chrome/Edge：Android 或桌面版；iOS 需 16.4+ 并「添加到主屏幕」后打开）
   访问 https://<PROJECT_NAME>.pages.dev → 点「开启通知」→ 允许权限 → 复制页面上的 User ID

2) 把 User ID 交给 Agent 执行（或在服务器上执行）：
   curl -s -X POST https://<PROJECT_NAME>.pages.dev/api/notify \
     -H "Authorization: Bearer $NOTIFY_SECRET" \
     -H 'content-type: application/json' \
     -d '{"userId":"<User ID>","templateId":"t_demo",
          "variables":{"title":"部署验收","body":"看到这张大图卡片即成功"},
          "url":"https://<PROJECT_NAME>.pages.dev/?from=push"}' | tee /tmp/push.json

3) 期望：
   - 响应 {"success":true,"sent":1,"failed":0,"cleaned":0}
   - 手机弹出通知，且带大图卡片（图是 /api/card-image 渲染出来的）
   - 点击通知跳转到带 ?from=push 的地址
````

若 `sent: 0` / `failed: 1`，加 `"debug": true` 重发，按第 9 节排查。

拿到 User ID 后**补跑一次验收**，把 skip 清零：

```bash
npm run verify:live -- --base "$BASE" \
  --notify-secret "$NOTIFY_SECRET" --admin-secret "$ADMIN_SECRET" \
  --user "<上面拿到的 User ID>" --json
# 期望：ok=true, passed=23, failed=0, skipped=0
```

### 8.4 回报格式（Agent → 人类）

```
部署完成
- 生产地址: https://<PROJECT_NAME>.pages.dev
- Pages 项目: <PROJECT_NAME> （生产分支 <PRODUCTION_BRANCH>）
- D1 数据库: <DB_NAME> / database_id=<uuid> / 已执行 schema.sql（3 表 + t_demo 默认模板）
- 密钥: 5 个已写入 Pages 项目（值见人类私有记录；VAPID_PRIVATE_KEY 请务必备份）
- verify:live: ok=true, passed=NN, failed=0, skipped=0
- dryRun: sent=0(未真发) / imageUrl 渲染 200 image/png / cache=HIT
- 待人类验收: 真机推送 3 步（见 8.3）
```

---

## 9. 故障处置手册（现象 → 判定 → 处置）

| 现象 | 判定 | 处置 |
|---|---|---|
| `GET /api/*` 返回 `D1 binding "DB" is missing` | 绑定未生效 | 直接上传：确认 `wrangler.toml` 有 `[[d1_databases]] binding="DB"` 且 `database_id` 非占位符后重新部署；Git 集成：在 Dashboard 加 D1 binding（变量名必须 `DB`） |
| 接口返回 `no such table` | 迁移没执行 | 重跑第 4 节；确认 SQL 打在**同一个** `DB_NAME` 上 |
| 卡片接口 500，错误含 `Font ... is not available` | 字体没打包 | `npm run build:fonts` → 确认 `functions/_lib/fonts/*.bin` 存在 → 重新部署 |
| 卡片中文渲染成空白 | 用了完整字体或其它字体 | 只能用 `NotoSansSC-*.bin`（子集）；检查 `functions/_lib/fonts.js` 未被改动 |
| `/api/card-image` 一律 403 | 签名过期（5 分钟）或链接被改 | 属预期行为；用 `/api/notify` 重新生成链接，或后台（会话鉴权）预览 |
| `/api/notify` 返回 `failed` 且 `debug` 显示 `fetch failed` | Worker 出站被限（本地/受限网络） | 部署在 Cloudflare 上不应出现；若出现，检查是否在本地 `pages dev` 里测试 |
| FCM/APNs 返回 **401/403** | VAPID 公私钥不匹配，或 `VAPID_SUBJECT` 前缀不对 | 跑 `GET /api/admin/checklist` 看 `vapid_keys` / `vapid_subject` 两项；用 `npm run vapid:keys -- --from-private <KEY>` 反推公钥核对 |
| FCM 返回 **413** | 载荷 > 4096 字节 | 缩短 `title`/`body`（卡片是 URL，不占载荷） |
| FCM 返回 **429** | 被限流 | 错误已标记可重试；稍后重发（同一 `topic` 会覆盖显示） |
| FCM 返回 **404/410** | 订阅失效 | 预期行为：记录会被自动删除并计入 `cleaned` |
| 部署时 `Could not resolve "fs"` | 依赖被换成官方 `satori` | 恢复 `package.json` 中 `@cf-wasm/satori`，重跑 `npm ci` |
| `database_id` 校验失败 | 忘了 `--update-config` 或用了 `d1 create` 的默认输出 | 手动把 UUID 填进 `wrangler.toml`，重新部署 |
| 部署失败且工作区 dirty 报错 | 缺少 `--commit-dirty=true` | 加上该标志重新部署 |
| 升级后内置模板 `t_demo` 未更新 | 种子语句是 `INSERT ... WHERE NOT EXISTS` | 在后台删掉重建，或 `DELETE FROM templates WHERE id='t_demo'` 后重跑 `schema.sql` |

查看线上实时日志：

```bash
npx wrangler pages deployment tail --project-name "$PROJECT_NAME"
```

---

## 10. 回滚

### 10.1 回滚代码（Pages 部署）

```bash
# 查看历史部署
npx wrangler pages deployment list --project-name "$PROJECT_NAME" --environment production --json | head -40
```

然后用下面任一方式回滚：

- **Dashboard**：Workers & Pages → 项目 → Deployments → 选中上一个成功的生产部署 → **Rollback to this deployment**
- **重新上传上一个提交**：`git checkout <上一个 commit> && npm run deploy`
- **注意**：回滚**不会**回滚 D1 数据与密钥；若旧版接口依赖不同的表结构，需要同步执行对应的 SQL

### 10.2 回滚数据（谨慎）

```bash
# 单表结构备份（回滚或排查前先做）
npx wrangler d1 export "$DB_NAME" --remote --output=/tmp/pingcard-backup-$(date +%F).sql
# 期望：/tmp/pingcard-backup-*.sql 非空
```

> ⚠️ 不要用「删除 D1 重建」当作回滚手段——会丢失所有订阅记录，用户必须重新授权通知。

### 10.3 密钥轮换（仅在密钥泄露时）

| 密钥 | 可轮换性 | 影响 |
|---|---|---|
| `ADMIN_SECRET` | 可随时轮换 | 后台需重新登录（旧会话 Cookie 立即失效） |
| `NOTIFY_SECRET` | 可轮换 | 调用方需同步更新；已发出的卡片链接立即失效（5 分钟窗口内本就会过期） |
| `VAPID_PRIVATE_KEY` | **避免轮换** | 所有存量浏览器订阅失效，用户需重新「开启通知」 |
| `VAPID_PUBLIC_KEY` | 与私钥成对 | 同上 |

---

## 附录 A：自定义域名与 HTTPS

Pages 默认提供 `https://<PROJECT_NAME>.pages.dev`（自动 HTTPS，Web Push 可用）。
自定义域名需在 Dashboard 配置（`wrangler` 不管理域名）：

1. Workers & Pages → 项目 → **Custom domains** → Set up a custom domain
2. 输入域名（如 `push.example.com`）→ 按提示在 DNS 添加 `CNAME` 到 `<PROJECT_NAME>.pages.dev`
3. 等待证书签发（通常 1–5 分钟），然后 `curl -sI https://push.example.com/ | head -1` 期望 `HTTP/2 200`

> 换域名不需要改代码：`/api/notify` 用请求自身的 origin 生成卡片链接。
> 但**换域名会影响已有订阅的可见性**：已有的 `Notification` 权限与订阅是按 origin 隔离的，
> 用户需要在新域名上重新开启通知。

---

## 附录 B：一键命令清单（复制即用，不含填表与校验）

```bash
set -euo pipefail
cd "$REPO_DIR"

# 预检
node -v && npx wrangler whoami
npm ci && npm test
ls -la functions/_lib/fonts/*.bin

# 资源
npx wrangler pages project list | grep -w "$PROJECT_NAME" || npx wrangler pages project create "$PROJECT_NAME" --production-branch "$PRODUCTION_BRANCH"
npx wrangler d1 list | grep -w "$DB_NAME" || npx wrangler d1 create "$DB_NAME" --binding DB --location "$D1_LOCATION" --update-config
grep -q '00000000-0000-0000-0000-000000000000' wrangler.toml && { echo "❌ database_id 未替换"; exit 1; } || true

# 数据库
npx wrangler d1 execute "$DB_NAME" --remote --file=./schema.sql -y

# 密钥
node scripts/vapid-keys.mjs --json > /tmp/vapid.json
export VAPID_PUBLIC_KEY=$(node -p "require('/tmp/vapid.json').VAPID_PUBLIC_KEY")
export VAPID_PRIVATE_KEY=$(node -p "require('/tmp/vapid.json').VAPID_PRIVATE_KEY")
export NOTIFY_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
export ADMIN_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
umask 077
printf 'VAPID_PUBLIC_KEY=%s\nVAPID_PRIVATE_KEY=%s\nVAPID_SUBJECT=%s\nNOTIFY_SECRET=%s\nADMIN_SECRET=%s\nDEFAULT_ICON_URL=/icons/icon-192.png\nDEFAULT_BADGE_URL=/icons/badge-72.png\n' \
  "$VAPID_PUBLIC_KEY" "$VAPID_PRIVATE_KEY" "$VAPID_SUBJECT" "$NOTIFY_SECRET" "$ADMIN_SECRET" > .dev.vars
git check-ignore .dev.vars >/dev/null || { echo "❌ .dev.vars 未被忽略，停止"; exit 1; }
npx wrangler pages secret bulk .dev.vars --project-name "$PROJECT_NAME"
npx wrangler pages secret list --project-name "$PROJECT_NAME"

# 部署
npx wrangler pages deploy public --project-name "$PROJECT_NAME" --branch "$PRODUCTION_BRANCH" \
  --commit-hash "$(git rev-parse HEAD)" --commit-message "$(git log -1 --pretty=%s)" --commit-dirty=true

# 验收
BASE="https://$PROJECT_NAME.pages.dev"
npm run verify:live -- --base "$BASE" --notify-secret "$NOTIFY_SECRET" --admin-secret "$ADMIN_SECRET" --json | tee /tmp/verify-live.json
node -e "const r=require('/tmp/verify-live.json'); console.log(r.ok ? '✅ 验收通过' : '❌ 验收失败: '+r.failures.join(' | ')); process.exit(r.ok?0:1)"
```

---

## 附录 C：期望输出样本（对照用）

```jsonc
// npm run verify:live -- ... --json 的成功输出（截取）
{
  "base": "https://pingcard.pages.dev",
  "ok": true,
  "passed": 23,
  "failed": 0,
  "skipped": 0,
  "results": [
    { "name": "GET / 返回设置页", "status": "pass", "detail": "HTTP 200" },
    { "name": "中文字体子集已部署", "status": "pass", "detail": "827 KiB" },
    { "name": "自检全部通过（无 fail 项）", "status": "pass", "detail": "13 项" },
    { "name": "签名链接可渲染出 PNG", "status": "pass", "detail": "24537 字节 · 1024x512" },
    { "name": "重复请求命中缓存", "status": "pass", "detail": "cache=HIT · render-ms=0" },
    { "name": "过期签名被拒绝 → 403", "status": "pass", "detail": "" }
  ],
  "failures": []
}
```

```jsonc
// 成功推送的响应（真机验收第 2 步）
{ "success": true, "sent": 1, "failed": 0, "cleaned": 0, "total": 1,
  "templateId": "t_demo", "imageUrl": "https://pingcard.pages.dev/api/card-image?templateId=t_demo&variables=…&ts=…&sig=…" }
```

---

## 附录 D：变更后复验清单

每次改代码或模板后，至少重跑：

```bash
npm test                                   # 单元测试
npm run verify:live -- --base "$BASE" --notify-secret "$NOTIFY_SECRET" --admin-secret "$ADMIN_SECRET" --json
```

- **改了模板**：无需清缓存 —— 缓存键包含模板的 `updated_at`，保存即自动失效
- **改了 `NOTIFY_SECRET`**：调用方需同步更新；卡片链接立即失效
- **改了字体**：重新 `npm run build:fonts` 并重新部署，`verify:live` 会核对字体体积
- **改了 `schema.sql`**：先 `d1 export` 备份，再 `d1 execute --remote --file=./schema.sql`
