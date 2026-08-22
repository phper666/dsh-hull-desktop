# T2 看板时间线 startDate 字段与 schema v2 迁移契约

## 契约信息

- 工作项：T2 startDate 字段 + schema v2 迁移（M2 看板时间线共识 §14.1，飞书 dsh-hull-desktop 清单，bda6a7df-327c-462d-b459-c5d25ff7bc34）
- 契约状态：冻结（2026-08-22）
- 版本：v0.1
- 适用版本：M2 看板时间线（共识-Hull桌面壳-M2看板时间线.md v1.2）
- 最后更新：2026-08-22
- 说明：**对既有 B1 契约（feishu-b1-m2-kanban-api-contract.md）的增量契约**——无新增 IPC channel、无 HTTP 面；核心 = Task 新增可空字段 `startDate` + `KANBAN_SCHEMA_VERSION` 1→2 迁移函数 + createTask/updateTask 可选参数扩展（向后兼容）。字段唯一事实源仍为 B1 契约 JSON Schema，本契约登记增量。

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| Task 新增 startDate 字段 | T2 | CON-R-timeline-003 + Q-052 | 详情面板设/清 startDate 即时生效并持久化（验收②）；未填任务日历按 dueDate 单日显示不受影响 | createTask/updateTask + Task Schema | 已定义 |
| API 可选参数扩展（向后兼容） | T2 | CON-R-timeline-003 + Q-052 | createTask/updateTask 以可选参数支持读写，不传不影响既有调用（验收③） | createTask/updateTask | 已定义 |
| 契约变更传播 | T2 | CON-R-timeline-003 + Q-052 | B1 契约 + preload 类型 + IPC 校验同步更新，走 change-propagation 登记变更摘要（验收④） | 本契约 + src/preload/index.ts + KanbanIpc | 已定义 |
| schema v1→v2 迁移 | T2 | CON-R-timeline-004 + Q-051 | v1 数据注入 → 迁移成功（任务/时间线不丢、版本升 2、落盘 v2、幂等）（验收①）；失败走备份重建兜底 | migrate()（KanbanStore） | 已定义 |

> T2 验收标准（共识 §14.1）：① v1 数据注入→迁移成功（任务/时间线数据不丢、KANBAN_SCHEMA_VERSION 升 2、落盘为 v2、重复迁移幂等）；② 详情面板设/清 startDate 即时生效持久化；③ createTask/updateTask 可选参数扩展向后兼容；④ 契约 feishu-b1-m2-kanban-api-contract.md + preload 类型 + IPC 校验同步更新（Q-052）。UI 层（详情面板日期选择器）归 T1 承接，本契约只约束数据层读写语义。

## 范围与非目标

### 范围

- Task Schema 增量：`startDate`（string|null，ISO 日期字符串，与 dueDate 同型）
- `KANBAN_SCHEMA_VERSION` 1→2 + migrate() v1→v2 迁移函数（三层遍历/幂等/失败兜底）
- createTask/updateTask 请求增加可选 `startDate` 参数（向后兼容）
- preload 类型镜像 + IPC 入参校验同步（Q-052）

### 非目标

- 时间线/日历视图渲染（T1）
- 视图持久化 localStorage（T1，CON-R-timeline-005）
- duration/endDate 字段（U-3 定案不新增）
- 拖拽改期（U-4 定案不做）
- HullSettings schema 变更 / 新增 IPC channel（零新增）

## 对既有 B1 契约的增量变更

> 变更类型：MODIFIED = 修改既有接口/Schema 定义；无 ADDED/DEPRECATED/REMOVED 项。B1 契约其余部分（16 个 IPC 原语、公共异常集、原子写/损坏恢复行为）不变。

