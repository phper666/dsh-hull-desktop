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
| 数据模型 schema | B1 | CON-R017/023/024 + Q-013/014/015/020/025 | Board/Column/Task/SubTask/ExecutionRecord/Comment schema 完整 | boards.json Schema | 已定义 |
| 多项目看板 | B1 | CON-R031（决策 1） | boards[] 顶层，每 Board 独立列配置/任务 | boards.json Schema | 已定义 |
| 原子写 | B1 | CON-R017 | temp+rename，写失败不破坏现有数据 | 持久化层 | 已定义 |
| 损坏恢复 | B1 | CON-R017 | 解析失败 → 备份 corrupt-<ts> → 重建默认看板 | 持久化层 | 已定义 |
| schema 迁移 | B1 | CON-R017 | version 递增 + 迁移函数；迁移失败走备份重建 | 持久化层 | 已定义 |
| 加载性能 | B1 | CON-R023 | ≤5MB 冷启动 <500ms | 加载层 | 已定义 |
| DSH_HOME 零接触 | B1 | CON-R017（CON-R002 延伸） | 数据落 userData/kanban，不碰 DSH_HOME | 数据归属 | 已定义 |
| 评论来源/删除权限 | B1 | CON-R025 + Q-028 | user 评论可删；agent 评论只读 | kanban:deleteComment | 已定义 |
| 执行态/记录字段 | B1 | Q-015/Q-025 + CON-R030 | selfCheck/statedAt-finishedAt/subagentPolicy | ExecutionRecord Schema | 已定义 |
| 删除守卫 | B1 | Q-019 + CON-R033 | running/queued 禁删；看板含 ticket（含归档）拒删 | deleteTask/deleteBoard | 已定义 |
| 归档 | B1 | CON-R033（决策 1/2） | Done 可归档 + 恢复/彻底删除；archivedAt/archivedFromColumnId | archiveTask/restoreTask/purgeTask | 已定义 |
| 列删除 | B1 | CON-R020 + PRD FR-2 | 自定义列可删（列内卡入 Todo）；模板列拒删 | kanban:deleteColumn | 已定义 |

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
| 10 | 已定义 | invoke | `kanban:addComment` | 追加评论（manual 结果回填/user 评论） | 无 | 否（创建） |
| 11 | 已定义 | invoke | `kanban:deleteComment` | 删除评论（仅 user 评论，Q-028） | 无 | 否（删除） |
| 12 | 已定义 | invoke | `kanban:updateColumn` | 更新列配置（改名/排序/颜色/隐藏） | 无 | 是 |
| 13 | 已定义 | invoke | `kanban:deleteColumn` | 删除自定义列（列内卡片移入 Todo） | 无 | 否（删除） |
| 14 | 已定义 | invoke | `kanban:archiveTask` | 归档 Done ticket（CON-R033） | 无 | 是 |
| 15 | 已定义 | invoke | `kanban:restoreTask` | 恢复归档 ticket（回 Done 或原列） | 无 | 是 |
| 16 | 已定义 | invoke | `kanban:purgeTask` | 彻底删除归档 ticket（级联清理） | 无 | 否（删除） |

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
| archivedAt | string | 否 | 是 | 空=未归档；非空=在归档区（CON-R033，决策 1） | 无 | 归档时间 |
| archivedFromColumnId | string | 否 | 是 | 归档前所在列，恢复用（回原列或 Done） | 无 | 归档来源列 |
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

> **写入权（P1-1 定稿）**：timeline 条目由三层写入——① store 层自动追加 **system 事件**（createTask：创建事件；moveTask：`from→to`/user；deleteTask：删除事件；addComment/deleteComment：评论增删事件）；② B3 调度层写 **execution 记录**（仅 execution 类型）；③ B2 通过 `addComment` 写 **user 评论**。B2 无直接写 timeline 通道，避免多写入口冲突。

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

### 最小 boards.json 示例

