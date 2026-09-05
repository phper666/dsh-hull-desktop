/**
 * L2b ACPProvider 单测（B4 design §4.1 / 契约 A1~A7, A16, A20 + 标准 ACP 对齐 Q-017-C）
 *
 * dsh 0.1.2-rc.1 的 acp profile 实现标准 ACP（Zed Agent Client Protocol）——真机重放实锤：
 * 自造 `newSession`/`prompt` 方法名 → error -32601 Method not found。本文件按标准协议讲：
 * spawn → initialize → session/new → session/prompt；流式通知 session/update
 * （sessionUpdate 变体分派）；session/request_permission 为 server→client REQUEST
 * （带 id，须回 response 帧）。
 *
 * 覆盖：
 * - spawn 参数（复用 M1 spawnArgs：node --expose-internals <bin> --profile acp）
 * - 握手序列：initialize（protocolVersion/clientCapabilities）→ session/new（cwd/mcpServers）
 * - prompt 用 session/prompt 帧（prompt 内容块数组），响应 stopReason → 结算
 * - session/update agent_message_chunk → text_chunk；其他变体忽略
 * - session/request_permission 请求 → permission_request 事件 + respondPermission 回 response 帧
 * - cancel 幂等：session/cancel 通知 + kill 兜底 + 结果丢弃（E4/O-11）
 * - 崩溃：子进程意外退出 → failed + 无悬挂（A20/P2-B4-2）
 * - DSH_HOME 未设置 → failed（A16 spawn 前置）
 */
import { test } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ACPProvider, buildPromptText } from './ACPProvider';
import type { ExecutionEvent, ExecutionResult, ExecutionTask } from './ExecutionProvider';

const OLD_HOME = process.env.DSH_HOME;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 假 stdio（stdin 记录写入 / stdout 可推入） */
class FakeIo extends EventEmitter {
  lines: string[] = [];
  write = (s: string): boolean => {
    this.lines.push(s);
    return true;
  };
  emitData(s: string): void {
    this.emit('data', Buffer.from(s, 'utf8'));
  }
}

/** fake 子进程：与 child_process.ChildProcess 结构兼容 */
class FakeChild extends EventEmitter {
  pid = 123;
  exitCode: number | null = null;
  stdout: FakeIo;
  stderr: FakeIo;
  stdin: FakeIo;
  killed: string[] = [];
  constructor() {
    super();
    this.stdout = new FakeIo();
    this.stderr = new FakeIo();
    this.stdin = new FakeIo();
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(String(signal ?? 'SIGTERM'));
    return true;
  }
}

/** 执行采集器 */
class Harness {
  statuses: string[] = [];
  events: ExecutionEvent[] = [];
  results: ExecutionResult[] = [];
  resultCount = 0;
  child: FakeChild | null = null;
  handlers = {
    onStatus: (s: string) => this.statuses.push(s),
    onEvent: (e: ExecutionEvent) => this.events.push(e),
    onResult: (r: ExecutionResult) => {
      this.results.push(r);
      this.resultCount++;
    },
  };
}

function setup(): { provider: ACPProvider; h: Harness; spawnLog: { cmd: string; args: string[]; opts: unknown }[] } {
  const h = new Harness();
  const spawnLog: { cmd: string; args: string[]; opts: unknown }[] = [];
  const provider = new ACPProvider({
    spawnFn: ((cmd: string, args: string[], opts: unknown) => {
      spawnLog.push({ cmd, args, opts });
      h.child = new FakeChild();
      return h.child;
    }) as never,
  });
  return { provider, h, spawnLog };
}