| # | 变更类型 | 对象 | 变更内容 | 兼容性 | 依据 |
|---|---|---|---|---|---|
| 1 | MODIFIED | `kanban:createTask` 请求 | body 增加可选字段 `startDate?: string \| null`（缺省 null，语义同 dueDate） | 向后兼容（不传=null，既有调用不受影响） | CON-R-timeline-003/Q-052 |
| 2 | MODIFIED | `kanban:updateTask` 请求 | body 可编辑字段白名单增加 `startDate?: string \| null`（部分更新语义：不传=不变；显式 null=清空） | 向后兼容 | CON-R-timeline-003/Q-052 |
| 3 | MODIFIED | Task Schema | 新增字段 `startDate`（必填、可空、默认 null）——v2 起所有任务携带该字段 | v1 数据经迁移补齐后兼容 | CON-R-timeline-003/FR-3 |
| 4 | MODIFIED | boards.json 顶层 `version` / `KANBAN_SCHEMA_VERSION` | 默认值 1→2；migrate() 增加 v1→v2 transform（见 §迁移契约） | v1 文件可直接加载迁移；version>2 仍拒绝 | CON-R-timeline-004/Q-051 |

### 受影响代码位（实现锚点）

| 文件 | 变更 |
|---|---|
| `src/kanban/types.ts` | `KANBAN_SCHEMA_VERSION = 2`；`Task.startDate: string \| null` |
| `src/kanban/KanbanStore.ts` | `CreateTaskInput`/`UpdateTaskPatch` 增 `startDate?`；createTask 组装补 `startDate: input.startDate ?? null`；updateTask 白名单补 `if (patch.startDate !== undefined)`；**startDate 归一化（权威，主进程）**：写入侧 createTask/updateTask 对 string 值做 YYYY-MM-DD 格式校验、非法归一化 null；加载/migrate 读取侧对脏数据同样归一化（dueDate 不在本次范围，维持渲染层容错）；migrate() 补 v1→v2 transform |
| `src/preload/index.ts` | bridge 方法签名类型同步（createTask/updateTask 入参含 startDate） |
| `src/shared/ipc-channels.ts` | 无变化（channel 名不变，仅入参 schema 扩展） |

## Schema 与枚举（增量）

### Task（B1 契约 §Task 表增量行）

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| startDate | string | 是（v2 起） | 是 | ISO 日期字符串（YYYY-MM-DD，与 dueDate 同型）；默认 null；**非法日期串归一化归属：主进程 KanbanStore（权威）**——写入侧（createTask/updateTask）string 但非合法 YYYY-MM-DD → 归一化存 null；加载/迁移读取侧脏数据同样归一化置 null，不阻塞加载（CON-R-timeline-007）；renderer 仅做友好预校验（日期选择器约束），不承担权威校验；`startDate > dueDate` 存储层不校验不报错（展示层以 dueDate 为准单日显示） | 无 | 计划开始日期（日历区间跨格依据，FR-3） |

> 其余 Task 字段沿用 B1 契约，不重复登记。枚举无新增。

### 最小 boards.json 示例（v2）

```jsonc
{
  "version": 2,
  "boards": [
    {
      "id": "b_2f5a1c00-0000-4000-8000-000000000001",
      "name": "默认看板",
      "order": 0,
      "createdAt": "2026-08-22T09:00:00.000Z",
      "updatedAt": "2026-08-22T09:00:00.000Z",
      "columns": [ /* 同 B1 契约 6 态模板列 */ ],
      "tasks": [
        {
          "id": "t_1a2b3c4d-0000-4000-8000-000000000001",
          "title": "示例任务",
          "dueDate": "2026-09-01",
          "startDate": "2026-08-25",
          /* 其余字段同 B1 契约 createTask 示例 */
        }
      ]
    }
  ]
}
```

## 迁移契约（CON-R-timeline-004 / Q-051）

### migrate() v1→v2 行为

```text
加载 boards.json → 读 version
  version == 2 → 直接就绪（幂等：不再执行迁移）
  version == 1 → 执行 v1→v2：
    遍历 boards[] → columns[] 不动 → tasks[] 三层嵌套遍历，
    为每个 task 补 startDate: null（已有 startDate 的任务原样跳过）；
    其余字段一律原样保留（只加字段不动存量）；
    version 升 2 → 迁移成功后重新保存落盘为 v2
  version > 2 → 走备份重建兜底（load 路径，KanbanStore.loadStore 现行为）：
    备份 boards.json.corrupt-<ts> → 重建默认看板；
    renderer 收到默认看板数据 + 壳层状态提示，**无 IPC 错误码返回**
迁移抛错（migrate() 直调 / B5 导入校验路径）→ 抛 store-migrate-failed；
  load 路径捕获后同样走备份重建兜底（静默恢复，与 B1 K4/K6 现行为一致）
```

