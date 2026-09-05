/**
 * L3a 收口测试：审批响应通道 / extend 心跳重置 / interrupt / markDeprecated / registry isReady
 *
 * - ACPProvider.respondPermission：经 JsonRpcClient 发 permission_response 帧（B4 §4.2）
 * - Scheduler/ExecutionEngine.respondApproval：转发到当前执行句柄
 * - ExecutionEngine.extendExecution：重置心跳窗口（running 有效，非 running exec-not-running）
 * - ExecutionEngine.interruptExecution：scheduler.cancel + interrupted + 心跳 stop
 * - ExecutionEngine.markExecutionDeprecated：execution 记录标"已废弃（AC 修订）"
 * - ProviderRegistry isReady 接 RuntimeManager phase（假 runtime）
 */
import { test, after } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { KanbanStore } from '../kanban/KanbanStore';
import { DEFAULT_COLUMNS } from '../kanban/types';
import { MockProvider } from './provider/MockProvider';
import { ACPProvider } from './provider/ACPProvider';
import { ProviderManager } from './provider/ProviderManager';
import { ProviderRegistry } from './provider/ProviderRegistry';
import { ExecutionEngine } from './ExecutionEngine';
import { Scheduler, type SchedulerMutations, type SchedulerReadStore } from './scheduler/Scheduler';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时');
    await sleep(5);
  }
}

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup) fn();
});

function makeEnv(delayMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'hull-close-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new KanbanStore({ userDataPath: dir });
  cleanup.push(() => store.dispose());
  const board = store.createBoard('看板', DEFAULT_COLUMNS.map((c) => ({ ...c })));
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new MockProvider({ delayMs }),
    maxParallelTasks: 3,
  });
  cleanup.push(() => engine.dispose());
  const t = store.createTask(board.id, { title: '任务', acceptanceCriteria: { what: 'w', expected: 'e', verify: 'v' } });
  return { store, board, engine, task: t };
}

const status = (store: KanbanStore, boardId: string, taskId: string) =>
  store.getBoard(boardId).tasks.find((t) => t.id === taskId)!.executionStatus;

// ───────────────────── 1. ACPProvider.respondPermission ─────────────────────

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
class FakeChild extends EventEmitter {
  pid = 1;
  exitCode: number | null = null;
  stdout = new FakeIo();
  stderr = new FakeIo();
  stdin = new FakeIo();
  kill(): boolean {
    return true;
  }
}

const OLD_HOME = process.env.DSH_HOME;

test('ACPProvider.respondPermission：回 session/request_permission response 帧（B4 §4.2 + Q-017-C 标准 ACP）', async () => {
  process.env.DSH_HOME = '/tmp/fake-home';
  try {
    const child = new FakeChild();
    const provider = new ACPProvider({
      spawnFn: (() => child) as never,
    });
    const events: string[] = [];
    const handle = provider.execute(
      { taskId: 't1', title: 't', cwd: tmpdir() },
      {
        onEvent: (e) => events.push(e.kind),
        onStatus: () => {},
        onResult: () => {},
      },
    );
    // 标准 ACP 两步握手：initialize → session/new
    const init = JSON.parse(child.stdin.lines[0]);
    equal(init.method, 'initialize');
    child.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1 } }) + '\n');
    await sleep(5);
    const ns = JSON.parse(child.stdin.lines[1]);
    equal(ns.method, 'session/new');
    child.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: ns.id, result: { sessionId: 's1' } }) + '\n');
    await sleep(5);
    // 标准 ACP：permission 是 server→client REQUEST（带 id）→ permission_request 事件
    child.stdout.emitData(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: { question: '允许?', options: [{ id: 'allow1', kind: 'allow_once' }, { id: 'reject1', kind: 'reject_once' }] },
      }) + '\n',
    );
    await sleep(5);
    ok(events.includes('permission_request'), 'permission_request 事件');
    // respondPermission → 回 response 帧（selected outcome，非旧通知帧）
    (handle as { respondPermission?: (a: string, b: boolean, c?: string) => void }).respondPermission?.('7', true, '用户批准');
    await sleep(5);
    const resp = child.stdin.lines.map((l) => JSON.parse(l)).find((f) => f.id === 7 && f.method === undefined);
    ok(resp, '发送 permission response 帧（id=7）');
    equal(resp.result.outcome.outcome, 'selected');
    equal(resp.result.outcome.optionId, 'allow1', 'approved=true 选 allow 选项');
    // 收尾：回 prompt 响应，结束 ACP 链路（防 30s sendRequest timer 悬挂）
    const pt = child.stdin.lines.map((l) => JSON.parse(l)).find((m) => m.method === 'session/prompt');
    if (pt) {
      child.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: pt.id, result: { stopReason: 'end_turn' } }) + '\n');
      await sleep(10);
    }
  } finally {
    process.env.DSH_HOME = OLD_HOME ?? '/tmp/fake-home';
  }
});

