import { contextBridge, ipcRenderer } from 'electron';

/**
 * 壳框架 preload 桥（S8 D5/D6 + S8' M1-重构 D2）：
 * 原 5 方法（retry/openLogs/install/cancelInstall/installStatus，S2 引导态/进度轮询）
 * + getDshStatus（壳页首载取初值，之后事件驱动）+ onStatus(cb)（hull:status 固定单通道订阅）
 * + openSettings + checkDshUpdate（D6 导航入口；S8' 收敛为统一映射 hull:checkDshUpdate，§4.3）。
 * + settings.ts 15 方法并入（S8' D2 单一桥：getSettings/setSettings + dsh/Hull 双通道全套 + S4 通道 + 诊断）。
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
  /** S8' D1：壳导航设置入口 → hull:showSettings → 主进程切 settings 视图（原 hull:openSettings 独立窗口移除） */
  showSettings: () => ipcRenderer.invoke('hull:showSettings'),
  /** S8' §4.3 H1：检查收敛——统一映射 hull:checkDshUpdate（无 dialog 返回结果；设置区块消费） */
  checkDshUpdate: () => ipcRenderer.invoke('hull:checkDshUpdate'),
  /** B2：壳导航任务看板入口 → main 切 view 到 placeholder:board（官方 UI 隐藏，看板面板显示） */
  showBoard: () => ipcRenderer.invoke('hull:showBoard'),
  /** B2 补丁：壳导航 dsh web 入口 → main 恢复官方 view（Ready 复用/重载，否则占位态） */
  showWeb: () => ipcRenderer.invoke('hull:showWeb'),
  /** S1：壳导航 Skills 入口 → main 切 view 到 placeholder:skills（与官方 UI 互斥） */
  showSkills: () => ipcRenderer.invoke('hull:showSkills'),

  // ─────────── S8' D2：设置页桥 15 方法并入（原 src/preload/settings.ts 删除） ───────────
  /** 读全量设置（settings.json 持久化，CON-R002 走主进程 SettingsProvider） */
  getSettings: () => ipcRenderer.invoke('hull:getSettings'),
  /** 增量更新设置 + 持久化（主进程门面 hull:setSettings 零改动） */
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('hull:setSettings', patch),
  /** dsh 升级：确认卡片「立即升级」（§4.5 M1：phase=confirm → hull:status → 确认卡片 → hull:upgradeDsh） */
  upgradeDsh: (target: string) => ipcRenderer.invoke('hull:upgradeDsh', target),
  /** dsh 升级取消（installing 段） */
  cancelDshUpgrade: () => ipcRenderer.invoke('hull:cancelDshUpgrade'),
  /** dsh 稍后再说（confirm → idle + 当日去重） */
  dismissDshUpdate: () => ipcRenderer.invoke('hull:dismissDshUpdate'),
  /** dsh 手动回滚 */
  rollbackDsh: () => ipcRenderer.invoke('hull:rollbackDsh'),
  /** S4：版本通道读取 */
  getChannel: () => ipcRenderer.invoke('hull:getChannel'),
  /** S4：版本通道设置 */
  setChannel: (channel: string, version?: string) => ipcRenderer.invoke('hull:setChannel', channel, version),
  /** S4：版本列表（pinned datalist） */
  listVersions: () => ipcRenderer.invoke('hull:listVersions'),
  /** Hull 自更新检查（无 dialog，返回 {hasUpdate, targetVersion, changeNotes}） */
  checkHullUpdate: () => ipcRenderer.invoke('hull:checkHullUpdate'),
  /** Hull 自更新快照（250ms 轮询） */
  getHullUpdateStatus: () => ipcRenderer.invoke('hull:getHullUpdateStatus'),
  /** Hull 下载 + 自动重启安装 */
  downloadHullUpdate: () => ipcRenderer.invoke('hull:downloadHullUpdate'),
  /** Hull 下载取消 */
  cancelHullUpdate: () => ipcRenderer.invoke('hull:cancelHullUpdate'),
  /** Hull 稍后再说（confirm → idle + 当日去重） */
  dismissHullUpdate: () => ipcRenderer.invoke('hull:dismissHullUpdate'),
  /** 打开数据目录（诊断） */
  openDataDir: () => ipcRenderer.invoke('hull:openDataDir'),
  /** 复制文本到剪贴板（dsh web 地址复制；走主进程，渲染侧 file:// 无 clipboard 权限） */
  copyText: (text: string) => ipcRenderer.invoke('hull:copyText', text),
  /** 打开外部浏览器（dsh web 地址浏览器访问；主进程校验 http/https） */
  openExternal: (url: string) => ipcRenderer.invoke('hull:openExternal', url),
});

// ─────────────────────────── S1 扫描 + S2 操作桥 ───────────────────────────
/** window.skills：S1 4 原语（feishu-s1-skills-api-contract）+ S2 7 原语（feishu-s2-skills-api-contract）。
 *  本地搜索 frontend-only 无通道；破坏性操作经 UI 二次确认后调用，主进程侧仍有强制守卫。 */
contextBridge.exposeInMainWorld('skills', {
  // S1 只读
  /** 触发后台扫描（幂等；返回即时快照，通常 scanning + 上次结果） */
  scan: () => invoke('skills:scan'),
  /** 当前快照（轮询至 status=ready） */
  getSnapshot: () => invoke('skills:getSnapshot'),
  /** 状态栏计数 */
  getStatus: () => invoke('skills:getStatus'),
  /** 远程 marketplace 检索 */
  searchRemote: (query: string) => invoke('skills:searchRemote', query),
  /** 远程安装（O-3：npx skills add <repo> -s <skill> -a <agent>；agent 白名单守卫） */
  installRemote: (skillRef: string, agent: string) => invoke('skills:installRemote', skillRef, agent),
  // S2 操作（二次确认 UI 之后调用）
  /** 移除（批量逐条；先备份回收站） */
  remove: (paths: string[]) => invoke('skills:remove', paths),
  /** 一键升级（staging 原子替换失败自动回滚） */
  upgrade: (path: string) => invoke('skills:upgrade', path),
  /** 禁用/启用（按物理路径粒度移目录真禁用） */
  setEnabled: (path: string, enabled: boolean) => invoke('skills:setEnabled', path, enabled),
  /** 本地来源可填（O-3：写 SKILL.md frontmatter metadata.source） */
  setSource: (path: string, source: string) => invoke('skills:setSource', path, source),
  /** 已禁用映射列表 */
  getDisabledList: () => invoke('skills:getDisabledList'),
  /** 回收站列表（顺带惰性清理 TTL/500MB） */
  getTrashList: () => invoke('skills:getTrashList'),
  /** 回收站恢复到原路径（冲突不覆盖） */
  restoreFromTrash: (trashId: string) => invoke('skills:restoreFromTrash', trashId),
  /** 破坏性操作日志（时间倒序） */
  getOperationLog: (limit?: number) => invoke('skills:getOperationLog', limit),
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
