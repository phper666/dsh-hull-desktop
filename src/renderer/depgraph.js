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

  let state = null; // { task, subtasks } —— kanban 推入的最新数据
  let wrap = null;  // 弹框 DOM（isConnected 判断开/关）

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

  function buildModal() {
    wrap = document.createElement('div');
    wrap.className = 'dg-modal';
    wrap.innerHTML = `
      <div class="dg-box" role="dialog" aria-modal="true" aria-label="依赖关系图">
        <div class="dg-head">
          <span class="dg-title">依赖关系图</span>
          <span class="dg-chip" id="dg-maxp">并发 ≤3</span>
          <span class="dg-pool" id="dg-pool"><span class="dg-slots" id="dg-slots"></span><b id="dg-cnt">0/3</b></span>
          <button class="dg-close" data-close aria-label="关闭">✕</button>
        </div>
        <div class="dg-body"><div class="dg-canvas" id="dg-canvas"></div></div>
        <div class="dg-foot"><span class="dg-legend" id="dg-legend"></span><span class="dg-hint">ESC 或点遮罩关闭</span></div>
      </div>`;
    document.body.appendChild(wrap);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    wrap._onKey = onKey;
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
    const legend = wrap.querySelector('#dg-legend');
    legend.innerHTML = LEGEND.map(([cls, name]) => `<span class="dg-lg"><i class="${cls}"></i>${name}</span>`).join('');
  }

  function close() {
    if (!wrap) return;
    if (wrap._onKey) document.removeEventListener('keydown', wrap._onKey);
    wrap.remove();
    wrap = null;
    state = null;
  }

  // 池态：快照优先（全局并行池，running 不分板；try/catch 回退自算，标注 degraded）
  async function updatePool() {
    if (!wrap || !state) return;
    let p = null;
    try {
      if (window.exec && window.exec.getExecutionSnapshot) {
        const r = await window.exec.getExecutionSnapshot();
        if (r && r.ok && r.data) p = core.poolState(r.data);
      }
    } catch { /* snapshot 不可用 → 回退 */ }
    if (!p) p = core.poolState(state.subtasks);
    if (!wrap || !state) return; // 异步期间已关
    wrap.querySelector('#dg-maxp').textContent = '并发 ≤' + p.maxParallel;
    wrap.querySelector('#dg-cnt').textContent = p.running + '/' + p.maxParallel;
    wrap.querySelector('#dg-pool').classList.toggle('full', p.running >= p.maxParallel);
    const slots = wrap.querySelector('#dg-slots');
    slots.innerHTML = '';
    for (let i = 0; i < p.maxParallel; i++) {
      const s = document.createElement('span');
      s.className = 'dg-slot' + (i < p.running ? ' on' : '');
      slots.appendChild(s);
    }
    if (p.degraded) wrap.querySelector('#dg-cnt').title = '快照不可用，按任务状态估算';
  }

  function render() {
    if (!wrap || !state) return;
    const tasks = state.subtasks;
    const byId = {};
    for (const t of tasks) byId[t.id] = t;
    const depsById = {};
    for (const t of tasks) depsById[t.id] = (t.dependencies || []).filter((d) => byId[d]);
    const res = core.layout(tasks, depsById);
    const halted = core.haltedSet(byId, Object.keys(byId).filter((id) => HALT_SOURCE.includes(byId[id].executionStatus)));
    const pos = Object.fromEntries(res.nodes.map((n) => [n.id, n]));

    const canvas = wrap.querySelector('#dg-canvas');
    canvas.innerHTML = '';
    canvas.style.width = res.W + 'px';
    canvas.style.height = res.H + 'px';

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
      const x2 = q.x, y2 = q.y + 24; // nodeH 48 中心
      const poly = document.createElementNS(SVG_NS, 'polygon');
      poly.setAttribute('points', `${x2},${y2 - 4} ${x2 - 8},${y2} ${x2},${y2 + 4}`);
      g.appendChild(poly);
      svg.appendChild(g);
      edgeEls.push({ e, g });
    }
    canvas.appendChild(svg);

    // 节点（HTML div 绝对定位，复用 --hull-* 令牌）
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
      el.innerHTML = `<div class="dg-n-top"><span class="dg-n-id">${esc(t.id)}</span><span class="dg-n-title" title="${esc(t.title)}">${esc(t.title)}</span></div>
        <div class="dg-n-meta"><span class="dg-n-badge">${esc(badge)}</span></div>`;
      el.addEventListener('mouseenter', () => {
        for (const eg of edgeEls) {
          const lit = eg.e.from === n.id || eg.e.to === n.id;
          eg.g.classList.toggle('lit', lit);
          eg.g.classList.toggle('dim', !lit);
        }
      });
      el.addEventListener('mouseleave', () => {
        for (const eg of edgeEls) eg.g.classList.remove('lit', 'dim');
      });
      canvas.appendChild(el);
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

  window.depgraph = { open, refresh, isOpen };
})();
