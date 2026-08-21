# B2 看板 UI 与交互契约

## 契约信息

- 工作项：B2 看板 UI 与交互（飞书 dsh-hull-desktop 清单，t100102）
- 契约状态：已冻结（2026-08-21，ora-1 第三轮复核通过）
- 版本：v0.1
- 适用版本：M2（共识 v1.4）
- 最后更新：2026-08-21
- 说明：桌面壳前端 UI + IPC 消费契约——定义壳 UI 如何消费 B1 数据原语（16 IPC）+ 视图交互 + UI 状态。B2 消费 B1 全部数据原语，新增 UI 专属行为（视图切换/拖拽/筛选/空态/归档区/多项目看板）。B1 契约（feishu-b1-m2-kanban-api-contract.md）为数据层事实源。

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口/场景 | 状态 |
|---|---|---|---|---|---|
| 看板主界面 | B2 | CON-R020/026 | 列横排卡片 + 工具栏筛选 + 卡片多信息 | UI 场景 1 | 已定义 |
| 6 态列自定义 | B2 | CON-R020 + PRD FR-2 | 增删改/排序/颜色/隐藏；模板列不可删 | UI 场景 5 + deleteColumn/updateColumn | 已定义 |
| 多项目看板 | B2 | CON-R031（决策 1） | 创建/切换，各 Board 独立列+任务 | UI 场景 4 + getBoards/createBoard | 已定义 |
| 卡片 CRUD+子任务 | B2 | CON-R022/026 | 卡片增删改 + 子任务 + 父子可见 + 跨列聚合 | UI 场景 3/6 + createTask/updateTask/deleteTask | 已定义 |
| 拖拽流转 | B2 | CON-R020 | 人工拖拽最高优先级 + 冲突弹窗 + 写 timeline | UI 场景 1 + moveTask | 已定义 |
| 视图切换 | B2 | CON-R033（决策 3） | 看板/列表/归档，同数据多视图渲染 | UI 场景 1/2 + 状态 | 已定义 |
| 归档区 | B2 | CON-R033（决策 1/2） | 只读 + 恢复 + 彻底删除 | UI 场景 3 + archiveTask/restoreTask/purgeTask | 已定义 |
| 空态三态 | B2 | Q-021 | 空列/筛选无结果/空看板 | UI 状态 | 已定义 |
| 评论/时间线 | B2 | CON-R025 + Q-028 | user 评论可删；agent 评论只读 | UI 场景 6 + addComment/deleteComment | 已定义 |

## 范围与非目标

### 范围

- 壳内看板 UI：看板视图/列表视图/归档视图三视图（同 tasks 数据多视图渲染）
- 多项目看板（创建/切换，各 Board 独立列+任务）
- 6 态列自定义（增删改/排序/颜色/隐藏/删除）
- 卡片 CRUD + 子任务 + 父引用徽标 + 跨列聚合进度
- 拖拽流转（人工拖拽语义 + 冲突弹窗 + Blocked 进出）
- 归档区（只读 + 恢复 + 彻底删除）
- 空态三态、筛选、排序、搜索
- 详情侧板（子任务/时间线/评论/干预按钮/执行流程步骤条）

### 非目标

- 数据模型/持久化（B1，16 原语已冻结）
- 执行引擎/状态机调度（B3）
- 执行集成/ACP/审批（B4）
- 导出/导入（B5）
- 时间线/日历视图（M2+）
- 实时协作/权限（M2+）

## 业务流程与状态

### 核心流程

```text
用户进入任务看板 → getBoards 加载看板列表 → 默认/上次看板 getTasks 加载任务
→ 视图渲染（看板/列表/归档）
用户操作（CRUD/拖拽/评论/归档）→ 调 B1 IPC 原语 → 响应更新内存态 → 重渲染
冲突场景（拖 Done 执行中/子任务未完成）→ 确认弹窗 → 可强制通过
```

> **getTasks 过滤语义（P1-B2-1 定稿）**：`getTasks` 返回**全量任务（含 archivedAt 字段，B1 冻结语义）**，不含归档过滤。B2 三视图各自基于 `archivedAt` 过滤渲染同一份 tasks 数据——看板/列表视图过滤 `archivedAt == null`（归档卡不显示）；归档视图过滤 `archivedAt != null`（仅归档区显示）。B2 不做第二次取数，视图切换即同一内存态换过滤条件重渲染（P2-B2-2 一致性断言）。