/** 推送一个 dsh→壳 响应帧 */
function respond(child: FakeChild, id: number, result: unknown): void {
  child.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
/** 推送一个通知帧 */
function notify(child: FakeChild, method: string, params: unknown): void {
  child.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
/** 推送一个 server→client 请求帧（标准 ACP permission 为 request 带 id） */
function serverRequest(child: FakeChild, id: number, method: string, params: unknown): void {
  child.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}
/** 解析 fake child stdin 第 idx 条已发送帧 */
function sentRequest(h: Harness, idx: number): { id?: number; method?: string; params: unknown } {
  return JSON.parse(h.child!.stdin.lines[idx]);
}

/** 标准 ACP 握手：回 initialize + session/new 两步响应（sessionId=s_1），返回 prompt 请求帧 */
async function handshake(h: Harness): Promise<{ id: number; method: string; params: unknown }> {
  const init = sentRequest(h, 0);
  respond(h.child!, init.id!, { protocolVersion: 1, agentInfo: { name: 'deepseek-harness-acp' } });
  await sleep(5);
  const ns = sentRequest(h, 1);
  respond(h.child!, ns.id!, { sessionId: 's_1' });
  await sleep(5);
  return sentRequest(h, 2) as { id: number; method: string; params: unknown };
}

/** 触发子进程退出（崩溃模拟） */
function crashChild(child: FakeChild): void {
  child.exitCode = 1;
  child.emit('exit', 1, null);
}

/** Q-019：任务工作目录（必须真实存在——connect 防御校验 existsSync） */
const TASK_CWD = mkdtempSync(join(tmpdir(), 'hull-cwd-'));
const TASK: ExecutionTask = {
  taskId: 't_1',
  title: '实现看板拖拽',
  ac: { what: '拖拽流转', expected: '列间移动', verify: '手动验证' },
  cwd: TASK_CWD,
};

process.env.DSH_HOME = '/tmp/fake-home';

test('spawn 参数：复用 M1 spawnArgs（node --expose-internals <bin> --profile acp，cwd=DSH_HOME/dsh）', () => {
  const { provider, h, spawnLog } = setup();
  provider.execute(TASK, h.handlers);
  equal(spawnLog.length, 1);
  equal(spawnLog[0].cmd, 'node');
  equal(spawnLog[0].args[0], '--expose-internals');
  equal(spawnLog[0].args[1], '/tmp/fake-home/dsh/bin/dsh');
  equal(spawnLog[0].args[2], '--profile');
  equal(spawnLog[0].args[3], 'acp');
  equal((spawnLog[0].opts as { cwd: string }).cwd, '/tmp/fake-home/dsh');
});

test('握手序列：initialize 先于 session/new（标准 ACP，自造方法名必 Method not found）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  // 第 1 帧 = initialize（带 protocolVersion + clientCapabilities）
  const init = sentRequest(h, 0);
  equal(init.method, 'initialize');
  equal((init.params as { protocolVersion: number }).protocolVersion, 1);
  ok((init.params as { clientCapabilities: unknown }).clientCapabilities !== undefined, '带 clientCapabilities');
  respond(h.child!, init.id!, { protocolVersion: 1, agentInfo: { name: 'deepseek-harness-acp' } });
  await sleep(5);
  // 第 2 帧 = session/new（cwd + mcpServers）
  const ns = sentRequest(h, 1);
  equal(ns.method, 'session/new');
  equal((ns.params as { cwd: string }).cwd, TASK_CWD, 'session/new cwd = task.cwd（会话归组 + agent 工作目录）');
  deepEqual((ns.params as { mcpServers: unknown[] }).mcpServers, []);
  respond(h.child!, ns.id!, { sessionId: 's_1' });
  await sleep(5);
  equal(h.statuses.includes('running'), true);
  // 第 3 帧 = session/prompt（prompt 内容块数组，非自造 text 字段）
  const pt = sentRequest(h, 2);
  equal(pt.method, 'session/prompt');
  equal((pt.params as { sessionId: string }).sessionId, 's_1');
  const promptBlocks = (pt.params as { prompt: Array<{ type: string; text: string }> }).prompt;
  equal(promptBlocks.length, 1);
  equal(promptBlocks[0].type, 'text');
  ok(promptBlocks[0].text.includes('t_1'), 'prompt 文本携带 taskId');
  ok(promptBlocks[0].text.includes('拖拽流转'), 'prompt 文本携带 AC');
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.resultCount, 1);
  equal(h.results[0].exitCode, 0, 'stopReason 响应 = 通道侧完成');
  equal(h.statuses.includes('succeeded'), true);
});

test('session/update agent_message_chunk → text_chunk 事件（A2 流式心跳）；其他 sessionUpdate 变体忽略', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  await handshake(h);
  notify(h.child!, 'session/update', {
    sessionId: 's_1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已完成步骤一' } },
  });
  notify(h.child!, 'session/update', {
    sessionId: 's_1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '继续' } },
  });
  notify(h.child!, 'session/update', {
    sessionId: 's_1',
    update: { sessionUpdate: 'tool_call', content: { type: 'text', text: '不应透传' } },
  });
  await sleep(5);
  equal(h.events.length, 2, 'tool_call 变体忽略');
  equal(h.events[0].kind, 'text_chunk');
  if (h.events[0].kind === 'text_chunk') equal(h.events[0].text, '已完成步骤一');
});

test('session/request_permission：server→client REQUEST → permission_request 事件 + emit permission ctx（B4 审批入口）', async () => {
  const { provider, h } = setup();
  const perms: Array<{ taskId: string; title: string; requestId: string; message: string }> = [];
  provider.on('permission', (ctx) => perms.push(ctx));
  provider.execute(TASK, h.handlers);
  await handshake(h);
  // 标准 ACP：permission 是带 id 的请求帧（非通知），须回 response
  serverRequest(h.child!, 7, 'session/request_permission', {
    sessionId: 's_1',
    question: '允许执行 git push？',
    options: [
      { id: 'opt_allow', kind: 'allow_once' },
      { id: 'opt_reject', kind: 'reject_once' },
    ],
  });
  await sleep(5);
  equal(h.events.length, 1);
  equal(h.events[0].kind, 'permission_request');
  if (h.events[0].kind === 'permission_request') {
    equal(h.events[0].id, '7', 'requestId = JSON-RPC id 字符串');
    equal(h.events[0].message, '允许执行 git push？');
  }
  equal(perms.length, 1, 'emit 一次 permission 事件');
  deepEqual(perms[0], { taskId: 't_1', title: '实现看板拖拽', requestId: '7', message: '允许执行 git push？' });
  // 收尾：回 prompt 响应结束 ACP 链路（防 30s timer 悬挂；本帧 id=7 的 response 由下一条测断言）
  respond(h.child!, 7, { outcome: { outcome: 'selected', optionId: 'opt_allow' } });
  const pt = sentRequest(h, 2);
  if (pt.method === 'session/prompt') respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
});

