/**
 * L2b ACPProvider 单测（B4 design §4.1 / 契约 A1~A7, A16, A20）
 *
 * 用 fake spawn（进程桩 stdio）验证：
 * - spawn 参数（复用 M1 spawnArgs：node --expose-internals <bin> acp，cwd=DSH_HOME/dsh）
 * - 连接生命周期：newSession → running → prompt → 完成（onResult 恰好一次 + selfCheck 回传 A8/A9）
 * - agent_message_chunk → text_chunk 事件映射（A2）
 * - session/request_permission → permission_request 事件映射（A3/A4）
 * - cancel 幂等：session/cancel 通知 + kill 兜底 + 结果丢弃（E4/O-11）
 * - 崩溃：子进程意外退出 → failed + 无悬挂（A20/P2-B4-2）
 * - DSH_HOME 未设置 → failed（A16 spawn 前置）
 */
import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { EventEmitter } from 'node:events';

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
/** 解析 fake child stdin 第 idx 条已发送请求 */
function sentRequest(h: Harness, idx: number): { id: number; method: string; params: unknown } {
  return JSON.parse(h.child!.stdin.lines[idx]);
}
/** 触发子进程退出（崩溃模拟） */
function crashChild(child: FakeChild): void {
  child.exitCode = 1;
  child.emit('exit', 1, null);
}

const TASK: ExecutionTask = {
  taskId: 't_1',
  title: '实现看板拖拽',
  ac: { what: '拖拽流转', expected: '列间移动', verify: '手动验证' },
};

process.env.DSH_HOME = '/tmp/fake-home';

test('spawn 参数：复用 M1 spawnArgs（node --expose-internals <bin> acp，cwd=DSH_HOME/dsh）', () => {
  const { provider, h, spawnLog } = setup();
  provider.execute(TASK, h.handlers);
  equal(spawnLog.length, 1);
  equal(spawnLog[0].cmd, 'node');
  equal(spawnLog[0].args[0], '--expose-internals');
  equal(spawnLog[0].args[1], '/tmp/fake-home/dsh/bin/dsh');
  equal(spawnLog[0].args[2], 'acp');
  equal((spawnLog[0].opts as { cwd: string }).cwd, '/tmp/fake-home/dsh');
});

test('连接生命周期：newSession → running → prompt → 完成（A1，onResult 恰好一次）', async () => {
  const { provider, h } = setup();
  const handle = provider.execute(TASK, h.handlers);
  const ns = sentRequest(h, 0);
  equal(ns.method, 'newSession');
  equal((ns.params as { cwd: string }).cwd, '/tmp/fake-home/dsh');
  respond(h.child!, ns.id, { sessionId: 's_1' });
  await sleep(5);
  equal(h.statuses.includes('running'), true);
  const pt = sentRequest(h, 1);
  equal(pt.method, 'prompt');
  equal((pt.params as { sessionId: string }).sessionId, 's_1');
  const text = (pt.params as { text: string }).text;
  ok(text.includes('t_1'), 'prompt 携带 taskId');
  ok(text.includes('拖拽流转'), 'prompt 携带 AC');
  respond(h.child!, pt.id, { summary: 'done', outputPath: 'kanban/executions/e_1.log', selfCheck: { passed: true, evidence: 'ok' } });
  await sleep(5);
  equal(h.resultCount, 1);
  equal(h.results[0].exitCode, 0);
  equal(h.results[0].selfCheck?.passed, true);
  equal(h.results[0].outputPath, 'kanban/executions/e_1.log');
  equal(h.statuses.includes('succeeded'), true);
  await handle.cancel();
  equal(h.resultCount, 1, 'cancel 后不新增结果');
});

test('agent_message_chunk → text_chunk 事件（A2 流式心跳）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const ns = sentRequest(h, 0);
  respond(h.child!, ns.id, { sessionId: 's_1' });
  await sleep(5);
  notify(h.child!, 'agent_message_chunk', { sessionId: 's_1', content: '已完成步骤一' });
  notify(h.child!, 'agent_message_chunk', { sessionId: 's_1', content: '继续' });
  await sleep(5);
  equal(h.events.length, 2);
  equal(h.events[0].kind, 'text_chunk');
  if (h.events[0].kind === 'text_chunk') equal(h.events[0].text, '已完成步骤一');
});

