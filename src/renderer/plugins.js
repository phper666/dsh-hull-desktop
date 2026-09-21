/* P4 插件市场 UI（docs/api/feishu-plugin-market-api-contract.md §接口详情 + 共识 v2.1 §4.5/4.9）
   双 tab：市场（registry 浏览/搜索/安装）+ 已安装（reconcile 列表/更新/卸载/状态徽标）。
   数据经 window.hull（pluginListRegistry/getInstalledPlugins/getPluginStatus/pluginInstall/pluginUpdate/pluginUninstall）
   6 通道消费，typeof 守卫 + try/catch 静默降级（桥未就绪不抛错）。
   安装两段式（预览→信任+patch 确认→执行）；卸载二次确认；降级空态（registry 快照/dsh 未装/空列表）。
   视觉：复用 skills.css .sk-* 组件 + 壳级 .empty-ico/.modal-wrap + --hull-* 令牌（零新增设计语言）。
   纯函数（错误码映射/搜索过滤/状态徽标）导出供 node:test 直测。 */
(function () {
  // ── 纯函数（先定义 + 导出，Node 直测不触碰 DOM） ──
  /** 契约 §错误码（9 kebab + io-error/bridge-unavailable）→ 用户可见中文提示；code 未识别时回落 message */
  const ERR_TEXT = {
    'plugin-registry-unreachable': '插件市场不可达，当前显示离线快照或缓存数据。',
    'plugin-not-whitelisted': '该插件不在市场白名单内，已拒绝安装。',
    'plugin-install-failed': '安装失败，请稍后重试。',
    'plugin-update-failed': '更新失败。',
    'plugin-uninstall-failed': '卸载失败。',
    'plugin-profile-missing': 'dsh 插件环境不可用（profile hull 缺失），请先安装并启动 dsh。',
    'plugin-busy': '有插件操作或升级/自更新正在进行，请稍后再试。',
    'plugin-not-installed': '该插件未安装。',
    'plugin-version-too-old': '当前 dsh 版本低于要求，仍可尝试安装（后果以安装结果为准）。',
    'io-error': '读写错误。',
    'bridge-unavailable': '插件桥不可用（应用版本过旧？）。',
  };
  function pluginErrText(code, message) {
    return ERR_TEXT[code] || message || '操作失败。';
  }
  // 前端搜索过滤：名称/描述/分类/owner 命中（大小写不敏感；空词返回全量）
  function filterEntries(entries, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return entries || [];
    return (entries || []).filter((e) =>
      [e.name, e.description, e.category, e.owner].some((v) => String(v ?? '').toLowerCase().includes(q))
    );
  }
  // 稳定标识：name#owner 复合键（与主进程 types.entryId 同构；防同 name 不同 owner 装错）
  function entryIdOf(e) {
    return `${e.name}#${e.owner ?? ''}`;
  }
  // 已安装状态徽标映射（复用 skills.css .sk-badge 语义变体：installed=绿 / updatable=琥珀 / deprecated=红）
  const STATUS_BADGE = {
    installed: { cls: 'latest', text: '已安装' },
    updatable: { cls: 'upgradable', text: '可更新' },
    deprecated: { cls: 'notinstalled', text: '已弃用' },
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ERR_TEXT, pluginErrText, filterEntries, entryIdOf, STATUS_BADGE };
  }

  // 浏览器侧继续；node:test 直测仅到 module.exports（不触 DOM）
  if (typeof document === 'undefined') return;
  const root = document.getElementById('plugin-root');
  if (!root) return;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const EMPTY_ICO =
    '<div class="empty-ico" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 44V32"/><path d="M16 12V6"/><path d="M32 12V6"/><path d="M11 12h26v10a13 13 0 0 1-13 13 13 13 0 0 1-13-13z"/></svg></div>';
  const SRC_TEXT = { remote: '在线', cache: '缓存', snapshot: '离线快照' };

  // ── 桥访问（typeof 守卫 + try/catch 统一 IpcResult 口径） ──
  async function call(method, arg) {
    const h = window.hull;
    if (!h || typeof h[method] !== 'function') return { ok: false, code: 'bridge-unavailable' };
    try { return await h[method](arg); } catch (e) { return { ok: false, code: 'bridge-unavailable', message: e && e.message }; }
  }
  const toast = (msg) => { if (typeof window.toast === 'function') window.toast(msg); else console.warn('[plugins]', msg); };

  // ── 状态 ──
  let tab = 'market'; // market | installed
  let query = '';
  let registry = null; // { entries, source, fetchedAt }
  let registryErr = false; // registry 不可达（snapshot/cache 兜底标注）
  let plugins = []; // InstalledPlugin[]
  let installedWarn = null; // dsh 不可达等降级提示
  let loadingMarket = false;
  let loadingInstalled = false;
  let busy = false; // 安装/更新/卸载 in-flight（本地置灰）
  let gateOk = true; // getPluginStatus.canOperate
  let gateMsg = '';
  // 市场列表懒加载（评审 🟠-4）：top-N + 加载更多，避免 4105 行全量 DOM；搜索后重置
  const MARKET_PAGE = 100;
  let marketLimit = MARKET_PAGE;

  const $ = (sel) => root.querySelector(sel);

  // ── 渲染 ──
  function render() {
    root.innerHTML = `
      <div class="sk-toolbar">
        <div class="sk-tabs">
          <button class="sk-tab ${tab === 'market' ? 'active' : ''}" data-tab="market">市场</button>
          <button class="sk-tab ${tab === 'installed' ? 'active' : ''}" data-tab="installed">已安装</button>
        </div>
        ${tab === 'market' ? `<input id="pkt-q" class="sk-input" placeholder="搜索名称 / 作者…" value="${esc(query)}" />` : ''}
        <div class="sk-spacer"></div>
        <button class="sk-btn" id="pkt-refresh">${tab === 'market' ? '刷新市场' : '重新检测'}</button>
      </div>
      <div class="sk-statusbar" id="pkt-statusbar"></div>
      <div class="sk-list" id="pkt-list"></div>`;
    renderStatusbar();
    if (tab === 'market') renderMarket();
    else renderInstalled();
  }

  function renderStatusbar() {
    const el = $('#pkt-statusbar');
    if (!el) return;
    if (tab === 'market') {
      let html = '<span>插件市场</span>';
      if (registry) {
        const src = SRC_TEXT[registry.source] || registry.source;
        if (src) html += `<span>来源 <b>${esc(src)}</b></span>`;
        if (registry.fetchedAt) html += `<span>更新于 ${esc(new Date(registry.fetchedAt).toLocaleTimeString())}</span>`;
        html += `<span class="sk-spacer"></span><span>${registry.entries.length} 个插件</span>`;
      }
      if (registryErr) html += `<span class="sk-scanstate error">registry 不可达（已用本地快照/缓存兜底）</span>`;
      el.innerHTML = html;
      return;
    }
    let html = '<span>已安装</span>';
    if (installedWarn) html += `<span class="sk-scanstate error">${esc(installedWarn)}</span>`;
    else if (plugins.length) html += `<span class="sk-spacer"></span><span>共 <b>${plugins.length}</b> 个</span>`;
    if (!gateOk) html += `<span class="sk-scanstate error">${esc(gateMsg || '当前不可操作')}</span>`;
    el.innerHTML = html;
  }

  function renderMarket() {
    const list = $('#pkt-list');
    if (!list) return;
    if (loadingMarket && !registry) {
      list.innerHTML = Array.from({ length: 5 }, () => '<div class="sk-skeleton"></div>').join('');
      return;
    }
    if (!registry) {
      list.innerHTML = `<div class="sk-empty">${EMPTY_ICO}<h2>插件市场</h2><p>${registryErr ? 'registry 不可达且无本地快照，请检查网络后重试。' : '加载市场数据中…'}</p></div>`;
      return;
    }
    const visible = filterEntries(registry.entries, query);
    if (visible.length === 0) {
      const isSearch = query.trim().length > 0;
      list.innerHTML = `<div class="sk-empty">${EMPTY_ICO}<h2>${isSearch ? '未找到匹配的插件' : '市场暂无插件'}</h2><p>${isSearch ? `没有名称/作者包含「${esc(query)}」的插件，试试其他关键词` : 'registry 列表为空。'}</p></div>`;
      return;
    }
    // 懒加载（🟠-4）：只渲染前 marketLimit 条；超出 → 底部「加载更多」按钮
    const shown = visible.slice(0, marketLimit);
    const more =
      visible.length > shown.length
        ? `<button class="sk-btn" id="pkt-more">加载更多（还有 ${visible.length - shown.length} 个）</button>`
        : '';
    list.innerHTML = shown.map(entryRow).join('') + more;
  }

  function entryRow(e) {
    const deprecated = e.deprecated === true;
    const meta = [];
    if (e.category) meta.push(`<span class="sk-badge">${esc(e.category)}</span>`);
    if (e.owner) meta.push(`<span class="sk-badge plat">${esc(e.owner)}</span>`);
    if (e.minDshVersion) meta.push(`<span class="sk-badge" title="最低 dsh 版本要求">dsh ≥ ${esc(e.minDshVersion)}</span>`);
    const desc = e.description || e.install || '';
    return `<div class="sk-row">
      <div class="sk-main">
        <div class="sk-name">${esc(e.name)}${deprecated ? '<span class="sk-badge notinstalled" title="该插件已弃用">已弃用</span>' : ''}</div>
        ${desc ? `<div class="sk-desc">${esc(desc)}</div>` : ''}
        ${meta.length ? `<div class="sk-meta">${meta.join('')}</div>` : ''}
      </div>
      <div class="sk-side">
        <button class="sk-btn sk-primary-btn" data-install="${esc(entryIdOf(e))}" ${deprecated || !gateOk || busy ? 'disabled' : ''} title="${deprecated ? '该插件已弃用，不可安装' : ''}">${busy ? '安装中…' : '安装'}</button>
      </div>
    </div>`;
  }

  function renderInstalled() {
    const list = $('#pkt-list');
    if (!list) return;
    if (loadingInstalled && plugins.length === 0) {
      list.innerHTML = Array.from({ length: 4 }, () => '<div class="sk-skeleton"></div>').join('');
      return;
    }
    if (installedWarn) {
      list.innerHTML = `<div class="sk-empty">${EMPTY_ICO}<h2>dsh 不可用</h2><p class="sk-error">${esc(installedWarn)}</p><p>请先安装并启动 dsh，再回到这里管理插件。</p></div>`;
      return;
    }
    if (plugins.length === 0) {
      list.innerHTML = `<div class="sk-empty">${EMPTY_ICO}<h2>尚未安装任何插件</h2><p>去「市场」tab 浏览并安装插件；安装后在此查看状态、更新与卸载。</p></div>`;
      return;
    }
    list.innerHTML = plugins.map(installedRow).join('');
  }

  function installedRow(p) {
    const st = STATUS_BADGE[p.status] || { cls: '', text: p.status };
    const canUpd = p.status === 'updatable';
    return `<div class="sk-row${canUpd ? ' sk-upgradable' : ''}">
      <div class="sk-main">
        <div class="sk-name">${esc(p.name)}<span class="sk-badge ${st.cls}">${esc(st.text)}</span></div>
        <div class="sk-desc">版本 ${esc(p.version)}${canUpd && p.registryVersion ? `（可更新至 ${esc(p.registryVersion)}）` : ''}</div>
      </div>
      <div class="sk-side">
        ${canUpd ? `<button class="sk-btn sk-primary-btn" data-update="${esc(p.id)}" ${busy || !gateOk ? 'disabled' : ''}>更新</button>` : ''}
        <button class="sk-btn sk-danger-btn" data-uninstall="${esc(p.id)}" ${busy || !gateOk ? 'disabled' : ''}>卸载</button>
      </div>
    </div>`;
  }

  // ── 数据加载 ──
  async function fetchMarket(refresh) {
    if (loadingMarket) return;
    loadingMarket = true;
    render();
    const r = await call('pluginListRegistry', { refresh });
    loadingMarket = false;
    if (r && r.ok === false) {
      registryErr = true;
      if (r.data && Array.isArray(r.data.entries)) registry = r.data; // 契约：失败仍返回 snapshot/缓存数据
    } else if (r && r.data && Array.isArray(r.data.entries)) {
      registry = r.data;
      registryErr = r.data.source === 'snapshot';
    } else {
      registryErr = true;
    }
    render();
  }

  async function fetchInstalled() {
    if (loadingInstalled) return;
    loadingInstalled = true;
    render();
    const r = await call('getInstalledPlugins');
    loadingInstalled = false;
    if (r && r.ok === false) {
      installedWarn = pluginErrText(r.code, r.message);
      plugins = [];
    } else if (r && r.data && Array.isArray(r.data.plugins)) {
      plugins = r.data.plugins;
      installedWarn = null;
    } else {
      installedWarn = pluginErrText('io-error');
    }
    render();
  }

  async function fetchGate() {
    const r = await call('getPluginStatus');
    if (r && r.ok !== false && r.data) {
      const c = r.data.canOperate;
      // 门控字段（评审 🟠-1）：读 c.ok + c.message（置灰 + 原因提示），不再死读 canOperate !== false
      const ok = c === undefined ? true : typeof c === 'object' ? c.ok !== false : c !== false;
      const inflight = r.data.inflight;
      gateOk = ok && !inflight;
      gateMsg = inflight ? '有插件操作正在进行，请稍后再试。' : (c && typeof c === 'object' && c.message) || (!ok ? '当前不可操作。' : '');
    } else {
      gateOk = true; // 只读门控失败不阻断浏览
      gateMsg = '';
    }
    renderStatusbar();
    if (tab === 'market') renderMarket();
    else renderInstalled();
  }

  // ── 操作流 ──
  async function installFlow(entry) {
    if (busy) return;
    busy = true;
    render();
    const r1 = await call('pluginInstall', { entryId: entryIdOf(entry) });
    busy = false;
    render();
    if (!r1 || r1.ok === false) { toast(pluginErrText(r1 && r1.code, r1 && r1.message)); return; }
    const preview = r1.data && r1.data.preview;
    if (!preview) {
      if (r1.data && r1.data.stage === 'done') { toast('已安装 ' + entry.name); await fetchInstalled(); }
      else toast('安装响应异常，请重试');
      return;
    }
    const ok = await confirmInstallModal(preview);
    if (!ok) return;
    busy = true;
    render();
    const r2 = await call('pluginInstall', { entryId: entryIdOf(entry), confirm: true });
    busy = false;
    if (!r2 || r2.ok === false) toast(pluginErrText(r2 && r2.code, r2 && r2.message));
    else { toast('已安装 ' + entry.name); await fetchInstalled(); await fetchMarket(false); }
    render();
  }

  async function updateFlow(id) {
    if (busy) return;
    busy = true;
    render();
    const r = await call('pluginUpdate', { id });
    busy = false;
    if (r && r.ok === false) toast(pluginErrText(r.code, r.message));
    else { toast('更新完成'); await fetchInstalled(); }
    render();
  }

  async function uninstallFlow(id) {
    const p = plugins.find((x) => x.id === id);
    if (!p) return;
    const ok = await confirmUninstallModal(p);
    if (!ok || busy) return;
    busy = true;
    render();
    const r = await call('pluginUninstall', { id });
    busy = false;
    if (r && r.ok === false) toast(pluginErrText(r.code, r.message));
    else { toast('已卸载 ' + p.name); await fetchInstalled(); }
    render();
  }

  // ── 确认弹窗（复用壳级 .sk-modal-wrap/.sk-modal；安装=信任+patch 预览，卸载=二次确认） ──
  function confirmInstallModal(preview) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'sk-modal-wrap';
      const patch = preview.patchSummary
        ? `<div class="sk-detail-desc"><code>${esc(preview.patchSummary)}</code></div>`
        : '<p class="sk-muted">无法预览配置变更（cordis.patch.yml 解析失败），安装仍可继续。</p>';
      const versionWarn = preview.versionTooOld
        ? `<p class="sk-error">${esc(pluginErrText('plugin-version-too-old'))}</p>`
        : '';
      wrap.innerHTML = `<div class="sk-modal"><h3>确认安装插件</h3>
        <div class="sk-modal-body">
          <p>即将安装 <b>${esc(preview.id || '该插件')}</b>（v${esc(preview.version || '?')}）</p>
          ${preview.sourceUrl ? `<p>来源：<span class="sk-source">${esc(preview.sourceUrl)}</span></p>` : ''}
          ${versionWarn}
          <p style="margin-top:8px">配置变更预览（patch）：</p>${patch}
          <p class="sk-error">该操作会修改 dsh 配置；请确认来源可信后再继续。</p>
        </div>
        <div class="sk-modal-ops"><button class="sk-btn" data-close>取消</button><button class="sk-btn sk-primary-btn" data-ok>确认安装</button></div>
      </div>`;
      document.body.appendChild(wrap);
      const close = (v) => { wrap.remove(); resolve(v); };
      wrap.addEventListener('click', (ev) => { if (ev.target === wrap) close(false); });
      wrap.querySelector('[data-close]').addEventListener('click', () => close(false));
      wrap.querySelector('[data-ok]').addEventListener('click', () => close(true));
    });
  }

  function confirmUninstallModal(p) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'sk-modal-wrap';
      wrap.innerHTML = `<div class="sk-modal"><h3>确认卸载插件</h3>
        <div class="sk-modal-body">
          <p>将卸载 <b>${esc(p.name)}</b>（v${esc(p.version)}）。</p>
          <p class="sk-error">卸载后插件能力将不可用；如需恢复需重新安装。</p>
        </div>
        <div class="sk-modal-ops"><button class="sk-btn" data-close>取消</button><button class="sk-btn sk-danger-btn" data-ok>确认卸载</button></div>
      </div>`;
      document.body.appendChild(wrap);
      const close = (v) => { wrap.remove(); resolve(v); };
      wrap.addEventListener('click', (ev) => { if (ev.target === wrap) close(false); });
      wrap.querySelector('[data-close]').addEventListener('click', () => close(false));
      wrap.querySelector('[data-ok]').addEventListener('click', () => close(true));
    });
  }

  // ── 事件（root 级委托：tabs/搜索/刷新 + 操作按钮；innerHTML 重建不失效） ──
  root.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      const next = tabBtn.dataset.tab;
      if (next === tab) return;
      tab = next;
      query = '';
      marketLimit = MARKET_PAGE;
      render();
      if (tab === 'market') void fetchMarket(false);
      else void fetchInstalled();
      return;
    }
    if (e.target.closest('#pkt-refresh')) { void (tab === 'market' ? fetchMarket(true) : fetchInstalled()); return; }
    if (e.target.closest('#pkt-more')) { marketLimit += MARKET_PAGE; renderMarket(); return; }
    const inst = e.target.closest('[data-install]');
    if (inst) {
      const entry = registry ? registry.entries.find((x) => entryIdOf(x) === inst.dataset.install) : null;
      if (entry) void installFlow(entry);
      return;
    }
    const upd = e.target.closest('[data-update]');
    if (upd) { void updateFlow(upd.dataset.update); return; }
    const un = e.target.closest('[data-uninstall]');
    if (un) { void uninstallFlow(un.dataset.uninstall); }
  });
  root.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'pkt-q') { query = e.target.value; marketLimit = MARKET_PAGE; renderMarket(); }
  });

  // ── 初始化：进入视图即拉三数据源（reconcile + 门控） ──
  render();
  void fetchMarket(false);
  void fetchInstalled();
  void fetchGate();
  window.__pluginsRefresh = () => { void fetchMarket(false); void fetchInstalled(); void fetchGate(); };
})();