> **错误码语义澄清（复核修正）**：load 路径的迁移失败/版本过新实际由 `backupAndRebuild()` 静默兜底——原文件 rename 为 `.corrupt-<ts>`、重建默认看板、warn 日志，renderer **不会收到 `store-migrate-failed` 错误码**；该错误码仅在 migrate() 直调与 B5 导入校验路径抛出。本契约测试场景按此实际行为断言。

| 行为点 | 约束 | 依据 |
|---|---|---|
| 三层遍历 | boards[]→columns[]→tasks[] 全量覆盖，无任务遗漏 | Q-051 |
| 幂等 | 重复执行不重复加字段、不报错；已含 startDate 任务原样跳过 | Q-051 |
| 只加不动 | 除新增 startDate 与 version 外，任何字段（含 timeline/execution 记录）不得改动 | FR-4/R2 |
| 失败兜底 | 备份 `boards.json.corrupt-<ts>` → 重建默认看板；load 路径 renderer 收默认看板+状态提示（无错误码），migrate() 直调/B5 导入路径抛 store-migrate-failed | CON-R-timeline-004/B1 K6 |
| B5 导入复用 | B5 importVersionOlder 路径复用同一 migrate()（P2-B5-2），v1 导入自动升 v2 | B5 契约 |

### 迁移验证场景

| # | 注入数据 | 动作 | 预期 |
|---|---|---|---|
| V1 | version=1，N 板 M 列 K 任务，均无 startDate | 加载 | 全部任务 startDate=null；version=2；落盘文件 version=2；任务数/标题/timeline 条目数与注入一致 |
| V2 | version=2 且任务已含 startDate 值 | 再次加载/重复 migrate | 字段值不变、不报错（幂等） |
| V3 | version=3 | 加载 | 备份重建兜底：boards.json.corrupt-<ts> 生成、默认看板重建（无错误码返回；migrate() 直调路径则抛 store-migrate-failed） |

## 公共异常集

> 沿用 B1 契约 `KANBAN_STORE_ERROR` 七错误码，无新增错误码。迁移相关：`store-migrate-failed` 仅在 **migrate() 直调 / B5 导入校验路径**抛出（v1→v2 迁移抛错或 version>当前）；**load 路径**的迁移失败/版本过新走 `backupAndRebuild()` 静默兜底（备份 corrupt-<ts> + 重建默认看板），renderer 不收到错误码（与 B1 现行为一致）。`validation-error`：startDate 非 string/null 类型时 field=startDate。

## 接口详情（增量）

### createTask（MODIFIED）

`invoke kanban:createTask { boardId, title, columnId?, parentId?, executionMode?, ..., startDate? }`

#### 请求（增量行）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | startDate | string \| null | 否 | ISO 日期字符串（YYYY-MM-DD）；缺省/null → 存 null | 计划开始日期（Q-052） |

#### 成功响应

- 响应 Schema：`Task`（创建后；`startDate`=传入值或 null；其余同 B1 契约 §6，含 system 创建事件）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---|:---:|
| validation-error | startDate 非 string/null 类型 | code+msg+field=startDate | 提示字段 | 否 |

> 归一化归属（复核修正）：非法日期串由**主进程 KanbanStore 权威归一化**——写入侧 string 但非合法 YYYY-MM-DD → 存 null（不拒绝，IPC 响应 startDate=null）；加载/迁移读取侧脏数据同样置 null 不阻塞加载。renderer 仅做友好预校验。`startDate > dueDate` 照存，展示层以 dueDate 为准（PRD §8）。

#### 幂等与并发

- 同 B1 契约 §6（幂等键无，每次创建新任务）。

### updateTask（MODIFIED）