test('session/request_permission → permission_request 事件（A3/A4 审批入口）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const ns = sentRequest(h, 0);
  respond(h.child!, ns.id, { sessionId: 's_1' });
  await sleep(5);
  notify(h.child!, 'session/request_permission', { requestId: 'req_1', message: '允许执行 git push？' });
  await sleep(5);
  equal(h.events.length, 1);
  equal(h.events[0].kind, 'permission_request');
  if (h.events[0].kind === 'permission_request') {
    equal(h.events[0].id, 'req_1');
    equal(h.events[0].message, '允许执行 git push？');
  }
});

test('session/request_permission → emit permission 事件（B4 收口：ApprovalManager 入队数据源）', async () => {
  const { provider, h } = setup();
  const perms: Array<{ taskId: string; title: string; requestId: string; message: string }> = [];
  provider.on('permission', (ctx) => perms.push(ctx));
  provider.execute(TASK, h.handlers);
  const ns = sentRequest(h, 0);
  respond(h.child!, ns.id, { sessionId: 's_1' });
  await sleep(5);
  notify(h.child!, 'session/request_permission', { requestId: 'req_1', message: '允许执行 git push？' });
  await sleep(5);
  equal(perms.length, 1, 'emit 一次 permission 事件');
  deepEqual(perms[0], { taskId: 't_1', title: '实现看板拖拽', requestId: 'req_1', message: '允许执行 git push？' });
  // 收尾：回 prompt 响应结束 ACP 链路（防 30s sendRequest timer 悬挂）
  const pt = sentRequest(h, 1);
  if (pt.method === 'prompt') {
    respond(h.child!, pt.id, { summary: 'done' });
    await sleep(5);
  }
});

test('selfCheck passed=false：原样回传（A9，判定归 VerifyGate）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const ns = sentRequest(h, 0);
  respond(h.child!, ns.id, { sessionId: 's_1' });
  await sleep(5);
  const pt = sentRequest(h, 1);
  respond(h.child!, pt.id, { summary: 'fail', selfCheck: { passed: false, evidence: 'check 不通过' } });
  await sleep(5);
  equal(h.results[0].selfCheck?.passed, false);
  equal(h.results[0].exitCode, 0, '通道侧完成（判定归引擎）');
});

test('cancel：session/cancel 通知 + kill 兜底 + 结果丢弃（幂等）', async () => {
  const { provider, h } = setup();
  const handle = provider.execute(TASK, h.handlers);
  const ns = sentRequest(h, 0);
  respond(h.child!, ns.id, { sessionId: 's_1' });
  await sleep(5);
  await handle.cancel();
  const cancelMsg = h.child!.stdin.lines.find((l) => l.includes('session/cancel'));
  ok(cancelMsg, '发送 session/cancel 通知');
  const parsed = JSON.parse(cancelMsg!);
  equal(parsed.params.sessionId, 's_1');
  ok(h.child!.killed.length >= 1, 'kill 兜底');
  await handle.cancel();
  ok(true, 'cancel 幂等不抛');
});

test('崩溃：子进程意外退出 → failed + 无 onResult 悬挂（A20/P2-B4-2）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const ns = sentRequest(h, 0);
  crashChild(h.child!);
  await sleep(20);
  equal(h.statuses.includes('failed'), true);
  equal(h.resultCount, 1);
  equal(h.results[0].exitCode, 1);
  equal(h.results[0].selfCheck?.passed, false);
});

test('崩溃后响应帧不再触发 onResult（settle 后丢弃）', async () => {
  const { provider, h } = setup();
  provider.execute(TASK, h.handlers);
  const ns = sentRequest(h, 0);
  crashChild(h.child!);
  await sleep(20);
  respond(h.child!, ns.id, { sessionId: 's_1' });
  await sleep(10);
  equal(h.resultCount, 1, '崩溃后无第二次 onResult');
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

test('buildPromptText：text 携带 taskId+AC', () => {
  const text = buildPromptText(TASK);
  ok(text.includes('t_1'));
  ok(text.includes('what: 拖拽流转'));
  ok(text.includes('expected: 列间移动'));
  ok(text.includes('verify: 手动验证'));
  ok(!text.includes('context: '), '无 context 时不输出 context 行');
});

test('buildPromptText：含 context', () => {
  const text = buildPromptText({ taskId: 't_3', title: 't', ac: { what: 'w', expected: 'e', verify: 'v', context: '背景' } });
  ok(text.includes('context: 背景'));
});

test('无 AC：prompt 文本仅 taskId+title', () => {
  const text = buildPromptText({ taskId: 't_2', title: '无 AC 任务' });
  ok(text.includes('t_2'));
  ok(!text.includes('验收标准'));
});
