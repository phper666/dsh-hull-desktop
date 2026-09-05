/**
 * L3a ExecutionEngine 门面单测
 *
 * 注入 MockProvider（outcome 可控）+ 内存 KanbanStore（参照 KanbanStore.test.ts 用法）。
 * 覆盖：executeTask 单/父卡/自检通过进 Verify/失败 failed/confirmVerify/manualComplete/
 * cancel/pause/resume/快照/心跳超时/收敛。
 */
import { test, after } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KanbanStore } from '../kanban/KanbanStore';
import { DEFAULT_COLUMNS } from '../kanban/types';
import { MockProvider, type MockOutcome } from './provider/MockProvider';
import type { ExecutionProvider, ExecutionTask, ExecutionHandlers, ExecutionResult } from './provider/ExecutionProvider';
import { ProviderManager } from './provider/ProviderManager';
import { ExecutionEngine } from './ExecutionEngine';
import type { NotifInput } from '../notifications/types';

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

function makeEnv(outcome?: MockOutcome, delayMs = 0, emitNotif?: (input: NotifInput) => void, useExecLog?: boolean, providerOverride?: ExecutionProvider) {
  const dir = mkdtempSync(join(tmpdir(), 'hull-engine-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new KanbanStore({ userDataPath: dir });
  cleanup.push(() => store.dispose());
  const board = store.createBoard('看板', DEFAULT_COLUMNS.map((c) => ({ ...c })));
  const provider = providerOverride ?? new MockProvider(outcome ? { outcome, delayMs } : { delayMs });
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider,
    maxParallelTasks: 3,
    emitNotif,
    executionsDir: useExecLog ? join(dir, 'kanban', 'executions') : undefined, // Q-回复落盘（2026-09-05）：流式输出日志目录（缺省不写）
  });
  cleanup.push(() => engine.dispose());
  return { store, board, engine };
}

function makeTask(
  store: KanbanStore,
  boardId: string,
  over: { title?: string; executionMode?: 'manual' | 'auto'; ac?: boolean; parentId?: string; dependencies?: string[] } = {},
) {
  return store.createTask(boardId, {
    title: over.title ?? '任务',
    executionMode: over.executionMode ?? 'auto',
    acceptanceCriteria: over.ac === false ? null : { what: 'w', expected: 'e', verify: 'v' },
    parentId: over.parentId,
    dependencies: over.dependencies ?? [],
  });
}

const status = (store: KanbanStore, boardId: string, taskId: string) =>
  store.getBoard(boardId).tasks.find((t) => t.id === taskId)!.executionStatus;
const column = (store: KanbanStore, boardId: string, taskId: string) =>
  store.getBoard(boardId).tasks.find((t) => t.id === taskId)!.columnId;

/** manual 结算 stub：无 selfCheck（对齐 ACP 对 manual 任务不回 selfCheck，Q-015） */
class NoSelfCheckProvider implements ExecutionProvider {
  execute(task: ExecutionTask, handlers: ExecutionHandlers): { cancel(): Promise<void> } {
    handlers.onStatus('running');
    setTimeout(() => {
      handlers.onResult({ exitCode: 0, summary: 'manual 完成', outputPath: '' });
      handlers.onStatus('succeeded');
    }, 5);
    return { cancel: async () => {} };
  }
}

function makeManualEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'hull-engine-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new KanbanStore({ userDataPath: dir });
  cleanup.push(() => store.dispose());
  const board = store.createBoard('看板', DEFAULT_COLUMNS.map((c) => ({ ...c })));
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new NoSelfCheckProvider(),
    maxParallelTasks: 3,
  });
  cleanup.push(() => engine.dispose());
  return { store, board, engine };
}

test('单任务执行：queued → running → succeeded + 列→verify（selfCheck passed=true）', async () => {
  const { store, board, engine } = makeEnv(undefined, 5);
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  const verifyColId = board.columns.find((c) => c.type === 'verify')!.id;
  equal(column(store, board.id, t.id), verifyColId, '完成自动进 verify');
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  // 🟡-4：succeeded 后清 currentExecutionId（execution record 走 timeline 追溯，不再指向旧执行）
  equal(rec.currentExecutionId, null, 'succeeded 后清 currentExecutionId');
  // execution 记录 timeline
  ok(rec.timeline.some((x) => x.type === 'execution'), '有 execution 记录');
  ok(rec.timeline.some((x) => x.type === 'system'), '有 system 事件');
});

test('selfCheck passed=false → failed', async () => {
  const { store, board, engine } = makeEnv({ kind: 'success', selfCheck: { passed: false } }, 5);
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'failed');
  equal(status(store, board.id, t.id), 'failed');
});

