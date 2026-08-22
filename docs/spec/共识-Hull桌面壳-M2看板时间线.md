# Hull 桌面壳（M2 看板时间线/日历视图）共识文档

> 版本：v1.2 · 更新：2026-08-22 · 维护者：phper666（PM） · 状态：已发布
> 数据来源：看板时间线/日历视图 PRD v0.2（docs/prd/2026-08-22-kanban-timeline-prd.md）
> 关联：M2 任务看板（共识-Hull桌面壳-M2看板.md，已发布）；本需求为 M2 后续规划项提升承接（原 M2 共识 §15.3「时间线/日历视图」）

## 1. 文档元信息

- **本版本变更**（v1.2，已发布）：三角色扫描 Q-051~Q-055 全部定案关闭（2026-08-22 PM 决策，solo 上下文）并回写——Q-051 迁移嵌套遍历+幂等（CON-R-timeline-004）；Q-052 startDate 契约变更传播（createTask/updateTask 可选参数向后兼容 + 契约/preload/IPC 校验同步，登记变更摘要）（CON-R-timeline-003）；Q-053 视图持久化 localStorage（key=kanban:lastView，不 bump HullSettings schema）（CON-R-timeline-005）；Q-054 日历 CJK/时区（本地时区解析 + 中文月标签 + 跨月条带按日遍历）（CON-R-timeline-002）；Q-055 时间线数据缺失兜底（updatedAt 兜底/跳过标记"时间未知" + 同时间戳按 id 稳定排序）（CON-R-timeline-001）。五条规则修订生效。
- **历史变更摘要**：v1.1（2026-08-22）未决项 U-1~U-5 全部定案关闭（用户确认推荐默认全收，结论按 PRD 默认值）；业务规则 CON-R-timeline-001~007 定案生效；状态由草稿升为已发布。v1.0（2026-08-22）首次建立（草稿）——从 PRD v0.1 提取整理为业务事实源，登记 CON-R-timeline-001~007 与 U-1~U-5。详见 §15.2。

## 2. 文档结构总览

- **覆盖**：M2 看板内新增两种视图——**时间线视图**（任务活动流沿时间轴铺开，按时间倒序）+ **日历视图**（任务按 dueDate 落格、startDate+dueDate 区间跨格）；新增 Task 字段 `startDate`；schema v1→v2 迁移（补 `startDate: null`）；视图接入复用 M2 多视图状态机（`viewNames` + render 函数 + 通用工具栏）。
- **适用范围**：仅 Hull 壳内看板展示层增量（B2 UI 层同源扩展）——不碰 DSH_HOME（CON-R002）、不改官方 UI（CON-R001）、不走 dsh 内部扩展点（纯壳内展示层，CON-R004 相容）。
- **不做事项（明确排除）**：实时协作/共享日历（多用户同步看板日历）；任务自动排期（按依赖/工期自动计算 start/due）；跨看板时间线聚合（多看板 M2 P2 未落地，本期仅当前看板）；拖拽改期（日历格拖任务改 dueDate/startDate，U-4 已定案：本期不做）；新增 schema 之外的字段（duration/endDate 已定案不新增，区间 = startDate→dueDate，见 U-3）。

## 3. 领域术语表

