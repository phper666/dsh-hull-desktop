/**
 * L2 AcEditor 单测（B4 design §4.5 / 契约 §3，CON-R021/Q-022）——full 实现
 *
 * - 非 running → B1 updateTask 普通编辑（无中断/diff）
 * - running → 终止 ACP + interrupted + 旧 partial 标废弃 + AC diff 留痕 + 新 AC 生效
 * - 竞态：终止前复核仍 running（已完成任务不被误中断）
 * - AC 缺必填 → validation-error（不落盘不中断）
 */
import { test } from 'node:test';
import { deepEqual, equal, rejects } from 'node:assert/strict';

import { AcEditor, type AcceptanceCriteriaInput } from './AcEditor';
import { ExecNotRunningError, ExecValidationError } from '../errors';

interface HarnessState {
  status: string;
  executionId: string | null;
  oldAc: AcceptanceCriteriaInput | null;
}

function makeHarness(init: Partial<HarnessState> = {}) {
  const state: HarnessState = {
    status: 'idle',
    executionId: 'e_old',
    oldAc: { what: '旧w', expected: '旧e', verify: '旧v' },
    ...init,
  };
  const calls = {
    updated: [] as Array<{ boardId: string; taskId: string; ac: AcceptanceCriteriaInput }>,
    cancelled: [] as Array<{ boardId: string; taskId: string }>,
    interrupted: [] as Array<{ boardId: string; taskId: string }>,
    deprecated: [] as Array<{ boardId: string; taskId: string; executionId: string }>,
    timeline: [] as Array<{ boardId: string; taskId: string; content: string }>,
  };

  const editor = new AcEditor({
    readStore: {
      getExecutionStatus: () => state.status,
      getCurrentExecutionId: () => state.executionId,
      getAcceptanceCriteria: () => state.oldAc,
    },
    mutations: { updateAcceptanceCriteria: (boardId, taskId, ac) => calls.updated.push({ boardId, taskId, ac }) },
    executionBridge: {
      cancelExecution: async (boardId, taskId) => {
        calls.cancelled.push({ boardId, taskId });
      },
      markInterrupted: (boardId, taskId) => calls.interrupted.push({ boardId, taskId }),
      markExecutionDeprecated: (boardId, taskId, executionId) =>
        calls.deprecated.push({ boardId, taskId, executionId }),
    },
    timelineStore: { appendSystemEvent: (boardId, taskId, content) => calls.timeline.push({ boardId, taskId, content }) },
  });

  return { editor, calls, setStatus: (s: string) => (state.status = s) };
}

const AC_NEW: AcceptanceCriteriaInput = { what: '新w', expected: '新e', verify: '新v' };

test('非 running → B1 updateTask 普通编辑（无中断/diff）', async () => {
  const h = makeHarness({ status: 'succeeded' });
  const r = await h.editor.editAcceptanceCriteria('b_1', 't_1', AC_NEW);
  deepEqual(r, { taskId: 't_1', executionStatus: 'updated', previousExecutionId: null });
  equal(h.calls.updated.length, 1);
  deepEqual(h.calls.updated[0].ac, AC_NEW);
  equal(h.calls.cancelled.length, 0, '不中断');
  equal(h.calls.timeline.length, 0, '无 diff 留痕要求');
});

test('running → 终止 ACP + interrupted + 旧 partial 标废弃 + AC diff 留痕 + 新 AC 生效', async () => {
  const h = makeHarness({ status: 'running', executionId: 'e_old' });
  const r = await h.editor.editAcceptanceCriteria('b_1', 't_1', AC_NEW);
  deepEqual(r, { taskId: 't_1', executionStatus: 'interrupted', previousExecutionId: 'e_old' });
  // 终止进程
  deepEqual(h.calls.cancelled, [{ boardId: 'b_1', taskId: 't_1' }]);
  // interrupted + 旧 partial 废弃
  deepEqual(h.calls.interrupted, [{ boardId: 'b_1', taskId: 't_1' }]);
  deepEqual(h.calls.deprecated, [{ boardId: 'b_1', taskId: 't_1', executionId: 'e_old' }]);
  // diff 留痕（system 事件，CON-R021：变更前后对照）
  equal(h.calls.timeline.length, 1);
  ok(h.calls.timeline[0].content.includes('AC 修订'), 'diff system 事件含 AC 修订');
  ok(h.calls.timeline[0].content.includes('what: 旧w → 新w'), 'what 对照');
  ok(h.calls.timeline[0].content.includes('expected: 旧e → 新e'), 'expected 对照');
  ok(h.calls.timeline[0].content.includes('verify: 旧v → 新v'), 'verify 对照');
  // 新 AC 落字段（B1 updateTask）
  deepEqual(h.calls.updated, [{ boardId: 'b_1', taskId: 't_1', ac: AC_NEW }]);
});

