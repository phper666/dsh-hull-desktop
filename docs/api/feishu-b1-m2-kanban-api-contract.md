# B1 看板数据模型与持久化契约

## 契约信息

- 工作项：B1 看板数据模型与持久化（飞书 dsh-hull-desktop 清单，t100101）
- 契约状态：待评审
- 版本：v0.1
- 适用版本：M2（共识 v1.3）
- 最后更新：2026-08-20
- 说明：桌面壳本地数据契约（无 HTTP API 面）；核心 = boards.json JSON Schema + 持久化行为约束（原子写/损坏恢复/schema 迁移/加载性能）+ IPC 数据读写原语（B2/B3 消费）

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| 数据模型 schema | B1 | CON-R017/023/024 + Q-013/014/020 | Board/Column/Task/SubTask/ExecutionRecord/Comment schema 完整 | boards.json Schema | 已定义 |
| 多项目看板 | B1 | CON-R031（决策 1） | boards[] 顶层，每 Board 独立列配置/任务 | boards.json Schema | 已定义 |
| 原子写 | B1 | CON-R017 | temp+rename，写失败不破坏现有数据 | 持久化层 | 已定义 |
| 损坏恢复 | B1 | CON-R017 | 解析失败 → 备份 corrupt-<ts> → 重建默认看板 | 持久化层 | 已定义 |
| schema 迁移 | B1 | CON-R017 | version 递增 + 迁移函数；迁移失败走备份重建 | 持久化层 | 已定义 |
| 加载性能 | B1 | CON-R023 | ≤5MB 冷启动 <500ms | 加载层 | 已定义 |
| DSH_HOME 零接触 | B1 | CON-R017（CON-R002 延伸） | 数据落 userData/kanban，不碰 DSH_HOME | 数据归属 | 已定义 |

## 范围与非目标

### 范围

- boards.json 完整 JSON Schema（Board/Column/Task/SubTask/ExecutionRecord/Comment 全字段，含 Q-013 executionStatus/currentExecutionId、Q-014 dependencies、Q-020 assignee、agentSpec/subagentPolicy）
- 持久化行为：原子写（temp+rename）、损坏备份重建、schema version 迁移、加载性能（≤5MB <500ms 冷启动）
- 数据归属：`<userData>/kanban/boards.json`，不触 DSH_HOME
- IPC 数据读写原语（B1 提供，B2/B3 消费）：getBoards/createBoard/updateBoard/getTasks/createTask/updateTask/moveTask/deleteTask/deleteBoard 等

### 非目标

- 执行引擎/状态机调度（B3）
- 执行集成/ACP/审批（B4）
- 看板 UI/交互/拖拽（B2）
- 导出/导入（B5，FR-16）
- 多设备同步/实时协作（M2+，O-4 关联）
- 数据加密/SQLite 迁移（P2，O-3 定案）

## 业务流程与状态

### 核心流程

```text
壳启动 → 加载 boards.json → 校验 version + 解析 → 损坏则备份重建 → 内存态就绪
用户 CRUD/流转/评论 → 变更内存态 → 防抖 500ms → 原子写（temp+rename）
写失败 → 提示错误，内存态保留，下次成功写重试
```

### 状态转换（持久化层）

| 当前状态 | 动作 | 目标状态 | 前置条件 | 冲突行为 | 依据 |
|---|---|---|---|---|---|
| 未加载 | 加载成功 | 就绪 | 文件存在且解析成功 | 无 | PRD FR-5 |
| 未加载 | 文件不存在 | 就绪（新建默认） | 首进自动建默认看板+6 列 | 无 | FR-2 |
| 未加载 | 解析失败 | 就绪（备份重建） | 文件损坏 | 备份 corrupt-<ts> + 重建默认 + 提示 | §9 |
| 未加载 | version 不兼容 | 就绪（迁移） | 有迁移函数 | 跑迁移；失败走备份重建 | §9/R2 |
| 就绪 | 写失败 | 就绪（内存保留） | 磁盘只读/满 | 提示错误，内存态不丢，下次成功写重试 | §9 |
| 就绪 | 变更 | 就绪（防抖写） | 任意 CRUD/流转 | 500ms 防抖后原子写 | FR-5 |