test('父卡展开：executeTask(父卡) → 子任务入队执行全部 succeeded', async () => {
  const { store, board, engine } = makeEnv(undefined, 5);
  const parent = makeTask(store, board.id, { title: '父卡' });
  const c1 = makeTask(store, board.id, { parentId: parent.id });
  const c2 = makeTask(store, board.id, { parentId: parent.id });
  const c3 = makeTask(store, board.id, { parentId: parent.id });
  const res = engine.executeTask(board.id, parent.id);
  equal(res.kind, 'parent_expand');
  equal(res.enqueued.length, 3);
  await waitFor(() => [c1.id, c2.id, c3.id].every((id) => status(store, board.id, id) === 'succeeded'));
});

test('父卡展开缺 AC 子任务跳过（manual 任务绕过 store 门控）', async () => {
  const { store, board, engine } = makeEnv(undefined, 5);
  const parent = makeTask(store, board.id, { title: '父卡' });
  const ok1 = makeTask(store, board.id, { parentId: parent.id, title: '好子' });
  // manual 任务无 AC 也是合法（store 不门控 manual）
  const manual = makeTask(store, board.id, { parentId: parent.id, title: 'manual 子', executionMode: 'manual', ac: false });
  const res = engine.executeTask(board.id, parent.id);
  equal(res.enqueued.length, 2, 'manual 子也入队（manual 无 AC 门槛）');
  equal(res.enqueued.includes(ok1.id), true);
  equal(res.enqueued.includes(manual.id), true);
  await waitFor(() => status(store, board.id, ok1.id) === 'succeeded');
});

test('confirmVerify：verify 列 → done 列；非 verify 列 → validation-error', async () => {
  const { store, board, engine } = makeEnv(undefined, 5);
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  const vc = board.columns.find((c) => c.type === 'verify')!;
  const dc = board.columns.find((c) => c.type === 'done')!;
  equal(column(store, board.id, t.id), vc.id);
  const out = engine.confirmVerify(board.id, t.id);
  equal(out.columnId, dc.id);
  equal(column(store, board.id, t.id), dc.id);
  const t2 = makeTask(store, board.id, { title: '未执行' });
  throws(() => engine.confirmVerify(board.id, t2.id), /仅 verify 列任务可确认完成/);
});

test('manualComplete：failed → succeeded + 列→verify', async () => {
  const { store, board, engine } = makeEnv({ kind: 'success', selfCheck: { passed: false } }, 5);
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'failed');
  const out = engine.manualComplete(board.id, t.id);
  equal(out.executionStatus, 'succeeded');
  equal(status(store, board.id, t.id), 'succeeded');
  const vc = board.columns.find((c) => c.type === 'verify')!;
  equal(column(store, board.id, t.id), vc.id);
});

test('cancel：running 任务取消 → cancelled + 心跳停止', async () => {
  const { store, board, engine } = makeEnv(undefined, 100);
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'running');
  await engine.cancel(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'cancelled');
  equal(status(store, board.id, t.id), 'cancelled');
});

test('pause/resume：running → paused → queued → running → succeeded', async () => {
  const { store, board, engine } = makeEnv(undefined, 60);
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'running');
  await engine.pause(board.id, t.id);
  equal(status(store, board.id, t.id), 'paused');
  await engine.resume(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
});

test('getExecutionSnapshot：running/queued + maxParallel', async () => {
  const { store, board, engine } = makeEnv(undefined, 60);
  const t1 = makeTask(store, board.id);
  const t2 = makeTask(store, board.id);
  const t3 = makeTask(store, board.id);
  engine.executeTask(board.id, t1.id);
  engine.executeTask(board.id, t2.id);
  engine.executeTask(board.id, t3.id);
  await waitFor(() => status(store, board.id, t1.id) === 'running');
  const snap = engine.getExecutionSnapshot(board.id);
  equal(snap.maxParallel, 3);
  equal(snap.running.length, 3);
  equal(snap.queued.length, 0);
});

test('心跳超时：无活动 → failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-engine-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new KanbanStore({ userDataPath: dir });
  cleanup.push(() => store.dispose());
  const board = store.createBoard('b', DEFAULT_COLUMNS.map((c) => ({ ...c })));
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new MockProvider({ delayMs: 5000 }), // 长任务，触发心跳超时
    maxExecutionIdleMinutes: 0.001, // 60ms 心跳超时
  });
  cleanup.push(() => engine.dispose());
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'failed', 3000);
  equal(status(store, board.id, t.id), 'failed');
});

