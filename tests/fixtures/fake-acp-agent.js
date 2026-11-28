#!/usr/bin/env node
/**
 * fake ACP agent —— U-002 集成测试替身，同时是「外部 ACP Agent」的参考实现。
 *
 * 契约对照：docs/api/external-acp-agent-contract.md
 *   §1 传输：stdio + 换行分隔 JSON-RPC 2.0（NDJSON）；stdout 只写协议帧，日志一律 stderr
 *   §2 握手：initialize → session/new →（可选 set_config_option）→ session/prompt
 *   §3.1 initialize：agentInfo + sessionCapabilities
 *   §3.2 session/new：sessionId(uuid) + configOptions（model 分组 + reasoning_effort 四档）
 *   §3.3 session/set_config_option：参数名 configId（传错 → -32602），result 回更新后的 configOptions
 *   §3.4 session/prompt：result {"stopReason":"end_turn"}（取消 → cancelled；拒绝授权 → refusal）
 *   §3.5 session/update：agent_message_chunk 流式文本 + usage_update 用量
 *   §3.6 session/request_permission：agent → Hull 的 REQUEST（带 id，必须等响应再继续）；
 *        Hull 响应 result {"requestId": "...", "approved": true, "reason": ""}
 *   §3.7 session/cancel：通知（无 id），收到后当前 prompt 回 {"stopReason":"cancelled"}
 *   §4 错误码：未知方法 -32601 / 参数错 -32602
 *
 * 测试断言锚点：agent_message_chunk 文本含 FAKE_AGENT_REPLY；
 * prompt 文本含 ASK_PERMISSION 时触发 permission 往返。
 */
'use strict';

const { randomUUID } = require('node:crypto');
const readline = require('node:readline');

/** 诊断日志只走 stderr（stdout 混入日志会污染帧流，契约 §1/§5） */
function log(message) {
  process.stderr.write(`[fake-acp-agent] ${message}\n`);
}

function send(frame) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
}

function reply(id, result) {
  send({ id, result });
}

function replyError(id, code, message) {
  send({ id, error: { code, message } });
}

/** sessionId → { configOptions } */
const sessions = new Map();
/** sessionId → 当前进行中的 prompt turn */
const activePrompts = new Map();
/** 我们发给 Hull 的 permission REQUEST id → resolve(result) */
const pendingPermissions = new Map();
let nextServerRequestId = 1000;

function makeConfigOptions() {
  const modelA = JSON.stringify(['fake-route', 'fake-model-a']);
  const modelB = JSON.stringify(['fake-route', 'fake-model-b']);
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: modelA,
      options: [
        {
          group: 'fake-route',
          name: 'Fake Route',
          options: [
            { value: modelA, name: 'fake-model-a' },
            { value: modelB, name: 'fake-model-b' },
          ],
        },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
        { value: 'max', name: 'Max' },
      ],
    },
  ];
}

/** §3.5 流式文本增量（Hull → text_chunk 事件） */
function emitChunk(sessionId, text) {
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: randomUUID(),
        content: { type: 'text', text },
      },
    },
  });
}

/** §3.5 上下文用量（Hull 用量条直接消费） */
function emitUsage(sessionId) {
  send({
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'usage_update', used: 19847, size: 1000000 } },
  });
}

function finishTurn(turn, stopReason) {
  if (turn.done) return;
  turn.done = true;
  activePrompts.delete(turn.sessionId);
  log(`prompt result ${stopReason}`);
  reply(turn.id, { stopReason });
}

/**
 * §3.6 agent → Hull REQUEST：带 id，必须阻塞等待 Hull 的响应帧再继续。
 * 响应契约 §3.6：result { requestId, approved, reason }（兼容标准 ACP selected outcome）。
 */
function requestPermission(sessionId) {
  return new Promise((resolve) => {
    const id = nextServerRequestId++;
    const requestId = randomUUID();
    pendingPermissions.set(id, resolve);
    send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        requestId,
        options: [
          { type: 'allow_once', name: '允许一次' },
          { type: 'reject_once', name: '拒绝一次' },
        ],
        message: { role: 'user', content: [{ type: 'text', text: 'fake agent 想执行工具，是否允许？' }] },
      },
    });
  });
}

function isApproved(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.approved === true) return true;
  // 标准 ACP 兼容形态：{ outcome: { outcome: 'selected', optionId: 'allow-once' } }
  if (result.outcome && result.outcome.outcome === 'selected') {
    return !/reject/i.test(String(result.outcome.optionId ?? ''));
  }
  return false;
}

