# 通知中心 V2a（NotificationService + 看板执行源）技术方案

> 判级：**复杂**（新子系统：统一通知服务 + 独立存储 + 事件推送 + 第二源接入执行引擎）→ 本文档
> 需求（用户 2026-09-03）：通知中心 V2a——底座做实 + 接第二源「看板卡片执行通知」。
> 前置：V1 见 docs/design/工作流-workflows-design.md §9（工作流首源/source 维度预留）；§9.5 交互修订；原型 C。

## 一、V1 遗留 → V2a 补齐

| V1 现状 | V2a |
|:---|:---|
| 数据寄居 workflows runs.json（50 条） | NotificationService 独立存储 `<userData>/notifications/notifications.json` |
| 渲染层 60s 轮询 | 主进程 `notifs:changed` 事件推送（onChanged → webContents.send） |
| 仅工作流源 | + 看板卡片执行源（source='board-exec'），来源筛选启用 |
| 已读 = localStorage lastReadTs（时间戳切） | 逐条 `readAt`（service 存储内） |
| runs.json 一次性导入（迁移） | 首启无 notifications.json 且 runs.json 存在 → 导入 runs（≤50）为 workflow 通知；failed → 未读，success → 已读；runs.json 原样保留（工作流卡片徽标仍读它） |

## 二、NotificationService（src/notifications/）

```
src/notifications/
  types.ts                  # NotifSource/Severity/NotifLink/NotifInput/NotifRow
  NotificationService.ts    # emit/list/markAllRead/迁移/保留/onChanged
  NotificationService.test.ts
  NotifsIpc.ts              # notifs:list / notifs:markAllRead / notifs:changed（推送）
```

- **模型**：`NotifRow { id, source: 'workflow'|'board-exec', severity: 'error'|'info', title, body, link, ts, readAt: string|null, meta }`；link 判别联合 `{ kind:'workflow', workflowId } | { kind:'task', boardId, taskId }`。
- **emit(input)**：uuid + ts 兜底 → 落盘（原子写）→ 按源保留裁剪（workflow 50 / board-exec 100，环形按 ts）→ 触发 onChanged。
- **系统推送策略（service 内聚）**：`severity==='error'` → 注入的 `systemChannel(row)`（main 接 Electron Notification，click 按 link.kind 路由：workflow → showWorkflows；task → showBoard + 打开任务详情）；info 不推送。emitter 只管 emit，不碰系统通知。
- **迁移**：`migrateFromWorkflowRuns(runsJsonPath)`——幂等（notifications.json 已存在则跳过）；导入 runs 为 workflow 通知（severity failed→error/success→info；readAt failed→null/success→ts）。

## 三、两源接入

### 3.1 工作流源（改造 §8.1 失败自动通知）

- WorkflowEngine deps 增 `emitNotif?: (input: NotifInput) => void`；**run 级完成通知全部走 service**：
  - failed → `{ severity:'error', title:'工作流 · 名【失败】', body:首条错误(截断120), link:{kind:'workflow',workflowId}, meta:{trigger,durationMs,log} }`（service 推系统通知——取代 §8.1 引擎直发，行为等价）
  - success → `{ severity:'info', readAt:now, title:'工作流 · 名', body:末步消息 }`（进中心不推送，保 V1 列表全量）
- deps.notify 保留：仅显式 notification 步骤使用（系统通知 + 不进中心，语义与 V1 一致）。
- 定时/手动来源照旧入 meta.trigger。

### 3.2 看板执行源（新增）

- **failed 发射点（唯一出口）**：`setExecutionStatus(taskId,'failed')`——结算失败（VerifyGate markFailed 内部必经）、依赖级联 E15、死锁 E16 全部汇于此；去重键 `${taskId}:failed`。实测教训：settleTask 处额外发射会双发（applyResult 内部 markFailed 先经 setExecutionStatus，且结算后 currentExecutionId 被清空导致含 executionId 的去重键失效）。
- **succeeded 发射点**：`settleTask` mutation（markSucceeded 不经 setExecutionStatus，需独立发射）——info 不推送。
- **级联边界（实测）**：E15 级联只作用于已入队任务；依赖失败时未入队的下游保持 idle，不发通知（设计确认行为）。
- 字段：title `任务 · ${taskTitle}`；link `{kind:'task', boardId, taskId}`；meta { executionId }。
- **非目标**：级联失败子任务不单独通知（根因已报）；执行中 stream 事件不通知。

## 四、渲染层（notifs.js 升级）

- 数据源切 `window.notifs.list()`；`来源：工作流` 静态 chip → 真筛选（工作流/看板执行 segments）。
- 角标 = 未读 error 数（service readAt 语义）；onChanged 推送即刷（60s 轮询保留兜底）。
- 看板执行行详情：任务/执行信息 + 「查看任务」→ `hull.showBoard()` + `window.__kanbanOpenTask(taskId)`（kanban.js 暴露 openDetail）；工作流行「查看工作流」照旧。
- localStorage lastReadTs 退役（迁移期一次性丢弃，导入的 failed 记未读——与 V1 语义近似）。

## 五、非目标（V2a）

更新可用源（dsh/Hull，v3 与「稍后再说」去重）· 通知偏好（按源/按工作流静音、免打扰，V2b 拼盘）· 失败步骤自动展开 · per-item 已读 UI（仅全读）· 多设备同步（O-4）。

## 六、风险与回退

| 风险 | 缓解 |
|:-----|:-----|
| 双系统通知（引擎直发 + service 推送） | §8.1 引擎直发路径移除，失败系统通知唯一出口 = service systemChannel |
| 迁移重复导入 | notifications.json 存在即跳过；幂等 |
| 级联/结算双发 | 去重键 Set + 级联路径 design 明确不发 |
| 批量执行通知洪峰 | board-exec 保留 100 环形 + 成功不推送 |
| 渲染层 404 断链（gitignore 事故家族） | notifs 无新 JS 文件（复用 notifs.js）；新 TS 均在 src/notifications（.ts 不在 ignore 白名单外——src/**/*.js 只忽略 JS，.ts 需确认 ignore 规则不含） |

## 七、实现管道

TDD：NotificationService（emit/保留/已读/迁移/onChanged）+ WorkflowEngine emitNotif 断言迁移 + ExecutionEngine settleTask/级联发射与去重。渲染层胶水 node --check + e2e（notifs.spec 改造：seed notifications.json 双源断言 + 迁移路径断言）。工程基线三问 ✓。
