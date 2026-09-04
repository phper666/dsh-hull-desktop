/**
 * B3 并行调度器（Scheduler，契约 E13~E32）
 *
 * 单飞 + 原子结算段（P1-2）：drain 循环同一时刻只一段在跑；完成回调只入队 + 唤醒，
 * 绝不直接改池（结算在 settleAll 原子段内同步执行）。并行上限 maxParallelTasks，
 * 依赖就绪判据 + 失败传播 + 死锁兜底 + 父卡展开。
 */
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Board, ExecutionStatus, Task } from '../../kanban/types';
import { NOOP_LOGGER, type RuntimeLogger } from '../../shared/types';
import type { ExecutionProvider, ExecutionResult } from '../provider/ExecutionProvider';
import { ExecNotFoundError, ExecStateConflictError, ExecValidationError } from '../errors';

export interface SchedulerReadStore {
  getBoard(boardId: string): Board;
}

export interface SchedulerSettledResult {
  exitCode: number;
  /** Q-020 失败可观测性：provider 真实失败原因（结算透传到 VerifyGate 失败 detail → timeline/通知） */
  summary?: string;
  selfCheck: { passed: boolean; evidence?: string } | null;
}

export interface SchedulerMutations {
  enqueueTask(taskId: string, executionId: string): void;
  startTask(taskId: string, executionId: string, startedAt: string): void;
  settleTask(taskId: string, result: SchedulerSettledResult): 'succeeded' | 'failed';
  cancelTask(taskId: string): void;
  failQueuedDependency(taskId: string, depId: string): void;
  failDeadlock(parentId: string): void;
  /** Q-017 兜底：启动失败/重启重排校验失败——任务没跑起来 ≠ succeeded → failed + system 事件 */
  failQueuedTask?(taskId: string, reason: string, detail: string): void;
  deriveParent(parentId: string, derived: ExecutionStatus): void;
  onStreamEvent?(taskId: string, ev: unknown): void;
}

export interface SchedulerOptions {
  maxParallelTasks?: number;
  /** Q-017-C 观测：重启重排入队/跳过留痕（缺省 NOOP） */
  logger?: RuntimeLogger;
}

export interface ExecuteTaskResult {
  taskId: string;
  kind: 'single' | 'parent_expand';
  executionStatus?: 'queued';
  currentExecutionId?: string | null;
  enqueued: string[];
  skipped: string[];
}

/** provider.execute 返回的执行句柄（cancel + 可选 respondPermission 审批响应） */
interface ExecHandleLike {
  cancel: () => Promise<void>;
  respondPermission?: (requestId: string, approved: boolean, reason?: string) => void;
}

interface RunningRec {
  executionId: string;
  startedAt: string;
  handle: ExecHandleLike | null;
}

interface QueuedRec {
  boardId: string;
  task: Task;
}

/** 快照项（getSnapshot 用） */
interface SnapshotEntry {
  taskId: string;
  executionStatus: string;
}

const DEFAULT_MAX_PARALLEL = 3;

