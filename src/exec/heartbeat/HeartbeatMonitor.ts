/**
 * B3 活动心跳监视器（B3 design §4.3，冻结）
 *
 * Q-026 活动心跳语义：agent_message_chunk 流式事件 = 活动 → reset 重置 idle 计时器
 * （非总时长——持续输出长任务不超时）；连续 maxExecutionIdleMinutes（默认 30）无活动
 * → emit('timeout') → 引擎层 failed("疑似卡死") + kill ACP 进程 + exec-timeout-heartbeat 回写。
 *
 * E31（P1-1，与 paused 冲突）：计时器仅绑定 running 态；任务迁出 running
 * （paused/interrupted/succeeded/failed/cancelled）→ stop 销毁计时器——paused 不心跳判定、
 * 无 idle 超时（避免长时间 paused 触发"疑似卡死"failed 与 O-11"暂停保任务态可恢复"矛盾）；
 * resume/重跑/重试转 running → reset 重新绑定（全新窗口）。
 *
 * 计时器仅内存态，不持久化（壳重启由 Convergence 兜底）。
 *
 * 职责边界：本模块只负责计时触发（emit timeout）；failed 落库 + kill 进程是引擎层
 * （L3 ExecutionEngine）订阅后执行——本模块不依赖 store/provider。
 */
import { EventEmitter } from 'node:events';

export interface HeartbeatMonitorOptions {
  /** 连续无活动事件心跳超时（分钟；CON-R032 默认 30，SettingsProvider 可配） */
  maxExecutionIdleMinutes?: number;
}

/** 心跳超时事件载荷（→ 引擎层 failed + kill + 回写） */
export interface HeartbeatTimeoutEvent {
  taskId: string;
  /** 触发超时的 idle 窗口（分钟） */
  idleMinutes: number;
}

/**
 * 活动心跳监视器（每任务一个 idle 计时器）。
 * 事件：'timeout' → HeartbeatTimeoutEvent。
 */
export class HeartbeatMonitor extends EventEmitter {
  private readonly maxIdleMs: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(options: HeartbeatMonitorOptions = {}) {
    super();
    this.maxIdleMs = (options.maxExecutionIdleMinutes ?? 30) * 60_000;
  }

  /**
   * 绑定/重置 idle 计时器（running 进入 或 活动事件/resume 重绑）。
   * 覆盖既有计时器：活动事件即推窗，非累计总时长（Q-026）。
   */
  reset(taskId: string): void {
    const existing = this.timers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      this.emit('timeout', { taskId, idleMinutes: this.maxIdleMs / 60_000 } satisfies HeartbeatTimeoutEvent);
    }, this.maxIdleMs);
    timer.unref?.();
    this.timers.set(taskId, timer);
  }

  /**
   * 销毁计时器（任务迁出 running → paused/interrupted/succeeded/failed/cancelled，E31）。
   * 幂等：未绑定任务无操作。
   */
  stop(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
  }

  /** 清理全部计时器（shutdown/收敛兜底） */
  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** 当前绑定计时器任务数（测试/快照） */
  get size(): number {
    return this.timers.size;
  }
}