```jsonc
{
  "version": 1,
  "boards": [
    {
      "id": "b_2f5a1c00-0000-4000-8000-000000000001",
      "name": "默认看板",
      "order": 0,
      "createdAt": "2026-08-20T09:00:00.000Z",
      "updatedAt": "2026-08-20T09:00:00.000Z",
      "columns": [
        { "id": "c_backlog", "type": "backlog", "name": "Backlog", "order": 0, "color": "#8b949e", "hidden": false },
        { "id": "c_todo", "type": "todo", "name": "Todo", "order": 1, "color": "#58a6ff", "hidden": false },
        { "id": "c_in_progress", "type": "in_progress", "name": "In Progress", "order": 2, "color": "#d29922", "hidden": false },
        { "id": "c_verify", "type": "verify", "name": "Verify", "order": 3, "color": "#a371f7", "hidden": false },
        { "id": "c_done", "type": "done", "name": "Done", "order": 4, "color": "#3fb950", "hidden": false },
        { "id": "c_blocked", "type": "blocked", "name": "Blocked", "order": 5, "color": "#f85149", "hidden": false }
      ],
      "tasks": []
    }
  ]
}
```

### 公共异常集

#### KANBAN_STORE_ERROR（本地数据层）

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---|:---:|
| store-io-error | 磁盘写失败（只读/满） | code + msg | 提示错误，内存态保留，下次成功写重试 | 是 |
| store-corrupt | 解析失败/损坏 | code + msg + rebuilt=true | 提示已备份重建 | 否（已重建） |
| store-migrate-failed | schema 迁移失败 | code + msg + rebuilt=true | 提示已备份重建 | 否（已重建） |
| store-not-found | board/task/comment 不存在（已删除） | code + msg | 提示"数据已删除，自动刷新" | 否 |
| store-task-executing | 任务 running/queued 时删除（Q-019 执行态守卫） | code + msg | 提示"执行中不可删" | 否 |
| store-board-not-empty | 看板含 ticket（含归档）时删除（CON-R033） | code + msg | 提示"先清空全部 ticket（含归档）" | 否 |
| validation-error | 真输入校验失败（标题空/超长、auto 缺 AC、目标列不存在） | code + msg + field | 提示具体字段 | 否 |

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
| validation-error | name 空/超长 | code+msg+field | 提示字段 | 否 |

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
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---|:---:|
| store-not-found | 看板 id 不存在 | code+msg | 提示"数据已删除，自动刷新" | 否 |

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
|---|---:|---:|---|---|:---:|
| store-not-found | 看板 id 不存在 | code+msg | 提示"数据已删除，自动刷新" | 否 |
| store-board-not-empty | 看板含 ticket（含归档） | code+msg | 提示"先清空全部 ticket（含归档）" | 否 |
| validation-error | 删除最后一个看板（可改名替代） | code+msg | 提示"最后一个看板不可删，可改名" | 否 |
| store-task-executing | 看板内任务 running/queued（含归档外的执行中） | code+msg | 提示"执行中不可删" | 否 |

> **删除规则（CON-R033 对齐，P1-D/E）**：删除看板——有 ticket（含归档）→ 拒删（store-board-not-empty）；看板内任务执行中 → 拒删（store-task-executing）；无 ticket → 可删；最后一个看板 → 不可删（可改名，validation-error）。原"删除唯一看板 → validation-error"规则废弃，替换为本规则。删除成功后级联清理全部任务 + 附件 + executions log。

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
| body | dependencies | array[string] | 否 | 子任务 ID 数组（仅子任务可声明，同父下） | 依赖声明（P2-3：建子任务时一次声明） |
| body | priority/assignee/dueDate/labels/description | — | 否 | 见 Schema | 可选字段 |

#### 成功响应

- 响应 Schema：`Task`（创建后，含系统生成的 id/order/createdAt/executionStatus=idle/timeline=[]；store 自动追加 system 创建事件）