test('respondPermission：approved=true/false → 回 response 帧选择 allow/reject 选项（标准 ACP outcome）', async () => {
  const { provider, h } = setup();
  const handle = provider.execute(TASK, h.handlers);
  await handshake(h);
  serverRequest(h.child!, 7, 'session/request_permission', {
    sessionId: 's_1',
    question: 'q1',
    options: [
      { id: 'opt_allow', kind: 'allow_once' },
      { id: 'opt_reject', kind: 'reject_once' },
    ],
  });
  await sleep(5);
  (handle as { respondPermission?: (a: string, b: boolean, c?: string) => void }).respondPermission?.('7', true, '用户批准');
  const resp = h.child!.stdin.lines.map((l) => JSON.parse(l)).find((f) => f.id === 7 && f.method === undefined);
  ok(resp, '有 response 帧（id=7）');
  equal(resp.result.outcome.outcome, 'selected');
  equal(resp.result.outcome.optionId, 'opt_allow', 'approved=true 选 allow 选项');

  // 第二次权限请求 approved=false → reject 选项
  serverRequest(h.child!, 8, 'session/request_permission', {
    sessionId: 's_1',
    question: 'q2',
    options: [
      { id: 'opt_allow', kind: 'allow_once' },
      { id: 'opt_reject', kind: 'reject_once' },
    ],
  });
  await sleep(5);
  (handle as { respondPermission?: (a: string, b: boolean, c?: string) => void }).respondPermission?.('8', false);
  const resp2 = h.child!.stdin.lines.map((l) => JSON.parse(l)).find((f) => f.id === 8 && f.method === undefined);
  ok(resp2, '有 response 帧（id=8）');
  equal(resp2.result.outcome.optionId, 'opt_reject', 'approved=false 选 reject 选项');
  // 收尾：回 prompt 响应结束 ACP 链路（防 30s timer 悬挂）
  const pt = sentRequest(h, 2);
  if (pt.method === 'session/prompt') respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
});

test('prompt 响应 stopReason → 通道侧完成 exitCode 0（selfCheck 缺省，判定归 VerifyGate）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const pt = await handshake(h);
  // 先流式输出（聚合进 summary），再完成
  notify(h.child!, 'session/update', {
    sessionId: 's_1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '答案：2' } },
  });
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.resultCount, 1);
  equal(h.results[0].exitCode, 0);
  equal(h.results[0].summary, '答案：2', '流式文本聚合进结算 summary');
  equal(h.results[0].selfCheck, undefined, '标准 ACP 无 selfCheck 回传');
  await sleep(1);
});

// ─────────────────── Q-018 模型选择（session/set_config_option + listModels） ───────────────────

const TASK_WITH_MODEL: ExecutionTask = { ...TASK, model: '["deepseek-official","deepseek-v4"]' };

test('Q-018 task 带 model → session/new 响应后先发 session/set_config_option（成功才进 prompt）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK_WITH_MODEL, h.handlers);
  const init = sentRequest(h, 0);
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(5);
  const ns = sentRequest(h, 1);
  respond(h.child!, ns.id!, { sessionId: 's_1' });
  await sleep(5);
  // 第 3 帧 = set_config_option（非 prompt——模型须先于任务提交生效）
  const sc = sentRequest(h, 2);
  equal(sc.method, 'session/set_config_option');
  equal((sc.params as { sessionId: string }).sessionId, 's_1');
  equal((sc.params as { configId: string }).configId, 'model');
  equal((sc.params as { value: string }).value, '["deepseek-official","deepseek-v4"]', 'value = configOptions 的 value JSON 串');
  respond(h.child!, sc.id!, { ok: true });
  await sleep(5);
  const pt = sentRequest(h, 3);
  equal(pt.method, 'session/prompt', '模型设置成功后才提交 prompt');
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.resultCount, 1);
  equal(h.statuses.includes('succeeded'), true);
});

test('Q-018 task 不带 model → 不发设置帧（dsh 默认模型）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const pt = await handshake(h);
  equal(pt.method, 'session/prompt', '握手后直接 prompt，无 set_config_option');
  equal(h.child!.stdin.lines.some((l) => l.includes('set_config_option')), false);
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.resultCount, 1);
});

test('Q-018 set_config_option error → settleFailure（错误信息含「模型设置失败」）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK_WITH_MODEL, h.handlers);
  const init = sentRequest(h, 0);
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(5);
  const ns = sentRequest(h, 1);
  respond(h.child!, ns.id!, { sessionId: 's_1' });
  await sleep(5);
  const sc = sentRequest(h, 2);
  equal(sc.method, 'session/set_config_option');
  // 非法 value → dsh 回 -32602（真机验证行为）
  h.child!.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: sc.id!, error: { code: -32602, message: 'Invalid params' } }) + '\n');
  await sleep(5);
  equal(h.statuses.includes('failed'), true);
  equal(h.resultCount, 1);
  ok(h.results[0].summary.includes('模型设置失败'), '失败信息带「模型设置失败」');
  equal(h.results[0].exitCode, 1);
});

test('Q-018 listModels：configOptions[model] 分组原样返回 + 5 分钟缓存（两次调用仅 spawn 一次）', async () => {
  const h = new Harness();
  const spawnLog: { cmd: string; args: string[]; opts: unknown }[] = [];
  const provider = new ACPProvider({
    settingsPath: join(tmpdir(), 'hull-no-settings.yaml'), // 不存在 → settings 来源静默跳过（只回 acp 分组）
    spawnFn: ((cmd: string, args: string[], opts: unknown) => {
      spawnLog.push({ cmd, args, opts });
      h.child = new FakeChild();
      return h.child;
    }) as never,
  });
  const groups = [
    {
      group: '官方渠道',
      name: '官方渠道',
      options: [{ value: '["deepseek-official","deepseek-v4"]', name: 'deepseek-v4', description: '官方 v4' }],
    },
    {
      group: '自定义渠道',
      name: '自定义渠道',
      options: [{ value: '["custom","my-model"]', name: 'my-model' }],
    },
  ];
  const p = provider.listModels();
  const init = sentRequest(h, 0);
  equal(init.method, 'initialize', '独立轻量会话仍走标准握手');
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(5);
  const ns = sentRequest(h, 1);
  equal(ns.method, 'session/new');
  respond(h.child!, ns.id!, {
    sessionId: 's_list',
    configOptions: [{ id: 'model', type: 'select', currentValue: '["deepseek-official","deepseek-v4"]', options: groups }],
  });
  const result = await p;
  deepEqual(result, groups, 'configOptions[model].options 原样返回（含 dsh 自定义渠道分组）');
  ok(h.child!.killed.length >= 1, '轻量会话用完即弃（kill 子进程）');
  // 缓存：第二次调用不再 spawn
  const again = await provider.listModels();
  deepEqual(again, groups);
  equal(spawnLog.length, 1, '5 分钟内缓存命中，仅一次 spawn');
});

