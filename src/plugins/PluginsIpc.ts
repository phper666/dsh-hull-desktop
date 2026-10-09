/**
 * P4 插件市场 IPC 注册（设计 §1.8 / 契约 feishu-plugin-market-api-contract §接口清单）：
 *   6 channel：hull:pluginListRegistry / getInstalledPlugins / pluginInstall / pluginUpdate /
 *   pluginUninstall / getPluginStatus（通道常量唯一事实源在 src/shared/ipc-channels.ts PLUGIN_IPC_CHANNELS）。
 *   - 统一返回 { ok:true, data } | { ok:false, code, message }（PluginError 码透传，未知错误按 handler 语义兜底）
 *   - URL 不经渲染层：install 只收 entryId（entryId = name#owner 复合键，types.entryId），
 *     主进程白名单反查条目 URL（防注入，Q-105）
 *   - 主进程强制门控：installer 内部 canOperatePlugin（dsh 升级/自更新/in-flight → plugin-busy）；
 *     getPluginStatus 直接求值 canOperatePlugin（契约 §接口详情 6）
 *   - 业务逻辑在 createPluginsHandlers（纯函数工厂，可脱 Electron 单测）；registerPluginsIpc 仅 ipcMain.handle 薄壳
 *   - 注册见 src/main/index.ts bootstrap（runner/registry/installer/gate 就绪后，与 backup 服务并列）
 */
import { ipcMain } from 'electron';

import { PluginError } from './errors';
import { canOperatePlugin, type GateDeps } from './gate';
import type { Inflight, PluginInstaller } from './installer';
import type { RegistryLoadResult } from './registry';
import type { InstalledPlugin, PluginPreview, RegistryEntry } from './types';

/** 6 通道常量唯一事实源在 src/shared/ipc-channels.ts（PLUGIN_IPC_CHANNELS）；此处转出供主进程注册面消费 */
export { PLUGIN_IPC_CHANNELS } from '../shared/ipc-channels';

/** 契约统一响应包裹（PluginIpcResult 联合；code 为 kebab 错误码，UI 直接展示） */
export type PluginIpcResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export interface PluginsIpcDeps {
  /** registry 拉取（main 装配闭包：url/snapshotPath/logger；HULL_E2E_REGISTRY 覆盖已注入） */
  loadRegistry(forceRefresh: boolean): Promise<RegistryLoadResult>;
  /** 同步 installer 白名单条目（registry 刷新后保持「安装时取最新条目」口径） */
  syncEntries(entries: RegistryEntry[]): void;
  installer: PluginInstaller;
  /** 插件门控 deps（getPluginStatus 求值 canOperate；installer 内部同样强制，双向互斥） */
  gate: GateDeps;
  /** reconcile（dsh list --profile hull → InstalledPlugin[]；失败 → plugin-profile-missing） */
  reconcile(): Promise<InstalledPlugin[]>;
}

/** 门控/进行中/已装概览（契约 §接口详情 6 getPluginStatus data） */
export interface PluginStatusData {
  canOperate: ReturnType<typeof canOperatePlugin>;
  inflight: Inflight | null;
  installedCount: number;
}

function fail(err: unknown, fallbackCode: string): PluginIpcResult<never> {
  const code = err instanceof PluginError ? err.code : fallbackCode;
  return { ok: false, code, message: err instanceof Error ? err.message : String(err) };
}

