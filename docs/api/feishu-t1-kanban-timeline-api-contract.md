# T1 时间线/日历视图契约

## 契约信息

- 工作项：T1 时间线/日历视图（飞书 dsh-hull-desktop 清单，fd4fdf45-32be-4ff1-8174-68505e26c5a4）
- 契约状态：冻结（2026-08-22）
- 版本：v0.1
- 适用版本：M2 看板时间线模块（共识 v1.2）
- 最后更新：2026-08-22
- 说明：纯 renderer 展示层行为契约（无 HTTP API 面、无新增 IPC）；核心 = 时间线视图聚合/排序/兜底规则 + 日历视图落格/区间/时区/本地化规则 + 视图持久化 + 按需渲染性能约束。判级：复杂（前置技术方案须评审冻结后方可进入实现管道）。

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 承载 | 状态 |
|---|---|---|---|---|---|
| 五视图接入与切换 | T1 | CON-R-timeline-005 | ① 五视图切换正常且响应 <300ms，各视图渲染独立不串扰 | viewNames 扩展 + renderTimeline/renderCalendar | 已定义 |
| 视图持久化 | T1 | CON-R-timeline-005 + Q-053 | ① localStorage（key=`kanban:lastView`）记忆上次视图，重启保持；不 bump HullSettings schema | renderer localStorage | 已定义 |
| 时间线视图 | T1 | CON-R-timeline-001 + Q-055 | ② 活动流按时间倒序 + 点击跳对应卡片 + 空态提示 + 缺失时间戳兜底（updatedAt/标记"时间未知"）+ 同时间戳按 id 稳定排序 | renderTimeline | 已定义 |
| 日历视图 | T1 | CON-R-timeline-002 + Q-054 | ③ dueDate 落格 + 过期视觉标记 + startDate+dueDate 区间跨格条带 + 本地时区解析 + 中文月份标签 | renderCalendar | 已定义 |
| 边界容错 | T1 | CON-R-timeline-007 | ③ startDate>dueDate 以 dueDate 单日显示；非法日期串丢弃置 null 不阻塞加载 | renderCalendar | 已定义 |
| 按需渲染性能 | T1 | CON-R-timeline-006 | ④ ≥1000 卡时时间线/日历按需渲染（分页/切片/按月），不一次全量 DOM；切换 <300ms | renderTimeline/renderCalendar | 已定义 |

> 验收 ①~④ 对应共识 §14.1 T1 行验收标准拆分；来源 PRD：docs/prd/2026-08-22-kanban-timeline-prd.md（FR-1/FR-2/FR-5/§7/§8/§10）。

## 范围与非目标

### 范围

- 时间线视图：本看板内任务活动流聚合（纯读既有字段，零 schema 变更）、时间倒序、点击跳卡、空态
- 日历视图：月/周粒度网格（默认月，U-1 定案）、dueDate 落格、startDate+dueDate 区间跨格条带、仅 startDate 显示至当月末尾、过期视觉标记、本地时区解析、中文月份标签、点击开详情、空态
- 视图持久化：renderer localStorage（key=`kanban:lastView`），重启保持上次视图
- 视图接入：复用 `src/renderer/kanban.js` 多视图状态机（viewNames + render 分发 + boardToolbar 通用工具栏），合计五视图（Board/List/Archive/Timeline/Calendar）
- 按需渲染：≥1000 卡时时间线分页/虚拟滚动、日历按月渲染

### 非目标

- startDate 字段新增 + schema v2 迁移 + createTask/updateTask 参数扩展（**T2**，bda6a7df-327c-462d-b459-c5d25ff7bc34；T1 只消费）
- 拖拽改期（U-4 定案本期不做）
- 跨看板时间线聚合（仅当前看板）
- 实时协作/共享日历、任务自动排期
- 新增 duration/endDate 字段（U-3 定案不新增，区间 = startDate→dueDate）

## 无接口变更声明

> **本工作项零新增 IPC、零 preload 变更、零存储层变更。**

