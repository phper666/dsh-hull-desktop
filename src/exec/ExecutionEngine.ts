/**
 * B3 ExecutionEngine 执行引擎门面（design §4 模块表 + §4.8/4.9，冻结）
 *
 * 组装 Scheduler + HeartbeatMonitor + Convergence + VerifyGate + ProviderManager，
 * 实现 SchedulerMutations 把调度簿记落到 KanbanStore（executionStatus/currentExecutionId/
 * timeline system 事件）。公开入口对齐契约 10 IPC 语义（executeTask/cancel/pause/resume/
 * manualComplete/confirmVerify/getExecutionSnapshot）。
 *
 * 关键接线：
 * - Scheduler 完成回调 handleResult → settleTask mutation → VerifyGate.applyResult
 *   （selfCheck 判定 + 列流转 verify/failed）→ Scheduler 结算
 * - 心跳：onStreamEvent（agent_message_chunk）→ heartbeat.reset；running 迁出 → stop；
 *   heartbeat timeout → failed + kill（经 settle 回调）
 * - 壳重启收敛：Convergence.run() 在引擎启动时执行（IPC 就绪前）
 */
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Board, Task } from '../kanban/types';
import type { KanbanStore } from '../kanban/KanbanStore';
import type { ExecutionRecord } from '../kanban/types';
import type { NotifInput } from '../notifications/types';
import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';
import type {
  ExecutionProvider,
  ExecutionResult,
} from './provider/ExecutionProvider';
import type { ProviderManager } from './provider/ProviderManager';
import { Scheduler, type SchedulerMutations, type SchedulerSettledResult } from './scheduler/Scheduler';
import { HeartbeatMonitor, type HeartbeatTimeoutEvent } from './heartbeat/HeartbeatMonitor';
import { Convergence, type ConvergenceMutations } from './Convergence';
import { VerifyGate, type VerifyGateMutations } from './VerifyGate';
import {
  ExecNotFoundError,
  ExecNotCancellableError,
  ExecNotPausedError,
  ExecNotCompletableError,
  ExecNotRunningError,
  ExecValidationError,
} from './errors';

/** 执行快照（契约 getExecutionSnapshot：running/queued 列表 + 并行上限） */
export interface ExecutionSnapshot {
  running: Array<{ taskId: string; executionStatus: string }>;
  queued: Array<{ taskId: string; executionStatus: string }>;
  maxParallel: number;
}

export interface ExecutionEngineOptions {
  /** 注入的 KanbanStore（B4 P2-1：依赖注入，禁止静态导入单例） */
  store: KanbanStore;
  /** provider 选择管理器（无 provider 注入时用 getProvider()） */
  providerManager: ProviderManager;
  /** provider 直注（测试 seam；优先于 providerManager，mock outcome 注入用） */
  provider?: ExecutionProvider;
  /** 并行上限（默认 3） */
  maxParallelTasks?: number;
  /** 心跳 idle 分钟（默认 30） */
  maxExecutionIdleMinutes?: number;
  /** V2a：看板执行结算通知走 NotificationService（settleTask + 级联 failed；缺省不发射） */
  emitNotif?: (input: NotifInput) => void;
  /** Q-017-C 观测：重启 sweep 异常/重排留痕（缺省 NOOP；main 传 logger） */
  logger?: RuntimeLogger;
  /** Q-回复落盘（2026-09-05）：流式输出日志目录（<userData>/kanban/executions；缺省不写日志，测试不依赖 fs） */
  executionsDir?: string;
}

/** 执行态变更事件负载（onExecutionUpdate 推送） */
export interface EngineExecutionUpdate {
  boardId: string;
  taskId: string;
  executionStatus: Task['executionStatus'];
  currentExecutionId?: string | null;
}

/** executions log 相对路径（<userData>/kanban/executions/e_<uuid>.log） */
function executionLogPath(executionId: string): string {
  return `kanban/executions/${executionId}.log`;
}