### 状态转换（UI 视图状态）

| 当前视图 | 动作 | 目标视图 | 前置条件 | 冲突行为 | 依据 |
|---|---|---|---|---|---|
| 看板视图 | 切换列表 | 列表视图 | 同看板数据 | 无 | 决策 3 |
| 看板/列表 | 切换归档 | 归档视图 | 只读，archivedAt 非空 | 恢复/彻底删除需确认 | CON-R033 |
| 归档 | 恢复 | 看板视图（Done/原列） | restoreTask 成功 | 清归档字段；恢复后看板/列表视图重新显示该卡（archivedAt 已清） | CON-R033 |
| 任意视图 | 切换看板 | 目标看板视图 | createBoard/getBoards | 各 Board 独立 | CON-R031 |

> **恢复目标列规则（P1-B2-2 定稿）**：恢复时 B2 不传 `toColumnId`（走 B1 缺省）——默认回 `archivedFromColumnId`（原列）；若原列已删除或隐藏则回 Done（与 Blocked 解除同构，B1 restoreTask 缺省语义）。B2 UI 恢复按钮语义即"回原列/回 Done"，不暴露目标列选择。

## 接口清单

> B2 消费 B1 的 16 个 IPC 原语（feishu-b1-m2-kanban-api-contract.md 已冻结），本节为 B2 各 UI 场景 → B1 原语消费映射，非新增接口。

| # | UI 场景 | 消费 B1 原语 | 用途 | 错误码 |
|---|---|---|---|---|
| 1 | 看板主界面 | getBoards / getTasks | 加载看板+任务 | store-* |
| 2 | 多项目看板 | getBoards / createBoard / updateBoard / deleteBoard | 创建/切换/重命名/删除 | store-*/validation-error |
| 3 | 卡片 CRUD | createTask / updateTask / deleteTask | 增删改 | store-*/validation-error |
| 4 | 拖拽流转 | moveTask | 列间移动 + Blocked | validation-error |
| 5 | 列管理 | updateColumn / deleteColumn | 列配置/删除 | store-*/validation-error |
| 6 | 评论/时间线 | addComment / deleteComment | 评论增删 | store-*/validation-error |
| 7 | 归档区 | archiveTask / restoreTask / purgeTask | 归档/恢复/彻底删除 | store-*/validation-error |

## Schema 与枚举

> 数据字段结构以 B1 契约为准（本契约不重复）；本节仅列 B2 UI 专属状态（不持久化，内存态）。

### UI 视图状态

| 字段 | 类型 | 说明 |
|---|---|---|
| currentView | string | kanban / list / archive（决策 3 视图切换） |
| currentBoardId | string | 当前看板 id（默认/上次） |
| archiveFilter | string | archive / active（当前视图的任务过滤：归档视图=archive（archivedAt!=null）；看板/列表=active（archivedAt==null）） |
| filters | object | 搜索/优先级/状态/标签筛选（工具栏） |
| sortField | string | 列表视图排序字段（白名单：title/priority/dueDate/updatedAt/order） |
| dragState | object | 拖拽中状态（draggingCardId/ghostColumnId/冲突待确认） |

### 空态三态

| 态 | 触发 | 渲染 |
|---|---|---|
| 空列 | 列无卡片 | "新建任务"引导按钮 |
| 筛选无结果 | 筛选后无匹配 | "无匹配卡片" + 清除筛选按钮 |
| 空看板 | 罕见（首进自动建 6 列） | 兜底提示 |

### 公共异常集

> 复用 B1 `KANBAN_STORE_ERROR`（7 错误码）：store-io-error / store-corrupt / store-migrate-failed / store-not-found / store-task-executing / store-board-not-empty / validation-error。B2 为消费方，错误码语义与客户端处理以 B1 契约为准。

## 接口详情

### UI 场景 1：看板主界面

