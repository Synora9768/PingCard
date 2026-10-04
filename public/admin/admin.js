/**
 * PingCard 模板管理后台逻辑（原生 JS）。
 */

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;

const EXAMPLE_TEMPLATE = `<div style="display:flex;flex-direction:column;width:1024px;height:512px;padding:56px;justify-content:space-between;background-image:url({{bgImage|https://images.unsplash.com/photo-1518770660439-4636190af475?w=1024}});background-size:cover;background-color:#0f172a;font-family:'Noto Sans SC'">
  <div style="display:flex;flex-direction:column">
    <div style="display:flex;font-size:20px;letter-spacing:2px;color:#93c5fd;text-transform:uppercase">{{kicker|系统通知}}</div>
    <div style="display:flex;font-size:58px;font-weight:700;color:#ffffff;margin-top:14px;line-height:1.15">{{title}}</div>
    <div style="display:flex;font-size:30px;color:#e2e8f0;margin-top:18px">{{body}}</div>
  </div>
  <div style="display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;font-size:24px;color:#cbd5e1">{{footer|来自 PingCard}}</div>
    <div style="display:flex;padding:10px 22px;border-radius:999px;background-color:#2563eb;color:#ffffff;font-size:24px">{{cta|查看详情}}</div>
  </div>
</div>`;

const EXAMPLE_SCHEMA = {
  kicker: { type: 'string', required: false, label: '小标题', default: '系统通知' },
  title: { type: 'string', required: true, label: '标题', sample: '服务器告警' },
  body: { type: 'string', required: true, label: '正文', sample: 'CPU 使用率超过 90%，请立即处理' },
  bgImage: { type: 'image_url', required: false, label: '背景图' },
  footer: { type: 'string', required: false, label: '底部文字', default: '来自 PingCard' },
  cta: { type: 'string', required: false, label: '按钮文字', default: '查看详情' },
};

const STATE = {
  /** @type {Array<any>} */
  templates: [],
  /** @type {{id?: string, name: string, htmlTemplate: string, variablesSchema: any, width: number, height: number} | null} */
  draft: null,
  /** @type {Record<string, string>} */
  variables: {},
  isNew: false,
  previewUrl: null,
  previewTimer: null,
  dirty: false,
};

const $ = (id) => document.getElementById(id);
const el = {
  loginPanel: $('loginPanel'),
  workspace: $('workspace'),
  secretInput: $('secretInput'),
  loginBtn: $('loginBtn'),
  loginError: $('loginError'),
  logoutBtn: $('logoutBtn'),
  checklistBtn: $('checklistBtn'),
  checklistBox: $('checklistBox'),
  checklistResult: $('checklistResult'),
  usersBtn: $('usersBtn'),
  usersBox: $('usersBox'),
  usersResult: $('usersResult'),
  newBtn: $('newBtn'),
  reloadBtn: $('reloadBtn'),
  seedBtn: $('seedBtn'),
  templateList: $('templateList'),
  editorEmpty: $('editorEmpty'),
  editor: $('editor'),
  fId: $('fId'),
  fName: $('fName'),
  fWidth: $('fWidth'),
  fHeight: $('fHeight'),
  fState: $('fState'),
  fHtml: $('fHtml'),
  fSchema: $('fSchema'),
  varPanel: $('varPanel'),
  placeholderHint: $('placeholderHint'),
  saveBtn: $('saveBtn'),
  previewBtn: $('previewBtn'),
  lintBtn: $('lintBtn'),
  schemaBtn: $('schemaBtn'),
  setDefaultBtn: $('setDefaultBtn'),
  deleteBtn: $('deleteBtn'),
  editorMessages: $('editorMessages'),
  previewImg: $('previewImg'),
  previewMeta: $('previewMeta'),
  confirmModal: $('confirmModal'),
  confirmText: $('confirmText'),
  confirmOk: $('confirmOk'),
  confirmCancel: $('confirmCancel'),
};