```json
{
  "id": "t_1a2b3c4d-0000-4000-8000-000000000001",
  "parentId": null,
  "columnId": "c_todo",
  "title": "实现看板拖拽流转",
  "executionMode": "manual",
  "executionStatus": "idle",
  "currentExecutionId": null,
  "acceptanceCriteria": null,
  "agentSpec": { "provider": "dsh", "agent": null, "model": null, "subagentPolicy": "auto" },
  "dependencies": [],
  "priority": "P1",
  "assignee": null,
  "dueDate": null,
  "order": 0,
  "blockedFromColumnId": null,
  "createdAt": "2026-08-20T10:00:00.000Z",
  "updatedAt": "2026-08-20T10:00:00.000Z",
  "timeline": [
    { "id": "tl_00000001-0000-4000-8000-000000000001", "type": "system",
      "content": "任务创建", "attachments": [], "createdAt": "2026-08-20T10:00:00.000Z",
      "author": "system", "source": { "type": "system" }, "execution": null }
  ]
}
```

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---|:---:|
| validation-error | 标题空/超长；auto 缺 AC 必填项；dependencies 引用非同级子任务 | code+msg+field | 提示字段 | 否 |
| store-not-found | parentId/columnId 不存在 | code+msg | 提示"数据已删除，自动刷新" | 否 |

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
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---|:---:|
| store-not-found | 任务 id 不存在（已删除） | code+msg | 提示"数据已删除，自动刷新" | 否 |
| validation-error | dependencies 引用非同级子任务（编辑时校验，同 createTask）；executionMode 切 auto 缺 AC（CON-R018 门控）；直接改 executionStatus/currentExecutionId/timeline（系统管理字段） | code+msg+field | 提示具体字段 | 否 |

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

> **Blocked 语义（P2-4）**：store 入 Blocked 时自动记 `blockedFromColumnId`（取当前 columnId）；解除 Blocked（toColumnId 非 Blocked）时——来源列非隐藏列 → 自动还原到来源列；来源列已删除或隐藏 → 回 Todo。

#### 成功响应

- 响应 Schema：`Task`（columnId 更新；**不改变 executionStatus**——双轨解耦 Q-013；updatedAt 刷新；store 自动追加 system 事件 `from→to`/user；父卡聚合由 B2 消费重算）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| validation-error | 目标列不存在 | code+msg+field | 提示 | 否 |

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
|---|---:|---:|---|---|:---:|
| store-not-found | 任务 id 不存在 | code+msg | 提示"数据已删除，自动刷新" | 否 |
| store-task-executing | 任务 running/queued（含子任务执行中）时删除（Q-019 守卫） | code+msg | 提示"执行中不可删" | 否 |

> **执行态守卫归属（P1-B）**：B1 store 内置校验——deleteTask 删除前检查目标任务及全部子任务 executionStatus，任一 running/queued → 拒绝（store-task-executing）。B2 删除按钮直接调 B1 也受此守卫（不依赖 B3 前置校验），B3 调度层删除原语同样走此校验。级联删除子任务/评论/附件/executions log（Q-019）+ 清理其他子任务 dependencies 引用（二次确认）。

### 10. addComment

`invoke kanban:addComment { boardId, taskId, content, attachments[] }`

#### 用途与依据

- 使用场景：追加评论（manual 模式结果回填 / 用户评论）
- 共识：CON-R025（评论来源区分）；PRD FR-9
- 验收：手动模式可粘贴文本 + 添加文件引用作为评论

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | taskId | string | 是 | `t_<uuid>` | 任务 id |
| body | content | string | 是 | 非空 | 评论文本 |
| body | attachments | array[Attachment] | 否 | 单文件 ≤maxAttachmentSizeMB（默认 10） | 文件引用 |

#### 成功响应

