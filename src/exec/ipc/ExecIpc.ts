/**
 * B3 执行控制 IPC 注册（feishu-b3-m2 §执行控制 IPC 10 条）+ B4 执行集成 3 条
 * （feishu-b4-m2 §接口清单；approvalRespond 已列 B3 10 条内，B4 对齐消费）。
 *
 * main 侧：ipc.handle('kanban:xxx') → ExecutionEngine/ApprovalManager/ProviderRegistry/
 * AcEditor。错误统一转 { ok:false, code, message }（code 取 HullError.code，exec-* 集）。
 * renderer 经 preload 桥（window.exec）消费。
 *
 * 依赖注入：ExecutionEngine/ApprovalManager/ProviderRegistry/AcEditor 构造入参注入，
 * 测试可注入假实现（不做真实 IPC，测 handler 逻辑 + channel 白名单一致性）。
 */
import { ipcMain as defaultIpcMain, type IpcMain, type WebContents } from 'electron';
import { HullError } from '../../shared/errors';
import { KANBAN_EXEC_IPC_CHANNELS, KANBAN_B4_EXEC_IPC_CHANNELS } from '../../shared/ipc-channels';
import type { ExecutionEngine, EngineExecutionUpdate } from '../ExecutionEngine';
import type { ApprovalManager, ApprovalDecision } from '../approval/ApprovalManager';
import type { PermissionRequestEvent } from '../approval/ApprovalManager';
import type { ProviderRegistry } from '../provider/ProviderRegistry';
import type { AcEditor, AcceptanceCriteriaInput } from '../approval/AcEditor';

/** B3+B4 执行 channel 白名单（测试断言一致性用） */
export const EXEC_IPC_CHANNELS = [...KANBAN_EXEC_IPC_CHANNELS, ...KANBAN_B4_EXEC_IPC_CHANNELS] as const;
export type ExecIpcChannel = (typeof EXEC_IPC_CHANNELS)[number];

/** IPC 统一响应包裹（对齐 B1 KanbanIpc） */
export type ExecIpcResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

/** 同步 handler 包裹 */
function toResult<T>(fn: () => T): ExecIpcResult<T> {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    const code = err instanceof HullError ? err.code : 'unknown';
    return { ok: false, code, message: (err as Error).message };
  }
}

/** 异步 handler 包裹 */
async function toResultAsync<T>(fn: () => Promise<T>): Promise<ExecIpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const code = err instanceof HullError ? err.code : 'unknown';
    return { ok: false, code, message: (err as Error).message };
  }
}

/** 审批请求事件负载（onPermissionRequest 推送） */
export interface PermissionRequestPayload {
  boardId: string;
  taskId: string;
  title: string;
  requestId: string;
  message: string;
  queuePosition: number;
  deadlineAt: string;
}

/** 执行更新事件负载（onExecutionUpdate 推送） */
export interface ExecutionUpdatePayload {
  boardId?: string;
  taskId: string;
  executionStatus: string;
  currentExecutionId?: string | null;
  parallel?: { running: number; queued: number };
  idleResetAt?: string;
}

export interface ExecIpcDeps {
  engine: ExecutionEngine;
  approval?: ApprovalManager;
  registry?: ProviderRegistry;
  acEditor?: AcEditor;
  /** ipcMain 注入（测试 seam；默认 electron.ipcMain） */
  ipc?: IpcMain;
  /** webContents 广播注入（测试 seam；默认 electron.webContents.getAllWebContents） */
  broadcast?: (channel: string, payload: unknown) => void;
}

/** 默认广播：全部 webContents 推送（onExecutionUpdate/onPermissionRequest） */
function defaultBroadcast(channel: string, payload: unknown): void {
  // 懒加载 electron（node:test 下不可用，测试注入 broadcast）
  const wc = require('electron') as { webContents: { getAllWebContents(): Array<{ send(c: string, p: unknown): void }> } };
  for (const w of wc.webContents.getAllWebContents()) w.send(channel, payload);
}

/**
 * 注册 B3 10 条 + B4 3 条执行 IPC。
 * 事件推送（onExecutionUpdate/onPermissionRequest）：
 * - 订阅方注册时重放当前快照
 * - 🟡-3：ExecutionEngine 'execution-update' → 实时推 onExecutionUpdate；
 *   ApprovalManager 'request' → 实时推 onPermissionRequest（B2 弹窗触发）
 */