function handlePrompt(msg) {
  const params = msg.params || {};
  const sessionId = params.sessionId;
  const session = sessions.get(sessionId);
  if (!session) {
    replyError(msg.id, -32602, 'Invalid params: unknown sessionId');
    return;
  }
  const text = (Array.isArray(params.prompt) ? params.prompt : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  const turn = { id: msg.id, sessionId, done: false };
  activePrompts.set(sessionId, turn);
  log(`prompt start ${sessionId}`);
  emitChunk(sessionId, 'FAKE_AGENT_REPLY: 已收到任务');
  if (text.includes('ASK_PERMISSION')) {
    void requestPermission(sessionId).then((result) => {
      if (turn.done) return;
      if (!isApproved(result)) {
        finishTurn(turn, 'refusal');
        return;
      }
      emitChunk(sessionId, 'FAKE_AGENT_REPLY: 权限已批准，继续执行');
      emitUsage(sessionId);
      finishTurn(turn, 'end_turn');
    });
    return;
  }
  emitChunk(sessionId, 'FAKE_AGENT_REPLY: 完成');
  emitUsage(sessionId);
  finishTurn(turn, 'end_turn');
}

/** §3.7 session/cancel（通知）：停止当前 turn，prompt 回 cancelled */
function handleCancel(params) {
  const sessionId = params && params.sessionId;
  log(`session/cancel ${sessionId}`);
  const turn = activePrompts.get(sessionId);
  if (!turn) return;
  finishTurn(turn, 'cancelled');
}

function handleRequest(msg) {
  switch (msg.method) {
    case 'initialize':
      // §3.1：能力声明（sessionCapabilities 声明 close/list/resume → Hull 对应按钮可见）
      reply(msg.id, {
        protocolVersion: 1,
        agentInfo: { name: 'fake-acp-agent', version: '0.1.0' },
        agentCapabilities: {
          mcpCapabilities: { http: false },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      });
      return;
    case 'session/new': {
      // §3.2：sessionId 必须唯一；configOptions 可为空数组
      const sessionId = randomUUID();
      const configOptions = makeConfigOptions();
      sessions.set(sessionId, { configOptions });
      log(`session/new ${sessionId}`);
      reply(msg.id, { sessionId, configOptions });
      return;
    }
    case 'session/set_config_option': {
      // §3.3：参数名是 configId（不是 optionId）
      const params = msg.params || {};
      const session = sessions.get(params.sessionId);
      if (!session) {
        replyError(msg.id, -32602, 'Invalid params: unknown sessionId');
        return;
      }
      if (typeof params.configId !== 'string' || params.configId === '') {
        replyError(msg.id, -32602, 'Invalid params: configId required');
        return;
      }
      for (const option of session.configOptions) {
        if (option.id === params.configId) option.currentValue = String(params.value);
      }
      reply(msg.id, { configOptions: session.configOptions });
      return;
    }
    case 'session/prompt':
      handlePrompt(msg);
      return;
    case 'session/resume': {
      // 声明了 resume 就实现最小语义：会话不存在（进程重启）→ 重建同 id 会话
      const params = msg.params || {};
      let session = sessions.get(params.sessionId);
      if (!session) {
        session = { configOptions: makeConfigOptions() };
        sessions.set(params.sessionId, session);
      }
      reply(msg.id, { sessionId: params.sessionId, configOptions: session.configOptions });
      return;
    }
    default:
      // §4：握手顺序错/未知方法
      replyError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

function handleNotification(msg) {
  if (msg.method === 'session/cancel') {
    handleCancel(msg.params);
    return;
  }
  log(`忽略未知通知 ${msg.method}`);
}

/** 响应帧（Hull 对我们 permission REQUEST 的回复）：无 method、带 id */
function handleResponse(msg) {
  const resolve = pendingPermissions.get(msg.id);
  if (!resolve) return;
  pendingPermissions.delete(msg.id);
  resolve(msg.result);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // 坏帧丢弃 + stderr 日志（stdout 绝不吐非协议内容）
    log('坏 JSON 帧丢弃');
    return;
  }
  if (msg === null || typeof msg !== 'object') return;
  if (typeof msg.method === 'string') {
    if (msg.id !== undefined) handleRequest(msg);
    else handleNotification(msg);
    return;
  }
  if (msg.id !== undefined) handleResponse(msg);
});
process.stdin.on('end', () => process.exit(0));
log('ready');