- 响应 Schema：`Task`（timeline 追加 comment 条目，source.type=user，author=当前用户；updatedAt 刷新）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---|:---:|
| store-not-found | 任务 id 不存在 | code+msg | 提示"数据已删除，自动刷新" | 否 |
| validation-error | content 空；附件超限 | code+msg+field | 提示字段 | 否 |

#### 幂等与并发

- 幂等键：无（每次追加新评论）
- 重复请求：追加多条（业务允许）

### 11. deleteComment

`invoke kanban:deleteComment { boardId, taskId, commentId }`

#### 用途与依据

- 使用场景：删除评论（附件一并删除）
- 共识：CON-R025 + **Q-028**（user 评论可删；agent 评论只读不可删）
- 验收：删除评论后重启不复活、附件文件已清理

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | taskId | string | 是 | `t_<uuid>` | 任务 id |
| body | commentId | string | 是 | `tl_<uuid>`（type=comment） | 评论 id |

#### 成功响应

- 响应：删除成功（`{ deleted: true }`）；附件磁盘文件一并删除

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---|:---:|
| store-not-found | 评论/任务 id 不存在 | code+msg | 提示"数据已删除，自动刷新" | 否 |
| validation-error | 目标为 agent/system 条目（Q-028：agent 评论只读） | code+msg | 提示"agent 评论只读，不可删除" | 否 |

> **Q-028 权限判定归属**：由 B1 store 层校验——仅 `source.type=user` 的 comment 可删；agent 评论（含执行结果回填）与 execution/system 条目拒绝（409 语义，validation-error）。B2 无绕过通道。

#### 幂等与并发

- 幂等：否（删除后重复请求 → store-not-found）

### 12. updateColumn

`invoke kanban:updateColumn { boardId, columnId, patch }`

#### 用途与依据

- 使用场景：列配置更新（改名/排序/改色/隐藏/显示）
- 共识：CON-R020（列自定义）+ Q-027（隐藏=过滤）
- 验收：新增/重命名/排序/改色/隐藏即时生效并持久化

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | columnId | string | 是 | `c_<uuid>` | 列 id |
| body | name | string | 否 | ≤200 字符 | 新列名 |
| body | order | integer | 否 | 数字 | 新排序 |
| body | color | string | 否 | 十六进制色值 | 新色带 |
| body | hidden | boolean | 否 | — | 隐藏/显示 |

> 约束：模板列（有 type）不可删（见列管理弹窗）；updateColumn 只更新配置不涉及任务；隐藏列数据保留（Q-027）。

#### 成功响应

- 响应 Schema：`Column`（更新后）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---|:---:|
| store-not-found | 列/看板 id 不存在 | code+msg | 提示"数据已删除，自动刷新" | 否 |
| validation-error | 尝试删除/改 type 模板列 | code+msg+field | 提示模板列不可删 | 否 |

#### 幂等与并发

- 幂等：是（同配置重复更新结果一致）

### 13. deleteColumn

`invoke kanban:deleteColumn { boardId, columnId }`

#### 用途与依据

- 使用场景：删除自定义列（列内卡片移入 Todo）
- 共识：CON-R020（列自定义）+ PRD FR-2（仅删自定义列，模板列不可删）
- 验收：删除自定义列时列内卡片移入 Todo；模板列不可删除

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | columnId | string | 是 | `c_<uuid>` | 列 id |

#### 成功响应

- 响应：删除成功（`{ deleted: true }`）；该列内卡片 columnId 改 Todo（父卡聚合重算由 B2 消费）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---|:---:|
| store-not-found | 列/看板 id 不存在 | code+msg | 提示"数据已删除，自动刷新" | 否 |
| validation-error | 尝试删除模板列（有 type） | code+msg+field | 提示模板列不可删 | 否 |

#### 幂等与并发

- 幂等：否（删除后重复请求 → store-not-found）

### 14. archiveTask

`invoke kanban:archiveTask { boardId, id }`

#### 用途与依据

