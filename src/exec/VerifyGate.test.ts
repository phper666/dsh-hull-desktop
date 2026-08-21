/**
 * L2 VerifyGate 单测（B3 design §4.5/§4.7，CON-R028/Q-015 冻结）
 *
 * - confirmVerify（§4.5）：verify 列 → done 列；executionStatus 保持 succeeded（双轨）；
 *   非 verify 列 → validation-error；幂等：已 done 结果一致返回
 * - manualComplete（契约 §5）：interrupted/failed → succeeded + 列→verify（把关不绕过）；
 *   非 interrupted/failed → exec-not-completable；幂等：succeeded 结果一致返回
 * - applyResult / selfCheck（§4.7 Q-015）：passed=true → succeeded + verify；passed=false →
 *   failed；manual（无 selfCheck）→ 评论回填 + 列不自动推进
 */
import { test } from 'node:test';
import { deepEqual, equal, throws } from 'node:assert/strict';

import { VerifyGate, type VerifyGateMutations, type VerifyGateResult } from './VerifyGate';
import { ExecNotCompletableError, ExecValidationError } from './errors';
import type { Board, Task } from '../kanban/types';

const NOW = '2026-08-21T00:00:00.000Z';
const B_ID = 'b_1';
const C_VERIFY = 'c_verify';
const C_DONE = 'c_done';

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
    id: B_ID,
    name: 'b',
    columns: [
      { id: C_VERIFY, type: 'verify', name: 'Verify', order: 3, color: '#a371f7', hidden: false },
      { id: C_DONE, type: 'done', name: 'Done', order: 4, color: '#3fb950', hidden: false },
    ],
    tasks,
    order: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** 造 VerifyGate：注入内存读面（克隆保持外部不可变）+ 记录 mutation 调用 */
function make(tasks: Task[]) {
  const boards = new Map<string, Board>([[B_ID, makeBoard(tasks)]]);
  const store = {
    getBoard: (boardId: string) => {
      const b = boards.get(boardId);
      if (!b) throw new ExecValidationError('看板不存在（已删除）', 'boardId');
      return { ...b, tasks: b.tasks.map((t) => ({ ...t })) };
    },
  };
  const calls: { method: string; taskId: string; arg2?: string; arg3?: string }[] = [];
  const mutations: VerifyGateMutations = {
    markSucceeded: (taskId, reason, detail) => calls.push({ method: 'markSucceeded', taskId, arg2: reason, arg3: detail }),
    markFailed: (taskId, reason, detail) => calls.push({ method: 'markFailed', taskId, arg2: reason, arg3: detail }),
    moveToColumn: (taskId, columnId) => calls.push({ method: 'moveToColumn', taskId, arg2: columnId }),
    fillManualResult: (taskId, summary) => calls.push({ method: 'fillManualResult', taskId, arg2: summary }),
  };
  return { gate: new VerifyGate(store, mutations), calls };
}

test('confirmVerify：verify 列 → done 列；executionStatus 保持 succeeded（双轨不改执行态）', () => {
  const { gate, calls } = make([makeTask({ id: 't_1', columnId: C_VERIFY, executionStatus: 'succeeded' })]);
  const out = gate.confirmVerify(B_ID, 't_1');
  deepEqual(out, { taskId: 't_1', executionStatus: 'succeeded', columnId: C_DONE });
  deepEqual(calls, [{ method: 'moveToColumn', taskId: 't_1', arg2: C_DONE }], '仅列流转，不改执行态');
});

test('confirmVerify：非 verify 列 → validation-error（CON-R028 把关不绕过）', () => {
  const { gate, calls } = make([makeTask({ id: 't_1', columnId: 'c_todo', executionStatus: 'succeeded' })]);
  throws(() => gate.confirmVerify(B_ID, 't_1'), ExecValidationError);
  equal(calls.length, 0);
});

test('confirmVerify：幂等——已 done 列结果一致返回，无 mutation', () => {
  const { gate, calls } = make([makeTask({ id: 't_1', columnId: C_DONE, executionStatus: 'succeeded' })]);
  const out = gate.confirmVerify(B_ID, 't_1');
  deepEqual(out, { taskId: 't_1', executionStatus: 'succeeded', columnId: C_DONE });
  equal(calls.length, 0);
});

test('manualComplete：interrupted → succeeded + 列→verify（两选一②，仍走把关）', () => {
  const { gate, calls } = make([makeTask({ id: 't_1', executionStatus: 'interrupted', columnId: 'c_in_progress' })]);
  const out = gate.manualComplete(B_ID, 't_1');
  deepEqual(out, { taskId: 't_1', executionStatus: 'succeeded', columnId: C_VERIFY });
  deepEqual(calls, [
    { method: 'markSucceeded', taskId: 't_1', arg2: '手动完成', arg3: 'manualComplete（CON-R028 把关不绕过）' },
    { method: 'moveToColumn', taskId: 't_1', arg2: C_VERIFY },
  ]);
});