- 复用现有 IPC（B1 契约 feishu-b1-m2-kanban-api-contract.md 接口清单）：`kanban:getBoards`、`kanban:getTasks`（T1 主要数据源）等既有 16 原语；B5 export/import 2 原语与本工作项无关。
- 数据消费方式：renderer 已持有的 `currentBoard.tasks[]`（经 `kanban:getTasks` 加载）内存态直接派生时间线/日历视图，不发起新请求、不加 channel。
- schema 影响：零（时间线纯读 Task.createdAt/timeline[].createdAt/execution.startedAt·finishedAt 既有字段；日历读 dueDate + T2 交付的 startDate）。HullSettings schema 不动（Q-053 定案）。
- preload 白名单：不变（沿用 M2）。
- 若实现过程中出现"需要新 IPC 才能做"的判断 → 即为越界信号，停止并回 Orchestrator 重新判级。

## 前端行为契约

### 1. 时间线视图（renderTimeline，CON-R-timeline-001/Q-055）

#### 1.1 活动聚合规则

数据源 = 当前看板全部任务（含子任务；不含归档区任务——归档活动随归档区展示，不进主时间线）。每个任务派生活动条目：

| 来源字段 | 活动类型徽标 | 条目数 | 排序键 |
|---|---|---|---|
| `task.createdAt` | 创建 | 每 task 1 条 | task.createdAt |
| `timeline[]` type=comment 的 `createdAt` | 评论 | 每条目 1 条 | 条目 createdAt |
| `timeline[]` type=system 的 `createdAt` | 系统 | 每条目 1 条 | 条目 createdAt |
| `timeline[]` type=execution 的 `execution.startedAt`/`finishedAt` | 执行 | 每条 execution 1 条 | 见 1.2 兜底链 |

- 执行条目展示：状态徽标（复用 execNames 中文映射）+ command 摘要 + startedAt/finishedAt（有则显示）。
- 所有时间戳均为 ISO 8601 UTC 存储（B1 契约），渲染时转本地时区显示（沿用 M2 `new Date(...).toLocaleString()` 语义）。

#### 1.2 排序与稳定性

- 主排序：时间**倒序**（最新在上）。
- 执行条目排序键兜底链（Q-055）：`execution.startedAt` → 缺失取 `execution.finishedAt` → 再缺失取所属 `task.updatedAt`（此时条目显示"时间未知"标记，仍参与排序）。
- 终极兜底：上述全部缺失或非法（Date 解析 NaN）→ 该条目**跳过正常排序流，固定排列表末尾**，显示"时间未知"，不参与时间轴分组。
- 同时间戳 tie：按条目 id 字符串比较稳定排序（倒序视图中 id 大者在前），保证同一数据两次渲染顺序一致（Q-055 定案"倒序时后建在前"语义）。

#### 1.3 交互与空态

- 点击活动条目 → 打开对应任务详情弹窗（复用 M2 `openDetail`），不新开页面。
- 空态：看板无任何活动（无任务）→ 显示"暂无活动，创建任务后这里会显示时间线"（PRD FR-1 文案）。

### 2. 日历视图（renderCalendar，CON-R-timeline-002/Q-054）

#### 2.1 粒度与导航

- 月视图（默认）/ 周视图切换（U-1 定案）；月视图渲染当月 6×7 格（含前后月补位灰显），周视图渲染当周 7 格。
- 上/下月（周）导航 + 回到今天按钮。

#### 2.2 落格规则

| 任务字段组合 | 行为 |
|---|---|
| 仅 `dueDate` | 单日落格（dueDate 对应格） |
| `startDate` + `dueDate` | 区间跨格条带（startDate 起 → dueDate 止；跨月/跨周边界按日遍历逐格渲染，Q-054 定案） |
| 仅 `startDate` | 从 startDate 起显示至**当月末尾**（未定截止） |
| 两者皆空 | 不进日历 |

