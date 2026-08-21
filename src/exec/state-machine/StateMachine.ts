/**
 * B3 状态机（B3 design §4.1，冻结）：表驱动迁移 + 非法迁移防护 + 事件 emit
 *
 * - 执行态 8 态迁移表驱动（EXEC_TRANSITIONS），只写 executionStatus（Q-013 双轨：
 *   列迁移走 B1 moveTask，本机不碰 columnId）。
 * - 非法迁移：dev 下 throw / prod 下 log 忽略并返回 false（复用 M1 RuntimeManager D7 模式）。
 * - on('status', cb) 事件 → onExecutionUpdate 推送源。
 */
import { EventEmitter } from 'node:events';

import { NOOP_LOGGER, type RuntimeLogger } from '../../shared/types';
import type { ExecutionStatus } from '../../kanban/types';
import { EXEC_TRANSITIONS } from './transitions';

/** 状态事件载荷（契约 §onExecutionUpdate：8 态 + 双轨解耦，无列字段） */
export interface ExecutionStatusEvent {
  taskId: string;
  executionStatus: ExecutionStatus;
  /** 双轨标注：列迁移不改执行态，本事件不含 columnId（Q-013） */
}

export interface StateMachineOptions {
  /** 非法迁移：dev 下 throw / prod 下 log 忽略；默认 false（prod） */
  dev?: boolean;
  logger?: RuntimeLogger;
}

/**
 * 单任务执行态状态机（每任务实例；任务 id 构造入参）。
 * 非法迁移防护：dev throw / prod log-ignore 返回 false（对齐 M1 D7）。
 */
export class StateMachine extends EventEmitter {
  private readonly taskId: string;
  private readonly dev: boolean;
  private readonly logger: RuntimeLogger;
  private status: ExecutionStatus = 'idle';

  constructor(taskId: string, options: StateMachineOptions = {}) {
    super();
    this.taskId = taskId;
    this.dev = options.dev ?? false;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** 当前执行态（初始 idle） */
  get current(): ExecutionStatus {
    return this.status;
  }

  /** 迁移统一入口：校验迁移表 → 更新 status → emit。非法迁移 dev throw / prod false */
  transition(to: ExecutionStatus): boolean {
    const from = this.status;
    const allowed = EXEC_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      const err = new Error(`非法状态迁移: ${from} -> ${to}（task=${this.taskId}）`);
      if (this.dev) throw err;
      this.logger.warn(`[state] ${err.message}（忽略）`);
      return false;
    }
    this.status = to;
    this.emit('status', { taskId: this.taskId, executionStatus: to } satisfies ExecutionStatusEvent);
    return true;
  }
}