## 接口清单

> B1 为本地数据契约，无 HTTP paths；"接口" = IPC 数据读写原语（主进程 KanbanStore 暴露，preload 桥接，renderer 消费）。字段细节见 Schema 章。

| # | 状态 | 方法 | 路径（IPC channel） | 用途 | 权限 | 幂等 |
|---|---|---|---|---|---|---|
| 1 | 已定义 | invoke | `kanban:getBoards` | 获取看板列表 | 无（壳内） | 读 |
| 2 | 已定义 | invoke | `kanban:createBoard` | 创建看板（项目） | 无 | 否（创建） |
| 3 | 已定义 | invoke | `kanban:updateBoard` | 重命名/排序看板 | 无 | 是 |
| 4 | 已定义 | invoke | `kanban:deleteBoard` | 删除看板（级联任务） | 无 | 否（删除） |
| 5 | 已定义 | invoke | `kanban:getTasks` | 获取某看板任务列表 | 无 | 读 |
| 6 | 已定义 | invoke | `kanban:createTask` | 创建任务/子任务 | 无 | 否（创建） |
| 7 | 已定义 | invoke | `kanban:updateTask` | 更新任务字段 | 无 | 是 |
| 8 | 已定义 | invoke | `kanban:moveTask` | 移动任务到列 | 无 | 是 |
| 9 | 已定义 | invoke | `kanban:deleteTask` | 删除任务（级联子任务） | 无 | 否（删除） |

## Schema 与枚举

> 字段结构唯一权威 = 本契约 JSON Schema（本地文件数据契约，无 OpenAPI yaml）；枚举值须与共识 §9 一致。

### boards.json 顶层

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| version | integer | 是 | 否 | 默认 1；不兼容演进递增 + 迁移函数 | 无 | schema 版本 |
| boards | array[Board] | 是 | 否 | 多项目看板（决策 1）；空数组合法 | 无 | 顶层看板列表 |

### Board

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| id | string | 是 | 否 | `b_<uuid>` | 无 | 看板唯一标识 |
| name | string | 是 | 否 | ≤200 字符，可重命名 | 无 | 看板名（项目名） |
| columns | array[Column] | 是 | 否 | 默认 6 态模板列 | 无 | 列配置（独立于其他看板） |
| tasks | array[Task] | 是 | 否 | 空起步 | 无 | 任务集合 |
| order | integer | 是 | 否 | 数字 | 无 | 看板排序 |
| createdAt / updatedAt | string | 是 | 否 | ISO 8601 UTC | 无 | 创建/更新时间 |

### Column

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| id | string | 是 | 否 | `c_<uuid>` | 无 | 列唯一标识 |
| type | string | 否 | 是 | backlog/todo/in_progress/verify/done/blocked（仅模板列有，唯一、不可删） | 无 | 模板列类型 |
| name | string | 是 | 否 | ≤200 字符 | 无 | 列名（默认 6 态模板名） |
| order | integer | 是 | 否 | 数字 | 无 | 列排序 |
| color | string | 是 | 否 | 十六进制色值 | 无 | 列头色带（列语义） |
| hidden | boolean | 是 | 否 | 默认 false（Blocked 默认显示） | 无 | 隐藏/显示（Q-027：隐藏=过滤，数据保留） |

