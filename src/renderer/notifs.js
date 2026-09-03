/* §9 V1 + V2a 通知中心（docs/design/通知中心v2a-notify-service-design.md）：
   数据经 window.notifs 桥（list/markAllRead + onChanged 推送）——NotificationService 独立存储。
   双源：工作流（workflow）/ 看板执行（board-exec）；未读 = severity error 且 readAt 为空；
   角标 60s 轮询兜底 + onChanged 即时刷；进入页面即已读。
   跳转：workflow 行 → 工作流视图；board-exec 行 → 看板视图 + 任务详情（notifs:openTask / __kanbanOpenTask）。 */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SOURCE_NAMES = { workflow: '工作流', 'board-exec': '看板执行' };
  const STEP_NAMES = {
    'dsh-card': 'dsh 任务卡片', http: 'HTTP 请求', 'connection-action': '工作台连接动作',
    'token-budget': 'Token 预算检查', notification: '系统通知', delay: '延时等待',
  };
  const badge = document.getElementById('notifs-badge');
  const bell = document.getElementById('nav-notifs');
  const root = document.getElementById('notifs-root');
  if (!root) return;

  let rows = [];
  let query = '';
  let statusFilter = 'all'; // all | failed | success（success 档 = info 通知）
  let sourceFilter = 'all'; // all | workflow | board-exec

  const fmtRel = (iso) => {
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  };
  const fmtAbs = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
  const fmtDur = (ms) => (!ms ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  const unreadCount = () => rows.filter((n) => n.severity === 'error' && n.readAt === null).length;

  /* ── 角标 ── */
  async function refreshBadge() {
    if (!badge) return;
    try {
      const rr = await window.notifs.list();
      if (!rr.ok) return;
      // 角标一律以 service 状态为准（markRead 后立即清零）；本地 rows 仅承载页面未读样式（进入页渲染后不冲掉）
      const fails = (rr.data || []).filter((n) => n.severity === 'error' && n.readAt === null).length;
      badge.hidden = fails === 0;
      badge.textContent = fails > 99 ? '99+' : String(fails);
      const section = document.getElementById('notifs');
      if (!section || section.classList.contains('hidden')) rows = rr.data || [];
    } catch { /* 桥未就绪等，忽略 */ }
  }
  function markRead() {
    void window.notifs.markAllRead();
  }

  /* ── 过滤 ── */
  function filtered() {
    const q = query.trim().toLowerCase();
    return rows
      .filter((n) => sourceFilter === 'all' || n.source === sourceFilter)
      .filter((n) => statusFilter === 'all' || (statusFilter === 'failed' ? n.severity === 'error' : n.severity === 'info'))
      .filter((n) => !q || n.title.toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q));
  }

  function rowHtml(n) {
    const failed = n.severity === 'error';
    const trigger = n.source === 'workflow' && n.meta?.trigger === 'cron' ? '<span class="badge cron">定时</span>' : n.source === 'workflow' ? '<span class="badge muted">手动</span>' : '';
    return `<div class="nt-item" data-id="${esc(n.id)}">
      <div class="nt-row ${n.readAt === null ? 'unread' : ''}" data-toggle-detail>
        <span class="st"><span class="dot ${failed ? 'err' : 'ok'}"></span><span class="st-t ${failed ? 'err' : 'ok'}">${failed ? '失败' : '通知'}</span></span>
        <span class="wf" title="${esc(n.title)}">${esc(n.title)}</span>
        <span>${trigger}</span>
        <span class="msg ${failed ? 'err' : ''}" title="${esc(n.body)}">${esc(n.body)}</span>
        <span class="dur">${fmtDur(n.meta?.durationMs)}</span>
        <span class="tm" title="${esc(fmtAbs(n.ts))}">${esc(fmtRel(n.ts))}</span>
      </div>
      <div class="nt-detail hidden">${detailHtml(n)}</div>
    </div>`;
  }

  function detailHtml(n) {
    const metaLine = n.source === 'workflow'
      ? `来源 ${SOURCE_NAMES[n.source]} · 触发 ${n.meta?.trigger === 'cron' ? '定时（cron）' : '手动'} · ${esc(fmtAbs(n.ts))} · 总耗时 ${fmtDur(n.meta?.durationMs)}`
      : `来源 ${SOURCE_NAMES[n.source]} · ${esc(fmtAbs(n.ts))}`;
    const log = Array.isArray(n.meta?.log) ? n.meta.log : [];
    const steps = n.source === 'workflow' && log.length
      ? log.map((l) => `<div class="nt-step ${l.ok ? '' : 'err'}">${l.ok ? '✓' : '✗'} [${esc(STEP_NAMES[l.type] || l.type)}] ${esc(l.message)}（${fmtDur(l.durationMs)}）</div>`).join('')
      : '';
    const gotoLabel = n.link.kind === 'task' ? '查看任务 →' : '查看工作流 →';
    return `<div class="nt-detail-inner">
      <div class="nt-meta-line">${metaLine}</div>
      ${steps ? `<div class="nt-steps">${steps}</div>` : ''}
      <div class="nt-detail-ops"><button class="nt-goto" data-goto="${esc(n.id)}">${gotoLabel}</button></div>
    </div>`;
  }

  function render() {
    const list = filtered();
    root.innerHTML = `
      <div class="nt-toolbar">
        <span class="tk-title">通知中心</span>
        <input class="input nt-search" id="nt-search" placeholder="搜索标题 / 消息…" value="${esc(query)}" autocomplete="off">
        <div class="c-seg" id="nt-status">
          <button data-f="all" class="${statusFilter === 'all' ? 'active' : ''}">全部</button>
          <button data-f="failed" class="${statusFilter === 'failed' ? 'active' : ''}">失败</button>
          <button data-f="success" class="${statusFilter === 'success' ? 'active' : ''}">通知</button>
        </div>
        <div class="c-seg" id="nt-source">
          <button data-f="all" class="${sourceFilter === 'all' ? 'active' : ''}">全部来源</button>
          <button data-f="workflow" class="${sourceFilter === 'workflow' ? 'active' : ''}">工作流</button>
          <button data-f="board-exec" class="${sourceFilter === 'board-exec' ? 'active' : ''}">看板执行</button>
        </div>
        <span class="nt-meta">${list.length} 条 · 未读失败 ${unreadCount()}</span>
      </div>
      <div class="nt-table">
        <div class="nt-thead"><span>状态</span><span>标题</span><span>触发</span><span>消息</span><span>耗时</span><span>时间</span></div>
        <div id="nt-rows">${list.length ? list.map(rowHtml).join('') : '<div class="nt-empty">没有匹配的通知——工作流运行 / 看板执行后出现在这里</div>'}</div>
      </div>
      <div class="nt-foot">
        <button id="nt-mark">标记全部已读</button>
        <span class="nt-hint">每源保留最近 50/100 条 · 点击行展开详情</span>
      </div>`;

    root.querySelector('#nt-search').addEventListener('input', (e) => { query = e.target.value; renderRows(); });
    root.querySelectorAll('#nt-status button').forEach((b) =>
      b.addEventListener('click', () => {
        statusFilter = b.dataset.f;
        root.querySelectorAll('#nt-status button').forEach((x) => x.classList.toggle('active', x === b));
        render();
      })
    );
    root.querySelectorAll('#nt-source button').forEach((b) =>
      b.addEventListener('click', () => {
        sourceFilter = b.dataset.f;
        root.querySelectorAll('#nt-source button').forEach((x) => x.classList.toggle('active', x === b));
        render();
      })
    );
    root.querySelector('#nt-mark').addEventListener('click', () => { markRead(); });
    root.querySelector('#nt-rows').addEventListener('click', (e) => {
      const goto = e.target.closest('.nt-goto');
      if (goto) {
        e.stopPropagation();
        const n = rows.find((x) => x.id === goto.dataset.goto);
        if (!n) return;
        if (n.link.kind === 'task') {
          if (window.hull) void window.hull.showBoard();
          window.__kanbanOpenTask?.(n.link.taskId); // 看板视图内打开任务详情
        } else {
          window.__workflowsHighlightId = n.link.workflowId;
          if (window.hull) void window.hull.showWorkflows();
          window.__workflowsRefresh?.();
        }
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
    if (meta) meta.textContent = `${list.length} 条 · 未读失败 ${unreadCount()}`;
  }

  /** 进入页面：拉数据 + 标记已读（§9.2）；由铃铛点击触发 */
  async function enter() {
    try {
      const rr = await window.notifs.list();
      rows = rr.ok ? rr.data || [] : [];
    } catch { rows = []; }
    render(); // 先渲染未读样式（本次浏览的「新」标记），再后台标读
    markRead();
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
  window.notifs?.onChanged?.(() => void refreshBadge()); // V2a：主进程推送即时刷
  setInterval(() => void refreshBadge(), 60_000); // 兜底轮询（onChanged 丢失时补漏）
})();
