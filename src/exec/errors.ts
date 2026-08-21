/**
 * B3 执行引擎具名错误集（KANBAN_EXEC_ERROR，feishu-b3-m2-kanban-api-contract.md §公共异常集）
 *
 * 与 B1 HullError 风格对齐：KANBAN_EXEC_ERROR 前缀常量 + 具名子类（kebab 码）。
 * 与 B1 KANBAN_STORE_ERROR 并存；validation-error / store-not-found 复用命名（跨契约同码不歧义）。
 */

import { HullError } from '../shared/errors';

/** B3 执行引擎错误码（KANBAN_EXEC_ERROR 集，kebab 对齐 B1） */
export const KANBAN_EXEC_ERRORS = {
  notFound: 'exec-not-found',
  providerUnavailable: 'exec-provider-unavailable',
  stateConflict: 'exec-state-conflict',
  notCancellable: 'exec-not-cancellable',
  notRunning: 'exec-not-running',
  notPaused: 'exec-not-paused',
  notCompletable: 'exec-not-completable',
  approvalNotPending: 'exec-approval-not-pending',
  timeoutHeartbeat: 'exec-timeout-heartbeat',
  validation: 'validation-error',
} as const;

export type ExecErrorCode = (typeof KANBAN_EXEC_ERRORS)[keyof typeof KANBAN_EXEC_ERRORS];

/** 任务/看板不存在（已删除） */
export class ExecNotFoundError extends HullError {
  constructor(message: string) {
    super(KANBAN_EXEC_ERRORS.notFound, message);
  }
}

/** dsh ACP 未就绪 / spawn 失败 */
export class ExecProviderUnavailableError extends HullError {
  constructor(message: string) {
    super(KANBAN_EXEC_ERRORS.providerUnavailable, message);
  }
}

/** 状态冲突（running/queued 中重复 executeTask；单卡单执行守卫） */
export class ExecStateConflictError extends HullError {
  readonly taskId: string;
  readonly currentStatus: string;

  constructor(message: string, taskId: string, currentStatus: string) {
    super(KANBAN_EXEC_ERRORS.stateConflict, message);
    this.taskId = taskId;
    this.currentStatus = currentStatus;
  }
}

/** 非 queued/running/paused 不可取消 */
export class ExecNotCancellableError extends HullError {
  readonly currentStatus: string;

  constructor(message: string, currentStatus: string) {
    super(KANBAN_EXEC_ERRORS.notCancellable, message);
    this.currentStatus = currentStatus;
  }
}

/** 非 running 不可暂停/延长执行 */
export class ExecNotRunningError extends HullError {
  readonly currentStatus: string;

  constructor(message: string, currentStatus: string) {
    super(KANBAN_EXEC_ERRORS.notRunning, message);
    this.currentStatus = currentStatus;
  }
}

/** 非 paused 不可恢复 */
export class ExecNotPausedError extends HullError {
  readonly currentStatus: string;

  constructor(message: string, currentStatus: string) {
    super(KANBAN_EXEC_ERRORS.notPaused, message);
    this.currentStatus = currentStatus;
  }
}

/** 非 interrupted/failed 不可手动完成 */
export class ExecNotCompletableError extends HullError {
  readonly currentStatus: string;

  constructor(message: string, currentStatus: string) {
    super(KANBAN_EXEC_ERRORS.notCompletable, message);
    this.currentStatus = currentStatus;
  }
}

/** 审批请求不存在/已响应（含 30s 超时已自动 deny） */
export class ExecApprovalNotPendingError extends HullError {
  readonly requestId: string;

  constructor(message: string, requestId: string) {
    super(KANBAN_EXEC_ERRORS.approvalNotPending, message);
    this.requestId = requestId;
  }
}

/** 心跳超时 → failed（"疑似卡死"，回写 failed 记录） */
export class ExecTimeoutHeartbeatError extends HullError {
  constructor(message: string) {
    super(KANBAN_EXEC_ERRORS.timeoutHeartbeat, message);
  }
}

/** 参数校验失败（auto 缺 AC、decision 非法、taskId 空等） */
export class ExecValidationError extends HullError {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(KANBAN_EXEC_ERRORS.validation, message);
    this.field = field;
  }
}
