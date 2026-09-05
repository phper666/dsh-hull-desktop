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
  /** Q-022 会话复用：本次执行建立的 acp 会话 id（结算回写 task.acpSessionId，重跑 resume 续用） */
  sessionId?: string;
  /**
   * Q-025：resume 失败已降级新建——有 sessionId 时新 id 覆盖旧引用；无 sessionId（降级 new
   * 也失败）时结算清空 task.acpSessionId（损坏 id 不留，下次执行不再白试）
   */
  resumeFailed?: boolean;
}

/** execute() 入参任务（契约 §ExecutionProvider 字段） */
export interface ExecutionTask {
  taskId: string;
  title: string;
  /** Q-026 任务描述：prompt 内容（task.description；缺失则不拼） */
  description?: string;
  /** auto 模式 AC（四字段） */
  ac?: { what: string; expected: string; verify: string; context?: string };
  /** Q-018 模型选择：session/set_config_option 的 value JSON 串（task.agentSpec.model ?? board.defaultModel）；缺省走 dsh 默认 */
  model?: string;
  /** Q-019 工作目录：session/new cwd（task.agentSpec.cwd ?? board.defaultCwd ?? homedir；Scheduler 已展开 ~） */
  cwd: string;
  /** Q-021 推理力度：session/set_config_option reasoning_effort（task.agentSpec.reasoningEffort ?? board.defaultReasoningEffort ?? 'low' 终端兜底） */
  reasoningEffort?: string;
  /** Q-022 会话复用：上次执行的 acp 会话 id（存在则先 session/resume 续用，失败优雅降级 session/new） */
  resumeSessionId?: string;
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
