/* T-Token 消耗视图（docs/design/Token消耗查看-tokens-design.md）：
   数据经 window.tokens.getUsage(granularity) 单桥消费（main 扫描全部平台源 → 聚合摘要）。
   空态 = 支持平台指引（本机无对应数据时引导用户）；扫描只读，绝不写各平台目录（CON-R002 精神）
   视觉：壳内 --hull-* 主题变量（暗/亮双主题）；单一强调色 + 状态色只在数据处（参考 TokenTracker DESIGN + 壳 UI 调研 5 共性） */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  };
  const pct = (v, total) => (total > 0 ? Math.round((v / total) * 100) : 0);
  const GRAN = [['hour', '24小时'], ['day', '30天'], ['week', '12周'], ['month', '12月']];
  const granRange = (k) => { const g = GRAN.find(([kk]) => kk === k); return g ? `近${g[1]}` : k; };
  const PLATFORM_NAMES = {
    'claude-code': 'Claude Code', codex: 'Codex', dsh: 'dsh', opencode: 'OpenCode', cline: 'Cline', roo: 'Roo Code',
    gemini: 'Gemini CLI', kimi: 'Kimi Code', goose: 'Goose', continue: 'Continue', zed: 'Zed', warp: 'Warp',
    zcode: 'ZCode', qoder: 'Qoder', copilot: 'Copilot', kiro: 'Kiro',
  };
  /* 平台锚点色（数据可视化专用，暗/亮双主题均可读；取自各工具品牌色，未知平台走哈希取色板） */
  const PLAT_COLORS = {
    'claude-code': '#d97757', codex: '#3b82f6', dsh: '#2e8bf5', gemini: '#2196f3', kimi: '#a78bfa',
    opencode: '#f59e0b', zcode: '#14b8a6', cline: '#f97316', roo: '#6366f1', goose: '#34d399',
    continue: '#ec4899', zed: '#fbbf24', warp: '#2dd4bf', qoder: '#8b5cf6', copilot: '#6e7681', kiro: '#fb7185',
  };
  const PALETTE = ['#38bdf8', '#a78bfa', '#f59e0b', '#34d399', '#fb7185', '#2dd4bf', '#f97316', '#818cf8'];
  const platColor = (p) => {
    if (PLAT_COLORS[p]) return PLAT_COLORS[p];
    const s = String(p); let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };

  let granularity = 'day';
  const root = document.getElementById('tokens-root');

  function renderShell() {
    root.innerHTML = `
      <div class="tk-toolbar">
        <span class="tk-mark" aria-hidden="true"></span>
        <span class="tk-title">Token 消耗</span>
        <span class="tk-spacer"></span>
        <div class="tk-gran" role="radiogroup" aria-label="统计粒度">
          ${GRAN.map(([k, n]) => `<button type="button" data-gran="${k}" aria-pressed="${k === granularity}">${n}</button>`).join('')}
        </div>
        <button class="tk-btn" id="tk-refresh" title="重新扫描各平台会话数据">刷新</button>
      </div>
      <div id="tk-body"><div class="tk-empty">选择粒度后加载…</div></div>`;
    root.querySelectorAll('[data-gran]').forEach((b) =>
      b.addEventListener('click', () => {
        granularity = b.dataset.gran;
        root.querySelectorAll('[data-gran]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        void load();
      })
    );
    root.querySelector('#tk-refresh')?.addEventListener('click', () => void load());
  }

  async function load() {
    const body = root.querySelector('#tk-body');
    if (!body) return;
    if (!window.tokens?.getUsage) {
      body.innerHTML = '<div class="tk-error">tokens 桥不可用（preload 版本过旧？）</div>';
      return;
    }
    body.innerHTML = '<div class="tk-loading"><div class="spinner"></div>扫描各平台会话数据中…</div>';
    let r;
    try {
      r = await window.tokens.getUsage(granularity);
    } catch (err) {
      body.innerHTML = `<div class="tk-error">加载失败：${esc(err.message || String(err))}</div>`;
      return;
    }
    if (!r.ok) {
      body.innerHTML = `<div class="tk-error">加载失败：${esc(r.message || '未知错误')}</div>`;
      return;
    }
    renderData(r.data);
  }

  function renderData(s) {
    const body = root.querySelector('#tk-body');
    if (!body) return;
    const t = s.totals || {};
    if (!t.totalTokens) {
      const srcCards = (s.sources || [])
        .map((src) => {
          const name = PLATFORM_NAMES[src.platform] || src.platform;
          const ok = src.files > 0;
          return `<div class="tk-src-card">
            <i class="dot" style="background:${platColor(src.platform)}"></i>
            <div class="tk-src-main"><b>${esc(name)}</b><code>${esc(src.home)}</code></div>
            <span class="tk-src-status ${ok ? 'ok' : 'no'}">${ok ? `已扫描 ${src.files} 个文件` : '未检测到数据'}</span>
          </div>`;
        })
        .join('');
      body.innerHTML = `
        <div class="tk-empty">
          <div class="tk-empty-ico" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 40V24M18 40V14M30 40V8M42 40V20" opacity="0.55"/>
              <path d="M4 42h40" opacity="0.35"/>
            </svg>
          </div>
          <h2>暂无 Token 用量数据</h2>
          <p>使用以下任一支持的 AI 编程工具产生会话后，这里会自动统计输入 / 输出 / 缓存 / 推理 token（${GRAN.map(([k, n]) => '近' + n).join(' / ')}）。扫描只读，不会修改各平台目录。</p>
          <div class="tk-src-grid">${srcCards || '<div class="tk-muted">未配置任何扫描源</div>'}</div>
        </div>`;
      return;
    }

    /* —— 合计英雄卡：大数字 + 构成分解（输入/输出/缓存/其他） —— */
    const inp = t.inputTokens || 0;
    const out = t.outputTokens || 0;
    const cache = (t.cacheReadTokens || 0) + (t.cacheWriteTokens || 0);
    const total = t.totalTokens || 1;
    const rem = Math.max(total - inp - out - cache, 0);
    const segs = [
      { k: '输入', v: inp, c: 'in' },
      { k: '输出', v: out, c: 'out' },
      { k: '缓存', v: cache, c: 'cache' },
      { k: '其他/推理', v: rem, c: 'rem' },
    ].filter((x) => x.v > 0);
    const compBar = segs.map((x) => `<i class="seg ${x.c}" style="width:${((x.v / total) * 100).toFixed(1)}%" title="${esc(x.k)} ${fmt(x.v)}"></i>`).join('');
    const compLegend = segs.map((x) => `<span class="tk-seg ${x.c}"><i></i>${esc(x.k)}<b>${pct(x.v, total)}%</b></span>`).join('');
    const hero = `
      <div class="tk-hero">
        <div class="tk-hero-main">
          <div class="tk-hero-label">合计 Token 消耗 · ${granRange(s.granularity)}</div>
          <div class="tk-hero-val" title="${t.totalTokens}">${fmt(total)}</div>
        </div>
        <div class="tk-hero-comp">
          <div class="tk-comp-bar">${compBar}</div>
          <div class="tk-comp-legend">${compLegend}</div>
        </div>
      </div>`;

    /* —— 三个分项瓦片 —— */
    const read = t.cacheReadTokens || 0;
    const write = t.cacheWriteTokens || 0;
    const rw = read + write;
    const tiles = `
      <div class="tk-tiles">
        <div class="tk-tile">
          <div class="tk-tile-k">输入</div>
          <div class="tk-tile-v">${fmt(inp)}</div>
          <div class="tk-tile-sub">占合计 ${pct(inp, total)}%</div>
        </div>
        <div class="tk-tile">
          <div class="tk-tile-k">输出</div>
          <div class="tk-tile-v">${fmt(out)}</div>
          <div class="tk-tile-sub">占合计 ${pct(out, total)}%</div>
        </div>
        <div class="tk-tile cache">
          <div class="tk-tile-k">缓存（读 + 写）</div>
          <div class="tk-tile-v">${fmt(cache)}</div>
          <div class="tk-tile-sub">读 ${fmt(read)} · 写 ${fmt(write)}
            <div class="tk-mini"><i style="width:${rw ? (read / rw) * 100 : 0}%"></i></div>
          </div>
        </div>
      </div>`;

    /* —— 时间序列：纵向柱图（纯 CSS）+ 悬停提示 —— */
    const series = s.series || [];
    const seriesMax = Math.max(...series.map((b) => b.totalTokens), 1);
    const n = series.length;
    const step = Math.max(1, Math.ceil(n / 8));
    const cols = series
      .map((b, i) => {
        const v = b.totalTokens || 0;
        const h = v ? Math.max((v / seriesMax) * 100, 2) : 0;
        const showLbl = i % step === 0 || i === n - 1;
        return `<div class="tk-col" data-bucket="${esc(b.bucket)}" data-val="${fmt(v)}">
          <div class="tk-tip"><b>${esc(b.bucket)}</b><span>${fmt(v)}</span></div>
          <div class="tk-bar${v ? '' : ' zero'}" style="height:${h}%;--i:${Math.min(i, 20)}" title="${esc(b.bucket)} · ${fmt(v)}"></div>
          ${showLbl ? `<span class="tk-lbl" title="${esc(b.bucket)}">${esc(b.bucket)}</span>` : ''}
        </div>`;
      })
      .join('');
    const seriesBlock = `
      <div class="tk-section">
        <h3>时间序列（${granRange(s.granularity)}）</h3>
        ${n ? `<div class="tk-chart" role="img" aria-label="各时间段 token 消耗柱状图"><div class="tk-bars">${cols}</div></div>` : '<div class="tk-muted">无数据</div>'}
      </div>`;

    /* —— 明细表（按平台 / 按模型）—— */
    const num = (v) => `<td class="num">${fmt(v)}</td>`;
    const table = (rows, mode) => {
      if (!rows.length) return '<div class="tk-none">暂无数据</div>';
      const sums = rows.reduce(
        (a, r) => ({
          in: a.in + (r.inputTokens || 0), out: a.out + (r.outputTokens || 0),
          rea: a.rea + (r.reasoningTokens || 0),
          c: a.c + (r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0),
          tot: a.tot + (r.totalTokens || 0),
        }),
        { in: 0, out: 0, rea: 0, c: 0, tot: 0 }
      );
      const rowsHtml = rows
        .map((r) => {
          const plat = `<span class="tk-pname"><i class="dot" style="background:${platColor(r.platform)}"></i>${esc(PLATFORM_NAMES[r.platform] || r.platform)}</span>`;
          const model = `<span class="tk-mname">${esc(r.model)}</span>`;
          return `<tr>
            <td class="${mode === 'model' ? 'tk-sub' : ''}">${plat}</td>
            <td class="${mode === 'platform' ? 'tk-sub' : ''}">${model}</td>
            ${num(r.inputTokens)}${num(r.outputTokens)}${num(r.reasoningTokens)}${num((r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0))}
            <td class="num tk-total">${fmt(r.totalTokens)}</td>
          </tr>`;
        })
        .join('');
      return `<div class="tk-tbl-wrap"><table class="tk-table">
        <thead><tr><th>平台</th><th>模型</th><th class="num">输入</th><th class="num">输出</th><th class="num">推理</th><th class="num">缓存</th><th class="num">合计</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot><tr><td colspan="2">小计</td><td class="num">${fmt(sums.in)}</td><td class="num">${fmt(sums.out)}</td><td class="num">${fmt(sums.rea)}</td><td class="num">${fmt(sums.c)}</td><td class="num tk-total">${fmt(sums.tot)}</td></tr></tfoot>
      </table></div>`;
    };

    body.innerHTML = `
      ${hero}
      ${tiles}
      ${seriesBlock}
      <div class="tk-section">
        <h3>按平台（${granRange(s.granularity)}）</h3>
        ${table(s.byPlatform || [], 'platform')}
      </div>
      <div class="tk-section">
        <h3>按模型（${granRange(s.granularity)}）</h3>
        ${table(s.byModel || [], 'model')}
      </div>`;
  }

  // 初始渲染骨架 + 对外刷新入口（nav 进入视图时触发新数据加载）
  renderShell();
  window.__tokensRefresh = load;
})();