test('收敛：壳重启残留 running → failed（Q-017）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-engine-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new KanbanStore({ userDataPath: dir });
  cleanup.push(() => store.dispose());
  const board = store.createBoard('b', DEFAULT_COLUMNS.map((c) => ({ ...c })));
  const a = store.createTask(board.id, { title: '残留运行', acceptanceCriteria: { what: 'w', expected: 'e', verify: 'v' } });
  // 直写 raw 内部态（模拟壳重启残留：running + currentExecutionId）
  const rawBoard = (store as unknown as { data: { boards: Array<{ id: string; tasks: Array<{ id: string; executionStatus: string; currentExecutionId: string | null }> }> } }).data.boards.find((b) => b.id === board.id)!;
  const rawTask = rawBoard.tasks.find((x) => x.id === a.id)!;
  rawTask.executionStatus = 'running';
  rawTask.currentExecutionId = 'e_residual';
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
  });
  cleanup.push(() => engine.dispose());
  engine.start(); // 收敛
  equal(status(store, board.id, a.id), 'failed');
  equal(rawTask.currentExecutionId, null, '清 currentExecutionId');
});

// ─────────────────── 🔴-2 执行态持久化（flushSync 落盘）───────────────────

test('🔴-2 执行态直写后 flush：running → succeeded 全链路落盘（boards.json 可读）', async () => {
  const { store, board, engine } = makeEnv(undefined, 5);
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  // 同步 flush 已随每次执行态写入触发（setExecutionRecord/setExecutionStatus/writeExecutionRecord）
  store.flushSync();
  const filePath = join((store as unknown as { dir: string }).dir, 'boards.json');
  const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as {
    boards: Array<{ id: string; tasks: Array<{ id: string; executionStatus: string; currentExecutionId: string | null; timeline: Array<{ id: string; type: string }> }> }>;
  };
  const dt = onDisk.boards.find((b) => b.id === board.id)!.tasks.find((x) => x.id === t.id)!;
  equal(dt.executionStatus, 'succeeded', '落盘 executionStatus=succeeded');
  equal(dt.currentExecutionId, null, '🟡-4：succeeded 后 currentExecutionId=null 落盘');
  ok(dt.timeline.some((x) => x.type === 'execution'), '落盘 execution timeline 条目');
});

test('🔴-2 收敛后立刻 flush：重启收敛态可读（failed 落盘）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-engine-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new KanbanStore({ userDataPath: dir });
  cleanup.push(() => store.dispose());
  const board = store.createBoard('b', DEFAULT_COLUMNS.map((c) => ({ ...c })));
  const a = store.createTask(board.id, { title: '残留', acceptanceCriteria: { what: 'w', expected: 'e', verify: 'v' } });
  const rawBoard = (store as unknown as { data: { boards: Array<{ id: string; tasks: Array<{ id: string; executionStatus: string }> }> } }).data.boards.find((b) => b.id === board.id)!;
  rawBoard.tasks.find((x) => x.id === a.id)!.executionStatus = 'running';
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
  });
  cleanup.push(() => engine.dispose());
  engine.start(); // markFailed → setExecutionStatus → flushStore 已同步落盘
  equal(status(store, board.id, a.id), 'failed');
  // 不额外 flushSync：验证引擎自身已 flush
  const filePath = join((store as unknown as { dir: string }).dir, 'boards.json');
  const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as {
    boards: Array<{ id: string; tasks: Array<{ id: string; executionStatus: string }> }>;
  };
  const dt = onDisk.boards.find((b) => b.id === board.id)!.tasks.find((x) => x.id === a.id)!;
  equal(dt.executionStatus, 'failed', '收敛 failed 已落盘（无额外 flushSync）');
});

// ─────────────────── 🔴-1 execution timeline 条目 id = currentExecutionId ───────────────────

test('🔴-1 markSucceeded：execution timeline 条目 id = 本次执行 e_<seq> + succeeded 后清 currentExecutionId（🟡-4 重跑独立追溯）', async () => {
  const { store, board, engine } = makeEnv({ kind: 'success', selfCheck: { passed: true } }, 5);
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  const execItem = rec.timeline.find((x) => x.type === 'execution')!;
  ok(execItem, '有 execution 记录');
  ok(execItem.id.startsWith('e_'), 'execution 条目 id = 本次执行 e_<seq>');
  equal(rec.currentExecutionId, null, '🟡-4：succeeded 后清 currentExecutionId（重跑不指向旧执行）');
  ok(execItem.execution?.outputPath?.includes(execItem.id), 'execution 记录 outputPath 指向本次执行日志');
});