export class ExecutionEngine extends EventEmitter {
  private readonly store: KanbanStore;
  /** V2a：看板执行源发射（NotificationService） */
  private readonly emitNotif?: (input: NotifInput) => void;
  private readonly emittedNotifKeys = new Set<string>();
  private readonly scheduler: Scheduler;
  private readonly heartbeat: HeartbeatMonitor;
  private readonly convergence: Convergence;
  private readonly verifyGate: VerifyGate;
  private readonly provider: ExecutionProvider;
  private readonly logger: RuntimeLogger;
  /** Q-回复落盘（2026-09-05）：流式输出日志落点目录（undefined = 不写） */
  private readonly executionsDir?: string;
  private readonly mutations: SchedulerMutations & VerifyGateMutations & ConvergenceMutations;

  constructor(options: ExecutionEngineOptions) {
    super();
    this.store = options.store;
    this.provider = options.provider ?? options.providerManager.getProvider();
    this.emitNotif = options.emitNotif;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.executionsDir = options.executionsDir;
    this.heartbeat = new HeartbeatMonitor({ maxExecutionIdleMinutes: options.maxExecutionIdleMinutes ?? 30 });

    // 写面：落到 KanbanStore（system 事件 + 执行态 + 列流转）
    this.mutations = this.buildMutations();

    this.verifyGate = new VerifyGate(this.store, this.mutations);
    this.convergence = new Convergence(this.store, this.mutations);
    this.scheduler = new Scheduler(this.store, this.provider, this.mutations, {
      maxParallelTasks: options.maxParallelTasks ?? 3,
      logger: this.logger, // Q-017-C：重排入队/跳过留痕透传
    });

    // 心跳接线：timeout → 引擎层 failed + kill（HeartbeatMonitor 只 emit，引擎订阅执行）
    this.heartbeat.on('timeout', (ev: HeartbeatTimeoutEvent) => this.handleHeartbeatTimeout(ev));
  }

  /** 启动：壳重启收敛（IPC 就绪前执行，防 UI 读到未收敛态）+ Q-017 重启重排 */
  start(): void {
    this.convergence.run();
    // Q-017 核心修复：Scheduler 的 queuedQueue 是内存 Map（重启即空），Convergence 对
    // queued 任务只写 store 状态 + timeline「已重新排队」→ 无人启动，永久卡「排队中」。
    // 此处遍历 store 全部 board 的收敛后残留 queued 任务，重新塞回调度器内存队列并 kick drain。
    try {
      let swept = 0;
      for (const board of this.rawBoards()) {
        for (const task of board.tasks) {
          if (task.executionStatus !== 'queued') continue;
          swept++;
          this.scheduler.requeuePersisted(board.id, task);
        }
      }
      this.scheduler.kickNow();
      // Q-017-C 观测：sweep 规模留痕（0 也记——prod 可区分「跑了没」与「没活干」）
      this.logger.info(`[Q-017] 重启重排 sweep 完成: ${swept} 个 queued 任务`);
    } catch (err) {
      // Q-017-C：sweep/kick 静默失败 = queued 永久卡死且无痕——必须落 error 日志
      this.logger.error(`[Q-017] 重启重排 sweep 异常: ${(err as Error).message}`);
    }
  }

  /** 单任务执行 / 父卡展开（契约 executeTask） */
  executeTask(boardId: string, taskId: string) {
    const res = this.scheduler.executeTask(boardId, taskId);
    return res;
  }

  /** 取消（queued 出队 / running 句柄 cancel；幂等） */
  async cancel(boardId: string, taskId: string): Promise<void> {
    await this.scheduler.cancel(boardId, taskId);
  }

  /** 暂停（仅 running → paused，O-11：kill 进程 + 结果丢弃保留现场） */
  async pause(boardId: string, taskId: string): Promise<void> {
    const task = this.requireTask(boardId, taskId);
    if (task.executionStatus !== 'running') {
      throw new ExecNotPausedError(`非 running 不可暂停（当前 ${task.executionStatus}）`, task.executionStatus);
    }
    await this.scheduler.cancel(boardId, taskId);
    this.setExecutionStatus(taskId, 'paused', '已暂停', 'pause（O-11 标记暂停 + 结果丢弃保留现场）');
    this.heartbeat.stop(taskId);
  }