- 过期视觉标记：`dueDate < 今日`（本地时区当日 0 点比较）→ 复用 M2 过期标记语义（红色系标记），区间条带以 dueDate 判定过期。
- 边界容错（CON-R-timeline-007）：`startDate > dueDate` → 以 dueDate 为准单日显示，不报错（可加非阻塞 UI 提示）；`startDate`/`dueDate` 非法日期串 → 丢弃置 null 处理，不阻塞加载。
- T2 未合入时 `t.startDate` 为 undefined → 按 null 处理（优雅降级为单日/不显示）。

#### 2.3 时区与本地化（Q-054）

- date-only 字符串（`YYYY-MM-DD`）解析**必须**用 `new Date(y, m-1, d)` 本地时区构造，**禁止** `new Date('YYYY-MM-DD')`（UTC 解析导致 UTC+8 西移一天落错格）。
- 月标签中文：`Intl.DateTimeFormat('zh-CN', ...)`（如"2026年8月"）；星期头中文（一~日）。
- 带时间的 ISO 戳（createdAt 等）不受此约束（本就按本地时区显示）。

#### 2.4 交互与空态

- 点击日历格内任务 → 打开对应卡片详情（复用 M2 详情面板）。
- 空态：当月（周）无到期任务 → 显示"本月无到期任务"（PRD FR-2 文案）。

### 3. 视图持久化（Q-053/CON-R-timeline-005）

| 项 | 契约 |
|---|---|
| 存储 | renderer `localStorage`，key=`kanban:lastView` |
| 值 | 字符串枚举：`board` / `list` / `archive` / `timeline` / `calendar` |
| 写时机 | 视图切换即时写入（切换生效与持久化同事务语义） |
| 读时机 | kanban.js 初始化时读取作为初始 `view`（替代硬编码 `'board'`） |
| 兜底 | 值缺失 / 不在枚举内 / localStorage 抛异常（隐私模式等）→ 回退 `board`，不报错 |
| schema | 不 bump HullSettings schema、无 IPC 新增（Q-053 定案） |
| 重启 | 保持上次视图 |

### 4. 性能（CON-R-timeline-006）

| 项 | 契约 |
|---|---|
| 触发阈值 | 当前看板任务 ≥1000 卡 |
| 时间线 | 分页加载（每页固定条数 + "加载更多"）或虚拟滚动，二选一由技术方案定案；首屏只渲染首屏数据，不一次拼全量 DOM |
| 日历 | 仅渲染当前月（周）格子命中的任务；切月重算，不做全年预渲染 |
| 视图切换 | 五视图任意切换响应 <300ms（e2e 以 `performance.now()` 计时断言） |
| 渲染隔离 | 各视图渲染独立，切换不串扰（每次 render 全量重建容器内容，沿用 M2 模式） |

### 5. 视图接入（FR-5/CON-R-timeline-005）

- `viewNames`（src/renderer/kanban.js:23）扩展为五项：`{ board: '看板', list: '列表', archive: '归档', timeline: '时间线', calendar: '日历' }`；工具栏按钮由 boardToolbar 统一渲染（现有 `Object.entries(viewNames)` 循环自动带上，无需改工具栏代码）。
- `render()` 分发（src/renderer/kanban.js:37-42）增加 `timeline`/`calendar` 分支 → `renderTimeline()`/`renderCalendar()`。
- 不新建页面/入口/路由；无框架增量。

## 数据结构引用

> 字段唯一事实源 = B1 契约 JSON Schema（+ T2 变更传播后的 startDate 扩展）；本节仅列 T1 消费字段，不重复定义。

