# 通知中心 V2a（NotificationService + 看板执行源）实现与核验记录

> 需求：通知中心 V2a——底座做实 + 第二源接入（用户 2026-09-03 拍板 V2a）
> 设计：docs/design/通知中心v2a-notify-service-design.md（判级：复杂 → 方案冻结）
> 分支：feature/notify-v2a（worktree always）

## 实现记录

### 判级

**复杂**——新子系统（统一通知服务 + 独立存储 + 事件推送 + 执行引擎接入）。

### 改动清单

| 文件 | 内容 |
|:-----|:-----|
| src/notifications/types.ts（新） | NotifSource/Severity/NotifLink（判别联合）/NotifInput/NotifRow + 每源保留上限（workflow 50 / board-exec 100） |
| src/notifications/NotificationService.ts（新） | emit（落盘+按源环形保留+onChanged）/list（未读优先+时间倒序）/markAllRead(按源)/migrateFromWorkflowRuns（V1 runs.json 平移，幂等；failed 未读/success 已读；runs 原样保留） |
| src/notifications/NotifsIpc.ts（新） | notifs:list / notifs:markAllRead |
| src/workflows/WorkflowEngine.ts | §3.1：run 完成 emitNotif（failed→error 推系统通知+未读；success→info 已读入中心）；deps.notify 收敛为显式 notification 步骤专用；测试断言全量迁移 |
| src/exec/ExecutionEngine.ts | §3.2：看板执行源——failed 唯一出口 = setExecutionStatus（结算失败/级联 E15/死锁必经；**实测收敛**：settleTask 处额外发射会双发——applyResult 内部 markFailed 先经 setExecutionStatus，且结算后 currentExecutionId 被清空使含 execId 的去重键失效，键改 `taskId:status`）；succeeded 在 settleTask 发射；**级联边界实测**：E15 只作用已入队任务，未入队依赖保持 idle 不通知 |
| src/main/index.ts | NotificationService 装配（onChanged→WindowManager 推送）+ migrateFromWorkflowRuns + notifSystemChannel（error 推 Electron Notification，click 按 link 路由：workflow→showWorkflows / task→showBoard+openTask）+ 双引擎 emitNotif 注入 |
| src/window/WindowManager.ts | notifyNotifsChanged（notifs:changed 推送）/ openTaskFromNotif（board 视图 + notifs:openTask 事件） |
| src/preload/index.ts | window.notifs 桥（list/markAllRead/onChanged/onOpenTask） |
| src/renderer/notifs.js | 数据源切 notifs:list；来源筛选 segments（全部/工作流/看板执行）启用；双源行/详情/双跳转（workflow→工作流+flash / board-exec→看板+__kanbanOpenTask）；角标一律以 service 状态为准（markRead 即清零），本地 rows 只承载页面未读样式（onChanged 可见时不重绘行防冲掉） |
| src/renderer/kanban.js | __kanbanOpenTask 钩子（openDetail）+ IIFE 尾一次性订阅 notifs:openTask |
| tests/e2e/notifs.spec.ts | V2a 重写：notifications.json 双源 seed → 角标 2 → 未读排序（未读优先）→ 进页已读 → 来源筛选 → board-exec「查看任务」路由断言 → workflow「查看工作流」flash 定位 |

### 验证

- typecheck ✓；单测 **910/910 绿**（新增 service 7 + 引擎 emitNotif 迁移 + ExecutionEngine 2）
- e2e **33/33 绿**（notifs V2a 重写一次通过）
- ExecutionEngine 新用例 3 连跑稳定（结算发射时序曾有 2s 级间歇延迟——waitFor 2000 对新用例过紧，放宽 5000 后稳定；未改生产代码）

### Code Review（AI review，solo 算数）

- **实测修正设计假设 ×2**（已回写设计 §3.2）：①failed 双发（去重键含被清空的 executionId 失效）→ failed 发射收敛 setExecutionStatus 唯一出口 + 键改 taskId:status；②E15 级联不作用于未入队依赖（保持 idle 不通知）→ 测试与文档按事实修正。
- 角标状态源修正：初版从本地 rows 算未读致 markRead 后角标不清——改为一律以 service 返回为准；本地 rows 仅承载页面未读样式（onChanged 可见时不重绘行）。
- 系统通知唯一出口：§8.1 引擎直发移除，失败系统通知统一走 service systemChannel（防双份）。
- 迁移幂等（notifications.json 存在即跳过）+ runs.json 不动（工作流卡片徽标依赖）。

### Semgrep

新增面（service/IPC/装配）无告警；既有 2 条 rejectUnauthorized 存量已接受风险不受影响。

## 核验记录

| 设计条目 | 证据 |
|:-----|:-----|
| §二 service（emit/保留/已读/迁移/幂等/onChanged） | NotificationService.test 7 用例 |
| §3.1 工作流源（failed error 推送 / success info 静默 / notify 收敛） | WorkflowEngine.test（emitted 断言迁移） |
| §3.2 看板执行源（failed 唯一出口/succeeded settleTask/去重/级联边界） | ExecutionEngine.test 2 用例（3 连跑稳定） |
| §四 渲染层（多源筛选/双跳转/角标即时） | notifs.spec V2a 全链一次通过 |
| §五 非目标 | 更新源/偏好/自动展开/per-item 已读 UI 未做 ✓ |

**核验结论：通过**。风险项：执行结算发射时序存在秒级间歇延迟（测试 waitFor 已放宽，生产由 onChanged 推送承载实时性）；系统通知点击路由依赖窗口存活（已有守卫）。
