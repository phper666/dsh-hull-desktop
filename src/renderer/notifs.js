/* §9 V1 通知中心（docs/design/工作流-workflows-design.md §9；视觉基准 prototype/2026-09-03-workflow-notify-variants-prototype.html C 方案）：
   壳级通知中心第一期——本期唯一数据源 = 工作流运行记录（workflows:runs），
   toNotifRows 归一化带 source:'workflow'，v2 接第二源（看板执行/更新可用）时建 NotificationService 迁移，页面零返工。
   未读语义沿 §8.2：status=failed 且 startedAt > localStorage lastReadTs；进入页面即已读；角标 60s 轮询补漏。 */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS_NOTIF_TS = 'workflows:notifLastReadTs';
  const SOURCE_NAMES = { workflow: '工作流' };
  const badge = document.getElementById('notifs-badge');
  const bell = document.getElementById('nav-notifs');
  const root = document.getElementById('notifs-root');
  if (!root) return;

  let rows = [];
  let query = '';
  let statusFilter = 'all'; // all | failed | success
  let triggerFilter = 'all'; // all | cron | manual
  const lastReadTs = () => Number(localStorage.getItem(LS_NOTIF_TS) || 0);

  /** 运行记录 → 通知行归一化（source 维度：本期唯一源 workflow；v2 多源在此扩展） */
  function toNotifRows(runs) {
    return (runs || []).map((r) => ({
      source: 'workflow',
      id: r.id,
      workflowId: r.workflowId,
      title: r.workflowName,
      status: r.status,
      trigger: r.trigger === 'cron' ? 'cron' : 'manual',
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      log: r.log || [],
      durationMs: (r.log || []).reduce((acc, l) => acc + (l.durationMs || 0), 0),
      message: r.status === 'failed'
        ? (r.log || []).find((l) => !l.ok)?.message || '运行失败'
        : (r.log || [])[(r.log || []).length - 1]?.message || '',
      unread: r.status === 'failed' && new Date(r.startedAt).getTime() > lastReadTs(),
    }));
  }

  const fmtRel = (iso) => {
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  };
  const fmtDur = (ms) => (!ms ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  const fmtAbs = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
  const STEP_NAMES = {
    'dsh-card': 'dsh 任务卡片', http: 'HTTP 请求', 'connection-action': '工作台连接动作',
    'token-budget': 'Token 预算检查', notification: '系统通知', delay: '延时等待',
  };

  /* ── 角标（铃铛；进页面清零） ── */
  async function refreshBadge() {
    if (!badge) return;
    try {
      const rr = await window.workflows.runs();
      if (!rr.ok) return;
      const fails = toNotifRows(rr.data).filter((n) => n.unread).length;
      badge.hidden = fails === 0;
      badge.textContent = fails > 99 ? '99+' : String(fails);
    } catch { /* 桥未就绪等，忽略 */ }
  }
  function markRead() {
    localStorage.setItem(LS_NOTIF_TS, String(Date.now()));
    void refreshBadge();
  }

  /* ── 页面 ── */
  function filtered() {
    const q = query.trim().toLowerCase();
    return rows.filter((n) => statusFilter === 'all' || n.status === statusFilter)
      .filter((n) => triggerFilter === 'all' || n.trigger === triggerFilter)
      .filter((n) => !q || n.title.toLowerCase().includes(q) || (n.message || '').toLowerCase().includes(q));
  }

  function rowHtml(n) {
    // §9.5 视觉修订：状态/触发用「色点+文本」替代 pill——文字起点与表头严格对齐（pill 内边距是列错位根因）
    const statusCell = `<span class="dot ${n.status === 'success' ? 'ok' : n.status === 'failed' ? 'err' : 'run'}"></span><span class="st-t ${n.status === 'success' ? 'ok' : n.status === 'failed' ? 'err' : 'run'}">${n.status === 'success' ? '成功' : n.status === 'failed' ? '失败' : '运行中'}</span>`;
    const triggerCell = `<span class="tg ${n.trigger === 'cron' ? 'tg-cron' : ''}">${n.trigger === 'cron' ? '定时' : '手动'}</span>`;
    return `<div class="nt-item" data-id="${esc(n.id)}">
      <div class="nt-row ${n.unread ? 'unread' : ''}" data-toggle-detail>
        <span class="st">${statusCell}</span>
        <span class="wf" title="${esc(n.title)}">${esc(n.title)}</span>
        <span>${triggerCell}</span>
        <span class="msg ${n.status === 'failed' ? 'err' : ''}" title="${esc(n.message)}">${esc(n.message)}</span>
        <span class="dur">${fmtDur(n.durationMs)}</span>
        <span class="tm" title="${esc(fmtAbs(n.startedAt))}">${esc(fmtRel(n.startedAt))}</span>
      </div>
      <div class="nt-detail hidden">${detailHtml(n)}</div>
    </div>`;
  }

  /** §9.5：展开详情——完整步骤日志 + 触发/起止 + 显式跳转按钮（行点击不再直接跳转） */
  function detailHtml(n) {
    const steps = n.log.length
      ? n.log.map((l) => `<div class="nt-step ${l.ok ? '' : 'err'}">${l.ok ? '✓' : '✗'} [${esc(STEP_NAMES[l.type] || l.type)}] ${esc(l.message)}（${fmtDur(l.durationMs)}）</div>`).join('')
      : '<div class="nt-step">（无步骤——空工作流直接运行）</div>';
    return `<div class="nt-detail-inner">
      <div class="nt-meta-line">触发 ${n.trigger === 'cron' ? '定时（cron）' : '手动'} · 开始 ${esc(fmtAbs(n.startedAt))} · 结束 ${esc(fmtAbs(n.finishedAt))} · 总耗时 ${fmtDur(n.durationMs)}</div>
      <div class="nt-steps">${steps}</div>
      <div class="nt-detail-ops"><button class="nt-goto" data-goto-wf="${esc(n.workflowId)}">查看工作流 →</button></div>
    </div>`;
  }

  function render() {
    const list = filtered();
    const unreadFails = rows.filter((n) => n.unread).length;
    root.innerHTML = `
      <div class="nt-toolbar">
        <span class="tk-title">通知中心</span>
        <input class="input nt-search" id="nt-search" placeholder="搜索工作流 / 消息…" value="${esc(query)}" autocomplete="off">
        <div class="c-seg" id="nt-status">
          <button data-f="all" class="${statusFilter === 'all' ? 'active' : ''}">全部</button>
          <button data-f="failed" class="${statusFilter === 'failed' ? 'active' : ''}">失败</button>
          <button data-f="success" class="${statusFilter === 'success' ? 'active' : ''}">成功</button>
        </div>
        <select id="nt-trigger" class="nt-trigger">
          <option value="all" ${triggerFilter === 'all' ? 'selected' : ''}>全部触发</option>
          <option value="cron" ${triggerFilter === 'cron' ? 'selected' : ''}>定时</option>
          <option value="manual" ${triggerFilter === 'manual' ? 'selected' : ''}>手动</option>
        </select>
        <span class="nt-source-chip">来源：工作流</span>
        <span class="nt-meta">${list.length} 条 · 未读失败 ${unreadFails}</span>
      </div>
      <div class="nt-table">
        <div class="nt-thead"><span>状态</span><span>工作流</span><span>触发</span><span>消息</span><span>耗时</span><span>时间</span></div>
        <div id="nt-rows">${list.length ? list.map(rowHtml).join('') : '<div class="nt-empty">没有匹配的通知——工作流运行后会出现在这里</div>'}</div>
      </div>
      <div class="nt-foot">
        <button id="nt-mark">标记全部已读</button>
        <span class="nt-hint">保留最近 50 条 · 点击行进入工作流视图</span>
      </div>`;

    root.querySelector('#nt-search').addEventListener('input', (e) => { query = e.target.value; renderRows(); });
    root.querySelectorAll('#nt-status button').forEach((b) =>
      b.addEventListener('click', () => {
        statusFilter = b.dataset.f;
        root.querySelectorAll('#nt-status button').forEach((x) => x.classList.toggle('active', x === b));
        render();
      })
    );
    root.querySelector('#nt-trigger').addEventListener('change', (e) => { triggerFilter = e.target.value; render(); });
    root.querySelector('#nt-mark').addEventListener('click', () => { rows.forEach((n) => { n.unread = false; }); markRead(); render(); });
    root.querySelector('#nt-rows').addEventListener('click', (e) => {
      const goto = e.target.closest('.nt-goto');
      if (goto) {
        e.stopPropagation();
        window.__workflowsHighlightId = goto.dataset.gotoWf; // 工作流页 renderList 消费：定位 + flash
        if (window.hull) void window.hull.showWorkflows();
        window.__workflowsRefresh?.();
        return;
      }
      const row = e.target.closest('[data-toggle-detail]');
      if (!row) return;
      row.parentElement.querySelector('.nt-detail')?.classList.toggle('hidden');
    });
  }

  function renderRows() {
    const list = filtered();
    const box = root.querySelector('#nt-rows');
    const meta = root.querySelector('.nt-meta');
    if (box) box.innerHTML = list.length ? list.map(rowHtml).join('') : '<div class="nt-empty">没有匹配的通知</div>';
    if (meta) meta.textContent = `${list.length} 条 · 未读失败 ${rows.filter((n) => n.unread).length}`;
  }

  /** 进入页面：拉数据 + 标记已读（§9.2）；由 shell.html 铃铛点击 / nav 高亮回写触发 */
  async function enter() {
    try {
      const rr = await window.workflows.runs();
      rows = rr.ok ? toNotifRows(rr.data) : [];
    } catch { rows = []; }
    markRead();
    render();
  }

  if (bell) {
    bell.addEventListener('click', async () => {
      if (window.hull) await window.hull.showNotifs();
      void enter();
    });
  }

  window.__notifsEnter = enter;
  window.__notifsRefreshBadge = refreshBadge;
  void refreshBadge();
  setInterval(() => void refreshBadge(), 60_000); // §9.2：60s 轻轮询补漏（实时性由系统通知承担）
})();