| 术语 | 定义 | 出处 |
|:-----|:-----|:-----|
| 时间线视图 | 看板内视图：以时间轴（垂直）分组展示本看板活动（任务创建 createdAt / 执行记录 startedAt·finishedAt / 评论·系统事件 timeline createdAt），按时间倒序（最新在上）；点击条目跳对应卡片详情 | PRD FR-1 |
| 日历视图 | 看板内视图：月/周粒度网格，任务按 `dueDate` 落在对应日格；`startDate`+`dueDate` 齐备时按计划区间跨格显示（条带）；过期任务视觉标记 | PRD FR-2 |
| startDate | Task 新增可空字段：计划开始日期（ISO 日期字符串，与 dueDate 同型）；createTask/updateTask 以可选参数扩展（向后兼容）；详情面板可编辑，即时生效持久化 | PRD FR-3/Q-052 |
| dueDate | 任务截止日期（M2 既有字段，见 共识-Hull桌面壳-M2看板 §7.1）：日历视图单日落格依据；`startDate > dueDate` 时以 dueDate 为准 | PRD FR-2/§8 |
| schema v2 迁移 | `KANBAN_SCHEMA_VERSION` 1→2 的迁移函数：遍历 boards[]→columns[]→tasks[] 三层为每个任务补 `startDate: null`，其余字段原样保留；幂等（重复执行不重复加/不报错）；失败走 M2 兜底（备份 boards.json.corrupt-<ts> → 重建默认看板） | PRD FR-4/Q-051 |
| 视图持久化 | 上次视图记忆：renderer 侧 localStorage，key=`kanban:lastView`；重启保持；不 bump HullSettings schema、无 IPC 新增 | Q-053 |
| 多视图状态机 | M2 已搭的视图切换机制：`kanban.js` 的 `viewNames` + 各 render 函数 + 通用工具栏；本期仅增两视图与两 render 函数，不新建页面/IPC | PRD FR-5 |
| 看板/卡片/时间线/执行记录 | 见 共识-Hull桌面壳-M2看板 §3（本需求引用，不重复定义） | 父共识 §3 |

## 4. 模块概述

- **定位**：M2 看板已交付（按列看状态），本期补"按时间看节奏"视角——时间线回顾活动、日历规划到期，复用 M2 多视图状态机，属壳内展示层增量。
- **业务目标**：① 时间线视图——按时间倒序铺开任务活动历史（创建/执行/评论/系统），一眼看清"这周做了什么、每张卡进展到哪"；② 日历视图——按 dueDate/计划区间把任务排进日历格，解决"哪些事本周到期、下周排什么"的规划视角；③ 新字段 startDate + schema v2 迁移，零数据丢失。
- **参与角色**：当前 solo（pm/be/fe/qa = phper666）；用户是唯一操作者；agent（dsh）为执行方（非操作者，与 M2 同）。
- **子模块清单**：时间线视图（renderTimeline）、日历视图（renderCalendar，月/周粒度）、startDate 字段（Task schema + 详情面板日期选择器）、schema v2 迁移（migrate() v1→v2）、视图接入（viewNames 扩展）。

## 5. 业务流程与状态机

本需求不新增业务状态机——视图为**纯读取/渲染**，数据侧仅 Task 新增可空字段 `startDate`（与 dueDate 同轨，无独立流转）。既有执行状态机/看板流转沿用 M2 共识 §5。

### 5.1 视图切换流程（FR-5）

1. 视图工具栏按钮（Board / List / Archive / 时间线 / 日历）统一渲染，五视图并列；
2. 点击切换 → 即时生效并持久化：renderer 侧 localStorage（key=`kanban:lastView`），重启保持上次视图；不 bump HullSettings schema、无 IPC 新增（Q-053 定案，CON-R-timeline-005）；
3. 各视图独立渲染不串扰；切换响应 < 300ms（见 CON-R-timeline-006）。

### 5.2 迁移流程（FR-4）

1. 加载时读 `KANBAN_SCHEMA_VERSION`；
2. v1 → 执行 v2 迁移：遍历 boards[]→columns[]→tasks[] 三层，为每个任务补 `startDate: null`，其余字段原样保留，版本号升 2；
3. 迁移幂等：重复执行不重复加字段、不报错（已含 startDate 的任务原样跳过）（Q-051）；
4. 迁移成功 → 任务与时间线完整不丢，重新保存落盘为 v2；
5. 迁移失败 → 沿用 M2 兜底（备份 `boards.json.corrupt-<ts>` → 重建默认看板并提示），不破坏原数据。

## 6. 角色与权限矩阵