/**
 * Q-019：~ 形态 cwd 展开为 homedir 绝对路径（'~' 或 '~/xxx'；session/new cwd 必须绝对路径，
 * 且 ACPProvider 对不存在目录会防御失败——相对路径/波浪号原样传入会误伤）。
 */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export class Scheduler extends EventEmitter {
  private readonly store: SchedulerReadStore;
  private readonly provider: ExecutionProvider;
  private readonly mutations: SchedulerMutations;
  private readonly maxParallel: number;
  private readonly logger: RuntimeLogger;

  private readonly running = new Map<string, RunningRec>();
  private runningCount = 0;
  private readonly queuedQueue = new Map<string, QueuedRec>();
  private readonly pendingSettlements: string[] = [];
  private readonly pendingResults = new Map<string, SchedulerSettledResult>();
  private readonly parentDerived = new Map<string, ExecutionStatus>();
  private readonly taskBoards = new Map<string, string>(); // taskId → boardId（running 后 queuedQueue 已删）
  private loopRunning = false;
  private waiters: Array<() => void> = [];
  private executionSeq = 0;

  constructor(
    store: SchedulerReadStore,
    provider: ExecutionProvider,
    mutations: SchedulerMutations,
    options: SchedulerOptions = {},
  ) {
    super();
    this.store = store;
    this.provider = provider;
    this.mutations = mutations;
    this.maxParallel = options.maxParallelTasks ?? DEFAULT_MAX_PARALLEL;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /**
   * Q-017 核心修复：壳重启后内存队列已空（queuedQueue 是内存 Map），Convergence 保留的
   * queued 任务须重新塞回内存队列。复用 executeTask 守卫语义：running/queued 已有 → 跳过
   * （幂等）；auto 缺 AC → 按现有 E2 语义转 failed（不抛错，收敛要幂等可靠）。
   * 由引擎在收敛后批量调用，最后统一 kickNow 唤醒 drain。
   */
  requeuePersisted(boardId: string, task: Task): void {
    if (this.running.has(task.id) || this.queuedQueue.has(task.id)) {
      // Q-017-C 观测：跳过原因留痕（prod hull.log 可回答 sweep 跑没跑）
      this.logger.info(`[Q-017] requeuePersisted 跳过（已在内存队列）: ${task.id}`);
      return;
    }
    if (task.executionMode === 'auto' && !this.hasCompleteAc(task)) {
      this.logger.info(`[Q-017] requeuePersisted 跳过（auto 缺 AC → failed）: ${task.id}`);
      this.mutations.failQueuedTask?.(task.id, '自动执行校验失败', 'auto 任务缺验收标准（AC）（Q-017 重启重排）');
      return;
    }
    this.enqueue(boardId, task, this.nextExecutionId());
    this.logger.info(`[Q-017] requeuePersisted 已入队: ${task.id}`);
  }

  /** 公开唤醒（Q-017：引擎重启重排后 kick 单飞 drain 循环；执行入口内部已自行 kick） */
  kickNow(): void {
    this.kick();
  }

  /** 单任务执行 / 父卡展开（E17/E28/E2/E29/E30） */
  executeTask(boardId: string, taskId: string): ExecuteTaskResult {
    const board = this.store.getBoard(boardId);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) throw new ExecNotFoundError(`任务不存在: ${taskId}`);

    // 父卡展开：taskId 有子任务即展开（蓝图 !task.parentId 判单卡与 E17/E32 矛盾，修正）
    const children = board.tasks.filter((t) => t.parentId === taskId);
    if (children.length > 0) {
      const enqueued: string[] = [];
      const skipped: string[] = [];
      for (const child of children) {
        if (this.running.has(child.id) || this.queuedQueue.has(child.id)) {
          skipped.push(child.id);
          continue;
        }
        if (child.executionMode === 'auto' && !this.hasCompleteAc(child)) {
          skipped.push(child.id);
          continue;
        }
        if (!child.dependencies.every((d) => this.isDepSatisfied(board, d))) {
          skipped.push(child.id);
          continue;
        }
        this.enqueue(boardId, child, this.nextExecutionId());
        enqueued.push(child.id);
      }
      if (enqueued.length > 0) {
        this.notifyChanged();
        this.kick();
      }
      this.mutations.deriveParent(taskId, enqueued.length > 0 ? 'queued' : (this.parentDerived.get(taskId) ?? 'idle'));
      return { taskId, kind: 'parent_expand', executionStatus: undefined, currentExecutionId: null, enqueued, skipped };
    }

    if (!task.parentId) {
      // 单任务守卫：running/queued 中重复 execute → 状态冲突（E28）
      if (this.running.has(taskId) || this.queuedQueue.has(taskId)) {
        throw new ExecStateConflictError(`任务已在执行: ${taskId}`, taskId, task.executionStatus);
      }
      // auto 缺 AC → 校验错误（E2）
      if (task.executionMode === 'auto' && !this.hasCompleteAc(task)) {
        throw new ExecValidationError(`auto 任务缺验收标准（AC）`, 'acceptanceCriteria');
      }
      const executionId = this.nextExecutionId();
      this.enqueue(boardId, task, executionId);
      this.notifyChanged();
      this.kick();
      return {
        taskId,
        kind: 'single',
        executionStatus: 'queued',
        currentExecutionId: executionId,
        enqueued: [taskId],
        skipped: [],
      };
    }

    // 蓝图遗留分支：被调任务为子任务（parentId 非空）且无自己子卡 → 直接入队
    if (this.running.has(taskId) || this.queuedQueue.has(taskId)) {
      throw new ExecStateConflictError(`任务已在执行: ${taskId}`, taskId, task.executionStatus);
    }
    if (task.executionMode === 'auto' && !this.hasCompleteAc(task)) {
      throw new ExecValidationError(`auto 任务缺验收标准（AC）`, 'acceptanceCriteria');
    }
    this.enqueue(boardId, task, this.nextExecutionId());
    this.notifyChanged();
    this.kick();
    return { taskId, kind: 'single', executionStatus: 'queued', currentExecutionId: null, enqueued: [taskId], skipped: [] };
  }

  /** 取消：queued 出队 / running 发 cancel（幂等） */
  async cancel(boardId: string, taskId: string): Promise<void> {
    void boardId;
    const q = this.queuedQueue.get(taskId);
    if (q) {
      this.queuedQueue.delete(taskId);
      this.taskBoards.delete(taskId);
      this.notifyChanged();
      return;
    }
    const rec = this.running.get(taskId);
    if (rec && rec.handle) {
      await rec.handle.cancel();
      // 句柄 cancel 后主动收尾（provider 可能不回 cancelled 状态；MockProvider.cancel 仅置 flag）
      this.handleStatus(taskId, 'cancelled');
    }
  }

  /** 审批响应转发（B4：approvalRespond → ACP 子进程 permission_response 帧） */
  respondApproval(taskId: string, requestId: string, approved: boolean, reason?: string): boolean {
    const rec = this.running.get(taskId);
    const fn = rec?.handle?.respondPermission;
    if (!fn) return false;
    fn(requestId, approved, reason);
    return true;
  }

  /** 快照（E26） */
  getSnapshot(boardId?: string): {
    running: SnapshotEntry[];
    queued: SnapshotEntry[];
    maxParallel: number;
  } {
    const running: SnapshotEntry[] = [];
    for (const [taskId, rec] of this.running) {
      running.push({ taskId, executionStatus: 'running' });
    }
    const queued: SnapshotEntry[] = [];
    for (const [taskId, q] of this.queuedQueue) {
      if (boardId && q.boardId !== boardId) continue;
      queued.push({ taskId, executionStatus: 'queued' });
    }
    return { running, queued, maxParallel: this.maxParallel };
  }

  /** 完成回调：只入队 + 唤醒，绝不直接改池（E32 成败在此） */
  handleResult(taskId: string, result: ExecutionResult): void {
    const rec = this.running.get(taskId);
    if (!rec) return; // 双 onResult 幂等：已 settle 后 running 无此键 → 忽略
    // 🟡-2：结算在途（failRunning 已注入 failed）→ 迟到 provider 结果不覆盖（终态唯一）
    if (this.pendingSettlements.includes(taskId)) {
      // Q-020：onStatus('failed') 先于 onResult（ACPProvider settleFailure 同步顺序）时，
      // 注入条目已建但无 summary——此处合并真实失败原因（终态仍 failed，只补文案不覆盖结算意图）
      const pending = this.pendingResults.get(taskId);
      if (pending && !pending.summary && result.summary) pending.summary = result.summary;
      return;
    }
    // Q-020：summary（真实失败原因）透传结算——此前在 pendingResults 处即被丢
    this.pendingResults.set(taskId, { exitCode: result.exitCode, summary: result.summary, selfCheck: result.selfCheck ?? null });
    this.pendingSettlements.push(taskId);
    this.wakeSoon();
    this.kick();
  }

  /**
   * 🟡-2 心跳超时强制失败（引擎层 handleHeartbeatTimeout 用）：
   * kill 运行句柄（进程兜底）+ 清既有 pending 结果 + 注入 failed 结算——与 scheduler.cancel 的
   * cancelled 状态路径解耦（不触发 handleStatus('cancelled')，避免 cancelled 与 settleAll 竞态）。
   * 结算仍走 pendingSettlements + settleAll → settleTask → VerifyGate markFailed（恰好一次；
   * 任务已 settle/非 running → 幂等忽略）。
   */
  failRunning(taskId: string): void {
    const rec = this.running.get(taskId);
    if (!rec) return; // 已结算/非 running → 忽略（恰好一次结算）
    // 先入结算队列（provider 同步 cancelled 回调时 handleStatus 守卫能看到在途结算）
    const i = this.pendingSettlements.indexOf(taskId);
    if (i >= 0) this.pendingSettlements.splice(i, 1);
    this.pendingResults.delete(taskId);
    this.pendingSettlements.push(taskId);
    this.pendingResults.set(taskId, { exitCode: 1, selfCheck: { passed: false } });
    // 再 kill 进程（进程兜底；mock 置 flag 后不再回执，ACPProvider cancel 幂等）
    void rec.handle?.cancel().catch(() => {});
    this.notifyChanged();
    this.kick();
  }

  /** running 迁移唯一入口 = onStatus 回调（防双迁移） */
  handleStatus(taskId: string, s: string): void {
    const rec = this.running.get(taskId);
    if (!rec) return;
    if (s === 'running') {
      // 幂等：startTask mutation 内部判已 running
      this.mutations.startTask(taskId, rec.executionId, rec.startedAt);
    } else if (s === 'cancelled') {
      // 🟡-2 双 kill 竞态守卫：任务已入 pendingSettlements（心跳超时 settle 在途/已结算）
      // → 跳过 cancelled 覆盖，终态唯一由 settleAll 决定（防 cancelled→succeeded 摇摆）
      if (this.pendingSettlements.includes(taskId)) return;
      this.running.delete(taskId);
      this.runningCount--;
      this.mutations.cancelTask(taskId);
      this.emitParallelAll();
      this.notifyChanged();
    } else if (s === 'failed') {
      if (!this.pendingSettlements.includes(taskId)) {
        this.pendingSettlements.push(taskId);
        this.pendingResults.set(taskId, { exitCode: 1, selfCheck: { passed: false } });
        this.wakeSoon();
      }
    }
  }

  /** 单飞主循环 */
  private async drain(): Promise<void> {
    if (this.loopRunning) return;
    this.loopRunning = true;
    try {
      for (;;) {
        // Q-017 次级修复：单轮异常（settleAll/findStartable/startBatch/checkDeadlock 任何
        // 同步抛错）只跳过本轮，不打死单飞循环（否则全调度停摆、任务卡内存/store 之间）
        try {
          this.settleAll(); // ① 同步结算全部 pending（零 await）
          const ready = this.findStartable(); // ② 重算就绪集
          this.startBatch(ready); // ③ 入池 ≤ 空余池位（同步）
          this.checkDeadlock(); // ④ 死锁兜底
        } catch (err) {
          console.error('[Scheduler] drain 单轮异常，跳过本轮等待变更:', err);
        }
        if (this.runningCount === 0 && this.queuedQueue.size === 0) break;
        await this.waitForChange();
      }
    } finally {
      this.loopRunning = false; // 必须 finally 复位
    }
  }

  /** 原子结算段 ①：while 一次性清空，期间不 await（pop 反序避免 shift O(n²)） */
  private settleAll(): void {
    while (this.pendingSettlements.length > 0) {
      const taskId = this.pendingSettlements.pop()!;
      const rec = this.running.get(taskId);
      if (!rec) continue;
      const result = this.pendingResults.get(taskId)!;
      this.running.delete(taskId);
      this.runningCount--;
      this.pendingResults.delete(taskId);
      this.parentDerived.delete(taskId);
      const finalStatus = this.mutations.settleTask(taskId, result);
      if (finalStatus === 'failed') this.propagateFailure(taskId);
      this.deriveParent(taskId, finalStatus);
    }
    if (this.running.size < this.maxParallel) this.emitParallelAll();
  }

  /** 入池 ③：同步调 provider.execute（句柄必须同步返回） */
  private startBatch(ready: Task[]): void {
    const free = this.maxParallel - this.runningCount;
    for (const task of ready.slice(0, free)) {
      const q = this.queuedQueue.get(task.id);
      if (!q) continue;
      this.queuedQueue.delete(task.id);
      const executionId = this.nextExecutionId();
      const startedAt = new Date().toISOString();
      this.running.set(task.id, { executionId, startedAt, handle: null });
      this.runningCount++;
      // Q-017 次级修复：provider.execute 同步抛错 → 回滚内存池 + 任务置 failed
      //（任务没跑起来 ≠ succeeded；queuedQueue 不还原——任务已终态）
      let handle: ExecHandleLike;
      try {
        handle = this.provider.execute(this.toExecutionTask(task, q.boardId), {
          onEvent: (ev) => this.mutations.onStreamEvent?.(task.id, ev),
          onStatus: (s) => this.handleStatus(task.id, s),
          onResult: (r) => this.handleResult(task.id, r),
        });
      } catch (err) {
        this.running.delete(task.id);
        this.runningCount--;
        const msg = err instanceof Error ? err.message : String(err);
        this.mutations.failQueuedTask?.(task.id, '启动失败', `provider.execute 异常：${msg}`);
        continue;
      }
      const rec = this.running.get(task.id);
      if (rec) rec.handle = handle;
    }
    this.emitParallelAll();
  }

  /** 依赖判据 */
  private isDepSatisfied(board: Board, depId: string): boolean {
    const dep = board.tasks.find((t) => t.id === depId);
    if (!dep) return false;
    if (dep.executionStatus === 'succeeded') return true;
    if (dep.executionMode === 'manual') {
      const col = board.columns.find((c) => c.id === dep.columnId);
      if (col?.type === 'done') return true;
    }
    return false;
  }

  /** 重算就绪集 */
  private findStartable(): Task[] {
    const ready: Task[] = [];
    for (const [, { boardId, task }] of this.queuedQueue) {
      const board = this.store.getBoard(boardId);
      if (task.dependencies.every((d) => this.isDepSatisfied(board, d))) ready.push(task);
    }
    return ready;
  }

  /** 死锁兜底（E16）：running>0 禁止判死锁 */
  private checkDeadlock(): void {
    if (this.runningCount > 0 || this.queuedQueue.size === 0) return;
    if (this.findStartable().length > 0) return;
    const parentIds = new Set<string>();
    for (const [, q] of this.queuedQueue) {
      if (q.task.parentId) parentIds.add(q.task.parentId);
    }
    // 环死锁（无父卡）：整队清空按 taskId 兜底标 deadlock（E16）
    const deadlockAll = parentIds.size === 0;
    if (deadlockAll) {
      for (const [taskId] of this.queuedQueue) parentIds.add(taskId);
    }
    this.queuedQueue.clear();
    for (const pid of parentIds) this.mutations.failDeadlock(pid);
    this.emitParallelAll();
  }

  /** 失败传播（E15，级联） */
  private propagateFailure(failedId: string): void {
    const queue: string[] = [failedId];
    while (queue.length) {
      const f = queue.shift()!;
      for (const [queuedId, { task }] of [...this.queuedQueue]) {
        if (task.dependencies.includes(f)) {
          this.queuedQueue.delete(queuedId);
          this.mutations.failQueuedDependency(queuedId, f);
          this.deriveParent(queuedId, 'failed');
          queue.push(queuedId);
        }
      }
    }
  }

  /** 父卡派生 */
  private deriveParent(childId: string, childStatus: ExecutionStatus): void {
    const boardId = this.findBoardIdOf(childId);
    if (boardId === null) return;
    const board = this.store.getBoard(boardId);
    const child = board.tasks.find((t) => t.id === childId);
    if (!child?.parentId) return;
    const siblings = board.tasks.filter((t) => t.parentId === child.parentId);
    let derived: 'running' | 'queued' | 'succeeded' | 'failed' = 'succeeded';
    for (const s of siblings) {
      if (s.executionStatus === 'failed') {
        derived = 'failed';
        break;
      }
      if (s.executionStatus === 'running' || s.executionStatus === 'queued') {
        derived = 'running';
      } else if (
        s.executionStatus === 'paused' ||
        s.executionStatus === 'cancelled' ||
        s.executionStatus === 'interrupted'
      ) {
        if (derived === 'succeeded') derived = 'running';
      }
    }
    if (this.parentDerived.get(child.parentId) !== derived) {
      this.parentDerived.set(child.parentId, derived);
      this.mutations.deriveParent(child.parentId, derived);
    }
  }

  private findBoardIdOf(taskId: string): string | null {
    return this.taskBoards.get(taskId) ?? null;
  }

  /** 事件唤醒 */
  private notifyChanged(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /**
   * Q-017-A 唤醒延迟到微任务：provider 可能在 execute **同步调用栈内**回调（ACPProvider
   * DSH_HOME 未设 → settleFailure 立即触发）——此刻 drain 尚未执行到 waitForChange，
   * waiters 为空，同步 notifyChanged 是空操作 → pendingSettlements 无人结算，任务僵尸
   * （内存 running / store queued 之间）且 drain 永久挂起。微任务在 drain 挂起
   * （waiter 已注册）后触发，恰好唤醒下一轮 settleAll。pendingSettlements 仍同步入队，
   * 仅唤醒延迟，不改变结算语义。
   */
  private wakeSoon(): void {
    queueMicrotask(() => this.notifyChanged());
  }

  private waitForChange(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private kick(): void {
    if (!this.loopRunning) void this.drain();
  }

  private emitParallelAll(): void {
    const running: SnapshotEntry[] = [];
    for (const [taskId] of this.running) running.push({ taskId, executionStatus: 'running' });
    this.emit('parallel', 'all', { running });
  }

  private enqueue(boardId: string, task: Task, executionId: string): void {
    this.queuedQueue.set(task.id, { boardId, task });
    this.taskBoards.set(task.id, boardId);
    this.mutations.enqueueTask(task.id, executionId);
  }

  private nextExecutionId(): string {
    this.executionSeq++;
    return `e_${String(this.executionSeq).padStart(4, '0')}`;
  }

  private hasCompleteAc(task: Task): boolean {
    const ac = task.acceptanceCriteria;
    return !!ac && ac.what.trim().length > 0 && ac.expected.trim().length > 0 && ac.verify.trim().length > 0;
  }

  /** ExecutionTask 组装（Q-018 模型合并 + Q-019 cwd 三级回落） */
  private toExecutionTask(task: Task, boardId?: string) {
    const board = boardId ? this.store.getBoard(boardId) : undefined;
    const model = task.agentSpec.model ?? board?.defaultModel ?? undefined;
    // Q-019 工作目录：task.agentSpec.cwd > board.defaultCwd > os.homedir()（会话归组正确 + agent 在指定目录干活）
    const cwd = expandTilde(task.agentSpec.cwd ?? board?.defaultCwd ?? homedir());
    return {
      taskId: task.id,
      title: task.title,
      cwd,
      ...(model ? { model } : {}),
      ac: task.acceptanceCriteria ?? undefined,
      agentSpec: task.agentSpec
        ? {
            provider: task.agentSpec.provider,
            ...(task.agentSpec.agent ? { agent: task.agentSpec.agent } : {}),
            ...(task.agentSpec.model ? { model: task.agentSpec.model } : {}),
            subagentPolicy: task.agentSpec.subagentPolicy,
          }
        : undefined,
    };
  }
}
