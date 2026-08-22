/**
 * B3 Scheduler 并行调度器单测（契约 E13~E32）
 *
 * 注入 MockProvider + 假 store（SchedulerReadStore 内存实现）+ mutations spy。
 * 覆盖：并行上限/依赖串行/失败传播/死锁/父卡展开/守卫/快照/并发竞态/排队/cancel/
 * manual 依赖/cancel queued/双 onResult 幂等。
 */
import { test } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';

import type { Board, ExecutionStatus, Task } from '../../kanban/types';
import { MockProvider } from '../provider/MockProvider';
import type { ExecutionEvent } from '../provider/ExecutionProvider';
import { Scheduler, type SchedulerReadStore, type SchedulerSettledResult } from './Scheduler';

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

/** 假 store：内存 board，任务状态可手动改 */
class FakeStore implements SchedulerReadStore {
  boards = new Map<string, Board>();
  register(board: Board): void {
    this.boards.set(board.id, board);
  }
  getBoard(boardId: string): Board {
    const b = this.boards.get(boardId);
    if (!b) throw new Error(`board 不存在: ${boardId}`);
    return b;
  }
  status(taskId: string): ExecutionStatus {
    for (const b of this.boards.values()) {
      const t = b.tasks.find((x) => x.id === taskId);
      if (t) return t.executionStatus;
    }
    throw new Error(`task 不存在: ${taskId}`);
  }
  setStatus(taskId: string, s: ExecutionStatus): void {
    for (const b of this.boards.values()) {
      const t = b.tasks.find((x) => x.id === taskId);
      if (t) {
        t.executionStatus = s;
        return;
      }
    }
  }
}

/** mutations spy：记录调用序列 */
class SpyMutations {
  calls: string[] = [];
  settled = new Map<string, SchedulerSettledResult>();
  started = new Set<string>();
  cancelled = new Set<string>();
  failedDeps = new Map<string, string[]>();
  deadlocked = new Set<string>();
  derived = new Map<string, ExecutionStatus>();
  events = new Map<string, ExecutionEvent[]>();
  /** store 联动引用：settle 时同步任务状态（spy 需镜像真实 store 语义） */
  setStatus: (taskId: string, s: ExecutionStatus) => void = () => {};

  enqueueTask = (taskId: string) => this.calls.push(`enqueue:${taskId}`);
  startTask = (taskId: string) => {
    if (this.started.has(taskId)) return; // 幂等
    this.started.add(taskId);
    this.calls.push(`start:${taskId}`);
  };
  settleTask = (taskId: string, result: SchedulerSettledResult) => {
    this.settled.set(taskId, result);
    this.calls.push(`settle:${taskId}`);
    const s = result.exitCode === 0 && (result.selfCheck?.passed ?? true) ? ('succeeded' as const) : ('failed' as const);
    this.setStatus(taskId, s);
    return s;
  };
  cancelTask = (taskId: string) => {
    this.cancelled.add(taskId);
    this.calls.push(`cancel:${taskId}`);
  };
  failQueuedDependency = (taskId: string, depId: string) => {
    this.failedDeps.set(taskId, [...(this.failedDeps.get(taskId) ?? []), depId]);
    this.setStatus(taskId, 'failed');
    this.calls.push(`failDep:${taskId}<-${depId}`);
  };
  failDeadlock = (parentId: string) => {
    this.deadlocked.add(parentId);
    this.setStatus(parentId, 'failed');
    this.calls.push(`deadlock:${parentId}`);
  };
  deriveParent = (parentId: string, derived: ExecutionStatus) => {
    this.derived.set(parentId, derived);
    this.calls.push(`derive:${parentId}:${derived}`);
  };
  onStreamEvent = (taskId: string, ev: unknown) => {
    this.events.set(taskId, [...(this.events.get(taskId) ?? []), ev as ExecutionEvent]);
  };
}

function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    parentId: null,
    columnId: 'c_todo',
    title: `任务 ${id}`,
    executionMode: 'auto',
    executionStatus: 'idle',
    currentExecutionId: null,
    acceptanceCriteria: { what: 'w', expected: 'e', verify: 'v' },
    agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
    dependencies: [],
    description: null,
    labels: [],
    priority: 'P2',
    assignee: null,
    dueDate: null,
    startDate: null,
    order: 0,
    blockedFromColumnId: null,
    archivedAt: null,
    archivedFromColumnId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timeline: [],
    ...over,
  };
}

