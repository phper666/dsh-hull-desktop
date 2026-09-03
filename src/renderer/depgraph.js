/**
 * U3 依赖图渲染（docs/design/U3-依赖图可视化-kanban-depgraph-design.md §三/§五）
 * 独立弹框（900px × 72vh）+ 内联 SVG（createElementNS，CSP img-src data: 相容，无外链）。
 * 数据由 kanban.js 推入（open/幂等 open），本模块不反读 kanban 状态。
 * API：window.depgraph = { open(task, subtasks), refresh(), isOpen() }
 * 关闭三路：ESC / 点遮罩 / ✕。
 */
(function () {
  const core = window.depgraphCore;
  if (!core) return; // core 缺失（script 顺序错）→ 静默降级，不影响看板主流程

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STATUS_NAMES = { idle: '未执行', queued: '排队中', running: '执行中', paused: '已暂停', interrupted: '已中断', cancelled: '已取消', failed: '失败', succeeded: '已成功' };
  const HALT_SOURCE = ['failed', 'cancelled', 'interrupted'];
  const LEGEND = [
    ['st-succeeded', '成功'], ['st-running', '运行'], ['st-queued', '排队'], ['st-idle', '未执行'],
    ['st-paused', '暂停'], ['st-interrupted', '中断'], ['st-cancelled', '取消'], ['st-failed', '失败'], ['st-halted', '已中止'],
  ];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const statusName = (s) => STATUS_NAMES[s] || s;

  // 布局参数（调用侧可调；core.layout 第三参 opts）：层距/同层间隙/画布 padding 加大防重叠与边缘裁剪
  const LAYOUT = { layerGap: 260, nodeW: 190, nodeH: 60, nodeGapY: 44, pad: 40 };

  let state = null; // { task, subtasks } —— kanban 推入的最新数据
  let wrap = null;  // 弹框 DOM（isConnected 判断开/关）
  let onCloseCb = null; // kanban 关闭回调（复位 openDepgraphTaskId）

  function open(task, subtasks) {
    if (!task) return;
    state = { task, subtasks: subtasks || [] };
    if (wrap && wrap.isConnected) { render(); return; } // 幂等：已开 → 推新数据重绘（exec 刷新路径）
    buildModal();
    render();
  }

  function refresh() {
    if (wrap && wrap.isConnected && state) render(); // 无参重绘（用最近推入数据）
  }

  function isOpen() { return !!(wrap && wrap.isConnected); }

  // kanban 侧注册关闭回调（复位其 openDepgraphTaskId，防陈旧图残留）
  function onClose(cb) { onCloseCb = cb; }

  function buildModal() {
    wrap = document.createElement('div');
    wrap.className = 'dg-modal';
    wrap.innerHTML = `
      <div class="dg-box" role="dialog" aria-modal="true" aria-label="依赖关系图">
        <div class="dg-head">
          <span class="dg-title">依赖关系图</span>
          <span class="dg-chip" id="dg-maxp">并发 ≤3</span>
          <span class="dg-pool" id="dg-pool"><span class="dg-slots" id="dg-slots"></span><b id="dg-cnt">0/3</b></span>
          <button class="dg-listtoggle" id="dg-listtoggle" title="折叠/展开子任务列表" aria-pressed="true">▤</button>
          <button class="dg-close" data-close aria-label="关闭">✕</button>
        </div>
        <div class="dg-body">
          <aside class="dg-list" id="dg-list"></aside>
          <div class="dg-vp" id="dg-vp"><div class="dg-canvas" id="dg-canvas"><div class="dg-scale" id="dg-scale"></div></div></div>
        </div>
        <div class="dg-foot"><span class="dg-legend" id="dg-legend"></span><span class="dg-hint">ESC 或点遮罩关闭</span></div>
      </div>`;
    document.body.appendChild(wrap);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }; // stopPropagation：双层弹框不一个 ESC 全关
    document.addEventListener('keydown', onKey);
    wrap._onKey = onKey;
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
    // 子任务列表折叠/展开
    const toggle = wrap.querySelector('#dg-listtoggle');
    toggle.addEventListener('click', () => {
      const collapsed = wrap.classList.toggle('dg-c');
      toggle.setAttribute('aria-pressed', String(!collapsed));
      render();
    });
    const legend = wrap.querySelector('#dg-legend');
    legend.innerHTML = LEGEND.map(([cls, name]) => `<span class="dg-lg"><i class="${cls}"></i>${name}</span>`).join('');
  }

  function close() {
    if (!wrap) return;
    if (wrap._onKey) document.removeEventListener('keydown', wrap._onKey);
    wrap.remove();
    wrap = null;
    state = null;
    const cb = onCloseCb; onCloseCb = null;
    cb?.();
  }

  // 池态：快照优先（全局并行池，running 不分板；try/catch 回退自算，标注 degraded）
  async function updatePool() {
    const w = wrap; // 捕获当前弹框：await 期间可能已关/重开，只写原弹框
    if (!w || !state) return;
    let p = null;
    try {
      if (window.exec && window.exec.getExecutionSnapshot) {
        const r = await window.exec.getExecutionSnapshot();
        if (r && r.ok && r.data) p = core.poolState(r.data);
      }
    } catch { /* snapshot 不可用 → 回退 */ }
    if (!w.isConnected || !state) return; // 异步期间已关/重开 → 放弃写入
    if (!p) p = core.poolState(state.subtasks);
    w.querySelector('#dg-maxp').textContent = '并发 ≤' + p.maxParallel;
    w.querySelector('#dg-cnt').textContent = p.running + '/' + p.maxParallel;
    w.querySelector('#dg-pool').classList.toggle('full', p.running >= p.maxParallel);
    const slots = w.querySelector('#dg-slots');
    slots.innerHTML = '';
    for (let i = 0; i < p.maxParallel; i++) {
      const s = document.createElement('span');
      s.className = 'dg-slot' + (i < p.running ? ' on' : '');
      slots.appendChild(s);
    }
    if (p.degraded) w.querySelector('#dg-cnt').title = '快照不可用，按任务状态估算';
  }

  function render() {
    if (!wrap || !state) return;
    const tasks = state.subtasks;
    const byId = {};
    for (const t of tasks) byId[t.id] = t;
    const depsById = {};
    for (const t of tasks) depsById[t.id] = (t.dependencies || []).filter((d) => byId[d]);
    const res = core.layout(tasks, depsById, LAYOUT);
    const halted = core.haltedSet(byId, Object.keys(byId).filter((id) => HALT_SOURCE.includes(byId[id].executionStatus)));
    const pos = Object.fromEntries(res.nodes.map((n) => [n.id, n]));

    const canvas = wrap.querySelector('#dg-canvas');
    const scaleEl = wrap.querySelector('#dg-scale');
    /* 等比缩放适配视口：允许放大撑满（上限 1.6 保可读）；图过大（s<0.5）不缩放交滚动 */
    const vp = wrap.querySelector('#dg-vp');
    const vpW = vp.clientWidth || 880, vpH = vp.clientHeight || 480;
    let s = Math.min(vpW / res.W, vpH / res.H);
    if (s > 1.6) s = 1.6;
    if (s < 0.5) s = 1;
    canvas.style.width = (res.W * s) + 'px';
    canvas.style.height = (res.H * s) + 'px';
    scaleEl.style.width = res.W + 'px';
    scaleEl.style.height = res.H + 'px';
    scaleEl.style.transform = s === 1 ? '' : `scale(${s})`;
    scaleEl.style.transformOrigin = '0 0';
    scaleEl.innerHTML = ''; // 只清空内容层（保留 #dg-scale 容器本体，勿清 canvas——否则容器被销毁）

    // SVG 边（<g class="dg-edge …">，path 描边 + polygon 箭头，CSS currentColor 取色）
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'dg-svg');
    svg.setAttribute('viewBox', `0 0 ${res.W} ${res.H}`);
    svg.setAttribute('width', res.W);
    svg.setAttribute('height', res.H);
    const edgeEls = [];
    for (const e of res.edges) {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'dg-edge ' + edgeClass(byId[e.from], byId[e.to], halted));
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', e.path);
      g.appendChild(path);
      const q = pos[e.to];
      const x2 = q.x, y2 = q.y + LAYOUT.nodeH / 2; // 箭头终点 = 目标左缘中点（nodeH 由 LAYOUT 定）
      const poly = document.createElementNS(SVG_NS, 'polygon');
      poly.setAttribute('points', `${x2},${y2 - 4} ${x2 - 8},${y2} ${x2},${y2 + 4}`);
      g.appendChild(poly);
      svg.appendChild(g);
      edgeEls.push({ e, g });
    }
    scaleEl.appendChild(svg);

    // 子任务列表（标题 + 八态徽标；点行联动高亮节点）
    const list = wrap.querySelector('#dg-list');
    list.innerHTML = '';
    const setActive = (id) => {
      for (const n of res.nodes) nodeEls[n.id]?.classList.toggle('hl', n.id === id);
      list.querySelectorAll('.dg-li').forEach((r) => r.classList.toggle('hl', r.dataset.id === id));
      const tgt = nodeEls[id];
      if (tgt) tgt.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    for (const t of tasks) {
      const st = t.executionStatus || 'idle';
      const isHalted = halted.has(t.id);
      const row = document.createElement('div');
      row.className = 'dg-li st-' + st + (isHalted ? ' st-halted' : '');
      row.dataset.id = t.id;
      row.innerHTML = `<i class="dg-li-dot"></i><span class="dg-li-title" title="${esc(t.title)}">${esc(t.title)}</span><span class="dg-li-badge">${esc(isHalted ? '已中止' : statusName(st))}</span>`;
      row.addEventListener('click', () => setActive(t.id));
      list.appendChild(row);
    }

    // 节点（HTML div 绝对定位，复用 --hull-* 令牌；标题为主，id 缩为次要小字）
    const nodeEls = {};
    for (const n of res.nodes) {
      const t = byId[n.id];
      if (!t) continue;
      const st = t.executionStatus || 'idle';
      const isHalted = halted.has(n.id);
      const el = document.createElement('div');
      el.className = 'dg-node st-' + st + (isHalted ? ' st-halted' : '');
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      el.dataset.id = n.id;
      const badge = isHalted ? '已中止' : (st === 'succeeded' ? '✓ ' + statusName(st) : statusName(st));
      const depsN = (t.dependencies || []).filter((d) => byId[d]).length;
      el.innerHTML = `<span class="dg-pri ${esc('dg-pri-' + (t.priority || '无'))}"></span>
        <div class="dg-n-top"><span class="dg-n-title" title="${esc(t.title)}">${esc(t.title)}</span><span class="dg-n-badge">${esc(badge)}</span></div>
        <div class="dg-n-meta"><span class="dg-n-id" title="${esc(t.id)}">${esc(t.id)}</span><span class="dg-n-deps">依赖 ${depsN}</span></div>`;
      el.addEventListener('mouseenter', () => {
        for (const eg of edgeEls) {
          const lit = eg.e.from === n.id || eg.e.to === n.id;
          eg.g.classList.toggle('lit', lit);
          eg.g.classList.toggle('dim', !lit);
        }
        list.querySelector('.dg-li[data-id="' + n.id + '"]')?.classList.add('hl');
      });
      el.addEventListener('mouseleave', () => {
        for (const eg of edgeEls) eg.g.classList.remove('lit', 'dim');
        list.querySelector('.dg-li[data-id="' + n.id + '"]')?.classList.remove('hl');
      });
      scaleEl.appendChild(el);
      nodeEls[n.id] = el;
    }

    // 环警示徽标
    const legend = wrap.querySelector('#dg-legend');
    legend.querySelector('.dg-cycle')?.remove();
    if (res.cycle.length) {
      const c = document.createElement('span');
      c.className = 'dg-cycle';
      c.textContent = `⚠ 环依赖 ${res.cycle.length}`;
      legend.appendChild(c);
    }

    updatePool();
  }

  function edgeClass(from, to, halted) {
    if (halted.has(to.id)) return 'st-aborted';
    if (from.executionStatus === 'failed') return 'st-failed';
    if (from.executionStatus === 'running' || to.executionStatus === 'running' || from.executionStatus === 'succeeded') return 'st-active';
    return '';
  }

  window.depgraph = { open, refresh, isOpen, onClose };
})();