| 字段 | 类型 | 来源 | T1 用途 |
|---|---|---|---|
| `task.createdAt` / `task.updatedAt` | ISO 8601 UTC | B1 Schema | 时间线「创建」条目 / 执行兜底排序键 |
| `task.timeline[].createdAt` | ISO 8601 UTC | B1 Schema | 评论/系统条目排序键 |
| `task.timeline[].execution.startedAt`/`finishedAt` | ISO 8601 UTC \| null | B1 Schema（Q-025） | 执行条目排序键 + 展示 |
| `task.dueDate` | `YYYY-MM-DD` \| null | B1 Schema | 日历落格 |
| `task.startDate` | `YYYY-MM-DD` \| null | T2 交付（schema v2 迁移补齐） | 日历区间条带 |
| `localStorage['kanban:lastView']` | string 枚举 | T1 新增（renderer 侧） | 视图记忆 |

## 联调与测试场景

| # | 场景 | 前置条件 | 请求/动作 | 预期结果 | 数据与审计结果 | 验收编号 |
|---|---|---|---|---|---|---|
| TL1 | 时间线倒序 | 看板含创建/评论/执行三类活动（时间戳交错） | 切到时间线视图 | 活动按时间倒序（最新在上），徽标类型正确 | DOM 顺序断言 | T1-② |
| TL2 | 同时间戳稳定排序 | 构造多条同 createdAt 条目 | 渲染两次对比 | 顺序一致：按 id 倒序（id 大在前），可复现 | 两次快照 diff 为空 | T1-② |
| TL3 | 执行缺 startedAt/finishedAt | execution 两字段均 null | 渲染时间线 | 以 task.updatedAt 兜底参与排序，条目显示"时间未知" | 排序位置 + 标记断言 | T1-② |
| TL4 | 兜底链全缺 | execution 无时间戳且 task.updatedAt 非法 | 渲染时间线 | 条目跳过排序流固定末尾，显示"时间未知"，不报错 | 末尾位置断言 | T1-② |
| TL5 | 点击跳卡 | 时间线有条目 | 点击任一条目 | 打开对应任务详情弹窗（标题匹配） | 详情弹窗 DOM 断言 | T1-② |
| TL6 | 时间线空态 | 空看板（无任务） | 切到时间线 | 显示"暂无活动，创建任务后这里会显示时间线" | 空态文案断言 | T1-② |
| CAL1 | dueDate 落格 | 任务 dueDate=2026-08-22 | 月视图渲染当月 | 落在 8 月 22 日格 | 格内任务断言 | T1-③ |
| CAL2 | 区间跨格条带 | 任务 startDate=2026-08-20 + dueDate=2026-09-02 | 月视图渲染 8 月 | 8/20→8/31 条带连续；9 月视图含 9/1→9/2（跨月按日遍历） | 两月条带覆盖断言 | T1-③ |
| CAL3 | 仅 startDate | 任务仅 startDate=2026-08-25 | 月视图渲染 8 月 | 从 8/25 显示至 8/31（当月末尾） | 条带终点断言 | T1-③ |
| CAL4 | 过期视觉标记 | 任务 dueDate=昨天 | 渲染日历 | 该任务有过期标记（红色系） | 标记 class 断言 | T1-③ |
| CAL5 | 本地时区解析 | dueDate=2026-08-01（机器 UTC+8） | 渲染日历 | 落 8/1 格，不西移到 7/31（date-only 用 new Date(y,m,d)） | 落格断言 | T1-③ |
| CAL6 | 中文月份标签 | 任意 | 渲染月视图 | 标题"2026年8月"式中文（Intl zh-CN），星期头中文 | 文案断言 | T1-③ |
| CAL7 | 月/周切换 | 默认月视图 | 切周视图再切回 | 周 7 格正确（含跨月周）；默认始终月 | 格数 + 默认值断言 | T1-③ |
| CAL8 | startDate>dueDate | startDate=2026-08-30 + dueDate=2026-08-22 | 渲染日历 | 以 dueDate 单日显示，不报错 | 单日落格断言 | T1-③ |
| CAL9 | 非法日期串 | dueDate="not-a-date" | 加载+渲染 | 丢弃置 null 处理（不进日历），不阻塞其他任务渲染 | 无异常 + 其他卡正常 | T1-③ |
| CAL10 | 日历空态 | 当月无到期任务 | 渲染月视图 | 显示"本月无到期任务" | 空态文案断言 | T1-③ |
| CAL11 | 点击开详情 | 格内有任务 | 点击任务 | 打开对应卡片详情 | 详情弹窗断言 | T1-③ |
| P1 | 切换写 localStorage | 任意看板 | 切到 timeline 视图 | `localStorage['kanban:lastView']==='timeline'` | 存储值断言 | T1-① |
| P2 | 重启保持 | lastView=calendar | 重载页面（模拟重启） | 初始视图为 calendar | 初始 active 视图断言 | T1-① |
| P3 | 非法值兜底 | 手工注入 lastView="hack" | 初始化 | 回退 board 视图，不报错 | active 视图断言 | T1-① |
| P4 | 无 schema bump | — | 全流程 | HullSettings schemaVersion 不变、无新 IPC channel 调用 | IPC spy 零新增断言 | T1-① |
| PERF1 | 时间线按需渲染 | 注入 ≥1000 卡（每卡含 timeline） | 切到时间线 | 首屏 DOM 条目数 ≤ 分页页大小（非全量），"加载更多"可用 | DOM 计数断言 | T1-④ |
| PERF2 | 日历按月渲染 | 注入 ≥1000 卡分布多月 | 渲染 8 月 | 仅当月命中任务入 DOM | DOM 计数断言 | T1-④ |
| PERF3 | 切换 <300ms | ≥1000 卡看板 | 五视图两两切换计时 | 每次切换 render 完成 <300ms | performance.now() 计时断言 | T1-④ |