// ─────────────────── Q-018 模型选择（session/set_config_option + listModels） ───────────────────

/** 造注入 settings.yaml 的 provider（listModels settings 来源测试用） */
function setupWithSettings(settingsYaml: string | null): { provider: ACPProvider; h: Harness; spawnLog: { cmd: string; args: string[]; opts: unknown }[] } {
  const h = new Harness();
  const spawnLog: { cmd: string; args: string[]; opts: unknown }[] = [];
  let settingsPath = join(tmpdir(), 'hull-no-settings.yaml');
  if (settingsYaml !== null) {
    const dir = mkdtempSync(join(tmpdir(), 'hull-settings-'));
    settingsPath = join(dir, 'settings.yaml');
    writeFileSync(settingsPath, settingsYaml, 'utf8');
  }
  const provider = new ACPProvider({
    settingsPath,
    spawnFn: ((cmd: string, args: string[], opts: unknown) => {
      spawnLog.push({ cmd, args, opts });
      h.child = new FakeChild();
      return h.child;
    }) as never,
  });
  return { provider, h, spawnLog };
}

/** listModels 驱动：握手并回 configOptions（可带内置分组），返回结果 promise */
async function driveListModels(provider: ACPProvider, h: Harness, configOptions: unknown): Promise<unknown> {
  const p = provider.listModels();
  const init = sentRequest(h, 0);
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(5); // session/new 请求在 initialize 响应处理后发出
  const ns = sentRequest(h, 1);
  respond(h.child!, ns.id!, { sessionId: 's_list', configOptions });
  return p;
}

test('Q-018 listModels 合并 settings 自定义渠道：acp 分组在前 + settings 分组在后 + value 格式 ["route","modelId"]', async () => {
  const yaml = `ui-onboarding:
  welcomeNoticeVersion: 1
llm-pi-ai:
  providers:
    zhipu:
      apiKeyEnv: ZHIPU_API_KEY
      models:
        - id: glm-5.3
          contextWindow: 1024000
        - id: glm-5.3-flash
          name: GLM
`;
  const { provider, h } = setupWithSettings(yaml);
  const acpGroups = [
    { group: 'deepseek-official', name: 'DeepSeek', options: [{ value: '["deepseek-official","deepseek-v4-flash"]', name: 'DeepSeek-V4-Flash' }] },
  ];
  const result = (await driveListModels(provider, h, [{ id: 'model', type: 'select', options: acpGroups }])) as Array<{
    group?: string;
    name?: string;
    options: Array<{ value: string; name: string; description?: string }>;
  }>;
  equal(result.length, 2, 'acp 1 组 + settings 1 组');
  deepEqual(result[0], acpGroups[0], 'acp 内置分组在前');
  deepEqual(
    result[1],
    { group: 'zhipu', name: 'zhipu', options: [{ value: '["zhipu","glm-5.3"]', name: 'glm-5.3' }, { value: '["zhipu","glm-5.3-flash"]', name: 'GLM' }] },
    'settings 分组在后（name 字段回显，无则回退 id；description 无来源省略）',
  );
});

test('Q-018 listModels 去重：settings 与 acp 分组重叠的 value 跳过（防重复渲染）', async () => {
  const yaml = `llm-pi-ai:
  providers:
    zhipu:
      models:
        - id: glm-5.3
        - id: glm-5.3-flash
`;
  const { provider, h } = setupWithSettings(yaml);
  const acpGroups = [
    { group: 'zhipu', name: 'zhipu', options: [{ value: '["zhipu","glm-5.3"]', name: 'glm-5.3' }] },
  ];
  const result = (await driveListModels(provider, h, [{ id: 'model', options: acpGroups }])) as Array<{
    group?: string;
    options: Array<{ value: string }>;
  }>;
  equal(result.length, 2, '重叠组外仍出现 settings 分组');
  equal(result[1].options.length, 1, '重叠 value ["zhipu","glm-5.3"] 去重，仅剩 flash');
  equal(result[1].options[0].value, '["zhipu","glm-5.3-flash"]');
});

test('Q-018 listModels 容错：settings 缺失 / 损坏 / 无 providers 段 → 只回 acp 分组不抛错', async () => {
  const acpGroups = [{ group: 'deepseek-official', name: 'DeepSeek', options: [{ value: '["d","m"]', name: 'm' }] }];
  const configOptions = [{ id: 'model', options: acpGroups }];
  // 缺失文件
  const missing = setupWithSettings(null);
  deepEqual(await driveListModels(missing.provider, missing.h, configOptions), acpGroups, '文件不存在 → 只回 acp');
  // 损坏内容（二进制乱码/极深异常缩进）
  const broken = setupWithSettings('llm-pi-ai:\n  providers:\n    [\n broken ::: {\n\t\t\x00');
  deepEqual(await driveListModels(broken.provider, broken.h, configOptions), acpGroups, '损坏 → 只回 acp');
  // 无 providers 段
  const noProv = setupWithSettings('llm-pi-ai:\n  otherKey: 1\n');
  deepEqual(await driveListModels(noProv.provider, noProv.h, configOptions), acpGroups, '无 providers 段 → 只回 acp');
  // providers 段结构异常（route 无 models）
  const emptyRoute = setupWithSettings('llm-pi-ai:\n  providers:\n    zhipu:\n      apiKeyEnv: X\n');
  deepEqual(await driveListModels(emptyRoute.provider, emptyRoute.h, configOptions), acpGroups, 'route 无 models → 跳过该组');
});