### Task（卡片，含 SubTask）

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| id | string | 是 | 否 | `t_<uuid>` | 无 | 任务唯一标识 |
| parentId | string | 否 | 是 | 非空即子任务（指向父任务 id）；单层嵌套 | 无 | 父任务引用 |
| columnId | string | 是 | 否 | 所在列；默认 Todo | 无 | 看板列 |
| title | string | 是 | 否 | ≤200 字符 | 无 | 标题 |
| executionMode | string | 是 | 否 | manual（默认）/ auto | 无 | 执行模式 |
| executionStatus | string | 是 | 否 | idle（默认）/ queued / running / paused / interrupted / cancelled / failed / succeeded（Q-013） | 无 | 执行生命周期（与 columnId 双轨解耦） |
| currentExecutionId | string | 否 | 是 | 指向 timeline execution 条目 id（Q-013） | 无 | 当前执行 |
| acceptanceCriteria | object | 否 | auto 必填 | what/expected/verify 强校验必填 + context 可选 | 无 | 验收标准（auto 模式必填） |
| agentSpec | object | 否 | 是 | 见下 | 无 | agent 指定 |
| dependencies | array[string] | 否 | 是 | 子任务 ID 数组；空=无依赖可并行（Q-014）；仅子任务可声明（同父下） | 无 | 依赖声明 |
| description | string | 否 | 是 | Markdown | 无 | 描述 |
| labels | array[string] | 否 | 是 | 彩色小徽标 | 无 | 标签 |
| priority | string | 否 | 是 | P0/P1/P2/无（默认 P2） | 无 | 优先级 |
| assignee | string | 否 | 是 | 可空；纯展示/筛选，无权限语义（Q-020） | 无 | 负责人 |
| dueDate | string | 否 | 是 | 日期，可空 | 无 | 截止日期 |
| order | integer | 是 | 否 | 数字 | 无 | 列内排序 |
| blockedFromColumnId | string | 否 | 是 | Blocked 来源列，解除时恢复（来源列已删则回 Todo） | 无 | Blocked 来源 |
| createdAt / updatedAt | string | 是 | 否 | ISO 8601 UTC | 无 | 创建/更新时间 |
| timeline | array[TimelineItem] | 是 | 否 | 统一时间线（评论+执行+系统） | 无 | 时间线 |

### agentSpec

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| provider | string | 是 | 否 | 默认 'dsh'，预留其他平台 | 无 | agent 平台 |
| agent | string | 否 | 是 | 可空 | 无 | 具体 agent |
| model | string | 否 | 是 | 可空 | 无 | 模型 |
| subagentPolicy | string | 否 | 否 | 'auto'（默认）/ 'restricted'（CON-R030） | 无 | 子 agent 策略 |

### TimelineItem（Comment / ExecutionRecord / SystemEvent 统一）

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| id | string | 是 | 否 | `tl_<uuid>` | 无 | 条目唯一标识 |
| type | string | 是 | 否 | comment / execution / system | 无 | 条目类型 |
| content | string | 是 | 否 | 评论文本/执行摘要/事件描述 | 无 | 内容 |
| attachments | array[Attachment] | 否 | 是 | 落盘 `<userData>/kanban/attachments/<timelineId>/` | 无 | 附件引用 |
| createdAt | string | 是 | 否 | ISO 8601 UTC | 无 | 时间 |
| author | string | 否 | 是 | 显示名，可空 | 无 | 作者 |
| source | object | 是 | 否 | { type: user/agent/system, agentId?, provider? } | 无 | 来源 |
| execution | object | 否 | 是 | 见下；type=execution 时携带 | 无 | 执行详情 |

### Attachment

| 字段 | 类型 | 必填 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|
| name | string | 是 | — | 无 | 文件名 |
| path | string | 是 | `kanban/attachments/tl_<uuid>/<file>` | 无 | 相对路径 |
| size | integer | 是 | ≤maxAttachmentSizeMB（默认 10） | 无 | 文件大小（字节） |

### ExecutionRecord（timeline[].execution）

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| status | string | 是 | 否 | queued/running/succeeded/failed/paused/interrupted/cancelled | 无 | 执行状态 |
| command | string | 是 | 否 | 实际下发 agent 命令 | 无 | 命令 |
| startedAt | string | 是 | 否 | ISO 8601 UTC（Q-025：执行开始即写） | 无 | 开始时间 |
| finishedAt | string | 否 | 是 | ISO 8601 UTC（Q-025：完成补） | 无 | 完成时间 |
| exitCode | integer | 否 | 是 | — | 无 | 退出码 |
| outputPath | string | 否 | 是 | `kanban/executions/e_<uuid>.log` | 无 | 完整输出落盘 |
| selfCheck | object | 否 | 是 | { passed: boolean, evidence?: string }（Q-015） | 无 | auto 自验判定信号 |

### 枚举与状态

