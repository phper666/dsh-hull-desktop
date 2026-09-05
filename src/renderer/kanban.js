/**
 * B2 看板 UI（M2，feishu-b2-m2-kanban-api-contract.md）
 * 消费 window.kanban（18 原语：B1 16 IPC + B5 export/import 2）+ window.exec（执行控制 10 通道 + onPermissionRequest/onPermissionSettled/onExecutionUpdate 订阅）+ window.hull（showBoard nav 接入）。
 * 纯原生 JS 无框架。深色主题沿用 shell.html 设计语言（#171c26/#2a3342/#2e8bf5）。
 * 视图：看板/列表/归档/时间线/日历 五视图（T1，CON-R-timeline-005 复用多视图状态机；视图持久化 localStorage Q-053）。
 * UI 场景 1~7 + 空态三态（Q-021）。
 */
(() => {
  const kanban = window.kanban;
  const exec = window.exec;
  const boardRoot = document.getElementById('board-root');
  if (!kanban || !boardRoot) return;

  const execNames = { idle: '未执行', queued: '排队中', running: '执行中', paused: '已暂停', interrupted: '已中断', cancelled: '已取消', failed: '失败', succeeded: '已成功' };
  // T1/CON-R-timeline-005：五视图并列（Board/List/Archive/Timeline/Calendar），复用 boardToolbar 自动出按钮。
  // 注意：须先于「状态」块定义——初始视图恢复依赖 viewNames 枚举校验。
  const viewNames = { board: '看板', list: '列表', archive: '归档', timeline: '时间线', calendar: '日历', sessions: '会话' };
  // T1/Q-053：视图持久化 = renderer localStorage（不 bump HullSettings schema、无 IPC）
  const LAST_VIEW_KEY = 'kanban:lastView';
  function loadLastView() {
    try {
      const v = localStorage.getItem(LAST_VIEW_KEY);
      return Object.keys(viewNames).includes(v) ? v : 'board'; // 非法值兜底回退 board（P3）
    } catch { return 'board'; } // localStorage 不可用（隐私模式）静默回退
  }
  function saveLastView(v) {
    try { localStorage.setItem(LAST_VIEW_KEY, v); } catch { /* 隐私模式等：切换仍生效，仅不记忆 */ }
  }

  // ── 状态 ──
  let boards = [];
  let currentBoard = null;
  let view = loadLastView(); // T1/Q-053：初始视图恢复上次选择（替代硬编码 'board'）
  let filterCol = 'all';
  let filterQ = '';
  let dragTaskId = null;
  let approvalModal = null;
  let openDepgraphTaskId = null; // U3：依赖图弹框当前打开的任务 id（exec 刷新时推最新数据）
  let openDetailTaskId = null; // 需求 1（2026-09-05）：详情弹框定向更新定位（开/关同步）
  let openDetailWrap = null;
  // T1/D5 按需渲染状态：时间线分页 + 日历粒度/游标
  // ponytail: 分页封顶首屏 DOM（CON-R-timeline-006 <300ms）；≥1000 卡实测超标再升级虚拟滚动（只换 renderTimeline 内部，聚合纯函数不动）
  const TIMELINE_PAGE_SIZE = 100;
  let timelinePage = 1;
  let calMode = 'month'; // 'month' | 'week'（U-1 定案：默认月）
  let calCursor = new Date();

  // ── 工具 ──
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const colById = (id) => currentBoard?.columns.find((c) => c.id === id);
  const taskById = (id) => currentBoard?.tasks.find((t) => t.id === id);
  const activeTasks = () => (currentBoard?.tasks || []).filter((t) => !t.archivedAt);
  const archivedTasks = () => (currentBoard?.tasks || []).filter((t) => t.archivedAt);
  const childrenOf = (id) => (currentBoard?.tasks || []).filter((t) => t.parentId === id);
  const visibleCols = () => orderedCols().filter((c) => !c.hidden);
  /* 列拖拽换序（用户需求 2026-08-30）：显示顺序 = order 字段升序（未设置按数组下标兜底）。
     重排实现：拖拽落点 → 有序数组内 splice → 全列重赋 order（变更列批量 updateColumn） */
  const orderedCols = () => {
    const cols = currentBoard?.columns || [];
    return cols
      .map((c, i) => [c, i])
      .sort((a, b) => ((a[0].order ?? a[1]) - (b[0].order ?? b[1])) || (a[1] - b[1]))
      .map(([c]) => c);
  };
  const subDone = (t) => { const ch = childrenOf(t.id); return ch.length ? ch.filter((c) => c.executionStatus === 'succeeded' || colById(c.columnId)?.type === 'done').length + '/' + ch.length : ''; };

  // ── E1 Markdown 渲染管线（markdown-it v14.1.0 + DOMPurify；CON-R-editor-002/004/005）──
  // 库经 shell.html <script src="vendor/*"> 本地加载（CSP 'self'，无 CDN）；缺失时兜底 esc（纯文本降级，不抛错）
  // breaks:true 兼容旧纯文本 description 换行显示（E5 场景：textarea 时代换行可见）；html:false 默认——原始 HTML 转义为文本
  const md = (() => {
    if (!window.markdownit || !window.DOMPurify) return null;
    const inst = window.markdownit({ breaks: true, linkify: false });
    if (window.markdownitTaskLists) inst.use(window.markdownitTaskLists);
    return inst;
  })();
  // 唯一用户内容进 HTML 的出口：markdown-it 渲染 → DOMPurify 消毒（XSS 载荷移除事件属性/script/javascript: href）
  const mdRender = (text) => (md && window.DOMPurify ? window.DOMPurify.sanitize(md.render(String(text ?? ''))) : esc(text));

  // ── E1 EasyMDE 编辑器工厂（create/edit/comment 三入口；Q-041 每开新建、关即 destroy 不复用）──
  function createEditor(textarea, initialValue) {
    if (!window.EasyMDE || !textarea) return null;
    return new window.EasyMDE({
      element: textarea,
      initialValue: initialValue ?? textarea.value,
      spellChecker: false,
      autoDownloadFontAwesome: false, // E14/Q-042：禁运行时注入 FA CDN <link>（CSP 违规源）；图标用本地 unicode 兜底（easymde-dark.css）
      status: false,
      // 工具栏裁剪：去 guide（外链导航风险）/fullscreen（弹窗内无意义），保留 GFM 全套 + 双预览切换
      toolbar: ['bold', 'italic', 'strikethrough', 'heading', '|', 'unordered-list', 'ordered-list', 'check-list', 'table', '|', 'link', '|', 'preview', 'side-by-side'],
      previewRender: (plainText) => mdRender(plainText), // Q-047：预览与详情读态同一管线，GFM 语义两端一致
    });
  }
  const destroyEditor = (editor) => { try { editor?.destroy(); } catch {} };

  // ── 模型选择（window.exec.listModels/setBoardDefaultModel 桥由执行链 lane 提供）──
  // 桥缺失/报错 → 隐藏选择器，不阻塞表单；模块级缓存：成功 5 分钟，失败 30 秒快速重试（Q-023）
  const MODELS_TTL_MS = 5 * 60 * 1000;
  const MODELS_FAIL_TTL_MS = 30 * 1000; // Q-023：失败缓存快速过期（30s 重试），不与成功缓存同 TTL
  let modelsCache = null; // { at, groups|null }（null=失败，30s 后重试）
  const MODEL_PRIORITY_HINT = '优先级：本卡片所选模型 → 看板默认模型 → dsh 默认；自定义渠道来自 dsh 设置';

  // ── 推理力度选择（B4-推理力度 UI；agentSpec.reasoningEffort / board.defaultReasoningEffort 由执行链 lane 存储执行）──
  // 2026-09-05 调整：删「默认（dsh 决定）」空选项——dsh 默认（off）对 glm 系模型必 400，所有任务显式选力度；
  // 未设置过（null/undefined）显示态预选 low（不写回，存储保持 null，终端兜底由执行链负责）；
  // off 对部分模型（如 glm 系）非法 → 执行 400 → 失败通知带原因；deepseek-official 内置模型 off 合法（省 token）
  const REASONING_EFFORTS = [['low', 'low'], ['off', 'off（关闭思考）'], ['medium', 'medium'], ['high', 'high'], ['max', 'max']];
  const REASONING_TICKET_HINT = '推理力度——ticket 所选 > 看板默认；未设置时按 low 执行；部分模型不支持 off（关闭思考），选了会执行失败并提示';
  const REASONING_BOARD_HINT = '看板默认推理力度——ticket 未选时使用；未设置时按 low 执行，部分模型不支持 off';
  const reasoningOptionsHtml = (selected) => {
    const sel = selected || 'low'; // 显示态预选 low：仅显示，不写回
    return REASONING_EFFORTS.map(([v, n]) =>
      `<option value="${esc(v)}" ${sel === v ? 'selected' : ''}>${esc(n)}</option>`).join('');
  };
  async function loadModelGroups() {
    if (modelsCache) {
      // Q-023：失败缓存 30s 快速过期（重试），成功缓存仍 5 分钟
      const ttl = modelsCache.groups ? MODELS_TTL_MS : MODELS_FAIL_TTL_MS;
      if (Date.now() - modelsCache.at < ttl) return modelsCache.groups;
    }
    let groups = null;
    try {
      const r = await window.exec?.listModels?.();
      if (r && Array.isArray(r.data)) groups = r.data; // Result 包装 { ok, data }
      else if (Array.isArray(r)) groups = r; // 兜底：直接返回数组
    } catch { groups = null; } // Q-023：IPC reject（如超时）/桥异常 → 隐藏降级
    modelsCache = { at: Date.now(), groups };
    return groups;
  }
  // name/description 来自 dsh 配置，仍按不可信文本 esc() 转义
  const modelOptionsHtml = (groups, emptyLabel) =>
    `<option value="">${esc(emptyLabel)}</option>` + groups.map((g) =>
      `<optgroup label="${esc(g.name)}">${(g.options || []).map((o) =>
        `<option value="${esc(o.value)}" ${o.description ? `title="${esc(o.description)}"` : ''}>${esc(o.name)}</option>`).join('')}</optgroup>`).join('');
  /**
   * 异步填充模型 select（初始渲染「加载模型中…」占位）；失败 → 隐藏（wrapSel 给定时隐藏整行，否则隐藏 select 自身）。
   * Q-023：任何异常不再逃逸（try/catch 收敛到隐藏降级，渲染层不卡「加载模型中…」占位符）。
   * 返回 true=已到终态（填充/隐藏）；false=填充时 select 已被重渲染替换（disconnected）——
   * 调用方可用 fillModelSelectWithRetry 安排 rAF 重试一次。
   */
  async function fillModelSelect(sel, selected, emptyLabel, wrapSel, retried = false) {
    let groups;
    try {
      groups = await loadModelGroups();
    } catch { groups = null; }
    if (!sel.isConnected) return false;
    if (!groups) { (wrapSel ? sel.closest(wrapSel) : sel).style.display = 'none'; return true; }
    sel.innerHTML = modelOptionsHtml(groups, emptyLabel);
    sel.value = selected || '';
    return true;
  }
  // Q-023：填充 + disconnected 重试一次——rAF 后按 getter 重查 DOM（render 重渲染替换出的新节点）
  function fillModelSelectWithRetry(getSel, selected, emptyLabel, wrapSel) {
    return fillModelSelect(getSel(), selected, emptyLabel, wrapSel).then((done) => {
      if (!done) requestAnimationFrame(() => { void fillModelSelect(getSel(), selected, emptyLabel, wrapSel, true); });
    });
  }

  // ── 原生目录选择器（hull:pickDirectory 桥，dialog:pickDirectory 通道）──
  // 桥不存在/报错 → alert 提示，不影响手输；取消（path null）→ 不改动 input
  async function pickDirectory() {
    try {
      const r = await window.hull?.pickDirectory?.();
      if (r && r.ok) return r.path || null;
      alert('无法打开目录选择器：' + (r && r.message ? r.message : '桥不可用'));
    } catch { alert('无法打开目录选择器'); }
    return null;
  }

  // ── 主渲染 ──
  function render() {
    if (!currentBoard) { renderEmpty(); return; }
    if (view === 'board') renderBoard();
    else if (view === 'list') renderList();
    else if (view === 'archive') renderArchive();
    else if (view === 'timeline') renderTimeline(); // T1/CON-R-timeline-001
    else if (view === 'sessions') renderSessions(); // 会话视图（2026-09-05：壳内分组空间，dsh web 无法归组 ACP 会话）
    else renderCalendar(); // T1/CON-R-timeline-002
  }

  function renderEmpty() {
    boardRoot.innerHTML = `<div class="kb-empty"><div class="empty-ico" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="9" height="34" rx="2"/><rect x="19.5" y="7" width="9" height="34" rx="2" opacity="0.55"/><rect x="32" y="7" width="9" height="34" rx="2" opacity="0.55"/><path d="M11 20h3M23.5 20h3M36 20h3" opacity="0.6"/></svg></div><h2>没有看板</h2><p>创建一个任务看板开始规划</p><button class="kb-btn kb-primary" id="kb-newboard-empty">新建看板</button></div>`;
    $('#kb-newboard-empty')?.addEventListener('click', promptNewBoard);
  }

  function boardToolbar() {
    const cols = orderedCols();
    return `<div class="kb-toolbar">
      <div class="kb-boards"><select id="kb-board-select">${boards.map((b) => `<option value="${b.id}" ${b.id === currentBoard.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select><button class="kb-btn" id="kb-newboard">＋ 新建</button></div>
      <div class="kb-views">${Object.entries(viewNames).map(([k, n]) => `<button class="kb-view ${view === k ? 'active' : ''}" data-view="${k}">${n}</button>`).join('')}</div>
      <div class="kb-filters"><select id="kb-col-filter"><option value="all">全部列</option>${cols.map((c) => `<option value="${c.id}" ${filterCol === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><input id="kb-q" placeholder="筛选关键词…" value="${esc(filterQ)}" /><select id="kb-board-model" class="kb-input" title="看板默认模型——ticket 未选模型时使用；自定义渠道来自 dsh 设置；变更即时保存"><option value="">加载模型中…</option></select><input id="kb-board-cwd" class="kb-input" placeholder="${esc(currentBoard?.defaultCwd || '~')}" title="看板默认工作目录——ticket 未填时使用；agent 会话将在此目录运行；仅作用于 kanban 任务执行（dsh web 聊天工作区不在此设置）；失焦/回车保存" value="${esc(currentBoard?.defaultCwd || '')}" /><button class="kb-btn" id="kb-board-cwd-browse">浏览…</button><select id="kb-board-effort" class="kb-input" title="${REASONING_BOARD_HINT}">${reasoningOptionsHtml(currentBoard?.defaultReasoningEffort || '')}</select></div>
    </div>`;
  }

  function renderBoard() {
    const cols = visibleCols();
    boardRoot.innerHTML = boardToolbar() + `<div class="kb-cols" id="kb-cols">${cols.map((c) => {
      const tasks = activeTasks().filter((t) => t.columnId === c.id && matchesFilter(t));
      const empty = tasks.length === 0;
      return `<div class="kb-col" data-col="${c.id}" style="border-top-color:${c.color}"><div class="kb-col-head" draggable="true" title="拖拽换序"><span class="kb-col-name">${esc(c.name)}</span><span class="kb-col-count">${tasks.length}</span><span class="kb-col-actions"><button class="kb-icon" title="列管理" data-act="col-mgr">⚙</button></span></div><div class="kb-col-body">${empty ? '<div class="kb-empty-col">空列</div>' : tasks.map(cardHtml).join('')}</div><button class="kb-add-card" data-col="${c.id}">＋ 添加卡片</button></div>`;
    }).join('')}</div>`;
    bindBoardEvents();
  }

  function matchesFilter(t) {
    if (filterCol !== 'all' && t.columnId !== filterCol) return false;
    if (filterQ && !(t.title + ' ' + (t.description || '') + ' ' + t.labels.join(' ')).toLowerCase().includes(filterQ.toLowerCase())) return false;
    return true;
  }

  function cardHtml(t) {
    const col = colById(t.columnId);
    const isVerify = col?.type === 'verify';
    const done = col?.type === 'done';
    const execNamesBadge = t.executionStatus !== 'idle' ? execNames[t.executionStatus] || t.executionStatus : '';
    // 需求 2（2026-09-05）：succeeded 徽标 hover title 显示结果摘要前 80 字（timeline 最新「执行结果：」comment；esc 转义）
    const resultCmt = t.executionStatus === 'succeeded' ? (t.timeline || []).filter((i) => i.type === 'comment' && i.content.startsWith('执行结果：')).pop() : null;
    const execTitle = resultCmt ? ` title="${esc(resultCmt.content.slice(0, 80))}"` : '';
    const execBadge = execNamesBadge ? `<span class="kb-exec kb-exec-${t.executionStatus}"${execTitle}>${execNamesBadge}</span>` : '';
    const runBtn = (t.executionStatus === 'idle' || ['failed', 'cancelled', 'interrupted', 'succeeded'].includes(t.executionStatus)) ? `<button class="kb-run" data-run="${t.id}" title="执行">▶</button>` : '';
    const pauseBtn = t.executionStatus === 'running' ? `<button class="kb-run" data-pause="${t.id}" title="暂停">⏸</button>` : '';
    const resumeBtn = t.executionStatus === 'paused' ? `<button class="kb-run" data-resume="${t.id}" title="恢复">▶</button>` : '';
    const cancelBtn = t.executionStatus === 'running' || t.executionStatus === 'queued' ? `<button class="kb-run" data-cancel="${t.id}" title="取消">✕</button>` : '';
    const verifyBtn = isVerify && (['succeeded', 'idle', 'interrupted'].includes(t.executionStatus)) ? `<button class="kb-run" data-verify="${t.id}" title="确认完成">✓</button>` : '';
    return `<div class="kb-card ${done ? 'kb-done' : ''}" draggable="true" data-id="${t.id}"><div class="kb-card-top"><span class="kb-pri kb-pri-${t.priority}">${esc(t.priority)}</span>${t.labels.map((l) => `<span class="kb-label">${esc(l)}</span>`).join('')}${execBadge}</div><div class="kb-card-title">${esc(t.title)}</div>${t.description ? `<div class="kb-card-desc">${esc(t.description)}</div>` : ''}${subDone(t) ? `<div class="kb-sub">子任务 ${subDone(t)}</div>` : ''}<div class="kb-card-ops">${runBtn}${pauseBtn}${resumeBtn}${cancelBtn}${verifyBtn}<button class="kb-run" data-detail="${t.id}" title="详情">⋯</button></div></div>`;
  }

  // ── 列表视图排序/树形状态（需求 2，模块级持久）──
  let listSort = { key: null, dir: 'asc' }; // 三态循环：asc → desc → 默认（order）
  const listCollapsed = new Set(); // 树形折叠：已折叠父任务 id 集

  /** 列表排序：标题/列/标签 localeCompare；优先级 P0<P1<P2<无；执行态固定序（活跃在前）；默认按 order */
  function sortTasksForList(tasks) {
    const priOrd = { P0: 0, P1: 1, P2: 2, '无': 3 };
    const stOrd = { running: 0, queued: 1, paused: 2, idle: 3, interrupted: 4, cancelled: 5, failed: 6, succeeded: 7 };
    const { key, dir } = listSort;
    const cmp = (a, b) => {
      let d = 0;
      if (key === 'title') d = a.title.localeCompare(b.title);
      else if (key === 'col') d = (colById(a.columnId)?.name || '').localeCompare(colById(b.columnId)?.name || '');
      else if (key === 'priority') d = (priOrd[a.priority] ?? 9) - (priOrd[b.priority] ?? 9);
      else if (key === 'status') d = (stOrd[a.executionStatus] ?? 9) - (stOrd[b.executionStatus] ?? 9);
      else if (key === 'labels') d = a.labels.join(',').localeCompare(b.labels.join(','));
      if (d === 0) d = a.order - b.order; // 同值稳定次序兜底
      return dir === 'desc' ? -d : d;
    };
    return key ? tasks.slice().sort(cmp) : tasks.slice().sort((a, b) => a.order - b.order);
  }

  function renderList() {
    // 树形（需求 2）：仅 parentId 子任务成树（DAG 依赖保持依赖图视图）；筛选作用于父任务，子随父展示
    const top = sortTasksForList(activeTasks().filter((t) => !t.parentId && matchesFilter(t)));
    const headers = [['title', '标题'], ['col', '列'], ['priority', '优先级'], ['status', '执行态'], ['labels', '标签']];
    const ths = headers.map(([k, n]) => {
      const arrow = listSort.key === k ? (listSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th data-sortkey="${k}" class="kb-sortable" title="点击排序">${esc(n + arrow)}</th>`;
    }).join('');
    const rowHtml = (t, opts = {}) => {
      const col = colById(t.columnId);
      const twist = opts.arrow !== undefined ? `<span class="kb-tree-twist" data-collapse="${t.id}">${opts.arrow}</span>` : '<span class="kb-tree-indent"></span>';
      return `<tr data-id="${t.id}" ${opts.isChild ? 'class="kb-child-row"' : ''}><td>${twist}${esc(t.title)}${t.parentId ? ' <span class="kb-subtag">子任务</span>' : ''}</td><td>${col ? `<span class="kb-col-chip" style="border-color:${col.color}">${esc(col.name)}</span>` : ''}</td><td><span class="kb-pri kb-pri-${t.priority}">${esc(t.priority)}</span></td><td><span class="kb-exec kb-exec-${t.executionStatus}">${execNames[t.executionStatus] || t.executionStatus}</span></td><td>${t.labels.map((l) => `<span class="kb-label">${esc(l)}</span>`).join('')}</td></tr>`;
    };
    const body = top.map((t) => {
      const kids = childrenOf(t.id);
      const collapsed = listCollapsed.has(t.id);
      let html = rowHtml(t, kids.length ? { arrow: collapsed ? '▶' : '▼' } : {});
      if (kids.length && !collapsed) html += kids.map((s) => rowHtml(s, { isChild: true })).join('');
      return html;
    }).join('');
    boardRoot.innerHTML = boardToolbar() + `<div class="kb-list-wrap"><table class="kb-list kb-listview"><thead><tr>${ths}</tr></thead><tbody>${body || '<tr><td colspan="5" class="kb-empty-row">筛选无结果</td></tr>'}</tbody></table></div>`;
    bindBoardEvents();
    // 表头排序（三态循环）+ 树形折叠（模块级状态，重渲染保持）
    document.querySelectorAll('th[data-sortkey]').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.sortkey;
      if (listSort.key !== k) listSort = { key: k, dir: 'asc' };
      else if (listSort.dir === 'asc') listSort = { key: k, dir: 'desc' };
      else listSort = { key: null, dir: 'asc' };
      renderList();
    }));
    document.querySelectorAll('[data-collapse]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation(); // 不触发行点击（详情）
      const id = b.dataset.collapse;
      if (listCollapsed.has(id)) listCollapsed.delete(id); else listCollapsed.add(id);
      renderList();
    }));
  }

  function renderArchive() {
    const tasks = archivedTasks().slice().sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''));
    boardRoot.innerHTML = boardToolbar() + `<div class="kb-list-wrap"><table class="kb-list"><thead><tr><th>标题</th><th>归档时间</th><th>操作</th></tr></thead><tbody>${tasks.length === 0 ? '<tr><td colspan="3" class="kb-empty-row">归档区为空</td></tr>' : tasks.map((t) => `<tr data-id="${t.id}"><td>${esc(t.title)}</td><td>${t.archivedAt ? new Date(t.archivedAt).toLocaleString() : ''}</td><td><button class="kb-btn" data-restore="${t.id}">恢复</button><button class="kb-btn kb-danger" data-purge="${t.id}">彻底删除</button></td></tr>`).join('')}</tbody></table></div>`;
    bindBoardEvents();
  }

  // ═══════════════════════ T1 时间线视图（CON-R-timeline-001/Q-055） ═══════════════════════

  /** 时间戳解析：null/undefined/空串视为缺失（Date(null)=epoch 0 陷阱）；非法日期 → null（Q-055 兜底链判据） */
  function tsOf(v) {
    if (v === null || v === undefined || v === '') return null;
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }

  /**
   * 聚合当前看板活动条目（纯函数，D2）：task.createdAt→创建 / timeline comment·system createdAt→评论·系统 /
   * execution startedAt→finishedAt→task.updatedAt 兜底链（Q-055，兜底态标「时间未知」仍参与排序）；
   * 全缺/非法 → ts=null 固定末尾。排序：ts desc 主键 + id desc 同戳 tie（倒序后建在前，两次渲染一致）。
   */
  function buildTimelineEntries(tasks) {
    const entries = [];
    for (const t of tasks) {
      entries.push({ id: `${t.id}:create`, taskId: t.id, type: '创建', ts: tsOf(t.createdAt), unknown: false });
      for (const i of t.timeline || []) {
        if (i.type === 'comment' || i.type === 'system') {
          entries.push({ id: i.id, taskId: t.id, type: i.type === 'comment' ? '评论' : '系统', ts: tsOf(i.createdAt), item: i, unknown: false });
        } else if (i.type === 'execution') {
          const ex = i.execution || {};
          let ts = tsOf(ex.startedAt);
          let unknown = false;
          if (ts === null) ts = tsOf(ex.finishedAt);
          if (ts === null) { ts = tsOf(t.updatedAt); unknown = true; } // updatedAt 兜底：标未知仍参与排序
          entries.push({ id: i.id, taskId: t.id, type: '执行', ts, unknown, item: i });
        }
      }
    }
    const pinned = (e) => (e.ts === null ? 1 : 0);
    entries.sort((a, b) => pinned(a) - pinned(b) || b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return entries;
  }

  /** 时间线时间格式（2026-09-05 显示优化）：同年紧凑 MM/DD HH:mm，跨年回退完整 toLocaleString（信息不删减） */
  function fmtTs(ts) {
    const d = new Date(ts);
    return d.getFullYear() === new Date().getFullYear()
      ? d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString();
  }

  function renderTimeline() {
    const all = buildTimelineEntries(activeTasks()); // 归档排除（契约实现补充约定）
    const shown = all.slice(0, timelinePage * TIMELINE_PAGE_SIZE); // D5 按需渲染：首屏封顶分页大小
    const typeCls = { 创建: 'kb-tlb-create', 执行: 'kb-tlb-exec', 评论: 'kb-tlb-comment', 系统: 'kb-tlb-system' };
    boardRoot.innerHTML = boardToolbar() + `<div class="kb-timeline">${
      all.length === 0
        ? '<div class="kb-empty-tlv">暂无活动，创建任务后这里会显示时间线</div>'
        : shown.map((e) => {
            const task = taskById(e.taskId);
            const time = e.ts !== null ? fmtTs(e.ts) : '';
            const badge = `<span class="kb-tlb ${typeCls[e.type]}">${e.type}</span>${e.unknown ? '<span class="kb-tl-unknown">时间未知</span>' : ''}`;
            // 消毒（T1 契约 §6/D6）：评论 content 走 E1 同管线 mdRender；execution/system/结构化字段 esc()
            let body = '';
            if (e.type === '评论') body = `<div class="kb-tl-md kb-md">${mdRender(e.item.content)}</div>`;
            else if (e.type === '执行') {
              // 2026-09-05 显示优化：原样展示 command（恒为 `execute t_x` 无信息量）→ 改可读摘要（状态 · 退出码）
              const ex = e.item.execution || {};
              const bits = [execNames[ex.status] || ex.status || '—'];
              if (ex.exitCode !== null && ex.exitCode !== undefined) bits.push(`退出码 ${ex.exitCode}`);
              body = `<div class="kb-tl-cmd">${esc(bits.join(' · '))}</div>`;
            } else body = `<div class="kb-tl-cmd">${esc(e.item?.content || '')}</div>`;
            return `<div class="kb-tl-row" data-task="${e.taskId}"><span class="kb-tl-time">${esc(time)}</span>${badge}<span class="kb-tl-title">${esc(task?.title || '')}</span>${body}</div>`;
          }).join('')}${all.length > shown.length ? '<button class="kb-btn" id="kb-tl-more">加载更多</button>' : ''}</div>`;
    bindBoardEvents();
    $('#kb-tl-more')?.addEventListener('click', () => { timelinePage++; renderTimeline(); }); // PERF4：slice 追加语义不重不漏
    document.querySelectorAll('.kb-tl-row').forEach((r) => r.addEventListener('click', () => openDetail(r.dataset.task)));
  }

  // ═══════════════════════ 会话视图（2026-09-05：壳内分组空间） ═══════════════════════
  // 背景：dsh web 无法给 ACP/壳创建的会话归组（协议刻意排除 workspace 注册；壳红线 CON-R002 不写 DSH_HOME）
  // → 壳内看板建「会话」视图按票分组列出执行会话，成为壳自己的分组空间。

  /** 模型短名：agentSpec.model 为 set_config_option value JSON 串（如 ["provider","model"]）→ provider/model；无 → 「默认」 */
  function modelShortName(t) {
    const raw = t.agentSpec?.model;
    if (!raw) return '默认';
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return `${arr[0]}/${arr[1] ?? arr[0]}`;
    } catch { /* 非 JSON 串 → 原样展示 */ }
    return String(raw);
  }

  /** 最近执行时间：timeline 最后 execution 事件 createdAt（无 → null） */
  function lastExecAt(t) {
    const execs = (t.timeline || []).filter((i) => i.type === 'execution');
    return execs.length ? execs[execs.length - 1].createdAt : null;
  }

  /** 会话票集合：有 acpSessionId 或有过执行记录；按最近执行时间倒序 */
  function sessionTasks() {
    return activeTasks()
      .filter((t) => t.acpSessionId || (t.timeline || []).some((i) => i.type === 'execution'))
      .slice()
      .sort((a, b) => (lastExecAt(b) || '').localeCompare(lastExecAt(a) || ''));
  }

  // ── 会话视图筛选状态（需求 1，模块级持久——视图切换不重置）──
  let sessFilterQ = '';
  let sessFilterStatus = 'all'; // all | succeeded | failed | running（running 含 queued/paused）
  let sessFilterModel = 'all'; // all | provider 短名（当前会话列表动态聚合）

  /** 会话筛选（需求 1）：关键词（票标题/会话 ID/工作目录 包含）+ 执行状态 + 模型 provider */
  function sessionFilterMatch(t) {
    if (sessFilterQ) {
      const hay = `${t.title} ${t.acpSessionId || ''} ${t.agentSpec?.cwd || currentBoard?.defaultCwd || ''}`.toLowerCase();
      if (!hay.includes(sessFilterQ.toLowerCase())) return false;
    }
    if (sessFilterStatus === 'succeeded' && t.executionStatus !== 'succeeded') return false;
    if (sessFilterStatus === 'failed' && t.executionStatus !== 'failed') return false;
    if (sessFilterStatus === 'running' && !['running', 'queued', 'paused'].includes(t.executionStatus)) return false;
    if (sessFilterModel !== 'all' && modelShortName(t).split('/')[0] !== sessFilterModel) return false;
    return true;
  }

  function renderSessions() {
    const all = sessionTasks();
    // 模型下拉选项 = 当前会话列表 provider 集合动态聚合（全量集合，不随筛选收缩）
    const providers = [...new Set(all.map((t) => modelShortName(t).split('/')[0]))].sort();
    const statusNames = { all: '全部状态', succeeded: '成功', failed: '失败', running: '进行中' };
    const rows = all.filter((t) => sessionFilterMatch(t)).map((t) => {
      const col = colById(t.columnId);
      const sid = t.acpSessionId || '';
      const execAt = lastExecAt(t);
      return `<tr data-id="${t.id}"><td>${esc(t.title)}</td><td>${col ? `<span class="kb-col-chip" style="border-color:${col.color}">${esc(col.name)}</span>` : ''}</td><td><span class="kb-exec kb-exec-${t.executionStatus}">${execNames[t.executionStatus] || t.executionStatus}</span></td><td>${sid ? `<span class="kb-sid" title="${esc(sid)}">${esc(sid.slice(0, 8))}…</span>` : '<span class="kb-muted">—</span>'}</td><td>${esc(modelShortName(t))}</td><td>${esc(t.agentSpec?.cwd || currentBoard?.defaultCwd || '~')}</td><td>${execAt ? esc(new Date(execAt).toLocaleString()) : '—'}</td><td class="kb-sess-ops">${sid ? `<button class="kb-btn" data-copysid="${esc(sid)}">复制会话ID</button>` : ''}<button class="kb-btn" data-viewlog="${t.id}">查看输出</button><button class="kb-btn" data-openweb>在 web 打开</button></td></tr>`;
    }).join('');
    const filterBar = `<div class="kb-sess-filters">
      <input id="kb-sess-q" class="kb-input" placeholder="搜索标题 / 会话 ID / 工作目录…" value="${esc(sessFilterQ)}" />
      <select id="kb-sess-status" class="kb-input">${Object.entries(statusNames).map(([k, n]) => `<option value="${k}" ${sessFilterStatus === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <select id="kb-sess-model" class="kb-input"><option value="all" ${sessFilterModel === 'all' ? 'selected' : ''}>全部模型</option>${providers.map((p) => `<option value="${esc(p)}" ${sessFilterModel === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
    </div>`;
    boardRoot.innerHTML = boardToolbar() + filterBar + `<div class="kb-list-wrap"><table class="kb-list kb-sessions"><thead><tr><th>票</th><th>列</th><th>执行态</th><th>会话 ID</th><th>模型</th><th>工作目录</th><th>最近执行</th><th>操作</th></tr></thead><tbody id="kb-sess-rows">${all.length === 0 ? '<tr><td colspan="8" class="kb-empty-row">暂无执行会话</td></tr>' : (rows || '<tr><td colspan="8" class="kb-empty-row">筛选无结果</td></tr>')}</tbody></table></div>`;
    bindBoardEvents();
    // 筛选绑定：搜索/状态/模型变更 → 仅重渲染 tbody（输入框焦点不丢；筛选状态模块级持久）
    $('#kb-sess-q')?.addEventListener('input', (e) => { sessFilterQ = e.target.value.trim(); renderSessionRows(all); });
    $('#kb-sess-status')?.addEventListener('change', (e) => { sessFilterStatus = e.target.value; renderSessionRows(all); });
    $('#kb-sess-model')?.addEventListener('change', (e) => { sessFilterModel = e.target.value; renderSessionRows(all); });
    // 会话行操作绑定（bindBoardEvents 已给行挂详情点击；按钮 stopPropagation 防重复弹详情）
    document.querySelectorAll('[data-viewlog]').forEach(bindSessionViewLog);
    document.querySelectorAll('[data-copysid]').forEach(bindSessionCopySid);
    document.querySelectorAll('[data-openweb]').forEach(bindSessionOpenWeb);
  }

  /** 会话列表行重渲染（筛选时仅替换 tbody，筛选栏/输入焦点保留） */
  function renderSessionRows(all) {
    const tbody = $('#kb-sess-rows');
    if (!tbody) return;
    const rows = all.filter(sessionFilterMatch).map((t) => {
      const col = colById(t.columnId);
      const sid = t.acpSessionId || '';
      const execAt = lastExecAt(t);
      return `<tr data-id="${t.id}"><td>${esc(t.title)}</td><td>${col ? `<span class="kb-col-chip" style="border-color:${col.color}">${esc(col.name)}</span>` : ''}</td><td><span class="kb-exec kb-exec-${t.executionStatus}">${execNames[t.executionStatus] || t.executionStatus}</span></td><td>${sid ? `<span class="kb-sid" title="${esc(sid)}">${esc(sid.slice(0, 8))}…</span>` : '<span class="kb-muted">—</span>'}</td><td>${esc(modelShortName(t))}</td><td>${esc(t.agentSpec?.cwd || currentBoard?.defaultCwd || '~')}</td><td>${execAt ? esc(new Date(execAt).toLocaleString()) : '—'}</td><td class="kb-sess-ops">${sid ? `<button class="kb-btn" data-copysid="${esc(sid)}">复制会话ID</button>` : ''}<button class="kb-btn" data-viewlog="${t.id}">查看输出</button><button class="kb-btn" data-openweb>在 web 打开</button></td></tr>`;
    }).join('');
    tbody.innerHTML = rows || '<tr><td colspan="8" class="kb-empty-row">筛选无结果</td></tr>';
    // 行操作重绑（行按钮/详情点击随 tbody 重建）
    tbody.querySelectorAll('[data-viewlog]').forEach(bindSessionViewLog);
    tbody.querySelectorAll('[data-copysid]').forEach(bindSessionCopySid);
    tbody.querySelectorAll('[data-openweb]').forEach(bindSessionOpenWeb);
  }

  /** 「查看输出」单按钮绑定（renderSessions 与筛选重渲染共用） */
  function bindSessionViewLog(b) {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = b.dataset.viewlog;
      const r = await kanban.getExecutionLog?.(currentBoard.id, taskId);
      const text = r && r.ok ? r.data : null;
      const task = taskById(taskId);
      modal(`执行输出 · ${task ? task.title : ''}`, `<pre class="kb-exec-log-pre kb-exec-log-full">${text ? linkifyExecLog(text, task) : '暂无执行输出'}</pre>`, (w) => {
        // 路径点击委托（与详情弹框执行输出区块同款；block 监听体系不适用——此处独立弹框）
        w.addEventListener('click', (ev) => {
          const p = ev.target.closest('[data-openpath]');
          if (!p) return;
          ev.preventDefault();
          Promise.resolve(window.hull?.openPath?.(p.dataset.openpath))
            .then((rr) => { if (rr && !rr.ok) alert('打开失败：' + (rr.message || '未知错误')); })
            .catch(() => alert('打开失败：桥不可用'));
        });
      });
    });
  }

  /** 「复制会话ID」单按钮绑定（共用） */
  function bindSessionCopySid(b) {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(b.dataset.copysid); } catch { alert('复制失败：剪贴板不可用'); }
    });
  }

  /** 「在 web 打开」（2026-09-05 需求 1）：hull.showWeb 切 dsh web 视图（无会话深链 → 落列表用户自选） */
  function bindSessionOpenWeb(b) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      try { window.hull?.showWeb?.(); } catch { alert('打开 dsh web 失败'); }
    });
  }


  // ═══════════════════════ T1 日历视图（CON-R-timeline-002/Q-054） ═══════════════════════

  /** date-only 解析：本地时区构造 new Date(y,m,d)（禁字符串直传 Date 的 UTC 偏移西移）；非法/不存在日期 → null */
  function parseDateOnly(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) || dt.getMonth() !== m - 1 || dt.getDate() !== d ? null : dt;
  }
  const fmtKey = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const addDays = (dt, n) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + n);

  /** 可见格序列：月=当月 6×7（周一起始含前后月补位）；周=光标所在周 7 格 */
  function calCells() {
    if (calMode === 'week') {
      const dow = (calCursor.getDay() + 6) % 7; // 周一=0
      const start = addDays(calCursor, -dow);
      return Array.from({ length: 7 }, (_, i) => addDays(start, i));
    }
    const first = new Date(calCursor.getFullYear(), calCursor.getMonth(), 1);
    const dow = (first.getDay() + 6) % 7;
    const start = addDays(first, -dow);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }

  /** 区间条带按日遍历（Q-054 冻结）：每任务算 [start,end] 与可见范围求交逐日落桶；跨月/跨周边界自然连续 */
  function calBands(tasks, cells) {
    const visStart = cells[0];
    const visEnd = cells[cells.length - 1];
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const byDay = new Map();
    for (const t of tasks) {
      let start = parseDateOnly(t.startDate);
      let end = parseDateOnly(t.dueDate);
      if (!start && !end) continue; // 皆空不进日历
      if (start && end && start > end) start = end; // startDate>dueDate → 以 dueDate 单日（CON-R-timeline-007）
      if (!end) end = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 0); // 仅 startDate → 当月末尾
      if (!start) start = end; // 仅 dueDate 单日落格
      let cur = start < visStart ? visStart : start;
      const stop = end > visEnd ? visEnd : end;
      const overdue = parseDateOnly(t.dueDate) !== null && parseDateOnly(t.dueDate) < today0; // 过期以 dueDate 判定
      while (cur <= stop) {
        const k = fmtKey(cur);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push({ task: t, overdue });
        cur = addDays(cur, 1);
      }
    }
    return byDay;
  }

  function renderCalendar() {
    const cells = calCells();
    const bands = calBands(activeTasks(), cells);
    const title = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(calCursor); // 中文月标签（Q-054）
    const label = calMode === 'month' ? title : `${title} · 周`;
    const wd = ['一', '二', '三', '四', '五', '六', '日'];
    const todayKey = fmtKey(new Date());
    const grid = cells.map((c) => {
      const k = fmtKey(c);
      const items = (bands.get(k) || []).map(({ task, overdue }) =>
        `<div class="kb-cal-task ${overdue ? 'kb-overdue' : ''}" data-task="${task.id}">${esc(task.title)}</div>`).join('');
      return `<div class="kb-cal-cell ${c.getMonth() !== calCursor.getMonth() ? 'kb-cal-out' : ''} ${k === todayKey ? 'kb-cal-today' : ''}" data-date="${k}"><span class="kb-cal-day">${c.getDate()}</span>${items}</div>`;
    }).join('');
    boardRoot.innerHTML = boardToolbar() + `
      <div class="kb-cal-bar">
        <button class="kb-btn" data-cal="prev">‹</button>
        <button class="kb-btn" data-cal="today">今天</button>
        <button class="kb-btn" data-cal="next">›</button>
        <span class="kb-cal-title">${esc(label)}</span>
        <span class="kb-cal-modes"><button class="kb-view ${calMode === 'month' ? 'active' : ''}" data-calmode="month">月</button><button class="kb-view ${calMode === 'week' ? 'active' : ''}" data-calmode="week">周</button></span>
      </div>
      ${bands.size === 0 ? '<div class="kb-empty-tlv">本月无到期任务</div>' : ''}
      <div class="kb-cal-grid kb-cal-${calMode}">${wd.map((w) => `<div class="kb-cal-wd">${w}</div>`).join('')}${grid}</div>`;
    bindBoardEvents();
    document.querySelectorAll('[data-cal]').forEach((b) => b.addEventListener('click', () => {
      const act = b.dataset.cal;
      if (act === 'today') calCursor = new Date();
      else if (calMode === 'month') calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + (act === 'next' ? 1 : -1), 1);
      else calCursor = addDays(calCursor, act === 'next' ? 7 : -7);
      renderCalendar();
    }));
    document.querySelectorAll('[data-calmode]').forEach((b) => b.addEventListener('click', () => { calMode = b.dataset.calmode; renderCalendar(); }));
    document.querySelectorAll('.kb-cal-task').forEach((el) => el.addEventListener('click', () => openDetail(el.dataset.task)));
  }

  // ── 事件绑定 ──
  /** 单卡片事件绑定（bindBoardEvents 与执行事件定向更新共用：新建/替换的卡片元素需重绑） */
  function bindCardEvents(el) {
    // 拖拽（CON-R020 人工拖拽最高优先级）
    el.addEventListener('dragstart', (e) => { dragTaskId = el.dataset.id; e.dataTransfer.effectAllowed = 'move'; el.classList.add('kb-dragging'); });
    el.addEventListener('dragend', () => { dragTaskId = null; el.classList.remove('kb-dragging'); });
    // 卡片主体点击 → 弹详情（操作按钮区不弹）
    el.addEventListener('click', (e) => { if (e.target.closest('.kb-card-ops')) return; openDetail(el.dataset.id); });
    el.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', async () => { const r = await exec.executeTask(currentBoard.id, b.dataset.run); if (!r.ok) alert('执行失败：' + (r.message || r.code)); }));
    el.querySelectorAll('[data-pause]').forEach((b) => b.addEventListener('click', async () => { const r = await exec.pauseExecution(currentBoard.id, b.dataset.pause); if (!r.ok) alert('暂停失败：' + (r.message || r.code)); }));
    el.querySelectorAll('[data-resume]').forEach((b) => b.addEventListener('click', async () => { const r = await exec.resumeExecution(currentBoard.id, b.dataset.resume); if (!r.ok) alert('恢复失败：' + (r.message || r.code)); }));
    el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => { const r = await exec.cancelExecution(currentBoard.id, b.dataset.cancel); if (!r.ok) alert('取消失败：' + (r.message || r.code)); }));
    el.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', async () => { const r = await exec.confirmVerify(currentBoard.id, b.dataset.verify); if (r.ok) await loadBoard(currentBoard.id); else alert('确认失败：' + (r.message || r.code)); }));
    el.querySelectorAll('[data-detail]').forEach((b) => b.addEventListener('click', () => openDetail(b.dataset.detail)));
  }

  /** 列体重建（需求 1 定向更新）：仅替换指定列卡片容器（全板 DOM/弹框/焦点不动）；列不可见 → 跳过（内存已同步） */
  function renderColumnBody(colId) {
    const colEl = boardRoot.querySelector(`.kb-col[data-col="${colId}"] .kb-col-body`);
    if (!colEl) return;
    const tasks = activeTasks().filter((t) => t.columnId === colId && matchesFilter(t));
    colEl.innerHTML = tasks.length === 0 ? '<div class="kb-empty-col">空列</div>' : tasks.map(cardHtml).join('');
    colEl.querySelectorAll('.kb-card[data-id]').forEach(bindCardEvents);
  }

  /** 执行事件定向更新落 DOM（需求 1）：状态变 → 卡片原地替换；列变 → 旧列移除+双列体重建；列头计数刷新 */
  function applyTaskToDom(task, fromColumnId) {
    if (view !== 'board') return; // 非看板视图：内存已同步，render() 时自然呈现
    const oldEl = boardRoot.querySelector(`.kb-card[data-id="${task.id}"]`);
    if (fromColumnId) {
      oldEl?.remove();
      renderColumnBody(fromColumnId);
      renderColumnBody(task.columnId);
    } else if (oldEl) {
      const tmp = document.createElement('div');
      tmp.innerHTML = cardHtml(task);
      const newEl = tmp.firstElementChild;
      if (newEl) { oldEl.replaceWith(newEl); bindCardEvents(newEl); }
    }
    // 列头计数刷新（受影响列；与 renderBoard 同口径 = 匹配筛选的活动任务数）
    for (const colId of fromColumnId ? [fromColumnId, task.columnId] : [task.columnId]) {
      const cnt = boardRoot.querySelector(`.kb-col[data-col="${colId}"] .kb-col-count`);
      if (cnt) cnt.textContent = String(activeTasks().filter((t) => t.columnId === colId && matchesFilter(t)).length);
    }
    updateDetailForTask(task);
  }

  /** 详情弹框原地刷新（需求 1③）：状态徽标 + 时间线重建 + 执行输出区块；弹框不重建（评论编辑器焦点保留） */
  function updateDetailForTask(task) {
    const w = openDetailWrap;
    if (!w || !w.isConnected || openDetailTaskId !== task.id) return;
    const badge = w.querySelector('.kb-detail-meta .kb-exec');
    if (badge) {
      badge.className = `kb-exec kb-exec-${task.executionStatus}`;
      badge.textContent = execNames[task.executionStatus] || task.executionStatus;
    }
    const tlEl = w.querySelector('.kb-tl');
    if (tlEl) {
      const tmp = document.createElement('div');
      tmp.innerHTML = timelineHtml(task); // 评论编辑按钮随重建出现；编辑委托挂在 w 上，重建后仍生效
      tlEl.replaceWith(tmp.firstElementChild);
    }
    linkifyTimeline(w, task); // 需求 2：comment 内容路径链接化（重建后重跑，task 提供相对路径 cwd 上下文）
    loadExecLogBlock(w, task.id);
  }

  /** 详情弹框时间线 HTML（openDetail 与定向更新共用；需求 2：user 来源 comment 带编辑按钮） */
  function timelineHtml(t) {
    const tl = (t.timeline || []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return `<div class="kb-tl"><h4>时间线</h4>${tl.length === 0 ? '<div class="kb-empty-tl">暂无记录</div>' : tl.map((i) => {
      const who = i.author || (i.source.type === 'agent' ? 'agent' : i.source.type);
      const execTag = i.execution ? `<span class="kb-exec kb-exec-${i.execution.status}">${execNames[i.execution.status] || i.execution.status}${i.execution.exitCode !== null ? ` (${i.execution.exitCode})` : ''}</span>` : '';
      // E1/FE-2：comment 条目走 Markdown 管线（DOMPurify 消毒）；execution/system 条目维持 esc 纯文本
      const contentHtml = i.type === 'comment' ? mdRender(i.content) : esc(i.content);
      // 需求 2（2026-09-05）：仅 user 来源 comment 可编辑（与 store lane 守卫同源；agent 执行结果不可编辑）
      const editBtn = i.type === 'comment' && i.source?.type === 'user' ? `<button class="kb-cmt-edit" data-editcmt="${esc(i.id)}" title="编辑评论">编辑</button>` : '';
      return `<div class="kb-tl-item" data-cmtid="${esc(i.id)}"><span class="kb-tl-who">${esc(who)}</span><span class="kb-tl-time">${new Date(i.createdAt).toLocaleString()}</span>${execTag}${editBtn}<div class="kb-tl-content kb-md">${contentHtml}</div></div>`;
    }).join('')}</div>`;
  }

  /** 需求 2（2026-09-05）+ 相对路径扩展（2026-09-05）：路径扫描正则源（每次调用 new RegExp 隔离 /g 状态）。
   *  组1=绝对（/ 或 ~/ 开头）；组2=相对（至少一级目录 + 扩展名，./ ../ 前缀天然在 [\w.@-] 内） */
  const PATH_SCAN_SRC = '([~/][\\w.@/-]{5,})|([\\w.@-]+(?:\\/[\\w.@-]+)+\\.\\w+)';

  /** 相对路径解析（resolve 语义手动 normalize）：base + rel 逐段处理，`..` 弹栈、空栈即逃逸 → null（不链接） */
  function resolveRelCwd(rel, base) {
    const out = [];
    for (const s of (base + '/' + rel).split('/')) {
      if (!s || s === '.') continue;
      if (s === '..') { if (!out.length) return null; out.pop(); continue; }
      out.push(s);
    }
    return out.length ? '/' + out.join('/') : null;
  }

  /** 单次路径命中 → data-openpath 目标：绝对原样；相对解析 task.agentSpec.cwd → board.defaultCwd，无 base/逃逸 → null（不链接） */
  function pathTargetFor(matched, isAbs, task) {
    const raw = matched.replace(/[.,;:)\]]+$/, ''); // 去句尾 ASCII 标点（中文标点不在字符类内天然不吞）
    if (raw.length < 6) return null; // 过短非路径（去尾标点后复核）
    if (isAbs) return raw;
    const base = task?.agentSpec?.cwd || currentBoard?.defaultCwd || null;
    return base ? resolveRelCwd(raw, base) : null;
  }

  /** 路径命中守卫：前字符为 :（URL 协议后）或 \w/.（词内段 + ../ 起点）→ 非独立路径，跳过 */
  function pathBoundaryOk(text, index) {
    const prev = index > 0 ? text[index - 1] : '';
    return !(prev === ':' || prev === '/' || /[\w.]/.test(prev));
  }

  /** 需求 2（2026-09-05）：执行输出路径链接化——esc 前原文分段匹配（命中段 esc 进属性与文案，其余 esc） */
  function linkifyExecLog(text, task) {
    const re = new RegExp(PATH_SCAN_SRC, 'g');
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!pathBoundaryOk(text, m.index)) continue;
      const target = pathTargetFor(m[0], Boolean(m[1]), task);
      if (!target) continue;
      out += esc(text.slice(last, m.index)) + `<a href="#" class="kb-openpath" data-openpath="${esc(target)}">${esc(m[0])}</a>`;
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  /** 需求 2（2026-09-05）：文本节点路径链接化（DOM 后处理）——锚点经 DOM API（createElement+textContent）
   *  创建，零注入面；绝对/相对判据同 linkifyExecLog（共享 PATH_SCAN_SRC + pathTargetFor，task 上下文解析 cwd） */
  function linkifyPaths(el, task) {
    if (!el) return;
    const re = new RegExp(PATH_SCAN_SRC, 'g');
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.textContent;
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        if (!pathBoundaryOk(text, m.index)) continue;
        const target = pathTargetFor(m[0], Boolean(m[1]), task);
        if (!target) continue;
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'kb-openpath';
        a.dataset.openpath = target;
        a.textContent = m[0];
        frag.appendChild(a);
        last = m.index + m[0].length;
      }
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.replaceWith(frag);
    }
  }

  /** 需求 2：时间线 comment（mdRender 后 DOM）路径链接化——openDetail 与定向更新共用 */
  function linkifyTimeline(w, task) {
    w?.querySelectorAll('.kb-tl-content').forEach((el) => linkifyPaths(el, task));
  }

  /** 执行输出区块加载（openDetail 与定向更新共用）：插在时间线之前；无日志/桥缺失 → 不出现 */
  async function loadExecLogBlock(w, taskId) {
    try {
      const r = await kanban.getExecutionLog?.(currentBoard.id, taskId);
      const text = r && r.ok ? r.data : null;
      const tlEl = $('.kb-tl', w);
      if (!text || !String(text).trim() || !tlEl || !tlEl.isConnected) return;
      let block = $('.kb-exec-log', w);
      if (!block) {
        block = document.createElement('div');
        block.className = 'kb-exec-log';
        // 需求 2（2026-09-05）：展开/收起按钮 + 文件路径点击——监听挂 block（innerHTML 重置不移除自身监听，重建后仍有效）
        block.addEventListener('click', (e) => {
          const p = e.target.closest('[data-openpath]');
          if (p) {
            e.preventDefault(); // href="#" 不跳转
            const path = p.dataset.openpath;
            Promise.resolve(window.hull?.openPath?.(path))
              .then((r) => { if (r && !r.ok) alert('打开失败：' + (r.message || '未知错误')); })
              .catch(() => alert('打开失败：桥不可用'));
            return;
          }
          const btn = e.target.closest('[data-logtoggle]');
          if (!btn) return;
          const pre = $('.kb-exec-log-pre', block);
          if (!pre) return;
          const on = pre.classList.toggle('expanded');
          btn.textContent = on ? '收起' : '展开';
        });
        tlEl.parentNode.insertBefore(block, tlEl);
      }
      block.innerHTML = '<h4>执行输出<button class="kb-exec-log-toggle" data-logtoggle>展开</button></h4><pre class="kb-exec-log-pre">' + linkifyExecLog(text, taskById(taskId)) + '</pre>';
    } catch { /* 通道缺失/读取失败：区块隐藏 */ }
  }

  /** 评论内联编辑（需求 2）：内容区 → textarea + 保存/取消；成功原地更新 + 内存任务同步（契约返回更新后任务） */
  function startCommentEdit(w, taskId, commentId) {
    const item = w.querySelector(`.kb-tl-item[data-cmtid="${commentId}"]`);
    const cmt = taskById(taskId)?.timeline?.find((x) => x.id === commentId);
    if (!item || !cmt || cmt.source?.type !== 'user') return; // 守卫同渲染侧（双保险）
    const contentEl = $('.kb-tl-content', item);
    if (!contentEl || contentEl.querySelector('textarea')) return; // 已在编辑
    const original = cmt.content;
    contentEl.innerHTML = `<textarea class="kb-input kb-cmt-ta">${esc(original)}</textarea><div class="kb-cmt-ops"><button class="kb-btn kb-primary" data-savecmt>保存</button><button class="kb-btn" data-cancelcmt>取消</button></div>`;
    const ta = $('textarea', contentEl);
    ta.focus();
    $('[data-cancelcmt]', contentEl).addEventListener('click', () => { contentEl.innerHTML = mdRender(original); });
    $('[data-savecmt]', contentEl).addEventListener('click', async () => {
      const content = ta.value.trim();
      if (!content || content === original) { contentEl.innerHTML = mdRender(original); return; }
      const r = await kanban.updateComment?.(currentBoard.id, taskId, commentId, content);
      if (!r || !r.ok) { alert('评论保存失败：' + ((r && r.message) || '通道不可用')); return; }
      // 内存同步：契约返回更新后任务 → 整体替换；否则直接改本地 timeline 条目（下次渲染一致）
      const updated = r.data && r.data.id ? r.data : null;
      if (updated) {
        const idx = currentBoard.tasks.findIndex((x) => x.id === taskId);
        if (idx >= 0) currentBoard.tasks[idx] = updated;
      } else {
        const it = taskById(taskId)?.timeline?.find((x) => x.id === commentId);
        if (it) it.content = content;
      }
      contentEl.innerHTML = mdRender(updated?.timeline?.find((x) => x.id === commentId)?.content ?? content);
    });
  }

  function bindBoardEvents() {
    $('#kb-board-select')?.addEventListener('change', (e) => loadBoard(e.target.value));
    $('#kb-newboard')?.addEventListener('click', promptNewBoard);
    document.querySelectorAll('.kb-view').forEach((b) => b.addEventListener('click', (e) => { view = e.target.dataset.view; saveLastView(view); timelinePage = 1; render(); }));
    $('#kb-col-filter')?.addEventListener('change', (e) => { filterCol = e.target.value; render(); });
    $('#kb-q')?.addEventListener('input', (e) => { filterQ = e.target.value; render(); });

    // 看板默认模型（BUG 修复 2026-09-05：原误调不存在的 window.exec.setBoardDefaultModel 桥 → optional
    // chaining 静默吞掉，选择永不保存。对齐 #kb-board-cwd 的 updateBoard 保存模式：成功本地同步、失败 alert）
    const bmSel = $('#kb-board-model');
    if (bmSel) {
      bmSel.addEventListener('change', async (e) => {
        const v = e.target.value || null;
        if (v === (currentBoard?.defaultModel || null)) return;
        try {
          const r = await window.kanban?.updateBoard?.(currentBoard.id, { defaultModel: v });
          if (!r || !r.ok) { alert('保存看板默认模型失败：' + ((r && r.message) || '通道不可用')); return; }
          currentBoard = { ...currentBoard, defaultModel: v };
        } catch { alert('保存看板默认模型失败：通道不可用'); }
      });
      fillModelSelectWithRetry(() => bmSel, currentBoard?.defaultModel, '默认（dsh 默认）', null);
    }
    // 看板默认工作目录：失焦或回车提交（空值传 null 清除；通道 kanban:updateBoard，defaultCwd patch 由执行链 lane 支持）
    const bcwd = $('#kb-board-cwd');
    if (bcwd) {
      const saveCwd = async () => {
        const v = bcwd.value.trim() || null;
        if (v === (currentBoard?.defaultCwd || null)) return;
        const r = await kanban.updateBoard(currentBoard.id, { defaultCwd: v });
        if (!r.ok) alert('保存看板工作目录失败：' + (r.message || r.code));
        else currentBoard = { ...currentBoard, defaultCwd: v };
      };
      bcwd.addEventListener('change', saveCwd);
      bcwd.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveCwd(); } });
      $('#kb-board-cwd-browse')?.addEventListener('click', async () => {
        const p = await pickDirectory();
        if (p) { bcwd.value = p; await saveCwd(); } // 选完即走工具栏保存链路（本地去重 + currentBoard 同步在 saveCwd 内）
      });
    }
    // 看板默认推理力度：change 提交（空值传 null 清除；通道 kanban:updateBoard，defaultReasoningEffort patch 由执行链 lane 支持）
    const beSel = $('#kb-board-effort');
    if (beSel) {
      beSel.addEventListener('change', async (e) => {
        const v = e.target.value || null;
        if (v === (currentBoard?.defaultReasoningEffort || null)) return;
        try {
          const r = await window.kanban?.updateBoard?.(currentBoard.id, { defaultReasoningEffort: v });
          if (!r || !r.ok) { alert('保存看板默认推理力度失败：' + ((r && r.message) || '通道不可用')); return; }
          currentBoard = { ...currentBoard, defaultReasoningEffort: v };
        } catch { alert('保存看板默认推理力度失败：通道不可用'); }
      });
    }

    // 拖拽（CON-R020 人工拖拽最高优先级）——dragstart/dragend 绑定并入 bindCardEvents（定向更新共用）
    // 列拖拽换序（列头拖动；dragColId 仅列头 dragstart 设置，卡片拖拽不干扰）
    let dragColId = null;
    document.querySelectorAll('.kb-col-head').forEach((head) => {
      head.addEventListener('dragstart', (e) => {
        dragColId = head.closest('.kb-col')?.dataset.col || null;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragColId || '');
        head.closest('.kb-col')?.classList.add('kb-col-dragging');
      });
      head.addEventListener('dragend', () => {
        dragColId = null;
        document.querySelectorAll('.kb-col').forEach((el) => el.classList.remove('kb-col-dragging', 'kb-col-drop-hint'));
      });
      head.addEventListener('dragover', (e) => {
        if (!dragColId) return; // 卡片拖拽不进入列换序逻辑
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        head.closest('.kb-col')?.classList.add('kb-col-drop-hint');
      });
      head.addEventListener('dragleave', () => head.closest('.kb-col')?.classList.remove('kb-col-drop-hint'));
      head.addEventListener('drop', (e) => {
        const targetId = head.closest('.kb-col')?.dataset.col;
        document.querySelectorAll('.kb-col').forEach((el) => el.classList.remove('kb-col-drop-hint'));
        if (!dragColId || !targetId) return;
        e.preventDefault();
        e.stopPropagation(); // 不触发列体的卡片放置
        const id = dragColId;
        dragColId = null;
        reorderColumn(id, targetId);
      });
    });

    document.querySelectorAll('.kb-col').forEach((col) => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('kb-drop-target'); });
      col.addEventListener('dragleave', () => col.classList.remove('kb-drop-target'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault(); col.classList.remove('kb-drop-target');
        if (!dragTaskId || !currentBoard) return;
        const toCol = col.dataset.col;
        const task = taskById(dragTaskId);
        if (!task || task.columnId === toCol) return;
        const dst = colById(toCol);
        const conflicts = (dst?.type === 'done' && task.executionStatus !== 'succeeded') || (dst?.type === 'verify' && !['succeeded', 'idle'].includes(task.executionStatus));
        if (conflicts && !confirm(`任务「${task.title}」拖到「${dst?.name}」列（执行态 ${execNames[task.executionStatus]}），确认强制通过？`)) return;
        const r = await kanban.moveTask(currentBoard.id, dragTaskId, toCol);
        if (r.ok) { dragTaskId = null; await loadBoard(currentBoard.id); } else alert('移动失败：' + (r.message || r.code));
      });
    });

    // 列拖拽换序：有序数组内 splice → 全列重赋 order（变更列批量持久化）
    async function reorderColumn(dragId, targetId) {
      if (!currentBoard || dragId === targetId) return;
      const ordered = orderedCols();
      const from = ordered.findIndex((c) => c.id === dragId);
      const to = ordered.findIndex((c) => c.id === targetId);
      if (from === -1 || to === -1) return;
      const next = ordered.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      const updates = next
        .map((c, i) => ({ id: c.id, order: i }))
        .filter((u, i) => next[i].order !== i);
      const rs = await Promise.all(updates.map((u) => kanban.updateColumn(currentBoard.id, u.id, { order: u.order })));
      if (rs.every((r) => r.ok)) await loadBoard(currentBoard.id);
      else alert('列排序失败：' + (rs.find((r) => !r.ok)?.message || ''));
    }

    // 卡片操作（bindCardEvents 单卡片绑定：bindBoardEvents 与定向更新新建/替换卡片共用）
    document.querySelectorAll('.kb-card[data-id]').forEach(bindCardEvents);
    // V2a 通知中心「查看任务」跳转：系统通知/中心行 → 看板视图 + 打开任务详情
    window.__kanbanOpenTask = (taskId) => { try { openDetail(taskId); } catch { /* 数据不存在等，忽略 */ } };
    // 点击卡片主体 → 弹详情（操作按钮区 stopPropagation 已挡；拖拽不触发 click）——点击绑定并入 bindCardEvents
    // 列表视图行点击 → 弹详情（排除操作按钮）
    document.querySelectorAll('.kb-list tbody tr[data-id]').forEach((r) => r.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openDetail(r.dataset.id);
    }));
    document.querySelectorAll('.kb-add-card').forEach((b) => b.addEventListener('click', () => promptNewTask(b.dataset.col)));
    document.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => { const r = await kanban.restoreTask(currentBoard.id, b.dataset.restore); if (r.ok) await loadBoard(currentBoard.id); else alert('恢复失败：' + (r.message || r.code)); }));
    document.querySelectorAll('[data-purge]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('彻底删除该任务及其评论/附件，不可恢复。确认？')) return;
      const r = await kanban.purgeTask(currentBoard.id, b.dataset.purge);
      if (r.ok) await loadBoard(currentBoard.id); else alert('删除失败：' + (r.message || r.code));
    }));
    document.querySelectorAll('[data-act="col-mgr"]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openColumnMgr(); }));
  }

  // ── 弹窗 ──
  function modal(title, bodyHtml, onOpen) {
    const wrap = document.createElement('div');
    wrap.className = 'kb-modal';
    // 2026-09-05 共识：所有弹框统一拖拽缩放——工厂层一处接线（手柄 .kb-modal-resize + pointer 拖拽），
    // ticket/评论/详情/审批等全部 modal() 出口自动生效；缩放写盒体内联 width/height（覆盖初始定宽/自适应值）
    wrap.innerHTML = `<div class="kb-modal-box"><div class="kb-modal-head"><h3>${esc(title)}</h3><button class="kb-icon" data-close>✕</button></div><div class="kb-modal-body">${bodyHtml}</div><div class="kb-modal-resize" title="拖拽调整大小"></div></div>`;
    boardRoot.appendChild(wrap);
    bindModalResize(wrap);
    // E1/Q-041：关闭清理栈（EasyMDE destroy 等，onOpen 内经 wrap.kbOnClose 注册）；Q-046：ESC 关闭
    // （document 冒泡层处理——CM5 默认不拦 ESC，编辑器不吞；随 close 移除监听防泄漏）
    const cleanups = [];
    const close = () => {
      if (!wrap.parentNode) return;
      while (cleanups.length) { try { cleanups.pop()(); } catch {} }
      wrap.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));
    wrap.kbOnClose = cleanups;
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
    onOpen?.(wrap, close);
    return wrap;
  }

  /** 弹框统一缩放（2026-09-05 共识）：右下角手柄 pointer 拖拽 → 盒体内联宽高；min 320×240、上限 95vw/95vh。
   *  监听全挂 document 且 pointerup 必然清理（弹框中途关闭也无残留）；拖拽期间 body user-select:none 防选文本 */
  function bindModalResize(wrap) {
    const box = wrap.querySelector('.kb-modal-box');
    const grip = wrap.querySelector('.kb-modal-resize');
    if (!box || !grip) return;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // 不聚焦内部控件/不触发文本选择
      e.stopPropagation(); // 不冒泡到 wrap click（防误关）与卡片拖拽链
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = box.offsetWidth;
      const startH = box.offsetHeight;
      const move = (ev) => {
        // 下限 320×240；上限 95vw/95vh（同步抬 CSS max 约束——否则 82vh/88vh 基类先卡住）
        box.style.width = `${Math.min(Math.max(startW + (ev.clientX - startX), 320), window.innerWidth * 0.95)}px`;
        box.style.height = `${Math.min(Math.max(startH + (ev.clientY - startY), 240), window.innerHeight * 0.95)}px`;
        box.style.maxWidth = '95vw';
        box.style.maxHeight = '95vh';
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.body.style.userSelect = '';
      };
      document.body.style.userSelect = 'none';
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }

  function promptNewBoard() {
    modal('新建看板', `<input id="kb-bname" class="kb-input" placeholder="看板名称" /><div class="kb-modal-ops"><button class="kb-btn kb-primary" data-ok>创建</button><button class="kb-btn" data-close>取消</button></div>`, (w, close) => {
      const inp = $('#kb-bname', w); inp.focus();
      const ok = async () => {
        const name = inp.value.trim();
        if (!name) return;
        const r = await kanban.createBoard(name);
        if (r.ok) { close(); await refreshBoards(r.data.id); } else alert('创建失败：' + (r.message || r.code));
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      $('[data-ok]', w).addEventListener('click', ok);
    });
  }

  function promptNewTask(colId) {
    if (!currentBoard) return;
    modal('新建卡片', `
      <div class="kb-f"><label>标题</label><input id="kb-tt" class="kb-input" /></div>
      <div class="kb-f"><label>模式</label><select id="kb-mode" class="kb-input"><option value="manual">手动</option><option value="auto">自动（需 AC）</option></select></div>
      <div class="kb-f" id="kb-model-wrap"><label>模型</label><select id="kb-model" class="kb-input" title="${MODEL_PRIORITY_HINT}"><option value="">加载模型中…</option></select><span class="kb-hint">用于本票执行；自定义渠道来自 dsh 设置</span></div>
      <div class="kb-f"><label>工作目录</label><input id="kb-cwd" class="kb-input" placeholder="默认 ~（主目录）" title="ticket 所选 → 看板默认 → ~（主目录）；目录不存在时执行会失败并提示" /><button class="kb-btn" id="kb-cwd-browse">浏览…</button><span class="kb-hint">仅 kanban 任务执行生效（dsh web 聊天工作区不在此设置）</span></div>
      <div class="kb-f"><label>推理力度</label><select id="kb-effort" class="kb-input" title="${REASONING_TICKET_HINT}">${reasoningOptionsHtml('')}</select></div>
      <div class="kb-f" id="kb-ac-wrap" style="display:none"><label>AC·what</label><input id="kb-ac-what" class="kb-input" /><label>AC·expected</label><input id="kb-ac-exp" class="kb-input" /><label>AC·verify</label><input id="kb-ac-ver" class="kb-input" /></div>
      <div class="kb-f"><label>优先级</label><select id="kb-pri" class="kb-input"><option>P0</option><option>P1</option><option selected>P2</option><option>无</option></select></div>
      <div class="kb-f"><label>描述</label><textarea id="kb-desc" class="kb-input"></textarea></div>
      <div class="kb-modal-ops"><button class="kb-btn kb-primary" data-ok>创建</button><button class="kb-btn" data-close>取消</button></div>`, (w, close) => {
      $('#kb-mode', w).addEventListener('change', (e) => { $('#kb-ac-wrap', w).style.display = e.target.value === 'auto' ? '' : 'none'; });
      $('#kb-cwd-browse', w)?.addEventListener('click', async () => {
        const p = await pickDirectory();
        if (p) $('#kb-cwd', w).value = p; // 对话框仅填值（DOM 属性赋值，无 HTML 注入面），随保存提交
      });
      fillModelSelectWithRetry(() => $('#kb-model', w), '', '默认（跟随看板）', '#kb-model-wrap');
      // E1：描述 textarea → EasyMDE（Q-041 新实例；关闭随 kbOnClose destroy）
      const descEditor = createEditor($('#kb-desc', w));
      w.kbOnClose.push(() => destroyEditor(descEditor));
      descEditor?.codemirror.focus(); // Q-046：初始化后编辑器获得焦点
      const ok = async () => {
        const input = { title: $('#kb-tt', w).value.trim(), columnId: colId, priority: $('#kb-pri', w).value, description: (descEditor ? descEditor.value() : $('#kb-desc', w).value).trim() || null, executionMode: $('#kb-mode', w).value, agentSpec: { model: $('#kb-model', w)?.value || null, cwd: $('#kb-cwd', w)?.value.trim() || null, reasoningEffort: $('#kb-effort', w)?.value || null } }; // agentSpec.model/cwd/reasoningEffort：执行链 lane 补 store/IPC 透传
        if (!input.title) return;
        if (input.executionMode === 'auto') {
          input.acceptanceCriteria = { what: $('#kb-ac-what', w).value.trim(), expected: $('#kb-ac-exp', w).value.trim(), verify: $('#kb-ac-ver', w).value.trim() };
          if (!input.acceptanceCriteria.what || !input.acceptanceCriteria.expected || !input.acceptanceCriteria.verify) { alert('auto 模式需填 AC 三字段'); return; }
        }
        const r = await kanban.createTask(currentBoard.id, input);
        if (r.ok) { close(); await loadBoard(currentBoard.id); } else alert('创建失败：' + (r.message || r.code));
      };
      $('#kb-tt', w).addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      $('[data-ok]', w).addEventListener('click', ok);
    });
  }

  function openDetail(taskId) {
    const t = taskById(taskId);
    if (!t) return;
    const col = colById(t.columnId);
    const sub = childrenOf(t.id);
    modal('卡片详情', `
      <div class="kb-detail-head"><h3>${esc(t.title)}</h3><span class="kb-pri kb-pri-${t.priority}">${esc(t.priority)}</span>${t.labels.map((l) => `<span class="kb-label">${esc(l)}</span>`).join('')}</div>
      <div class="kb-detail-meta"><span>列：${col ? esc(col.name) : ''}</span><span>模式：${t.executionMode}</span><span class="kb-exec kb-exec-${t.executionStatus}">${execNames[t.executionStatus] || t.executionStatus}</span></div>
      <div class="kb-detail-dates"><label>开始 <input type="date" id="kb-date-start" value="${esc(t.startDate || '')}" /></label><label>截止 <input type="date" id="kb-date-due" value="${esc(t.dueDate || '')}" /></label></div>
      ${t.description ? `<div class="kb-detail-desc kb-md">${mdRender(t.description)}</div>` : ''}
      ${sub.length ? `<div class="kb-sub-list"><h4>子任务</h4>${sub.map((s) => `<div class="kb-sub-item">${esc(s.title)} <span class="kb-exec kb-exec-${s.executionStatus}">${execNames[s.executionStatus] || s.executionStatus}</span></div>`).join('')}</div>` : ''}
      ${sub.length ? `<div class="dg-entry" role="button" tabindex="0" title="点开查看依赖图"><span class="dg-et">依赖图</span><span class="dg-sum" id="dg-sum">…</span><span class="dg-open">查看依赖图 ↗</span></div>` : ''}
      ${timelineHtml(t)}
      <div class="kb-comment"><textarea id="kb-comment-text" class="kb-input" placeholder="添加评论…"></textarea></div>
      <div class="kb-modal-ops"><button class="kb-btn kb-primary" data-comment>评论</button><button class="kb-btn" data-edit>编辑</button>${t.archivedAt ? '' : `<button class="kb-btn" data-archive>归档</button>`}<button class="kb-btn kb-danger" data-del>删除</button></div>`, (w, close) => {
      // 详情弹框自适应尺寸（2026-09-05）：modifier class → CSS 放大 + head/ops sticky（其余弹框维持 440px）
      w.querySelector('.kb-modal-box')?.classList.add('kb-modal-detail');
      // 需求 1（2026-09-05）：详情弹框追踪（执行事件定向更新定位；随 close 清理防泄漏）
      openDetailTaskId = t.id;
      openDetailWrap = w;
      w.kbOnClose.push(() => { openDetailTaskId = null; openDetailWrap = null; });
      // Q-回复落盘（2026-09-05）：执行输出区块（loadExecLogBlock 与定向更新共用；无日志不出现）
      loadExecLogBlock(w, t.id);
      linkifyTimeline(w, taskById(t.id) || t); // 需求 2：时间线 comment 路径链接化（mdRender(DOMPurify) 后 DOM 后处理）
      // 需求 2：评论编辑入口 + 文件路径点击（事件委托挂在弹框容器——定向更新重建时间线后仍生效）
      w.addEventListener('click', (e) => {
        const p = e.target.closest('[data-openpath]');
        if (p) {
          e.preventDefault(); // href="#" 不跳转
          const path = p.dataset.openpath;
          Promise.resolve(window.hull?.openPath?.(path))
            .then((r) => { if (r && !r.ok) alert('打开失败：' + (r.message || '未知错误')); })
            .catch(() => alert('打开失败：桥不可用'));
          return;
        }
        const btn = e.target.closest('[data-editcmt]');
        if (btn) startCommentEdit(w, t.id, btn.dataset.editcmt);
      });
      // E1：评论框 → EasyMDE（CON-R-editor-006 U-1；Q-041 生命周期同 create/edit）
      const cmtEditor = createEditor($('#kb-comment-text', w));
      w.kbOnClose.push(() => destroyEditor(cmtEditor));
      cmtEditor?.codemirror.focus();
      // U3 依赖图摘要入口条（有子任务时）：依赖数 · 池水位 · 态计数；点击/Enter 开独立弹框
      if (sub.length) {
        const entry = w.querySelector('.dg-entry');
        const sumEl = w.querySelector('#dg-sum');
        const openDg = () => {
          openDepgraphTaskId = t.id;
          const dg = window.depgraph;
          if (dg) { dg.onClose(() => { openDepgraphTaskId = null; }); dg.open(t, sub); }
        };
        entry.addEventListener('click', openDg);
        entry.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDg(); } });
        const deps = sub.reduce((n, s) => n + (s.dependencies || []).filter((d) => sub.some((x) => x.id === d)).length, 0);
        const counts = { running: 0, queued: 0, idle: 0, paused: 0, interrupted: 0, cancelled: 0, failed: 0, succeeded: 0 };
        for (const s of sub) counts[s.executionStatus || 'idle']++;
        let halted = 0;
        if (window.depgraphCore) {
          const byId = {}; for (const s of sub) byId[s.id] = s;
          halted = window.depgraphCore.haltedSet(byId, Object.keys(byId).filter((id) => ['failed', 'cancelled', 'interrupted'].includes(byId[id].executionStatus))).size;
        }
        (async () => {
          let poolTxt = '池 --/--';
          try {
            if (exec && exec.getExecutionSnapshot) {
              const r = await exec.getExecutionSnapshot(currentBoard.id);
              if (r && r.ok && r.data && window.depgraphCore) {
                const p = window.depgraphCore.poolState(r.data);
                poolTxt = p.running >= p.maxParallel ? `池满 ${p.running}/${p.maxParallel}` : `池 ${p.running}/${p.maxParallel}`;
              }
            }
          } catch { /* 快照不可用 → 保持 -- */ }
          if (sumEl.isConnected) sumEl.textContent = `${deps} 依赖 · ${poolTxt} · 运行 ${counts.running} · 就绪 ${counts.queued} · 未执行 ${counts.idle} · 失败 ${counts.failed} · 中止 ${halted}`;
        })();
      }
      // T2 契约 UI 承接（Q-052）：开始/截止日期选择器，变更即时生效持久化（清空=显式 null）
      const saveDate = async (field, value) => {
        const r = await kanban.updateTask(currentBoard.id, t.id, { [field]: value || null });
        if (r.ok) { close(); await loadBoard(currentBoard.id); openDetail(t.id); } else alert('保存失败：' + (r.message || r.code));
      };
      $('#kb-date-start', w)?.addEventListener('change', (e) => saveDate('startDate', e.target.value));
      $('#kb-date-due', w)?.addEventListener('change', (e) => saveDate('dueDate', e.target.value));
      $('[data-comment]', w).addEventListener('click', async () => {
        const c = (cmtEditor ? cmtEditor.value() : $('#kb-comment-text', w).value).trim();
        if (!c) return;
        const r = await kanban.addComment({ boardId: currentBoard.id, taskId: t.id, content: c });
        if (r.ok) { close(); await loadBoard(currentBoard.id); openDetail(t.id); } else alert('评论失败：' + (r.message || r.code));
      });
      $('[data-edit]', w).addEventListener('click', () => { close(); editTask(t.id); });
      $('[data-archive]', w)?.addEventListener('click', async () => { const r = await kanban.archiveTask(currentBoard.id, t.id); if (r.ok) { close(); await loadBoard(currentBoard.id); } else alert('归档失败：' + (r.message || r.code)); });
      $('[data-del]', w).addEventListener('click', async () => {
        if (!confirm(`删除任务「${t.title}」？`)) return;
        const r = await kanban.deleteTask(currentBoard.id, t.id);
        if (r.ok) { close(); await loadBoard(currentBoard.id); } else alert('删除失败：' + (r.message || r.code));
      });
    });
  }

  function editTask(taskId) {
    const t = taskById(taskId);
    if (!t) return;
    // U3：前置依赖仅子任务可声明（store Q-014 同父约束）——同父兄弟列表，排除自身与已依赖本任务的兄弟（防 UI 造 A→B→A 环，store 无环检测）
    const siblings = t.parentId ? (currentBoard?.tasks || []).filter((x) => x.parentId === t.parentId && x.id !== t.id && !(x.dependencies || []).includes(t.id)) : [];
    modal('编辑卡片', `
      <div class="kb-f"><label>标题</label><input id="kb-tt" class="kb-input" value="${esc(t.title)}" /></div>
      <div class="kb-f"><label>描述</label><textarea id="kb-desc" class="kb-input">${esc(t.description || '')}</textarea></div>
      <div class="kb-f"><label>优先级</label><select id="kb-pri" class="kb-input">${['P0', 'P1', 'P2', '无'].map((p) => `<option ${t.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div class="kb-f" id="kb-model-wrap"><label>模型</label><select id="kb-model" class="kb-input" title="${MODEL_PRIORITY_HINT}"><option value="">加载模型中…</option></select><span class="kb-hint">用于本票执行；自定义渠道来自 dsh 设置</span></div>
      <div class="kb-f"><label>工作目录</label><input id="kb-cwd" class="kb-input" placeholder="默认 ~（主目录）" title="ticket 所选 → 看板默认 → ~（主目录）；目录不存在时执行会失败并提示" value="${esc(t.agentSpec?.cwd || '')}" /><button class="kb-btn" id="kb-cwd-browse">浏览…</button><span class="kb-hint">仅 kanban 任务执行生效（dsh web 聊天工作区不在此设置）</span></div>
      <div class="kb-f"><label>推理力度</label><select id="kb-effort" class="kb-input" title="${REASONING_TICKET_HINT}">${reasoningOptionsHtml(t.agentSpec?.reasoningEffort || '')}</select></div>
      ${t.parentId ? `<div class="kb-f"><label>前置依赖</label><div class="kb-deps" id="kb-deps">${siblings.length ? siblings.map((s) => `<label class="kb-dep"><input type="checkbox" value="${esc(s.id)}" ${(t.dependencies || []).includes(s.id) ? 'checked' : ''} /> ${esc(s.title)}</label>`).join('') : '<span class="kb-muted">无同父兄弟任务</span>'}</div></div>` : ''}
      <div class="kb-modal-ops"><button class="kb-btn kb-primary" data-ok>保存</button><button class="kb-btn" data-close>取消</button></div>`, (w, close) => {
      // E1：预填现值（FE-1 editor.value(t.description ?? '')）；旧纯文本 = 合法 Markdown（E10 兼容）
      const descEditor = createEditor($('#kb-desc', w), t.description ?? '');
      w.kbOnClose.push(() => destroyEditor(descEditor));
      descEditor?.codemirror.focus(); // Q-046/E19：编辑弹窗初始 focus 在编辑器
      fillModelSelectWithRetry(() => $('#kb-model', w), t.agentSpec?.model, '默认（跟随看板）', '#kb-model-wrap'); // 回显 task.agentSpec.model（Q-023 disconnected 重试）
      $('#kb-cwd-browse', w)?.addEventListener('click', async () => {
        const p = await pickDirectory();
        if (p) $('#kb-cwd', w).value = p; // 对话框仅填值（DOM 属性赋值，无 HTML 注入面），随保存提交
      });
      $('[data-ok]', w).addEventListener('click', async () => {
        // U3：子任务保存附带 dependencies（同父兄弟勾选；顶层任务不可声明，store 校验兜底）
        const patch = { title: $('#kb-tt', w).value.trim(), description: (descEditor ? descEditor.value() : $('#kb-desc', w).value).trim() || null, priority: $('#kb-pri', w).value, agentSpec: { model: $('#kb-model', w)?.value || null, cwd: $('#kb-cwd', w)?.value.trim() || null, reasoningEffort: $('#kb-effort', w)?.value || null } }; // agentSpec.model/cwd/reasoningEffort：执行链 lane 补 store/IPC 透传
        if (t.parentId) patch.dependencies = [...w.querySelectorAll('#kb-deps input:checked')].map((c) => c.value);
        const r = await kanban.updateTask(currentBoard.id, t.id, patch);
        if (r.ok) { close(); await loadBoard(currentBoard.id); } else alert('保存失败：' + (r.message || r.code));
      });
    });
  }

  function openColumnMgr() {
    if (!currentBoard) return;
    const cols = currentBoard.columns;
    modal('列管理', `
      <div class="kb-cols-mgr">${cols.map((c) => `<div class="kb-col-row"><span class="kb-col-chip" style="border-color:${c.color};background:${c.color}22">${esc(c.name)}</span>${c.type ? `<span class="kb-tpl">模板列</span>` : ''}<button class="kb-btn" data-upcol="${c.id}">编辑</button>${c.type ? '' : `<button class="kb-btn kb-danger" data-delcol="${c.id}">删除</button>`}</div>`).join('')}</div>
      <div class="kb-modal-ops"><button class="kb-btn kb-primary" data-newcol>新建列</button><button class="kb-btn" data-close>关闭</button></div>`, (w, close) => {
      $('[data-newcol]', w).addEventListener('click', () => { close(); promptNewColumn(); });
      document.querySelectorAll('[data-upcol]', w).forEach((b) => b.addEventListener('click', () => { close(); editColumn(b.dataset.upcol); }));
      document.querySelectorAll('[data-delcol]', w).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('删除该列（列内任务将被迁移/处理）？')) return;
        const r = await kanban.deleteColumn(currentBoard.id, b.dataset.delcol);
        if (r.ok) { close(); await loadBoard(currentBoard.id); } else alert('删除失败：' + (r.message || r.code));
      }));
    });
  }

  function promptNewColumn() {
    modal('新建列', `<div class="kb-f"><label>列名</label><input id="kb-cname" class="kb-input" /></div><div class="kb-modal-ops"><button class="kb-btn kb-primary" data-ok>创建</button><button class="kb-btn" data-close>取消</button></div>`, (w, close) => {
      $('[data-ok]', w).addEventListener('click', async () => {
        const name = $('#kb-cname', w).value.trim();
        if (!name) return;
        const r = await kanban.createColumn(currentBoard.id, name);
        if (r.ok) { close(); await loadBoard(currentBoard.id); } else alert('创建失败：' + (r.message || r.code));
      });
    });
  }

  function editColumn(colId) {
    const c = colById(colId);
    if (!c) return;
    modal('编辑列', `<div class="kb-f"><label>列名</label><input id="kb-cname" class="kb-input" value="${esc(c.name)}" /></div><div class="kb-f"><label>颜色</label><input id="kb-ccolor" class="kb-input" type="color" value="${c.color}" /></div><div class="kb-f"><label><input id="kb-chide" type="checkbox" ${c.hidden ? 'checked' : ''} /> 隐藏列</label></div><div class="kb-modal-ops"><button class="kb-btn kb-primary" data-ok>保存</button><button class="kb-btn" data-close>取消</button></div>`, (w, close) => {
      $('[data-ok]', w).addEventListener('click', async () => {
        const r = await kanban.updateColumn(currentBoard.id, colId, { name: $('#kb-cname', w).value.trim(), color: $('#kb-ccolor', w).value, hidden: $('#kb-chide', w).checked });
        if (r.ok) { close(); await loadBoard(currentBoard.id); } else alert('保存失败：' + (r.message || r.code));
      });
    });
  }

  // ── 数据加载 ──
  async function refreshBoards(selectId) {
    const r = await kanban.getBoards();
    if (r.ok) {
      boards = r.data;
      if (selectId) await loadBoard(selectId);
      else if (currentBoard && boards.find((b) => b.id === currentBoard.id)) await loadBoard(currentBoard.id);
      else if (boards.length) await loadBoard(boards[0].id);
      else { currentBoard = null; renderEmpty(); }
    }
  }

  async function loadBoard(boardId) {
    const [br, tr] = await Promise.all([kanban.getBoards(), kanban.getTasks(boardId)]);
    if (br.ok) boards = br.data;
    if (tr.ok && br.ok) {
      const b = boards.find((x) => x.id === boardId);
      if (b) { timelinePage = 1; currentBoard = { ...b, tasks: tr.data }; render(); }
    } else {
      alert('加载看板失败：' + ((!br.ok && br.message) || (!tr.ok && tr.message) || ''));
    }
  }

  // ── 订阅 ──
  if (exec && exec.onExecutionUpdate) {
    exec.onExecutionUpdate(async (payload) => {
      // 需求 1（2026-09-05）执行事件定向更新：广播载荷 boardId 恒 undefined（ExecIpc L157 显式 undefined）
      // → 原条件永 false、全板从不自动刷新。改 taskId 定向：任务在当前看板 → 重取任务替换内存 + 卡片/列/
      // 详情弹框原地更新；不调 loadBoard（避免全板重渲染销毁弹框/焦点）。其余 board 变更仍走 loadBoard。
      if (!currentBoard || !payload?.taskId || !taskById(payload.taskId)) return; // 非当前看板任务（跨板广播）忽略
      const r = await kanban.getTasks(currentBoard.id);
      if (!r.ok) return;
      const fresh = r.data.find((x) => x.id === payload.taskId);
      const prev = taskById(payload.taskId);
      if (!fresh || !prev) return;
      const colChanged = prev.columnId !== fresh.columnId;
      const idx = currentBoard.tasks.findIndex((x) => x.id === payload.taskId);
      if (idx >= 0) currentBoard.tasks[idx] = fresh; // 内存先同步（非看板视图/隐藏列靠它兜底）
      applyTaskToDom(fresh, colChanged ? prev.columnId : null);
      // U3：依赖图弹框开着 → 幂等 open 推最新数据重绘（depgraph 不反读 kanban，数据由 kanban 推）
      if (window.depgraph && openDepgraphTaskId === payload.taskId) {
        const dt = taskById(payload.taskId);
        if (dt && window.depgraph.isOpen()) window.depgraph.open(dt, childrenOf(dt.id));
      }
    });
  }
  if (exec && exec.onPermissionRequest) {
    exec.onPermissionRequest((p) => showApproval(p));
  }
  if (exec && exec.onPermissionSettled) {
    exec.onPermissionSettled((p) => {
      // 收到同 requestId settled → 关闭弹窗（去重：已关无操作）
      if (approvalModal && approvalModal.dataset.requestId === String(p.requestId)) {
        approvalModal.remove();
        approvalModal = null;
      }
    });
  }

  function showApproval(p) {
    // Q-024/Bug-B：currentBoard 未加载（其他视图/加载中）不再吞审批——审批等待 30s 即 auto-deny，
    // 卡片被吞 = 用户永远看不到 = 工具必被拒；boardId 缺省用事件载荷（main 填空串，timeline 兜底）
    const boardId = p.boardId || currentBoard?.id || '';
    const task = p.taskId ? taskById(p.taskId) : null;
    const wrap = modal('审批请求', `
      <p class="kb-approval-msg">${task ? `任务「${esc(task.title)}」` : ''}请求授权</p>
      <div class="kb-approval-body">${p.message ? esc(p.message) : 'agent 请求执行需要授权的操作'}${p.requestId ? `<div class="kb-muted">requestId: ${esc(p.requestId)}</div>` : ''}</div>
      <div class="kb-approval-countdown kb-muted" data-countdown>${Math.max(0, Math.round((new Date(p.deadlineAt).getTime() - Date.now()) / 1000))}s 后自动拒绝</div>
      <div class="kb-modal-ops"><button class="kb-btn kb-danger" data-deny>拒绝</button><button class="kb-btn kb-primary" data-approve>批准</button></div>`, (_, close) => {
      approvalModal = wrap; approvalModal.dataset.requestId = String(p.requestId);
      // Q-024/Bug-B：30s 倒计时显示（deadlineAt 主进程下发，本地每秒递减——只读展示，判定权在主进程）
      const cd = wrap.querySelector('[data-countdown]');
      const tick = setInterval(() => {
        const left = Math.round((new Date(p.deadlineAt).getTime() - Date.now()) / 1000);
        if (left <= 0) { clearInterval(tick); if (cd) cd.textContent = '已自动拒绝'; }
        else if (cd) cd.textContent = `${left}s 后自动拒绝`;
      }, 1000);
      const stopTick = () => clearInterval(tick);
      wrap.addEventListener('click', (e) => {
        if (e.target === approvalModal || e.target.closest('[data-close]')) { approvalModal = null; stopTick(); close(); }
      });
      approvalModal.querySelector('[data-approve]').addEventListener('click', async () => { stopTick(); await exec.approvalRespond(boardId, p.taskId, p.requestId, 'approved', ''); approvalModal = null; });
      approvalModal.querySelector('[data-deny]').addEventListener('click', async () => { stopTick(); const reason = prompt('拒绝原因（可选）') || ''; await exec.approvalRespond(boardId, p.taskId, p.requestId, 'denied', reason); approvalModal = null; });
    });
  }

  // ── E1 markdown 链接代理（detail desc / timeline comment / EasyMDE 预览内 <a>）──
  // 壳页不可导航：http(s) 走 hull:openExternal（主进程协议校验），其余 href 一律阻止默认行为
  boardRoot.addEventListener('click', (e) => {
    const a = e.target.closest('.kb-md a[href], .EasyMDEContainer .editor-preview a[href], .EasyMDEContainer .editor-preview-side a[href]');
    if (!a || !boardRoot.contains(a)) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/^https?:/i.test(href)) window.hull?.openExternal?.(href);
  });

  // ── 初始化 ──
  refreshBoards();
// V2a：系统通知点击 → notifs:openTask 事件（一次性订阅，openDetail 在上方作用域）
window.hull?.onOpenTask?.((d) => window.__kanbanOpenTask?.(d.taskId));
window.__kanbanOpenTask = (taskId) => { try { openDetail(taskId); } catch { /* 数据不存在等，忽略 */ } };
})();