test('Q-018 listModels displayName：settings displayName → 分组 name（对齐 acp configOptions 渲染）', async () => {
  const yaml = `llm-pi-ai:
  providers:
    huoshan-yongyou:
      displayName: 火山（永友）
      models:
        - id: glm-5.3-flash
          name: glm-5.3-flash
`;
  const { provider, h } = setupWithSettings(yaml);
  const result = (await driveListModels(provider, h, [{ id: 'model', options: [] }])) as Array<{ group?: string; name?: string }>;
  deepEqual(result, [{ group: 'huoshan-yongyou', name: '火山（永友）', options: [{ value: '["huoshan-yongyou","glm-5.3-flash"]', name: 'glm-5.3-flash' }] }]);
});

test('cancel：session/cancel 通知 + 优雅关停（Q-027）+ 结果丢弃（幂等）', async () => {
  const { provider, h } = setup();
  const handle = provider.execute(TASK, h.handlers);
  await handshake(h);
  await handle.cancel();
  const cancelMsg = h.child!.stdin.lines.find((l) => l.includes('session/cancel'));
  ok(cancelMsg, '发送 session/cancel 通知');
  const parsed = JSON.parse(cancelMsg!);
  equal(parsed.params.sessionId, 's_1');
  // Q-027：优雅关停——grace 1500ms 未自然退出才 SIGTERM 兜底（O-11 保证终止）
  await sleep(1800);
  ok(h.child!.killed.includes('SIGTERM'), 'grace 窗口后 SIGTERM 兜底（不立即杀，保落盘完整）');
  await handle.cancel();
  ok(true, 'cancel 幂等不抛');
});

test('崩溃：子进程意外退出 → failed + 无 onResult 悬挂（A20/P2-B4-2）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const init = sentRequest(h, 0);
  crashChild(h.child!);
  await sleep(20);
  equal(h.statuses.includes('failed'), true);
  equal(h.resultCount, 1);
  equal(h.results[0].exitCode, 1);
  equal(h.results[0].selfCheck?.passed, false);
  void init;
});

test('崩溃后响应帧不再触发 onResult（settle 后丢弃）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const init = sentRequest(h, 0);
  crashChild(h.child!);
  await sleep(20);
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(10);
  equal(h.resultCount, 1, '崩溃后无第二次 onResult');
});