export function registerExecIpc(deps: ExecIpcDeps): void {
  const { engine, approval, registry, acEditor } = deps;
  const ipc = deps.ipc ?? defaultIpcMain;
  const broadcast = deps.broadcast ?? defaultBroadcast;

  // ── B3 执行控制 9 invoke ──
  ipc.handle('kanban:executeTask', (_e, boardId: string, taskId: string) =>
    toResult(() => engine.executeTask(boardId, taskId))
  );
  ipc.handle('kanban:cancelExecution', (_e, boardId: string, taskId: string) =>
    toResultAsync(() => engine.cancel(boardId, taskId).then(() => ({ taskId, executionStatus: 'cancelled' })))
  );
  ipc.handle('kanban:pauseExecution', (_e, boardId: string, taskId: string) =>
    toResultAsync(() => engine.pause(boardId, taskId).then(() => ({ taskId, executionStatus: 'paused' })))
  );
  ipc.handle('kanban:resumeExecution', (_e, boardId: string, taskId: string) =>
    toResultAsync(() => engine.resume(boardId, taskId).then(() => ({ taskId, executionStatus: 'queued' })))
  );
  ipc.handle('kanban:manualComplete', (_e, boardId: string, taskId: string) =>
    toResult(() => engine.manualComplete(boardId, taskId))
  );
  ipc.handle('kanban:confirmVerify', (_e, boardId: string, taskId: string) =>
    toResult(() => engine.confirmVerify(boardId, taskId))
  );
  ipc.handle('kanban:extendExecution', (_e, boardId: string, taskId: string) =>
    toResult(() => engine.extendExecution(boardId, taskId))
  );
  ipc.handle('kanban:getExecutionSnapshot', (_e, boardId?: string) =>
    toResult(() => engine.getExecutionSnapshot(boardId))
  );
  // approvalRespond：B3 10 条内（B4 对齐消费；B2 审批弹窗响应）
  ipc.handle('kanban:approvalRespond', (_e, boardId: string, taskId: string, requestId: string, decision: string, message?: string) => {
    if (!approval) return { ok: false, code: 'exec-approval-not-pending', message: '审批模块未接线' };
    return toResult(() => {
      const d = approval.respond(boardId, taskId, requestId, decision as ApprovalDecision, message);
      return { taskId, requestId, decision: d };
    });
  });

  // ── B4 执行集成 2 invoke + 1 event ──
  ipc.handle('kanban:editAcceptanceCriteria', (_e, boardId: string, taskId: string, ac: AcceptanceCriteriaInput) => {
    if (!acEditor) return { ok: false, code: 'exec-not-running', message: 'AC 修订模块未接线' };
    return toResult(() => acEditor.editAcceptanceCriteria(boardId, taskId, ac));
  });
  ipc.handle('kanban:getAgentProviders', () => {
    if (!registry) return { ok: true, data: [] };
    return toResult(() => registry.list());
  });

  // ── B3 event：onExecutionUpdate（状态/并行池变化推送）──
  ipc.on('kanban:onExecutionUpdate-sub', (event) => {
    const wc = event.sender as WebContents;
    // 订阅即重放当前快照（首载初值）
    const snap = engine.getExecutionSnapshot();
    for (const r of snap.running) {
      wc.send('kanban:onExecutionUpdate', { boardId: undefined, taskId: r.taskId, executionStatus: r.executionStatus } as ExecutionUpdatePayload);
    }
    for (const q of snap.queued) {
      wc.send('kanban:onExecutionUpdate', { boardId: undefined, taskId: q.taskId, executionStatus: q.executionStatus } as ExecutionUpdatePayload);
    }
  });

  // ── B4 event：onPermissionRequest（审批推送，ApprovalManager 内触发）──
  if (approval) {
    ipc.handle('kanban:getPendingApprovals', () => toResult(() => approval.getPending()));
    // 🟡-3：ApprovalManager 'request' 事件 → 实时推 onPermissionRequest（B2 弹窗触发）
    approval.on('request', (ev: PermissionRequestEvent) => {
      broadcast('kanban:onPermissionRequest', ev);
    });
    // 🟡-3：ApprovalManager 'settled' 事件 → 实时推 onPermissionSettled（B2 审批弹窗 push 式关闭）
    approval.on('settled', (ev: { boardId: string; taskId: string; requestId: string; decision: string }) => {
      broadcast('kanban:onPermissionSettled', ev);
    });
  }

  // ── B3 event：onExecutionUpdate 实时推送（🟡-3：引擎状态变更 → webContents）──
  // ExecutionEngine 每次执行态写入 emit 'execution-update'，此处转发到全部 webContents。
  engine.on('execution-update', (payload: EngineExecutionUpdate) => {
    broadcast('kanban:onExecutionUpdate', payload);
  });
}
