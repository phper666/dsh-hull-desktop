/**
 * B1 看板 IPC 注册（feishu-b1-m2-kanban-api-contract.md §接口清单 16 原语）
 * + B5 导出/导入 2 原语（feishu-b5-m2-kanban-api-contract.md §接口清单；导出/导入走 KanbanTransfer）
 * main 侧：ipcMain.handle('kanban:xxx') → KanbanStore/KanbanTransfer 方法。错误统一转
 * { ok:false, code, message }（code 取 HullError.code，7 错误码 + B5 import/export 错误码）。
 * renderer 经 preload 桥（src/preload/kanban.ts）消费。
 */
import { ipcMain } from 'electron';
import { join } from 'node:path';

import { HullError } from '../shared/errors';
import { KanbanStore, type AddCommentInput, type CreateTaskInput, type UpdateTaskPatch } from './KanbanStore';
import { KanbanTransfer } from './KanbanTransfer';
import { readLatestExecutionLog } from './executionLog';
import { KANBAN_STORE_ERRORS } from './types';

/** 16 个 IPC channel 白名单（B1 契约）+ 2 个 B5 导出/导入 channel */
export const KANBAN_IPC_CHANNELS = [
  'kanban:getBoards',
  'kanban:createBoard',
  'kanban:updateBoard',
  'kanban:deleteBoard',
  'kanban:getTasks',
  'kanban:createTask',
  'kanban:updateTask',
  'kanban:moveTask',
  'kanban:deleteTask',
  'kanban:addComment',
  'kanban:deleteComment',
  'kanban:createColumn',
  'kanban:updateColumn',
  'kanban:deleteColumn',
  'kanban:archiveTask',
  'kanban:restoreTask',
  'kanban:purgeTask',
  'kanban:exportBoard',
  'kanban:importBoard',
  'kanban:getExecutionLog', // Q-回复落盘（2026-09-05）：读最近一次执行流式日志（详情弹框「执行输出」）
] as const;

export type KanbanIpcChannel = (typeof KANBAN_IPC_CHANNELS)[number];

/** IPC 统一响应包裹 */
export type KanbanIpcResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

function toResult<T>(fn: () => T): KanbanIpcResult<T> {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    const code = err instanceof HullError ? err.code : 'unknown';
    return { ok: false, code, message: (err as Error).message };
  }
}

export function registerKanbanIpc(store: KanbanStore): void {
  registerKanbanIpcWithTransfer(store);
}

/** 注册含 B5 传输层（KanbanTransfer 依赖可注入，供主进程装配/测试） */
export function registerKanbanIpcWithTransfer(store: KanbanStore, transfer?: KanbanTransfer): void {
  const t = transfer ?? new KanbanTransfer({ userDataPath: store.getDataDir(), store });
  ipcMain.handle('kanban:getBoards', () => toResult(() => store.getBoards()));
  ipcMain.handle('kanban:createBoard', (_e, name: string) => toResult(() => store.createBoard(name)));
  ipcMain.handle('kanban:updateBoard', (_e, boardId: string, patch: { name?: string; order?: number; defaultModel?: string | null }) =>
    toResult(() => store.updateBoard(boardId, patch))
  );
  ipcMain.handle('kanban:deleteBoard', (_e, boardId: string) => toResult(() => store.deleteBoard(boardId)));
  ipcMain.handle('kanban:getTasks', (_e, boardId: string) => toResult(() => store.getTasks(boardId)));
  ipcMain.handle('kanban:createTask', (_e, boardId: string, input: CreateTaskInput) =>
    toResult(() => store.createTask(boardId, input))
  );
  ipcMain.handle('kanban:updateTask', (_e, boardId: string, taskId: string, patch: UpdateTaskPatch) =>
    toResult(() => store.updateTask(boardId, taskId, patch))
  );
  ipcMain.handle('kanban:moveTask', (_e, boardId: string, taskId: string, toColumnId: string) =>
    toResult(() => store.moveTask(boardId, taskId, toColumnId))
  );
  ipcMain.handle('kanban:deleteTask', (_e, boardId: string, taskId: string) =>
    toResult(() => store.deleteTask(boardId, taskId))
  );
  ipcMain.handle('kanban:addComment', (_e, input: AddCommentInput) => toResult(() => store.addComment(input)));
  ipcMain.handle('kanban:deleteComment', (_e, boardId: string, taskId: string, commentId: string) =>
    toResult(() => store.deleteComment(boardId, taskId, commentId))
  );
  // Q-026 评论更新：仅 user 评论可编辑（守卫同 deleteComment；agent/system 条目拒绝）
  ipcMain.handle('kanban:updateComment', (_e, boardId: string, taskId: string, commentId: string, content: string) =>
    toResult(() => store.updateComment(boardId, taskId, commentId, content))
  );
  ipcMain.handle('kanban:createColumn', (_e, boardId: string, name: string) => toResult(() => store.createColumn(boardId, name)));
  ipcMain.handle('kanban:updateColumn', (_e, boardId: string, columnId: string, patch: { name?: string; order?: number; color?: string; hidden?: boolean }) =>
    toResult(() => store.updateColumn(boardId, columnId, patch))
  );
  ipcMain.handle('kanban:deleteColumn', (_e, boardId: string, columnId: string) =>
    toResult(() => store.deleteColumn(boardId, columnId))
  );
  ipcMain.handle('kanban:archiveTask', (_e, boardId: string, taskId: string) =>
    toResult(() => store.archiveTask(boardId, taskId))
  );
  ipcMain.handle('kanban:restoreTask', (_e, boardId: string, taskId: string, toColumnId?: string) =>
    toResult(() => store.restoreTask(boardId, taskId, toColumnId))
  );
  ipcMain.handle('kanban:purgeTask', (_e, boardId: string, taskId: string) =>
    toResult(() => store.purgeTask(boardId, taskId))
  );
  // B5：导出/导入（kanban:exportBoard / kanban:importBoard，feishu-b5-m2 契约 §接口详情）
  ipcMain.handle('kanban:exportBoard', (_e, boardId?: string) => toResult(() => t.exportBoard(boardId)));
  ipcMain.handle('kanban:importBoard', (_e, filePath: string, mode: string) =>
    toResult(() => t.importBoard(filePath, mode as never))
  );
  // Q-回复落盘（2026-09-05）：最近一次执行的流式输出日志（无记录/文件缺失 → data: null，UI 区块隐藏）
  ipcMain.handle('kanban:getExecutionLog', (_e, boardId: string, taskId: string) =>
    toResult(() => {
      const task = store.getBoard(boardId).tasks.find((x) => x.id === taskId);
      if (!task) throw new HullError(KANBAN_STORE_ERRORS.notFound, '任务不存在');
      return readLatestExecutionLog(join(store.getDataDir(), '..'), task);
    })
  );
}