test('Q-017-B overlayDir 注入：优先于 env.DSH_HOME（壳自管 <userData>/dsh 同构注入，DSH_HOME 零引用红线）', async () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/env-home'; // env 也设了 → 注入优先
  try {
    const h = new Harness();
    const spawnLog: { cmd: string; args: string[]; opts: unknown }[] = [];
    const provider = new ACPProvider({
      overlayDir: '/custom/overlay',
      spawnFn: ((cmd: string, args: string[], opts: unknown) => {
        spawnLog.push({ cmd, args, opts });
        h.child = new FakeChild();
        return h.child;
      }) as never,
    });
    provider.execute(TASK, h.handlers);
    equal(spawnLog.length, 1);
    equal(spawnLog[0].args[1], '/custom/overlay/bin/dsh', 'bin 路径用注入 overlayDir');
    equal((spawnLog[0].opts as { cwd: string }).cwd, '/custom/overlay', 'cwd 用注入 overlayDir');
    // 标准握手收尾（防 30s timer 悬挂）
    const init = sentRequest(h, 0);
    respond(h.child!, init.id!, { protocolVersion: 1 });
    await sleep(5);
    const ns = sentRequest(h, 1);
    respond(h.child!, ns.id!, { sessionId: 's_1' });
    await sleep(5);
    const pt = sentRequest(h, 2);
    if (pt.method === 'session/prompt') respond(h.child!, pt.id!, { stopReason: 'end_turn' });
    await sleep(5);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('DSH_HOME 未设置 → failed（A16，不 spawn）', async () => {
  delete process.env.DSH_HOME;
  try {
    const { provider, h, spawnLog } = setup();
    provider.execute(TASK, h.handlers);
    await sleep(5);
    equal(spawnLog.length, 0, '不 spawn');
    equal(h.statuses.includes('failed'), true);
    equal(h.resultCount, 1);
  } finally {
    process.env.DSH_HOME = OLD_HOME ?? '/tmp/fake-home';
  }
});

test('buildPromptText：text 携带 taskId+AC', () => {  const text = buildPromptText(TASK);
  ok(text.includes('t_1'));
  ok(text.includes('what: 拖拽流转'));
  ok(text.includes('expected: 列间移动'));
  ok(text.includes('verify: 手动验证'));
  ok(!text.includes('context: '), '无 context 时不输出 context 行');
});

test('buildPromptText：含 context', () => {
  const text = buildPromptText({ taskId: 't_3', title: 't', cwd: tmpdir(), ac: { what: 'w', expected: 'e', verify: 'v', context: '背景' } });
  ok(text.includes('context: 背景'));
});

test('buildPromptText：Q-026 描述进 prompt，缺失不输出描述行', () => {
  const withDesc = buildPromptText({ taskId: 't_4', title: '调研', cwd: tmpdir(), description: '调研一下 salesforce 平台' });
  ok(withDesc.includes('任务描述：调研一下 salesforce 平台'));
  const noDesc = buildPromptText({ taskId: 't_5', title: '无描述', cwd: tmpdir() });
  ok(!noDesc.includes('任务描述：'), '无描述时不输出描述行');
});

test('无 AC：prompt 文本仅 taskId+title', () => {
  const text = buildPromptText({ taskId: 't_2', title: '无 AC 任务', cwd: tmpdir() });
  ok(text.includes('t_2'));
  ok(!text.includes('验收标准'));
});

// ─────────────────── Q-019 工作目录（session/new cwd + 防御校验） ───────────────────

test('Q-019 防御校验：task.cwd 目录不存在 → failed 含「工作目录不存在」（不 spawn）', async () => {
  const { provider, h, spawnLog } = setup();
  provider.execute({ ...TASK, cwd: '/nonexistent-hull-dir-xyz/nested' }, h.handlers);
  await sleep(5);
  equal(spawnLog.length, 0, '不 spawn');
  equal(h.statuses.includes('failed'), true);
  equal(h.resultCount, 1);
  ok(h.results[0].summary.includes('工作目录不存在'), '失败信息含「工作目录不存在」');
  ok(h.results[0].summary.includes('/nonexistent-hull-dir-xyz/nested'), '失败信息带路径');
});

// ─────────────────── Q-021 推理力度（session/set_config_option reasoning_effort） ───────────────────

test('Q-021 task 带 reasoningEffort（无 model）→ session/new 后发 reasoning_effort 设置帧，成功才进 prompt', async () => {
  const { provider, h } = setup();
  provider.execute({ ...TASK, reasoningEffort: 'low' }, h.handlers);
  const init = sentRequest(h, 0);
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(5);
  const ns = sentRequest(h, 1);
  respond(h.child!, ns.id!, { sessionId: 's_1' });
  await sleep(5);
  const sc = sentRequest(h, 2);
  equal(sc.method, 'session/set_config_option');
  equal((sc.params as { configId: string }).configId, 'reasoning_effort');
  equal((sc.params as { value: string }).value, 'low');
  respond(h.child!, sc.id!, { ok: true });
  await sleep(5);
  const pt = sentRequest(h, 3);
  equal(pt.method, 'session/prompt', 'effort 设置成功后才提交 prompt');
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.resultCount, 1);
});

test('Q-021 model 与 reasoningEffort 都带 → 两帧顺序 model 先 effort 后', async () => {
  const { provider, h } = setup();
  provider.execute({ ...TASK, model: '["p","m"]', reasoningEffort: 'low' }, h.handlers);
  const init = sentRequest(h, 0);
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(5);
  const ns = sentRequest(h, 1);
  respond(h.child!, ns.id!, { sessionId: 's_1' });
  await sleep(5);
  const m = sentRequest(h, 2);
  equal((m.params as { configId: string }).configId, 'model', 'model 先');
  respond(h.child!, m.id!, { ok: true });
  await sleep(5);
  const e = sentRequest(h, 3);
  equal((e.params as { configId: string }).configId, 'reasoning_effort', 'effort 后');
  equal((e.params as { value: string }).value, 'low');
  respond(h.child!, e.id!, { ok: true });
  await sleep(5);
  const pt = sentRequest(h, 4);
  equal(pt.method, 'session/prompt');
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.resultCount, 1);
});

test('Q-021 reasoning_effort 设置 error → failed 含「推理力度设置失败」', async () => {
  const { provider, h } = setup();
  provider.execute({ ...TASK, reasoningEffort: 'low' }, h.handlers);
  const init = sentRequest(h, 0);
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(5);
  const ns = sentRequest(h, 1);
  respond(h.child!, ns.id!, { sessionId: 's_1' });
  await sleep(5);
  const sc = sentRequest(h, 2);
  h.child!.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: sc.id!, error: { code: -32602, message: 'Invalid params' } }) + '\n');
  await sleep(5);
  equal(h.statuses.includes('failed'), true);
  equal(h.resultCount, 1);
  ok(h.results[0].summary.includes('推理力度设置失败'), '错误信息带「推理力度设置失败」');
});

// ─────────────────── Q-022 会话复用（session/resume + 优雅降级 + sessionId 回传） ───────────────────

test('Q-022 resumeSessionId 存在 → 先发 session/resume 帧（非 session/new），成功后续用', async () => {
  const { provider, h } = setup();
  provider.execute({ ...TASK, resumeSessionId: 'sess-prev-1' }, h.handlers);
  const init = sentRequest(h, 0);
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(5);
  const rs = sentRequest(h, 1);
  equal(rs.method, 'session/resume');
  equal((rs.params as { sessionId: string }).sessionId, 'sess-prev-1');
  equal((rs.params as { cwd: string }).cwd, TASK_CWD, 'resume cwd 必须与会话原 cwd 一致（mismatch → invalidParams）');
  deepEqual((rs.params as { mcpServers: unknown[] }).mcpServers, []);
  respond(h.child!, rs.id!, { sessionId: 'sess-prev-1' });
  await sleep(5);
  const pt = sentRequest(h, 2);
  equal(pt.method, 'session/prompt');
  ok(!h.child!.stdin.lines.some((l) => l.includes('session/new')), 'resume 成功不发 session/new');
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.resultCount, 1);
  equal(h.results[0].sessionId, 'sess-prev-1', 'onResult 带 sessionId（回写 acpSessionId 用）');
});

