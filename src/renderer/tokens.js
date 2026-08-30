/* T-Token 消耗视图（docs/design/Token消耗查看-tokens-design.md）：
   数据经 window.tokens.getUsage(granularity) 单桥消费（main 扫描全部平台源 → 聚合摘要）。
   空态 = 支持平台指引（本机无对应数据时引导用户）；扫描只读，绝不写各平台目录（CON-R002 精神） */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  };
  const GRAN = [['hour', '小时'], ['day', '天'], ['week', '周'], ['month', '月']];
  const PLATFORM_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', dsh: 'dsh' };

  let granularity = 'day';
  const root = document.getElementById('tokens-root');

  function renderShell() {
    root.innerHTML = `
      <div class="tk-toolbar">
        <span class="tk-title">Token 消耗</span>
        <span class="tk-spacer"></span>
        <div class="tk-gran" role="radiogroup" aria-label="统计粒度">
          ${GRAN.map(([k, n]) => `<button type="button" data-gran="${k}" aria-pressed="${k === granularity}">${n}</button>`).join('')}
        </div>
        <button class="tk-btn" id="tk-refresh">刷新</button>
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
      const srcRows = (s.sources || [])
        .map(
          (src) =>
            `<div><b>${esc(PLATFORM_NAMES[src.platform] || src.platform)}</b> · <code>${esc(src.home)}</code> · ${src.files ? `已扫描 ${src.files} 个文件` : '未检测到数据'}</div>`
        )
        .join('');
      body.innerHTML = `
        <div class="tk-empty">
          <h2>暂无 Token 用量数据</h2>
          <p>使用以下任一支持的 AI 编程工具产生会话后，这里会自动统计输入 / 输出 / 缓存 token（${GRAN.map(([k, n]) => n).join(' / ')}粒度）。</p>
          <div class="src">${srcRows}</div>
          <p class="hint-note">扫描只读，不会修改各平台目录；dsh / API 型平台适配器在路线图中。</p>
        </div>`;
      return;
    }

    const cards = `
      <div class="tk-cards">
        <div class="tk-card"><div class="k">输入</div><div class="v">${fmt(t.inputTokens)}</div></div>
        <div class="tk-card"><div class="k">输出</div><div class="v">${fmt(t.outputTokens)}</div></div>
        <div class="tk-card"><div class="k">缓存（读+写）</div><div class="v accent">${fmt(t.cacheReadTokens + t.cacheWriteTokens)}</div><div class="sub">读 ${fmt(t.cacheReadTokens)} · 写 ${fmt(t.cacheWriteTokens)}</div></div>
        <div class="tk-card"><div class="k">合计</div><div class="v">${fmt(t.totalTokens)}</div></div>
      </div>`;

    const seriesMax = Math.max(...(s.series || []).map((b) => b.totalTokens), 1);
    const series = (s.series || [])
      .map(
        (b) => `<div class="tk-serie"><span class="bucket">${esc(b.bucket)}</span><div class="bar"><i style="width:${Math.max((b.totalTokens / seriesMax) * 100, 1)}%"></i></div><span class="val">${fmt(b.totalTokens)}</span></div>`
      )
      .join('');

    const table = (rows) =>
      `<table class="tk-table"><thead><tr><th>平台</th><th>模型</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存</th><th class="num">合计</th></tr></thead><tbody>${
        rows
          .map(
            (r) =>
              `<tr><td>${esc(PLATFORM_NAMES[r.platform] || r.platform)}</td><td>${esc(r.model)}</td><td class="num">${fmt(r.inputTokens)}</td><td class="num">${fmt(r.outputTokens)}</td><td class="num">${fmt(r.cacheReadTokens + r.cacheWriteTokens)}</td><td class="num">${fmt(r.totalTokens)}</td></tr>`
          )
          .join('')
      }</tbody></table>`;

    body.innerHTML = `
      ${cards}
      <div class="tk-section">
        <h3>时间序列（${GRAN.find(([k]) => k === s.granularity)?.[1] || s.granularity}）</h3>
        <div class="tk-series">${series || '<div class="tk-muted">无数据</div>'}</div>
      </div>
      <div class="tk-section">
        <h3>按平台</h3>
        ${table(s.byPlatform || [])}
      </div>
      <div class="tk-section">
        <h3>按模型</h3>
        ${table(s.byModel || [])}
      </div>`;
  }

  // 初始渲染骨架 + 对外刷新入口（nav 进入视图时触发新数据加载）
  renderShell();
  window.__tokensRefresh = load;
})();
