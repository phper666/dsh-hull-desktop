/* T-工作台连接视图（docs/design/工作台连接-connections-design.md）：
   数据经 window.connections 桥（platforms/list/save/test/delete）。
   表单 schema 驱动（适配器注册表）：新增平台 = 后端加适配器，渲染零改动。
   安全：secret 输入 password 型，编辑留空=保留原值，列表只显示掩码。 */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const root = document.getElementById('connections-root');

  const state = { platforms: [], connections: [], mode: 'list', formPlatform: null, verifyMsg: null };

  const platformName = (id) => state.platforms.find((p) => p.id === id)?.name || id;
  const statusBadge = (c) => {
    if (state.verifyId === c.id) return '<span class="cn-badge verifying">验证中…</span>';
    if (c.status === 'connected') return '<span class="cn-badge connected">已连接</span>';
    if (c.status === 'failed') return '<span class="cn-badge failed">验证失败</span>';
    return '<span class="cn-badge unverified">未验证</span>';
  };

  function render() {
    if (state.mode === 'platforms') return renderPlatforms();
    if (state.mode === 'form') return renderForm();
    renderList();
  }

  /* ── 列表 ── */
  function renderList() {
    if (!state.connections.length) {
      root.innerHTML = `
        <div class="tk-toolbar"><span class="tk-title">工作台连接</span><span class="cn-spacer"></span>
          <button class="cn-btn primary" id="cn-add">＋ 连接平台</button></div>
        <div class="cn-empty">
          <h2>连接你的第一个平台</h2>
          <p>连接 Salesforce、阿里云短信、腾讯云短信或 SMTP 邮件后，即可在工作台调用平台能力。<br>凭据经系统安全加密存储，界面不会回显完整密钥。</p>
          <button class="cn-btn primary" id="cn-add-empty">＋ 连接平台</button>
        </div>`;
      for (const b of root.querySelectorAll('#cn-add, #cn-add-empty')) b.addEventListener('click', () => { state.mode = 'platforms'; render(); });
      return;
    }
    const cards = state.connections
      .map((c) => {
        const fieldLines = Object.entries(c.fields)
          .map(([k, v]) => `<div>${esc(k)}: ${esc(v)}</div>`)
          .join('');
        return `<div class="cn-card" data-id="${c.id}">
          <div class="cn-card-head">
            <span class="name">${esc(c.name)}</span>
            <span class="plat">${esc(platformName(c.platform))}</span>
            ${statusBadge(c)}
          </div>
          <div class="fields">${fieldLines}</div>
          ${c.lastError ? `<div class="lasterr">${esc(c.lastError)}</div>` : ''}
          ${c.lastVerifiedAt ? `<div class="fields">上次验证: ${esc(c.lastVerifiedAt.replace('T', ' ').slice(0, 19))}</div>` : ''}
          <div class="cn-card-ops">
            <button class="cn-btn" data-test="${c.id}">测试</button>
            <button class="cn-btn" data-edit="${c.id}">编辑</button>
            <button class="cn-btn danger" data-del="${c.id}">删除</button>
          </div>
        </div>`;
      })
      .join('');
    root.innerHTML = `
      <div class="tk-toolbar"><span class="tk-title">工作台连接</span><span class="cn-spacer"></span>
        <button class="cn-btn primary" id="cn-add">＋ 连接平台</button></div>
      <div class="cn-list">${cards}</div>`;
    root.querySelector('#cn-add').addEventListener('click', () => { state.mode = 'platforms'; render(); });
    for (const b of root.querySelectorAll('[data-test]'))
      b.addEventListener('click', async () => {
        b.disabled = true;
        b.textContent = '测试中…';
        const r = await window.connections.test(b.dataset.test);
        b.disabled = false;
        b.textContent = '测试';
        toast(r.ok && r.data?.verify?.ok ? r.data.verify.message : r.data?.verify?.message || r.message || '测试失败');
        await loadList();
      });
    for (const b of root.querySelectorAll('[data-edit]'))
      b.addEventListener('click', () => {
        const c = state.connections.find((x) => x.id === b.dataset.edit);
        if (!c) return;
        state.mode = 'form';
        state.formPlatform = c.platform;
        state.editId = c.id;
        state.formName = c.name;
        state.formFields = c.fields; // 脱敏值（secret 掩码，留空=保留）
        render();
      });
    for (const b of root.querySelectorAll('[data-del]'))
      b.addEventListener('click', async () => {
        if (!confirm('确定删除该连接？凭据将从本机移除。')) return;
        await window.connections.delete(b.dataset.del);
        await loadList();
      });
  }

  /* ── 平台选择 ── */
  function renderPlatforms() {
    root.innerHTML = `
      <div class="tk-toolbar"><span class="tk-title">选择要连接的平台</span><span class="cn-spacer"></span>
        <button class="cn-back" id="cn-back">← 返回</button></div>
      <div class="cn-platforms">
        ${state.platforms
          .map((p) => `<button class="cn-platform" data-p="${p.id}"><div class="name">${esc(p.name)}</div><div class="desc">${esc(p.description)}</div></button>`)
          .join('')}
      </div>
      <div class="hint-note" style="padding: 0 14px; font-size: 11px; color: var(--hull-text-sub);">更多平台（小红书 / 抖音 / 飞书等）在路线图中，适配器架构已预留。</div>`;
    root.querySelector('#cn-back').addEventListener('click', () => { state.mode = 'list'; render(); });
    for (const b of root.querySelectorAll('[data-p]'))
      b.addEventListener('click', () => {
        state.mode = 'form';
        state.formPlatform = b.dataset.p;
        state.editId = null;
        state.formName = '';
        state.formFields = {};
        render();
      });
  }

  /* ── 表单（schema 驱动） ── */
  function renderForm() {
    const platform = state.platforms.find((p) => p.id === state.formPlatform);
    if (!platform) { state.mode = 'list'; render(); return; }
    const editing = !!state.editId;
    const fieldsHtml = platform.fields
      .map((f) => {
        const val = state.formFields[f.key] ?? '';
        if (f.type === 'switch') {
          const on = val === (f.switchOnValue || 'true');
          return `<div class="cn-f"><label>${esc(f.label)}</label><div class="cn-f-row"><button type="button" class="cn-switch" role="switch" data-fkey="${f.key}" aria-checked="${on}"></button><span class="hint">${esc(f.hint || '')}</span></div></div>`;
        }
        const type = f.secret || f.type === 'password' ? 'password' : f.type === 'url' ? 'text' : f.type || 'text';
        const ph = f.secret && editing ? '已保存（留空保留原值）' : f.placeholder || '';
        return `<div class="cn-f"><label>${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label><input class="input" data-fkey="${f.key}" type="${type}" value="${esc(f.secret ? '' : val)}" placeholder="${esc(ph)}" autocomplete="off">${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
      })
      .join('');
    root.innerHTML = `
      <div class="tk-toolbar"><span class="tk-title">${editing ? '编辑连接' : '连接'} · ${esc(platform.name)}</span><span class="cn-spacer"></span>
        <button class="cn-back" id="cn-back">← 返回</button></div>
      <div class="cn-form">
        <div class="cn-f"><label>连接名称 <span class="req">*</span></label><input class="input" id="cn-name" value="${esc(state.formName || '')}" placeholder="便于识别的名称，如：生产 SF" autocomplete="off"></div>
        ${fieldsHtml}
        <div class="cn-form-ops">
          <span class="cn-verify-msg ${state.verifyMsg?.ok ? 'ok' : 'err'}" id="cn-vmsg">${esc(state.verifyMsg?.message || '')}</span>
          <button class="cn-btn primary" id="cn-save">${editing ? '保存并重新验证' : '保存并连接'}</button>
        </div>
      </div>`;
    root.querySelector('#cn-back').addEventListener('click', () => { state.mode = 'list'; render(); });
    for (const sw of root.querySelectorAll('.cn-switch'))
      sw.addEventListener('click', () => {
        const on = sw.getAttribute('aria-checked') === 'true';
        sw.setAttribute('aria-checked', String(!on));
      });
    root.querySelector('#cn-save').addEventListener('click', async () => {
      const btn = root.querySelector('#cn-save');
      const name = root.querySelector('#cn-name').value.trim();
      const fields = {};
      for (const f of platform.fields) {
        const el = root.querySelector(`[data-fkey="${f.key}"]`);
        if (!el) continue;
        if (f.type === 'switch') fields[f.key] = el.getAttribute('aria-checked') === 'true' ? (f.switchOnValue || 'true') : 'false';
        else {
          const v = el.value.trim();
          if (v) fields[f.key] = v; // 留空 = 编辑时保留原值（secret）；新连接缺必填由后端校验
        }
      }
      btn.disabled = true;
      btn.textContent = '保存并验证中…（≤10s）';
      const r = await window.connections.save({ id: state.editId || undefined, platform: state.formPlatform, name, fields });
      btn.disabled = false;
      btn.textContent = editing ? '保存并重新验证' : '保存并连接';
      if (!r.ok) {
        state.verifyMsg = { ok: false, message: r.message || '保存失败' };
        render();
        return;
      }
      state.verifyMsg = { ok: !!(r.verify && r.verify.ok), message: r.verify?.message || '已保存' };
      state.editId = r.data.id;
      state.formName = r.data.name;
      state.formFields = r.data.fields; // 脱敏回显
      render();
      await loadList();
    });
  }

  async function loadList() {
    const r = await window.connections.list();
    if (r.ok) {
      state.connections = r.data;
      if (state.mode === 'list') render();
    }
  }

  // ── 初始化：拉平台元数据与连接列表 ──
  (async () => {
    if (!window.connections?.platforms) {
      root.innerHTML = '<div class="tk-error">connections 桥不可用（preload 版本过旧？）</div>';
      return;
    }
    const [p, l] = await Promise.all([window.connections.platforms(), window.connections.list()]);
    if (p.ok) state.platforms = p.data;
    if (l.ok) state.connections = l.data;
    render();
  })();
  // 对外刷新入口（nav 进入视图时触发）
  window.__connectionsRefresh = async () => {
    const [p, l] = await Promise.all([window.connections.platforms(), window.connections.list()]);
    if (p.ok) state.platforms = p.data;
    if (l.ok) state.connections = l.data;
    render();
  };
})();
