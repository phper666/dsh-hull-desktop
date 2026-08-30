/**
 * 工作台连接 IPC（connections:*）：
 * platforms（schema）/ list（脱敏）/ save（加密存储 + 同步验证）/ test（重验证）/ delete。
 * 验证在 main 侧以解密凭据调用平台适配器；渲染层只接触脱敏视图与状态。
 */
import { ipcMain } from 'electron';

import type { ConnectionsStore } from './ConnectionsStore';
import { getPlatformAdapter } from './PlatformRegistry';
import type { PlatformId } from './types';

export interface ConnectionsIpcOptions {
  store: ConnectionsStore;
}

export function registerConnectionsIpc(options: ConnectionsIpcOptions): void {
  const { store } = options;

  ipcMain.handle('connections:platforms', () => ({ ok: true, data: store.platforms() }));

  ipcMain.handle('connections:list', () => ({ ok: true, data: store.list() }));

  ipcMain.handle('connections:save', async (_e, input: { id?: string; platform: PlatformId; name?: string; fields?: Record<string, string> }) => {
    try {
      // 保存（加密落盘）→ 立即验证（≤10s）→ 状态落盘 → 返回最终脱敏视图
      const view = store.save({
        id: input?.id,
        platform: input?.platform,
        name: input?.name || '',
        fields: input?.fields || {},
      });
      const cred = store.getCredentials(view.id);
      if (!cred) return { ok: true, data: view };
      const adapter = getPlatformAdapter(cred.platform);
      if (!adapter) return { ok: true, data: view };
      let result;
      try {
        result = await adapter.verify(cred.fields);
      } catch (err) {
        result = { ok: false, message: (err as Error).message };
      }
      store.recordResult(view.id, result.ok ? 'connected' : 'failed', result.ok ? undefined : result.message);
      const updated = store.list().find((c) => c.id === view.id) || view;
      return { ok: true, data: updated, verify: result };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  ipcMain.handle('connections:test', async (_e, id: string) => {
    const cred = store.getCredentials(id);
    if (!cred) return { ok: false, message: '连接不存在' };
    const adapter = getPlatformAdapter(cred.platform);
    if (!adapter) return { ok: false, message: '不支持的平台' };
    let result;
    try {
      result = await adapter.verify(cred.fields);
    } catch (err) {
      result = { ok: false, message: (err as Error).message };
    }
    store.recordResult(id, result.ok ? 'connected' : 'failed', result.ok ? undefined : result.message);
    return { ok: true, data: { verify: result } };
  });

  ipcMain.handle('connections:delete', (_e, id: string) => ({ ok: store.delete(id) }));
}