- 布局：左侧 Hull 导航（dsh web/设置/升级/任务看板）+ 右侧看板视图
- 顶部：视图切换器（看板/列表/归档）+ 多项目看板切换器 + 创建看板按钮 + 工具栏（搜索/优先级/状态/标签筛选/清除/管理列/新建任务）
- 列区：列（300px，列头色带=列颜色，卡片数徽标）；卡片（优先级色条/模式徽标/父引用徽标/标签/进度条+展开子任务/截止/负责人/执行状态徽标/←/→/agent 按钮）
- 消费：`getBoards` + `getTasks`（加载，**getTasks 返回全量含 archivedAt**）；`moveTask`（拖拽）；`createTask`（新建）
- 视图过滤：看板/列表视图仅渲染 `archivedAt == null` 任务（P1-B2-1）；归档卡不显示
- 错误处理：store-not-found → 提示"数据已删除，自动刷新"；store-io-error → 提示保存失败重试
- 拖拽语义（CON-R020）：人工拖拽直接生效不自动矫正；冲突弹窗（拖 Done 执行中/未执行→"任务未完成执行，确认跳过？"；父卡拖 Done 子任务未完成→"子任务未全部完成，确认？"；执行中拖其他列→执行不终止，列以人工为准）；拖拽写 timeline（B1 store 自动，from→to/user）

### UI 场景 2：列表视图（决策 3）

- 表格渲染同看板 tasks 数据（不改数据模型）：列=标题/优先级/状态/截止/负责人/执行状态/操作；**仅渲染 archivedAt==null 任务（P1-B2-1）**
- 排序：sortField 白名单（title/priority/dueDate/updatedAt/order）；筛选：复用工具栏 filters
- 空态：筛选无结果 → "无匹配卡片" + 清除筛选
- 操作：行内 编辑/移动/删除/归档（复用卡片操作）

### UI 场景 3：归档区视图（CON-R033）

- 只读：已归档 ticket 列表（**渲染 archivedAt != null 任务，P1-B2-1**）
- 恢复：`restoreTask`（**不传 toColumnId，走 B1 缺省 = 回 archivedFromColumnId 原列，原列已删/隐藏则回 Done，P1-B2-2**，二次确认）
- 彻底删除：`purgeTask`（级联清 timeline/附件/executions log，二次确认）
- 错误处理：validation-error（未归档不可 purge）→ 提示

### UI 场景 4：多项目看板（决策 1）

- 创建：`createBoard`（name 必填，缺省 6 态模板列）
- 切换：`getBoards` 列表，各 Board 独立列+任务
- 重命名/排序：`updateBoard`
- 删除：`deleteBoard`（有 ticket 含归档→store-board-not-empty 拒删；最后一个→validation-error 可改名；执行中→store-task-executing）
- 删除前置：UI 提示"需先清空全部 ticket（含归档）"

### UI 场景 5：列管理弹窗（CON-R020）

- 列列表：序号/颜色选择器/名称/上移下移/删除（模板列锁定，有 type 不可删）
- 新增自定义列：`updateColumn`（或列操作）
- 删除：`deleteColumn`（自定义列可删，列内卡片移入 Todo；模板列→validation-error）
- 隐藏/显示：`updateColumn` hidden（隐藏=过滤，数据保留 Q-027）
- 重置默认/保存

### UI 场景 6：详情侧板 + 编辑弹窗

- 详情侧板：标题/描述/元信息/父任务面包屑（点击跳父）/执行模式（auto 四字段 or manual AI 结果）/执行流程步骤条/子任务列表（点击跳子）/附件（上限提示）/时间线 tab + 评论 tab/干预按钮区
- 编辑弹窗：标题/描述/执行模式切换（auto 显示四字段，manual 显示 AI 结果输入）/依赖子任务 ID（逗号分隔，留空=无依赖可并行）/优先级/状态/截止/负责人（assignee，可空）/标签；auto 必填项缺失标红拦截（CON-R018 门控）
- 评论：`addComment`（user 评论）/ `deleteComment`（仅 user 评论可删，agent 评论只读 Q-028）
- 消费：`createTask` / `updateTask` / `deleteTask` / `addComment` / `deleteComment`

### UI 场景 7：归档操作

