/**
 * 工作流 IPC（workflows:*）：list/get/save/delete/run/runs + cronPreview（v2）。
 * v2：list 注入 nextRunAt（enabled+cron 的下次触发，非法为 null）；save/delete 后调度器全量重算。
 */
import { ipcMain } from 'electron';

import { cronNext } from './cron';
import type { WorkflowScheduler } from './WorkflowScheduler';
import type { WorkflowEngine } from './WorkflowEngine';
import type { WorkflowStore } from './WorkflowStore';
import type { WorkflowStep, WorkflowTriggerCron } from './types';

export function registerWorkflowIpc(store: WorkflowStore, engine: WorkflowEngine, scheduler?: WorkflowScheduler): void {
  ipcMain.handle('workflows:list', () => {
    const now = new Date();
    return {
      ok: true,
      data: store.list().map((w) => {
        let nextRunAt: string | null = null;
        if (w.enabled && w.trigger?.type === 'cron') {
          try {
            nextRunAt = cronNext(w.trigger.expr, now).toISOString();
          } catch {
            nextRunAt = null;
          }
        }
        return { ...w, nextRunAt };
      }),
    };
  });
  ipcMain.handle('workflows:get', (_e, id: string) => {
    const w = store.get(id);
    return w ? { ok: true, data: w } : { ok: false, message: '工作流不存在' };
  });
  ipcMain.handle('workflows:save', (_e, input: { id?: string; name?: string; enabled?: boolean; steps?: WorkflowStep[]; trigger?: WorkflowTriggerCron | null }) => {
    try {
      const w = store.save({ id: input?.id, name: input?.name || '', enabled: input?.enabled, steps: input?.steps || [], trigger: input?.trigger ?? null });
      scheduler?.reschedule();
      return { ok: true, data: w };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });
  ipcMain.handle('workflows:delete', (_e, id: string) => {
    const ok = store.delete(id);
    if (ok) scheduler?.reschedule();
    return { ok };
  });
  ipcMain.handle('workflows:run', async (_e, id: string) => {
    try {
      const run = await engine.run(id);
      return { ok: true, data: run };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });
  ipcMain.handle('workflows:runs', (_e, workflowId?: string) => ({ ok: true, data: store.runs(workflowId) }));
  // v2：cron 校验 + 下 3 次触发预览（渲染层零解析逻辑，main 单点维护解析器）
  ipcMain.handle('workflows:cronPreview', (_e, input: { expr?: string }) => {
    const expr = String(input?.expr ?? '');
    try {
      const next: string[] = [];
      let cursor = new Date();
      for (let i = 0; i < 3; i++) {
        cursor = cronNext(expr, cursor);
        next.push(cursor.toISOString());
      }
      return { ok: true, data: { valid: true, next, error: null as string | null } };
    } catch (err) {
      return { ok: true, data: { valid: false, next: [] as string[], error: (err as Error).message } };
    }
  });
}
