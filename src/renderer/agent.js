/* 「Agent」页 UI（外部 ACP Agent 对话视图；桥契约 window.agent.start/send/cancel/close/approve/status/onEvent）
   结构参照 dsh-agent 原版：顶栏工具条 + 空态建议卡 + 气泡消息流（轻量 Markdown）+ 工具轨迹卡 + 审批卡；
   配色复用 --hull-* 令牌。事件驱动单订阅，离开视图不 close（会话保留）。
   降级：桥缺失 / 未配置（start 返回 chat-not-configured）/ 崩溃（error 事件或 status.connected=false）。 */
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
  const pad2 = (n) => String(n).padStart(2, '0');
  const clock = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

  const st = {
    connected: false,
    busy: false,
    starting: false,
    state: 'closed', // closed | starting | connected | busy | idle | error
    sessionId: null,
    agentName: '',
    lastError: '',
    configured: true,
    awaiting: false, // 本轮已发送、尚未收到首个 chunk（思考指示）
  };
  let currentBot = null; // { el, raw, md } 当前助手气泡
  let lastUserText = ''; // 重试用：最近一次成功发送的用户文本
  const toolRows = new Map(); // tool id → { el, body, pre }
  const approvals = []; // 待处理审批 {requestId, message}
  let approvalOpen = false;
  let subscribed = false;

  const ICON = {
    seal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7.5" width="16" height="12" rx="2.5"/><path d="M12 4v3.5"/><circle cx="12" cy="3.2" r="1.1"/><path d="M9 12.5h.01M15 12.5h.01" stroke-width="2.2"/><path d="M9.5 16.5h5" opacity="0.6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H5.5A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M12 6l6 6-6 6"/></svg>',
  };

  // ── 骨架（一次构建；输入区不被消息增量破坏） ──
  root.innerHTML = `
    <div class="ag-top">
      <div class="ag-brand">
        <span class="ag-seal" aria-hidden="true">${ICON.seal}</span>
        <div class="ag-brand-txt">
          <span class="ag-name" id="ag-name">外部 Agent</span>
          <span class="ag-state"><span class="ag-dot" id="ag-dot" data-state="closed" aria-hidden="true"></span><span id="ag-state-txt">未连接</span></span>
        </div>
      </div>
      <div class="ag-tools">
        <button class="ag-chip hidden" id="ag-sid" type="button" title="点击复制会话 ID">${ICON.copy}<span id="ag-sid-txt"></span></button>
        <button class="ag-btn" id="ag-new" type="button" disabled>新会话</button>
        <button class="ag-btn danger" id="ag-stop" type="button" disabled>停止</button>
        <button class="ag-btn" id="ag-export" type="button" disabled>导出</button>
      </div>
    </div>
    <div class="ag-banner hidden" id="ag-banner" role="alert">
      <span id="ag-banner-msg"></span><span class="ag-spacer"></span>
      <button class="ag-btn" id="ag-reconnect" type="button">重新连接</button>
    </div>
    <div class="ag-msgs" id="ag-msgs"><div class="ag-stream" id="ag-stream"><div class="ag-empty" id="ag-empty"></div></div></div>
    <div class="ag-thinking" id="ag-thinking" hidden><span class="ag-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>Agent 正在思考…</span></div>
    <div class="ag-compose-wrap">
      <div class="ag-compose">
        <textarea id="ag-input" rows="1" placeholder="连接后在这里输入消息…" aria-label="发送给 Agent 的消息"></textarea>
        <button class="ag-send" id="ag-send" type="button" aria-label="发送" disabled>${ICON.send}</button>
      </div>
      <div class="ag-hint"><span id="ag-hint-msg"></span><button class="ag-linkbtn hidden" id="ag-stop2" type="button">停止</button></div>
    </div>`;

  const el = (id) => document.getElementById(id);
  const msgs = el('ag-msgs');
  const stream = el('ag-stream');
  const input = el('ag-input');

  // ── 轻量 Markdown（先转义再渲染；支持粗体/行内代码/代码块/列表） ──
  function renderMd(raw) {
    const blocks = [];
    const inlines = [];
    let s = esc(String(raw ?? ''));
    s = s.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
      const l = String(lang || '').trim();
      blocks.push(`<div class="ag-code">${l ? `<div class="ag-code-lang">${l}</div>` : ''}<pre><code>${String(code).replace(/\n$/, '')}</code></pre></div>`);
      return `\u0001${blocks.length - 1}\u0001`;
    });
    s = s.replace(/`([^`\n]+)`/g, (_m, code) => {
      inlines.push(`<code>${code}</code>`);
      return `\u0002${inlines.length - 1}\u0002`;
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

    const out = [];
    let para = [];
    let list = null; // { tag, items }
    const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
    const flushList = () => {
      if (!list) return;
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (const line of s.split('\n')) {
      const t = line.trim();
      if (!t) { flushPara(); flushList(); continue; }
      const bm = /^\u0001(\d+)\u0001$/.exec(t);
      if (bm) { flushPara(); flushList(); out.push(blocks[Number(bm[1])]); continue; }
      const ul = /^[-*+]\s+(.*)$/.exec(t);
      const ol = /^\d+[.)]\s+(.*)$/.exec(t);
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((ul || ol)[1]);
        continue;
      }
      flushList();
      para.push(t);
    }
    flushPara();
    flushList();
    return out.join('').replace(/\u0002(\d+)\u0002/g, (_m, i) => inlines[Number(i)]);
  }

  // ── 状态渲染 ──
  function stateText() {
    if (!bridgeOk()) return '未连接';
    if (st.lastError || st.state === 'error') return '出错';
    if (st.starting) return '连接中';
    if (st.busy) return '思考中';
    return st.connected ? '已连接' : '未连接';
  }

  function sync() {
    const bridged = bridgeOk();
    el('ag-dot').dataset.state = !bridged ? 'closed'
      : st.lastError || st.state === 'error' ? 'error'
        : st.starting || st.busy ? 'busy'
          : st.connected ? 'connected' : 'closed';
    el('ag-state-txt').textContent = stateText();
    el('ag-name').textContent = st.agentName || '外部 Agent';

    const sid = el('ag-sid');
    if (st.sessionId) {
      sid.classList.remove('hidden');
      sid.title = `点击复制会话 ID：${st.sessionId}`;
      el('ag-sid-txt').textContent = shortId(st.sessionId);
    } else {
      sid.classList.add('hidden');
    }

    const banner = el('ag-banner');
    banner.classList.toggle('hidden', !st.lastError);
    if (st.lastError) el('ag-banner-msg').textContent = `Agent 异常：${st.lastError}`;

    const canWrite = st.connected && !st.busy && bridged;
    input.disabled = !canWrite;
    input.placeholder = !bridged ? '当前版本不支持 Agent'
      : !st.configured ? '先在设置页配置外部 Agent'
        : !st.connected ? '连接后在这里输入消息…'
          : st.busy ? 'Agent 正在响应…'
            : '输入消息，Enter 发送';
    el('ag-send').disabled = !canWrite || !input.value.trim();
    el('ag-new').disabled = !bridged;
    el('ag-stop').disabled = !st.busy;
    el('ag-stop2').classList.toggle('hidden', !st.busy);
    el('ag-export').disabled = !hasMessages();
    el('ag-thinking').hidden = !(st.busy && st.awaiting);
    el('ag-hint-msg').textContent = bridged ? 'Enter 发送 · Shift+Enter 换行 · 内容由你的 Agent 处理' : '';
  }

  function nearBottom() {
    return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
  }
  function hasMessages() {
    return msgs.querySelector('.ag-msg, .ag-tcard, .ag-err') !== null;
  }

  function appendNode(node) {
    const bottom = nearBottom();
    stream.appendChild(node);
    renderEmpty();
    if (bottom) msgs.scrollTop = msgs.scrollHeight;
  }

  // ── 空态欢迎（建议卡点击直接发送） ──
  const SUGGESTIONS = [
    {
      k: '解释代码',
      d: '逐步说明一段代码的作用与边界',
      q: '解释一下这段代码在做什么',
      ico: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7l-5 5 5 5"/><path d="M15 7l5 5-5 5"/></svg>',
    },
    {
      k: '检查改动',
      d: '审阅当前改动里的问题与风险',
      q: '帮我检查最近改动有没有问题',
      ico: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-2.9 7.4-7 9-4.1-1.6-7-4.8-7-9V6z"/><path d="M9 12l2.2 2.2L15.5 10"/></svg>',
    },
    {
      k: '写测试',
      d: '为关键逻辑补上可运行的测试',
      q: '为这个模块补一组单元测试',
      ico: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M10 3v5.5L5.6 17a2 2 0 0 0 1.8 3h9.2a2 2 0 0 0 1.8-3L14 8.5V3"/><path d="M8 14h8"/></svg>',
    },
  ];

  function renderEmpty() {
    const box = el('ag-empty');
    if (!box) return;
    if (hasMessages()) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    if (!bridgeOk()) {
      box.innerHTML = `<span class="ag-seal lg" aria-hidden="true">${ICON.seal}</span><h2>当前版本不支持</h2><p>未检测到 Agent 桥，请升级到支持 Agent 的版本后再试。</p>`;
      return;
    }
    if (!st.configured) {
      box.innerHTML = `<span class="ag-seal lg" aria-hidden="true">${ICON.seal}</span><h2>尚未配置外部 Agent</h2><p>先到设置页填写外部 Agent 的启动命令，再回到这里连接。未配置时不会启动任何进程。</p><div class="ag-empty-cta"><button class="sbtn primary" id="ag-settings" type="button">去设置</button></div>`;
      return;
    }
    const cards = SUGGESTIONS.map((s) => `<button class="ag-sug" type="button" data-q="${esc(s.q)}">
        <span class="ag-sug-ico" aria-hidden="true">${s.ico}</span>
        <span class="ag-sug-body"><span class="ag-sug-k">${esc(s.k)}</span><span class="ag-sug-d">${esc(s.d)}</span><span class="ag-sug-t">${esc(s.q)}</span></span>
      </button>`).join('');
    const cta = st.connected
      ? '<div class="ag-empty-cta"><span class="ag-pill"><span class="ag-dot" aria-hidden="true"></span>已连接</span></div>'
      : `<div class="ag-empty-cta"><button class="sbtn primary" id="ag-connect" type="button"${st.starting ? ' disabled' : ''}>${st.starting ? '连接中…' : '连接 Agent'}</button></div>`;
    box.innerHTML = `<span class="ag-seal lg" aria-hidden="true">${ICON.seal}</span>
      <h2>开始和 Agent 对话</h2>
      <p>连接后由你配置的外部 ACP Agent 提供响应。</p>
      <div class="ag-sugs">${cards}</div>
      ${cta}`;
  }

  // ── 消息 ──
  function appendUser(text) {
    const div = document.createElement('div');
    div.className = 'ag-msg user';
    div.innerHTML = '<div class="ag-bubble"></div><span class="ag-ts"></span>';
    div.querySelector('.ag-bubble').textContent = text;
    div.querySelector('.ag-ts').textContent = clock();
    appendNode(div);
  }

  function ensureBot() {
    if (currentBot && currentBot.el.isConnected) return currentBot;
    for (const b of msgs.querySelectorAll('.ag-msg.bot')) {
      const r = b.querySelector('[data-act="retry"]');
      if (r) r.remove(); // 「重试」只留最后一条助手消息
    }
    const div = document.createElement('div');
    div.className = 'ag-msg bot streaming';
    div.innerHTML = `<span class="ag-avatar" aria-hidden="true">${ICON.seal}</span>
      <div class="ag-bot-body"><div class="ag-md"></div>
        <div class="ag-msg-foot"><span class="ag-ts"></span>
          <span class="ag-acts"><button class="ag-mini" type="button" data-act="copy">复制</button><button class="ag-mini" type="button" data-act="retry">重试</button></span>
        </div>
      </div>`;
    div.querySelector('.ag-ts').textContent = clock();
    currentBot = { el: div, raw: '', md: div.querySelector('.ag-md') };
    appendNode(div);
    return currentBot;
  }

  function appendError(msg) {
    const div = document.createElement('div');
    div.className = 'ag-err';
    div.innerHTML = '<span class="ag-err-text"></span><button type="button" data-act="reconnect">重新连接</button>';
    div.querySelector('.ag-err-text').textContent = msg;
    appendNode(div);
  }

  // ── 工具轨迹卡 ──
  const T_STATE = { pending: 'wait', waiting: 'wait', in_progress: 'run', running: 'run', completed: 'ok', success: 'ok', failed: 'fail', error: 'fail', cancelled: 'cancel', canceled: 'cancel' };
  const T_TEXT = { wait: '等待中', run: '运行中', ok: '完成', fail: '失败', cancel: '已取消' };
  const toolState = (s) => T_STATE[String(s || '').toLowerCase()] || 'wait';

  function toolContentText(content) {
    const out = [];
    const walk = (n) => {
      if (n == null) return;
      if (typeof n === 'string') { if (n.trim()) out.push(n); return; }
      if (Array.isArray(n)) { for (const x of n) walk(x); return; }
      if (typeof n !== 'object') return;
      if (typeof n.text === 'string') { if (n.text.trim()) out.push(n.text); return; }
      for (const k of ['content', 'content_block', 'update']) if (n[k] !== undefined) walk(n[k]);
    };
    walk(content);
    return out.join('\n\n');
  }

  function appendTool(id, title, toolKind, status) {
    if (id && toolRows.has(id)) { updateTool(id, { status, toolKind }); return; }
    const card = document.createElement('details');
    card.className = 'ag-tcard';
    card.dataset.state = toolState(status);
    card.innerHTML = `<summary><span class="ag-tdot" aria-hidden="true"></span><span class="ag-tname"></span><span class="ag-tstate"></span></summary>
      <div class="ag-tbody" hidden><pre></pre></div>`;
    card.querySelector('.ag-tname').textContent = title || '工具调用';
    if (toolKind) {
      const k = document.createElement('span');
      k.className = 'ag-tkind';
      k.textContent = toolKind;
      card.querySelector('.ag-tstate').before(k);
    }
    card.querySelector('.ag-tstate').textContent = T_TEXT[card.dataset.state] || '';
    if (id) toolRows.set(id, { el: card, body: card.querySelector('.ag-tbody'), pre: card.querySelector('pre') });
    appendNode(card);
  }

  function updateTool(id, patch) {
    const rec = toolRows.get(id);
    if (!rec) return;
    if (patch.status) {
      const s = toolState(patch.status);
      rec.el.dataset.state = s;
      rec.el.querySelector('.ag-tstate').textContent = T_TEXT[s] || '';
    }
    if (patch.toolKind && !rec.el.querySelector('.ag-tkind')) {
      const k = document.createElement('span');
      k.className = 'ag-tkind';
      k.textContent = patch.toolKind;
      rec.el.querySelector('.ag-tstate').before(k);
    }
    const text = toolContentText(patch.content);
    if (text) {
      rec.pre.textContent = text;
      rec.body.hidden = false;
      rec.el.open = true; // 结果到达默认展开，可手动收起
    }
  }

  function resetMessages() {
    for (const n of msgs.querySelectorAll('.ag-msg, .ag-tcard, .ag-err')) n.remove();
    toolRows.clear();
    currentBot = null;
    lastUserText = '';
    renderEmpty();
  }

  // ── 审批卡（不自动批准；遮罩/Esc 不关闭；逐条排队） ──
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
    wrap.innerHTML = `<div class="ag-ap" role="dialog" aria-modal="true" aria-labelledby="ag-ap-title">
      <div class="ag-ap-head">
        <span class="ag-ap-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 3 20h18L12 4z"/><path d="M12 10v4.4"/><path d="M12 17.3v.1"/></svg></span>
        <div><h3 id="ag-ap-title">写操作需要确认</h3><div class="ag-ap-sub">Agent 请求执行一项会产生实际影响的动作，确认后才会提交。</div></div>
      </div>
      <div class="ag-ap-quote"></div>
      <div class="ag-ap-meta"><span class="ag-ap-tag"></span><span class="ag-ap-note">不确认不会执行</span></div>
      <div class="ag-ap-ops">
        <button class="sbtn" id="ag-approve-deny" type="button">拒绝</button>
        <button class="sbtn primary" id="ag-approve-allow" type="button">允许</button>
      </div>
    </div>`;
    wrap.querySelector('.ag-ap-quote').textContent = message || 'Agent 请求执行一个操作。';
    wrap.querySelector('.ag-ap-tag').textContent = shortId(requestId);
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
        else if (ev.state === 'idle') { st.busy = false; st.awaiting = false; st.connected = true; st.state = 'idle'; }
        else if (ev.state === 'connected') { st.connected = true; st.state = 'connected'; st.lastError = ''; }
        else if (ev.state === 'starting') { st.starting = true; }
        else if (ev.state === 'closed') { st.connected = false; st.busy = false; st.starting = false; st.awaiting = false; st.state = 'closed'; }
        else if (ev.state === 'error') { st.lastError = ev.message || 'Agent 运行出错'; st.state = 'error'; st.busy = false; st.awaiting = false; st.connected = false; }
        break;
      case 'message_chunk': {
        if (typeof ev.text !== 'string' || !ev.text) break;
        st.awaiting = false;
        const bottom = nearBottom();
        const b = ensureBot();
        b.raw += ev.text;
        b.el.dataset.raw = b.raw;
        b.md.innerHTML = renderMd(b.raw);
        if (bottom) msgs.scrollTop = msgs.scrollHeight;
        break;
      }
      case 'tool_call':
        st.awaiting = false;
        appendTool(ev.id, ev.title, ev.toolKind, ev.status);
        break;
      case 'tool_call_update':
        updateTool(ev.id, { status: ev.status, content: ev.content });
        break;
      case 'permission_request':
        enqueueApproval(ev);
        break;
      case 'turn_end':
        st.busy = false;
        st.awaiting = false;
        if (currentBot) currentBot.el.classList.remove('streaming');
        currentBot = null;
        if (st.connected) st.state = 'idle';
        break;
      case 'error':
        st.lastError = ev.message || 'Agent 运行出错';
        st.busy = false;
        st.awaiting = false;
        st.connected = false;
        st.state = 'error';
        if (currentBot) currentBot.el.classList.remove('streaming');
        currentBot = null;
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
      if (!st.busy) { st.starting = false; st.awaiting = false; }
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
    renderEmpty();
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

  function resizeInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight || 0, 140)}px`;
  }

  async function sendText(text) {
    const value = String(text ?? '').trim();
    if (!value || !bridgeOk()) return;
    if (!st.connected) {
      await connect();
      if (!st.connected) { toast('请先连接 Agent'); return; }
    }
    if (st.busy) return;
    // 先乐观置 busy 再 await：main 可能在 ack 之前就推 turn_end/idle（快 agent），
    // 若等 ack 后再置 busy 会覆盖已到达的 idle → 假「思考中」卡死。
    lastUserText = value;
    appendUser(value);
    if (input.value.trim() === value) { input.value = ''; resizeInput(); }
    st.busy = true;
    st.awaiting = true;
    currentBot = null;
    sync();
    let r = null;
    try { r = await agent().send(value); } catch (e) { r = { ok: false, message: (e && e.message) || '发送失败' }; }
    if (!r || r.ok === false) {
      st.busy = false;
      st.awaiting = false;
      appendError((r && r.message) || '发送失败，请检查 Agent 是否仍在运行。');
      sync();
      return;
    }
    input.focus();
  }

  function send() { return sendText(input.value); }

  function retry() {
    if (!lastUserText || st.busy || !st.connected) return;
    void sendText(lastUserText);
  }

  async function stop() {
    const a = agent();
    if (a && typeof a.cancel === 'function') {
      try { await a.cancel(); } catch { /* 忽略：以下按本地状态复位 */ }
    }
    st.busy = false;
    st.awaiting = false;
    st.state = st.connected ? 'idle' : 'closed';
    if (currentBot) currentBot.el.classList.remove('streaming');
    currentBot = null;
    sync();
  }

  async function newSession() {
    const a = agent();
    if (a && typeof a.close === 'function') {
      try { await a.close(); } catch { /* 关闭失败也继续尝试新建 */ }
    }
    st.connected = false;
    st.busy = false;
    st.awaiting = false;
    st.sessionId = null;
    st.lastError = '';
    st.state = 'closed';
    resetMessages();
    sync();
    await connect();
  }

  // ── 复制 / 导出 ──
  function copyText(text) {
    const b = window.hull;
    if (b && typeof b.copyText === 'function') {
      return Promise.resolve(b.copyText(text)).then((r) => !r || r.ok !== false, () => false);
    }
    if (navigator.clipboard) return navigator.clipboard.writeText(text).then(() => true, () => false);
    return Promise.resolve(false);
  }

  function copySession() {
    if (!st.sessionId) return;
    void copyText(st.sessionId).then((ok) => {
      const lbl = el('ag-sid-txt');
      if (!ok) { toast('复制失败'); return; }
      if (!lbl) return;
      const old = lbl.textContent;
      lbl.textContent = '已复制';
      setTimeout(() => { lbl.textContent = old; }, 1200);
    });
  }

  function copyMessage(msgEl, btn) {
    const raw = msgEl.dataset.raw || '';
    if (!raw) return;
    void copyText(raw).then((ok) => {
      if (!btn) return;
      btn.textContent = ok ? '已复制' : '复制失败';
      btn.classList.toggle('done', ok);
      setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('done'); }, 1400);
    });
  }

  function exportChat() {
    const lines = ['# Agent 对话', '', `- 会话：${st.sessionId || '未建立'}`, `- Agent：${st.agentName || '外部 Agent'}`, `- 导出时间：${new Date().toLocaleString('zh-CN')}`, ''];
    for (const node of stream.children) {
      if (node.classList.contains('ag-msg')) {
        const ts = node.querySelector('.ag-ts')?.textContent || '';
        if (node.classList.contains('user')) {
          lines.push(`## 我 · ${ts}`, '', node.querySelector('.ag-bubble')?.textContent || '', '');
        } else if (node.classList.contains('bot')) {
          const raw = (node.dataset.raw || '').trim();
          if (raw) lines.push(`## Agent · ${ts}`, '', raw, '');
        }
      } else if (node.classList.contains('ag-tcard')) {
        const name = node.querySelector('.ag-tname')?.textContent || '工具调用';
        const kind = node.querySelector('.ag-tkind')?.textContent || '';
        const state = node.querySelector('.ag-tstate')?.textContent || '';
        lines.push(`> 工具：${name}${kind ? `（${kind}）` : ''} · ${state}`, '');
        const body = (node.querySelector('.ag-tbody pre')?.textContent || '').trim();
        if (body) lines.push('```', body, '```', '');
      } else if (node.classList.contains('ag-err')) {
        lines.push(`> 错误：${node.querySelector('.ag-err-text')?.textContent || ''}`, '');
      }
    }
    const stamp = new Date();
    const day = `${stamp.getFullYear()}${pad2(stamp.getMonth() + 1)}${pad2(stamp.getDate())}-${pad2(stamp.getHours())}${pad2(stamp.getMinutes())}`;
    const name = `agent-chat-${shortId(st.sessionId) || 'session'}-${day}.md`;
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出对话');
  }

  // ── 绑定 ──
  root.addEventListener('click', (e) => {
    const sug = e.target.closest('.ag-sug');
    if (sug) return void sendText(sug.dataset.q || '');
    if (e.target.closest('#ag-connect')) return void connect();
    if (e.target.closest('#ag-reconnect')) return void connect();
    if (e.target.closest('#ag-settings')) { void window.hull?.showSettings?.(); return; }
    if (e.target.closest('#ag-new')) return void newSession();
    if (e.target.closest('#ag-stop') || e.target.closest('#ag-stop2')) return void stop();
    if (e.target.closest('#ag-send')) return void send();
    if (e.target.closest('#ag-sid')) return copySession();
    if (e.target.closest('#ag-export')) return exportChat();
    const act = e.target.closest('[data-act]');
    if (act) {
      const msgEl = act.closest('.ag-msg');
      if (act.dataset.act === 'copy' && msgEl) copyMessage(msgEl, act);
      else if (act.dataset.act === 'retry') retry();
      else if (act.dataset.act === 'reconnect') void connect();
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.target.id === 'ag-sid' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); copySession(); }
  });
  input.addEventListener('input', () => {
    resizeInput();
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
