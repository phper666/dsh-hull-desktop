/**
 * B3 执行引擎 8 态迁移表常量（B3 契约 §状态转换，冻结）
 *
 * 双轨解耦（Q-013）：executionStatus 8 态（系统流转）与 columnId（人工拖拽流转）独立。
 * Verify/Done 是列轨状态（模板列 type=verify/done），不在 8 态枚举内——故三张表：
 * 1) EXEC_TRANSITIONS 执行态轨道（8 态）
 * 2) COLUMN_TYPES 列轨道（模板列 type 语义，verify→done 人工把关）
 * 3) 系统收敛动作（失败传播/重启/死锁/心跳）为「目标态判定」，不含非法迁移
 *
 * 本表即契约矩阵机器可读形态：StateMachine 单测对着表测合法迁移 + 非法迁移防护。
 */
import type { ExecutionStatus } from '../../kanban/types';

/** 执行态轨道迁移表（契约 §执行态轨道 18 行；每态允许的目标态列表） */
export const EXEC_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  // idle：点「执行」→ queued（CON-R018 auto 需 AC 完整；manual 无门槛）
  idle: ['queued'],
  // queued：调度就绪→running（有并行名额+依赖满足）；用户取消→cancelled；系统收敛→failed（依赖失败）
  queued: ['running', 'cancelled', 'failed'],
  // running：用户暂停→paused（O-11 kill 进程）；编辑 AC→interrupted（Q-022）；用户取消→cancelled；完成→succeeded（selfCheck true）；失败→failed（selfCheck false/心跳/通道异常）
  running: ['paused', 'interrupted', 'cancelled', 'succeeded', 'failed'],
  // paused：用户恢复→running（重新执行）；用户取消→cancelled
  paused: ['running', 'cancelled'],
  // interrupted：两选一①以新 AC 重跑→queued；②手动完成→succeeded（列→verify，仍走把关）
  interrupted: ['queued', 'succeeded'],
  // failed：用户重试→queued；手动完成→succeeded（列→verify）
  failed: ['queued', 'succeeded'],
  // succeeded：再次点「执行」→ queued（重跑规则 Q-023；任何态点执行→queued）
  succeeded: ['queued'],
  // cancelled：重跑规则允许再次点「执行」→ queued
  cancelled: ['queued'],
};

/** 全部执行态（8 态，与 B1 ExecutionStatus 对齐） */
export const EXECUTION_STATUSES: ExecutionStatus[] = [
  'idle',
  'queued',
  'running',
  'paused',
  'interrupted',
  'cancelled',
  'failed',
  'succeeded',
];

/** 模板列类型（列轨道；B1 DEFAULT_COLUMNS 6 态镜像） */
export const COLUMN_TYPES = ['backlog', 'todo', 'in_progress', 'verify', 'done', 'blocked'] as const;
export type ColumnTypeName = (typeof COLUMN_TYPES)[number];

/** Verify/Done 列轨：仅 verify 列可人工确认 → done（CON-R028/O-6 把关） */
export const VERIFY_COLUMN_TYPE = 'verify';
export const DONE_COLUMN_TYPE = 'done';
