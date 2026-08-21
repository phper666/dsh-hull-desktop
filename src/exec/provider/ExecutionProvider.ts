/**
 * ExecutionProvider 抽象接口（B3 契约 §Schema ExecutionProvider 接口，冻结）
 *
 * 数据模型与执行协议解耦（CON-R019）：ACP 默认 / --patch 插件备选 / CLI headless
 * 兜底均实现此接口。B4 多 agent 注册表（CON-R030）消费 provider 字段扩展第二平台。
 *
 * 注意（Q-013 双轨）：executionStatus 8 态属看板 Task 模型（B1 types），ProviderStatus
 * 是执行通道侧状态（无 interrupted/idle——通道不感知看板 AC 修订/待执行）。两轨独立。
 */

/** 执行通道侧状态（契约 §ExecutionProvider：6 态，无 idle/interrupted） */
export type ProviderStatus = 'queued' | 'running' | 'paused' | 'cancelled' | 'failed' | 'succeeded';

/** 流式执行事件（契约 §ExecutionProvider；text_chunk = 活动心跳信号 Q-026） */
export type ExecutionEvent =
  | { kind: 'text_chunk'; text: string }
  | { kind: 'tool_call'; name: string; args: unknown }
  | { kind: 'permission_request'; id: string; message: string };

/** 最终执行结果（契约 §ExecutionProvider；selfCheck Q-015） */
export interface ExecutionResult {
  /** 0=成功 */
  exitCode: number;
  /** 输出摘要 ≤4KB（共识 §9 常量，引擎侧截断） */
  summary: string;
  /** kanban/executions/e_<uuid>.log（相对路径） */
  outputPath: string;
  /** Q-015 自验判定信号 */
  selfCheck?: { passed: boolean; evidence?: string };
}

/** execute() 入参任务（契约 §ExecutionProvider 字段） */
export interface ExecutionTask {
  taskId: string;
  title: string;
  /** auto 模式 AC（四字段） */
  ac?: { what: string; expected: string; verify: string; context?: string };
  agentSpec?: {
    /** 默认 'dsh'（CON-R030 预留多平台） */
    provider?: string;
    agent?: string;
    model?: string;
    subagentPolicy?: 'auto' | 'restricted';
  };
}

/** 执行回调集合（契约 §ExecutionProvider handlers） */
export interface ExecutionHandlers {
  /** 流式事件（含活动心跳） */
  onEvent: (ev: ExecutionEvent) => void;
  /** 状态变更 */
  onStatus: (s: ProviderStatus) => void;
  /** 最终结果 */
  onResult: (r: ExecutionResult) => void;
}

/** 执行提供方抽象（ACP 默认 / 插件备选 / CLI 兜底） */
export interface ExecutionProvider {
  /**
   * 执行任务。返回句柄，cancel() 取消执行（session/cancel；无会话则 kill）。
   * 实现必须保证最终恰好一次 onResult（成功或失败路径）；异常/进程崩溃经 onResult
   * 回传失败结果（exitCode!=0），不抛错逃逸。
   */
  execute(task: ExecutionTask, handlers: ExecutionHandlers): { cancel(): Promise<void> };
}