// ─────────────────── 🟡-1 manual 结算 succeeded + 依赖解锁 ───────────────────

test('🟡-1 manual 任务执行后 succeeded（结算不误判 failed）', async () => {
  const { store, board, engine } = makeManualEnv();
  const t = store.createTask(board.id, { title: 'manual 卡', executionMode: 'manual' });
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  equal(status(store, board.id, t.id), 'succeeded', 'manual 结算 succeeded 而非 failed');
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  ok(rec.timeline.some((x) => x.type === 'comment' && x.content.includes('执行结果')), 'manual 结果评论回填');
});

test('🟡-1 依赖 manual 的下游任务正确解锁（不级联失败）', async () => {
  const { store, board, engine } = makeManualEnv();
  // manual 父下两个子任务：manual 依赖 + auto 依赖（依赖 manual）
  const parent = makeTask(store, board.id, { title: '父卡' });
  const manualDep = store.createTask(board.id, { title: 'manual 依赖', parentId: parent.id, executionMode: 'manual' });
  const downstream = store.createTask(board.id, {
    title: '下游 auto',
    parentId: parent.id,
    executionMode: 'auto',
    acceptanceCriteria: { what: 'w', expected: 'e', verify: 'v' },
    dependencies: [manualDep.id],
  });
  // 首次展开：依赖未满足 → manualDep 入队，downstream 跳过（B3 父卡展开一次）
  engine.executeTask(board.id, parent.id);
  await waitFor(() => status(store, board.id, manualDep.id) === 'succeeded');
  equal(status(store, board.id, downstream.id), 'idle', '依赖未满足时下游保持 idle（未入队）');
  // manualDep 已 succeeded → 依赖满足；重展开父卡 → downstream 入队执行
  engine.executeTask(board.id, parent.id);
  await waitFor(() => status(store, board.id, downstream.id) === 'succeeded');
  equal(status(store, board.id, downstream.id), 'succeeded', 'manual 结算 succeeded → 下游依赖解锁（不触发 E15 级联 failed）');
});

// ─────────────────── 2026-09-05 体验改进：acp 执行成功 → 自动挪验收列 ───────────────────

test('acp 执行成功（无 selfCheck）→ 列自动流转 verify + 结果评论保留', async () => {
  const { store, board, engine } = makeManualEnv(); // NoSelfCheckProvider：acp 通道不回 selfCheck 的真实形态
  const t = makeTask(store, board.id, { title: 'acp 卡' });
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  const verifyColId = board.columns.find((c) => c.type === 'verify')!.id;
  equal(column(store, board.id, t.id), verifyColId, '成功自动进 verify 列（按列 type 查找，不硬编码 id）');
  ok(
    store.getBoard(board.id).tasks.find((x) => x.id === t.id)!.timeline.some((x) => x.type === 'comment' && x.content.includes('执行结果')),
    '「执行结果」comment 保留（需求 2 展示依据）',
  );
});

// ─────────────────── 🟡-3 引擎 execution-update 事件 ───────────────────

test('🟡-3 ExecutionEngine 发出 execution-update 事件（状态变更推送）', async () => {
  const { store, board, engine } = makeEnv(undefined, 10);
  const updates: Array<{ taskId: string; executionStatus: string }> = [];
  engine.on('execution-update', (p: { taskId: string; executionStatus: string }) => updates.push(p));
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  ok(updates.length >= 3, `收到 queued/running/succeeded 事件（实际 ${updates.length}）`);
  const succ = updates.find((u) => u.taskId === t.id && u.executionStatus === 'succeeded');
  ok(succ, '收到 succeeded 事件');
  const running = updates.find((u) => u.taskId === t.id && u.executionStatus === 'running');
  ok(running, '收到 running 事件');
});

// ─────────────────── 🟡-4 succeeded 重跑追溯断裂修复 ───────────────────

test('🟡-4 succeeded 任务重跑后 currentExecutionId=null + 新 execution record 独立', async () => {
  const { store, board, engine } = makeEnv({ kind: 'success', selfCheck: { passed: true } }, 5);
  const t = makeTask(store, board.id);
  // 首次执行 → succeeded
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  let rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  equal(rec.currentExecutionId, null, '首次 succeeded 后 currentExecutionId=null（🟡-4）');
  const firstExec = rec.timeline.filter((x) => x.type === 'execution');
  equal(firstExec.length, 1, '首次执行 1 条 execution 记录');
  const firstId = firstExec[0].id;

  // 重跑（Q-023 succeeded → queued）→ 再次 succeeded
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  equal(rec.currentExecutionId, null, '重跑 succeeded 后 currentExecutionId 仍 null（不指向旧执行）');
  const execs = rec.timeline.filter((x) => x.type === 'execution');
  equal(execs.length, 2, '重跑新增独立 execution 记录（共 2 条）');
  ok(execs[0].id !== execs[1].id, '两次执行记录 id 独立');
  ok(execs[1].id.startsWith('e_'), '新记录为 e_<seq> 格式');
  ok(execs[1].id !== firstId, '新记录不指向旧执行');
  ok(execs[1].execution?.outputPath?.includes(execs[1].id), '新记录 outputPath 指向本次执行日志');
});

