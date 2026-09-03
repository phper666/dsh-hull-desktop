/* T-工作流视图（docs/design/工作流-workflows-design.md）：
   数据经 window.workflows 桥（list/get/save/delete/run/runs/cronPreview）。
   v2：手动 + cron 定时触发（编辑器触发区 + 下次运行预览/列表显示）；
       新步骤 connection-action（工作台连接联动，按平台动态参数表单）+ token-budget（Token 预算检查）。 */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STEP_TYPES = [
    { type: 'dsh-card', name: 'dsh 任务卡片' },
    { type: 'http', name: 'HTTP 请求' },
    { type: 'connection-action', name: '工作台连接动作' },
    { type: 'token-budget', name: 'Token 预算检查' },
    { type: 'notification', name: '系统通知' },
    { type: 'delay', name: '延时等待' },
  ];
  const ACTION_PLATFORMS = ['smtp', 'aliyun-sms', 'tencent-sms'];
  const PLATFORM_NAMES = { smtp: 'SMTP 邮件', 'aliyun-sms': '阿里云短信', 'tencent-sms': '腾讯云短信' };
  const stepTypeName = (t) => STEP_TYPES.find((s) => s.type === t)?.name || t;
  const fmtLocal = (iso) => {
    try {
      return new Date(iso).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return iso;
    }
  };

  const root = document.getElementById('workflows-root');
  let workflows = [];
  let runs = [];
  let connections = []; // 脱敏视图（connection-action 步骤下拉）
  let editor = null; // { id?, name, enabled, steps, trigger } | null
  let runningId = null;
  let cronTimer = null;

  /* ── 列表 ── */
  async function renderList() {
    const [lr, rr, cr] = await Promise.all([window.workflows.list(), window.workflows.runs(), window.connections.list()]);
    workflows = lr.ok ? lr.data : [];
    runs = rr.ok ? rr.data : [];
    connections = cr.ok ? cr.data : [];
    const cards = workflows
      .map((w) => {
        const last = runs.find((r) => r.workflowId === w.id);
        const lastBadge = last
          ? `<span class="wf-badge ${last.status}">${last.status === 'running' ? '运行中' : last.status === 'success' ? '上次成功' : '上次失败'}</span>`
          : '<span class="wf-badge muted">未运行过</span>';
        const preview = w.steps.map((s) => `${esc(stepTypeName(s.type))}`).join(' <span class="arrow">→</span> ');
        const next = w.nextRunAt ? `<div class="meta next">⏰ 下次运行：${esc(fmtLocal(w.nextRunAt))}</div>` : '';
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
          ${next}
          <div class="meta">${w.steps.length} 个步骤 · 更新于 ${esc((w.updatedAt || '').replace('T', ' ').slice(0, 16))}</div>
        </div>`;
      })
      .join('');
    root.innerHTML = `
      <div class="wf-toolbar"><span class="tk-title">工作流</span><span class="cn-spacer"></span>
        <button class="wf-btn primary" id="wf-add">＋ 新建工作流</button></div>
      <div class="wf-list">${cards || ''}</div>
      ${runs.length ? `<div class="wf-runs"><h3>最近运行</h3>${runs.slice(0, 8).map(runHtml).join('')}</div>` : ''}
      ${workflows.length ? '' : '<div class="wf-empty"><div class="empty-ico" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="24" r="5"/><path d="M17 24h14"/><circle cx="38" cy="24" r="5" opacity="0.55"/><path d="M29 17l7 7-7 7" opacity="0.6"/></svg></div><h2>还没有工作流</h2><p>把「建卡 → 执行 → 通知」这类重复动作串成一条自动化链；也可配置 cron 定时触发。</p></div>'}`;
    root.querySelector('#wf-add').addEventListener('click', () => { editor = { name: '', enabled: true, steps: [], trigger: null }; renderEditor(); });
    for (const b of root.querySelectorAll('[data-toggle]'))
      b.addEventListener('click', async () => {
        const w = workflows.find((x) => x.id === b.dataset.toggle);
        if (!w) return;
        await window.workflows.save({ id: w.id, name: w.name, enabled: !w.enabled, steps: w.steps, trigger: w.trigger ?? null });
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
    void window.__notifsRefreshBadge?.();
  }

  function runHtml(r) {
    const src = r.trigger === 'cron' ? '<span class="wf-badge cron">定时</span> ' : '';
    return `<div class="wf-run">
      <div class="head">${src}<b>${esc(r.workflowName)}</b><span class="wf-badge ${r.status}">${r.status === 'success' ? '成功' : r.status === 'failed' ? '失败' : '运行中'}</span>
        <span class="time">${esc((r.startedAt || '').replace('T', ' ').slice(0, 19))}</span></div>
      ${r.log.map((l) => `<div class="stepline ${l.ok ? '' : 'err'}">${l.ok ? '✓' : '✗'} [${esc(stepTypeName(l.type))}] ${esc(l.message)}（${l.durationMs}ms）</div>`).join('')}
    </div>`;
  }

  /* ── 编辑器 ── */
  function renderEditor() {
    if (!editor) { renderList(); return; }
    const cron = editor.trigger?.type === 'cron' ? editor.trigger.expr : '';
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
        <div class="wf-f"><label>触发</label>
          <div class="wf-trigger">
            <label class="wf-radio"><input type="radio" name="wf-trig" value="manual" ${cron ? '' : 'checked'}> 手动运行</label>
            <label class="wf-radio"><input type="radio" name="wf-trig" value="cron" ${cron ? 'checked' : ''}> 定时（cron）</label>
          </div></div>
        <div class="wf-f" id="wf-cron-row" ${cron ? '' : 'style="display:none"'}>
          <label>Cron 表达式（分 时 日 月 周）</label>
          <input class="input" id="wf-cron" value="${esc(cron)}" placeholder="*/15 * * * *  或  0 9 * * 1-5（工作日早9点）" autocomplete="off">
          <div class="wf-hint" id="wf-cron-preview"></div>
        </div>
        <div class="wf-steps">${stepsHtml || '<div class="wf-hint">尚无步骤——点击下方添加</div>'}</div>
        <div><select id="wf-addstep" style="border:1px solid var(--hull-border); border-radius:var(--radius-sm); padding:6px 8px; color:var(--hull-text); background:var(--hull-panel);">
          <option value="">＋ 添加步骤…</option>${STEP_TYPES.map((t) => `<option value="${t.type}">${t.name}</option>`).join('')}
        </select></div>
        <div class="wf-hint">步骤自上而下顺序执行；任一步失败即中止。定时触发按本地时区对齐，错过不补跑；同工作流上一轮未结束不会重复触发。</div>
      </div>`;
    root.querySelector('#wf-cancel').addEventListener('click', () => { editor = null; renderList(); });
    root.querySelector('#wf-enabled').addEventListener('click', () => { editor.enabled = !editor.enabled; renderEditor(); });
    for (const radio of root.querySelectorAll('input[name="wf-trig"]'))
      radio.addEventListener('change', () => {
        const row = root.querySelector('#wf-cron-row');
        if (radio.value === 'cron') {
          if (editor.trigger?.type !== 'cron') editor.trigger = { type: 'cron', expr: root.querySelector('#wf-cron').value.trim() || '*/15 * * * *' };
          row.style.display = '';
        } else {
          editor.trigger = null;
          row.style.display = 'none';
        }
        renderEditor();
      });
    const cronInput = root.querySelector('#wf-cron');
    cronInput.addEventListener('input', () => {
      if (editor.trigger?.type === 'cron') editor.trigger.expr = cronInput.value.trim();
      clearTimeout(cronTimer);
      cronTimer = setTimeout(() => void cronPreview(cronInput.value.trim()), 300);
    });
    if (cron) void cronPreview(cron);
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
      if (s.type === 'connection-action') {
        const sel = el.querySelector('[data-cfg="connectionId"]');
        sel?.addEventListener('change', () => { s.config.connectionId = sel.value; renderEditor(); });
        el.querySelectorAll('[data-param]').forEach((inp) =>
          inp.addEventListener('input', () => {
            const params = {};
            el.querySelectorAll('[data-param]').forEach((i2) => { if (i2.value.trim()) params[i2.dataset.param] = i2.value; });
            s.config.params = JSON.stringify(params);
          })
        );
      }
    }
    root.querySelector('#wf-save').addEventListener('click', async () => {
      const name = root.querySelector('#wf-name').value.trim();
      if (!name) { toast('名称不能为空'); return; }
      const r = await window.workflows.save({ id: editor.id, name, enabled: editor.enabled, steps: editor.steps, trigger: editor.trigger ?? null });
      if (!r.ok) { toast(r.message || '保存失败'); return; }
      editor = null;
      await renderList();
    });
  }

  async function cronPreview(expr) {
    const el = root.querySelector('#wf-cron-preview');
    if (!el) return;
    if (!expr) { el.textContent = ''; el.classList.remove('err'); return; }
    const r = await window.workflows.cronPreview(expr);
    if (!r.ok || !r.data) return;
    if (r.data.valid) {
      el.classList.remove('err');
      el.textContent = `下次触发：${r.data.next.map(fmtLocal).join(' / ')}`;
    } else {
      el.classList.add('err');
      el.textContent = r.data.error || 'cron 表达式非法';
    }
  }

  function bindCfgInputs(stepEl, idx) {
    const s = editor.steps[idx];
    stepEl.querySelectorAll('[data-cfg]').forEach((el) => {
      const key = el.dataset.cfg;
      if (el.tagName === 'BUTTON') return;
      if (s.type === 'connection-action' && key === 'connectionId') return; // 平台参数表单随连接切换，单独绑定
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
    if (s.type === 'connection-action') {
      let p = {};
      try { p = JSON.parse(s.config.params || '{}') || {}; } catch { /* 坏 JSON 忽略，重填 */ }
      const selected = connections.find((c) => c.id === s.config.connectionId);
      const usable = connections.filter((c) => ACTION_PLATFORMS.includes(c.platform));
      const connOptions = usable
        .map((c) => `<option value="${c.id}" ${c.id === s.config.connectionId ? 'selected' : ''}>${esc(c.name)}（${PLATFORM_NAMES[c.platform] || c.platform}）</option>`)
        .join('');
      let fields = '<div class="wf-hint">选择连接后出现对应平台的参数表单</div>';
      if (selected?.platform === 'smtp') {
        fields = `<div class="wf-f"><label>收件人 *（逗号分隔多个）</label><input class="input" data-param="to" value="${esc(p.to ?? '')}" placeholder="a@x.com, b@y.com"></div>
          <div class="wf-f"><label>主题 *</label><input class="input" data-param="subject" value="${esc(p.subject ?? '')}"></div>
          <div class="wf-f"><label>正文</label><textarea data-param="body">${esc(p.body ?? '')}</textarea></div>
          <div class="wf-f"><label>发件人（可选，默认连接用户名）</label><input class="input" data-param="from" value="${esc(p.from ?? '')}"></div>`;
      } else if (selected?.platform === 'aliyun-sms') {
        fields = `<div class="wf-f"><label>手机号 *</label><input class="input" data-param="phoneNumbers" value="${esc(p.phoneNumbers ?? '')}" placeholder="13800001111,13900002222"></div>
          <div class="wf-f"><label>模板 Code *</label><input class="input" data-param="templateCode" value="${esc(p.templateCode ?? '')}" placeholder="SMS_12345678"></div>
          <div class="wf-f"><label>模板参数（JSON，可选）</label><input class="input" data-param="templateParam" value="${esc(p.templateParam ?? '')}" placeholder='{"code":"1234"}'></div>`;
      } else if (selected?.platform === 'tencent-sms') {
        fields = `<div class="wf-f"><label>手机号 *（E.164，逗号分隔）</label><input class="input" data-param="phoneNumberSet" value="${esc(p.phoneNumberSet ?? '')}" placeholder="+8613800001111"></div>
          <div class="wf-f"><label>模板 ID *</label><input class="input" data-param="templateId" value="${esc(p.templateId ?? '')}"></div>
          <div class="wf-f"><label>模板参数（JSON 数组，可选）</label><input class="input" data-param="templateParamSet" value="${esc(p.templateParamSet ?? '')}" placeholder='["1234"]'></div>`;
      }
      return `<div class="wf-f"><label>连接 *</label>
          <select data-cfg="connectionId"><option value="">选择连接…</option>${connOptions}</select>
          <div class="wf-hint">仅 SMTP / 阿里云短信 / 腾讯云短信支持动作${usable.length ? '' : '；暂无可用连接，请先到「工作台连接」创建'}</div></div>
        ${fields}`;
    }
    if (s.type === 'token-budget') {
      return `<div class="wf-f"><label>统计周期</label><select data-cfg="period">
          <option value="day" ${(s.config.period || 'day') === 'day' ? 'selected' : ''}>今天（0 点对齐）</option>
          <option value="month" ${s.config.period === 'month' ? 'selected' : ''}>本月（1 号对齐）</option>
          <option value="all" ${s.config.period === 'all' ? 'selected' : ''}>全部累计</option>
        </select></div>
        <div class="wf-f"><label>阈值 totalTokens *</label><input class="input" data-cfg="thresholdTokens" value="${v('thresholdTokens')}" placeholder="如 500000"></div>
        <div class="wf-hint">超限 = 工作流失败并发送系统通知（自动，无需配置）</div>`;
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
  renderList();
  window.__workflowsRefresh = renderList;
  // §9：角标/通知中心归 notifs.js；运行操作后顺带刷新角标
  void window.__notifsRefreshBadge?.();
})();