| 类型 | 值 | 含义 | 可用于请求 | 可出现在响应 |
|---|---|---|---|---|
| column.type | backlog/todo/in_progress/verify/done/blocked | 模板列类型 | 否（系统生成） | 是 |
| executionMode | manual/auto | 执行模式 | 是 | 是 |
| executionStatus | idle/queued/running/paused/interrupted/cancelled/failed/succeeded | 执行生命周期（Q-013） | 否（系统流转） | 是 |
| priority | P0/P1/P2/无 | 优先级 | 是 | 是 |
| source.type | user/agent/system | 来源 | 否 | 是 |
| timeline.type | comment/execution/system | 条目类型 | 部分（comment 可写） | 是 |
| agentSpec.subagentPolicy | auto/restricted | 子 agent 策略 | 是 | 是 |

### 公共异常集

#### KANBAN_STORE_ERROR（本地数据层）

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| STORE_IO_ERROR | 磁盘写失败（只读/满） | code + msg | 提示错误，内存态保留，下次成功写重试 | 是 |
| STORE_CORRUPTED | 解析失败/损坏 | code + msg + rebuilt=true | 提示已备份重建 | 否（已重建） |
| STORE_MIGRATE_FAILED | schema 迁移失败 | code + msg + rebuilt=true | 提示已备份重建 | 否（已重建） |
| VALIDATION_ERROR | 字段校验失败（如 auto 缺 AC、标题空） | code + msg + field | 提示具体字段 | 否 |

## 接口详情

### 1. getBoards

`invoke kanban:getBoards`

#### 用途与依据

- 使用场景：壳 UI 加载看板列表/切换看板
- 共识：CON-R017/R031
- 验收：多项目看板（创建/切换，各 Board 独立列+任务）

#### 请求

无请求体；返回全部 boards。

#### 成功响应

- 响应 Schema：`boards.json` 顶层（`{ version, boards[] }`）

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `version` | integer | 是 | 否 | 当前 schema 版本 | — |
| `boards[]` | array[Board] | 是 | 否 | 空数组合法 | 看板列表 |

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 无特有异常。

#### 幂等与并发

- 读操作，无幂等要求；返回内存态快照。

### 2. createBoard

`invoke kanban:createBoard { name }`

#### 用途与依据

- 使用场景：用户创建新看板（项目）
- 共识：CON-R031（决策 1）
- 验收：多项目看板创建

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | name | string | 是 | ≤200 字符，非空 | 看板名 |
| body | columns | array[Column] | 否 | 缺省自动建 6 态模板列 | 列配置（可自定义） |

#### 成功响应

- 响应 Schema：`Board`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `id` | string | 是 | 否 | 系统生成 `b_<uuid>` | 看板 id |
| `name` | string | 是 | 否 | 用户输入 | 看板名 |
| `columns` | array[Column] | 是 | 否 | 6 态模板列 | 列配置 |
| `tasks` | array[Task] | 是 | 否 | 空 | 任务集合 |
| `createdAt/updatedAt` | string | 是 | 否 | 系统生成 | 时间戳 |

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| VALIDATION_ERROR | name 空/超长 | code+msg+field | 提示字段 | 否 |

#### 幂等与并发

- 幂等键：无（每次创建新看板）
- 重复请求：创建多个同名看板（业务允许）

### 3. updateBoard

`invoke kanban:updateBoard { id, name?, order? }`

#### 用途与依据

- 使用场景：重命名/排序看板
- 共识：CON-R031

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | id | string | 是 | `b_<uuid>` | 看板 id |
| body | name | string | 否 | ≤200 字符 | 新名 |
| body | order | integer | 否 | 数字 | 新排序 |

#### 成功响应

- 响应 Schema：`Board`（更新后）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：无（id 不存在 → 通用 not found，见协调事项）。

#### 幂等与并发

- 幂等：是（同名/同序重复更新结果一致）

### 4. deleteBoard

`invoke kanban:deleteBoard { id }`

#### 用途与依据

- 使用场景：删除看板（级联任务）
- 共识：CON-R031

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | id | string | 是 | `b_<uuid>` | 看板 id |

#### 成功响应

- 响应：删除成功（无 body 或 `{ deleted: true }`）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| VALIDATION_ERROR | 删除唯一看板/看板不存在 | code+msg | 提示 | 否 |

