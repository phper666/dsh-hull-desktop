import { contextBridge, ipcRenderer } from 'electron';

/**
 * 壳框架 preload 桥（S8 D5/D6）：
 * 原 5 方法（retry/openLogs/install/cancelInstall/installStatus，S2 引导态/进度轮询）
 * + getDshStatus（壳页首载取初值，之后事件驱动）+ onStatus(cb)（hull:status 固定单通道订阅）
 * + openSettings + checkDshUpdate（D6 导航入口）。
 * + B1 看板桥（kanban:* 16 原语，M2）——B2 看板 UI 消费；window.kanban。
 * + B5 看板桥扩展（kanban:exportBoard/importBoard 2 原语，M2）——导出/导入分享。
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
  /** B2：壳导航任务看板入口 → main 切 view 到 placeholder:board（官方 UI 隐藏，看板面板显示） */
  showBoard: () => ipcRenderer.invoke('hull:showBoard'),
  /** B2 补丁：壳导航 dsh web 入口 → main 恢复官方 view（Ready 复用/重载，否则占位态） */
  showWeb: () => ipcRenderer.invoke('hull:showWeb'),
});

// ─────────────────────────── B1 看板桥（M2） ───────────────────────────
/** window.kanban 16 原语（B1 契约 §接口清单）+ B5 导出/导入 2 原语（B2 看板 UI 消费） */
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
  /** B5 导出（单看板/全看板 → JSON 快照文件；取消 → {cancelled:true}） */
  exportBoard: (boardId?: string) => invoke('kanban:exportBoard', boardId),
  /** B5 导入（合并/替换；校验失败零改动） */
  importBoard: (filePath: string, mode: 'merge' | 'replace') => invoke('kanban:importBoard', filePath, mode),
});

// ─────────────────────────── B3 执行控制桥（M2） ───────────────────────────
/** window.exec B3 9 invoke + 1 event + B4 2 invoke + 1 event（B2 看板执行 UI 消费） */
contextBridge.exposeInMainWorld('exec', {
  executeTask: (boardId: string, taskId: string) => invoke('kanban:executeTask', boardId, taskId),
  cancelExecution: (boardId: string, taskId: string) => invoke('kanban:cancelExecution', boardId, taskId),
  pauseExecution: (boardId: string, taskId: string) => invoke('kanban:pauseExecution', boardId, taskId),
  resumeExecution: (boardId: string, taskId: string) => invoke('kanban:resumeExecution', boardId, taskId),
  manualComplete: (boardId: string, taskId: string) => invoke('kanban:manualComplete', boardId, taskId),
  confirmVerify: (boardId: string, taskId: string) => invoke('kanban:confirmVerify', boardId, taskId),
  approvalRespond: (boardId: string, taskId: string, requestId: string, decision: string, message?: string) =>
    invoke('kanban:approvalRespond', boardId, taskId, requestId, decision, message),
  extendExecution: (boardId: string, taskId: string) => invoke('kanban:extendExecution', boardId, taskId),
  getExecutionSnapshot: (boardId?: string) => invoke('kanban:getExecutionSnapshot', boardId),
  editAcceptanceCriteria: (boardId: string, taskId: string, ac: unknown) =>
    invoke('kanban:editAcceptanceCriteria', boardId, taskId, ac),
  getAgentProviders: () => invoke('kanban:getAgentProviders'),
  /** B3 event：执行状态/并行池变化推送（订阅返回取消函数） */
  onExecutionUpdate: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('kanban:onExecutionUpdate', listener);
    ipcRenderer.send('kanban:onExecutionUpdate-sub'); // 订阅即重放当前快照
    return () => ipcRenderer.removeListener('kanban:onExecutionUpdate', listener);
  },
  /** B4 event：审批请求推送（非阻塞弹窗触发；订阅返回取消函数） */
  onPermissionRequest: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('kanban:onPermissionRequest', listener);
    return () => ipcRenderer.removeListener('kanban:onPermissionRequest', listener);
  },
  /** 🟡-3 B4 event：审批已 settled 推送（approve/deny/超时/重启 → B2 push 式关审批弹窗；订阅返回取消函数） */
  onPermissionSettled: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('kanban:onPermissionSettled', listener);
    return () => ipcRenderer.removeListener('kanban:onPermissionSettled', listener);
  },
  getPendingApprovals: () => invoke('kanban:getPendingApprovals'),
});