function makeBoard(id: string, tasks: Task[]): Board {
  return {
    id,
    name: `看板 ${id}`,
    columns: [
      { id: 'c_todo', type: 'todo', name: 'Todo', order: 0, color: '#58a6ff', hidden: false },
      { id: 'c_done', type: 'done', name: 'Done', order: 1, color: '#3fb950', hidden: false },
    ],
    tasks,
    order: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function setup(board: Board, opts: { maxParallelTasks?: number; delayMs?: number } = {}) {
  const store = new FakeStore();
  store.register(board);
  const mutations = new SpyMutations();
  mutations.setStatus = (taskId, s) => store.setStatus(taskId, s);
  const provider = new MockProvider({ delayMs: opts.delayMs ?? 0 });
  const sched = new Scheduler(store, provider, mutations, { maxParallelTasks: opts.maxParallelTasks ?? 3 });
  return { store, mutations, provider, sched };
}

function makeIndependentTasks(n: number, prefix = 't'): Task[] {
  return Array.from({ length: n }, (_, i) => makeTask(`${prefix}${i + 1}`));
}

test('E13 并行上限：5 空依赖 delayMs=30 → 峰值 2≤peak≤3', async () => {
  const board = makeBoard('b1', makeIndependentTasks(5));
  const { store, mutations, sched } = setup(board, { maxParallelTasks: 3, delayMs: 30 });
  let peak = 0;
  sched.on('parallel', (_b, { running }) => {
    peak = Math.max(peak, running.length);
  });
  sched.executeTask('b1', 't1');
  sched.executeTask('b1', 't2');
  sched.executeTask('b1', 't3');
  sched.executeTask('b1', 't4');
  sched.executeTask('b1', 't5');
  await waitFor(() => mutations.settled.size === 5);
  ok(peak >= 2, `峰值≥2，实际 ${peak}`);
  ok(peak <= 3, `峰值≤3，实际 ${peak}`);
  for (let i = 1; i <= 5; i++) equal(store.status(`t${i}`), 'succeeded');
});

test('E14 依赖串行：B 依赖 A → settle(A) 先于 start(B)', async () => {
  const a = makeTask('A');
  const b = makeTask('B', { dependencies: ['A'] });
  const board = makeBoard('b1', [a, b]);
  const { mutations, sched } = setup(board, { delayMs: 5 });
  sched.executeTask('b1', 'A');
  sched.executeTask('b1', 'B');
  await waitFor(() => mutations.settled.size === 2);
  const aSettle = mutations.calls.indexOf('settle:A');
  const bStart = mutations.calls.indexOf('start:B');
  ok(aSettle >= 0 && bStart >= 0);
  ok(aSettle < bStart, 'B 在 A settle 后才 start');
});

test('E15 失败传播：B selfCheck false → A(依赖B) queued→failed', async () => {
  const b = makeTask('B');
  const a = makeTask('A', { dependencies: ['B'] });
  const board = makeBoard('b1', [a, b]);
  const store = new FakeStore();
  store.register(board);
  const mutations = new SpyMutations();
  mutations.setStatus = (taskId, s) => store.setStatus(taskId, s);
  // B 注入 selfCheck passed=false → settleTask 返回 failed
  const provider = new MockProvider({
    delayMs: 5,
    outcome: { kind: 'success', selfCheck: { passed: false } },
  });
  const sched = new Scheduler(store, provider, mutations, { maxParallelTasks: 3 });
  sched.executeTask('b1', 'B');
  sched.executeTask('b1', 'A');
  await waitFor(() => mutations.settled.size === 1 && mutations.failedDeps.has('A'));
  equal(mutations.failedDeps.get('A')?.includes('B'), true);
  equal(store.status('A'), 'failed', 'A queued → failed');
});

test('E16 死锁：环 A→B→A 全 queued → failDeadlock', async () => {
  const a = makeTask('A', { dependencies: ['B'] });
  const b = makeTask('B', { dependencies: ['A'] });
  const board = makeBoard('b1', [a, b]);
  const { mutations, sched } = setup(board);
  sched.executeTask('b1', 'A');
  sched.executeTask('b1', 'B');
  await waitFor(() => mutations.deadlocked.size > 0 || mutations.calls.includes('deadlock:A'));
  ok(mutations.deadlocked.has('A') || mutations.deadlocked.has('B'), `死锁父卡 A/B 标 failDeadlock`);
});

test('E17/E29 父卡展开：5 子（3 就绪 + 1 缺 AC + 1 依赖未满足）→ enqueued=3 skipped=2', async () => {
  const parent = makeTask('P');
  const c1 = makeTask('C1');
  const c2 = makeTask('C2');
  const c3 = makeTask('C3');
  const c4 = makeTask('C4', { acceptanceCriteria: null }); // 缺 AC
  const c5 = makeTask('C5', { dependencies: ['X'] }); // 依赖不存在
  for (const c of [c1, c2, c3, c4, c5]) c.parentId = 'P';
  const board = makeBoard('b1', [parent, c1, c2, c3, c4, c5]);
  const { store, mutations, sched } = setup(board, { delayMs: 5 });
  const res = sched.executeTask('b1', 'P');
  equal(res.kind, 'parent_expand');
  equal(res.enqueued.length, 3);
  equal(res.skipped.length, 2);
  await waitFor(() => mutations.settled.size === 3);
  for (const id of res.enqueued) equal(store.status(id), 'succeeded');
});

test('E30 父卡全未就绪 → enqueued=[] skipped=全部', async () => {
  const parent = makeTask('P');
  const c1 = makeTask('C1', { dependencies: ['X'] });
  const c2 = makeTask('C2', { dependencies: ['X'] });
  c1.parentId = 'P';
  c2.parentId = 'P';
  const board = makeBoard('b1', [parent, c1, c2]);
  const { sched } = setup(board);
  const res = sched.executeTask('b1', 'P');
  equal(res.enqueued.length, 0);
  equal(res.skipped.length, 2);
  equal(res.skipped.includes('C1'), true);
  equal(res.skipped.includes('C2'), true);
});

test('E28 单卡守卫：running 中 executeTask → ExecStateConflictError', async () => {
  const t = makeTask('T');
  const board = makeBoard('b1', [t]);
  const { sched } = setup(board, { delayMs: 30 });
  sched.executeTask('b1', 'T');
  await sleep(5);
  throws(() => sched.executeTask('b1', 'T'), /任务已在执行/);
});

test('E2 auto 缺 AC → ExecValidationError', async () => {
  const t = makeTask('T', { acceptanceCriteria: null });
  const board = makeBoard('b1', [t]);
  const { sched } = setup(board);
  throws(() => sched.executeTask('b1', 'T'), /验收标准|AC|validation-error/);
});

test('E26 快照 getSnapshot', async () => {
  const board = makeBoard('b1', makeIndependentTasks(4));
  const { sched } = setup(board, { delayMs: 30 });
  sched.executeTask('b1', 't1');
  sched.executeTask('b1', 't2');
  sched.executeTask('b1', 't3');
  sched.executeTask('b1', 't4');
  await sleep(5);
  const snap = sched.getSnapshot('b1');
  equal(snap.maxParallel, 3);
  equal(snap.running.length, 3);
  equal(snap.queued.length, 1);
  equal(snap.queued[0].taskId, 't4');
});

test('E32 并发竞态：5 空依赖父卡展开，peak≥2 且 ≤3，全部 succeeded', async () => {
  const parent = makeTask('P');
  const children = makeIndependentTasks(5, 'c');
  for (const c of children) c.parentId = 'P';
  const board = makeBoard('b1', [parent, ...children]);
  const { store, mutations, sched } = setup(board, { maxParallelTasks: 3, delayMs: 30 });
  let peak = 0;
  sched.on('parallel', (_b, { running }) => {
    peak = Math.max(peak, running.length);
  });
  const res = sched.executeTask('b1', 'P');
  equal(res.enqueued.length, 5);
  await waitFor(() => sched['runningCount'] === 0 && sched['queuedQueue'].size === 0);
  ok(peak >= 2, `peak≥2，实际 ${peak}`);
  ok(peak <= 3, `peak≤3，实际 ${peak}`);
  for (const id of res.enqueued) equal(store.status(id), 'succeeded');
});

test('满池排队：5 空依赖 → 3 running + 2 queued，前 3 完成补 2', async () => {
  const board = makeBoard('b1', makeIndependentTasks(5));
  const { store, mutations, sched } = setup(board, { delayMs: 20 });
  for (let i = 1; i <= 5; i++) sched.executeTask('b1', `t${i}`);
  await sleep(5);
  let snap = sched.getSnapshot('b1');
  equal(snap.running.length, 3);
  equal(snap.queued.length, 2);
  await waitFor(() => mutations.settled.size === 5, 3000);
  snap = sched.getSnapshot('b1');
  equal(snap.running.length, 0);
  equal(snap.queued.length, 0);
  for (let i = 1; i <= 5; i++) equal(store.status(`t${i}`), 'succeeded');
});

test('cancel queued：出队不执行', async () => {
  const board = makeBoard('b1', makeIndependentTasks(4));
  const { mutations, sched } = setup(board, { delayMs: 30 });
  for (let i = 1; i <= 4; i++) sched.executeTask('b1', `t${i}`);
  await sleep(5);
  await sched.cancel('b1', 't4');
  await waitFor(() => mutations.settled.size === 3, 2000);
  const snap = sched.getSnapshot('b1');
  equal(snap.queued.length, 0);
  equal(mutations.calls.includes('start:t4'), false, 't4 未 start');
});

test('cancel running：句柄 cancel 被调（结果丢弃）', async () => {
  const board = makeBoard('b1', [makeTask('T')]);
  const { mutations, sched } = setup(board, { delayMs: 30 });
  sched.executeTask('b1', 'T');
  await sleep(5);
  await sched.cancel('b1', 'T');
  await waitFor(() => mutations.cancelled.size === 1, 2000);
  equal(mutations.cancelled.has('T'), true);
});

test('manual 依赖按列 Done 解锁：manual 依赖在 Done 列 → 解锁后续任务', async () => {
  const manual = makeTask('M', { executionMode: 'manual', columnId: 'c_done' });
  const auto = makeTask('A', { dependencies: ['M'] });
  const board = makeBoard('b1', [manual, auto]);
  const { store, mutations, sched } = setup(board, { delayMs: 5 });
  sched.executeTask('b1', 'A');
  await waitFor(() => mutations.settled.size === 1);
  equal(store.status('A'), 'succeeded', 'manual 依赖在 Done 列视为满足');
});

test('manual 依赖未在 Done 列 → 不满足（不进池）', async () => {
  const manual = makeTask('M', { executionMode: 'manual', columnId: 'c_todo' });
  const auto = makeTask('A', { dependencies: ['M'] });
  const board = makeBoard('b1', [manual, auto]);
  const { mutations, sched } = setup(board, { delayMs: 5 });
  sched.executeTask('b1', 'A');
  await sleep(20);
  equal(mutations.settled.size, 0, '依赖未满足不执行');
  equal(mutations.calls.includes('start:A'), false);
});

test('provider 双 onResult 幂等：settle 后第二次 onResult 忽略', async () => {
  const board = makeBoard('b1', [makeTask('T')]);
  const { mutations, sched } = setup(board, { delayMs: 30 });
  sched.executeTask('b1', 'T');
  await waitFor(() => mutations.settled.size === 1, 2000);
  equal(mutations.settled.size, 1, '仅一次 settle');
  // 手动触发第二次 handleResult（模拟 provider 双回调）→ 不重复结算
  sched.handleResult('T', { exitCode: 0, summary: 'dup', outputPath: '' });
  await sleep(10);
  equal(mutations.settled.size, 1);
});

test('onStreamEvent 透传：text_chunk 事件到 mutations', async () => {
  const t = makeTask('T');
  const board = makeBoard('b1', [t]);
  const { store, mutations } = setup(board, { delayMs: 5 });
  const provider = new MockProvider({ outcome: { kind: 'stream', chunks: ['a', 'b'] } });
  const sched2 = new Scheduler(store, provider, mutations, { maxParallelTasks: 3 });
  sched2.executeTask('b1', 'T');
  await waitFor(() => mutations.events.has('T') && mutations.events.get('T')!.length >= 2, 2000);
  const evs = mutations.events.get('T')!;
  equal(evs[0].kind, 'text_chunk');
  ok(evs.length >= 2);
});

test('🟡-2 心跳超时 + provider settle 同帧 → 终态唯一 failed（不出现 cancelled→succeeded 摇摆）', async () => {
  const t = makeTask('T');
  const board = makeBoard('b1', [t]);
  const { store, mutations, sched } = setup(board, { delayMs: 5000 }); // 长任务，超时窗口内仍在跑
  sched.executeTask('b1', 'T');
  await sleep(5);
  equal(mutations.calls.includes('start:T'), true, '任务已 start');
  // 心跳超时：引擎走 failRunning（kill + 注入 failed），不调 scheduler.cancel
  sched.failRunning('T');
  // 同帧 provider settle 迟到：模拟 provider 仍回 onResult（success）+ onStatus('cancelled')
  // ——终态必须唯一 failed，不允许 cancelled 覆盖或 succeeded 摇摆
  sched.handleResult('T', { exitCode: 0, summary: 'late', outputPath: '', selfCheck: { passed: true } });
  sched.handleStatus('T', 'cancelled');
  await waitFor(() => mutations.settled.size === 1, 2000);
  equal(mutations.settled.size, 1, '恰好一次结算');
  equal(store.status('T'), 'failed', '终态唯一 failed');
  ok(!mutations.calls.includes('cancel:T'), '未走 cancelTask（不出现 cancelled 覆盖）');
  const settle = mutations.settled.get('T');
  equal(settle?.selfCheck?.passed, false, '结算按超时 failed 判定（非迟到 succeeded）');
});