| 操作 | 用户 | 壳（系统） | agent | 说明 |
|:-----|:-----|:-----------|:------|:-----|
| 切换视图（时间线/日历） | ✅ | 记忆上次视图 | — | 即时生效并持久化 |
| 查看时间线活动流 | ✅ | 聚合渲染（只读） | — | 来源 createdAt/timeline/execution 时间戳 |
| 查看日历落格/区间 | ✅ | 聚合渲染（只读） | — | dueDate 落格，startDate+dueDate 跨格 |
| 编辑 startDate（详情面板） | ✅ | 持久化 | — | 可空，即时生效，重启保持 |
| 任务点击跳详情 | ✅ | — | — | 复用 M2 详情面板 |
| 看板数据读写 | — | ✅ 原子写/损坏兜底 | — | 不触 DSH_HOME（CON-R002）；无新增 IPC 面 |

## 7. 字段业务定义

### 7.1 Task 新增字段（FR-3）

| 字段 | 语义 | 必填 | 来源 | 枚举/默认 | 敏感性 |
|:-----|:-----|:-----|:-----|:----------|:-------|
| startDate | 计划开始日期（ISO 日期字符串，与 dueDate 同型可空） | 否 | 用户 | 可空；无值任务日历按 dueDate 单日显示 | 无 |

- 其余字段（id/columnId/title/executionMode/dueDate/timeline 等）沿用 M2 共识 §7.1，不重复定义。
- API 扩展（Q-052）：startDate 以**可选参数**扩展 createTask/updateTask（向后兼容，不传=不变/置 null 语义与 dueDate 一致）；preload 类型 + IPC 校验同步；契约 feishu-b1-m2-kanban-api-contract.md 须同步更新（Task schema 加 startDate、createTask/updateTask 参数说明），走 change-propagation 落地并登记变更摘要。
- 详情面板：截止日期旁新增「开始日期」日期选择器（可空）；编辑即时生效并持久化。
- 边界：`startDate > dueDate` → 以 dueDate 为准单日显示，不报错（可加 UI 提示，非阻塞）；`startDate`/`dueDate` 非法日期串 → 丢弃置 null，不阻塞加载（CON-R-timeline-007）。

### 7.2 schema v2 迁移

- `KANBAN_SCHEMA_VERSION` 1 → 2；migrate() 增加 v1→v2：遍历 boards[]→columns[]→tasks[] 三层为每个任务补 `startDate: null`，其余字段原样保留；幂等（重复执行不重复加/不报错）（Q-051）。
- 迁移失败 → 沿用 M2 兜底（备份 boards.json.corrupt-<ts> → 重建默认看板）。
- 兼容：老版本 schema（v1）数据可直接加载迁移；与 dsh 升级/回滚正交。

## 8. 业务规则清单