/** 6 handler 业务逻辑（纯函数工厂）：每个 handler = (payload) => Promise<PluginIpcResult<...>> */
export function createPluginsHandlers(deps: PluginsIpcDeps) {
  /** 安装前置：拉 registry（缓存命中零网络）→ 同步白名单条目；失败保持现有条目（白名单兜底） */
  const refreshEntries = async (): Promise<void> => {
    try {
      const r = await deps.loadRegistry(false);
      deps.syncEntries(r.entries);
    } catch {
      /* registry 不可达 → 保持现有条目 */
    }
  };

  // hull:pluginListRegistry：{ refresh? } → { entries, source, fetchedAt? }
  // 失败 plugin-registry-unreachable（loadRegistry 内部已回落缓存/snapshot；全部不可达才抛错）
  const listRegistry = async (payload?: { refresh?: boolean }): Promise<PluginIpcResult<RegistryLoadResult>> => {
    try {
      const r = await deps.loadRegistry(payload?.refresh === true);
      deps.syncEntries(r.entries);
      return { ok: true, data: r };
    } catch (err) {
      return fail(err, 'plugin-registry-unreachable');
    }
  };

  // hull:getInstalledPlugins：{} → { plugins: InstalledPlugin[] }（契约 §接口详情 2 data 形状）
  // reconcile（runner list + profile 解析；v1 registry 无版本字段 → registryVersion=null、无 updatable，R6 v2 严格映射）
  const getInstalledPlugins = async (): Promise<PluginIpcResult<{ plugins: InstalledPlugin[] }>> => {
    try {
      return { ok: true, data: { plugins: await deps.reconcile() } };
    } catch (err) {
      return fail(err, 'plugin-profile-missing');
    }
  };

  // hull:pluginInstall：两段式（契约 §接口详情 3）
  //   { entryId }            → 白名单校验 + pack 预览 → { stage:'preview', preview }
  //   { entryId, confirm:true } → dsh add → verify → { stage:'done', installed }
  const pluginInstall = async (payload?: {
    entryId?: unknown;
    confirm?: unknown;
  }): Promise<
    PluginIpcResult<{ stage: 'preview'; preview: PluginPreview } | { stage: 'done'; installed: InstalledPlugin }>
  > => {
    const entryId = typeof payload?.entryId === 'string' ? payload.entryId : '';
    if (!entryId) return { ok: false, code: 'plugin-not-whitelisted', message: '缺少 entryId' };
    await refreshEntries(); // 安装时从 registry 取最新条目（白名单反查口径）
    try {
      // 两段式（契约 §接口详情 3）：第一段 preview / 第二段 done；InstallResult 为 stage 判别联合直通
      const res = payload?.confirm === true ? await deps.installer.install(entryId, true) : await deps.installer.install(entryId);
      return { ok: true, data: res };
    } catch (err) {
      return fail(err, 'plugin-install-failed');
    }
  };

  // hull:pluginUpdate：{ id } → { updated }（未安装 → plugin-not-installed；in-flight → plugin-busy）
  const pluginUpdate = async (payload?: { id?: unknown }): Promise<PluginIpcResult<{ updated: InstalledPlugin }>> => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    if (!id) return { ok: false, code: 'plugin-not-installed', message: '缺少插件 id' };
    try {
      return { ok: true, data: await deps.installer.update(id) };
    } catch (err) {
      return fail(err, 'plugin-update-failed');
    }
  };

  // hull:pluginUninstall：{ id } → { removed:true }（未安装 → plugin-not-installed）
  const pluginUninstall = async (payload?: { id?: unknown }): Promise<PluginIpcResult<{ removed: true }>> => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    if (!id) return { ok: false, code: 'plugin-not-installed', message: '缺少插件 id' };
    try {
      return { ok: true, data: await deps.installer.uninstall(id) };
    } catch (err) {
      return fail(err, 'plugin-uninstall-failed');
    }
  };

  // hull:getPluginStatus：{} → { canOperate, inflight, installedCount }（只读；异常 → io-error）
  const getPluginStatus = async (): Promise<PluginIpcResult<PluginStatusData>> => {
    try {
      const installed = await deps.reconcile();
      return {
        ok: true,
        data: {
          canOperate: canOperatePlugin(deps.gate),
          inflight: deps.installer.getSnapshot().inflight,
          installedCount: installed.length,
        },
      };
    } catch (err) {
      return fail(err, 'io-error');
    }
  };

  return { listRegistry, getInstalledPlugins, pluginInstall, pluginUpdate, pluginUninstall, getPluginStatus };
}

/** ipcMain 薄壳注册（业务逻辑见 createPluginsHandlers；Electron 装配面） */
export function registerPluginsIpc(deps: PluginsIpcDeps): void {
  const h = createPluginsHandlers(deps);
  ipcMain.handle('hull:pluginListRegistry', (_e, payload) => h.listRegistry(payload));
  ipcMain.handle('hull:getInstalledPlugins', () => h.getInstalledPlugins());
  ipcMain.handle('hull:pluginInstall', (_e, payload) => h.pluginInstall(payload));
  ipcMain.handle('hull:pluginUpdate', (_e, payload) => h.pluginUpdate(payload));
  ipcMain.handle('hull:pluginUninstall', (_e, payload) => h.pluginUninstall(payload));
  ipcMain.handle('hull:getPluginStatus', () => h.getPluginStatus());
}
