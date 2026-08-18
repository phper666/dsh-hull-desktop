import { contextBridge, ipcRenderer } from 'electron';

/**
 * 最小 preload 桥（设计 D6 / 契约 #7 + S2 v0.2 #7/#8/#6）：
 * 白名单仅 5 方法（retry/openLogs/install/cancelInstall/installStatus），
 * 不透传回调、不暴露任意通道、无事件订阅（进度走 installStatus 轮询，B6）。
 * sandbox 兼容：只 require electron 内置模块。
 *
 * ⚠️ 仅随壳自有占位页挂载（session.setPreloads 由 WindowManager 控制）；
 * 官方 UI 加载时清空 preload（零注入，CON-R001）。
 */
contextBridge.exposeInMainWorld('hull', {
  /** 失败态重试（等价 RuntimeManager.start()） */
  retry: () => ipcRenderer.invoke('hull:retry'),
  /** 打开日志目录 */
  openLogs: () => ipcRenderer.invoke('hull:openLogs'),
  /** 触发首装/重装（引导态安装按钮） */
  install: () => ipcRenderer.invoke('hull:install'),
  /** 取消安装（进度视图取消按钮） */
  cancelInstall: () => ipcRenderer.invoke('hull:cancelInstall'),
  /** 轮询安装状态（phase + 进度载荷；250ms 由页面控制，非事件推送） */
  installStatus: () => ipcRenderer.invoke('hull:installStatus'),
});
