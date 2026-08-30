/* T-工作流视图（docs/design/工作流-workflows-design.md）：
   数据经 window.workflows 桥（list/get/save/delete/run/runs）。
   v1：手动运行 + 顺序步骤（dsh-card/http/notification/delay）；编辑器 = 步骤列表（GitHub Actions steps 同构）。 */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STEP_TYPES = [
    { type: 'dsh-card', name: 'dsh 任务卡片' },
    { type: 'http', name: 'HTTP 请求' },
    { type: 'notification', name: '系统通知' },
    { type: 'delay', name: '延时等待' },
  ];
  const stepTypeName = (t) => STEP_TYPES.find((s) => s.type === t)?.name || t;

  const root = document.getElementById('workflows-root');
  let workflows = [];
  let runs = [];
  let editor = null; // { id?, name, enabled, steps } | null
  let runningId = null;

  /* ── 列表 ── */
  async function renderList() {
    const [lr, rr] = await Promise.all([window.workflows.list(), window.workflows.runs()]);
    workflows = lr.ok ? lr.data : [];
    runs = rr.ok ? rr.data : [];
    const cards = workflows
      .map((w) => {
        const last = runs.find((r) => r.workflowId === w.id);
        const lastBadge = last
          ? `<span class="wf-badge ${last.status}">${last.status === 'running' ? '运行中' : last.status === 'success' ? '上次成功' : '上次失败'}</span>`
          : '<span class="wf-badge muted">未运行过</span>';
        const preview = w.steps.map((s) => `${esc(stepTypeName(s.type))}`).join(' <span class="arrow">→</span> ');
        return `<div class="wf-card" data-id="${w.id}">
          <div class="wf-card-head">
            <span class="name">${esc(w.name)}</span>
            <button class="wf-switch" role="switch" aria-checked="${w.enabled}" data-toggle="${w.id}" aria-label="启用"></button>
            ${lastBadge}
            <div class="wf-card-ops">
              <button class="wf-btn primary" data-run="${w.id}" ${runningId ? 'disabled' : ''}>▶ 运行</button>
              <button class="wf-btn" data-edit="${w.id}">编辑</button>
              <button class="wf-btn danger" data-del="${w.id}">删除</button>
            </div>
          </div>
          <div class="wf-steps-preview">${preview || '<span class="wf-hint">（无步骤）</span>'}</div>
          <div class="meta">${w.steps.length} 个步骤 · 更新于 ${esc((w.updatedAt || '').replace('T', ' ').slice(0, 16))}</div>
        </div>`;
      })
      .join('');
    root.innerHTML = `
      <div class="wf-toolbar"><span class="tk-title">工作流</span><span class="cn-spacer"></span>
        <button class="wf-btn primary" id="wf-add">＋ 新建工作流</button></div>
      <div class="wf-list">${cards || ''}</div>
      ${runs.length ? `<div class="wf-runs"><h3>最近运行</h3>${runs.slice(0, 8).map(runHtml).join('')}</div>` : ''}
      ${workflows.length ? '' : '<div class="wf-empty"><h2>还没有工作流</h2><p>把「建卡 → 执行 → 通知」这类重复动作串成一条自动化链。</p></div>'}`;
    root.querySelector('#wf-add').addEventListener('click', () => { editor = { name: '', enabled: true, steps: [] }; renderEditor(); });
    for (const b of root.querySelectorAll('[data-toggle]'))
      b.addEventListener('click', async () => {
        const w = workflows.find((x) => x.id === b.dataset.toggle);
        if (!w) return;
        await window.workflows.save({ id: w.id, name: w.name, enabled: !w.enabled, steps: w.steps });
        await renderList();
      });
    for (const b of root.querySelectorAll('[data-run]'))
      b.addEventListener('click', async () => {
        runningId = b.dataset.run;
        for (const x of root.querySelectorAll('[data-run]')) x.disabled = true;
        const r = await window.workflows.run(runningId);
        runningId = null;
        if (r.ok && r.data) toast(`工作流${r.data.status === 'success' ? '执行成功' : '执行失败'}（${r.data.log.length} 步）`);
        else toast(r.message || '运行失败');
        await renderList();
      });
    for (const b of root.querySelectorAll('[data-edit]'))
      b.addEventListener('click', () => {
        const w = workflows.find((x) => x.id === b.dataset.edit);
        if (!w) return;
        editor = JSON.parse(JSON.stringify(w));
        renderEditor();
      });
    for (const b of root.querySelectorAll('[data-del]'))
      b.addEventListener('click', async () => {
        if (!confirm('确定删除该工作流？')) return;
        await window.workflows.delete(b.dataset.del);
        await renderList();
      });
  }

  function runHtml(r) {
    return `<div class="wf-run">
      <div class="head"><b>${esc(r.workflowName)}</b><span class="wf-badge ${r.status}">${r.status === 'success' ? '成功' : r.status === 'failed' ? '失败' : '运行中'}</span>
        <span class="time">${esc((r.startedAt || '').replace('T', ' ').slice(0, 19))}</span></div>
      ${r.log.map((l) => `<div class="stepline ${l.ok ? '' : 'err'}">${l.ok ? '✓' : '✗'} [${esc(stepTypeName(l.type))}] ${esc(l.message)}（${l.durationMs}ms）</div>`).join('')}
    </div>`;
  }

  /* ── 编辑器 ── */
  function renderEditor() {
    if (!editor) { renderList(); return; }
    const stepsHtml = editor.steps
      .map((s, i) => {
        const cfg = stepCfgHtml(s);
        return `<div class="wf-step" data-idx="${i}">
          <div class="wf-step-head"><span class="idx">${i + 1}.</span>
            <select data-act="type">${STEP_TYPES.map((t) => `<option value="${t.type}" ${t.type === s.type ? 'selected' : ''}>${t.name}</option>`).join('')}</select>
            <span class="sp"></span>
            <button class="wf-btn" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="wf-btn" data-act="down" ${i === editor.steps.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="wf-btn danger" data-act="del">删除</button>
          </div>
          <div class="wf-step-cfg">${cfg}</div>
        </div>`;
      })
      .join('');
    root.innerHTML = `
      <div class="wf-toolbar"><span class="tk-title">${editor.id ? '编辑工作流' : '新建工作流'}</span><span class="cn-spacer"></span>
        <button class="wf-btn" id="wf-cancel">取消</button>
        <button class="wf-btn primary" id="wf-save">保存</button></div>
      <div class="wf-editor">
        <div class="wf-f"><label>名称 *</label><input class="input" id="wf-name" value="${esc(editor.name)}" placeholder="如：每日发布巡检" autocomplete="off"></div>
        <div class="wf-f"><label>启用</label><button type="button" class="wf-switch" id="wf-enabled" role="switch" aria-checked="${editor.enabled}"></button></div>
        <div class="wf-steps">${stepsHtml || '<div class="wf-hint">尚无步骤——点击下方添加</div>'}</div>
        <div><select id="wf-addstep" style="border:1px solid var(--hull-border); border-radius:var(--radius-sm); padding:6px 8px; color:var(--hull-text); background:var(--hull-panel);">
          <option value="">＋ 添加步骤…</option>${STEP_TYPES.map((t) => `<option value="${t.type}">${t.name}</option>`).join('')}
        </select></div>
        <div class="wf-hint">步骤自上而下顺序执行；任一步失败即中止。dsh 任务卡片步骤会创建看板卡片并可派发 dsh 执行。</div>
      </div>`;
    root.querySelector('#wf-cancel').addEventListener('click', () => { editor = null; renderList(); });
    root.querySelector('#wf-enabled').addEventListener('click', () => { editor.enabled = !editor.enabled; renderEditor(); });
    root.querySelector('#wf-addstep').addEventListener('change', (e) => {
      const t = e.target.value;
      if (!t) return;
      editor.steps.push({ id: `s${Date.now()}`, type: t, config: {} });
      renderEditor();
    });
    for (const [i, s] of editor.steps.entries()) {
      const el = root.querySelector(`.wf-step[data-idx="${i}"]`);
      el.querySelector('[data-act="type"]').addEventListener('change', (e) => { s.type = e.target.value; s.config = {}; renderEditor(); });
      el.querySelector('[data-act="del"]').addEventListener('click', () => { editor.steps.splice(i, 1); renderEditor(); });
      el.querySelector('[data-act="up"]').addEventListener('click', () => { if (i > 0) { editor.steps.splice(i - 1, 0, editor.steps.splice(i, 1)[0]); renderEditor(); } });
      el.querySelector('[data-act="down"]').addEventListener('click', () => { if (i < editor.steps.length - 1) { editor.steps.splice(i + 1, 0, editor.steps.splice(i, 1)[0]); renderEditor(); } });
      bindCfgInputs(el, i);
    }
    root.querySelector('#wf-save').addEventListener('click', async () => {
      const name = root.querySelector('#wf-name').value.trim();
      if (!name) { toast('名称不能为空'); return; }
      const r = await window.workflows.save({ id: editor.id, name, enabled: editor.enabled, steps: editor.steps });
      if (!r.ok) { toast(r.message || '保存失败'); return; }
      editor = null;
      await renderList();
    });
  }

  function bindCfgInputs(stepEl, idx) {
    const s = editor.steps[idx];
    stepEl.querySelectorAll('[data-cfg]').forEach((el) => {
      const key = el.dataset.cfg;
      if (el.tagName === 'BUTTON') return;
      el.addEventListener('change', () => { s.config[key] = el.value; });
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') el.addEventListener('input', () => { s.config[key] = el.value; });
    });
    const sw = stepEl.querySelector('.cn-switch[data-cfg]');
    if (sw) sw.addEventListener('click', () => { const on = sw.getAttribute('aria-checked') === 'true'; sw.setAttribute('aria-checked', String(!on)); s.config[sw.dataset.cfg] = String(!on); });
  }

  function stepCfgHtml(s) {
    const v = (k) => esc(s.config[k] ?? '');
    if (s.type === 'dsh-card') {
      return `<div class="wf-f"><label>看板 ID *</label><input class="input" data-cfg="boardId" value="${v('boardId')}" placeholder="看板 id（列表页可查）"></div>
        <div class="wf-f"><label>卡片标题 *</label><input class="input" data-cfg="title" value="${v('title')}" placeholder="如：每日发布巡检"></div>
        <div class="wf-f"><label>描述</label><textarea data-cfg="description">${v('description')}</textarea></div>
        <div class="wf-f"><label>优先级</label><select data-cfg="priority"><option value="P2">P2</option><option value="P1">P1</option><option value="P0">P0</option></select></div>
        <div class="wf-f"><label>创建后立即执行</label><button type="button" class="cn-switch" data-cfg="execute" role="switch" aria-checked="${s.config.execute === 'true'}"></button><div class="wf-hint">开 = 创建卡片后立即派发 dsh 执行</div></div>`;
    }
    if (s.type === 'http') {
      return `<div class="wf-f"><label>Method</label><select data-cfg="method">${['GET', 'POST', 'PUT', 'DELETE'].map((m) => `<option ${((s.config.method) || 'GET') === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div class="wf-f"><label>URL *</label><input class="input" data-cfg="url" value="${v('url')}" placeholder="https://…"></div>
        <div class="wf-f"><label>Headers（JSON，可选）</label><textarea data-cfg="headers" placeholder='{"X-Token":"…"}'>${v('headers')}</textarea></div>
        <div class="wf-f"><label>Body（可选）</label><textarea data-cfg="body">${v('body')}</textarea></div>`;
    }
    if (s.type === 'notification') {
      return `<div class="wf-f"><label>通知内容 *</label><input class="input" data-cfg="message" value="${v('message')}" placeholder="工作流通知文案"></div>`;
    }
    if (s.type === 'delay') {
      return `<div class="wf-f"><label>等待秒数（1~3600）</label><input class="input" data-cfg="seconds" value="${v('seconds') || '5'}"></div>`;
    }
    return '';
  }

  // 初始：编辑器/列表由外部触发（进入视图即刷新）
  void loadList;
  renderList();
  window.__workflowsRefresh = renderList;
})();