> 注：删除看板级联清理任务 + 附件 + executions 日志（级联清理规则 Q-019 由 B3 消费，B1 数据层提供原子删除原语）。

### 5. getTasks

`invoke kanban:getTasks { boardId }`

#### 用途与依据

- 使用场景：加载某看板任务
- 共识：CON-R017

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |

#### 成功响应

- 响应 Schema：`array[Task]`

| 字段路径 | 类型 | 必有 | 可空 | 说明 |
|---|---|---|---|---|
| `[]` | array[Task] | 是 | 否 | 空数组合法（空看板） |
| `[].id` | string | 是 | 否 | `t_<uuid>` |
| `[].executionStatus` | string | 是 | 否 | 8 态（Q-013） |
| `[].parentId` | string | 否 | 是 | 子任务引用 |
| `[].timeline` | array[TimelineItem] | 是 | 否 | 时间线 |

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 无特有异常。

### 6. createTask

`invoke kanban:createTask { boardId, title, columnId?, parentId?, executionMode?, ... }`

#### 用途与依据

- 使用场景：新建任务/子任务
- 共识：CON-R017；AC 强校验（CON-R018，B3/B4 消费时门控）
- 验收：卡片 CRUD 即时生效并持久化

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | title | string | 是 | ≤200 字符，非空 | 标题 |
| body | columnId | string | 否 | 缺省 Todo | 初始列 |
| body | parentId | string | 否 | 单层嵌套（父卡 id） | 建子任务 |
| body | executionMode | string | 否 | manual（默认）/auto | 执行模式 |
| body | acceptanceCriteria | object | auto 必填 | what/expected/verify 强校验必填 + context 可选 | AC（auto 模式必填） |
| body | priority/assignee/dueDate/labels/description | — | 否 | 见 Schema | 可选字段 |

#### 成功响应

- 响应 Schema：`Task`（创建后，含系统生成的 id/order/createdAt/executionStatus=idle/timeline=[]）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| VALIDATION_ERROR | 标题空/超长；auto 缺 AC 必填项 | code+msg+field | 提示字段 | 否 |

#### 幂等与并发

- 幂等键：无（每次创建新任务）
- 重复请求：创建多条（业务允许）

### 7. updateTask

`invoke kanban:updateTask { boardId, id, ...fields }`

#### 用途与依据

- 使用场景：编辑任务字段（标题/描述/AC/assignee/dependencies/executionMode 等）
- 共识：CON-R017

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | id | string | 是 | `t_<uuid>` | 任务 id |
| body | 可编辑字段 | — | 否 | 标题/描述/标签/优先级/assignee/dueDate/AC/executionMode/dependencies | 部分更新 |

> 约束：`executionStatus`/`currentExecutionId`/`timeline` 由系统管理，不通过 updateTask 直接改（B3 调度层写）。

#### 成功响应

- 响应 Schema：`Task`（更新后，updatedAt 刷新）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：无。

#### 幂等与并发

- 幂等：是（同字段重复更新结果一致）

### 8. moveTask

`invoke kanban:moveTask { boardId, id, toColumnId, blockedFromColumnId? }`

#### 用途与依据

- 使用场景：卡片状态流转（菜单/拖拽）
- 共识：CON-R020（人工拖拽最高优先级，不自动矫正）
- 验收：卡片可移动到任意列；Blocked 解除回来源列

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | id | string | 是 | `t_<uuid>` | 任务 id |
| body | toColumnId | string | 是 | 目标列（可含 Blocked） | 目标列 |
| body | blockedFromColumnId | string | 否 | 进入 Blocked 时记录来源列 | Blocked 来源 |

#### 成功响应

- 响应 Schema：`Task`（columnId 更新；**不改变 executionStatus**——双轨解耦 Q-013；updatedAt 刷新；父卡聚合由 B2 消费重算）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| VALIDATION_ERROR | 目标列不存在 | code+msg+field | 提示 | 否 |

#### 幂等与并发

- 幂等：是（同目标列重复移动结果一致）
- 冲突行为：执行中拖到其他列 → 执行不终止，列以人工为准（B3 执行层处理，B1 只落 columnId）