test('running 无当前执行记录（executionId null）→ 无 partial 废弃，仍中断+diff+落字段', async () => {
  const h = makeHarness({ status: 'running', executionId: null });
  const r = await h.editor.editAcceptanceCriteria('b_1', 't_1', AC_NEW);
  deepEqual(r, { taskId: 't_1', executionStatus: 'interrupted', previousExecutionId: null });
  equal(h.calls.deprecated.length, 0, '无记录不标废弃');
  equal(h.calls.interrupted.length, 1);
  equal(h.calls.timeline.length, 1);
  equal(h.calls.updated.length, 1);
});

test('竞态：终止前复核非 running（已完成）→ exec-not-running，不中断不落盘', async () => {
  // 首次读 running，复核时已 succeeded（模拟执行完成竞态窗口）
  let reads = 0;
  const calls = { cancelled: 0, interrupted: 0, deprecated: 0, timeline: 0, updated: 0 };
  const editor = new AcEditor({
    readStore: {
      getExecutionStatus: () => (reads++ === 0 ? 'running' : 'succeeded'),
      getCurrentExecutionId: () => 'e_old',
      getAcceptanceCriteria: () => ({ what: 'w', expected: 'e', verify: 'v' }),
    },
    mutations: { updateAcceptanceCriteria: () => calls.updated++ },
    executionBridge: {
      cancelExecution: async () => {
        calls.cancelled++;
      },
      markInterrupted: () => calls.interrupted++,
      markExecutionDeprecated: () => calls.deprecated++,
    },
    timelineStore: { appendSystemEvent: () => calls.timeline++ },
  });
  await rejects(
    () => editor.editAcceptanceCriteria('b_1', 't_1', AC_NEW),
    (err: unknown) => err instanceof ExecNotRunningError && err.currentStatus === 'succeeded',
  );
  equal(calls.cancelled, 0, '复核不过不终止进程');
  equal(calls.interrupted, 0, '不写 interrupted');
  equal(calls.deprecated, 0, '不标废弃');
  equal(calls.timeline, 0, '不写 diff');
  equal(calls.updated, 0, '不落新 AC');
});

test('AC 缺必填 → validation-error（field 精确；不中断不落盘）', async () => {
  const h = makeHarness({ status: 'running' });
  await rejects(
    () => h.editor.editAcceptanceCriteria('b_1', 't_1', { what: 'w', expected: 'e', verify: '' }),
    (err: unknown) => err instanceof ExecValidationError && err.field === 'verify',
  );
  await rejects(
    () => h.editor.editAcceptanceCriteria('b_1', 't_1', { what: '', expected: 'e', verify: 'v' }),
    (err: unknown) => err instanceof ExecValidationError && err.field === 'what',
  );
  equal(h.calls.cancelled.length, 0, '校验失败不中断');
  equal(h.calls.updated.length, 0, '校验失败不落盘');
});

test('diff：仅列变化字段（context 无变化不出现）', async () => {
  const h = makeHarness({ status: 'running', oldAc: { what: 'w', expected: 'e', verify: 'v', context: 'c' } });
  await h.editor.editAcceptanceCriteria('b_1', 't_1', { ...AC_NEW, context: 'c' });
  const content = h.calls.timeline[0].content;
  ok(!content.includes('context'), 'context 未变不出现');
  ok(content.includes('what'), 'what 变化出现');
});

function ok(cond: unknown, msg?: string): void {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}