- 归档：`archiveTask`（**"仅 Done 可归档"校验由 B1 store 执行**——非 Done → validation-error "仅 Done 可归档"；B2 前置置灰非 Done 卡的归档按钮，置灰仅 UX 引导，不替代 B1 校验）
- 恢复：`restoreTask`（不传 toColumnId，回原列/回 Done，P1-B2-2）
- 彻底删除：`purgeTask`（仅归档区，二次确认）

## 数据库与外部系统影响

> 无变化（数据层归 B1，UI 只消费 IPC）。无外部系统。

## 联调与测试场景

| # | 场景 | 前置条件 | 请求/动作 | 预期结果 | 数据与审计结果 | 验收编号 |
|---|---|---|---|---|---|---|
| U1 | 看板加载 | 有看板 | getBoards+getTasks | 列+卡片正确渲染 | 无写 | B2 验收 |
| U2 | 多项目切换 | 2 看板 | 切换看板 | 各 Board 独立列+任务 | 无写 | B2 验收 |
| U3 | 创建看板 | — | createBoard | 新看板入列表，6 态列 | boards[] +1 | B2 验收 |
| U4 | 卡片新建 | 默认看板 | createTask | 卡片入 Todo 列 | boards.json 持久化 | B2 验收 |
| U5 | 卡片拖拽 | 卡片在 Todo | moveTask 拖到 In Progress | 列更新，timeline from→to | system 事件 | B2 验收 |
| U6 | 拖拽冲突（执行中拖 Done） | running 卡 | 拖到 Done | 确认弹窗"任务未完成执行，确认跳过？"可强制通过 | 列以人工为准 | B2 验收 |
| U7 | 父卡拖 Done 子任务未完成 | 父卡含未完成子卡 | 拖到 Done | 确认弹窗"子任务未全部完成，确认？" | 可强制通过 | B2 验收 |
| U8 | Blocked 进出 | 卡片在 Todo | 移入 Blocked | blockedFromColumnId 记录；解除回原列 | system 事件 | B2 验收 |
| U9 | 空列 | 空列 | 查看 | "新建任务"引导按钮 | — | B2 验收 |
| U10 | 筛选无结果 | 筛选无匹配 | 搜索 | "无匹配卡片"+清除筛选按钮 | 清除后恢复 | B2 验收 |
| U11 | 列管理 | 自定义列 | 新增/改名/排序/颜色/隐藏 | 即时生效持久化 | boards.json | B2 验收 |
| U12 | 删除自定义列 | 自定义列含卡 | deleteColumn | 列内卡片移入 Todo | 卡片 columnId=Todo | B2 验收 |
| U13 | 删除模板列 | 默认看板 | deleteColumn c_done | validation-error（模板列不可删） | 列保留 | B2 验收 |
| U14 | 归档 Done | Done 卡 | archiveTask | 入归档区（archivedAt）；**归档后看板视图不显示该卡、归档视图显示**（P1-B2-1） | 归档字段 + 视图过滤正确 | B2 验收 |
| U15 | 归档非 Done | Todo 卡 | archiveTask | validation-error（仅 Done 可归档，B1 校验；B2 前置置灰） | 不归档 | B2 验收 |
| U16 | 恢复归档 | 归档区卡（原列 In Progress） | restoreTask（不传 toColumnId） | **回 archivedFromColumnId 原列（In Progress）**，清归档字段；看板视图重新显示该卡（P1-B2-2） | system 事件 + 目标列=原列 | B2 验收 |
| U16a | 恢复归档（原列已删/隐藏） | 归档区卡（原列已删除） | restoreTask（不传 toColumnId） | **回 Done**（B1 缺省，P1-B2-2） | 目标列=Done | B2 验收 |
| U17 | 彻底删除 | 归档区卡 | purgeTask | 级联清 timeline/附件/executions；归档视图不再显示 | 无残留 | B2 验收 |
| U18 | 评论增删 | user 评论 | addComment→deleteComment | 增删成功 + 附件清理 | 重启不复活 | B2 验收 |
| U19 | 删 agent 评论 | agent 评论 | deleteComment | validation-error（Q-028 只读） | 不可删 | B2 验收 |
| U20 | 视图切换 | — | 看板/列表/归档 | 同数据多视图渲染；**切换不重新取数（同一内存态换过滤条件），active/archive 集合互补且数据一致**（P2-B2-2） | 无写 | B2 验收 |
| U21 | 列表排序筛选 | 多卡 | 排序/筛选 | 白名单排序 + 筛选生效 | 无写 | B2 验收 |
| U22 | 编辑 auto 缺 AC | auto 卡 | 保存缺 AC | 标红拦截（CON-R018 门控） | 不落盘 | B2 验收 |
| U23 | 删除执行中卡 | running 卡 | deleteTask | store-task-executing（执行中不可删） | 不可删 | B2 验收 |
| U24 | 删除看板含 ticket | 看板有 ticket | deleteBoard | store-board-not-empty（先清空 ticket） | 看板保留 | B2 验收 |
| U25 | 子任务跨列 | 子卡在子列 | 查看 | 独立显示+父引用徽标+父卡聚合 | 无写 | B2 验收 |
| U26 | 删除卡片确认 | 父卡含子卡 | deleteTask | 级联提示（子任务一并删）二次确认 | 级联删子卡 | B2 验收 |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| 无 | — | — | — | — |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| preload 桥 | B2 renderer 经 preload 调 B1 IPC；channel 命名对齐 B1 契约 16 原语（`kanban:` 前缀） | phper666 | 已定（B1 冻结） | 已闭环 |
| 列表/归档视图渲染 | 视图切换在 B2 UI 层（不改数据模型），需与 B3 状态视图协同 | phper666 | B3 契约 | 待定 |
| 拖拽冲突确认 | 冲突弹窗后 moveTask 由 B2 触发（B1 只落 columnId） | phper666 | 已定 | 已闭环 |
| 归档 UI | archive/restore/purge 由 B2 调用（B1 提供原语） | phper666 | 已定 | 已闭环 |