- 使用场景：归档 Done 列 ticket → 归档区（只读）
- 共识：CON-R033（决策 1/2）
- 验收：Done 可归档；归档后入归档区

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | id | string | 是 | `t_<uuid>` | 任务 id |

#### 成功响应

- 响应 Schema：`Task`（`archivedAt`=当前时间、`archivedFromColumnId`=当前 columnId；system 事件"已归档"）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---|:---:|
| store-not-found | 任务 id 不存在 | code+msg | 提示"数据已删除，自动刷新" | 否 |
| validation-error | 任务不在 Done 列（非 Done 不可归档） | code+msg+field | 提示仅 Done 可归档 | 否 |

#### 幂等与并发

- 幂等：是（已归档再归档结果一致）

### 15. restoreTask

`invoke kanban:restoreTask { boardId, id, toColumnId? }`

#### 用途与依据

- 使用场景：恢复归档 ticket（回 Done 或原列）
- 共识：CON-R033（决策 1/2）
- 验收：归档区 ticket 可恢复

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | id | string | 是 | `t_<uuid>` | 任务 id |
| body | toColumnId | string | 否 | 缺省 = archivedFromColumnId（原列，若已删/隐藏则 Done） | 恢复目标列 |

#### 成功响应

- 响应 Schema：`Task`（清 `archivedAt`/`archivedFromColumnId`，columnId 回目标列；system 事件"已恢复"）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---|:---:|
| store-not-found | 任务 id 不存在 | code+msg | 提示"数据已删除，自动刷新" | 否 |
| validation-error | 任务未归档（archivedAt 空）；toColumnId 不存在 | code+msg+field | 提示具体字段 | 否 |

#### 幂等与并发

- 幂等：是（同目标列重复恢复结果一致）

### 16. purgeTask

`invoke kanban:purgeTask { boardId, id }`

#### 用途与依据

- 使用场景：彻底删除归档 ticket（从归档区移除）
- 共识：CON-R033（决策 1/2）
- 验收：归档区 ticket 可彻底删除（级联清理）

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | id | string | 是 | `t_<uuid>` | 任务 id |

#### 成功响应

- 响应：删除成功（`{ deleted: true }`）；级联清理 timeline + 附件磁盘文件 + executions log（二次确认）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---|:---:|
| store-not-found | 任务 id 不存在 | code+msg | 提示"数据已删除，自动刷新" | 否 |
| validation-error | 任务未归档（archivedAt 空，非归档区不可 purge） | code+msg+field | 提示仅归档区可彻底删除 | 否 |

#### 幂等与并发

- 幂等：否（删除后重复请求 → store-not-found）

## 数据库与外部系统影响

> 无变化（本地 JSON 单文件，无外部系统）。数据归属 `<userData>/kanban/boards.json`，不触 DSH_HOME（CON-R002）。

## 联调与测试场景