> 测试载体：Playwright e2e + node:test（跟随 M2 测试体系，PRD §10）。

## 依赖

| 依赖 | 说明 | 状态 |
|---|---|---|
| T2（bda6a7df-327c-462d-b459-c5d25ff7bc34） | startDate 字段 + schema v2 迁移 + createTask/updateTask 参数扩展；T1 日历区间条带消费 `t.startDate` | T1 前置（交付顺序 T2 → T1）；未合入期间 T1 按 null 优雅降级开发 |
| B1 契约 | boards.json Schema + 16 IPC 原语（getTasks 为主要数据源） | 已冻结 |
| B2（M2 已交付） | kanban.js 多视图状态机/viewNames/boardToolbar/openDetail 复用基座 | 已交付 |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| 无 | — | — | — | — |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| startDate 字段就绪 | T2 交付（schema v2 迁移 + 契约/preload 同步，走 change-propagation） | phper666 | T1 开发前 | 待 T2 |
| 技术方案冻结 | 判级复杂 → docs/design/ 方案文档评审冻结后方可进入实现管道（时间线分页 vs 虚拟滚动在此定案） | phper666 | 实现前 | 待办 |

## 完成记录

> 交付后填写，结果必须有证据。

| 项 | 结果 |
|:---|:-----|
| 交付时间 | — |
| 验证结果 | — |
| 构建/发布 | — |
| 偏差处理 | — |

## 变更记录

| 时间 | 类型 | 摘要 |
|---|---|---|
| 2026-08-22 | 初次生成 | 基于 T1（fd4fdf45）+ 共识 v1.2 §14.1/§8/§11/§12/§13 + PRD v0.2 FR-1/FR-2/FR-5/§7/§8 生成契约草案；零新增 IPC，纯 renderer 行为契约 |

## 自检记录

- 追踪完整性：PASS（T1→CON-R-timeline-001/002/005/006/007 + Q-053/054/055 + U-1 定案→验收 ①~④，追踪矩阵全覆盖）
- OpenAPI 一致性：不适用（无 HTTP API 面、无新增 IPC；前端行为契约即唯一事实源）
- 示例与错误场景：PASS（23 个联调场景 TL1~TL6/CAL1~CAL11/P1~P4/PERF1~PERF3 含成功/失败/边界/性能）
- 安全与敏感字段：PASS（零新增 IPC 面；数据仅存 userData + renderer localStorage，不触 DSH_HOME）
- 链接与格式：PASS
