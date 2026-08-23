/**
 * S1 Skills 检查器 UI + S2 操作 UI（feishu-s1/s2-skills-api-contract 前端行为契约）
 * 消费 window.skills（S1 4 原语 + S2 7 原语）+ window.hull.openExternal。
 * 纯原生 JS 无框架；深色主题沿用 shell.html 设计语言（skills.css，sk-* 前缀）。
 * 本地搜索 = 内存过滤（frontend-only）；远程 tab 仅浏览；两 tab 结果永不混合（Q-036）。
 * 破坏性操作（移除/升级/禁用）二次确认后发 IPC——主进程侧仍有强制守卫（不信任 renderer）。
 */
(() => {
  const skills = window.skills;
  const hull = window.hull;
  const root = document.getElementById('skills-root');
  if (!skills || !root) return;

  // ── 状态 ──
  let snapshot = { status: 'idle', entries: [], lastScanAt: null, error: null };
  let counts = { total: 0, upgradable: 0, disabled: 0, global: 0 };
  let tab = 'local'; // local | remote（默认本地，Q-036）
  let query = '';
  let platform = 'all';
  let onlyUpgradable = false;
  let onlyDisabled = false;
  let viewMode = localStorage.getItem('skills:viewMode') === 'card' ? 'card' : 'list'; // 列表 | 卡片
  let remoteEntries = null;
  let remoteError = '';
  let remoteLoading = false;
  let polling = false;
  let disabledList = []; // DisabledEntry[]（按路径粒度开关展示）
  let trashEntries = null; // TrashEntry[] | null（徽标/面板数据）

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel) => root.querySelector(sel);
  const PLATFORMS = ['claude-code', 'opencode', 'codex', 'gemini-cli', 'cursor'];
  const upgNames = { latest: '最新', upgradable: '▲ 可升级', unknown: '无法检测版本' };
  /** 升级按钮 tooltip：区分升级通道（无 source → 走 npx 官方通道，不依赖来源链接；有 source → git 轨可兜底） */
  const upgradeTitle = (e) =>
    e.upgradable === 'upgradable'
      ? e.source
        ? '经 npx skills update 升级（有来源，git 轨兜底）'
        : '经 npx skills update 官方通道升级（无需来源链接）'
      : upgNames[e.upgradable] || e.upgradable;
  /** S2 错误码 → 中文文案（契约 §公共异常集 SKILLS_OP_ERROR） */
  const ERR_MSG = {
    'validation-error': '参数或路径不合法',
    'skills-not-found': '目标已不存在，请刷新',
    'skills-conflict': '已被外部修改，请刷新后重试',
    'skills-op-in-progress': '操作进行中，请稍后',
    'restore-conflict': '原路径已被占用，请先移走冲突项或手动处理',
    'skills-upgrade-undetectable': '无法检测版本（无来源信息）',
    'skills-upgrade-failed': '升级失败（已自动回滚到原版本）',
    'skills-io-error': '文件操作失败，可尝试 open 手动处理',
  };
  const errMsg = (code, fallback) => ERR_MSG[code] || fallback || '操作失败';

  // ── 渲染 ──
  function render() {
    root.innerHTML = `
      <div class="sk-toolbar">
        <div class="sk-tabs">
          <button class="sk-tab ${tab === 'local' ? 'active' : ''}" data-tab="local">本地</button>
          <button class="sk-tab ${tab === 'remote' ? 'active' : ''}" data-tab="remote">远程</button>
        </div>
        <input id="sk-q" class="sk-input" placeholder="${tab === 'local' ? '搜索名称 / 描述 / 来源…' : '搜索 skills.sh 市场…'}" value="${esc(query)}" />
        ${tab === 'remote' ? '<button class="sk-btn" id="sk-search-btn" title="搜索市场">搜索</button>' : ''}
        ${tab === 'local' ? `
        <select id="sk-platform" class="sk-select" aria-label="平台筛选">
          <option value="all">全部平台</option>
          ${PLATFORMS.map((p) => `<option value="${p}" ${platform === p ? 'selected' : ''}>${p}</option>`).join('')}
          <option value="global" ${platform === 'global' ? 'selected' : ''}>全局（shared）</option>
        </select>
        <label class="sk-toggle"><input type="checkbox" id="sk-upg" ${onlyUpgradable ? 'checked' : ''} />仅看可升级</label>
        <label class="sk-toggle"><input type="checkbox" id="sk-dis" ${onlyDisabled ? 'checked' : ''} />仅看已禁用</label>
        <div class="sk-viewseg" role="group" aria-label="显示样式">
          <button class="sk-viewbtn ${viewMode === 'list' ? 'active' : ''}" data-view="list">列表</button>
          <button class="sk-viewbtn ${viewMode === 'card' ? 'active' : ''}" data-view="card">卡片</button>
        </div>
        ` : ''}
        <div class="sk-spacer"></div>
        <button class="sk-btn" id="sk-trash">回收站${trashEntries && trashEntries.length ? ` <span class="sk-badge notinstalled">${trashEntries.length}</span>` : ''}</button>
        <button class="sk-btn" id="sk-rescan">重新扫描</button>
      </div>
      <div class="sk-statusbar" id="sk-statusbar"></div>
      <div class="sk-list" id="sk-list"></div>
      <div id="sk-trash-panel" class="sk-trash-panel hidden"></div>
    `;
    renderStatusbar();
    if (tab === 'local') renderLocal();
    else renderRemote();
    bindEvents();
  }

  function renderStatusbar() {
    const el = $('#sk-statusbar');
    if (!el) return;
    const state =
      snapshot.status === 'scanning'
        ? '<span class="sk-scanstate">扫描中…</span>'
        : snapshot.status === 'error'
          ? `<span class="sk-scanstate error">扫描出错：${esc(snapshot.error || '')}</span>`
          : '';
    el.innerHTML = tab === 'remote'
      ? `<span>来源 <b>skills.sh 市场</b>（全球社区技能，可搜索并安装）</span>
         ${remoteError ? '<span class="sk-scanstate error">搜索出错：' + esc(remoteError) + '</span>' : ''}
         ${remoteEntries ? `<span class="sk-spacer"></span><span>${remoteEntries.length} 条结果</span>` : ''}`
      : `
      <span>共 <b>${counts.total}</b> 个 skill</span>
      <span>可升级 <b>${counts.upgradable}</b></span>
      <span>已禁用 <b>${counts.disabled}</b></span>
      <span>全局 <b>${counts.global}</b></span>
      ${state}
      ${snapshot.lastScanAt ? `<span class="sk-spacer"></span><span>上次扫描 ${esc(new Date(snapshot.lastScanAt).toLocaleTimeString())}</span>` : ''}
    `;
  }

  function matchesLocal(e) {
    if (onlyUpgradable && e.upgradable !== 'upgradable') return false;
    if (onlyDisabled && e.enabled) return false;
    // 平台筛选只看该平台专属（scoped）skill；全局 skill 是独立类别（选「全局」才出现）
    if (platform !== 'all') {
      if (platform === 'global') { if (e.scope !== 'global') return false; }
      else if (e.scope !== 'scoped' || !e.platforms.includes(platform)) return false;
    }
    if (query) {
      const q = query.toLowerCase();
      const hay = `${e.name} ${e.description || ''} ${e.source || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function sourceHtml(source) {
    return source
      ? `<a class="sk-source" data-source="${esc(source)}" title="${esc(source)}">${esc(source)}</a>`
      : '<span class="sk-source none">来源未知</span>';
  }

  /** 从 owner/repo@skill 推断 GitHub 直链（含 / 的仓库形态）；无 /（如 smithery.ai@x）→ null */
  function githubUrlOf(ref) {
    const m = String(ref ?? '').match(/^([\w.-]+\/[\w.-]+)@/);
    return m ? `https://github.com/${m[1]}` : null;
  }

  /** 路径行：启用开关（Q-031 按物理路径粒度真禁用） */
  function pathRow(path, isDisabled) {
    return `<div class="sk-path-row">
      <button class="sk-switch ${isDisabled ? 'off' : ''}" data-toggle-path="${esc(path)}" data-next="${isDisabled ? 'true' : 'false'}"
        title="${isDisabled ? '点击启用（恢复到 agent 目录）' : '点击禁用（移出 agent 目录，真生效）'}"
        aria-label="${esc(path)} ${isDisabled ? '已禁用' : '已启用'}"><i></i></button>
      <span class="sk-path ${isDisabled ? 'disabled' : ''}" title="${esc(path)}">${esc(path)}</span>
      <span class="sk-badge ${isDisabled ? 'notinstalled' : 'latest'}">${isDisabled ? '已禁用' : '启用中'}</span>
    </div>`;
  }

  function entryRow(e) {
    const activePaths = e.paths.map((p) => p.path);
    const disabledPaths = disabledList.filter((d) => d.skillName === e.name && !activePaths.includes(d.originalPath));
    const canUpgrade = e.upgradable === 'upgradable';
    return `<div class="sk-row" data-name="${esc(e.name)}">
      <div class="sk-main">
        <div class="sk-name">${esc(e.name)}
          ${e.scope === 'global' ? '<span class="sk-badge global">全局</span>' : ''}
          <span class="sk-badge ${e.upgradable}">${upgNames[e.upgradable] || e.upgradable}</span>
        </div>
        <div class="sk-desc">${e.description ? esc(e.description) : '<i>无描述</i>'}</div>
        <div class="sk-meta">
          ${e.platforms.map((p) => `<span class="sk-badge">${esc(p)}</span>`).join('')}
          ${sourceHtml(e.source)}
        </div>
        <div class="sk-paths">
          ${e.paths.map((p) => pathRow(p.path, false)).join('')}
          ${disabledPaths.map((d) => pathRow(d.originalPath, true)).join('')}
        </div>
      </div>
      <div class="sk-side">
        <button class="sk-btn sk-danger-btn" data-remove="${esc(e.name)}">移除</button>
        ${canUpgrade ? `<button class="sk-btn sk-primary-btn" data-upgrade="${esc(e.name)}" title="${esc(upgradeTitle(e))}">升级</button>` : ''}
      </div>
    </div>`;
  }

  /** 卡片视图：与列表同一份数据（matchesLocal），仅 DOM 结构不同；操作按钮复用同一 data-* 绑定 */
  function entryCard(e) {
    const activePaths = e.paths.map((p) => p.path);
    const disabledPaths = disabledList.filter((d) => d.skillName === e.name && !activePaths.includes(d.originalPath));
    const canUpgrade = e.upgradable === 'upgradable';
    return `<div class="sk-card" data-name="${esc(e.name)}">
      <div class="sk-name">${esc(e.name)}
        ${e.scope === 'global' ? '<span class="sk-badge global">全局</span>' : ''}
        <span class="sk-badge ${e.upgradable}">${upgNames[e.upgradable] || e.upgradable}</span>
      </div>
      <div class="sk-desc">${e.description ? esc(e.description) : '<i>无描述</i>'}</div>
      <div class="sk-meta">
        ${e.platforms.map((p) => `<span class="sk-badge">${esc(p)}</span>`).join('')}
        ${sourceHtml(e.source)}
      </div>
      <div class="sk-paths">
        ${e.paths.map((p) => pathRow(p.path, false)).join('')}
        ${disabledPaths.map((d) => pathRow(d.originalPath, true)).join('')}
      </div>
      <div class="sk-card-ops">
        <button class="sk-btn sk-danger-btn" data-remove="${esc(e.name)}">移除</button>
        ${canUpgrade ? `<button class="sk-btn sk-primary-btn" data-upgrade="${esc(e.name)}" title="${esc(upgradeTitle(e))}">升级</button>` : ''}
      </div>
    </div>`;
  }

  function renderLocal() {
    const list = $('#sk-list');
    list.classList.toggle('card', viewMode === 'card');
    if (snapshot.status === 'scanning' && snapshot.entries.length === 0) {
      list.innerHTML = Array.from({ length: 6 }, () => '<div class="sk-skeleton"></div>').join('');
      return;
    }
    const visible = snapshot.entries.filter(matchesLocal);
    if (visible.length === 0) {
      list.innerHTML = '<div class="sk-empty"><h2>未找到匹配的 skill</h2><p>试试调整搜索词或筛选条件</p></div>';
      return;
    }
    list.innerHTML = visible.map(viewMode === 'card' ? entryCard : entryRow).join('');
  }

  function renderRemote() {
    const list = $('#sk-list');
    if (remoteLoading) {
      list.innerHTML = Array.from({ length: 4 }, () => '<div class="sk-skeleton"></div>').join('');
      return;
    }
    if (remoteError) {
      list.innerHTML = `<div class="sk-empty"><h2>远程不可用</h2><p class="sk-error">${esc(remoteError)}</p><p>本地列表不受影响</p></div>`;
      return;
    }
    if (remoteEntries === null) {
      list.innerHTML = '<div class="sk-empty"><h2>搜索 skills.sh 市场</h2><p>输入关键词后回车或点「搜索」；结果可安装</p></div>';
      return;
    }
    if (remoteEntries.length === 0) {
      list.innerHTML = '<div class="sk-empty"><h2>未找到匹配的 skill</h2><p>试试其他关键词</p></div>';
      return;
    }
    list.innerHTML = remoteEntries
      .map(
        (r) => `<div class="sk-row" data-ref="${esc(r.name)}">
          <div class="sk-main">
            <div class="sk-name">${esc(r.name)}<span class="sk-badge notinstalled">未安装</span></div>
            <div class="sk-desc">${r.description ? esc(r.description) : '<i>无描述</i>'}</div>
            <div class="sk-meta">${sourceHtml(r.source)}${githubUrlOf(r.name) ? `<a class="sk-source" data-source="${esc(githubUrlOf(r.name))}" title="${esc(githubUrlOf(r.name))}">GitHub</a>` : ''}${r.installs != null ? `<span class="sk-badge">安装数 ${r.installs}</span>` : ''}</div>
          </div>
          <div class="sk-side"><button class="sk-btn sk-primary-btn" data-install="${esc(r.name)}">安装</button></div>
        </div>`
      )
      .join('');
  }

  // ── 弹窗（移除/升级二次确认，契约 §12 确认弹窗语义）──
  function modal(title, bodyHtml) {
    const wrap = document.createElement('div');
    wrap.className = 'sk-modal-wrap';
    wrap.innerHTML = `<div class="sk-modal"><h3>${esc(title)}</h3><div class="sk-modal-body">${bodyHtml}</div>
      <div class="sk-modal-ops"><button class="sk-btn" data-close>取消</button></div></div>`;
    root.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('click', (ev) => { if (ev.target === wrap) close(); });
    wrap.querySelector('[data-close]').addEventListener('click', close);
    return { wrap, close };
  }

  /**
   * skill 详情弹窗：点击卡片/行主体打开——单行省略的完整路径、描述、来源、平台在此看全。
   * 路径行带复制按钮（navigator.clipboard，Electron 支持）；来源链接复用 .sk-source 事件。
   */
  function showSkillDetail(entry) {
    const upgText = { latest: '最新', upgradable: '▲ 可升级', unknown: '无法检测版本' }[entry.upgradable] || entry.upgradable;
    const platforms = [...new Set(entry.paths.flatMap((p) => p.affectedPlatforms))];
    const pathRows = entry.paths
      .map((p) => `<div class="sk-detail-path"><code>${esc(p.path)}</code><button class="sk-btn" data-copy-path="${esc(p.path)}" title="复制路径">复制</button></div>`)
      .join('');
    const m = modal(`${esc(entry.name)}`, `
      <div class="sk-detail-head">
        ${entry.scope === 'global' ? '<span class="sk-badge global">全局</span>' : ''}
        <span class="sk-badge ${entry.upgradable}">${esc(upgText)}</span>
      </div>
      ${entry.description ? `<div class="sk-detail-desc">${esc(entry.description)}</div>` : ''}
      <div class="sk-detail-meta">${platforms.map((p) => `<span class="sk-badge">${esc(p)}</span>`).join('')}</div>
      ${entry.source ? `<div class="sk-detail-source">来源：${sourceHtml(entry.source)}</div>` : `<div class="sk-detail-source">来源：<span class="sk-source none">未知</span><button class="sk-btn" id="sk-set-source" title="填写来源">填写</button></div>`}
      ${entry.upgradable === 'upgradable' && !entry.source ? '<div class="sk-detail-source sk-muted">升级通道：npx 官方通道（skills update，无需来源链接）</div>' : ''}
      <div class="sk-detail-paths"><h4>安装路径</h4>${pathRows || '<p class="sk-muted">无路径</p>'}</div>
    `);
    m.wrap.querySelector('#sk-set-source')?.addEventListener('click', () => { m.close(); promptSetSource(entry); });
    m.wrap.querySelectorAll('[data-copy-path]').forEach((b) => {
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(b.dataset.copyPath); toastMsg('已复制路径'); }
        catch { toastMsg('复制失败'); }
      });
    });
    return m;
  }

  /** 填写本地 skill 来源（O-3）：输入 http(s) 链接 → 写 SKILL.md frontmatter metadata.source */
  function promptSetSource(entry) {
    const targetPath = entry.paths[0]?.path || '';
    const m = modal('填写来源', `
      <p>为 <b>${esc(entry.name)}</b> 填写来源链接（写入 SKILL.md 的 <code>metadata.source</code>）：</p>
      <div class="sk-f"><label>来源 URL</label><input id="sk-source-input" class="sk-input" placeholder="https://github.com/owner/repo" style="width:100%" /></div>
      <p class="sk-muted">用于本地 skill 关联到市场/源码位置；填写后本地详情与来源跳转生效。</p>
      <div class="sk-modal-ops"><button class="sk-btn sk-primary-btn" data-confirm>保存</button><button class="sk-btn" data-close>取消</button></div>
    `);
    const inp = m.wrap.querySelector('#sk-source-input');
    inp.focus();
    const save = async () => {
      const src = inp.value.trim();
      if (!/^https?:\/\/.+/.test(src)) { toastMsg('请输入 http(s) 链接'); return; }
      m.close();
      const res = await skills.setSource(targetPath, src);
      if (res.ok === false) { toastMsg(errMsg(res.code, res.message)); return; }
      toastMsg('已保存来源');
      await refreshMeta();
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') void save(); });
    m.wrap.querySelector('[data-confirm]').addEventListener('click', () => void save());
  }

  /** 远程结果详情弹窗（点击远程行主体打开；含安装入口 + 源跳转） */
  function showRemoteDetail(r) {
    const m = modal(`${esc(r.name)}`, `
      <div class="sk-detail-head"><span class="sk-badge notinstalled">未安装</span>${r.installs != null ? `<span class="sk-badge">安装数 ${r.installs}</span>` : ''}</div>
      ${r.description ? `<div class="sk-detail-desc">${esc(r.description)}</div>` : ''}
      ${r.source ? `<div class="sk-detail-source">来源：${sourceHtml(r.source)}</div>` : ''}
      <div class="sk-modal-ops"><button class="sk-btn sk-primary-btn" data-install="${esc(r.name)}">安装</button></div>
    `);
    m.wrap.querySelector('[data-install]')?.addEventListener('click', () => { m.close(); promptInstall(r.name); });
    return m;
  }

  /** 选 agent 安装弹窗：确认目标 agent 后调 skills:installRemote（O-3） */
  function promptInstall(ref) {
    const agents = ['claude-code', 'opencode', 'codex', 'gemini-cli', 'cursor'];
    const m = modal('安装 skill', `
      <p>安装 <b>${esc(ref)}</b> 到哪个 agent？</p>
      <div class="sk-f"><label>目标 agent</label><select id="sk-install-agent" class="sk-select">${agents.map((a) => `<option>${a}</option>`).join('')}</select></div>
      <p class="sk-muted">经 npx skills add 安装到对应 agent 的 skills 目录；安装后可刷新本地列表查看。</p>
      <div class="sk-modal-ops"><button class="sk-btn sk-primary-btn" data-confirm>确认安装</button><button class="sk-btn" data-close>取消</button></div>
    `);
    m.wrap.querySelector('[data-confirm]').addEventListener('click', async () => {
      const agent = m.wrap.querySelector('#sk-install-agent')?.value || 'opencode';
      m.close();
      const res = await skills.installRemote(ref, agent);
      if (res.ok === false) { toastMsg(errMsg(res.code, res.message)); return; }
      toastMsg(`已安装 ${res.data.installedRef} → ${res.data.agent}`);
      await refreshMeta();
      startPolling();
    });
  }

  function confirmRemove(entry) {
    const paths = entry.paths.map((p) => p.path);
    const platforms = [...new Set(entry.paths.flatMap((p) => p.affectedPlatforms))];
    const globalWarn = entry.scope === 'global' ? '<p class="sk-error">⚠ 全局 skill：移除后影响所有 agent 平台</p>' : '';
    const m = modal('移除 skill', `
      <p>将删除以下物理路径（先备份到壳内回收站，可恢复）：</p>
      <ul class="sk-path-list">${paths.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <p>受影响平台：${platforms.map((p) => `<span class="sk-badge">${esc(p)}</span>`).join(' ')}</p>
      ${globalWarn}
      <p class="sk-muted">此操作有二次确认；取消不产生任何变更。</p>
      <div class="sk-modal-ops"><button class="sk-btn sk-danger-btn" data-confirm>确认移除</button></div>
    `);
    m.wrap.querySelector('[data-confirm]').addEventListener('click', async () => {
      m.close();
      const res = await skills.remove(paths);
      if (res.ok === false) { toastMsg(errMsg(res.code, res.message)); return; }
      const failed = res.data.filter((r) => r.status === 'failed');
      if (failed.length) toastMsg(failed.map((r) => errMsg(r.code)).join('；'));
      else toastMsg('已移除（可在回收站恢复）');
      await refreshMeta();
      startPolling();
    });
  }

  function confirmUpgrade(entry) {
    const hashShort = (h) => (h ? h.slice(0, 10) + '…' : '—');
    const m = modal('一键升级', `
      <p>skill：<b>${esc(entry.name)}</b></p>
      <p>来源：${entry.source ? `<a class="sk-source" data-source="${esc(entry.source)}">${esc(entry.source)}</a>` : '未知'}</p>
      <p>本地哈希 <code>${hashShort(entry.localHash)}</code> vs 远端哈希 <code>${hashShort(entry.remoteHash)}</code></p>
      <p class="sk-muted">原子替换执行，失败自动回滚到原版本。</p>
      <div class="sk-modal-ops"><button class="sk-btn sk-primary-btn" data-confirm>确认升级</button></div>
    `);
    m.wrap.querySelector('[data-confirm]').addEventListener('click', async () => {
      m.close();
      const results = [];
      for (const p of entry.paths) {
        try {
          const r = await skills.upgrade(p.path);
          if (r.ok === false) results.push(`${p.path}: ${errMsg(r.code, r.message)}`);
        } catch (err) {
          results.push(`${p.path}: ${(err).message || '失败'}`);
        }
      }
      toastMsg(results.length ? results.join('；') : '升级完成');
      await refreshMeta();
      startPolling();
    });
  }

  // ── 回收站面板（D7：工具条按钮 + 弹层；恢复冲突提示态）──
  async function toggleTrashPanel() {
    const panel = $('#sk-trash-panel');
    if (!panel) return;
    if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    panel.innerHTML = '<div class="sk-skeleton"></div>';
    const res = await skills.getTrashList();
    if (res.ok === false) { panel.innerHTML = `<p class="sk-error">${errMsg(res.code, res.message)}</p>`; return; }
    trashEntries = res.data.entries;
    if (trashEntries.length === 0) {
      panel.innerHTML = '<div class="sk-trash-head"><b>回收站</b><button class="sk-btn" data-trash-close>关闭</button></div><p class="sk-muted">回收站为空</p>';
    } else {
      panel.innerHTML = `<div class="sk-trash-head"><b>回收站（${trashEntries.length}）</b><button class="sk-btn" data-trash-close>关闭</button></div>` +
        trashEntries.map((t) => `
          <div class="sk-trash-row" data-trash-id="${esc(t.id)}">
            <div><b>${esc(t.skillName)}</b> <span class="sk-muted">${(t.sizeBytes / 1024).toFixed(1)} KB · ${esc(new Date(t.deletedAt).toLocaleString())}</span></div>
            <div class="sk-path">${esc(t.originalPath)}</div>
            <div class="sk-trash-conflict hidden">原路径已被占用，请先移走冲突项或手动处理</div>
            <button class="sk-btn sk-primary-btn" data-restore="${esc(t.id)}">恢复</button>
          </div>`).join('');
    }
    panel.querySelector('[data-trash-close]')?.addEventListener('click', () => panel.classList.add('hidden'));
    for (const btn of panel.querySelectorAll('[data-restore]')) {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.sk-trash-row');
        const res2 = await skills.restoreFromTrash(btn.dataset.restore);
        if (res2.ok === false) {
          if (res2.code === 'restore-conflict') row?.querySelector('.sk-trash-conflict')?.classList.remove('hidden');
          else toastMsg(errMsg(res2.code, res2.message));
          return;
        }
        toastMsg('已恢复');
        await refreshMeta();
        startPolling();
        panel.classList.add('hidden'); // 刷新后重开可见新状态
      });
    }
  }

  // ── 事件 ──
  function bindEvents() {
    for (const btn of root.querySelectorAll('[data-tab]')) {
      btn.addEventListener('click', () => {
        const next = btn.dataset.tab;
        if (next === tab) return;
        tab = next;
        query = '';
        remoteEntries = null; // 切换清空对方结果（Q-036）
        remoteError = '';
        render();
        if (tab === 'local') $('#sk-q').focus();
      });
    }
    $('#sk-q').addEventListener('input', (ev) => {
      query = ev.target.value;
      if (tab === 'local') renderLocal();
    });
    $('#sk-q').addEventListener('keydown', async (ev) => {
      if (ev.key !== 'Enter' || tab !== 'remote') return;
      await runRemoteSearch();
    });
    // 远程 tab 搜索按钮（O-3 优化：回车 + 按钮双触发）
    $('#sk-search-btn')?.addEventListener('click', () => void runRemoteSearch());
    $('#sk-rescan').addEventListener('click', () => void triggerScan());
    $('#sk-trash').addEventListener('click', () => void toggleTrashPanel());
    const platSel = $('#sk-platform');
    if (platSel)
      platSel.addEventListener('change', () => { platform = platSel.value; renderLocal(); });
    const upg = $('#sk-upg');
    if (upg) upg.addEventListener('change', () => { onlyUpgradable = upg.checked; renderLocal(); });
    const dis = $('#sk-dis');
    if (dis) dis.addEventListener('change', () => { onlyDisabled = dis.checked; renderLocal(); });
    // 显示样式切换（列表/卡片，localStorage 持久化）
    for (const btn of root.querySelectorAll('[data-view]')) {
      btn.addEventListener('click', () => {
        if (btn.dataset.view === viewMode) return;
        viewMode = btn.dataset.view;
        localStorage.setItem('skills:viewMode', viewMode);
        // 同步分段按钮 active 态（renderLocal 只重渲染列表区，不碰工具条）
        for (const b of root.querySelectorAll('[data-view]')) b.classList.toggle('active', b.dataset.view === viewMode);
        renderLocal();
      });
    }

    // 路径级启用开关（Q-031）
    for (const sw of root.querySelectorAll('[data-toggle-path]')) {
      sw.addEventListener('click', async () => {
        const path = sw.dataset.togglePath;
        const next = sw.dataset.next === 'true';
        sw.disabled = true;
        try {
          const res = await skills.setEnabled(path, next);
          if (res.ok === false) toastMsg(errMsg(res.code, res.message));
        } catch {
          toastMsg('操作失败');
        }
        await refreshMeta();
        startPolling();
      });
    }
    // 移除 / 升级（二次确认）
    for (const btn of root.querySelectorAll('[data-remove]')) {
      btn.addEventListener('click', () => {
        const entry = snapshot.entries.find((e) => e.name === btn.dataset.remove);
        if (entry) confirmRemove(entry);
      });
    }
    for (const btn of root.querySelectorAll('[data-upgrade]')) {
      btn.addEventListener('click', () => {
        const entry = snapshot.entries.find((e) => e.name === btn.dataset.upgrade);
        if (entry) confirmUpgrade(entry);
      });
    }
    // 来源跳转（渲染侧 ^https:// 白名单 + main 侧二次校验，Q-038 双层防御）
    for (const a of root.querySelectorAll('.sk-source[data-source]')) {
      a.addEventListener('click', async () => {
        const url = a.dataset.source;
        if (!/^https:\/\/.+/.test(url)) return;
        try {
          const r = await hull.openExternal(url);
          if (r && r.ok === false) toastMsg(r.message || '打开失败');
        } catch { toastMsg('打开失败'); }
      });
    }
  }

  async function runRemoteSearch() {
    const q = query.trim();
    if (!q) return;
    remoteLoading = true;
    remoteError = '';
    renderRemote();
    try {
      const res = await skills.searchRemote(q);
      if (res && res.ok === false) {
        remoteError = res.message || '远程不可用';
        remoteEntries = null;
      } else {
        remoteEntries = res.data.entries;
      }
    } catch {
      remoteError = '远程不可用';
      remoteEntries = null;
    }
    remoteLoading = false;
    renderRemote();
  }

  /** 元数据刷新：禁用映射 + 回收站徽标（操作后调用） */
  async function refreshMeta() {
    try {
      const d = await skills.getDisabledList();
      disabledList = d && d.ok !== false ? d.data.entries : [];
      const t = await skills.getTrashList();
      trashEntries = t && t.ok !== false ? t.data.entries : trashEntries;
    } catch { /* 静默 */ }
    render();
  }

  // ── 数据流：scan 幂等触发 + scanning 期间轮询快照（300ms，FR-10 异步不阻塞）──
  async function triggerScan() {
    try {
      await skills.scan();
      startPolling();
    } catch {
      /* 静默：状态栏保留上次快照 */
    }
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    const tick = async () => {
      try {
        const snapRes = await skills.getSnapshot();
        if (snapRes && snapRes.ok !== false) {
          snapshot = snapRes.data;
          const c = await skills.getStatus();
          if (c && c.ok !== false) counts = c.data;
          renderStatusbar();
          if (tab === 'local') renderLocal();
        }
        if (snapshot.status === 'scanning') setTimeout(tick, 300);
        else {
          polling = false;
          await refreshMeta(); // 就绪后拉取禁用映射（路径开关态）
        }
      } catch {
        polling = false;
      }
    };
    tick();
  }

  function toastMsg(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ── 事件委托：点击卡片/行主体 → 详情弹窗（re-render 重建列表也生效；
  //    排除操作按钮/开关/来源链接；路径开关行内点击不触发）──
  root.addEventListener('click', (e) => {
    // 安装按钮（远程结果 + 详情弹窗内）→ 选 agent
    const installBtn = e.target.closest('[data-install]');
    if (installBtn && root.contains(installBtn)) {
      e.stopPropagation();
      promptInstall(installBtn.dataset.install);
      return;
    }
    // 本地卡片/行 → 本地详情
    const card = e.target.closest('.sk-card[data-name], .sk-row[data-name]');
    if (card && root.contains(card) && !e.target.closest('button, a, .sk-switch, .sk-card-ops, .sk-side')) {
      const entry = snapshot.entries.find((x) => x.name === card.dataset.name);
      if (entry) showSkillDetail(entry);
      return;
    }
    // 远程结果行 → 远程详情
    const rrow = e.target.closest('.sk-row[data-ref]');
    if (rrow && root.contains(rrow) && !e.target.closest('button, a')) {
      const r = remoteEntries?.find((x) => x.name === rrow.dataset.ref);
      if (r) showRemoteDetail(r);
    }
  });

  // ── 初始化：进入视图即触发后台扫描（契约核心流程：renderer 调 skills:scan 幂等触发）──
  render();
  void triggerScan();
})();