| # | 场景 | 前置条件 | 请求/动作 | 预期结果 | 数据与审计结果 | 验收编号 |
|---|---|---|---|---|---|---|
| K1 | 多项目看板创建/切换 | 空数据 | createBoard×2 + getBoards | 2 看板独立列/任务，切换正确 | boards[] 2 项 | B1 验收 |
| K2 | 卡片 CRUD 持久化 | 默认看板 | createTask→updateTask→重启 | 数据完整恢复 | boards.json 持久化 | B1 验收 |
| K3 | 原子写失败 | 注入法：userDataPath 指向只读临时目录 或 mock fs 使 rename 抛错 | updateTask | **store-io-error**；提示错误，内存态保留，数据不坏 | 原 boards.json 不变 | B1 验收 |
| K4 | 损坏重建 | 注入损坏 JSON | 加载 | **store-corrupt**；备份 corrupt-<ts> + 重建默认看板 + 提示 | 备份文件生成 | B1 验收 |
| K5 | schema 迁移成功 | version=1 数据 + v2 迁移函数 | 加载 | 跑迁移函数成功，version=2 | 数据转换正确 | B1 验收 |
| K6 | schema 迁移失败 | 迁移函数抛错 | 加载 | **store-migrate-failed**；备份 + 重建 + 提示 | 备份文件生成 | B1 验收 |
| K7 | 加载性能 | 构造 ≤5MB（1000+ 卡） | 冷启动 | <500ms | 计时达标 | B1 验收 |
| K8 | 子任务级联删除 | 父卡含 2 子卡 | deleteTask(父) | 级联删子任务 + 附件 + executions log | 无孤儿任务、无残留 log | B1 验收 |
| K9 | DSH_HOME 零接触 | — | 全部操作 | 不读写 DSH_HOME | userData 内 | CON-R017 |
| K10 | createTask 标题空 | 默认看板 | createTask{title:""} | **validation-error**（field=title） | 不落盘 | B1 验收 |
| K11 | createTask 标题超长 | 默认看板 | createTask{title:201 字符} | **validation-error**（field=title） | 不落盘 | B1 验收 |
| K12 | createTask auto 缺 AC | auto 模式 | createTask{executionMode:auto, 无 AC} | **validation-error**（field=acceptanceCriteria） | 不落盘 | B1 验收 |
| K13 | moveTask 目标列不存在 | 默认看板 | moveTask{toColumnId:"c_不存在"} | **validation-error**（field=columnId） | 不落盘 | B1 验收 |
| K14 | deleteTask 不存在 | 默认看板 | deleteTask{id:"t_不存在"} | **store-not-found** | 提示"数据已删除，自动刷新" | B1 验收 |
| K15 | updateTask 非法字段 | 默认看板 | updateTask 直接改 executionStatus | **validation-error**（executionStatus 系统管理） | 不落盘 | B1 验收 |
| K16 | moveTask 进 Blocked | 默认看板 | moveTask{toColumnId:blocked} | blockedFromColumnId 自动记录来源列 | system 事件 from→to/user | B1 验收 |
| K17 | moveTask 解除 Blocked | 卡在 Blocked | moveTask{toColumnId:来源列} | 自动还原来源列（非隐藏）；来源列已删/隐藏 → Todo | blockedFromColumnId 清除 | B1 验收 |
| K18 | deleteBoard 级联 | 看板含任务+附件+executions log | deleteBoard | **store-board-not-empty**（有 ticket 含归档拒删）；清空全部 ticket 后可删；最后一个看板 → **validation-error**（可改名） | boards[] 移除 | B1 验收 |
| K19 | deleteComment user 评论 | user 评论 | deleteComment | 删除成功 + 附件一并清理 | 重启不复活 | B1 验收 |
| K20 | deleteComment agent 评论 | agent 评论（执行回填） | deleteComment | **validation-error**（Q-028：agent 评论只读） | 不可删 | B1 验收 |
| K21 | deleteTask 执行中 | 任务 running | deleteTask | **store-task-executing**（执行中不可删） | 不可删 | B1 验收 |
| K22 | deleteBoard 执行中 | 看板内任务 running | deleteBoard | **store-task-executing**（执行中不可删） | 不可删 | B1 验收 |
| K23 | deleteColumn 模板列 | 默认看板 | deleteColumn{columnId:c_done} | **validation-error**（模板列不可删） | 列保留 | B1 验收 |
| K24 | deleteColumn 自定义列 | 自定义列含卡 | deleteColumn | 删除成功，列内卡片移入 Todo | 卡片 columnId=Todo | B1 验收 |
| K25 | archiveTask 非 Done | 任务在 Todo | archiveTask | **validation-error**（仅 Done 可归档） | 不归档 | B1 验收 |
| K26 | archiveTask→restoreTask | Done 任务 | archive→restore | 归档（archivedAt+from）→ 恢复回原列/ Done，清归档字段 | system 事件 | B1 验收 |
| K27 | purgeTask 彻底删除 | 归档区 ticket 含附件/executions | purgeTask | 级联清 timeline+附件+executions log | 无残留 | B1 验收 |
| K28 | deleteBoard 含归档拒删 | 看板有已归档 ticket | deleteBoard | **store-board-not-empty**（含归档拒删） | 看板保留 | B1 验收 |
| K29 | updateTask dependencies 非法引用 | 默认看板 | updateTask{dependencies:["t_别父下"]} | **validation-error**（非同父子任务） | 不落盘 | B1 验收 |
| K30 | updateTask 切 auto 缺 AC | manual 任务 | updateTask{executionMode:auto,无AC} | **validation-error**（CON-R018 门控） | 不落盘 | B1 验收 |
| K31 | updateTask 已删任务 | — | updateTask{id:"t_已删"} | **store-not-found** | 提示已删除 | B1 验收 |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| 无 | — | — | — | — |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| STORE 错误码统一 | 已定：公共异常集 `KANBAN_STORE_ERROR`（含 store-not-found/store-task-executing/store-board-not-empty），B2/B3 消费同一错误码集 | phper666 | 已闭环（本契约） | 已闭环 |
| 执行态字段写入权 | B1 updateTask 不写 executionStatus，B3 调度层写 | phper666 | B3 契约 | 已定（本契约约束） |
| IPC channel 命名与 preload 桥 | B2/B3 消费同一 preload 桥 | phper666 | B2 契约 | 待定 |
| B3 执行层与 store 直调 | **B3 与 B1 同主进程，直调 store 方法，不经 IPC**（仅 B2 renderer 走 IPC） | phper666 | B3 契约 | 已定 |
| 删除执行态守卫归属 | **B1 store 内置校验**（P1-B）：deleteTask/deleteBoard 内置 running/queued 检查，B2 删除按钮直调 B1 也受守卫（不依赖 B3 前置）；B3 删除原语同走此校验 | phper666 | 已闭环（本契约） | 已闭环 |
| 归档原语对接 | archiveTask/restoreTask/purgeTask（B1 数据层），归档 UI 归属 B2；purgeTask 级联清理（Q-019） | phper666 | B2 契约 | 已定 |

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
| 2026-08-20 | 复核修复 | 修复 ora-1 复核退回问题：P0-1 补 store-not-found 闭环；P1-1 timeline system 写入权定稿；P1-2 补 addComment/deleteComment/updateColumn；P1-3 统一 not-found 错误码；P1-4 补失败用例 + 验收编号 K1~K20 + 原子写注入法 + Blocked/deleteBoard 用例；P2 错误码 kebab 化、subagentPolicy 默认、createTask dependencies/示例、Blocked 自动记/还原、最小 boards.json 示例 |
| 2026-08-20 | 二轮复核修复 | P1-A updateTask 失败契约补全（not-found/同级校验/auto 缺 AC）；P1-B 补 store-task-executing 执行态守卫（deleteTask/deleteBoard）；P1-C 补 deleteColumn；P1-D/E deleteBoard 对齐 CON-R033（store-board-not-empty + 最后看板规则）；归档对齐 CON-R033（Task 增 archivedAt/archivedFromColumnId + archiveTask/restoreTask/purgeTask 原语）；测试 K18 对齐 + K21~K31 补归档/守卫用例 |

## 自检记录

- 追踪完整性：PASS（B1→CON-R017/018/020/023/024/025/R030/R031/R033 + Q-013/014/015/019/020/025/027/028→验收，追踪矩阵全覆盖）
- OpenAPI 一致性：不适用（本地文件数据契约，无 OpenAPI yaml；JSON Schema 即字段唯一事实源）
- 示例与错误场景：PASS（31 个联调场景 K1~K31 含成功/失败/边界 + 公共异常集 + 最小 boards.json 示例）
- 安全与敏感字段：PASS（无敏感字段；DSH_HOME 零接触声明）
- 链接与格式：PASS