test('Q-022 resume 错误 → 优雅降级发 session/new（一次重试不失败）+ onResult 带新 sessionId', async () => {
  const { provider, h } = setup();
  provider.execute({ ...TASK, resumeSessionId: 'sess-gone' }, h.handlers);
  const init = sentRequest(h, 0);
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(5);
  const rs = sentRequest(h, 1);
  equal(rs.method, 'session/resume');
  // cwd mismatch / not resumable → error
  h.child!.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: rs.id!, error: { code: -32602, message: 'session cwd does not match' } }) + '\n');
  await sleep(5);
  const ns = sentRequest(h, 2);
  equal(ns.method, 'session/new', '降级新建会话');
  equal((ns.params as { cwd: string }).cwd, TASK_CWD);
  respond(h.child!, ns.id!, { sessionId: 'sess-new-1' });
  await sleep(5);
  const pt = sentRequest(h, 3);
  equal(pt.method, 'session/prompt', '降级后照常进 prompt（用户无感）');
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.resultCount, 1);
  equal(h.statuses.includes('failed'), false, '降级不失败');
  equal(h.results[0].sessionId, 'sess-new-1', '回写新 sessionId');
});

test('Q-022 session/new 路径 onResult 也带 sessionId（新会话建立即回写）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const pt = await handshake(h);
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.results[0].sessionId, 's_1', '新会话 sessionId 回传');
});

test('Q-022 resume 响应缺 sessionId 字段（真机实测形态）→ 以 resumeSessionId 续用（不误降级）', async () => {
  const { provider, h } = setup();
  provider.execute({ ...TASK, resumeSessionId: 'sess-prev-1' }, h.handlers);
  const init = sentRequest(h, 0);
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(5);
  const rs = sentRequest(h, 1);
  respond(h.child!, rs.id!, {}); // 真机实测：resume 成功响应无 sessionId 字段
  await sleep(5);
  const pt = sentRequest(h, 2);
  equal(pt.method, 'session/prompt', 'resume 成功（不降级 session/new）');
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.resultCount, 1);
  equal(h.results[0].sessionId, 'sess-prev-1', 'onResult 回传 resumeSessionId（回写不变）');
});

// ─────────────────── Q-023 listModels 壳内挂起/污染修复（探测隔离 + 硬超时） ───────────────────

test('Q-023 探测子进程隔离：spawn env.DSH_HOME 指向临时目录（不污染真实 ~/.dsh/sessions）+ 探测结束清理', async () => {
  const h = new Harness();
  const spawnOpts: Array<{ cmd: string; args: string[]; opts: { env?: Record<string, string> } }> = [];
  const provider = new ACPProvider({
    settingsPath: join(tmpdir(), 'hull-no-settings.yaml'),
    spawnFn: ((cmd: string, args: string[], opts: never) => {
      spawnOpts.push({ cmd, args, opts: opts as { env?: Record<string, string> } });
      h.child = new FakeChild();
      return h.child;
    }) as never,
  });
  const groups = [{ group: 'g', name: 'g', options: [{ value: '["p","m"]', name: 'm' }] }];
  const p = driveListModels(provider, h, [{ id: 'model', options: groups }]);
  const tmpHome = spawnOpts[0]?.opts?.env?.DSH_HOME;
  ok(tmpHome, 'spawn env.DSH_HOME 指向临时目录');
  ok(existsSync(tmpHome!), '探测期间临时 home 存在');
  const init = sentRequest(h, 0);
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(5);
  const ns = sentRequest(h, 1);
  respond(h.child!, ns.id!, { sessionId: 's', configOptions: [{ id: 'model', options: groups }] });
  const result = (await p) as typeof groups;
  deepEqual(result, groups);
  equal(existsSync(tmpHome!), false, '探测结束临时 home 已清理（返回路径）');
});

test('Q-023 硬超时兜底：fake spawn 挂起（不回帧）→ 注入短超时 → reject「模型清单获取超时」+ 临时目录清理', async () => {
  const h = new Harness();
  let tmpHome = '';
  const provider = new ACPProvider({
    settingsPath: join(tmpdir(), 'hull-no-settings.yaml'),
    listModelsTimeoutMs: 60, // 注入短超时
    spawnFn: ((cmd: string, args: string[], opts: never) => {
      tmpHome = (opts as { env?: Record<string, string> }).env?.DSH_HOME ?? '';
      h.child = new FakeChild(); // 挂起：不回 initialize 响应
      return h.child;
    }) as never,
  });
  await rejects(
    () => provider.listModels(),
    /模型清单获取超时/,
    '45s 硬超时兜底（注入 60ms 验证）',
  );
  ok(tmpHome && !existsSync(tmpHome), '超时路径临时 home 已清理');
  ok(h.child!.killed.length >= 1, '挂起子进程被 kill（不残留）');
});

// ─────────────────── Q-024/Bug-B 权限响应对齐 dsh-acp 真实形态 ───────────────────

test('Q-024 dsh 真实 permission 请求形态（optionId 字段名）→ 批准回 allow-once（修复批准被当拒绝）', async () => {
  const { provider, h } = setup();
  const handle = provider.execute(TASK, h.handlers);
  await handshake(h);
  // dsh-acp 源码实锤形态：{ sessionId, toolCall:{toolCallId}, options:[{optionId,name,kind}] }——无 question 字段
  serverRequest(h.child!, 7, 'session/request_permission', {
    sessionId: 's_1',
    toolCall: { toolCallId: 'call_1' },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  });
  await sleep(5);
  equal(h.events[0].kind, 'permission_request');
  (handle as { respondPermission?: (a: string, b: boolean, c?: string) => void }).respondPermission?.('7', true, '用户批准');
  const resp = h.child!.stdin.lines.map((l) => JSON.parse(l)).find((f) => f.id === 7 && f.method === undefined);
  ok(resp, '有 response 帧');
  equal(resp.result.outcome.outcome, 'selected');
  equal(resp.result.outcome.optionId, 'allow-once', '批准 → allow-once（此前 hit.id=undefined 被 dsh 当 rejected）');
  // 收尾
  const pt = sentRequest(h, 2);
  if (pt.method === 'session/prompt') respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
});

