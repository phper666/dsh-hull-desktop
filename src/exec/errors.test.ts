/**
 * L1 B3 执行引擎具名错误集单测（errors.ts）
 * 对齐 B1 HullError 风格：KANBAN_EXEC_ERROR 码 + 具名子类 + 附带字段（taskId/currentStatus/requestId/field）
 */
import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import {
  ExecApprovalNotPendingError,
  ExecNotCancellableError,
  ExecNotCompletableError,
  ExecNotFoundError,
  ExecNotPausedError,
  ExecNotRunningError,
  ExecProviderUnavailableError,
  ExecStateConflictError,
  ExecTimeoutHeartbeatError,
  ExecValidationError,
  KANBAN_EXEC_ERRORS,
} from './errors';

test('KANBAN_EXEC_ERRORS 码集：10 码 kebab 命名', () => {
  const codes = Object.values(KANBAN_EXEC_ERRORS);
  equal(codes.length, 10);
  for (const c of codes) ok(/^[a-z]+(-[a-z0-9]+)*$/.test(c), `kebab 命名: ${c}`);
  // 关键码对齐契约 §公共异常集
  equal(KANBAN_EXEC_ERRORS.stateConflict, 'exec-state-conflict');
  equal(KANBAN_EXEC_ERRORS.notRunning, 'exec-not-running');
  equal(KANBAN_EXEC_ERRORS.notPaused, 'exec-not-paused');
  equal(KANBAN_EXEC_ERRORS.notCompletable, 'exec-not-completable');
  equal(KANBAN_EXEC_ERRORS.timeoutHeartbeat, 'exec-timeout-heartbeat');
  equal(KANBAN_EXEC_ERRORS.validation, 'validation-error');
});

test('具名错误：HullError 基类 + code 正确 + 附带字段', () => {
  // 状态冲突附带 taskId + currentStatus（契约响应字段要求）
  const conflict = new ExecStateConflictError('执行中重复触发', 't_1', 'running');
  ok(conflict instanceof Error);
  equal(conflict.code, 'exec-state-conflict');
  equal(conflict.taskId, 't_1');
  equal(conflict.currentStatus, 'running');
  equal(conflict.name, 'ExecStateConflictError');

  const notRunning = new ExecNotRunningError('非 running 不可暂停', 'queued');
  equal(notRunning.code, 'exec-not-running');
  equal(notRunning.currentStatus, 'queued');

  const approval = new ExecApprovalNotPendingError('审批已处理', 'req_1');
  equal(approval.code, 'exec-approval-not-pending');
  equal(approval.requestId, 'req_1');

  const validation = new ExecValidationError('auto 缺 AC 必填项', 'acceptanceCriteria');
  equal(validation.code, 'validation-error');
  equal(validation.field, 'acceptanceCriteria');

  equal(new ExecNotFoundError('任务不存在').code, 'exec-not-found');
  equal(new ExecProviderUnavailableError('dsh 未就绪').code, 'exec-provider-unavailable');
  equal(new ExecNotCancellableError('不可取消', 'idle').code, 'exec-not-cancellable');
  equal(new ExecNotPausedError('非 paused', 'running').code, 'exec-not-paused');
  equal(new ExecNotCompletableError('不可手动完成', 'running').code, 'exec-not-completable');
  equal(new ExecTimeoutHeartbeatError('疑似卡死').code, 'exec-timeout-heartbeat');
});

test('错误消息透传', () => {
  const err = new ExecNotFoundError('任务不存在（已删除）');
  equal(err.message, '任务不存在（已删除）');
});