  /** 恢复（仅 paused → running，重新执行） */
  async resume(boardId: string, taskId: string): Promise<void> {
    const task = this.requireTask(boardId, taskId);
    if (task.executionStatus !== 'paused') {
      throw new ExecNotPausedError(`非 paused 不可恢复（当前 ${task.executionStatus}）`, task.executionStatus);
    }
    this.setExecutionStatus(taskId, 'queued', '已重新排队', 'resume（重新执行）');
    this.scheduler.executeTask(boardId, taskId);
  }

  /** 手动完成（interrupted/failed → succeeded + 列→verify，走 VerifyGate） */
  manualComplete(boardId: string, taskId: string) {
    return this.verifyGate.manualComplete(boardId, taskId);
  }

  /** 人工确认完成（verify 列 → done 列，走 VerifyGate 把关） */
  confirmVerify(boardId: string, taskId: string) {
    return this.verifyGate.confirmVerify(boardId, taskId);
  }

  /** 执行快照（契约 getExecutionSnapshot） */
  getExecutionSnapshot(boardId?: string): ExecutionSnapshot {
    const snap = this.scheduler.getSnapshot(boardId);
    return { running: snap.running, queued: snap.queued, maxParallel: snap.maxParallel };
  }

  /**
   * 审批响应回 ACP（B4 §4.2）：转发到当前执行句柄的 respondPermission。
   * 任务非 running/无响应通道 → false（ApprovalManager 幂等已防重复）。
   */
  respondApproval(taskId: string, requestId: string, approved: boolean, reason?: string): boolean {
    return this.scheduler.respondApproval(taskId, requestId, approved, reason);
  }

  /** 延长执行（Q-026）：重置心跳窗口（仅 running 有效；非 running 抛 exec-not-running） */
  extendExecution(boardId: string, taskId: string): { taskId: string; executionStatus: string; idleResetAt: string } {
    const task = this.requireTask(boardId, taskId);
    if (task.executionStatus !== 'running') {
      throw new ExecNotRunningError(`非 running 无需延长（当前 ${task.executionStatus}）`, task.executionStatus);
    }
    this.heartbeat.reset(taskId);
    return { taskId, executionStatus: 'running', idleResetAt: new Date().toISOString() };
  }

  /** 终止执行（B4 AcEditor 桥：AC 修订中断；scheduler.cancel + interrupted 写） */
  async interruptExecution(boardId: string, taskId: string, reason: string, detail: string): Promise<void> {
    await this.scheduler.cancel(boardId, taskId);
    this.setExecutionStatus(taskId, 'interrupted', reason, detail);
    this.heartbeat.stop(taskId);
  }

  /** 旧 execution record 标"已废弃（AC 修订）"（B4 AcEditor 桥；execution 类条目 B3 调度层写权） */
  markExecutionDeprecated(boardId: string, taskId: string, executionId: string): void {
    const board = this.rawBoard(boardId);
    const task = board?.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const item = task.timeline.find(
      (x) => x.type === 'execution' && x.execution && x.execution.outputPath?.includes(executionId),
    );
    if (item && item.execution) {
      item.execution.status = 'interrupted';
      item.content = `${item.content}（已废弃：AC 修订）`;
      this.flushStore();
    }
  }

  /** 清理（测试/退出：心跳计时器 + scheduler 停止） */
  dispose(): void {
    this.heartbeat.clearAll();
  }

  // ─────────────────────────── Q-回复落盘：流式输出日志（2026-09-05） ───────────────────────────

  /** 日志绝对路径（executionsDir 未配置 / executionId 空 → null = 不写） */
  private execLogFilePath(executionId: string): string | null {
    if (!this.executionsDir || !executionId) return null;
    return join(this.executionsDir, `${executionId}.log`);
  }

