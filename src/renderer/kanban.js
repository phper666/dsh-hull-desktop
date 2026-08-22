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
  const viewNames = { board: '看板', list: '列表', archive: '归档', timeline: '时间线', calendar: '日历' };
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
  const visibleCols = () => (currentBoard?.columns || []).filter((c) => !c.hidden);
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

  // ── 主渲染 ──
  function render() {
    if (!currentBoard) { renderEmpty(); return; }
    if (view === 'board') renderBoard();
    else if (view === 'list') renderList();
    else if (view === 'archive') renderArchive();
    else if (view === 'timeline') renderTimeline(); // T1/CON-R-timeline-001
    else renderCalendar(); // T1/CON-R-timeline-002
  }

  function renderEmpty() {
    boardRoot.innerHTML = `<div class="kb-empty"><h2>没有看板</h2><p>创建一个任务看板开始规划</p><button class="kb-btn kb-primary" id="kb-newboard-empty">新建看板</button></div>`;
    $('#kb-newboard-empty')?.addEventListener('click', promptNewBoard);
  }

  function boardToolbar() {
    const cols = currentBoard.columns;
    return `<div class="kb-toolbar">
      <div class="kb-boards"><select id="kb-board-select">${boards.map((b) => `<option value="${b.id}" ${b.id === currentBoard.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select><button class="kb-btn" id="kb-newboard">＋ 新建</button></div>
      <div class="kb-views">${Object.entries(viewNames).map(([k, n]) => `<button class="kb-view ${view === k ? 'active' : ''}" data-view="${k}">${n}</button>`).join('')}</div>
      <div class="kb-filters"><select id="kb-col-filter"><option value="all">全部列</option>${cols.map((c) => `<option value="${c.id}" ${filterCol === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><input id="kb-q" placeholder="筛选关键词…" value="${esc(filterQ)}" /></div>
    </div>`;
  }

  function renderBoard() {
    const cols = visibleCols();
    boardRoot.innerHTML = boardToolbar() + `<div class="kb-cols" id="kb-cols">${cols.map((c) => {
      const tasks = activeTasks().filter((t) => t.columnId === c.id && matchesFilter(t));
      const empty = tasks.length === 0;
      return `<div class="kb-col" data-col="${c.id}" style="border-top-color:${c.color}"><div class="kb-col-head"><span class="kb-col-name">${esc(c.name)}</span><span class="kb-col-count">${tasks.length}</span><span class="kb-col-actions"><button class="kb-icon" title="列管理" data-act="col-mgr">⚙</button></span></div><div class="kb-col-body">${empty ? '<div class="kb-empty-col">空列</div>' : tasks.map(cardHtml).join('')}</div><button class="kb-add-card" data-col="${c.id}">＋ 添加卡片</button></div>`;
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
    const execBadge = t.executionStatus !== 'idle' ? `<span class="kb-exec kb-exec-${t.executionStatus}">${execNames[t.executionStatus] || t.executionStatus}</span>` : '';
    const runBtn = (t.executionStatus === 'idle' || ['failed', 'cancelled', 'interrupted', 'succeeded'].includes(t.executionStatus)) ? `<button class="kb-run" data-run="${t.id}" title="执行">▶</button>` : '';
    const pauseBtn = t.executionStatus === 'running' ? `<button class="kb-run" data-pause="${t.id}" title="暂停">⏸</button>` : '';
    const resumeBtn = t.executionStatus === 'paused' ? `<button class="kb-run" data-resume="${t.id}" title="恢复">▶</button>` : '';
    const cancelBtn = t.executionStatus === 'running' || t.executionStatus === 'queued' ? `<button class="kb-run" data-cancel="${t.id}" title="取消">✕</button>` : '';
    const verifyBtn = isVerify && (['succeeded', 'idle', 'interrupted'].includes(t.executionStatus)) ? `<button class="kb-run" data-verify="${t.id}" title="确认完成">✓</button>` : '';
    return `<div class="kb-card ${done ? 'kb-done' : ''}" draggable="true" data-id="${t.id}"><div class="kb-card-top"><span class="kb-pri kb-pri-${t.priority}">${esc(t.priority)}</span>${t.labels.map((l) => `<span class="kb-label">${esc(l)}</span>`).join('')}${execBadge}</div><div class="kb-card-title">${esc(t.title)}</div>${t.description ? `<div class="kb-card-desc">${esc(t.description)}</div>` : ''}${subDone(t) ? `<div class="kb-sub">子任务 ${subDone(t)}</div>` : ''}<div class="kb-card-ops">${runBtn}${pauseBtn}${resumeBtn}${cancelBtn}${verifyBtn}<button class="kb-run" data-detail="${t.id}" title="详情">⋯</button></div></div>`;
  }

  function renderList() {
    const tasks = activeTasks().filter(matchesFilter).slice().sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));
    boardRoot.innerHTML = boardToolbar() + `<div class="kb-list-wrap"><table class="kb-list"><thead><tr><th>标题</th><th>列</th><th>优先级</th><th>执行态</th><th>标签</th></tr></thead><tbody>${tasks.length === 0 ? '<tr><td colspan="5" class="kb-empty-row">筛选无结果</td></tr>' : tasks.map((t) => {
      const col = colById(t.columnId);
      return `<tr data-id="${t.id}"><td>${esc(t.title)}${t.parentId ? ' <span class="kb-subtag">子任务</span>' : ''}</td><td>${col ? `<span class="kb-col-chip" style="border-color:${col.color}">${esc(col.name)}</span>` : ''}</td><td><span class="kb-pri kb-pri-${t.priority}">${esc(t.priority)}</span></td><td><span class="kb-exec kb-exec-${t.executionStatus}">${execNames[t.executionStatus] || t.executionStatus}</span></td><td>${t.labels.map((l) => `<span class="kb-label">${esc(l)}</span>`).join('')}</td></tr>`;
    }).join('')}</tbody></table></div>`;
    bindBoardEvents();
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

  function renderTimeline() {
    const all = buildTimelineEntries(activeTasks()); // 归档排除（契约实现补充约定）
    const shown = all.slice(0, timelinePage * TIMELINE_PAGE_SIZE); // D5 按需渲染：首屏封顶分页大小
    const typeCls = { 创建: 'kb-tlb-create', 执行: 'kb-tlb-exec', 评论: 'kb-tlb-comment', 系统: 'kb-tlb-system' };
    boardRoot.innerHTML = boardToolbar() + `<div class="kb-timeline">${
      all.length === 0
        ? '<div class="kb-empty-tlv">暂无活动，创建任务后这里会显示时间线</div>'
        : shown.map((e) => {
            const task = taskById(e.taskId);
            const time = e.ts !== null ? new Date(e.ts).toLocaleString() : '';
            const badge = `<span class="kb-tlb ${typeCls[e.type]}">${e.type}</span>${e.unknown ? '<span class="kb-tl-unknown">时间未知</span>' : ''}`;
            // 消毒（T1 契约 §6/D6）：评论 content 走 E1 同管线 mdRender；execution/system/结构化字段 esc()
            let body = '';
            if (e.type === '评论') body = `<div class="kb-tl-md kb-md">${mdRender(e.item.content)}</div>`;
            else if (e.type === '执行') body = `<div class="kb-tl-cmd">${esc((e.item.execution?.command || '').slice(0, 120))}</div>`;
            else body = `<div class="kb-tl-cmd">${esc(e.item?.content || '')}</div>`;
            return `<div class="kb-tl-row" data-task="${e.taskId}"><span class="kb-tl-time">${time}</span>${badge}<span class="kb-tl-title">${esc(task?.title || '')}</span>${body}</div>`;
          }).join('')}${all.length > shown.length ? '<button class="kb-btn" id="kb-tl-more">加载更多</button>' : ''}</div>`;
    bindBoardEvents();
    $('#kb-tl-more')?.addEventListener('click', () => { timelinePage++; renderTimeline(); }); // PERF4：slice 追加语义不重不漏
    document.querySelectorAll('.kb-tl-row').forEach((r) => r.addEventListener('click', () => openDetail(r.dataset.task)));
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
  function bindBoardEvents() {
    $('#kb-board-select')?.addEventListener('change', (e) => loadBoard(e.target.value));
    $('#kb-newboard')?.addEventListener('click', promptNewBoard);
    document.querySelectorAll('.kb-view').forEach((b) => b.addEventListener('click', (e) => { view = e.target.dataset.view; saveLastView(view); timelinePage = 1; render(); }));
    $('#kb-col-filter')?.addEventListener('change', (e) => { filterCol = e.target.value; render(); });
    $('#kb-q')?.addEventListener('input', (e) => { filterQ = e.target.value; render(); });

    // 拖拽（CON-R020 人工拖拽最高优先级）
    document.querySelectorAll('.kb-card').forEach((card) => {
      card.addEventListener('dragstart', (e) => { dragTaskId = card.dataset.id; e.dataTransfer.effectAllowed = 'move'; card.classList.add('kb-dragging'); });
      card.addEventListener('dragend', () => { dragTaskId = null; card.classList.remove('kb-dragging'); });
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

    // 卡片操作
    document.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', async () => { const r = await exec.executeTask(currentBoard.id, b.dataset.run); if (!r.ok) alert('执行失败：' + (r.message || r.code)); }));
    document.querySelectorAll('[data-pause]').forEach((b) => b.addEventListener('click', async () => { const r = await exec.pauseExecution(currentBoard.id, b.dataset.pause); if (!r.ok) alert('暂停失败：' + (r.message || r.code)); }));
    document.querySelectorAll('[data-resume]').forEach((b) => b.addEventListener('click', async () => { const r = await exec.resumeExecution(currentBoard.id, b.dataset.resume); if (!r.ok) alert('恢复失败：' + (r.message || r.code)); }));
    document.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => { const r = await exec.cancelExecution(currentBoard.id, b.dataset.cancel); if (!r.ok) alert('取消失败：' + (r.message || r.code)); }));
    document.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', async () => { const r = await exec.confirmVerify(currentBoard.id, b.dataset.verify); if (!r.ok) alert('确认失败：' + (r.message || r.code)); }));
    document.querySelectorAll('[data-detail]').forEach((b) => b.addEventListener('click', () => openDetail(b.dataset.detail)));
    // 点击卡片主体 → 弹详情（操作按钮区 stopPropagation 已挡；拖拽不触发 click）
    document.querySelectorAll('.kb-card[data-id]').forEach((c) => c.addEventListener('click', (e) => {
      if (e.target.closest('.kb-card-ops')) return; // 操作按钮区不弹详情
      openDetail(c.dataset.id);
    }));
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
    wrap.innerHTML = `<div class="kb-modal-box"><div class="kb-modal-head"><h3>${esc(title)}</h3><button class="kb-icon" data-close>✕</button></div><div class="kb-modal-body">${bodyHtml}</div></div>`;
    boardRoot.appendChild(wrap);
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
      <div class="kb-f" id="kb-ac-wrap" style="display:none"><label>AC·what</label><input id="kb-ac-what" class="kb-input" /><label>AC·expected</label><input id="kb-ac-exp" class="kb-input" /><label>AC·verify</label><input id="kb-ac-ver" class="kb-input" /></div>
      <div class="kb-f"><label>优先级</label><select id="kb-pri" class="kb-input"><option>P0</option><option>P1</option><option selected>P2</option><option>无</option></select></div>
      <div class="kb-f"><label>描述</label><textarea id="kb-desc" class="kb-input"></textarea></div>
      <div class="kb-modal-ops"><button class="kb-btn kb-primary" data-ok>创建</button><button class="kb-btn" data-close>取消</button></div>`, (w, close) => {
      $('#kb-mode', w).addEventListener('change', (e) => { $('#kb-ac-wrap', w).style.display = e.target.value === 'auto' ? '' : 'none'; });
      // E1：描述 textarea → EasyMDE（Q-041 新实例；关闭随 kbOnClose destroy）
      const descEditor = createEditor($('#kb-desc', w));
      w.kbOnClose.push(() => destroyEditor(descEditor));
      descEditor?.codemirror.focus(); // Q-046：初始化后编辑器获得焦点
      const ok = async () => {
        const input = { title: $('#kb-tt', w).value.trim(), columnId: colId, priority: $('#kb-pri', w).value, description: (descEditor ? descEditor.value() : $('#kb-desc', w).value).trim() || null, executionMode: $('#kb-mode', w).value };
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
    const tl = t.timeline.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    modal('卡片详情', `
      <div class="kb-detail-head"><h3>${esc(t.title)}</h3><span class="kb-pri kb-pri-${t.priority}">${esc(t.priority)}</span>${t.labels.map((l) => `<span class="kb-label">${esc(l)}</span>`).join('')}</div>
      <div class="kb-detail-meta"><span>列：${col ? esc(col.name) : ''}</span><span>模式：${t.executionMode}</span><span class="kb-exec kb-exec-${t.executionStatus}">${execNames[t.executionStatus] || t.executionStatus}</span></div>
      <div class="kb-detail-dates"><label>开始 <input type="date" id="kb-date-start" value="${esc(t.startDate || '')}" /></label><label>截止 <input type="date" id="kb-date-due" value="${esc(t.dueDate || '')}" /></label></div>
      ${t.description ? `<div class="kb-detail-desc kb-md">${mdRender(t.description)}</div>` : ''}
      ${sub.length ? `<div class="kb-sub-list"><h4>子任务</h4>${sub.map((s) => `<div class="kb-sub-item">${esc(s.title)} <span class="kb-exec kb-exec-${s.executionStatus}">${execNames[s.executionStatus] || s.executionStatus}</span></div>`).join('')}</div>` : ''}
      <div class="kb-tl"><h4>时间线</h4>${tl.length === 0 ? '<div class="kb-empty-tl">暂无记录</div>' : tl.map((i) => {
        const who = i.author || (i.source.type === 'agent' ? 'agent' : i.source.type);
        const execTag = i.execution ? `<span class="kb-exec kb-exec-${i.execution.status}">${execNames[i.execution.status] || i.execution.status}${i.execution.exitCode !== null ? ` (${i.execution.exitCode})` : ''}</span>` : '';
        // E1/FE-2：comment 条目走 Markdown 管线（DOMPurify 消毒）；execution/system 条目维持 esc 纯文本
        const contentHtml = i.type === 'comment' ? mdRender(i.content) : esc(i.content);
        return `<div class="kb-tl-item"><span class="kb-tl-who">${esc(who)}</span><span class="kb-tl-time">${new Date(i.createdAt).toLocaleString()}</span>${execTag}<div class="kb-tl-content kb-md">${contentHtml}</div></div>`;
      }).join('')}</div>
      <div class="kb-comment"><textarea id="kb-comment-text" class="kb-input" placeholder="添加评论…"></textarea><button class="kb-btn kb-primary" data-comment>评论</button></div>
      <div class="kb-modal-ops"><button class="kb-btn" data-edit>编辑</button>${t.archivedAt ? '' : `<button class="kb-btn" data-archive>归档</button>`}<button class="kb-btn kb-danger" data-del>删除</button></div>`, (w, close) => {
      // E1：评论框 → EasyMDE（CON-R-editor-006 U-1；Q-041 生命周期同 create/edit）
      const cmtEditor = createEditor($('#kb-comment-text', w));
      w.kbOnClose.push(() => destroyEditor(cmtEditor));
      cmtEditor?.codemirror.focus();
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
    modal('编辑卡片', `
      <div class="kb-f"><label>标题</label><input id="kb-tt" class="kb-input" value="${esc(t.title)}" /></div>
      <div class="kb-f"><label>描述</label><textarea id="kb-desc" class="kb-input">${esc(t.description || '')}</textarea></div>
      <div class="kb-f"><label>优先级</label><select id="kb-pri" class="kb-input">${['P0', 'P1', 'P2', '无'].map((p) => `<option ${t.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div class="kb-modal-ops"><button class="kb-btn kb-primary" data-ok>保存</button><button class="kb-btn" data-close>取消</button></div>`, (w, close) => {
      // E1：预填现值（FE-1 editor.value(t.description ?? '')）；旧纯文本 = 合法 Markdown（E10 兼容）
      const descEditor = createEditor($('#kb-desc', w), t.description ?? '');
      w.kbOnClose.push(() => destroyEditor(descEditor));
      descEditor?.codemirror.focus(); // Q-046/E19：编辑弹窗初始 focus 在编辑器
      $('[data-ok]', w).addEventListener('click', async () => {
        const r = await kanban.updateTask(currentBoard.id, t.id, { title: $('#kb-tt', w).value.trim(), description: (descEditor ? descEditor.value() : $('#kb-desc', w).value).trim() || null, priority: $('#kb-pri', w).value });
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
        const r = await kanban.updateColumn(currentBoard.id, null, { name });
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
      if (currentBoard && payload && payload.boardId === currentBoard.id) await loadBoard(currentBoard.id);
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
    if (!currentBoard) return;
    const task = p.taskId ? taskById(p.taskId) : null;
    const wrap = modal('审批请求', `
      <p class="kb-approval-msg">${task ? `任务「${esc(task.title)}」` : ''}请求授权</p>
      <div class="kb-approval-body">${p.message ? esc(p.message) : ''}${p.requestId ? `<div class="kb-muted">requestId: ${esc(p.requestId)}</div>` : ''}</div>
      <div class="kb-modal-ops"><button class="kb-btn kb-danger" data-deny>拒绝</button><button class="kb-btn kb-primary" data-approve>批准</button></div>`, (_, close) => {
      approvalModal = wrap; approvalModal.dataset.requestId = String(p.requestId);
      approvalModal.addEventListener('click', (e) => {
        if (e.target === approvalModal || e.target.closest('[data-close]')) { approvalModal = null; close(); }
      });
      approvalModal.querySelector('[data-approve]').addEventListener('click', async () => { await exec.approvalRespond(currentBoard.id, p.taskId, p.requestId, 'approved', ''); approvalModal = null; });
      approvalModal.querySelector('[data-deny]').addEventListener('click', async () => { const reason = prompt('拒绝原因（可选）') || ''; await exec.approvalRespond(currentBoard.id, p.taskId, p.requestId, 'denied', reason); approvalModal = null; });
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
})();
