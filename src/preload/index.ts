import { contextBridge, ipcRenderer } from 'electron';

/**
 * 壳框架 preload 桥（S8 D5/D6）：
 * 原 5 方法（retry/openLogs/install/cancelInstall/installStatus，S2 引导态/进度轮询）
 * + getDshStatus（壳页首载取初值，之后事件驱动）+ onStatus(cb)（hull:status 固定单通道订阅）
 * + openSettings + checkDshUpdate（D6 导航入口）。
 * 白名单固定、不透传回调、不暴露任意通道（D5 注记：S1「无事件订阅」纪律系防任意通道透传，
 * hull:status 为固定单通道受控扩展，不违背纪律精神）。
 * sandbox 兼容：只 require electron 内置模块。仅随壳页挂载（webPreferences.preload，D3）。
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
  /** 首载取 hull:status 初值（D5：之后事件驱动） */
  getDshStatus: () => ipcRenderer.invoke('hull:getDshStatus'),
  /** 订阅 hull:status 推送（主进程单向，固定通道；返回取消订阅函数） */
  onStatus: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('hull:status', listener);
    return () => ipcRenderer.removeListener('hull:status', listener);
  },
  /** D6：壳导航设置入口 → hull:openSettings → settingsWindow.show() */
  openSettings: () => ipcRenderer.invoke('hull:openSettings'),
  /** D6：壳导航升级入口 → main runCheck → 原生 dialog */
  checkDshUpdate: () => ipcRenderer.invoke('hull:promptDshUpdate'),
});
