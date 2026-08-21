/**
 * ApprovalManager（B4 审批流，design §4.2 / 契约 §2/Q-018，P1-B4-1）
 *
 * - ACP session/request_permission → 入 FIFO pending 队列（queuePosition 1/2/3…），
 *   deadlineAt = now + 30s 由**主进程**计算（P1-B4-1：B2 只读展示倒计时，不自行计时）
 * - approvalRespond（approve/deny + reason?）→ 回 ACP { requestId, approved, reason? }
 *   （P2-B4-1：message 空则省略 reason；approved 必填）
 * - 30s 到点（主进程计时器）→ 自动 deny + timeline 留痕 + 推送 close
 * - 壳重启 → pending 立即 auto-deny + timeline（对齐 B3 重启收敛 Q-017）
 * - 非阻塞：不 block 执行；多请求 FIFO 排队，响应任一不阻塞其他
 *
 * 依赖注入（不硬依赖 ExecutionEngine）：
 * - respondApproval：回 ACP 审批响应（ACPProvider 接线注入）
 * - timelineStore：B1 timeline 写原语（system 事件，B4 ApprovalManager 写权，P1-1）
 * - now/setTimeout：mock 时钟 seam
 *
 * timeline 写入归属（design §4.2 P1-1）：审批决策/超时/重启 auto-deny 写 **system 事件**
 * （source.type=system，author=user，design 措辞）——复用 B1 store 原语，不新增第三写入入口。
 */
import { EventEmitter } from 'node:events';

import type { RuntimeLogger } from '../../shared/types';
import { NOOP_LOGGER } from '../../shared/types';
import { ExecApprovalNotPendingError, ExecValidationError } from '../errors';

/** 审批超时（契约 Q-018：30s 无响应自动 deny） */
export const APPROVAL_TIMEOUT_MS = 30_000;

/** 审批决策（契约 §approvalRespond：'approve' / 'deny'） */
export type ApprovalDecision = 'approve' | 'deny';

/** 审批请求来源上下文（ACPProvider.onEvent permission_request 消费；B2 弹窗数据源） */
export interface PermissionRequestContext {
  boardId: string;
  taskId: string;
  title: string;
  requestId: string;
  message: string;
}

/** B4→B2 审批事件负载（契约 §审批事件负载：deadlineAt 主进程计算下发） */
export interface PermissionRequestEvent extends PermissionRequestContext {
  /** FIFO 排队位置（从 1 起） */
  queuePosition: number;
  /** ISO 8601 UTC；推送时刻 + 30s（P1-B4-1 主进程计时归属） */
  deadlineAt: string;
}

/** 审批状态（契约 §审批请求状态 Q-018） */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'auto-denied';

/** pending 审批请求（队列元素） */
export interface PendingApproval {
  boardId: string;
  taskId: string;
  title: string;
  requestId: string;
  message: string;
  /** 入队时刻（毫秒） */
  createdAt: number;
  /** 入队时刻 + 30s（主进程超时截止） */
  deadlineAt: number;
  /** 在 pending 队列中的 FIFO 位置（重排后更新） */
  queuePosition: number;
}

/** B1 timeline 写原语注入面（B4 ApprovalManager 写 system 事件，P1-1） */
export interface ApprovalTimelineStore {
  /** 追加 system 事件到任务 timeline（B1 store 原语直调，不经 IPC） */
  appendSystemEvent(boardId: string, taskId: string, content: string): void;
}

export interface ApprovalManagerOptions {
  /** 回 ACP 审批响应（ACPProvider 接线注入；deny 用于超时/重启兜底） */
  respondApproval(ctx: PermissionRequestContext, decision: ApprovalDecision, reason?: string): void;
  /** B1 timeline 写原语（system 事件） */
  timelineStore: ApprovalTimelineStore;
  /** 日志注入 */
  logger?: RuntimeLogger;
  /** 时钟（测试 seam：deadlineAt 计算） */
  now?: () => number;
  /** 计时器（测试 seam：30s 超时） */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** 计时器清理（与 setTimeout 配对注入） */
  clearTimeout?: (handle: unknown) => void;
}