  /** 执行开始：确保目录存在并清空建文件（幂等；失败仅留痕不阻断执行） */
  private ensureExecLog(executionId: string): void {
    const p = this.execLogFilePath(executionId);
    if (!p) return;
    try {
      mkdirSync(this.executionsDir!, { recursive: true });
      writeFileSync(p, '', 'utf8');
    } catch (err) {
      this.logger.warn(`[exec-log] 日志初始化失败 ${p}: ${(err as Error).message}`);
    }
  }

  /** 流文本/错误 summary 追加（同步 append；ENOENT 时兜底建目录重试一次） */
  private appendExecLog(executionId: string, text: string): void {
    const p = this.execLogFilePath(executionId);
    if (!p) return;
    try {
      appendFileSync(p, text, 'utf8');
    } catch {
      try {
        mkdirSync(this.executionsDir!, { recursive: true });
        appendFileSync(p, text, 'utf8');
      } catch (err) {
        this.logger.warn(`[exec-log] 追加失败 ${p}: ${(err as Error).message}`);
      }
    }
  }

  // ─────────────────────────── 内部：mutation 写面 ───────────────────────────

  /**
   * B1 store 内部数据引用（B3 design：系统管理字段写属 L3 引擎层，B1 updateTask
   * 不承载 executionStatus/currentExecutionId/timeline；getBoard 返回深拷贝只读）。
   * 直写 store.data（同主进程，不经 IPC），不改 B1 代码。
   */
  private rawBoards(): Board[] {
    return (this.store as unknown as { data: { boards: Board[] } }).data.boards;
  }

  /**
   * 🔴-2 B3 高优：执行态持久化断链修复——rawBoards 直写执行态后同步 flush 落盘。
   * 复用 KanbanStore 现有公开 flushSync()（B1 测试钩子，同步原子写），保证每次执行态
   * 写入（queued/running/succeeded/failed/cancelled/interrupted/paused/timeline execution
   * 记录）立即落盘，壳重启 Convergence 可读到已收敛态（Q-017）。
   */
  private flushStore(): void {
    this.store.flushSync();
  }

  private rawBoard(boardId: string): Board | null {
    return this.rawBoards().find((b) => b.id === boardId) ?? null;
  }

  private findTaskById(taskId: string): Task | null {
    for (const board of this.rawBoards()) {
      const t = board.tasks.find((x) => x.id === taskId);
      if (t) return t;
    }
    return null;
  }

  private findBoardIdOf(taskId: string): string | null {
    for (const board of this.rawBoards()) {
      if (board.tasks.some((t) => t.id === taskId)) return board.id;
    }
    return null;
  }