| 编号 | 规则描述 | 来源 | 当前结论 | 变更状态 |
|:-----|:---------|:-----|:---------|:---------|
| CON-R-timeline-001 | 时间线视图 = 任务活动流按时间倒序（来源 createdAt/timeline 各条 createdAt/execution startedAt·finishedAt），零 schema 变更（纯读既有字段）；execution 记录缺 startedAt/finishedAt → 用 updatedAt 兜底或跳过该条目并标记"时间未知"；同时间戳 tie → 按 id 稳定排序（倒序时后建在前）（Q-055） | PRD FR-1/Q-055 | 生效 | 修订（v1.2） |
| CON-R-timeline-002 | 日历视图 = 月/周粒度（默认月），任务按 dueDate 落格，startDate+dueDate 区间跨格（条带）；过期任务视觉标记（复用 M2 过期标记语义）；仅 startDate → 从 startDate 显示至当月末尾；dueDate/startDate 按本地时区解析（date-only 用 new Date(y,m,d) 避免 UTC 偏移）；月标签中文（Intl.DateTimeFormat('zh-CN')）；跨月区间条带按日遍历渲染（Q-054） | PRD FR-2/Q-054 | 生效 | 修订（v1.2） |
| CON-R-timeline-003 | Task 新增 startDate 字段（ISO 日期字符串，可空，与 dueDate 同型）；createTask/updateTask 以可选参数扩展支持读写（向后兼容）；详情面板日期选择器可设/清空，即时生效并持久化；契约 feishu-b1-m2-kanban-api-contract.md 须同步更新（Task schema + 参数说明）+ preload 类型/IPC 校验同步，走 change-propagation 落地并登记变更摘要（Q-052） | PRD FR-3/Q-052 | 生效 | 修订（v1.2） |
| CON-R-timeline-004 | schema v2 迁移：KANBAN_SCHEMA_VERSION 1→2，migrate() 遍历 boards[]→columns[]→tasks[] 三层补 startDate:null 其余原样保留；幂等（重复执行不重复加/不报错）；失败沿用 M2 兜底（备份 boards.json.corrupt-<ts> → 重建默认看板）（Q-051） | PRD FR-4/Q-051 | 生效 | 修订（v1.2） |
| CON-R-timeline-005 | 视图接入复用 kanban.js viewNames 状态机 + render 函数 + 通用工具栏，不新建页面/入口；视图持久化 = renderer localStorage（key=kanban:lastView）重启保持；不 bump HullSettings schema；IPC/存储层零新增（仅 Task 字段扩展）（Q-053） | PRD FR-5/§7/Q-053 | 生效 | 修订（v1.2） |
| CON-R-timeline-006 | 性能：任务量大（≥1000 卡）时时间线/日历按需渲染（时间线虚拟滚动或按时间段切片；日历按月渲染当月），不一次渲染全量 DOM；视图切换响应 < 300ms | PRD §7/§9 R1 | 生效 | 稳定 |
| CON-R-timeline-007 | 边界容错：startDate>dueDate 以 dueDate 为准单日显示（不报错，可加非阻塞 UI 提示）；startDate/dueDate 非法日期串丢弃置 null 不阻塞加载 | PRD §8 | 生效 | 稳定 |

## 9. 枚举值与常量

- **视图**：Board（看板）/ List（列表）/ Archive（归档）/ Timeline（时间线）/ Calendar（日历）——五视图并列进 viewNames。
- **时间线活动类型徽标**：创建 / 执行 / 评论 / 系统。
- **日历粒度**：月（默认）/ 周（U-1 已定案：月 + 周）。
- **常量**：视图切换响应 < 300ms；任务量大阈值 ≥ 1000 卡（触发按需渲染）；KANBAN_SCHEMA_VERSION v2；schema v1 数据可直接加载迁移；视图持久化 key=`kanban:lastView`（localStorage）。

## 10. 第三方对接

本需求不新增第三方对接——纯壳内展示层，沿用 M2 既有数据/渲染/持久化链路；无新增 IPC 面（沿用 M2 preload 白名单）；数据仅存 userData（不触 DSH_HOME）。

## 11. 未决项登记

> 来源：PRD §5（U-1~U-5）。2026-08-22 用户确认推荐默认全收，U-1~U-5 全部定案关闭，结论按 PRD 默认值（月+周/可空 startDate/不新增 duration·endDate/不做拖拽/两独立视图），已回写 PRD v0.2 与本共识 v1.1。
> 追加来源：三角色扫描 Q-051~Q-055（2026-08-22），PM 决策（solo 上下文）全部定案关闭，结论已回写本共识 v1.2 与规则索引。