// ── V2a §3.2：看板执行源发射 ──

test('V2a 看板执行源：succeeded → info / failed → error（title/body/link）', async () => {
  const emitted: NotifInput[] = [];
  const { store, board, engine } = makeEnv({ kind: 'success', selfCheck: { passed: true } }, 0, (n) => emitted.push(n));
  const task = makeTask(store, board.id, { title: '自动任务', executionMode: 'auto', ac: true });
  await engine.executeTask(board.id, task.id);
  await waitFor(() => emitted.length >= 1, 5000);
  equal(emitted[0].severity, 'info');
  equal(emitted[0].title, '任务 · 自动任务');
  equal(emitted[0].link.kind, 'task');
  if (emitted[0].link.kind === 'task') equal(emitted[0].link.taskId, task.id);

  const emitted2: NotifInput[] = [];
  const env2 = makeEnv({ kind: 'success', selfCheck: { passed: false }, exitCode: 1 }, 0, (n) => emitted2.push(n));
  const task2 = makeTask(env2.store, env2.board.id, { title: '会失败的任务', executionMode: 'auto', ac: true });
  await env2.engine.executeTask(env2.board.id, task2.id);
  await waitFor(() => emitted2.length >= 1, 5000);
  equal(emitted2[0].severity, 'error');
  ok(emitted2[0].title.includes('【失败】'));
});

test('V2a 看板执行源：failed 去重单发 + 父卡聚合通知 + 未入队依赖不发', async () => {
  const emitted: NotifInput[] = [];
  const { store, board, engine } = makeEnv({ kind: 'success', selfCheck: { passed: false }, exitCode: 1 }, 0, (n) => emitted.push(n));
  const parent = makeTask(store, board.id, { title: '父卡' });
  const ac = { what: 'w', expected: 'e', verify: 'v' };
  const childA = store.createTask(board.id, { title: '子任务A（失败）', parentId: parent.id, executionMode: 'auto', acceptanceCriteria: ac, dependencies: [] });
  const childB = store.createTask(board.id, { title: '子任务B（依赖A）', parentId: parent.id, executionMode: 'auto', acceptanceCriteria: ac, dependencies: [childA.id] });
  await engine.executeTask(board.id, parent.id);
  // §3.2（实测修订）：failed 发射唯一出口 = setExecutionStatus（A 结算 + 父卡聚合推导各一条）；
  // B 依赖未满足保持 idle 不入队 → 不级联不发通知（E15 级联边界）
  const countFor = (taskId: string) => emitted.filter((n) => n.link.kind === 'task' && n.link.taskId === taskId).length;
  await waitFor(() => countFor(childA.id) >= 1, 5000);
  await new Promise((r) => setTimeout(r, 50));
  equal(countFor(childA.id), 1, 'A 结算失败恰好一条（去重生效）');
  equal(countFor(parent.id), 1, '父卡聚合 failed 一条（deriveParent → setExecutionStatus）');
  equal(countFor(childB.id), 0, 'B 未入队保持 idle，不发通知');
  equal(status(store, board.id, childB.id), 'idle');
  equal(emitted.every((n) => n.severity === 'error'), true);
});

// ─────────────────── Q-020 失败可观测性：provider 真实原因进 timeline + 通知 body ───────────────────

/** Q-020：onResult 带真实失败 summary 的 provider（复现 ACPProvider settleFailure 形态） */
class FailWithSummaryProvider implements ExecutionProvider {
  constructor(private readonly summary: string) {}
  execute(task: ExecutionTask, handlers: ExecutionHandlers): { cancel(): Promise<void> } {
    handlers.onStatus('failed');
    handlers.onResult({ exitCode: 1, summary: this.summary, outputPath: '', selfCheck: { passed: false } });
    return { cancel: async () => {} };
  }
}

