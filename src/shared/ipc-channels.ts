/**
 * IPC channel 白名单集中常量源（B3 design §4.8 P2-5，冻结）
 *
 * 唯一事实源：B1 16 数据原语 + createColumn（2026-09-03 BUG-1 修复新增）+ B5 2 导出/导入 + B3 10 执行控制 = 29 channel 共面。
 * preload 按清单逐条 exposeInMainWorld（src/preload/index.ts 桥），禁止散落硬编码。
 * 新增 channel 必须更新本清单（评审 checklist 项）。
 */

/** B1 数据原语 16 channel（feishu-b1-m2 契约 §接口清单）+ createColumn（BUG-1 修复）+ B5 导出/导入 2 channel */
export const KANBAN_IPC_CHANNELS = [
  'kanban:getBoards',
  'kanban:createBoard',
  'kanban:updateBoard',
  'kanban:deleteBoard',
  'kanban:getTasks',
  'kanban:createTask',
  'kanban:updateTask',
  'kanban:moveTask',
  'kanban:deleteTask',
  'kanban:addComment',
  'kanban:deleteComment',
  'kanban:createColumn',
  'kanban:updateColumn',
  'kanban:deleteColumn',
  'kanban:archiveTask',
  'kanban:restoreTask',
  'kanban:purgeTask',
  'kanban:exportBoard',
  'kanban:importBoard',
] as const;

/** B3 执行控制 10 channel（feishu-b3-m2 契约 §接口清单：9 invoke + 1 event） */
export const KANBAN_EXEC_IPC_CHANNELS = [
  'kanban:executeTask',
  'kanban:cancelExecution',
  'kanban:pauseExecution',
  'kanban:resumeExecution',
  'kanban:manualComplete',
  'kanban:confirmVerify',
  'kanban:approvalRespond',
  'kanban:extendExecution',
  'kanban:getExecutionSnapshot',
  'kanban:onExecutionUpdate',
] as const;

/** B4 执行集成 4 channel（feishu-b4-m2 契约 §接口清单：2 event + 2 invoke；approvalRespond 已列 B3）
 *  🟡-3：onPermissionSettled 新增（ApprovalManager 'settled' → B2 push 式关审批弹窗） */
export const KANBAN_B4_EXEC_IPC_CHANNELS = [
  'kanban:onPermissionRequest',
  'kanban:onPermissionSettled',
  'kanban:editAcceptanceCriteria',
  'kanban:getAgentProviders',
] as const;

/** S1 扫描 4 + S2 操作 7（feishu-s1/s2-skills-api-contract §接口清单）+ hull:showSkills 壳导航 */
export const SKILLS_IPC_CHANNELS = [
  'hull:showSkills',
  // S1 只读
  'skills:scan',
  'skills:getSnapshot',
  'skills:searchRemote',
  'skills:getStatus',
  // S2 操作
  'skills:remove',
  'skills:upgrade',
  'skills:setEnabled',
  'skills:getDisabledList',
  'skills:getTrashList',
  'skills:restoreFromTrash',
  'skills:getOperationLog',
] as const;

/** 全部 channel 白名单（B1+B5+B3+B4+S1 共面） */
export const ALL_IPC_CHANNELS = [
  ...KANBAN_IPC_CHANNELS,
  ...KANBAN_EXEC_IPC_CHANNELS,
  ...KANBAN_B4_EXEC_IPC_CHANNELS,
  ...SKILLS_IPC_CHANNELS,
] as const;

export type KanbanIpcChannel = (typeof KANBAN_IPC_CHANNELS)[number];
export type KanbanExecIpcChannel = (typeof KANBAN_EXEC_IPC_CHANNELS)[number];
export type KanbanB4ExecIpcChannel = (typeof KANBAN_B4_EXEC_IPC_CHANNELS)[number];
export type IpcChannel = (typeof ALL_IPC_CHANNELS)[number];