test('Q-024 dsh 真实形态拒绝 → reject-once；无 options 表 → 字面量兜底', async () => {
  const { provider, h } = setup();
  const handle = provider.execute(TASK, h.handlers);
  await handshake(h);
  serverRequest(h.child!, 7, 'session/request_permission', {
    sessionId: 's_1',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  });
  await sleep(5);
  (handle as { respondPermission?: (a: string, b: boolean) => void }).respondPermission?.('7', false);
  const resp = h.child!.stdin.lines.map((l) => JSON.parse(l)).find((f) => f.id === 7 && f.method === undefined);
  equal(resp.result.outcome.optionId, 'reject-once', '拒绝 → reject-once');
  // 无 options（异常形态）→ 字面量兜底（dsh 认得自己的硬编码 id）
  serverRequest(h.child!, 8, 'session/request_permission', { sessionId: 's_1', toolCall: { toolCallId: 'c2' } });
  await sleep(5);
  (handle as { respondPermission?: (a: string, b: boolean) => void }).respondPermission?.('8', true);
  const resp2 = h.child!.stdin.lines.map((l) => JSON.parse(l)).find((f) => f.id === 8 && f.method === undefined);
  equal(resp2.result.outcome.optionId, 'allow-once', '无选项表 → allow-once 字面量兜底');
  // 收尾
  const pt = sentRequest(h, 2);
  if (pt.method === 'session/prompt') respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
});

// ─────────────────── Q-025 resume 失败处理（损坏日志清引用 / cwd mismatch 保留） ───────────────────

test('Q-025 resume corrupt log 错误 → 降级结算 onResult 带 resumeFailed 标记（Engine 清损坏引用用）', async () => {
  const { provider, h } = setup();
  provider.execute({ ...TASK, resumeSessionId: 'sess-corrupt' }, h.handlers);
  const init = sentRequest(h, 0);
  respond(h.child!, init.id!, { protocolVersion: 1 });
  await sleep(5);
  const rs = sentRequest(h, 1);
  equal(rs.method, 'session/resume');
  // 真机实锤：损坏会话日志 → -32603 corrupt session log
  h.child!.stdout.emitData(JSON.stringify({
    jsonrpc: '2.0', id: rs.id!,
    error: { code: -32603, message: 'Internal error', data: { details: 'corrupt session log: seq gap in committed region at line 38 (expected 127, got 123)' } },
  }) + '\n');
  await sleep(5);
  const ns = sentRequest(h, 2);
  equal(ns.method, 'session/new', '降级新建');
  respond(h.child!, ns.id!, { sessionId: 'sess-fresh' });
  await sleep(5);
  const pt = sentRequest(h, 3);
  equal(pt.method, 'session/prompt');
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.resultCount, 1);
  equal(h.results[0].sessionId, 'sess-fresh', '新 id 回写覆盖损坏 id');
  equal(h.results[0].resumeFailed, true, '带降级标记（new 也失败时 Engine 清空引用用）');
});

test('Q-025 正常执行（无 resume）→ 不带 resumeFailed 标记', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const pt = await handshake(h);
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.results[0].resumeFailed, undefined);
});

// ─────────────────── Q-027 acp 子进程优雅关停（防会话日志损坏） ───────────────────
// 根因：dsh 会话持久化异步写，settle/cancel 后立即 SIGTERM 打断回合尾部落盘 → seq 回退/空洞 →
// 下次 resume corrupt。修复：dispose 关 stdin → 等 dsh 自然退出（grace 1500ms）→ 未退出才 SIGTERM。

test('Q-027 优雅关停：子进程自然退出（grace 窗口内）→ 不发 SIGTERM', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const pt = await handshake(h);
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.resultCount, 1, '结算已 resolve（不等待关停）');
  // 模拟 dsh 自然退出（flush 完成后 exitCode 置位）
  setTimeout(() => { h.child!.exitCode = 0; }, 300);
  await sleep(800);
  equal(h.child!.killed.length, 0, '自然退出 → 无 SIGTERM（回合尾部落盘完整）');
});

test('Q-027 优雅关停：grace 窗口未退出 → SIGTERM 兜底', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const pt = await handshake(h);
  respond(h.child!, pt.id!, { stopReason: 'end_turn' });
  await sleep(5);
  equal(h.child!.killed.length, 0, '结算即返回（关停后台 fire-and-forget）');
  await sleep(1800); // grace 1500ms + 轮询余量
  ok(h.child!.killed.includes('SIGTERM'), 'grace 窗口未退出 → SIGTERM 兜底');
});

test('Q-027 cancel 路径：session/cancel 后子进程自然退出 → 无 SIGTERM（取消不截断写入）', async () => {
  const { provider, h } = setup();
  const handle = provider.execute(TASK, h.handlers);
  await handshake(h);
  await handle.cancel();
  ok(h.child!.stdin.lines.some((l) => l.includes('session/cancel')), '先发 session/cancel');
  setTimeout(() => { h.child!.exitCode = 0; }, 300);
  await sleep(800);
  equal(h.child!.killed.length, 0, 'cancel 后自然退出 → 无立即 SIGTERM');
});

test('Q-027 cancel 兜底：cancel 后未退出 → grace 窗口后 SIGTERM（O-11 保证进程终止）', async () => {
  const { provider, h } = setup();
  const handle = provider.execute(TASK, h.handlers);
  await handshake(h);
  await handle.cancel();
  await sleep(1800);
  ok(h.child!.killed.includes('SIGTERM'), 'cancel 未退出 → SIGTERM 兜底（O-11）');
});