test('Q-020 失败原因透传：onResult summary → timeline content + 失败通知 body 含真实原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-engine-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new KanbanStore({ userDataPath: dir });
  cleanup.push(() => store.dispose());
  const board = store.createBoard('b', DEFAULT_COLUMNS.map((c) => ({ ...c })));
  const t = makeTask(store, board.id);
  const emitted: NotifInput[] = [];
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new FailWithSummaryProvider('真实失败原因XYZ：工作目录不存在'),
    emitNotif: (n) => emitted.push(n),
  });
  cleanup.push(() => engine.dispose());
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'failed');
  // timeline 失败 system 事件含真实原因
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  const failSys = rec.timeline.find((x) => x.type === 'system' && x.content.includes('真实失败原因XYZ'));
  ok(failSys, `timeline 失败事件含真实原因（实际 system 事件：${JSON.stringify(rec.timeline.filter((x) => x.type === 'system').map((x) => x.content))}）`);
  // 失败通知 body 含真实原因
  const notif = emitted.find((n) => n.severity === 'error' && n.link.kind === 'task' && n.link.taskId === t.id);
  ok(notif, '发出失败通知');
  ok(notif!.body.includes('真实失败原因XYZ'), `通知 body 含真实原因（实际 body：${notif!.body}）`);
});

test('Q-020 失败 summary 为空 → timeline/通知行为与现状一致（不含 summary 段）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-engine-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new KanbanStore({ userDataPath: dir });
  cleanup.push(() => store.dispose());
  const board = store.createBoard('b', DEFAULT_COLUMNS.map((c) => ({ ...c })));
  const t = makeTask(store, board.id);
  const emitted: NotifInput[] = [];
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new FailWithSummaryProvider(''),
    emitNotif: (n) => emitted.push(n),
  });
  cleanup.push(() => engine.dispose());
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'failed');
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  ok(rec.timeline.some((x) => x.type === 'system' && x.content.includes('selfCheck.passed=false（Q-015）')), '保留 Q-015 判定文案');
  equal(rec.timeline.some((x) => x.type === 'system' && x.content.includes('：：')), false, '无空 summary 拼接残留');
  const notif = emitted.find((n) => n.severity === 'error' && n.link.kind === 'task' && n.link.taskId === t.id);
  ok(notif, '仍发出失败通知');
  ok(notif!.body.length > 0, 'body 非空（现状文案）');
});

// ─────────────────── Q-017 壳重启 queued 重排（重启后重新调度） ───────────────────
test('Q-017 壳重启重排：store 残留 queued 任务 → engine.start() → 重新入队并被执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-engine-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new KanbanStore({ userDataPath: dir });
  cleanup.push(() => store.dispose());
  const board = store.createBoard('b', DEFAULT_COLUMNS.map((c) => ({ ...c })));
  const a = store.createTask(board.id, { title: '重启残留 queued', acceptanceCriteria: { what: 'w', expected: 'e', verify: 'v' } });
  // 直写 raw 内部态（模拟壳重启残留：queued 持久化，调度器内存队列已随进程消失）
  const rawBoard = (store as unknown as { data: { boards: Array<{ id: string; tasks: Array<{ id: string; executionStatus: string }> }> } }).data.boards.find((b) => b.id === board.id)!;
  rawBoard.tasks.find((x) => x.id === a.id)!.executionStatus = 'queued';
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new MockProvider({ delayMs: 5 }),
  });
  cleanup.push(() => engine.dispose());
  engine.start(); // 收敛 + 重排：queued 重新入队 + kick drain
  await waitFor(() => status(store, board.id, a.id) === 'succeeded', 3000);
  equal(status(store, board.id, a.id), 'succeeded', '残留 queued 任务重启后被执行（不再永久卡「排队中」）');
});

test('Q-017 重启重排：auto 缺 AC 的残留 queued → failed（不抛错不卡死）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-engine-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new KanbanStore({ userDataPath: dir });
  cleanup.push(() => store.dispose());
  const board = store.createBoard('b', DEFAULT_COLUMNS.map((c) => ({ ...c })));
  const a = store.createTask(board.id, { title: '缺 AC 残留', executionMode: 'auto', acceptanceCriteria: { what: 'w', expected: 'e', verify: 'v' } });
  const rawBoard = (store as unknown as { data: { boards: Array<{ id: string; tasks: Array<{ id: string; executionStatus: string; acceptanceCriteria: unknown; timeline: Array<{ type: string; content: string }> }> }> } }).data.boards.find((b) => b.id === board.id)!;
  const rawTask = rawBoard.tasks.find((x) => x.id === a.id)!;
  rawTask.executionStatus = 'queued';
  rawTask.acceptanceCriteria = null;
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new MockProvider({ delayMs: 5 }),
  });
  cleanup.push(() => engine.dispose());
  engine.start();
  equal(status(store, board.id, a.id), 'failed', '缺 AC 的残留 queued 转 failed（E2 语义）');
  ok(rawTask.timeline.some((x) => x.type === 'system' && x.content.includes('验收标准')), 'timeline 有缺 AC 失败 system 事件');
});

