/**
 * 工作流 IPC（workflows:*）：list/get/save/delete/run/runs。
 */
import { ipcMain } from 'electron';

import type { WorkflowEngine } from './WorkflowEngine';
import type { WorkflowStore } from './WorkflowStore';
import type { WorkflowStep } from './types';

export function registerWorkflowIpc(store: WorkflowStore, engine: WorkflowEngine): void {
  ipcMain.handle('workflows:list', () => ({ ok: true, data: store.list() }));
  ipcMain.handle('workflows:get', (_e, id: string) => {
    const w = store.get(id);
    return w ? { ok: true, data: w } : { ok: false, message: '工作流不存在' };
  });
  ipcMain.handle('workflows:save', (_e, input: { id?: string; name?: string; enabled?: boolean; steps?: WorkflowStep[] }) => {
    try {
      const w = store.save({ id: input?.id, name: input?.name || '', enabled: input?.enabled, steps: input?.steps || [] });
      return { ok: true, data: w };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });
  ipcMain.handle('workflows:delete', (_e, id: string) => ({ ok: store.delete(id) }));
  ipcMain.handle('workflows:run', async (_e, id: string) => {
    try {
      const run = await engine.run(id);
      return { ok: true, data: run };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });
  ipcMain.handle('workflows:runs', (_e, workflowId?: string) => ({ ok: true, data: store.runs(workflowId) }));
}
