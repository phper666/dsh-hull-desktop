/**
 * 通知中心 IPC（notifs:*）：list / markAllRead；变更推送走 notifs:changed（main → 渲染单向事件）。
 */
import { ipcMain } from 'electron';

import type { NotificationService } from './NotificationService';
import type { NotifSource } from './types';

export function registerNotifsIpc(service: NotificationService): void {
  ipcMain.handle('notifs:list', () => ({ ok: true, data: service.list() }));
  ipcMain.handle('notifs:markAllRead', (_e, source?: NotifSource) => {
    service.markAllRead(source);
    return { ok: true };
  });
}
