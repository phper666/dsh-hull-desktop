import { contextBridge, ipcRenderer } from 'electron';

/**
 * 设置页专用 preload 桥（设计 D1/B1/B2）：
 * - 白名单调用，不透传回调
 * - 页面 250ms 轮询 getSettings / getDshStatus / getHullUpdateStatus
 */
contextBridge.exposeInMainWorld('hull', {
  getSettings: () => ipcRenderer.invoke('hull:getSettings'),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('hull:setSettings', patch),

  getDshStatus: () => ipcRenderer.invoke('hull:getDshStatus'),
  checkDshUpdate: () => ipcRenderer.invoke('hull:checkDshUpdate'),
  upgradeDsh: (target: string) => ipcRenderer.invoke('hull:upgradeDsh', target),
  cancelDshUpgrade: () => ipcRenderer.invoke('hull:cancelDshUpgrade'),
  dismissDshUpdate: () => ipcRenderer.invoke('hull:dismissDshUpdate'),
  rollbackDsh: () => ipcRenderer.invoke('hull:rollbackDsh'),

  getChannel: () => ipcRenderer.invoke('hull:getChannel'),
  setChannel: (channel: string, version?: string) => ipcRenderer.invoke('hull:setChannel', channel, version),
  listVersions: () => ipcRenderer.invoke('hull:listVersions'),

  checkHullUpdate: () => ipcRenderer.invoke('hull:checkHullUpdate'),
  getHullUpdateStatus: () => ipcRenderer.invoke('hull:getHullUpdateStatus'),
  downloadHullUpdate: () => ipcRenderer.invoke('hull:downloadHullUpdate'),
  cancelHullUpdate: () => ipcRenderer.invoke('hull:cancelHullUpdate'),
  dismissHullUpdate: () => ipcRenderer.invoke('hull:dismissHullUpdate'),

  openLogs: () => ipcRenderer.invoke('hull:openLogs'),
  openDataDir: () => ipcRenderer.invoke('hull:openDataDir'),
});
