/**
 * N2 笔记视图（渲染层，feishu-n2-notes-api-contract.md v1.0）
 * 消费 window.notes 桥（N1 10 原语 + onIndexChanged；N1 lane 并行落地——桥缺失时降级占位不崩溃）。
 * 纯原生 JS 无框架；视图状态机：列表态 / 编辑态 / 保存冲突态 / 就绪态（契约 §渲染层视图状态）。
 * 渲染管线：markdown-it v14.1.0 + DOMPurify（vendored 全局，CON-R-editor-002/004，管线对齐 kanban.js E1）。
 * EasyMDE 纪律（CON-R-editor-001）：每开新建、关即 destroy（Q-041）；autoDownloadFontAwesome:false（CSP）。
 */
(() => {
  const root = document.getElementById('notes-root');
  if (!root) return;

  // N1 桥防御性获取：契约定 window.notes；window.hull.notes 为任务书兜底形态。两者皆缺 → 视图降级。
  const api = window.notes ?? window.hull?.notes ?? null;

  /* ── 小工具 ─────────────────────────────────── */
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const md = (() => {
    if (!window.markdownit || !window.DOMPurify) return null;
    const inst = window.markdownit({ breaks: true, linkify: false });
    if (window.markdownitTaskLists) inst.use(window.markdownitTaskLists);
    return inst;
  })();
  const mdRender = (text) => (md && window.DOMPurify ? window.DOMPurify.sanitize(md.render(String(text ?? ''))) : esc(text));
  const basename = (p) => String(p || '').split('/').pop() || '';
  const dirname = (p) => { const i = String(p || '').lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
  const NOW = () => new Date();
  function relTime(iso) {
    const diff = (NOW() - new Date(iso)) / 60000;
    if (!isFinite(diff)) return '—';
    if (diff < 1) return '刚刚';
    if (diff < 60) return Math.round(diff) + ' 分钟前';
    if (diff < 60 * 24) return Math.round(diff / 60) + ' 小时前';
    if (diff < 60 * 24 * 30) return Math.round(diff / 1440) + ' 天前';
    return new Date(iso).toLocaleDateString();
  }
  const fmtSize = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');
  // 正文字符数（去 frontmatter；契约 I3 底部字数口径）
  const stripFm = (content) => String(content ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '');
  const wordCount = (content) => stripFm(content).replace(/\s/g, '').length;

  /* ── 状态 ───────────────────────────────────── */
  const state = {
    ready: false,        // 索引就绪（N1 scanning→ready）
    entries: [],         // NoteIndexEntry[]（path/title/frontmatter/snippet/updatedAt）
    selectedDir: '',     // '' = 全部；否则筛选作用于子树（I2）
    typeFilter: '',      // '' = 全部类型（I14 双维过滤之二）
    query: '',           // 搜索词（非空 → 全局搜索态，I8）
    searchResults: null, // 搜索结果缓存（entries 形态）
    collapsed: new Set(),// 树折叠目录集
    extraDirs: new Set(),// 会话内新建的空目录（Q-075：树由 entries 派生，空目录补挂使其可见）
    trashMode: false,    // 回收站内联视图（I13）
    trashEntries: null,  // TrashEntry[] | null（惰性拉取）
    addingDir: false,    // 「+ 新建目录」内联输入态
    open: null,          // 编辑态：{ path, buffer, title, mtime, dirty, titleDirty, inflight, pendingAfter, conflict, editor }
  };
  let openSeq = 0;       // openNote 竞态守卫（连点两篇时仅最后一次生效）
  let saveTimer = null;
  const SAVE_DEBOUNCE_MS = 2000; // CON-R-notes-008：debounce ~2s
  let searchTimer = null;

  /* ── 桥调用包装（toResult 惯例：{ok,data}|{ok:false,code,message}；通道缺失/异常不崩溃）── */
  async function call(label, fn) {
    if (!api) return { ok: false, code: 'notes-bridge-missing', message: '笔记服务未就绪' };
    try { return await fn(api); }
    catch (e) { return { ok: false, code: 'notes-bridge-error', message: (e && e.message) || label + ' 调用失败' }; }
  }
  const bridge = {
    index: () => call('index', (a) => a.index()),
    get: (path) => call('get', (a) => a.get(path)),
    save: (input) => call('save', (a) => a.save(input)),
    create: (dir, title) => call('create', (a) => a.create(dir, title)), // 位置参数对齐 N1 通道表 dir/title（wire 形态 TBD-1，联调对齐点）
    mkdir: (dir) => call('mkdir', (a) => a.mkdir(dir)), // Q-075「+ 新建目录」（v1.1 集成期补获 notes:mkdir）
    rmdir: (dir) => call('rmdir', (a) => a.rmdir(dir)), // CON-R-notes-015 目录删除（仅空目录；N1 并行落地，未就绪走降级提示）
    move: (path, targetDir) => call('move', (a) => a.move(path, targetDir)),
    del: (path) => call('delete', (a) => (a.delete ?? a.del ?? a.deleteTask).call(a, path)),
    trashList: () => call('trashList', (a) => a.trashList()),
    restore: (trashId) => call('restore', (a) => a.restore(trashId)),
    purge: (trashId) => call('purge', (a) => a.purge(trashId)),
    search: (query) => call('search', (a) => a.search(query)),
  };

  /* ── N3 任务关联数据（feishu-n3-notes-api-contract.md v1.0）──
   * 候选/有效性判定 = kanban:getBoards + getTasks 组合聚合（TBD-1：N+1 次调用，量级可接受）；
   * 反查映射 = notes 索引 frontmatter.task 派生（无独立存储，CON-R-notes-002 精神）。
   * taskTickets=null ⇔ 看板数据未就绪 → 徽章中性占位、角标不显示（CON-R-notes-006），不标「未知任务」 */
  let taskTickets = null;        // TaskPickerItem[] | null
  let taskTicketsLoading = false;
  async function loadTaskTickets(force) {
    if (taskTicketsLoading || (taskTickets && !force)) return;
    taskTicketsLoading = true;
    try {
      const kb = window.kanban;
      if (!kb?.getBoards || !kb?.getTasks) { taskTickets = null; return; }
      const rb = await kb.getBoards();
      if (!rb || !rb.ok || !Array.isArray(rb.data)) { taskTickets = null; return; } // 依赖未就绪 → 降级态
      const items = [];
      for (const b of rb.data) {
        const rt = await kb.getTasks(b.id);
        if (rt && rt.ok && Array.isArray(rt.data)) {
          for (const t of rt.data) {
            // TBD-4 默认：已归档任务入选（id 仍可被 task: 引用且可跳详情），条目标注
            items.push({ id: t.id, title: t.title || '', boardName: b.name || b.id, updatedAt: t.updatedAt || t.createdAt || '', archived: !!t.archivedAt });
          }
        }
      }
      items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); // updatedAt 倒序
      taskTickets = items;
    } catch { taskTickets = null; } // 桥异常 = 依赖未就绪
    finally {
      // 就绪/数据到达 → 徽章/角标/相关笔记行统一刷新（CON-R-notes-006 就绪后统一刷新）
      renderList();
      if (state.open) renderEditorHead();
    }
  }
  const ticketExists = (tid) => !!taskTickets && taskTickets.some((t) => t.id === tid);
  /** task → 笔记列表 反查映射（派生自当前索引；值按 updatedAt 倒序）——kanban.js 消费（TBD-3 承接） */
  function taskNotesMap() {
    const m = new Map();
    for (const e of state.entries) {
      const tid = e.frontmatter?.task;
      if (!tid) continue; // task 空/解析失败的笔记不参与（契约 §数据结构）
      if (!m.has(tid)) m.set(tid, []);
      m.get(tid).push({ path: e.path, title: e.title || basename(e.path), updatedAt: e.updatedAt });
    }
    for (const arr of m.values()) arr.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return m;
  }

  /* ── 轻提示 ─────────────────────────────────── */
  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'nt-toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  /* ── 模态工厂（Esc/遮罩/✕ 关闭；dismissable=false 用于冲突分流——阻断直至用户选择）── */
  function ntModal({ title, bodyHtml, dismissable = true, onOpen }) {
    const wrap = document.createElement('div');
    wrap.className = 'nt-modal';
    wrap.innerHTML = `<div class="nt-modal-box"><h3>${esc(title)}</h3>${bodyHtml}</div>`;
    document.body.appendChild(wrap);
    const cleanups = [];
    const close = () => {
      if (!wrap.parentNode) return;
      while (cleanups.length) { try { cleanups.pop()(); } catch {} }
      wrap.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));
    if (dismissable) wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.kbOnClose = cleanups; // 关闭清理栈（镜像 kanban modal；调用方注册定时器/EasyMDE 清理）
    onOpen?.(wrap, close);
    return { wrap, close };
  }

  /* ── 挂载骨架（一次；后续全部局部渲染）───────── */
  function mount() {
    root.innerHTML = `
      <div class="notes-app">
        <aside class="nt-side">
          <div class="nt-head">
            <button class="nt-collapse" id="nt-collapse-tree" title="收起目录栏">«</button>
            <span class="nt-title">笔记<span class="nt-count" id="nt-count"></span></span>
            <button class="nt-btn" id="nt-new" title="新建笔记（继承当前目录）">＋ 新建笔记</button>
          </div>
          <div class="nt-search">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3" stroke-linecap="round"/></svg>
            <input id="nt-q" type="text" placeholder="搜索标题与内容…" autocomplete="off">
          </div>
          <div class="nt-hint">搜索为全局，不受目录筛选影响</div>
          <div class="nt-typebar" id="nt-typebar"></div>
          <div class="nt-treehead">
            <span class="nt-treehead-label">目录</span>
            <button class="nt-newdir" id="nt-newdir" title="新建目录，可用 / 建子目录">＋ 新建目录</button>
          </div>
          <div class="nt-tree" id="nt-tree"></div>
          <button class="nt-trash-entry" id="nt-trash-entry">🗑 回收站<span class="nt-trash-count" id="nt-trash-count" hidden></span></button>
        </aside>
        <button class="nt-ghost-strip" id="nt-strip-tree" title="展开目录栏" hidden>»</button>
        <div class="nt-resizer" id="nt-rz-tree" title="拖拽调整目录栏宽度"></div>
        <section class="nt-list">
          <div class="nt-list-head">
            <button class="nt-collapse" id="nt-collapse-list" title="收起列表栏">«</button>
            <div class="nt-list-head-main" id="nt-list-head-main"></div>
          </div>
          <div class="nt-items" id="nt-items"></div>
        </section>
        <button class="nt-ghost-strip" id="nt-strip-list" title="展开列表栏" hidden>«</button>
        <div class="nt-resizer" id="nt-rz-list" title="拖拽调整列表栏宽度"></div>
        <section class="nt-editor">
          <div class="nt-editor-head" id="nt-editor-head"></div>
          <div class="nt-editor-body" id="nt-editor-body"></div>
          <div class="nt-editor-foot" id="nt-editor-foot"></div>
        </section>
      </div>`;
    // 事件（一次绑定，委托于稳定容器）
    $('#nt-new').addEventListener('click', newNoteModal);
    $('#nt-q').addEventListener('input', onSearchInput);
    $('#nt-trash-entry').addEventListener('click', toggleTrash);
    $('#nt-tree').addEventListener('click', onTreeClick);
    $('#nt-items').addEventListener('click', onListClick);
    $('#nt-editor-head').addEventListener('click', onHeadClick);
    // ③ 折叠/展开/拖宽（宽度记忆 localStorage；拖拽中 body.nt-resizing 禁文本选中）
    $('#nt-collapse-tree').addEventListener('click', () => { ui.treeCollapsed = true; applyUi(); saveUi(); });
    $('#nt-strip-tree').addEventListener('click', () => { ui.treeCollapsed = false; applyUi(); saveUi(); });
    $('#nt-collapse-list').addEventListener('click', () => { ui.listCollapsed = true; applyUi(); saveUi(); });
    $('#nt-strip-list').addEventListener('click', () => { ui.listCollapsed = false; applyUi(); saveUi(); });
    bindResizer('#nt-rz-tree', '.nt-side', 120, 480, 'treeW', 'treeCollapsed');
    bindResizer('#nt-rz-list', '.nt-list', 150, 520, 'listW', 'listCollapsed');
    bindSplitDrag();
    applyUi();
    // #nt-newdir 绑定在 renderTreeHeadArea()——按钮态/内联输入态互切重渲染，绑定随渲染走
  }
  const $ = (sel, el) => (el || root).querySelector(sel);

  /* ── ③ 栏宽/折叠状态（localStorage 记忆；纯前端，无 IPC）── */
  const UI_KEY = 'notes:ui';
  const clampW = (w, min, max) => Math.min(Math.max(w, min), Math.max(min, Math.min(max, Math.floor(window.innerWidth * 0.45))));
  function loadUi() {
    const d = { treeW: 264, listW: 296, treeCollapsed: false, listCollapsed: false, splitRatio: 0.57 };
    try {
      const v = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
      return {
        treeW: clampW(Number(v.treeW) || d.treeW, 120, 480),
        listW: clampW(Number(v.listW) || d.listW, 150, 520),
        treeCollapsed: !!v.treeCollapsed,
        listCollapsed: !!v.listCollapsed,
        // ② 分屏比例（写侧占比）记忆：25%~75%
        splitRatio: Math.min(0.75, Math.max(0.25, Number(v.splitRatio) || d.splitRatio)),
      };
    } catch { return d; } // localStorage 不可用：默认宽度，功能不缺
  }
  const ui = loadUi();
  function saveUi() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* 隐私模式：仅会话内生效 */ } }
  function applyUi() {
    const side = $('.nt-side'), list = $('.nt-list');
    if (side) {
      side.style.display = ui.treeCollapsed ? 'none' : 'flex';
      side.style.width = ui.treeW + 'px';
    }
    if (list) {
      list.style.display = ui.listCollapsed ? 'none' : 'flex';
      list.style.width = ui.listW + 'px';
    }
    const rt = $('#nt-rz-tree'), rl = $('#nt-rz-list');
    if (rt) rt.style.display = ui.treeCollapsed ? 'none' : 'block';
    if (rl) rl.style.display = ui.listCollapsed ? 'none' : 'block';
    const st = $('#nt-strip-tree'), sl = $('#nt-strip-list');
    if (st) st.hidden = !ui.treeCollapsed;
    if (sl) sl.hidden = !ui.listCollapsed;
  }
  function bindResizer(rzSel, paneSel, min, max, wKey, collapseKey) {
    $(rzSel)?.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const pane = $(paneSel);
      if (!pane) return;
      const startX = e.clientX;
      const startW = pane.getBoundingClientRect().width;
      document.body.classList.add('nt-resizing'); // 拖拽中禁文本选中
      $(rzSel).classList.add('dragging');
      const move = (ev) => {
        pane.style.width = clampW(startW + (ev.clientX - startX), min, max) + 'px';
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.body.classList.remove('nt-resizing');
        $(rzSel).classList.remove('dragging');
        ui[wKey] = pane.getBoundingClientRect().width; // 拖拽即视为展开
        ui[collapseKey] = false;
        applyUi(); saveUi();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }
  /** ② 分屏分隔线拖拽：预览左缘 8px 命中区（CSS ::before）→ 实时调 --nt-split-ratio（25%~75%），记忆 localStorage */
  function bindSplitDrag() {
    $('#nt-editor-body').addEventListener('pointerdown', (e) => {
      const cont = $('#nt-editor-body .EasyMDEContainer');
      if (!cont || !cont.classList.contains('nt-split-on')) return;
      const preview = e.target.closest('.editor-preview-side');
      if (!preview) return;
      const pr = preview.getBoundingClientRect();
      if (e.clientX - pr.left > 12) return; // 仅左缘命中区触发，预览区交互不受影响
      e.preventDefault();
      const rect = cont.getBoundingClientRect();
      document.body.classList.add('nt-resizing'); // 拖拽中禁文本选中
      const move = (ev) => {
        ui.splitRatio = Math.min(0.75, Math.max(0.25, (ev.clientX - rect.left) / rect.width));
        cont.style.setProperty('--nt-split-ratio', String(ui.splitRatio));
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.body.classList.remove('nt-resizing');
        saveUi();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }
  /** 分屏比例变量落到容器（打开笔记/拖拽后调用；未打开为 no-op） */
  function applySplitRatio() {
    const cont = $('#nt-editor-body .EasyMDEContainer');
    if (cont) cont.style.setProperty('--nt-split-ratio', String(ui.splitRatio ?? 0.57));
  }

  /* ── 索引拉取（一次取数：树/列表/类型徽章全部由 entries 派生）── */
  let loaded = false;
  async function refreshIndex() {
    const r = await bridge.index();
    if (r && r.ok) {
      state.ready = !!r.data.ready;
      state.entries = Array.isArray(r.data.entries) ? r.data.entries : [];
      loaded = true;
    } else if (r && r.code === 'notes-bridge-missing') {
      state.ready = false; state.entries = []; state.noBridge = true;
    } else {
      toast('索引加载失败：' + ((r && r.message) || '可重试')); // 索引可重建——提示重试
    }
    renderAll();
    renderEditorEmptyState(); // N2 遗留修复：就绪且未选中 → 编辑器空态文案（不停留「正在加载」）
    window.__kanbanOnNotesChanged?.(); // N3：索引变化 → 看板侧徽章/相关笔记行统一重算（drawer 打开时重绘）
  }
  function renderAll() {
    renderCount();
    renderTypeBar();
    renderTree();
    if (state.trashMode) renderTrash(); else renderList();
    renderTrashCount();
  }
  function renderCount() {
    const el = $('#nt-count');
    if (el) el.textContent = state.entries.length ? '· ' + state.entries.length : '';
  }

  /* ── 目录树（entries[].path 派生；任意层级；子树计数；纯展示不自动归类）── */
  function deriveDirs() {
    const dirs = new Map([['', { name: '全部笔记', children: new Set() }]]);
    // 树挂载：任意路径段 → 目录行（父行 children 串联）；空段防御跳过
    const attach = (parts) => {
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/');
        if (!p) continue;
        if (!dirs.has(p)) dirs.set(p, { name: parts[i - 1], children: new Set() });
        const parent = i > 1 ? parts.slice(0, i - 1).join('/') : '';
        dirs.get(parent)?.children.add(p);
      }
    };
    for (const e of state.entries) attach(e.path.split('/').slice(0, -1)); // 文件段去掉基名
    for (const d of state.extraDirs) attach(d.split('/')); // 新建空目录（Q-075）
    for (const [p, d] of dirs) {
      d.count = p === ''
        ? state.entries.length
        : state.entries.filter((e) => e.path.startsWith(p + '/')).length;
    }
    return dirs;
  }
  function subtreeCount(path) {
    return state.entries.filter((e) => e.path.startsWith(path + '/')).length;
  }
  function renderTree() {
    const dirs = deriveDirs();
    const row = (path, name, depth, hasKids) => {
      const isOpen = !state.collapsed.has(path);
      // CON-R-notes-015：目录行 hover × 删除（仅空目录）；根「全部笔记」行除外
      const delBtn = path === '' ? '' : `<button class="nt-deldir" data-deldir="${esc(path)}" title="删除目录（仅空目录）">×</button>`;
      return `<div class="nt-trow ${state.selectedDir === path ? 'active' : ''}" data-dir="${esc(path)}" style="padding-left:${8 + depth * 14}px">
        <span class="nt-chev ${hasKids ? (isOpen ? 'open' : '') : 'empty'}" data-chev="${esc(path)}">▸</span>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.4 1.5H13a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5z"/></svg>
        <span class="nt-tname">${esc(name)}</span>
        <span class="nt-tcount">${path === '' ? state.entries.length : subtreeCount(path)}</span>
        ${delBtn}
      </div>` + (hasKids && isOpen ? [...dirs.get(path).children].sort().map((k) => row(k, dirs.get(k).name, depth + 1, dirs.get(k).children.size > 0)).join('') : '');
    };
    $('#nt-tree').innerHTML = row('', '全部笔记', 0, dirs.get('').children.size > 0);
  }
  /** 树点击：chevron 单击 = 折叠切换；行单击 = 选中筛选；
   *  ② 双击手势 = 同一行 350ms 内两次点击 → 切换折叠。
   *  不用原生 dblclick：单击处理器会重建树 DOM，原生 dblclick 因两击目标节点不同而不再合成（实测） */
  let lastTreeClick = { t: 0, dir: '' };
  function onTreeClick(e) {
    // CON-R-notes-015：目录行 × 删除（仅空目录；不进回收站，直接删）
    const delBtn = e.target.closest('[data-deldir]');
    if (delBtn) { deleteDirModal(delBtn.dataset.deldir); return; }
    const chev = e.target.closest('[data-chev]');
    if (chev) {
      // 根节点 data-chev=""（空串）：必须用 !== undefined 判别，if (p) 会把根节点折叠静默跳过
      const p = chev.dataset.chev;
      if (p !== undefined) state.collapsed.has(p) ? state.collapsed.delete(p) : state.collapsed.add(p);
      renderTree();
      return;
    }
    const r = e.target.closest('.nt-trow');
    if (!r) return;
    const dir = r.dataset.dir || '';
    const now = Date.now();
    // 根节点 dir='' 同样参与双击手势（空串是合法键；折叠语义由 chev 非 empty 守卫）
    const dbl = lastTreeClick.dir === dir && now - lastTreeClick.t < 350;
    lastTreeClick = dbl ? { t: 0, dir: '' } : { t: now, dir };
    if (dbl) {
      // 双击手势：切换折叠（仅含子目录的行有折叠语义，平铺目录行 chev empty 直接跳过）
      const chev = r.querySelector('.nt-chev');
      if (chev && !chev.classList.contains('empty')) {
        state.collapsed.has(dir) ? state.collapsed.delete(dir) : state.collapsed.add(dir);
      }
    }
    state.selectedDir = dir;
    renderTree(); renderList();
  }
  function renderTreeHeadArea() {
    // 「+ 新建目录」内联输入（②改版：只填名称，建在当前选中目录下；Enter 提交 / Esc 取消）
    const head = $('.nt-treehead');
    const parent = state.selectedDir || '';
    if (state.addingDir) {
      head.innerHTML = `<input class="nt-newdir-input" id="nt-newdir-input" placeholder="在 ${parent ? parent + '/' : '根目录'} 下新建，只填名称" autocomplete="off">`;
      $('#nt-newdir-input').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { state.addingDir = false; renderTreeHeadArea(); }
        if (e.key === 'Enter') submitNewDir(e.target.value);
      });
      $('#nt-newdir-input').focus();
    } else {
      head.innerHTML = `<span class="nt-treehead-label">目录</span><button class="nt-newdir" id="nt-newdir">＋ 新建目录</button>`;
      $('#nt-newdir').addEventListener('click', () => { state.addingDir = true; renderTreeHeadArea(); });
    }
  }

  /** CON-R-notes-015 目录删除（仅空目录）：一次确认 → bridge.rmdir。
   *  非空拒绝用渲染层预检（subtreeCount 可判定，不依赖 rmdir 通道时序）；通道未就绪 → 降级提示。
   *  被删目录为当前选中目录 → 选中回退根 */
  function deleteDirModal(dir) {
    if (!dir) return;
    ntModal({
      title: '删除目录',
      bodyHtml: `<p class="nt-modal-msg">删除目录 <b>${esc(dir)}/</b>？<b>仅空目录可删</b>，删除后不可恢复（不含回收站）。</p>
        <div class="nt-modal-ops"><button class="nt-ghost" data-x>取消</button><button class="nt-primary danger" data-ok>删除</button></div>`,
      onOpen(w, close) {
        $('[data-x]', w).addEventListener('click', close);
        $('[data-ok]', w).addEventListener('click', async () => {
          close();
          if (subtreeCount(dir) > 0) { toast('目录非空：先移空笔记/子目录再删'); return; }
          if (typeof api?.rmdir !== 'function') { toast('目录删除通道未就绪（等待 N1 rmdir 落地）'); return; }
          const r = await bridge.rmdir(dir);
          if (r && r.ok) {
            state.extraDirs.delete(dir);
            if (state.selectedDir === dir || state.selectedDir.startsWith(dir + '/')) state.selectedDir = ''; // 选中回退根
            refreshIndex();
            toast('已删除目录 ' + dir + '/');
          } else if (r && (r.code === 'notes-dir-not-empty' || /非空|not-empty/i.test(r.message || ''))) {
            toast('目录非空：先移空笔记/子目录再删'); // N1 校验兜底（预检与落地间隙有新笔记时）
          } else {
            toast('删除目录失败：' + ((r && r.message) || '可重试'));
          }
        });
      },
    });
  }

  async function submitNewDir(raw) {
    // ② 交互改版：名称单段（禁 /），创建位置 = 当前选中目录（未选中 → 根目录）；多级用「选中父目录后逐级建」
    const name = String(raw || '').trim();
    state.addingDir = false;
    renderTreeHeadArea();
    if (!name) return;
    if (name.includes('/')) { toast('目录名不能包含 /——先选中父目录，再只填名称'); renderTreeHeadArea(); return; }
    const parent = state.selectedDir || '';
    const fullPath = parent ? parent + '/' + name : name;
    const r = await bridge.mkdir(fullPath);
    if (r && r.ok) {
      toast('已在 ' + (parent ? parent + '/' : '根目录') + ' 创建 ' + name + '/');
      state.extraDirs.add(fullPath); // 空目录补挂保证可见（Q-075）
      state.selectedDir = fullPath;  // 建完选中，便于直接新建笔记进去
      refreshIndex();
    } else {
      toast('创建目录失败：' + ((r && r.message) || (r && r.code) || '未知错误'));
    }
  }

  /* ── type 过滤徽章（I14：与目录筛选双维过滤；类型由 entries 派生）── */
  function renderTypeBar() {
    const types = [...new Set(state.entries.map((e) => e.frontmatter?.type).filter(Boolean))].sort();
    const chip = (val, label) => `<button class="nt-typechip ${state.typeFilter === val ? 'active' : ''}" data-type="${esc(val)}" title="${esc(label)}">${esc(label)}</button>`;
    $('#nt-typebar').innerHTML = chip('', '全部') + types.map((t) => chip(t, t)).join('');
    $('#nt-typebar').onclick = (e) => {
      const b = e.target.closest('.nt-typechip');
      if (!b) return;
      state.typeFilter = b.dataset.type || '';
      renderTypeBar(); renderList();
    };
  }

  /* ── 列表（updatedAt 倒序；搜索态为全局结果）── */
  function visibleEntries() {
    let list;
    if (state.query) {
      list = state.searchResults || [];
    } else {
      list = state.entries.slice();
      if (state.selectedDir) list = list.filter((e) => e.path.startsWith(state.selectedDir + '/'));
      if (state.typeFilter) list = list.filter((e) => e.frontmatter?.type === state.typeFilter);
      list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }
    return list;
  }
  function itemHtml(e) {
    const active = state.open && state.open.path === e.path ? 'active' : '';
    // N3 徽章三态：有效关联（可点跳看板详情）/ 未知任务（灰色不可点不清洗）/ 未就绪中性占位
    const tid = e.frontmatter?.task;
    let taskBadge = '';
    if (tid) {
      if (!taskTickets) taskBadge = `<span class="nt-badge task pending" title="看板数据未就绪">⧉ ${esc(tid)}</span>`;
      else if (ticketExists(tid)) taskBadge = `<span class="nt-badge task jump" data-tid="${esc(tid)}" title="打开看板任务详情">⧉ ${esc(tid)}</span>`;
      else taskBadge = `<span class="nt-badge task unknown" title="看板中未找到该任务（字段保留不清洗）">⧉ ${esc(tid)} 未知任务</span>`;
    }
    return `<div class="nt-item ${active}" data-path="${esc(e.path)}">
      <div class="nt-item-top"><div class="nt-item-title">${esc(e.title)}</div></div>
      <div class="nt-item-snippet">${esc(e.snippet || '（无正文）')}</div>
      <div class="nt-item-meta">
        ${dirname(e.path) ? `<span class="nt-path">${esc(dirname(e.path))}/</span>` : ''}
        ${e.frontmatter?.type ? `<span class="nt-badge">${esc(e.frontmatter.type)}</span>` : ''}
        ${taskBadge}
        <span>${relTime(e.updatedAt)}</span>
      </div>
    </div>`;
  }
  function renderList() {
    const head = $('#nt-list-head-main');
    if (state.trashMode) return; // 回收站态由 renderTrash 接管
    if (!loaded) { head.innerHTML = `<span class="nt-list-title">笔记</span>`; $('#nt-items').innerHTML = `<div class="nt-empty"><div class="nt-empty-ico">⌛</div><p>${state.noBridge ? '笔记服务未就绪（存储桥未加载）' : '正在扫描笔记…'}</p><p class="nt-empty-sub">${state.noBridge ? '等待 N1 集成后可用' : '就绪后自动刷新'}</p></div>`; return; }
    const list = visibleEntries();
    if (state.query) {
      head.innerHTML = `<span class="nt-list-title">搜索结果<span class="nt-count">· ${list.length}</span></span>`;
    } else {
      head.innerHTML = `<span class="nt-list-title">笔记<span class="nt-count">· ${list.length}</span></span>`;
    }
    if (!list.length) {
      $('#nt-items').innerHTML = state.query
        ? `<div class="nt-empty"><div class="nt-empty-ico">⌕</div><p>没有匹配的笔记</p><p class="nt-empty-sub">搜索为全局（含所有目录），换个关键词试试</p></div>`
        : (state.selectedDir
          ? `<div class="nt-empty"><div class="nt-empty-ico">📁</div><p>此目录为空</p><p class="nt-empty-sub">用右上角「＋ 新建」在这里写第一篇</p></div>`
          : `<div class="nt-empty"><div class="nt-empty-ico">📝</div><p>还没有笔记</p><button class="nt-btn" id="nt-empty-new">＋ 新建第一篇</button></div>`);
      $('#nt-empty-new')?.addEventListener('click', newNoteModal);
      return;
    }
    $('#nt-items').innerHTML = list.map(itemHtml).join('');
  }
  function onListClick(e) {
    if (state.trashMode) {
      const b = e.target.closest('[data-restore]') || e.target.closest('[data-purge]');
      if (!b) return;
      if (b.dataset.restore) restoreEntry(b.dataset.restore);
      else purgeEntry(b.dataset.purge);
      return;
    }
    // N3：有效关联徽章 → 切看板视图打开 ticket 详情（不触发笔记打开）
    const badge = e.target.closest('.nt-badge.task.jump');
    if (badge) { jumpToTask(badge.dataset.tid); return; }
    const item = e.target.closest('.nt-item');
    if (item) openNote(item.dataset.path);
  }

  /* ── 搜索（I8：输入即搜，全局；空查询回常规列表）── */
  function onSearchInput(e) {
    const q = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.query = q.trim();
      if (!state.query) { state.searchResults = null; renderList(); return; }
      const r = await bridge.search(state.query);
      if (r && r.ok) { state.searchResults = r.data.entries || []; if (state.query === q.trim()) renderList(); }
      else toast('搜索失败：' + ((r && r.message) || '可重试'));
    }, 250);
  }

  /* ── 回收站（I13：底部入口含数量；内联视图；恢复冲突不覆盖；purge 二次确认）── */
  function renderTrashCount() {
    const el = $('#nt-trash-count');
    if (!el) return;
    const n = state.trashEntries ? state.trashEntries.length : null;
    if (n === null) { el.hidden = true; return; }
    el.hidden = n === 0;
    el.textContent = String(n);
  }
  async function refreshTrashCount() {
    const r = await bridge.trashList();
    if (r && r.ok) { state.trashEntries = r.data.entries || []; renderTrashCount(); }
  }
  async function toggleTrash() {
    flushSave(); // 内联视图切换也属「切换」——先 flush（CON-R-notes-008）
    state.trashMode = !state.trashMode;
    if (state.trashMode) { const r = await bridge.trashList(); state.trashEntries = r && r.ok ? (r.data.entries || []) : []; }
    renderAll();
  }
  function renderTrash() {
    $('#nt-list-head-main').innerHTML = `<span class="nt-list-title">回收站</span><button class="nt-back" id="nt-trash-back">← 返回列表</button>`;
    $('#nt-trash-back').addEventListener('click', () => { state.trashMode = false; renderAll(); });
    const list = state.trashEntries || [];
    $('#nt-items').innerHTML = list.length
      ? list.map((t) => `<div class="nt-trash-item">
          <div class="nt-trash-info">
            <div class="nt-trash-path">${esc(t.originalPath)}</div>
            <div class="nt-trash-meta">删除于 ${relTime(t.deletedAt)} · ${fmtSize(t.sizeBytes)}</div>
          </div>
          <div class="nt-trash-ops">
            <button class="nt-mini" data-restore="${esc(t.id)}">恢复</button>
            <button class="nt-mini danger" data-purge="${esc(t.id)}">彻底删除</button>
          </div>
        </div>`).join('')
      : `<div class="nt-empty"><div class="nt-empty-ico">🗑</div><p>回收站为空</p><p class="nt-empty-sub">删除的笔记在这里保留 30 天，可恢复</p></div>`;
  }
  async function restoreEntry(trashId) {
    const r = await bridge.restore(trashId);
    if (r && r.ok) {
      toast('已恢复到原路径');
      state.trashEntries = null;
      await refreshTrashCount();
      refreshIndex();
      if (state.trashMode) renderTrash();
    } else if (r && r.code === 'notes-restore-conflict') {
      toast('恢复冲突：原路径已被占用，未覆盖（条目保留在回收站）'); // CON-R-notes-007
    } else {
      toast('恢复失败：' + ((r && r.message) || '可重试'));
    }
  }
  function purgeEntry(trashId) {
    ntModal({
      title: '彻底删除',
      bodyHtml: `<p class="nt-modal-msg">将永久删除回收站中的这条笔记，<b>不可恢复</b>。确定继续？</p>
        <div class="nt-modal-ops"><button class="nt-ghost" data-x>取消</button><button class="nt-primary danger" data-ok>彻底删除</button></div>`,
      onOpen(w, close) {
        $('[data-x]', w).addEventListener('click', close);
        $('[data-ok]', w).addEventListener('click', async () => {
          const r = await bridge.purge(trashId);
          close();
          if (r && r.ok) { state.trashEntries = null; await refreshTrashCount(); if (state.trashMode) renderTrash(); toast('已彻底删除'); }
          else toast('删除失败：' + ((r && r.message) || '可重试'));
        });
      },
    });
  }

  /* ── 打开/关闭编辑器（I4/I15/I16；EasyMDE 每开新建、关即 destroy）── */
  async function openNote(path) {
    if (!path) return;
    const seq = ++openSeq;
    // 切换先 flush（契约：先 flush 再切换，无确认弹窗）——buffer 快照同步持有，切换销毁编辑器不影响在途保存
    flushSave();
    const r = await bridge.get(path);
    if (seq !== openSeq) return; // 连点守卫：仅最后一次打开生效
    if (!r || !r.ok) { toast('打开失败：' + ((r && r.message) || '文件可能已被移动或删除')); refreshIndex(); return; }
    const d = r.data;
    destroyEditor();
    state.open = {
      path: d.path,
      buffer: d.content ?? '',
      title: d.frontmatter?.title || basename(d.path).replace(/\.md$/, ''),
      frontmatter: d.frontmatter ?? {}, // N3：type/task chips 与关联回写的数据源（N2 遗留缺口修复）
      mtime: d.mtime,
      dirty: false, titleDirty: false, inflight: false, pendingAfter: false, conflict: null,
      editor: null,
    };
    renderEditorHead();
    $('#nt-editor-body').innerHTML = '<textarea id="nt-editor-text"></textarea>';
    state.open.editor = createEditor($('#nt-editor-text'), state.open.buffer);
    const ed = state.open.editor;
    if (ed) {
      ed.codemirror.on('change', () => {
        if (!state.open) return;
        state.open.buffer = ed.value();
        state.open.dirty = true;
        applyFrontmatterFade(); // ④ frontmatter 块随输入保持淡化
        renderFoot(); scheduleSave();
      });
      ed.codemirror.on('blur', () => flushSave()); // 编辑器失焦 → 立即 flush（CON-R-notes-008）
      ed.codemirror.focus();
    }
    // 工具栏内置预览/分屏切换 → 头部三态高亮同步（①：保证分屏态随时可经头部切回编辑/预览）
    $('#nt-editor-body .EasyMDEContainer')?.addEventListener('click', () => setTimeout(syncEditorModeFromEditor, 50));
    applySplitRatio(); // ② 分屏比例变量落容器（grid 列宽用）
    applyEditorMode(editorMode);
    applyFrontmatterFade();
    renderFoot();
    renderList(); // 列表 active 高亮
  }
  function closeEditor() {
    destroyEditor();
    state.open = null;
    renderEditorHead();
    $('#nt-editor-body').innerHTML = `<div class="nt-editor-empty"><div class="nt-empty" style="padding:0"><div class="nt-empty-ico">📝</div><p>从左侧选择或新建一篇笔记</p></div></div>`;
    renderFoot();
    renderList();
  }
  function destroyEditor() {
    if (state.open?.editor) { try { state.open.editor.destroy(); } catch {} }
    state.open && (state.open.editor = null);
  }
  function createEditor(textarea, initialValue) {
    if (!window.EasyMDE || !textarea) return null;
    return new window.EasyMDE({
      element: textarea,
      initialValue: initialValue ?? '',
      spellChecker: false,
      autoDownloadFontAwesome: false, // E14/Q-042：禁运行时 FA CDN 注入（CSP）
      status: false,
      // ① BUG 修复（真机反馈）：sideBySideFullscreen 默认 true → 分屏即全屏接管（fixed 预览盖住头部模式开关，用户被困）。
      // false → 容器持 sided--no-fullscreen 行内分屏（vendor CSS 既有布局），模式开关常驻可退。
      sideBySideFullscreen: false,
      toolbar: ['bold', 'italic', 'strikethrough', 'heading', '|', 'unordered-list', 'ordered-list', 'check-list', 'table', '|', 'link', '|', 'preview', 'side-by-side'],
      // ④ 预览态：frontmatter 不进预览（头部 chips 已承载其信息）；空正文给淡提示
      previewRender: (plainText) => {
        const body = stripFm(plainText);
        return body.trim() ? mdRender(body) : '<p class="nt-preview-empty">（无正文）</p>';
      },
    });
  }
  /** ④ 编辑/分屏态 frontmatter 弱化：块内文本 markText 淡色（IDE frontmatter 观感；行级操作，随输入重打） */
  function applyFrontmatterFade() {
    const o = state.open;
    if (!o?.editor) return;
    const cm = o.editor.codemirror;
    if (o.fmMark) { try { o.fmMark.clear(); } catch {} o.fmMark = null; }
    const m = o.buffer.match(/^---\n[\s\S]*?\n---/);
    if (!m) return;
    const endLine = m[0].split('\n').length; // 含首尾 ---，标记至块尾行首
    try { o.fmMark = cm.markText({ line: 0, ch: 0 }, { line: endLine, ch: 0 }, { className: 'nt-fm' }); } catch { /* 越界防御 */ }
  }
  /** 编辑器工具栏内置 preview/side-by-side 按钮与本头部三态开关的状态同步（用户点工具栏切换时校正高亮） */
  function syncEditorModeFromEditor() {
    const ed = state.open?.editor;
    if (!ed) return;
    const m = ed.isSideBySideActive() ? 'split' : ed.isPreviewActive() ? 'preview' : 'edit';
    if (m !== editorMode) {
      editorMode = m;
      document.querySelectorAll('.nt-mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    }
    updateSplitClass();
    applySplitRatio();
  }
  let editorMode = 'edit';
  function updateSplitClass() {
    // ②/③：grid 分屏布局仅 split 态启用（JS 切换类，避免 :has 依赖与编辑态误入 grid）
    $('#nt-editor-body .EasyMDEContainer')?.classList.toggle('nt-split-on', editorMode === 'split');
  }
  function applyEditorMode(mode) {
    editorMode = mode;
    document.querySelectorAll('.nt-mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    const ed = state.open?.editor;
    if (!ed) { updateSplitClass(); return; }
    const isPreview = !!ed.isPreviewActive();
    const isSplit = !!ed.isSideBySideActive();
    if (mode === 'preview') { if (isSplit) ed.toggleSideBySide(); if (!isPreview) ed.togglePreview(); }
    else if (mode === 'split') { if (isPreview) ed.togglePreview(); if (!isSplit) ed.toggleSideBySide(); }
    else { if (isPreview) ed.togglePreview(); if (isSplit) ed.toggleSideBySide(); }
    updateSplitClass();
    applySplitRatio();
  }

  function renderEditorHead() {
    const head = $('#nt-editor-head');
    const o = state.open;
    if (!o) {
      head.innerHTML = `<div class="nt-chips"><span class="nt-chip">未打开笔记</span>
        <div class="nt-mode-switch" style="display:none"></div></div>`;
      return;
    }
    head.innerHTML = `
      <div class="nt-chips">
        <input class="nt-title-input" id="nt-title" value="${esc(o.title)}" placeholder="标题（写入 frontmatter，不改文件名）" spellcheck="false">
        <div class="nt-mode-switch">
          <button class="nt-mode-btn ${editorMode === 'edit' ? 'active' : ''}" data-mode="edit">编辑</button>
          <button class="nt-mode-btn ${editorMode === 'split' ? 'active' : ''}" data-mode="split">分屏</button>
          <button class="nt-mode-btn ${editorMode === 'preview' ? 'active' : ''}" data-mode="preview">预览</button>
        </div>
      </div>
      <div class="nt-chips">
        ${o.frontmatter?.type ? `<span class="nt-chip">${esc(o.frontmatter.type)}</span>` : ''}
        ${taskChipHtml(o)}
        <span class="nt-chip" title="相对 notes.dir 的路径">${esc(o.path)}</span>
        <button class="nt-opbtn" id="nt-link" title="搜索看板任务并关联（写入 frontmatter task:）">＋ 关联任务</button>
        <button class="nt-opbtn" id="nt-move">移动到…</button>
        <button class="nt-opbtn danger" id="nt-del">删除</button>
      </div>`;
    const title = $('#nt-title');
    title.addEventListener('input', () => {
      if (!state.open) return;
      state.open.title = title.value;
      state.open.titleDirty = true;
      state.open.dirty = true;
      renderFoot(); scheduleSave();
    });
    title.addEventListener('blur', () => flushSave()); // 失焦 flush
    $('#nt-move').addEventListener('click', moveModal);
    $('#nt-del').addEventListener('click', deleteNoteModal);
    $('#nt-link').addEventListener('click', taskPickerModal);
  }
  /** 编辑器任务 chip 三态（N3）：有效关联（可点跳详情 + × 解除）/ 未知任务（灰、仅 ×）/ 未就绪中性占位 */
  function taskChipHtml(o) {
    const tid = o.frontmatter?.task;
    if (!tid) return '';
    if (!taskTickets) return `<span class="nt-chip task pending" title="看板数据未就绪">⧉ ${esc(tid)}</span>`;
    if (!ticketExists(tid)) {
      // CON-R-notes-006：灰色「未知任务」，不可点击跳转、不清洗字段；× 仍可解除关联
      return `<span class="nt-chip task unknown" title="看板中未找到该任务（字段保留）">⧉ ${esc(tid)} 未知任务<span class="unlink" data-unlink title="解除关联">×</span></span>`;
    }
    return `<span class="nt-chip task" data-tid="${esc(tid)}" title="打开看板任务详情">⧉ ${esc(tid)}<span class="unlink" data-unlink title="解除关联">×</span></span>`;
  }
  function onHeadClick(e) {
    // N3：× 解除关联（含未知任务态——字段清洗仍走保存链，可被再次编辑）
    const un = e.target.closest('[data-unlink]');
    if (un) { e.stopPropagation(); setTaskLink(null); return; }
    // N3：有效关联 chip 点击 → 切看板视图打开 ticket 详情（T3-06；未知任务 chip 无 data-tid 不可点）
    const chip = e.target.closest('.nt-chip.task[data-tid]');
    if (chip && !chip.classList.contains('unknown')) { jumpToTask(chip.dataset.tid); return; }
    const b = e.target.closest('.nt-mode-btn');
    if (b) applyEditorMode(b.dataset.mode);
  }
  function onDateChange() { /* T2 契约字段占位：N2 v1 无日期选择器 */ }
  function renderFoot() {
    const o = state.open;
    const foot = $('#nt-editor-foot');
    if (!o) { foot.innerHTML = `<span>—</span>`; return; }
    const status = o.conflict
      ? `<span class="nt-right nt-dirty">⚠ 冲突待处理（自动保存已暂停）</span>`
      : o.inflight
        ? `<span class="nt-right">保存中…</span>`
        : o.dirty
          ? `<span class="nt-right nt-dirty">● 未保存（${SAVE_DEBOUNCE_MS / 1000}s 后自动保存）</span>`
          : `<span class="nt-right nt-saved">✓ 已保存</span>`;
    foot.innerHTML = `<span>${wordCount(o.buffer)} 字</span>${status}`;
  }

  /* ── 自动保存编排（I5/I6/I7；D4：渲染层 debounce + notes:save 乐观锁）── */
  function scheduleSave() {
    if (!state.open || state.open.conflict) return; // 冲突态阻断自动保存直至用户选择
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushSave(), SAVE_DEBOUNCE_MS);
  }
  async function flushSave() {
    const o = state.open;
    if (!o || !o.dirty || o.conflict || o.inflight) { if (o && o.inflight && o.dirty) o.pendingAfter = true; return; }
    o.inflight = true; renderFoot();
    const input = {
      path: o.path,
      content: o.buffer,
      expectedMtime: o.mtime,
      ...(o.titleDirty ? { frontmatterPatch: { title: o.title } } : {}),
    };
    const r = await bridge.save(input);
    if (!state.open || state.open !== o) return; // 切换/关闭后丢弃陈旧响应（buffer 快照已入 input）
    o.inflight = false;
    if (r && r.ok) {
      o.mtime = r.data.mtime;
      if (r.data.path && r.data.path !== o.path) o.path = r.data.path; // saveAsCopy 后基线切到副本
      if (!o.dirty) o.titleDirty = false;
      renderFoot();
    } else {
      const code = r && r.code;
      if (code === 'notes-conflict-modified') enterConflict('modified');
      else if (code === 'notes-conflict-deleted') enterConflict('deleted');
      else { toast('保存失败：' + ((r && r.message) || code || '未知错误') + '（内容已保留）'); renderFoot(); }
    }
    if (o.pendingAfter) { o.pendingAfter = false; scheduleSave(); }
  }
  function enterConflict(kind) {
    const o = state.open;
    if (!o) return;
    o.conflict = kind;
    clearTimeout(saveTimer);
    renderFoot();
    if (kind === 'modified') {
      ntModal({
        title: '保存冲突：文件已被外部修改',
        dismissable: false,
        bodyHtml: `<p class="nt-modal-msg">「${esc(o.path)}」在编辑期间被外部修改（Obsidian / 其他编辑器 / agent）。请选择处理方式：</p>
          <div class="nt-modal-ops">
            <button class="nt-primary danger" data-c="overwrite">覆盖外部修改</button>
            <button class="nt-primary" data-c="saveAsCopy">另存冲突副本</button>
            <button class="nt-ghost" data-c="discard">放弃我的修改</button>
          </div>`,
        onOpen(w, close) {
          w.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-c]');
            if (!b) return;
            const strategy = b.dataset.c;
            close();
            if (strategy === 'discard') { await discardBuffer(); return; }
            await resolveConflict(strategy);
          });
        },
      });
    } else {
      ntModal({
        title: '保存冲突：文件已被外部删除',
        dismissable: false,
        bodyHtml: `<p class="nt-modal-msg">「${esc(o.path)}」已不存在（被外部删除或移动）。编辑缓冲仍保留，可选择另存为新文件，或放弃：</p>
          <div class="nt-modal-ops">
            <button class="nt-primary" data-c="saveAsCopy">另存为新文件</button>
            <button class="nt-ghost" data-c="discard">放弃</button>
          </div>`,
        onOpen(w, close) {
          w.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-c]');
            if (!b) return;
            const strategy = b.dataset.c;
            close();
            if (strategy === 'discard') { closeEditor(); return; }
            await resolveConflict(strategy);
          });
        },
      });
    }
  }
  async function resolveConflict(strategy) {
    const o = state.open;
    if (!o) return;
    const input = {
      path: o.path, content: o.buffer, expectedMtime: o.mtime, strategy,
      ...(o.titleDirty ? { frontmatterPatch: { title: o.title } } : {}),
    };
    const r = await bridge.save(input);
    if (!state.open || state.open !== o) return;
    if (r && r.ok) {
      o.conflict = null;
      o.mtime = r.data.mtime;
      if (r.data.path && r.data.path !== o.path) {
        o.path = r.data.path;
        renderEditorHead(); // 副本路径 → 头部 chips 重渲染
      }
      o.dirty = false; o.titleDirty = false;
      renderFoot(); refreshIndex();
      toast(strategy === 'saveAsCopy' ? '已另存为冲突副本' : '已覆盖外部修改');
    } else if (r && r.code === 'notes-conflict-deleted') {
      // overwrite 时文件恰好又被删 → 转二选
      o.conflict = null;
      enterConflict('deleted');
    } else {
      o.conflict = null; // 非冲突失败：解除阻断，允许继续自动保存重试
      toast('保存失败：' + ((r && r.message) || '可重试') + '（内容已保留）');
      renderFoot();
    }
  }
  async function discardBuffer() {
    const o = state.open;
    if (!o) return;
    const r = await bridge.get(o.path); // 回读磁盘态（放弃 = 以磁盘为准）
    if (r && r.ok) {
      destroyEditor();
      o.buffer = r.data.content ?? '';
      o.title = r.data.frontmatter?.title || basename(o.path).replace(/\.md$/, '');
      o.mtime = r.data.mtime;
      o.dirty = false; o.titleDirty = false; o.conflict = null;
      o.editor = createEditor($('#nt-editor-text'), o.buffer);
      if (o.editor) {
        o.editor.codemirror.on('change', () => { o.buffer = o.editor.value(); o.dirty = true; applyFrontmatterFade(); renderFoot(); scheduleSave(); });
        o.editor.codemirror.on('blur', () => flushSave());
      }
      $('#nt-editor-body .EasyMDEContainer')?.addEventListener('click', () => setTimeout(syncEditorModeFromEditor, 50));
      applyFrontmatterFade();
      renderEditorHead(); renderFoot();
    } else {
      closeEditor(); // 磁盘上已不存在 → 回列表态
    }
  }

  /* ── 操作：新建 / 移动 / 删除（I9/I11/I12）── */
  function newNoteModal() {
    const dir = state.selectedDir || '';
    ntModal({
      title: '新建笔记',
      bodyHtml: `<p class="nt-modal-msg">存入 <b>${esc(dir || '根目录（未分类）')}</b>；命名 YYYY-MM-DD-&lt;slug&gt;.md，slug 由标题生成，标题可留空。</p>
        <input class="nt-modal-input" id="nt-new-title" placeholder="标题（可选）" autocomplete="off">
        <div class="nt-modal-ops"><button class="nt-ghost" data-x>取消</button><button class="nt-primary" data-ok>创建</button></div>`,
      onOpen(w, close) {
        const inp = $('#nt-new-title', w);
        inp.focus();
        $('[data-x]', w).addEventListener('click', close);
        const ok = async () => {
          const title = inp.value.trim();
          const r = await bridge.create(dir || undefined, title || undefined);
          if (r && r.ok) {
            close();
            await refreshIndex();
            openNote(r.data.path); // 成功后直接进入编辑态（契约 I9）
          } else if (r && r.code === 'notes-name-conflict') {
            toast('同名笔记已存在，请换一个标题'); // 同目录同名 UI 拦截（§7）
          } else {
            toast('创建失败：' + ((r && r.message) || '可重试'));
          }
        };
        $('[data-ok]', w).addEventListener('click', ok);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      },
    });
  }
  function moveModal() {
    const o = state.open;
    if (!o) return;
    const dirs = [...deriveDirs().keys()].sort();
    const cur = dirname(o.path);
    ntModal({
      title: '移动到…',
      bodyHtml: `<p class="nt-modal-msg">移动「${esc(o.title)}」到目标目录（同名冲突不覆盖）：</p>
        <select class="nt-modal-input" id="nt-move-target">${dirs.map((d) => `<option value="${esc(d)}" ${d === cur ? 'selected' : ''}>${esc(d || '根目录（未分类）')}</option>`).join('')}</select>
        <div class="nt-modal-ops"><button class="nt-ghost" data-x>取消</button><button class="nt-primary" data-ok>移动</button></div>`,
      onOpen(w, close) {
        $('[data-x]', w).addEventListener('click', close);
        $('[data-ok]', w).addEventListener('click', async () => {
          const target = $('#nt-move-target', w).value;
          if (target === cur) { close(); return; }
          const r = await bridge.move(o.path, target);
          close();
          if (r && r.ok) {
            o.path = r.data.path; o.mtime = r.data.mtime;
            renderEditorHead(); renderFoot();
            refreshIndex();
            toast('已移动到 ' + (target ? target + '/' : '根目录'));
          } else if (r && r.code === 'notes-name-conflict') {
            toast('目标目录存在同名文件，未移动');
          } else {
            toast('移动失败：' + ((r && r.message) || '可重试'));
          }
        });
      },
    });
  }
  function deleteNoteModal() {
    const o = state.open;
    if (!o) return;
    ntModal({
      title: '删除笔记',
      bodyHtml: `<p class="nt-modal-msg">删除「${esc(o.title)}」？<b>可在回收站恢复</b>（保留 30 天）。</p>
        <div class="nt-modal-ops"><button class="nt-ghost" data-x>取消</button><button class="nt-primary danger" data-ok>删除</button></div>`,
      onOpen(w, close) {
        $('[data-x]', w).addEventListener('click', close);
        $('[data-ok]', w).addEventListener('click', async () => {
          const r = await bridge.del(o.path);
          close();
          if (r && r.ok) {
            closeEditor();
            await refreshTrashCount();
            refreshIndex();
            toast('已移入回收站，可在回收站恢复');
          } else {
            toast('删除失败：' + ((r && r.message) || '可重试'));
          }
        });
      },
    });
  }

  /* ── N3 任务关联交互（feishu-n3-notes-api-contract.md v1.0）── */

  /** 笔记 → 任务跳转（T3-06）：hull:showBoard 切视图 → 看板内部入口打开 ticket 详情（TBD-2 承接：window.__kanbanOpenDetail） */
  async function jumpToTask(tid) {
    if (!tid) return;
    try { await window.hull?.showBoard?.(); } catch { /* 桥缺失：高亮本地同步，详情仍尝试打开 */ }
    try {
      document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));
      document.getElementById('nav-board')?.classList.add('active');
    } catch {}
    window.__kanbanOpenDetail?.(tid);
  }

  /** 关联/解除回写（T3-01/T3-04）：先 flush 编辑器脏内容（契约回写时序）→ notes:save key 级写/清 task:
   *  冲突 → 002 分流（关联中止，frontmatter 不变）；失败 → 徽章回滚 + 提示 */
  async function setTaskLink(tid) {
    const o = state.open;
    if (!o) return;
    await flushSave();
    if (!state.open || state.open !== o) return;
    if (o.conflict) { toast('存在未处理的保存冲突，请先处理冲突再操作'); return; }
    o.inflight = true; renderFoot();
    const input = { path: o.path, content: o.buffer, expectedMtime: o.mtime, frontmatterPatch: { task: tid } };
    const r = await bridge.save(input);
    if (!state.open || state.open !== o) return;
    o.inflight = false;
    if (r && r.ok) {
      o.mtime = r.data.mtime;
      o.frontmatter = { ...(o.frontmatter || {}), task: tid };
      renderEditorHead(); renderFoot();
      refreshIndex(); // 索引增量 → 反查映射重建 → 角标/相关笔记行统一重算（经 __kanbanOnNotesChanged）
      toast(tid ? `已关联 ${tid}` : '已解除关联');
    } else if (r && (r.code === 'notes-conflict-modified' || r.code === 'notes-conflict-deleted')) {
      enterConflict(r.code === 'notes-conflict-modified' ? 'modified' : 'deleted');
    } else {
      renderEditorHead(); // 失败：徽章回滚到操作前态
      toast((tid ? '关联失败：' : '解除关联失败：') + ((r && r.message) || '可重试'));
    }
  }

  /** 搜索型任务选择器（T3-01/02/03）：输入实时过滤（标题/id、大小写不敏感）+ updatedAt 倒序平铺
   *  `[看板] id 标题`；Enter 选中首个；Esc/遮罩关闭；打开即刷新候选 */
  function taskPickerModal() {
    if (!state.open) return;
    loadTaskTickets(true);
    ntModal({
      title: '关联看板任务',
      bodyHtml: `<input class="nt-modal-input" id="nt-task-search" placeholder="搜索任务标题或 ID…" autocomplete="off">
        <div class="nt-picker-list" id="nt-picker-list"></div>`,
      onOpen(w, close) {
        const inp = $('#nt-task-search', w);
        const listEl = $('#nt-picker-list', w);
        const render = () => {
          const q = inp.value.trim().toLowerCase();
          const items = (taskTickets || []).filter((t) => !q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q));
          listEl.innerHTML = items.length
            ? items.map((t, i) => `<div class="nt-picker-item ${i === 0 ? 'top' : ''}" data-tid="${esc(t.id)}" title="${esc(t.title)}">
                <span class="p-board">[${esc(t.boardName)}]</span><span class="p-id">${esc(t.id)}</span>
                <span class="p-title">${esc(t.title)}</span>${t.archived ? '<span class="p-arch">已归档</span>' : ''}
                <span class="p-rel">${relTime(t.updatedAt)}</span>
              </div>`).join('')
            : `<div class="nt-picker-empty">${taskTickets ? '没有匹配的任务' : '看板数据加载中…'}</div>`;
        };
        render();
        // 候选异步到达后重绘（首开 loadTaskTickets 在途）；随模态关闭清理轮询
        const readyTimer = setInterval(() => {
          if (!w.isConnected || taskTickets) { clearInterval(readyTimer); if (w.isConnected) render(); }
        }, 200);
        (w.kbOnClose || []).push(() => clearInterval(readyTimer));
        const inpKey = (e) => {
          if (e.key !== 'Enter') return;
          const top = listEl.querySelector('.nt-picker-item');
          if (top) { close(); setTaskLink(top.dataset.tid); } // Enter = 选中首个候选
        };
        inp.addEventListener('input', render);
        inp.addEventListener('keydown', inpKey);
        listEl.addEventListener('click', (e) => {
          const item = e.target.closest('.nt-picker-item');
          if (item) { close(); setTaskLink(item.dataset.tid); }
        });
        inp.focus();
      },
    });
  }

  /* ── N2 遗留文案修复：索引就绪且未选中笔记 → 编辑器空态（不停留「正在加载」）── */
  function renderEditorEmptyState() {
    if (state.open) return;
    const body = $('#nt-editor-body');
    if (!body) return;
    body.innerHTML = state.noBridge
      ? `<div class="nt-editor-empty"><div class="nt-empty" style="padding:0"><div class="nt-empty-ico">📝</div><p>笔记服务未就绪（存储桥未加载）</p><p class="nt-empty-sub">等待 N1 集成后可用</p></div></div>`
      : `<div class="nt-editor-empty"><div class="nt-empty" style="padding:0"><div class="nt-empty-ico">📝</div><p>从左侧选择或新建一篇笔记</p></div></div>`;
    renderFoot();
  }

  /* ── 全局键盘：Cmd/Ctrl+S 强制保存（仅编辑态）；nav 切换/关窗 flush ── */
  function notesViewVisible() { return !document.getElementById('notes')?.classList.contains('hidden'); }
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && notesViewVisible() && state.open && !state.open.conflict) {
      e.preventDefault();
      clearTimeout(saveTimer);
      flushSave();
    }
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('.nav-item') && notesViewVisible()) flushSave(); // 切视图先 flush（静默）
  }, true);
  window.addEventListener('beforeunload', () => { flushSave(); }); // 关窗尽最大努力 flush（不阻塞）

  /* ── indexChanged 订阅（I17 就绪刷新 / I18 外部变更感知 / dir-changed 清空回列表）── */
  function subscribeIndexChanged() {
    const sub = api?.onIndexChanged;
    if (typeof sub !== 'function') return;
    try {
      sub.call(api, (payload) => {
        const reason = payload && payload.reason;
        if (reason === 'dir-changed') {
          // CON-R-notes-010：打开中笔记失效清空回列表 + 提示（切换前置脏处理：先尽力 flush）
          if (state.open) { flushSave(); closeEditor(); }
          toast('存储目录已更改');
        }
        refreshIndex(); // incremental/rescan/dir-changed → 统一重拉全量索引
      });
    } catch { /* 订阅形态以 N1 preload 为准；异常静默降级为手动刷新 */ }
  }

  /* ── 启动 ───────────────────────────────────── */
  mount();
  renderTreeHeadArea();
  renderEditorHead();
  $('#nt-editor-body').innerHTML = `<div class="nt-editor-empty"><div class="nt-empty" style="padding:0"><div class="nt-empty-ico">📝</div><p>${api ? '正在加载笔记索引…' : '笔记服务未就绪（存储桥未加载）'}</p><p class="nt-empty-sub">${api ? '扫描完成后自动出现列表' : '等待 N1 集成后可用'}</p></div></div>`;
  renderFoot();
  if (api) {
    refreshIndex();
    refreshTrashCount();
    subscribeIndexChanged();
  } else {
    state.noBridge = true; // 桥缺失：列表/编辑器呈现未就绪占位，不假死在「正在扫描」
    renderList();
  }
  // nav 进入即拉新（shell.html nav-notes 点击调用；桥缺失时为 no-op）。
  // N3 刷新时机③：视图进入拉取最新索引与 boards（反查映射/选择器候选/有效性判定同步）
  window.__notesRefresh = () => {
    if (!api) { state.noBridge = true; renderAll(); renderEditorEmptyState(); return; }
    refreshIndex();
    refreshTrashCount();
    loadTaskTickets();
  };
  // N3 对外入口（TBD-3 承接）：任务详情相关笔记行 / 看板卡片角标 → 程序化切笔记视图并打开指定笔记
  window.__notesOpenNote = (path) => { if (path) openNote(path); };
  // N3 对外入口：task → 关联笔记引用列表（null = 笔记索引未就绪 → 看板侧中性降级，不渲染角标/相关行）
  window.__notesTaskRefs = (tid) => {
    if (!loaded || !state.ready || !tid) return null;
    return taskNotesMap().get(tid) || [];
  };
})();