| 编号 | 问题 | 负责人 | 阻断等级 | 状态 | 结论 | 回写位置 |
|:-----|:-----|:-------|:---------|:-----|:-----|:---------|
| U-1 | 日历粒度 | PM | P2 | closed | 已定案：月视图 + 周视图（默认月） | §9/FR-2 |
| U-2 | startDate 是否必填 | PM | P2 | closed | 已定案：可空（仅日历规划场景填） | §7.1/FR-3 |
| U-3 | 是否新增 duration / endDate | PM | P2 | closed | 已定案：不新增（区间 = startDate→dueDate，YAGNI） | §7.1/FR-2 |
| U-4 | 是否支持拖拽改期 | PM | P2 | closed | 已定案：不做（本期） | §2/§12 |
| U-5 | 时间线与日历为同一视图还是两个 | PM | P2 | closed | 已定案：两个独立视图 | §2/§12 |
| Q-051 | v1→v2 迁移嵌套遍历与幂等性 | PM | P2 | closed | 已定案：migrate() 遍历 boards[]→columns[]→tasks[] 三层为每个 task 补 startDate:null；幂等（重复执行不重复加/不报错）；version 升 2；失败走 M2 兜底（备份 corrupt → 重建） | §5.2/§7.2/§13/CON-R-timeline-004 |
| Q-052 | startDate 契约变更传播 | PM | P2 | closed | 已定案：startDate 扩展 createTask/updateTask 参数（可选字段，向后兼容）；契约 feishu-b1-m2-kanban-api-contract.md 更新（Task schema 加 startDate、createTask/updateTask 参数说明）；preload 类型 + IPC 校验同步；走 change-propagation 登记变更摘要 | §7.1/§13/CON-R-timeline-003/变更摘要-M2看板 |
| Q-053 | 视图持久化位置 | PM | P2 | closed | 已定案：localStorage（renderer 侧，key=kanban:lastView），重启保持；不 bump HullSettings schema（避免影响 M1 schemaVersion）；无 IPC 新增 | §5.1/§9/§13/CON-R-timeline-005 |
| Q-054 | 日历 CJK/时区 | PM | P2 | closed | 已定案：dueDate/startDate 按本地时区解析（date-only 用 new Date(y,m,d) 避免 UTC 偏移）；月标签中文（Intl.DateTimeFormat('zh-CN')）；跨月区间条带按日遍历渲染 | §12/CON-R-timeline-002 |
| Q-055 | 时间线数据缺失 | PM | P2 | closed | 已定案：execution 记录无 startedAt/finishedAt → 用 updatedAt 兜底或跳过该执行条目（标记"时间未知"）；同时间戳 tie → 按 id 稳定排序（倒序时后建在前） | §12/§13/CON-R-timeline-001 |

## 12. 页面交互规范

| 页面/组件 | 角色 | 功能 | 权限 | 数据范围 |
|:----------|:-----|:-----|:-----|:---------|
| 时间线视图 | 用户 | 活动流按时间倒序：来源任务标题（点击跳对应卡片详情）+ 活动类型徽标（创建/执行/评论/系统）+ 时间戳；execution 缺 startedAt/finishedAt → updatedAt 兜底或跳过并标记"时间未知"；同时间戳按 id 稳定排序（倒序后建在前）；空态："暂无活动，创建任务后这里会显示时间线" | 只读 | 当前看板全部活动 |
| 日历视图 | 用户 | 月/周粒度网格（默认月）；dueDate 落格 + 过期视觉标记 + startDate+dueDate 区间跨格（条带）；仅 startDate → 显示至当月末尾；日期按本地时区解析（date-only 用 new Date(y,m,d)），月标签中文（Intl.DateTimeFormat('zh-CN')），跨月区间条带按日遍历渲染；任务点击打开卡片详情；空态："本月无到期任务" | 只读 | 当前看板任务 |
| 详情面板（startDate） | 用户 | 截止日期旁新增「开始日期」日期选择器（可空）；编辑即时生效并持久化 | 全量 | 单卡片 |

> 视图接入（FR-5）：五视图按钮统一渲染（复用通用工具栏）；当前视图切换即时生效并持久化；各视图渲染独立不串扰；无新建页面/入口。

## 13. 后端任务规范