/* ------------------------------------------------------------------ helpers */

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await response.json().catch(() => null) : null;
  if (!response.ok || (body && body.success === false)) {
    const error = new Error(body?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function message(text, kind = 'ok', target = el.editorMessages) {
  const node = document.createElement('div');
  node.className = `msg ${kind}`;
  node.textContent = text;
  target.appendChild(node);
  return node;
}

function clearMessages(target = el.editorMessages) {
  target.innerHTML = '';
}

function extractPlaceholders(html) {
  const out = [];
  const seen = new Set();
  PLACEHOLDER_RE.lastIndex = 0;
  let match;
  while ((match = PLACEHOLDER_RE.exec(html || '')) !== null) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    out.push({ name: match[1], defaultValue: match[2] ?? null });
  }
  return out;
}

function confirmDialog(text) {
  return new Promise((resolve) => {
    el.confirmText.textContent = text;
    el.confirmModal.classList.add('show');
    const done = (value) => {
      el.confirmModal.classList.remove('show');
      el.confirmOk.removeEventListener('click', onOk);
      el.confirmCancel.removeEventListener('click', onCancel);
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    el.confirmOk.addEventListener('click', onOk);
    el.confirmCancel.addEventListener('click', onCancel);
  });
}

/* -------------------------------------------------------------------- auth */

async function checkSession() {
  try {
    const body = await api('/api/admin/session');
    return body.authenticated === true;
  } catch {
    return false;
  }
}

function showLogin() {
  el.loginPanel.classList.remove('hide');
  el.workspace.classList.add('hide');
  el.logoutBtn.classList.add('hide');
  el.secretInput.focus();
}

async function showWorkspace() {
  el.loginPanel.classList.add('hide');
  el.workspace.classList.remove('hide');
  el.logoutBtn.classList.remove('hide');
  await loadTemplates();
}

async function login() {
  clearMessages(el.loginError);
  const secret = el.secretInput.value.trim();
  if (!secret) return;
  try {
    await api('/api/admin/session', { method: 'POST', body: JSON.stringify({ secret }) });
    el.secretInput.value = '';
    await showWorkspace();
  } catch (error) {
    message(`登录失败：${error.message}`, 'err', el.loginError);
  }
}

async function logout() {
  try {
    await api('/api/admin/session', { method: 'DELETE' });
  } catch {
    /* ignore */
  }
  showLogin();
}

/* --------------------------------------------------------------- templates */

function templateById(id) {
  return STATE.templates.find((template) => template.id === id) || null;
}

async function loadTemplates() {
  const body = await api('/api/admin/templates');
  STATE.templates = body.templates || [];
  renderTemplateList();
  if (STATE.draft?.id) {
    const fresh = templateById(STATE.draft.id);
    if (fresh && !STATE.dirty) {
      STATE.draft = { ...fresh };
      fillEditor();
    }
  }
}

function renderTemplateList() {
  el.templateList.innerHTML = '';
  if (!STATE.templates.length) {
    el.templateList.innerHTML =
      '<div class="muted small">还没有模板。点击「新建模板」或「插入内置示例模板」开始。</div>';
    return;
  }
  for (const template of STATE.templates) {
    const item = document.createElement('div');
    item.className = `item${STATE.draft?.id === template.id ? ' active' : ''}`;

    const img = document.createElement('img');
    img.alt = template.name;
    img.loading = 'lazy';
    const sample = buildSampleVariables(template.variablesSchema);
    img.src = `/api/card-image?templateId=${encodeURIComponent(template.id)}&w=320&h=160&variables=${encodeURIComponent(
      JSON.stringify(sample),
    )}`;
    img.onerror = () => {
      img.style.background = '#1f2937';
      img.removeAttribute('src');
    };

    const info = document.createElement('div');
    const title = document.createElement('div');
    title.innerHTML = `<b>${escapeHtml(template.name)}</b> ${
      template.isDefault ? '<span class="badge default">默认</span>' : ''
    }`;
    const meta = document.createElement('div');
    meta.className = 'muted small';
    meta.textContent = `${template.id} · ${template.width}×${template.height} · ${
      (template.placeholders || []).length
    } 个变量 · 更新于 ${template.updatedAt || '—'}`;
    info.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'row';
    const editBtn = document.createElement('button');
    editBtn.className = 'tiny';
    editBtn.textContent = '编辑';
    editBtn.onclick = () => selectTemplate(template.id);
    actions.append(editBtn);
    if (!template.isDefault) {
      const defBtn = document.createElement('button');
      defBtn.className = 'tiny ghost';
      defBtn.textContent = '设为默认';
      defBtn.onclick = () => setDefault(template.id);
      actions.append(defBtn);
    }

    item.append(img, info, actions);
    el.templateList.append(item);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function buildSampleVariables(schema) {
  const out = {};
  for (const [key, definition] of Object.entries(schema || {})) {
    if (!definition || typeof definition !== 'object') continue;
    if (definition.default) out[key] = String(definition.default);
    else if (definition.type === 'image_url') continue; // keep the default background
    else out[key] = String(definition.sample || definition.label || key);
  }
  return out;
}

function selectTemplate(id) {
  const template = templateById(id);
  if (!template) return;
  STATE.isNew = false;
  STATE.dirty = false;
  STATE.draft = {
    id: template.id,
    name: template.name,
    htmlTemplate: template.htmlTemplate,
    variablesSchema: template.variablesSchema,
    width: template.width,
    height: template.height,
  };
  STATE.variables = buildSampleVariables(template.variablesSchema);
  fillEditor();
  renderTemplateList();
  schedulePreview(0);
}

function newTemplate() {
  STATE.isNew = true;
  STATE.dirty = false;
  STATE.draft = {
    id: '',
    name: '新模板',
    htmlTemplate: EXAMPLE_TEMPLATE,
    variablesSchema: { ...EXAMPLE_SCHEMA },
    width: 1024,
    height: 512,
  };
  STATE.variables = buildSampleVariables(EXAMPLE_SCHEMA);
  fillEditor();
  renderTemplateList();
  schedulePreview(0);
}

function fillEditor() {
  const draft = STATE.draft;
  if (!draft) {
    el.editor.classList.add('hide');
    el.editorEmpty.classList.remove('hide');
    return;
  }
  el.editorEmpty.classList.add('hide');
  el.editor.classList.remove('hide');
  el.fId.value = draft.id || '';
  el.fId.disabled = !STATE.isNew;
  el.fName.value = draft.name;
  el.fWidth.value = draft.width;
  el.fHeight.value = draft.height;
  el.fHtml.value = draft.htmlTemplate;
  el.fSchema.value = draft.variablesSchema ? JSON.stringify(draft.variablesSchema, null, 2) : '';
  const template = draft.id ? templateById(draft.id) : null;
  el.fState.value = STATE.isNew
    ? '未保存'
    : `${template?.isDefault ? '默认模板 · ' : ''}更新于 ${template?.updatedAt || '—'}`;
  el.setDefaultBtn.disabled = STATE.isNew || Boolean(template?.isDefault);
  el.deleteBtn.disabled = STATE.isNew;
  renderVariablePanel();
  updatePlaceholderHint();
}

function updatePlaceholderHint() {
  const placeholders = extractPlaceholders(el.fHtml.value);
  el.placeholderHint.textContent = placeholders.length
    ? `检测到 ${placeholders.length} 个占位符：${placeholders.map((p) => `{{${p.name}}}`).join('、')}`
    : '当前模板没有占位符变量（至少需要一个，否则请直接使用静态 image 推送）';
}

/** Variable test panel: driven by the schema, falling back to detected placeholders. */
function renderVariablePanel() {
  el.varPanel.innerHTML = '';
  el.varPanel.classList.remove('grid2');
  const schema = parseSchemaText();
  const placeholders = extractPlaceholders(el.fHtml.value);
  const names = new Set([...Object.keys(schema || {}), ...placeholders.map((p) => p.name)]);

  if (!names.size) {
    el.varPanel.className = 'small muted';
    el.varPanel.textContent = '模板中没有占位符变量。';
    return;
  }
  el.varPanel.className = 'list';

  for (const name of names) {
    const definition = schema?.[name] || {};
    const row = document.createElement('label');
    row.className = 'field';
    row.style.marginBottom = '6px';
    const label = document.createElement('span');
    const hint = definition.label ? ` · ${definition.label}` : '';
    label.textContent = `${name}${hint}${definition.required ? '（必填）' : ''}${
      definition.type === 'image_url' ? '（图片 URL）' : ''
    }`;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = definition.type === 'image_url' ? 'https://…' : '测试值';
    input.value = STATE.variables[name] ?? definition.default ?? '';
    input.oninput = () => {
      STATE.variables[name] = input.value;
      schedulePreview(500);
    };
    row.append(label, input);
    el.varPanel.append(row);
  }
}

function parseSchemaText() {
  const text = el.fSchema.value.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function collectDraft() {
  return {
    id: el.fId.value.trim(),
    name: el.fName.value.trim(),
    htmlTemplate: el.fHtml.value,
    variablesSchema: el.fSchema.value.trim() ? safeJson(el.fSchema.value) : null,
    width: Number(el.fWidth.value) || 1024,
    height: Number(el.fHeight.value) || 512,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- preview */

function schedulePreview(delay = 600) {
  clearTimeout(STATE.previewTimer);
  STATE.previewTimer = setTimeout(() => {
    runPreview().catch((error) => console.error(error));
  }, delay);
}

async function runPreview() {
  const draft = collectDraft();
  if (!draft.htmlTemplate.trim()) {
    el.previewMeta.textContent = '模板为空';
    return;
  }
  el.previewMeta.textContent = '渲染中…';
  try {
    const response = await fetch('/api/admin/preview', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: draft.name,
        htmlTemplate: draft.htmlTemplate,
        variablesSchema: draft.variablesSchema,
        variables: STATE.variables,
        width: draft.width,
        height: draft.height,
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      clearMessages();
      for (const error of body.errors || [body.error || `HTTP ${response.status}`]) message(error, 'err');
      if (body.hint) message(body.hint, 'warn');
      el.previewMeta.textContent = '渲染失败';
      el.previewImg.removeAttribute('src');
      return;
    }

    const blob = await response.blob();
    if (STATE.previewUrl) URL.revokeObjectURL(STATE.previewUrl);
    STATE.previewUrl = URL.createObjectURL(blob);
    el.previewImg.src = STATE.previewUrl;

    const renderMs = response.headers.get('x-pingcard-render-ms');
    const warnings = Number(response.headers.get('x-pingcard-warnings') || 0);
    el.previewMeta.textContent = `${response.headers.get('x-pingcard-size') || ''} · 渲染 ${renderMs} ms${
      warnings ? ` · ${warnings} 条提示` : ''
    }`;
    clearMessages();
    if (warnings) message(`渲染成功，但有 ${warnings} 条风格提示（见浏览器控制台 / 保存时的返回）。`, 'warn');
  } catch (error) {
    el.previewMeta.textContent = `预览失败：${error.message}`;
  }
}

/* ----------------------------------------------------------------- actions */

async function saveTemplate() {
  clearMessages();
  const draft = collectDraft();
  if (!draft.name) return message('请填写模板名称。', 'err');
  if (!draft.htmlTemplate.trim()) return message('模板内容不能为空。', 'err');
  if (el.fSchema.value.trim() && !draft.variablesSchema) return message('variables_schema 不是合法 JSON。', 'err');

  el.saveBtn.disabled = true;
  try {
    const body = {
      name: draft.name,
      htmlTemplate: draft.htmlTemplate,
      variablesSchema: draft.variablesSchema,
      width: draft.width,
      height: draft.height,
      sampleVariables: STATE.variables,
    };
    let result;
    if (STATE.isNew) {
      if (draft.id) body.id = draft.id;
      result = await api('/api/admin/templates', { method: 'POST', body: JSON.stringify(body) });
      STATE.isNew = false;
    } else {
      result = await api(`/api/admin/templates/${encodeURIComponent(STATE.draft.id)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    }
    STATE.dirty = false;
    STATE.draft = {
      id: result.template.id,
      name: result.template.name,
      htmlTemplate: result.template.htmlTemplate,
      variablesSchema: result.template.variablesSchema,
      width: result.template.width,
      height: result.template.height,
    };
    message(`已保存「${result.template.name}」，渲染耗时 ${result.renderMs} ms。`, 'ok');
    for (const warning of result.warnings || []) message(warning, 'warn');
    await loadTemplates();
    fillEditor();
    renderTemplateList();
  } catch (error) {
    message(`保存失败：${error.message}`, 'err');
    for (const detail of error.body?.details?.errors || []) message(detail, 'err');
  } finally {
    el.saveBtn.disabled = false;
  }
}

async function setDefault(id) {
  clearMessages();
  try {
    await api(`/api/admin/templates/${encodeURIComponent(id)}/set-default`, { method: 'POST' });
    message('已设为默认模板：/api/notify 不指定 templateId 时将使用它。', 'ok');
    await loadTemplates();
    fillEditor();
  } catch (error) {
    message(`设置默认模板失败：${error.message}`, 'err');
  }
}

async function deleteTemplate() {
  const id = STATE.draft?.id;
  if (!id) return;
  const template = templateById(id);
  const okToDelete = await confirmDialog(
    `确认删除模板「${template?.name || id}」？该操作不可撤销。若它是当前唯一的默认模板，服务器会拒绝删除。`,
  );
  if (!okToDelete) return;
  clearMessages();
  try {
    await api(`/api/admin/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
    message('模板已删除。', 'ok');
    STATE.draft = null;
    fillEditor();
    await loadTemplates();
  } catch (error) {
    message(`删除失败：${error.message}`, 'err');
  }
}

async function insertSeed() {
  STATE.isNew = true;
  STATE.draft = {
    id: 't_demo',
    name: '告警卡片（示例）',
    htmlTemplate: EXAMPLE_TEMPLATE,
    variablesSchema: { ...EXAMPLE_SCHEMA },
    width: 1024,
    height: 512,
  };
  STATE.variables = buildSampleVariables(EXAMPLE_SCHEMA);
  fillEditor();
  schedulePreview(0);
  message('已载入内置示例模板（ID: t_demo）。可直接点「保存模板」，或点「新建模板」改成自定义 ID。', 'ok');
}

/* --------------------------------------------------------------- checklist */

async function runChecklist() {
  el.checklistBox.classList.remove('hide');
  el.checklistResult.innerHTML = '<div class="muted small">检测中…</div>';
  try {
    const body = await api('/api/admin/checklist');
    renderChecklist(body);
  } catch (error) {
    el.checklistResult.innerHTML = '';
    message(`自检失败：${error.message}`, 'err', el.checklistResult);
  }
}

function renderChecklist(body) {
  el.checklistResult.innerHTML = '';
  const summary = document.createElement('div');
  summary.className = 'small muted';
  summary.textContent = `共 ${body.summary.total} 项：失败 ${body.summary.failed}，警告 ${body.summary.warned}`;
  el.checklistResult.append(summary);
  for (const check of body.checks) {
    const row = document.createElement('div');
    row.className = 'status-row';
    const pill = document.createElement('span');
    pill.className = `pill ${check.status}`;
    pill.textContent = check.status === 'ok' ? '通过' : check.status === 'warn' ? '警告' : '失败';
    const text = document.createElement('span');
    text.innerHTML = `<b>${escapeHtml(check.label)}</b> <span class="muted">${escapeHtml(check.detail || '')}</span>`;
    row.append(pill, text);
    el.checklistResult.append(row);
  }
}

async function loadUsers() {
  el.usersBox.classList.remove('hide');
  el.usersResult.innerHTML = '<div class="muted small">加载中…</div>';
  try {
    const body = await api('/api/users');
    if (!body.users.length) {
      el.usersResult.innerHTML = '<div class="muted small">还没有任何订阅记录。</div>';
      return;
    }
    const table = document.createElement('table');
    table.innerHTML =
      '<thead><tr><th>User ID</th><th>活跃设备</th><th>最近活跃</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const user of body.users) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="mono">${escapeHtml(user.userId)}</td><td>${user.deviceCount}</td><td class="muted">${escapeHtml(
        user.lastActiveAt || '—',
      )}</td>`;
      tbody.append(tr);
    }
    table.append(tbody);
    el.usersResult.innerHTML = '';
    el.usersResult.append(table);
  } catch (error) {
    el.usersResult.innerHTML = '';
    message(`加载失败：${error.message}`, 'err', el.usersResult);
  }
}

/* -------------------------------------------------------------------- init */

function wireEvents() {
  el.loginBtn.onclick = login;
  el.secretInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') login();
  });
  el.logoutBtn.onclick = logout;
  el.newBtn.onclick = newTemplate;
  el.reloadBtn.onclick = () => loadTemplates().catch((error) => message(error.message, 'err'));
  el.seedBtn.onclick = insertSeed;
  el.checklistBtn.onclick = runChecklist;
  el.usersBtn.onclick = loadUsers;
  el.saveBtn.onclick = saveTemplate;
  el.previewBtn.onclick = runPreview;
  el.setDefaultBtn.onclick = () => STATE.draft?.id && setDefault(STATE.draft.id);
  el.deleteBtn.onclick = deleteTemplate;
  el.lintBtn.onclick = () => {
    updatePlaceholderHint();
    renderVariablePanel();
    schedulePreview(0);
  };
  el.schemaBtn.onclick = () => {
    const schema = {};
    for (const { name, defaultValue } of extractPlaceholders(el.fHtml.value)) {
      schema[name] = {
        type: /image|img|photo|avatar|cover/i.test(name) ? 'image_url' : 'string',
        required: false,
        label: name,
        ...(defaultValue ? { default: defaultValue } : {}),
      };
    }
    if (!Object.keys(schema).length) {
      message('模板中没有检测到 {{占位符}}。', 'warn');
      return;
    }
    el.fSchema.value = JSON.stringify(schema, null, 2);
    renderVariablePanel();
    schedulePreview(300);
  };

  for (const input of [el.fHtml, el.fSchema, el.fWidth, el.fHeight, el.fName]) {
    input.addEventListener('input', () => {
      STATE.dirty = true;
      if (input === el.fSchema) renderVariablePanel();
      if (input === el.fHtml) updatePlaceholderHint();
      schedulePreview(700);
    });
  }
  window.addEventListener('beforeunload', (event) => {
    if (STATE.dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

(async function init() {
  wireEvents();
  if (await checkSession()) await showWorkspace();
  else showLogin();
})().catch((error) => {
  console.error(error);
  showLogin();
  message(`初始化失败：${error.message}`, 'err', el.loginError);
});

export { EXAMPLE_TEMPLATE, EXAMPLE_SCHEMA };