test('manualComplete：failed → succeeded + 列→verify（E8 手动完成）', () => {
  const { gate, calls } = make([makeTask({ id: 't_1', executionStatus: 'failed', columnId: 'c_in_progress' })]);
  const out = gate.manualComplete(B_ID, 't_1');
  deepEqual(out, { taskId: 't_1', executionStatus: 'succeeded', columnId: C_VERIFY });
  equal(calls.length, 2);
});

test('manualComplete：running/queued/idle → exec-not-completable（exec-not-completable）', () => {
  for (const st of ['running', 'queued', 'idle'] as const) {
    const { gate } = make([makeTask({ id: 't_1', executionStatus: st })]);
    throws(() => gate.manualComplete(B_ID, 't_1'), ExecNotCompletableError, `${st} 不可手动完成`);
  }
});

test('manualComplete：幂等——succeeded 再手动完成结果一致，无 mutation', () => {
  const { gate, calls } = make([makeTask({ id: 't_1', executionStatus: 'succeeded', columnId: C_VERIFY })]);
  const out = gate.manualComplete(B_ID, 't_1');
  deepEqual(out, { taskId: 't_1', executionStatus: 'succeeded', columnId: C_VERIFY });
  equal(calls.length, 0);
});

test('selfCheck passed=true → succeeded + 列→verify（自动流转 CON-R029，E11）', () => {
  const { gate, calls } = make([makeTask({ id: 't_1', executionStatus: 'running', columnId: 'c_in_progress' })]);
  const out = gate.applyResult(B_ID, 't_1', { exitCode: 0, summary: 'ok', outputPath: '', selfCheck: { passed: true, evidence: 'ev' } });
  deepEqual(out, { taskId: 't_1', executionStatus: 'succeeded', columnId: C_VERIFY });
  deepEqual(calls, [
    { method: 'markSucceeded', taskId: 't_1', arg2: '自验通过', arg3: 'selfCheck.passed=true（CON-R029 自动流转）' },
    { method: 'moveToColumn', taskId: 't_1', arg2: C_VERIFY },
  ]);
});

test('selfCheck passed=false → failed（E12，Q-015）', () => {
  const { gate, calls } = make([makeTask({ id: 't_1', executionStatus: 'running', columnId: 'c_in_progress' })]);
  const out = gate.applyResult(B_ID, 't_1', { exitCode: 0, summary: 'bad', outputPath: '', selfCheck: { passed: false } });
  deepEqual(out, { taskId: 't_1', executionStatus: 'failed', columnId: 'c_in_progress' });
  deepEqual(calls, [{ method: 'markFailed', taskId: 't_1', arg2: '自验未通过', arg3: 'selfCheck.passed=false（Q-015）' }]);
});

test('selfCheck passed=false + exitCode!=0（超时/通道异常）→ failed（回写 failed 记录）', () => {
  const { gate, calls } = make([makeTask({ id: 't_1', executionStatus: 'running', columnId: 'c_in_progress' })]);
  const out = gate.applyResult(B_ID, 't_1', { exitCode: 1, summary: 'timeout', outputPath: '', selfCheck: { passed: false } });
  deepEqual(out, { taskId: 't_1', executionStatus: 'failed', columnId: 'c_in_progress' });
  deepEqual(calls, [{ method: 'markFailed', taskId: 't_1', arg2: '执行失败', arg3: 'selfCheck.passed=false（Q-015）' }]);
});

test('manual（无 selfCheck）→ 结果评论回填 + 执行态 succeeded + 列不自动推进（CON-R029，E27；🟡-1 结算 succeeded）', () => {
  const { gate, calls } = make([makeTask({ id: 't_1', executionStatus: 'running', columnId: 'c_in_progress' })]);
  const out = gate.applyResult(B_ID, 't_1', { exitCode: 0, summary: 'manual ok', outputPath: '' });
  deepEqual(out, { taskId: 't_1', executionStatus: 'succeeded', columnId: 'c_in_progress' }, '结算 succeeded，列不变（不自动推进）');
  deepEqual(calls, [
    { method: 'fillManualResult', taskId: 't_1', arg2: 'manual ok' },
    { method: 'markSucceeded', taskId: 't_1', arg2: '执行完成', arg3: 'manual 结果回填（CON-R029 列不自动推进）' },
  ]);
});

test('任务不存在 → validation-error（exec-not-found 语义在 L3 引擎层拦截）', () => {
  const { gate } = make([]);
  throws(() => gate.confirmVerify(B_ID, 't_missing'), ExecValidationError);
  throws(() => gate.manualComplete(B_ID, 't_missing'), ExecValidationError);
  throws(() => gate.applyResult(B_ID, 't_missing', { exitCode: 0, summary: '', outputPath: '' }), ExecValidationError);
});