  private buildMutations(): SchedulerMutations & VerifyGateMutations & ConvergenceMutations {
    const store = this.store;
    const self = this;

    return {
      // SchedulerMutations
      enqueueTask: (taskId, executionId) => {
        self.setExecutionRecord(taskId, 'queued', executionId);
        self.system(taskId, '已排队', `enqueue execution=${executionId}`);
      },
      startTask: (taskId, executionId, startedAt) => {
        // running 迁移唯一入口（onStatus 回调）；幂等：已 running 不重复写
        const task = self.findTaskById(taskId);
        if (task && task.executionStatus === 'running') return;
        self.setExecutionRecord(taskId, 'running', executionId);
        self.ensureExecLog(executionId); // Q-回复落盘：执行开始建/清空日志文件（同 executionId 重跑幂等清空）
        self.heartbeat.reset(taskId);
        self.system(taskId, '执行开始', `startedAt=${startedAt}`);
      },
      settleTask: (taskId, result) => {
        // selfCheck 判定（Q-015）：passed=true → succeeded + 列→verify；false/异常 → failed。
        // acp 无 selfCheck 成功 → 结算 succeeded（不级联失败传播 E15）+ 列→verify 自动流转
        // （2026-09-05 体验改进；VerifyGate 单点改动，settleTask 侧零改动）。
        const boardId = self.findBoardIdOf(taskId);
        if (boardId === null) return 'failed';
        self.heartbeat.stop(taskId);
        // 🟡-4：applyResult 前捕获 executionId（markSucceeded 会清 currentExecutionId，
        // execution record 必须用本次执行的 e_<seq>，独立不指向旧执行）
        const executionId = self.findTaskById(taskId)?.currentExecutionId ?? null;
        const outcome = self.verifyGate.applyResult(boardId, taskId, {
          exitCode: result.exitCode,
          // Q-020 失败可观测性：summary（provider 真实失败原因）透传——此前写死 ''，
          // VerifyGate 失败路径拿不到真实原因，timeline/通知只有通用判定文案；
          // 缺省 ''（failRunning 心跳超时注入等无 summary 路径 → VerifyGate 空串分支保持现状文案）
          summary: result.summary ?? '',
          outputPath: executionLogPath(''),
          selfCheck: result.selfCheck ?? undefined,
        });
        self.writeExecutionRecord(taskId, result, outcome.executionStatus, executionId);
        // Q-回复落盘：失败执行把 provider 真实原因追加日志尾部（成功路径 summary 已有「执行结果」comment）
        if (outcome.executionStatus !== 'succeeded' && result.summary && executionId) {
          self.appendExecLog(executionId, `\n[失败] ${result.summary}\n`);
        }
        // Q-022 会话复用：结算回写 task.acpSessionId（成功/失败都写——会话已建立，重跑 resume
        // 续用，agent 看得到上次上下文）；写在 writeExecutionRecord 之后的 flush 会带上。
        // onResult 不带 sessionId（会话未建立，如 cwd 防御失败）→ 不写保持 undefined
        if (result.sessionId) {
          const settled = self.findTaskById(taskId);
          if (settled) settled.acpSessionId = result.sessionId;
          self.flushStore();
        } else if (result.resumeFailed) {
          // Q-025：resume 失败（如损坏会话日志 -32603）且降级 newSession 也失败 → 清空引用——
          // 损坏 id 不留（下次执行不再白试 resume 坏 id + 白降级一次）；cwd mismatch 降级成功
          // 走上面新 id 覆盖分支，旧引用正常被替换
          const settled = self.findTaskById(taskId);
          if (settled && settled.acpSessionId) {
            settled.acpSessionId = undefined;
            self.flushStore();
          }
        }
        // V2a §3.2：succeeded 在此发射（info 不推送）；failed 必经 setExecutionStatus（markFailed/级联/死锁）
        // ——failed 发射收敛在该单一出口，防止结算+状态双写路径各发一条（实测双发）
        if (outcome.executionStatus === 'succeeded') {
          self.maybeEmitExecutionNotif(boardId, taskId, 'succeeded', '执行完成');
        }
        return outcome.executionStatus === 'succeeded' ? 'succeeded' : 'failed';
      },
      cancelTask: (taskId) => {
        self.setExecutionStatus(taskId, 'cancelled', '已取消', 'cancelExecution');
        self.heartbeat.stop(taskId);
      },
      failQueuedDependency: (taskId, depId) => {
        self.setExecutionStatus(taskId, 'failed', '依赖失败', `依赖 ${depId} 失败（E15 级联）`);
        self.heartbeat.stop(taskId);
      },
      failDeadlock: (parentId) => {
        self.setExecutionStatus(parentId, 'failed', '死锁', '依赖环检测（E16）');
        self.heartbeat.stop(parentId);
      },
      failQueuedTask: (taskId, reason, detail) => {
        // Q-017：启动失败/重启重排缺 AC——任务没跑起来 ≠ succeeded → failed + system 事件
        self.setExecutionStatus(taskId, 'failed', reason, detail);
        self.clearExecutionId(taskId);
        self.heartbeat.stop(taskId);
      },
      keepQueued: (taskId) => {
        self.system(taskId, '已重新排队', '壳重启收敛（Q-017）');
        self.flushStore();
      },
      deriveParent: (parentId, derived) => {
        self.setExecutionStatus(parentId, derived, '父卡派生', `父卡状态 ${derived}`);
      },
      onStreamEvent: (taskId, ev) => {
        // agent_message_chunk = 活动心跳（Q-026）：重置 idle 计时器
        const e = ev as { kind?: string; text?: string };
        if (e?.kind === 'text_chunk') {
          self.heartbeat.reset(taskId);
          // Q-回复落盘（2026-09-05）：流文本同步 append 落盘（本地 ssd + 文本量小，简单正确优先；
          // 无 executionsDir / 无 currentExecutionId → 跳过）
          const execId = self.findTaskById(taskId)?.currentExecutionId ?? null;
          if (execId && e.text) self.appendExecLog(execId, e.text);
        }
      },
      // VerifyGateMutations
      markSucceeded: (taskId, reason, detail) => {
        // 🟡-4：succeeded 也清 currentExecutionId（与 markFailed/收敛对称）——重跑后
        // execution record 独立（writeExecutionRecord 里 currentExecutionId 为空时回退随机 id），
        // 不再指向旧执行；重跑 Q-023 记录追溯走 timeline execution 条目（B5 round-trip 已宽松 e_/tl_ 格式校验）
        self.setExecutionStatus(taskId, 'succeeded', reason, detail);
        self.clearExecutionId(taskId);
        self.heartbeat.stop(taskId);
      },
      markFailed: (taskId, reason, detail) => {
        self.setExecutionStatus(taskId, 'failed', reason, detail);
        self.clearExecutionId(taskId);
        self.heartbeat.stop(taskId);
      },
      moveToColumn: (taskId, columnId) => {
        const boardId = self.findBoardIdOf(taskId);
        if (boardId !== null) store.moveTask(boardId, taskId, columnId);
      },
      fillManualResult: (taskId, summary) => {
        const boardId = self.findBoardIdOf(taskId);
        if (boardId === null) return;
        // Q-026：执行结果回填标记 agent 来源——与用户评论区分（user 通道可编辑/删除，agent 条目只读）
        store.addComment({ boardId, taskId, content: `执行结果：${summary}`, source: { type: 'agent', provider: 'dsh' } });
      },
    };
  }