`invoke kanban:updateTask { boardId, id, ...fields }`

#### 请求（增量行）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | startDate | string \| null | 否 | 部分更新：不传=不变；显式 null=清空（语义同 dueDate） | 设/清开始日期（Q-052） |

#### 成功响应

- 响应 Schema：`Task`（更新后，updatedAt 刷新；system 时间线不因 startDate 变更追加事件——纯字段编辑）

#### 失败响应

- 适用公共异常集：`KANBAN_STORE_ERROR`
- 特有异常：同 createTask（startDate 非法类型 → validation-error field=startDate）；其余沿 B1 契约 §7。

#### 幂等与并发

- 幂等：是（同值重复更新结果一致）。

## 数据库与外部系统影响

> 无变化（本地 JSON 单文件 `<userData>/kanban/boards.json`，version 1→2 由迁移函数处理；不触 DSH_HOME，CON-R002）。

## 联调与测试场景

| # | 场景 | 前置条件 | 请求/动作 | 预期结果 | 数据与审计结果 | 验收编号 |
|---|---|---|---|---|---|---|
| T2-1 | v1 数据迁移成功 | 注入 version=1 多板多列多任务数据（无 startDate） | 加载 store | 迁移成功：每任务 startDate=null、version=2；任务/时间线完整不丢 | 落盘 boards.json version=2 | T2 验收① |
| T2-2 | 迁移幂等 | 已迁移 v2 数据 | 再次加载/重复跑 migrate() | 不重复加字段、不报错；已有 startDate 值原样保留 | 数据无 diff | T2 验收① |
| T2-3 | 迁移失败兜底 | mock migrate() 抛错 | 加载 | 兜底生效：boards.json.corrupt-<ts> 备份生成 + 默认看板重建并展示；**无 IPC 错误码返回**（load 路径静默恢复，与 B1 K4/K6 现行为一致；store-migrate-failed 仅 migrate() 直调/B5 导入路径可见） | boards.json.corrupt-<ts> 生成 + 默认看板重建 | T2 验收① |
| T2-4 | version 过新拒绝 | 注入 version=3 | 加载 | 备份重建兜底：原文件 rename 为 boards.json.corrupt-<ts>（内容保留于备份）+ 默认看板重建；无错误码返回 | corrupt-<ts> 备份含原 version=3 数据 | CON-R-timeline-004 |
| T2-5 | createTask 带 startDate | 默认看板 | createTask{title, startDate:"2026-08-25"} | 创建成功，响应 startDate="2026-08-25"；重启后保持 | 落盘含该字段 | T2 验收③ |
| T2-6 | createTask 不带 startDate（向后兼容） | 默认看板 | createTask{title}（无 startDate） | 创建成功，startDate=null；既有调用零影响 | 落盘 startDate:null | T2 验收③ |
| T2-7 | updateTask 设/清 startDate | 既有任务 | updateTask{startDate:"2026-09-01"} → updateTask{startDate:null} | 先设后清均生效；updatedAt 刷新；重启保持 | 落盘同步 | T2 验收② |
| T2-8 | updateTask 不传 startDate | 既有任务（startDate 有值） | updateTask{priority:"P1"} | startDate 保持原值不变（部分更新语义） | — | T2 验收③ |
| T2-9 | 脏数据读取归一化 | boards.json 中任务 startDate:"not-a-date"（历史脏数据） | 加载/读取 | 主进程 KanbanStore 归一化置 null，不阻塞加载 | 内存态 startDate=null | CON-R-timeline-007 |
| T2-10 | startDate > dueDate | 任务 startDate=2026-10-01, dueDate=2026-09-01 | createTask/updateTask 写入 | 存储层不报错照存（展示层以 dueDate 单日显示，属 T1 渲染行为） | 落盘两字段原值 | PRD §8 |
| T2-11 | startDate 非法类型拒参 | 默认看板 | createTask{startDate:123} | **validation-error**（field=startDate） | 不落盘 | Q-052 |
| T2-12 | 契约传播三处同步 | — | 对照检查 B1 契约 Task Schema/createTask/updateTask 章节 + preload 类型 + KanbanIpc 入参 | 三处均含 startDate 且类型一致（string\|null，可选） | — | T2 验收④/Q-052 |
| T2-13 | IPC 写入非法日期串归一化 | 默认看板 | createTask{title, startDate:"not-a-date"} → updateTask{startDate:"2026-13-99"} | 主进程权威归一化：两次写入响应 startDate 均=null、落盘 null（不拒绝不报错）；类型错误仍拒（见 T2-11） | 落盘 startDate:null | CON-R-timeline-007/Q-052 |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| 无 | — | — | — | — |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| **Q-052 契约变更传播（跨模块协调项）** | B1 契约 feishu-b1-m2-kanban-api-contract.md 同步更新（Task Schema 加 startDate、createTask/updateTask 参数说明）+ preload 类型 + IPC 校验三处同步；走 change-propagation 并登记变更摘要-M2看板 | phper666 | T2 实现前完成契约侧，随 T2 交付代码侧 | 待办 |
| B5 导入链路回归 | B5 importVersionOlder 复用 migrate()（P2-B5-2）——v1 导入自动升 v2，需回归 B5 导入用例 | phper666 | T2 交付时 | 待办 |
| T1 消费方对齐 | T1 日历视图读 startDate（区间跨格/本地时区解析/非法置 null）依赖本契约字段语义；详情面板日期选择器 UI 归 T1 | phper666 | T1 开工前 | 待办 |