/**
 * 审批流管理：pending FIFO 队列 + 主进程 deadlineAt 计时 + 30s auto-deny + 重启 auto-deny。
 * 不直接依赖 ExecutionEngine；ACP 响应与 timeline 写均经注入回调（后续 B3/B4Ipc 接线）。
 *
 * 事件（🟡-3 审批事件推送断链修复）：
 * - 'request'：新审批请求入队（载荷 PermissionRequestEvent；ExecIpc 订阅 → webContents.send onPermissionRequest）
 * - 'settled'：请求已响应/超时/重启拒绝（载荷 { requestId, decision }；B2 关弹窗）
 */
export class ApprovalManager extends EventEmitter {
  private readonly respondApproval: ApprovalManagerOptions['respondApproval'];
  private readonly timelineStore: ApprovalTimelineStore;
  private readonly logger: RuntimeLogger;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  /** FIFO 队列（按任务平铺，先到先响应；响应任一不阻塞其他） */
  private readonly pending: PendingApproval[] = [];
  /** 已响应/已超时的 requestId → 幂等拒绝（exec-approval-not-pending） */
  private readonly settled = new Set<string>();
  /** 计时器句柄（timeoutId → 关联 requestId） */
  private readonly timers = new Map<unknown, string>();

  constructor(options: ApprovalManagerOptions) {
    super();
    this.respondApproval = options.respondApproval;
    this.timelineStore = options.timelineStore;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** 当前 pending 快照（B4 getPendingApprovals 恢复弹窗 / 调试） */
  getPending(): readonly PendingApproval[] {
    return this.pending.map((p) => ({ ...p }));
  }

  /**
   * ACP session/request_permission 到达 → 入 FIFO 队列 + 主进程计时（deadlineAt = now + 30s）。
   * 推送 onPermissionRequest（含 deadlineAt）；非阻塞。
   */
  handlePermissionRequest(
    ctx: PermissionRequestContext,
    onRequest: (ev: PermissionRequestEvent) => void,
  ): PermissionRequestEvent {    const createdAt = this.now();
    const deadlineAt = createdAt + APPROVAL_TIMEOUT_MS;
    const entry: PendingApproval = {
      ...ctx,
      createdAt,
      deadlineAt,
      queuePosition: this.pending.length + 1,
    };
    this.pending.push(entry);
    const ev: PermissionRequestEvent = {
      ...ctx,
      queuePosition: entry.queuePosition,
      deadlineAt: new Date(deadlineAt).toISOString(),
    };
    onRequest(ev);
    this.emit('request', ev);
    // 主进程计时器：到 deadlineAt → 自动 deny（B2 崩溃不影响，P1-B4-1）
    const timer = this.setTimeoutFn(() => this.autoDeny(entry.requestId), Math.max(0, deadlineAt - createdAt));
    this.timers.set(timer, entry.requestId);
    this.logger.info(`审批请求入队: requestId=${entry.requestId} taskId=${entry.taskId} queuePosition=${entry.queuePosition}`);
    return ev;
  }

  /**
   * 生产审批链路入口（main 装配 `acpProvider.on('permission', handlePermission)` 消费）：
   * 入队 + 广播 'request' 事件（ExecIpc 已订阅 → webContents.send onPermissionRequest）。
   * ACPProvider 事件载荷无 boardId（任务不含），填空串兜底（B2 按 taskId 展示）。
   */
  handlePermission(ctx: Omit<PermissionRequestContext, 'boardId'>): PermissionRequestEvent {
    return this.handlePermissionRequest({ boardId: '', ...ctx }, () => {});
  }

  /**
   * B2 审批响应 → 回 ACP { requestId, approved, reason? } + timeline 留痕。
   * requestId 不存在/已响应（含已超时）→ ExecApprovalNotPendingError；decision 非法 → ExecValidationError。
   */
  respond(boardId: string, taskId: string, requestId: string, decision: ApprovalDecision, message?: string): ApprovalDecision {
    if (decision !== 'approve' && decision !== 'deny') {
      throw new ExecValidationError(`decision 非法（approve/deny）: ${String(decision)}`, 'decision');
    }
    const idx = this.pending.findIndex((p) => p.requestId === requestId);
    if (idx < 0 || this.settled.has(requestId)) {
      throw new ExecApprovalNotPendingError('审批请求不存在/已处理（含 30s 超时已自动拒绝）', requestId);
    }
    const entry = this.pending[idx];
    this.pending.splice(idx, 1);
    this.reindex();
    this.settled.add(requestId);
    this.clearTimer(entry.requestId);
    this.respondApproval({ boardId, taskId, title: entry.title, requestId, message: entry.message }, decision, message);
    this.timelineStore.appendSystemEvent(boardId, taskId, `审批 ${decision}: ${message ?? ''}`.trimEnd());
    this.logger.info(`审批响应: requestId=${requestId} decision=${decision}`);
    this.emit('settled', { boardId, taskId, requestId, decision });
    return decision;
  }

  /** 响应后队列重排：queuePosition 保持连续 1/2/3… */
  private reindex(): void {
    this.pending.forEach((p, i) => {
      p.queuePosition = i + 1;
    });
  }

  /** 30s 到点自动 deny + timeline 留痕（Q-018）；已响应/不存在 → 忽略 */
  private autoDeny(requestId: string): void {
    this.timers.delete(this.findTimerHandle(requestId));
    const idx = this.pending.findIndex((p) => p.requestId === requestId);
    if (idx < 0 || this.settled.has(requestId)) return;
    const entry = this.pending[idx];
    this.pending.splice(idx, 1);
    this.reindex();
    this.settled.add(requestId);
    this.respondApproval(
      { boardId: entry.boardId, taskId: entry.taskId, title: entry.title, requestId, message: entry.message },
      'deny',
    );
    this.timelineStore.appendSystemEvent(entry.boardId, entry.taskId, '审批超时自动拒绝');
    this.logger.warn(`审批超时自动拒绝: requestId=${requestId} taskId=${entry.taskId}`);
    this.emit('settled', { boardId: entry.boardId, taskId: entry.taskId, requestId, decision: 'deny' });
  }

  /**
   * 壳重启收敛（对齐 B3 Q-017）：pending 请求 → 立即 auto-deny + timeline 留痕。
   * 主进程计时器随壳销毁无法延续，重启即判定超时拒绝（契约 P1-B4-1 第 3 条）。
   * 清空全部 pending 与计时器，返回被拒绝的请求数。
   */
  denyAllPendingOnRestart(): number {
    if (this.pending.length === 0) return 0;
    const victims = this.pending.splice(0);
    this.pending.length = 0;
    this.timers.clear();
    for (const entry of victims) {
      this.settled.add(entry.requestId);
      this.respondApproval(
        { boardId: entry.boardId, taskId: entry.taskId, title: entry.title, requestId: entry.requestId, message: entry.message },
        'deny',
      );
      this.timelineStore.appendSystemEvent(entry.boardId, entry.taskId, '壳重启，审批自动拒绝');
      this.emit('settled', { boardId: entry.boardId, taskId: entry.taskId, requestId: entry.requestId, decision: 'deny' });
    }
    this.logger.warn(`壳重启：${victims.length} 个 pending 审批立即自动拒绝`);
    return victims.length;
  }

  private clearTimer(requestId: string): void {
    const handle = this.findTimerHandle(requestId);
    if (handle !== undefined) {
      this.timers.delete(handle);
      this.clearTimeoutFn(handle);
    }
  }

  private findTimerHandle(requestId: string): unknown | undefined {
    for (const [handle, rid] of this.timers) {
      if (rid === requestId) return handle;
    }
    return undefined;
  }
}
