/**
 * L2 Convergence 单测（B3 design §4.4，Q-017 冻结）
 *
 * - 壳重启收敛：running/paused/interrupted → failed（"壳重启进程中断"）+ 补 finishedAt +
 *   清 currentExecutionId + system 事件（markFailed 语义）
 * - queued → 重跑就绪检查：依赖已收敛 failed → 转 failed（"依赖失败"）；仍满足 → 保留重调度
 * - 全量收敛后统一依赖重算（recomputeDeps 标志）
 * - 幂等：重复收敛对已 failed/succeeded 任务无操作
 */
import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';

import { Convergence, type ConvergenceMutations } from './Convergence';
import type { Board, ExecutionStatus, Task } from '../kanban/types';

const NOW = '2026-08-21T00:00:00.000Z';

function makeTask(partial: Partial<Task>): Task {
  return {
    id: 't_1',
    parentId: null,
    columnId: 'c_todo',
    title: 't',
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
    order: 0,
    blockedFromColumnId: null,
    archivedAt: null,
    archivedFromColumnId: null,
    createdAt: NOW,
    updatedAt: NOW,
    timeline: [],
    ...partial,
  };
}

function makeBoard(tasks: Task[]): Board {
  return {
    id: 'b_1',
    name: 'b',
    columns: [],
    tasks,
    order: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** 造收敛器：注入内存读面 + 记录 mutation 调用 */
function make(tasks: Task[]) {
  const boards: Board[] = [makeBoard(tasks)];
  const store = { getBoards: () => boards.map((b) => ({ ...b, tasks: b.tasks.map((t) => ({ ...t })) })) };
  const calls: { method: string; taskId: string; arg2?: string; arg3?: string }[] = [];
  const mutations: ConvergenceMutations = {
    markFailed: (taskId, reason, detail) => calls.push({ method: 'markFailed', taskId, arg2: reason, arg3: detail }),
    keepQueued: (taskId) => calls.push({ method: 'keepQueued', taskId }),
  };
  return { conv: new Convergence(store, mutations), calls };
}

test('E18 running/paused/interrupted → failed（壳重启进程中断）+ 补 finishedAt + 清 currentExecutionId + system 事件', () => {
  const tasks = [
    makeTask({ id: 't_run', executionStatus: 'running', currentExecutionId: 'e_1' }),
    makeTask({ id: 't_pause', executionStatus: 'paused', currentExecutionId: 'e_2' }),
    makeTask({ id: 't_int', executionStatus: 'interrupted', currentExecutionId: 'e_3' }),
  ];
  const { conv, calls } = make(tasks);
  const report = conv.run();
  deepEqual(report.failed.sort(), ['t_int', 't_pause', 't_run'].sort());
  equal(calls.length, 3);
  for (const c of calls) {
    equal(c.method, 'markFailed');
    equal(c.arg2, '壳重启进程中断', '收敛原因=壳重启进程中断');
  }
  equal(report.requeued.length, 0);
  equal(report.recomputeDeps, true);
});

test('E19 queued 依赖已收敛 failed → failed（依赖失败）', () => {
  const tasks = [
    makeTask({ id: 't_dep', executionStatus: 'failed' }),
    makeTask({ id: 't_q', executionStatus: 'queued', dependencies: ['t_dep'] }),
  ];
  const { conv, calls } = make(tasks);
  const report = conv.run();
  deepEqual(report.failed, ['t_q']);
  equal(calls[0].method, 'markFailed');
  equal(calls[0].arg2, '依赖失败');
});

test('E19 queued 依赖仍满足 → 保留重调度 + system 事件"已重新排队"（keepQueued）', () => {
  const tasks = [
    makeTask({ id: 't_dep', executionStatus: 'succeeded' }),
    makeTask({ id: 't_q', executionStatus: 'queued', dependencies: ['t_dep'] }),
  ];
  const { conv, calls } = make(tasks);
  const report = conv.run();
  deepEqual(report.requeued, ['t_q']);
  equal(calls[0].method, 'keepQueued');
  equal(report.failed.length, 0);
  equal(report.recomputeDeps, true);
});

test('queued 无依赖 → 保留重调度', () => {
  const { conv, calls } = make([makeTask({ id: 't_q', executionStatus: 'queued' })]);
  const report = conv.run();
  deepEqual(report.requeued, ['t_q']);
  equal(calls[0].method, 'keepQueued');
});

test('幂等：已 failed/succeeded 任务收敛无操作；idle/cancelled 非收敛面跳过', () => {
  const tasks = [
    makeTask({ id: 't_f', executionStatus: 'failed' }),
    makeTask({ id: 't_s', executionStatus: 'succeeded' }),
    makeTask({ id: 't_idle', executionStatus: 'idle' }),
    makeTask({ id: 't_c', executionStatus: 'cancelled' }),
  ];
  const { conv, calls } = make(tasks);
  const report = conv.run();
  equal(report.failed.length, 0);
  equal(report.requeued.length, 0);
  equal(report.recomputeDeps, false);
  equal(calls.length, 0);
});

test('全量收敛后统一依赖重算：仅有 failed 时 recomputeDeps=true；无收敛动作时 false', () => {
  const a = make([makeTask({ id: 't_run', executionStatus: 'running' })]);
  equal(a.conv.run().recomputeDeps, true, '有收敛动作 → 触发重算');
  const b = make([makeTask({ id: 't_f', executionStatus: 'failed' }), makeTask({ id: 't_s', executionStatus: 'succeeded' })]);
  equal(b.conv.run().recomputeDeps, false, '全收敛面已稳定 → 无重算');
});

test('依赖判据：succeeded 满足；failed 阻断；缺失依赖不阻断（保守保留重排）', () => {
  const ok = make([
    makeTask({ id: 't_dep_s', executionStatus: 'succeeded' }),
    makeTask({ id: 't_q1', executionStatus: 'queued', dependencies: ['t_dep_s'] }),
    makeTask({ id: 't_q2', executionStatus: 'queued', dependencies: ['t_missing'] }),
  ]);
  equal(ok.conv.run().failed.length, 0);
  deepEqual(ok.conv.run().requeued.sort(), ['t_q1', 't_q2'].sort());

  const blocked = make([
    makeTask({ id: 't_dep_f', executionStatus: 'failed' }),
    makeTask({ id: 't_q3', executionStatus: 'queued', dependencies: ['t_dep_f'] }),
  ]);
  deepEqual(blocked.conv.run().failed, ['t_q3']);
});