### 9. deleteTask

`invoke kanban:deleteTask { boardId, id }`

#### 用途与依据

- 使用场景：删除任务/父卡（级联子任务）
- 共识：CON-R017/024
- 验收：删除有确认；父卡删除级联子卡有明确提示

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | id | string | 是 | `t_<uuid>` | 任务 id |

#### 成功响应

- 响应：删除成功（`{ deleted: true }`）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| VALIDATION_ERROR | 任务不存在 | code+msg | 提示 | 否 |

> 注：级联删除子任务/评论/附件/executions 日志（Q-019 完整规则由 B3 执行层校验执行态后触发；B1 提供原子删除原语）。

## 数据库与外部系统影响

> 无变化（本地 JSON 单文件，无外部系统）。数据归属 `<userData>/kanban/boards.json`，不触 DSH_HOME（CON-R002）。

## 联调与测试场景

| 场景 | 前置条件 | 请求/动作 | 预期结果 | 数据与审计结果 | 验收编号 |
|---|---|---|---|---|---|
| 多项目看板创建/切换 | 空数据 | createBoard×2 + getBoards | 2 看板独立列/任务，切换正确 | boards[] 2 项 | B1 验收 |
| 卡片 CRUD 持久化 | 默认看板 | createTask→updateTask→重启 | 数据完整恢复 | boards.json 持久化 | B1 验收 |
| 原子写失败 | 磁盘只读 | updateTask | 提示错误，内存态保留，数据不坏 | 原 boards.json 不变 | B1 验收 |
| 损坏重建 | 注入损坏 JSON | 加载 | 备份 corrupt-<ts> + 重建默认看板 + 提示 | 备份文件生成 | B1 验收 |
| schema 迁移 | version=1 数据 + v2 迁移函数 | 加载 | 跑迁移函数成功，version=2 | 数据转换正确 | B1 验收 |
| schema 迁移失败 | 迁移函数抛错 | 加载 | 备份 + 重建 + 提示 | 备份文件生成 | B1 验收 |
| 加载性能 | 构造 ≤5MB（1000+ 卡） | 冷启动 | <500ms | 计时达标 | B1 验收 |
| 子任务级联删除 | 父卡含 2 子卡 | deleteTask(父) | 级联删子任务 | 无孤儿任务 | B1 验收 |
| DSH_HOME 零接触 | — | 全部操作 | 不读写 DSH_HOME | userData 内 | CON-R017 |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| 无 | — | — | — | — |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| not found 错误码命名 | B2/B3 消费方需统一 STORE 错误码 | phper666 | 契约评审前 | 待定 |
| 执行态字段写入权 | B1 updateTask 不写 executionStatus，B3 调度层写 | phper666 | B3 契约 | 已定（本契约约束） |
| IPC channel 命名与 preload 桥 | B2/B3 消费同一 preload 桥 | phper666 | B2 契约 | 待定 |

## 完成记录

> 交付后填写，结果必须有证据。

| 项 | 结果 |
|:---|:-----|
| 交付时间 | — |
| 验证结果 | — |
| 构建/发布 | — |
| 偏差处理 | — |

## 决策与踩坑

- 本地 JSON 数据契约形态：桌面壳数据层无 HTTP API 面（同 M1 模式），契约核心 = JSON Schema + 持久化行为约束，接口清单用 IPC 数据读写原语表达。复用场景：M2 其余子需求（B2/B3/B5）契约同构。

## 变更记录

| 时间 | 类型 | 摘要 |
|---|---|---|
| 2026-08-20 | 初次生成 | 基于 t100101（B1）和共识 v1.3 §7.1/§9/§13 生成契约草案 |

## 自检记录

- 追踪完整性：PASS（B1→CON-R017/023/024/R031 + Q-013/014/020→验收，追踪矩阵全覆盖）
- OpenAPI 一致性：不适用（本地文件数据契约，无 OpenAPI yaml；JSON Schema 即字段唯一事实源）
- 示例与错误场景：PASS（9 个联调场景含成功/失败/边界 + 公共异常集）
- 安全与敏感字段：PASS（无敏感字段；DSH_HOME 零接触声明）
- 链接与格式：PASS