// ─────────────────── Q-022 会话复用：结算回写 task.acpSessionId ───────────────────

/** Q-022：onResult 带 sessionId 的 provider（复现 ACPProvider 会话建立后回传形态） */
class SessionProvider implements ExecutionProvider {
  constructor(
    private readonly sessionId: string,
    private readonly selfCheck: { passed: boolean } | undefined,
  ) {}
  execute(task: ExecutionTask, handlers: ExecutionHandlers): { cancel(): Promise<void> } {
    if (this.selfCheck) handlers.onStatus('failed');
    else handlers.onStatus('succeeded');
    handlers.onResult(
      this.selfCheck
        ? { exitCode: 1, summary: '失败但会话已建立', outputPath: '', selfCheck: this.selfCheck, sessionId: this.sessionId }
        : { exitCode: 0, summary: '', outputPath: '', sessionId: this.sessionId },
    );
    return { cancel: async () => {} };
  }
}

test('Q-022 成功结算 → task.acpSessionId 回写（重跑续用会话）', async () => {
  const { store, board, engine } = makeEnv(undefined, 5);
  const t = makeTask(store, board.id);
  const engine2 = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new SessionProvider('sess-success-1', undefined),
  });
  cleanup.push(() => engine2.dispose());
  engine2.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  equal(rec.acpSessionId, 'sess-success-1', '成功结算回写 acpSessionId');
});

test('Q-022 失败结算也回写 acpSessionId（重跑续用，agent 看得到上次失败上下文）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-engine-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new KanbanStore({ userDataPath: dir });
  cleanup.push(() => store.dispose());
  const board = store.createBoard('b', DEFAULT_COLUMNS.map((c) => ({ ...c })));
  const t = makeTask(store, board.id);
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new SessionProvider('sess-fail-1', { passed: false }),
  });
  cleanup.push(() => engine.dispose());
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'failed');
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  equal(rec.acpSessionId, 'sess-fail-1', '失败结算同样回写 acpSessionId');
});

test('Q-022 onResult 不带 sessionId → acpSessionId 不写（保持 undefined）', async () => {
  const { store, board, engine } = makeEnv(undefined, 5);
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  equal(rec.acpSessionId, undefined, '无 sessionId 不写');
});

// ── Q-回复落盘（2026-09-05）：流式回复持久化 kanban/executions/e_<id>.log ──

test('Q-回复落盘：text_chunk 流写入执行日志（executionsDir 注入）', async () => {
  const { store, board, engine } = makeEnv({ kind: 'stream', chunks: ['你好', '，世界'] }, 5, undefined, true);
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  const execItem = rec.timeline.find((x) => x.type === 'execution' && x.execution?.outputPath);
  ok(execItem, '有 execution 记录（含 outputPath）');
  // outputPath 相对 userData 根（getDataDir() 返回 <userData>/kanban 层，故回退一级）
  const logPath = join(store.getDataDir(), '..', execItem!.execution!.outputPath!);
  const content = readFileSync(logPath, 'utf8');
  ok(content.includes('你好') && content.includes('，世界'), '流文本完整落盘');
});

test('Q-回复落盘：失败执行日志尾部含 provider 错误 summary', async () => {
  const { store, board, engine } = makeEnv(undefined, 0, undefined, true, new FailSummaryProvider());
  const t = makeTask(store, board.id);
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'failed');
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  const execItem = rec.timeline.find((x) => x.type === 'execution' && x.execution?.outputPath);
  ok(execItem, '失败同样有 execution 记录');
  // outputPath 相对 userData 根（getDataDir() 返回 <userData>/kanban 层，故回退一级）
  const content = readFileSync(join(store.getDataDir(), '..', execItem!.execution!.outputPath!), 'utf8');
  ok(content.includes('部分流式输出'), '失败前流文本已落盘');
  ok(content.includes('[失败]') && content.includes('模型 400'), '错误 summary 追加日志尾部');
});

/** Q-回复落盘测试桩：先流式输出，再以 selfCheck=false + summary 失败结算（引擎不改动 provider 侧） */
class FailSummaryProvider implements ExecutionProvider {
  execute(task: ExecutionTask, handlers: ExecutionHandlers): { cancel(): Promise<void> } {
    handlers.onStatus('running');
    setTimeout(() => {
      handlers.onEvent({ kind: 'text_chunk', text: '部分流式输出' });
      handlers.onResult({ exitCode: 1, summary: '模型 400：off 不支持', outputPath: '', selfCheck: { passed: false } });
      handlers.onStatus('failed');
    }, 5);
    return { cancel: async () => {} };
  }
}
// ─────────────────── Q-025 resume 失败：损坏会话引用清理 ───────────────────