- **迁移（FR-4，Q-051）**：加载时 `KANBAN_SCHEMA_VERSION` v1 → v2——migrate() 遍历 boards[]→columns[]→tasks[] 三层，为每个任务补 `startDate: null`，其余字段原样保留；只加字段不动存量；**幂等**（重复执行不重复加/不报错）；迁移失败 → 备份 `boards.json.corrupt-<ts>` → 重建默认看板（沿用 M2 兜底）。
- **持久化（Q-052）**：startDate 随 createTask/updateTask 读写——以可选参数扩展（向后兼容，不传不影响既有调用）；preload 类型 + IPC 校验同步；契约 feishu-b1-m2-kanban-api-contract.md 须同步更新并走 change-propagation 落地（已登记变更摘要）；变更即写（沿用 M2 原子写 + 防抖 500ms）。
- **视图持久化（Q-053）**：上次视图存 renderer localStorage（key=`kanban:lastView`），重启保持；不 bump HullSettings schema、无 IPC 新增。
- **时间线兜底（Q-055）**：execution 记录缺 startedAt/finishedAt → 用 updatedAt 兜底或跳过该条目（标记"时间未知"）；同时间戳 tie → 按 id 稳定排序（倒序时后建在前）。
- **安全**：数据仅存 userData（不触 DSH_HOME）；无新增 IPC 面（沿用 M2 preload 白名单）。

## 14. 端差异汇总

本模块不涉及（单端桌面应用，无多端差异）。

## 15. 附录与版本记录

### 15.1 文档关联

- **关联**：PRD（docs/prd/2026-08-22-kanban-timeline-prd.md）、父共识（docs/spec/共识-Hull桌面壳-M2看板.md，§3/§7.1/§15.3）、规则索引（docs/spec/规则索引.md）、看板契约（docs/api/feishu-b1-m2-kanban-api-contract.md，Q-052 startDate 扩展）、变更摘要（docs/spec/变更摘要-M2看板.md）。

### 15.2 版本记录

> SemVer 规则：破坏兼容/架构级/重构/**数据迁移** → 主版本 v2.0，不 v1.x 叠加。本模块 schema v1→v2 数据迁移已在 v1.0/v1.1 声明（规则发布前）；v1.2 扫描结论为确认/澄清。**后续对本模块的破坏兼容/数据迁移级变更将 bump 至 v2.0**。

| 版本 | 日期 | 变更摘要条目 | 说明 |
|:-----|:-----|:-------------|:-----|
| v1.2 | 2026-08-22 | 变更摘要-M2看板-2026-08-22（时间线扫描回写） | 三角色扫描 Q-051~Q-055 全部定案关闭并回写：迁移三层遍历+幂等（004）/startDate 契约变更传播+登记变更摘要（003）/视图持久化 localStorage kanban:lastView（005）/日历本地时区+CJK 月标签+跨月按日遍历（002）/时间线缺失兜底+id 稳定排序（001）；五规则修订生效 |
| v1.1 | 2026-08-22 | 变更摘要-M2看板-2026-08-22 | U-1~U-5 全部定案关闭（结论按默认）；CON-R-timeline-001~007 定案生效（变更状态 稳定）；视图计数笔误修正（四→五视图）；状态草稿→已发布 |
| v1.0 | 2026-08-22 | 未登记（草稿） | 首次建立：从看板时间线/日历 PRD v0.1 提取整理为业务事实源；登记 CON-R-timeline-001~007、U-1~U-5；状态草稿，待未决项评审定案后发布 |

### 15.3 后续规划

| 项 | 阶段 | 说明 |
|:---|:-----|:-----|
| 拖拽改期 | 后置（U-4 已定案：本期不做） | 日历格拖任务改 dueDate/startDate；本期定案不做，如后续需要重新评估 |
| 自动排期 | 后置 | 按依赖/工期自动计算 start/due——依赖子任务依赖图（M2 P2 未落地） |
| 跨看板时间线聚合 | 后置 | 多看板功能未落地（M2 P2），本期仅当前看板内聚合 |
| 实时协作/共享日历 | 后置 | 依赖多人协作/同步方案（M2 后续规划项，未定案） |