## 完成记录

> 交付后填写，结果必须有证据。

| 项 | 结果 |
|:---|:-----|
| 交付时间 | — |
| 验证结果 | — |
| 构建/发布 | — |
| 偏差处理 | — |

## 决策与踩坑

- 增量契约形态：T2 不另立全量 Schema，仅登记对 B1 契约的 MODIFIED 增量（字段唯一事实源仍在 B1 契约），避免双事实源漂移。
- startDate>dueDate 不在存储层校验：共识定案「以 dueDate 为准单日显示，不报错」是渲染层行为，存储层照存原值——把校验放错层会导致合法数据被拒。
- 非法日期串「读取时置 null」而非「写入时拒绝」：兼容历史脏数据不阻塞加载（CON-R-timeline-007），写入侧仅拒非 string/null 类型。

## 变更记录

| 时间 | 类型 | 摘要 |
|---|---|---|
| 2026-08-22 | 初次生成 | 基于 T2（bda6a7df-327c-462d-b459-c5d25ff7bc34）和共识-Hull桌面壳-M2看板时间线 v1.2 §7/§13/§14.1 + PRD v0.2 FR-3/FR-4 生成增量契约草案（对 B1 契约 4 项 MODIFIED） |
| 2026-08-22 | 复核修复 | FE/QA 契约复核退回修复：① HIGH——迁移失败/version 过新错误语义对齐实际代码（load 路径 backupAndRebuild 静默兜底：备份 corrupt-<ts> + 重建默认看板，renderer 无错误码；store-migrate-failed 仅 migrate() 直调/B5 导入路径），修正 §迁移契约/公共异常集/V3/T2-3/T2-4；② MEDIUM——非法日期串归一化归属定案为主进程 KanbanStore（写入+读取权威归一化，renderer 友好预校验），修正 Schema 约束/受影响代码位/createTask 备注/T2-9，新增 T2-13 |

## 自检记录

- 追踪完整性：PASS（T2 验收①~④ → CON-R-timeline-003/004 + Q-051/052 → 接口/迁移契约/测试场景全覆盖）
- OpenAPI 一致性：不适用（本地文件数据契约，同 B1 模式；JSON Schema 即字段唯一事实源）
- 示例与错误场景：PASS（13 个联调场景 T2-1~T2-13 含迁移成功/幂等/失败兜底/读写/边界 + 3 个迁移验证场景 V1~V3 + v2 最小示例；错误断言已对齐 load 路径实际行为）
- 安全与敏感字段：PASS（无敏感字段；DSH_HOME 零接触声明沿用）
- 链接与格式：PASS
