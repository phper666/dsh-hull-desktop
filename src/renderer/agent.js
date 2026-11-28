/* 「Agent」页 UI（外部 ACP Agent 对话视图；桥契约 window.agent.start/send/cancel/close/approve/status/onEvent）
   头部状态 + 消息流（chunk 增量累积）+ 输入区 + 审批弹窗；事件驱动单订阅，离开视图不 close（会话保留）。
   三态降级：桥缺失 / 未配置（start 返回 chat-not-configured）/ 崩溃（error 事件或 status.connected=false）。
   零新增设计语言：复用 --hull-* 令牌 + 壳级 .sbtn/.input/.modal-wrap/.sk-modal。 */
(function () {
  const root = document.getElementById('agent-root');
  if (!root) return;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shortId = (id) => String(id || '').slice(0, 8);
  const agent = () => window.agent; // 惰性取（preload 可能后挂）
  const bridgeOk = () => {
    const a = agent();
    return !!a && typeof a.start === 'function' && typeof a.send === 'function';
  };
  const toast = (msg) => { if (typeof window.toast === 'function') window.toast(msg); };

  const st = {
    connected: false,
    busy: false,
    starting: false,
    state: 'closed', // closed | starting | connected | busy | idle | error
    sessionId: null,
    agentName: '',
    lastError: '',
    configured: true,
  };
  let currentBot = null; // 当前助手气泡（turn_end 置空 → 下一轮新气泡）
  const toolRows = new Map(); // tool id → 行元素
  const approvals = []; // 待处理审批 {requestId, message}
  let approvalOpen = false;
  let subscribed = false;

  // ── 骨架（一次构建；输入区不被消息增量破坏） ──
  root.innerHTML = `
    <div class="ag-head">
      <span class="ag-dot" id="ag-dot" data-state="closed" aria-hidden="true"></span>
      <span class="ag-name" id="ag-name">外部 Agent</span>
      <span class="ag-sid hidden" id="ag-sid" title="点击复制会话 ID" role="button" tabindex="0"></span>
      <span class="ag-spacer"></span>
      <button class="sbtn" id="ag-new">新建会话</button>
      <button class="sbtn danger" id="ag-stop" disabled>停止</button>
    </div>
    <div class="ag-banner hidden" id="ag-banner" role="alert">
      <span id="ag-banner-msg"></span><span class="ag-spacer"></span>
      <button class="sbtn" id="ag-reconnect">重新连接</button>
    </div>
    <div class="ag-msgs" id="ag-msgs"><div class="ag-empty" id="ag-empty"></div></div>
    <div class="ag-hint">
      <span id="ag-hint-msg"></span>
      <button class="ag-linkbtn hidden" id="ag-stop2">停止</button>
    </div>
    <div class="ag-compose">
      <textarea id="ag-input" class="input" rows="1" placeholder="连接后在这里输入消息…" aria-label="发送给 Agent 的消息"></textarea>
      <button class="sbtn primary" id="ag-send" disabled>发送</button>
    </div>`;

  const el = (id) => document.getElementById(id);
  const msgs = el('ag-msgs');
  const input = el('ag-input');

  // ── 渲染 ──
  function sync() {
    el('ag-dot').dataset.state = st.lastError || st.state === 'error'
      ? 'error'
      : !bridgeOk()
        ? 'closed'
        : st.starting || st.state === 'busy'
          ? 'busy'
          : st.state === 'idle'
            ? 'idle'
            : st.connected
              ? 'connected'
              : 'closed';
    el('ag-dot').title = st.connected ? '已连接' : '未连接';
    el('ag-name').textContent = st.agentName || '外部 Agent';

    const sid = el('ag-sid');
    if (st.sessionId) {
      sid.textContent = shortId(st.sessionId);
      sid.classList.remove('hidden');
      sid.title = `点击复制会话 ID：${st.sessionId}`;
    } else {
      sid.classList.add('hidden');
    }

    const banner = el('ag-banner');
    if (st.lastError) {
      el('ag-banner-msg').textContent = `Agent 异常：${st.lastError}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    const canWrite = st.connected && !st.busy;
    input.disabled = !canWrite;
    input.placeholder = !bridgeOk() ? '当前版本不支持 Agent'
      : !st.configured ? '先在设置页配置外部 Agent'
        : !st.connected ? '连接后在这里输入消息…'
          : st.busy ? 'Agent 正在响应…'
            : '输入消息，Enter 发送';
    el('ag-send').disabled = !canWrite || !input.value.trim();
    el('ag-new').disabled = !bridgeOk();
    el('ag-stop').disabled = !st.busy;
    el('ag-stop2').classList.toggle('hidden', !st.busy);
    el('ag-hint-msg').textContent = st.busy
      ? 'Agent 正在响应…'
      : st.connected ? 'Enter 发送 · Shift+Enter 换行' : '';
  }

  function nearBottom() {
    return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
  }
  function stick(wasAtBottom) {
    if (wasAtBottom) msgs.scrollTop = msgs.scrollHeight;
  }
  function hasMessages() {
    return msgs.querySelector('.ag-msg, .ag-tool') !== null;
  }

  const EMPTY_ICO = '<div class="empty-ico" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="16" width="30" height="22" rx="5"/><path d="M24 9v7"/><circle cx="24" cy="7" r="2.2"/><path d="M18 25.5h.01M30 25.5h.01" stroke-width="3.4"/><path d="M18.5 32h11" opacity="0.6"/></svg></div>';

  function renderEmpty() {
    const box = el('ag-empty');
    if (!box) return;
    if (hasMessages()) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    if (!bridgeOk()) {
      box.innerHTML = `${EMPTY_ICO}<h2>当前版本不支持</h2><p>未检测到 Agent 桥，请升级到支持 Agent 的版本后再试。</p>`;
    } else if (!st.configured) {
      box.innerHTML = `${EMPTY_ICO}<h2>尚未配置外部 Agent</h2><p>先到设置页填写外部 Agent 的启动命令，再回到这里连接。未配置时不会启动任何进程。</p><button class="sbtn primary" id="ag-settings">去设置</button>`;
    } else if (!st.connected) {
      box.innerHTML = `${EMPTY_ICO}<h2>连接 Agent</h2><p>连接后即可在这里对话。Agent 需要手动连接，不会随应用自动启动。</p><button class="sbtn primary" id="ag-connect">连接 Agent</button>`;
    } else {
      box.innerHTML = '<h2>开始对话</h2><p>在下方输入消息，Enter 发送。</p>';
    }
  }

  function appendNode(node) {
    const bottom = nearBottom();
    msgs.appendChild(node);
    renderEmpty();
    stick(bottom);
  }

  function appendMsg(role, text) {
    const div = document.createElement('div');
    div.className = `ag-msg ${role}`;
    div.textContent = text;
    appendNode(div);
    return div;
  }

  function appendError(msg) {
    return appendMsg('err', msg);
  }

  function ensureBot() {
    if (currentBot && currentBot.isConnected) return currentBot;
    const div = document.createElement('div');
    div.className = 'ag-msg bot';
    appendNode(div);
    currentBot = div;
    return div;
  }

  const TOOL_TEXT = { pending: '等待中', running: '运行中', in_progress: '运行中', success: '完成', completed: '完成', failed: '失败', error: '失败', canceled: '已取消' };
  const toolText = (s) => TOOL_TEXT[s] || s || '';

  function appendTool(id, title, status) {
    if (id && toolRows.has(id)) return updateTool(id, status);
    const row = document.createElement('div');
    row.className = 'ag-tool';
    row.dataset.status = status || 'pending';
    row.innerHTML = `<span aria-hidden="true">⚙</span><span class="ag-tool-title">${esc(title || '工具调用')}</span><span class="ag-tool-st">${esc(toolText(status))}</span>`;
    appendNode(row);
    if (id) toolRows.set(id, row);
  }

  function updateTool(id, status) {
    const row = toolRows.get(id);
    if (!row) return;
    row.dataset.status = status || row.dataset.status;
    const s = row.querySelector('.ag-tool-st');
    if (s) s.textContent = toolText(status);
  }

  function resetMessages() {
    for (const n of msgs.querySelectorAll('.ag-msg, .ag-tool')) n.remove();
    toolRows.clear();
    currentBot = null;
    renderEmpty();
  }

  // ── 审批弹窗（不自动批准；逐条排队，关闭后弹下一条） ──
  function enqueueApproval(ev) {
    if (!ev || !ev.requestId) return;
    approvals.push({ requestId: ev.requestId, message: ev.message });
    showNextApproval();
  }

  function showNextApproval() {
    if (approvalOpen || approvals.length === 0) return;
    approvalOpen = true;
    const { requestId, message } = approvals.shift();
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.id = 'ag-approve';
    wrap.innerHTML = `<div class="modal-box sk-modal" role="dialog" aria-modal="true" aria-label="Agent 请求授权">
      <h3>Agent 请求授权</h3>
      <div class="sk-modal-body">
        <p>${esc(message || 'Agent 请求执行一个操作。')}</p>
        <p class="sk-muted">请求 ID <code>${esc(shortId(requestId))}</code></p>
      </div>
      <div class="sk-modal-ops">
        <button class="sbtn" id="ag-approve-deny">拒绝</button>
        <button class="sbtn primary" id="ag-approve-allow">允许</button>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    const finish = (approved) => {
      wrap.remove();
      approvalOpen = false;
      const a = agent();
      if (a && typeof a.approve === 'function') {
        try { void a.approve(requestId, approved); } catch { /* 桥异常不阻塞下一条 */ }
      }
      showNextApproval();
    };
    wrap.querySelector('#ag-approve-deny').addEventListener('click', () => finish(false));
    wrap.querySelector('#ag-approve-allow').addEventListener('click', () => finish(true));
  }

  // ── 事件 ──
  // 契约里 tool_call 的 kind（工具类型）与事件 kind 同名，上报时可能互相覆盖 → 未知 kind 按字段兜底归类
  const KNOWN_KINDS = new Set(['status', 'message_chunk', 'tool_call', 'tool_call_update', 'permission_request', 'turn_end', 'error']);
  function eventKind(ev) {
    if (KNOWN_KINDS.has(ev.kind)) return ev.kind;
    if (ev.stopReason) return 'turn_end';
    if (ev.requestId) return 'permission_request';
    if (typeof ev.text === 'string') return 'message_chunk';
    if (ev.id && (ev.title || ev.status)) return 'tool_call';
    if (ev.state) return 'status';
    return ev.message ? 'error' : '';
  }

  function handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    switch (eventKind(ev)) {
      case 'status':
        if (ev.state === 'busy') { st.busy = true; st.starting = false; }
        else if (ev.state === 'idle') { st.busy = false; st.connected = true; st.state = 'idle'; }
        else if (ev.state === 'connected') { st.connected = true; st.state = 'connected'; st.lastError = ''; }
        else if (ev.state === 'starting') { st.starting = true; }
        else if (ev.state === 'closed') { st.connected = false; st.busy = false; st.starting = false; st.state = 'closed'; }
        else if (ev.state === 'error') { st.lastError = ev.message || 'Agent 运行出错'; st.state = 'error'; st.busy = false; st.connected = false; }
        break;
      case 'message_chunk':
        if (typeof ev.text === 'string' && ev.text) ensureBot().textContent += ev.text;
        break;
      case 'tool_call':
        appendTool(ev.id, ev.title, ev.status);
        break;
      case 'tool_call_update':
        updateTool(ev.id, ev.status);
        break;
      case 'permission_request':
        enqueueApproval(ev);
        break;
      case 'turn_end':
        st.busy = false;
        currentBot = null;
        if (st.connected) st.state = 'idle';
        break;
      case 'error':
        st.lastError = ev.message || 'Agent 运行出错';
        st.busy = false;
        st.connected = false;
        st.state = 'error';
        appendError(st.lastError);
        break;
    }
    sync();
    renderEmpty();
  }

  function subscribe() {
    const a = agent();
    if (subscribed || !a || typeof a.onEvent !== 'function') return;
    subscribed = true;
    try { a.onEvent(handleEvent); } catch { subscribed = false; }
  }

  // ── 动作 ──
  async function refreshStatus() {
    const a = agent();
    if (!a || typeof a.status !== 'function') { sync(); renderEmpty(); return; }
    let r = null;
    try { r = await a.status(); } catch { r = null; }
    if (r && r.ok !== false && r.data) {
      const d = r.data;
      st.connected = !!d.connected;
      st.busy = !!d.busy;
      if (d.sessionId) st.sessionId = d.sessionId;
      if (d.agentName) st.agentName = d.agentName;
      st.lastError = d.lastError || '';
      st.state = d.busy ? 'busy' : d.connected ? 'connected' : 'closed';
      if (!st.busy) st.starting = false;
    }
    sync();
    renderEmpty();
  }

  async function connect() {
    const a = agent();
    if (!a || typeof a.start !== 'function') { sync(); renderEmpty(); return; }
    st.starting = true;
    st.lastError = '';
    sync();
    let r = null;
    try { r = await a.start(); } catch (e) { r = { ok: false, message: (e && e.message) || '连接失败' }; }
    st.starting = false;
    if (!r || r.ok === false) {
      const raw = String((r && (r.message || r.code)) || '连接失败');
      if (/not-configured|未配置/.test(raw)) {
        st.configured = false;
        st.state = 'closed';
      } else {
        st.lastError = raw;
        st.state = 'error';
        st.connected = false;
        appendError(raw);
      }
      sync();
      renderEmpty();
      return;
    }
    const d = (r && r.data) || {};
    st.connected = true;
    st.state = 'connected';
    st.sessionId = d.sessionId || st.sessionId;
    st.agentName = (d.agent && d.agent.name) || st.agentName || '';
    sync();
    renderEmpty();
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    const a = agent();
    if (!a || typeof a.send !== 'function') return;
    if (!st.connected) { toast('请先连接 Agent'); return; }
    if (st.busy) return;
    let r = null;
    try { r = await a.send(text); } catch (e) { r = { ok: false, message: (e && e.message) || '发送失败' }; }
    if (!r || r.ok === false) {
      appendError((r && r.message) || '发送失败，请检查 Agent 是否仍在运行。');
      sync();
      return;
    }
    appendMsg('user', text);
    input.value = '';
    input.style.height = 'auto';
    st.busy = true;
    currentBot = null;
    sync();
    input.focus();
  }

  async function stop() {
    const a = agent();
    if (a && typeof a.cancel === 'function') {
      try { await a.cancel(); } catch { /* 忽略：以下按本地状态复位 */ }
    }
    st.busy = false;
    st.state = st.connected ? 'idle' : 'closed';
    sync();
  }

  async function newSession() {
    const a = agent();
    if (a && typeof a.close === 'function') {
      try { await a.close(); } catch { /* 关闭失败也继续尝试新建 */ }
    }
    st.connected = false;
    st.busy = false;
    st.sessionId = null;
    st.lastError = '';
    st.state = 'closed';
    resetMessages();
    sync();
    await connect();
  }

  function copySession() {
    if (!st.sessionId) return;
    const done = () => toast('会话 ID 已复制');
    const b = window.hull;
    if (b && typeof b.copyText === 'function') {
      Promise.resolve(b.copyText(st.sessionId)).then((r) => { if (r && r.ok === false) toast('复制失败'); else done(); }).catch(() => toast('复制失败'));
      return;
    }
    if (navigator.clipboard) navigator.clipboard.writeText(st.sessionId).then(done, () => toast('复制失败'));
  }

  // ── 绑定 ──
  root.addEventListener('click', (e) => {
    if (e.target.closest('#ag-connect')) return void connect();
    if (e.target.closest('#ag-reconnect')) return void connect();
    if (e.target.closest('#ag-settings')) { void window.hull?.showSettings?.(); return; }
    if (e.target.closest('#ag-new')) return void newSession();
    if (e.target.closest('#ag-stop') || e.target.closest('#ag-stop2')) return void stop();
    if (e.target.closest('#ag-send')) return void send();
    if (e.target.closest('#ag-sid')) copySession();
  });
  root.addEventListener('keydown', (e) => {
    if (e.target.id === 'ag-sid' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); copySession(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    el('ag-send').disabled = !st.connected || st.busy || !input.value.trim();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });

  // ── 初始化：订阅事件 + 取一次状态（不自动 start，避免误起进程） ──
  subscribe();
  sync();
  renderEmpty();
  void refreshStatus();
  window.__agentRefresh = () => { st.configured = true; subscribe(); void refreshStatus(); }; // 每次进入重新给「连接」入口（配置可能已在设置页改好）
})();