  private async handleHeartbeatTimeout(ev: HeartbeatTimeoutEvent): Promise<void> {
    const boardId = this.findBoardIdOf(ev.taskId);
    if (boardId === null) return;
    // 🟡-2 双 kill 竞态修复：不调 scheduler.cancel（避免 cancelled 与 settleAll 竞态）——
    // 走 scheduler.failRunning：kill 进程 + 注入 failed 结算（pendingSettlements + settleTask
    // → VerifyGate markFailed，恰好一次）；同帧 provider settle 迟到也不覆盖（failRunning 清既有 pending）
    this.scheduler.failRunning(ev.taskId);
    // 契约 Q-026 语义：failed + kill + 回写（system 事件由 settleTask→markFailed 写入）
  }

  private setExecutionRecord(taskId: string, status: 'queued' | 'running', executionId: string): void {
    const boardId = this.findBoardIdOf(taskId);
    if (boardId === null) return;
    const board = this.rawBoard(boardId);
    const task = board?.tasks.find((t) => t.id === taskId);
    if (!task) return;
    // 系统管理字段直写（B3 调度层写权，B1 updateTask 不承载）
    task.executionStatus = status;
    task.currentExecutionId = executionId;
    task.updatedAt = new Date().toISOString();
    this.flushStore();
    this.emit('execution-update', { boardId, taskId, executionStatus: status, currentExecutionId: executionId } satisfies EngineExecutionUpdate);
  }