// ───────────────────── 2. Scheduler/ExecutionEngine.respondApproval ─────────────────────

test('ExecutionEngine.respondApproval：转发到当前执行句柄（running 时 true）', async () => {
  // 用 ACPProvider（真实 respondPermission）+ fake child 验证 engine 转发
  process.env.DSH_HOME = '/tmp/fake-home';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'hull-close-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new KanbanStore({ userDataPath: dir });
    cleanup.push(() => store.dispose());
    const board = store.createBoard('b', DEFAULT_COLUMNS.map((c) => ({ ...c })));
    const child = new FakeChild();
    const engine = new ExecutionEngine({
      store,
      providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
      provider: new ACPProvider({ spawnFn: (() => child) as never }),
    });
    cleanup.push(() => engine.dispose());
    const t = store.createTask(board.id, { title: 't', acceptanceCriteria: { what: 'w', expected: 'e', verify: 'v' } });
    engine.executeTask(board.id, t.id);
    // 标准 ACP 两步握手（Q-017-C）：initialize → session/new
    const init = JSON.parse(child.stdin.lines[0]);
    child.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1 } }) + '\n');
    await sleep(5);
    const ns = JSON.parse(child.stdin.lines[1]);
    child.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: ns.id, result: { sessionId: 's1' } }) + '\n');
    await sleep(5);
    // Q-021 修订：Scheduler 终端兜底 reasoningEffort='low' → 会话建立后先回 effort 设置帧
    const eff = JSON.parse(child.stdin.lines[2]);
    equal(eff.method, 'session/set_config_option');
    equal(eff.params.configId, 'reasoning_effort');
    equal(eff.params.value, 'low');
    child.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: eff.id, result: { ok: true } }) + '\n');
    await waitFor(() => status(store, board.id, t.id) === 'running');
    // Q-017-C：标准 ACP 下 respond 只能回在途请求——先模拟 dsh 发 permission 请求（id=7）
    child.stdout.emitData(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: { question: '允许?', options: [{ id: 'allow1', kind: 'allow_once' }] },
      }) + '\n',
    );
    await sleep(5);
    const okResp = engine.respondApproval(t.id, '7', true, 'ok');
    equal(okResp, true, 'running 任务可回审批');
    // Q-017-C：response 帧形态（id=7 无 method，selected outcome）
    const sent = child.stdin.lines.map((l) => JSON.parse(l)).find((f) => f.id === 7 && f.method === undefined);
    ok(sent, 'engine 转发 response 帧到 ACP');
    equal(sent.result.outcome.outcome, 'selected');
    // 收尾：回 prompt 响应，结束 ACP 会话链路（防 30s sendRequest timer 悬挂）
    const pt = child.stdin.lines.map((l) => JSON.parse(l)).find((m) => m.method === 'session/prompt');
    if (pt) {
      child.stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: pt.id, result: { stopReason: 'end_turn' } }) + '\n');
      await waitFor(() => status(store, board.id, t.id) === 'succeeded');
    }
  } finally {
    process.env.DSH_HOME = OLD_HOME ?? '/tmp/fake-home';
  }
});

test('ExecutionEngine.respondApproval：任务非 running（已结算）→ false', async () => {
  const { store, board, engine, task } = makeEnv(5);
  engine.executeTask(board.id, task.id);
  await waitFor(() => status(store, board.id, task.id) === 'succeeded');
  equal(engine.respondApproval(task.id, 'req_x', true), false, '非 running 无响应通道');
});

// ───────────────────── 3. extendExecution 心跳重置 ─────────────────────

test('extendExecution：running → 重置心跳窗口（idleResetAt 返回）', async () => {
  const { store, board, engine, task } = makeEnv(200); // 长任务保持 running
  engine.executeTask(board.id, task.id);
  await waitFor(() => status(store, board.id, task.id) === 'running');
  const out = engine.extendExecution(board.id, task.id);
  equal(out.executionStatus, 'running');
  ok(out.idleResetAt, '返回 idleResetAt');
  // 收尾：等 mock 结算完（防 after 清理后 mock 异步活动）
  await waitFor(() => status(store, board.id, task.id) === 'succeeded', 1000);
});

test('extendExecution：非 running → exec-not-running', async () => {
  const { store, board, engine, task } = makeEnv(5);
  engine.executeTask(board.id, task.id);
  await waitFor(() => status(store, board.id, task.id) === 'succeeded');
  throws(() => engine.extendExecution(board.id, task.id), /非 running 无需延长/);
});