## 完成记录

> 交付后填写，结果必须有证据。

| 项 | 结果 |
|:---|:-----|
| 交付时间 | — |
| 验证结果 | — |
| 构建/发布 | — |
| 偏差处理 | — |

## 决策与踩坑

- 前端 UI 契约形态：B2 无新增数据接口，全部消费 B1 16 IPC 原语 + 7 错误码；契约核心 = UI 场景清单 + IPC 消费映射 + UI 专属状态（视图切换/筛选/拖拽冲突/空态）。复用场景：B2 类纯 UI 消费子需求契约同构。
- 视图切换为 UI 层行为（决策 3）：看板/列表/归档同 tasks 数据多视图渲染，不改数据模型，避免数据分叉。
- 归档区取数（P1-B2-1）：getTasks 全量返回含 archivedAt，B2 视图层按 archivedAt 过滤——B1 不区分归档取数通道，避免双通道数据分叉；归档/活动过滤是 B2 UI 状态（archiveFilter）非数据查询。
- 恢复目标列（P1-B2-2）：B2 不暴露 toColumnId，走 B1 缺省（原列 archivedFromColumnId，已删/隐藏则 Done）——与 Blocked 解除同构，单侧规则可测。

## 变更记录

| 时间 | 类型 | 摘要 |
|---|---|---|
| 2026-08-20 | 初次生成 | 基于 t100102（B2）和共识 v1.4 §12 + B1 契约 16 原语生成契约草案 |
| 2026-08-21 | 复核修复 | ora-1：P1-B2-1 getTasks 全量过滤语义（三视图按 archivedAt 各自过滤，补 U14/U17 断言）；P1-B2-2 恢复目标列定死（B2 不传 toColumnId，走 B1 缺省回原列/已删隐藏则 Done，补 U16/U16a 断言）；P2-B2-1 "仅 Done"校验归属 B1、B2 前置置灰；P2-B2-2 视图切换一致性断言（U20）；P2-B2-3 preload 桥闭环 |

## 自检记录

- 追踪完整性：PASS（B2→CON-R020/022/026/031/033 + Q-021/027/028→验收，追踪矩阵全覆盖）
- OpenAPI 一致性：不适用（本地 UI + IPC 消费契约，无 OpenAPI yaml）
- 示例与错误场景：PASS（27 个 UI 场景 U1~U26 + U16a 含成功/失败/边界 + 7 错误码消费）
- 安全与敏感字段：PASS（无敏感字段；UI 只消费 IPC，不触 DSH_HOME）
- 链接与格式：PASS