  /** V2a §3.2：看板执行源——settleTask 终态与级联 failed 发射；key 去重防结算/级联双发 */
  private maybeEmitExecutionNotif(boardId: string, taskId: string, status: 'succeeded' | 'failed', detail: string): void {
    if (!this.emitNotif) return;
    const task = this.findTaskById(taskId);
    const key = `${taskId}:${status}`;
    if (this.emittedNotifKeys.has(key)) return;
    this.emittedNotifKeys.add(key);
    const title = `任务 · ${task?.title ?? taskId}`;
    try {
      this.emitNotif({
        source: 'board-exec',
        severity: status === 'failed' ? 'error' : 'info',
        title: status === 'failed' ? `${title}【失败】` : title,
        body: detail,
        link: { kind: 'task', boardId, taskId },
        meta: { executionId: task?.currentExecutionId ?? null, mode: task?.executionMode ?? null },
      });
    } catch { /* 通知失败不影响结算 */ }
  }

  private setExecutionStatus(taskId: string, status: Task['executionStatus'], reason: string, detail: string): void {
    const boardId = this.findBoardIdOf(taskId);
    if (boardId === null) return;
    const board = this.rawBoard(boardId);
    if (!board) return;
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.executionStatus = status;
    task.updatedAt = new Date().toISOString();
    this.pushSystem(board, taskId, reason, detail);
    this.flushStore();
    // V2a §3.2：级联/直接终态失败路径发射（正常结算走 settleTask）
    if (status === 'failed') this.maybeEmitExecutionNotif(boardId, taskId, 'failed', detail || reason);
    this.emit('execution-update', { boardId, taskId, executionStatus: status, currentExecutionId: task.currentExecutionId } satisfies EngineExecutionUpdate);
  }

  private clearExecutionId(taskId: string): void {
    const boardId = this.findBoardIdOf(taskId);
    if (boardId === null) return;
    const board = this.rawBoard(boardId);
    const task = board?.tasks.find((t) => t.id === taskId);
    if (task) task.currentExecutionId = null;
  }

  private writeExecutionRecord(taskId: string, result: SchedulerSettledResult, status: string, executionId: string | null): void {
    const boardId = this.findBoardIdOf(taskId);
    if (boardId === null) return;
    const board = this.rawBoard(boardId);
    if (!board) return;
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return;
    // execution 记录 timeline（B1 P1-1 ② 层：execution 类条目仅 B3 调度层写）
    // 🔴-1：条目 id 用 executionId（e_<seq>）——本参数由 settleTask 在 applyResult 前捕获，
    // 不受 markSucceeded/markFailed 清 currentExecutionId 影响（🟡-4：succeeded 后重跑记录独立）
    const execId = executionId ?? `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      status: status as ExecutionRecord['status'],
      command: `execute ${task.id}`,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      outputPath: executionId ? executionLogPath(executionId) : null,
      selfCheck: result.selfCheck,
    };
    task.timeline.push({
      id: execId,
      type: 'execution',
      content: `执行 ${status}`,
      attachments: [],
      createdAt: new Date().toISOString(),
      author: null,
      source: { type: 'agent', provider: 'dsh' },
      execution: record as Task['timeline'][number]['execution'],
    });
    task.updatedAt = new Date().toISOString();
    this.flushStore();
  }

  private pushSystem(board: Board, taskId: string, reason: string, detail: string): void {
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.timeline.push({
      id: `tl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'system',
      content: `${reason}：${detail}`,
      attachments: [],
      createdAt: new Date().toISOString(),
      author: 'system',
      source: { type: 'system' },
      execution: null,
    });
  }

  private system(taskId: string, reason: string, detail: string): void {
    const boardId = this.findBoardIdOf(taskId);
    if (boardId === null) return;
    const board = this.rawBoard(boardId);
    if (board) this.pushSystem(board, taskId, reason, detail);
  }

  private requireTask(boardId: string, taskId: string): Task {
    const board = this.store.getBoard(boardId);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) throw new ExecNotFoundError(`任务不存在: ${taskId}`);
    return task;
  }
}

// 类型再导出（ExecIpc/B4 AcEditor 桥接点消费）
export { ExecNotCancellableError, ExecNotPausedError, ExecNotCompletableError, ExecValidationError };