// ───────────────────── 4. interruptExecution + markExecutionDeprecated ─────────────────────

test('interruptExecution：scheduler.cancel + interrupted + 心跳 stop', async () => {
  const { store, board, engine, task } = makeEnv(200);
  engine.executeTask(board.id, task.id);
  await waitFor(() => status(store, board.id, task.id) === 'running');
  await engine.interruptExecution(board.id, task.id, '执行已中断', 'AC 修订');
  equal(status(store, board.id, task.id), 'interrupted');
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === task.id)!;
  ok(rec.timeline.some((x) => x.type === 'system' && x.content.includes('执行已中断')), 'system 事件');
});

test('markExecutionDeprecated：execution 记录标"已废弃（AC 修订）"', async () => {
  const { store, board, engine, task } = makeEnv(5);
  engine.executeTask(board.id, task.id);
  await waitFor(() => status(store, board.id, task.id) === 'succeeded');
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === task.id)!;
  // 🟡-4：succeeded 后 currentExecutionId=null——废弃定位改走 timeline execution 记录 id
  const execId = rec.timeline.find((x) => x.type === 'execution')!.id;
  equal(rec.currentExecutionId, null, '🟡-4 succeeded 后 currentExecutionId=null');
  engine.markExecutionDeprecated(board.id, task.id, execId);
  const after = store.getBoard(board.id).tasks.find((x) => x.id === task.id)!;
  const execItem = after.timeline.find((x) => x.type === 'execution');
  ok(execItem, '有 execution 记录');
  ok(execItem!.content.includes('已废弃'), 'execution 记录标废弃');
});

// ───────────────────── 5. ProviderRegistry isReady 接 RuntimeManager ─────────────────────

test('ProviderRegistry isReady：runtime phase=ready → available=true', () => {
  const registry = new ProviderRegistry();
  const fakeRuntime = {
    snapshot: () => ({ phase: 'ready' as string }),
  };
  registry.register({
    provider: 'dsh',
    displayName: 'DeepSeek Harness',
    factory: () => new MockProvider(),
    isReady: () => fakeRuntime.snapshot().phase === 'ready',
  });
  const info = registry.list();
  equal(info[0].available, true);
  equal(registry.resolve('dsh').provider, 'dsh');
});

test('ProviderRegistry isReady：runtime phase=idle → available=false + resolve 抛 exec-provider-unavailable', () => {
  const registry = new ProviderRegistry();
  const fakeRuntime = {
    snapshot: () => ({ phase: 'idle' as string }),
  };
  registry.register({
    provider: 'dsh',
    displayName: 'DeepSeek Harness',
    factory: () => new MockProvider(),
    isReady: () => fakeRuntime.snapshot().phase === 'ready',
  });
  const info = registry.list();
  equal(info[0].available, false, 'dsh 未就绪 available=false（口径一致 P1-B4-2）');
  throws(() => registry.resolve('dsh'), /exec-provider-unavailable|执行通道未就绪/);
});

// ───────────────────── Scheduler.respondApproval 直接测 ─────────────────────

test('Scheduler.respondApproval：转发到 running 句柄', async () => {
  const store: SchedulerReadStore & { status: (id: string) => string } = {
    getBoard: () => ({
      id: 'b1',
      name: 'b',
      columns: [{ id: 'c_todo', type: 'todo', name: 'Todo', order: 0, color: '#000', hidden: false }],
      tasks: [
        { id: 'T', parentId: null, columnId: 'c_todo', title: 't', executionMode: 'auto', executionStatus: 'idle', currentExecutionId: null, acceptanceCriteria: { what: 'w', expected: 'e', verify: 'v' }, agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' }, dependencies: [], description: null, labels: [], priority: 'P2', assignee: null, dueDate: null, startDate: null, order: 0, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null, createdAt: '', updatedAt: '', timeline: [] },
      ],
      order: 0,
      createdAt: '',
      updatedAt: '',
    }),
    status: () => 'idle',
  };
  const mutations: SchedulerMutations = {
    enqueueTask: () => {},
    startTask: () => {},
    settleTask: () => 'succeeded',
    cancelTask: () => {},
    failQueuedDependency: () => {},
    failDeadlock: () => {},
    deriveParent: () => {},
  };
  const sched = new Scheduler(store, new MockProvider({ delayMs: 30 }), mutations, { maxParallelTasks: 3 });
  sched.executeTask('b1', 'T');
  // MockProvider handle 无 respondPermission → false（无响应通道）
  const okResp = sched.respondApproval('T', 'req_1', true);
  equal(okResp, false, 'mock handle 无 respondPermission');
});