/** Q-025：可配置 onResult 载荷的 provider（resume 失败场景驱动） */
class ResumeFailProvider implements ExecutionProvider {
  constructor(private readonly payload: ExecutionResult) {}
  execute(task: ExecutionTask, handlers: ExecutionHandlers): { cancel(): Promise<void> } {
    handlers.onStatus('succeeded');
    handlers.onResult(this.payload);
    return { cancel: async () => {} };
  }
}

test('Q-025 resumeFailed + 新 sessionId → 覆盖损坏引用（正常降级路径）', async () => {
  const { store, board } = makeEnv(undefined, 5);
  const t = makeTask(store, board.id);
  const raw = (store as unknown as { data: { boards: Array<{ id: string; tasks: Array<{ id: string; acpSessionId?: string }> }> } }).data.boards.find((b) => b.id === board.id)!;
  raw.tasks.find((x) => x.id === t.id)!.acpSessionId = 'sess-corrupt';
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new ResumeFailProvider({ exitCode: 0, summary: '', outputPath: '', sessionId: 'sess-fresh', resumeFailed: true }),
  });
  cleanup.push(() => engine.dispose());
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  equal(raw.tasks.find((x) => x.id === t.id)!.acpSessionId, 'sess-fresh', '损坏 id 被新 id 覆盖');
});

test('Q-025 resumeFailed + 无 sessionId（降级 new 也失败）→ acpSessionId 清空（下次不再白试坏 id）', async () => {
  const { store, board } = makeEnv(undefined, 5);
  const t = makeTask(store, board.id);
  const raw = (store as unknown as { data: { boards: Array<{ id: string; tasks: Array<{ id: string; acpSessionId?: string }> }> } }).data.boards.find((b) => b.id === board.id)!;
  raw.tasks.find((x) => x.id === t.id)!.acpSessionId = 'sess-corrupt';
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new ResumeFailProvider({ exitCode: 1, summary: 'dsh ACP 通道异常', outputPath: '', selfCheck: { passed: false }, resumeFailed: true }),
  });
  cleanup.push(() => engine.dispose());
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'failed');
  equal(raw.tasks.find((x) => x.id === t.id)!.acpSessionId, undefined, '损坏引用被清空（下次执行走 session/new）');
});

test('Q-025 无 resumeFailed + 无 sessionId → acpSessionId 不动（cwd mismatch 等保留语义）', async () => {
  const { store, board } = makeEnv(undefined, 5);
  const t = makeTask(store, board.id);
  const raw = (store as unknown as { data: { boards: Array<{ id: string; tasks: Array<{ id: string; acpSessionId?: string }> }> } }).data.boards.find((b) => b.id === board.id)!;
  raw.tasks.find((x) => x.id === t.id)!.acpSessionId = 'sess-prev';
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new ResumeFailProvider({ exitCode: 1, summary: '通道异常', outputPath: '', selfCheck: { passed: false } }),
  });
  cleanup.push(() => engine.dispose());
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'failed');
  equal(raw.tasks.find((x) => x.id === t.id)!.acpSessionId, 'sess-prev', '引用保留（mismatch 场景下次仍可尝试）');
});

// ─────────────────── Q-026 agent 执行结果 comment 标记（source.type='agent'） ───────────────────

test('Q-026 manual 执行结果回填 comment → source.type=agent（不可经 user 评论通道改删）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-engine-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new KanbanStore({ userDataPath: dir });
  cleanup.push(() => store.dispose());
  const board = store.createBoard('b', DEFAULT_COLUMNS.map((c) => ({ ...c })));
  const t = makeTask(store, board.id);
  const engine = new ExecutionEngine({
    store,
    providerManager: new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } }),
    provider: new NoSelfCheckProvider(),
  });
  cleanup.push(() => engine.dispose());
  engine.executeTask(board.id, t.id);
  await waitFor(() => status(store, board.id, t.id) === 'succeeded');
  const rec = store.getBoard(board.id).tasks.find((x) => x.id === t.id)!;
  const resultComment = rec.timeline.filter((x) => x.type === 'comment' && x.content.startsWith('执行结果：')).pop();
  ok(resultComment, '有执行结果回填 comment');
  equal(resultComment!.source.type, 'agent', 'source.type=agent（此前 user 与用户评论无法区分）');
});
