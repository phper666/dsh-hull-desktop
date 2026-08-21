import { contextBridge, ipcRenderer } from 'electron';

/**
 * 壳框架 preload 桥（S8 D5/D6）：
 * 原 5 方法（retry/openLogs/install/cancelInstall/installStatus，S2 引导态/进度轮询）
 * + getDshStatus（壳页首载取初值，之后事件驱动）+ onStatus(cb)（hull:status 固定单通道订阅）
 * + openSettings + checkDshUpdate（D6 导航入口）。
 * + B1 看板桥（kanban:* 16 原语，M2）——B2 看板 UI 消费；window.kanban。
 * 白名单固定、不透传回调、不暴露任意通道（D5 注记：S1「无事件订阅」纪律系防任意通道透传，
 * hull:status 为固定单通道受控扩展，不违背纪律精神）。
 * sandbox 兼容：只 require electron 内置模块。仅随壳页挂载（webPreferences.preload，D3）。
 */

/** IPC 统一响应包裹（与 main 侧 KanbanIpc 对齐） */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

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

// ─────────────────────────── B1 看板桥（M2） ───────────────────────────
/** window.kanban 16 原语（B1 契约 §接口清单；B2 看板 UI 消费） */
contextBridge.exposeInMainWorld('kanban', {
  getBoards: () => invoke('kanban:getBoards'),
  createBoard: (name: string) => invoke('kanban:createBoard', name),
  updateBoard: (boardId: string, patch: unknown) => invoke('kanban:updateBoard', boardId, patch),
  deleteBoard: (boardId: string) => invoke('kanban:deleteBoard', boardId),
  getTasks: (boardId: string) => invoke('kanban:getTasks', boardId),
  createTask: (boardId: string, input: unknown) => invoke('kanban:createTask', boardId, input),
  updateTask: (boardId: string, taskId: string, patch: unknown) => invoke('kanban:updateTask', boardId, taskId, patch),
  moveTask: (boardId: string, taskId: string, toColumnId: string) => invoke('kanban:moveTask', boardId, taskId, toColumnId),
  deleteTask: (boardId: string, taskId: string) => invoke('kanban:deleteTask', boardId, taskId),
  addComment: (input: unknown) => invoke('kanban:addComment', input),
  deleteComment: (boardId: string, taskId: string, commentId: string) => invoke('kanban:deleteComment', boardId, taskId, commentId),
  updateColumn: (boardId: string, columnId: string, patch: unknown) => invoke('kanban:updateColumn', boardId, columnId, patch),
  deleteColumn: (boardId: string, columnId: string) => invoke('kanban:deleteColumn', boardId, columnId),
  archiveTask: (boardId: string, taskId: string) => invoke('kanban:archiveTask', boardId, taskId),
  restoreTask: (boardId: string, taskId: string, toColumnId?: string) => invoke('kanban:restoreTask', boardId, taskId, toColumnId),
  purgeTask: (boardId: string, taskId: string) => invoke('kanban:purgeTask', boardId, taskId),
});
