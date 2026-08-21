# B5 导出/导入与分享契约

## 契约信息

- 工作项：B5 导出/导入与分享（飞书 dsh-hull-desktop 清单，t100105）
- 契约状态：已冻结（2026-08-21，ora-1 第二轮复核通过）
- 版本：v0.1
- 适用版本：M2（共识 v1.4）
- 最后更新：2026-08-21
- 说明：桌面壳本地导出/导入契约（无 HTTP API 面）；核心 = boards.json 快照导出格式 + 导入校验（版本/字段/损坏拒绝）+ 合并/替换导入 + 分享快照（M2 能力，实时协作 M2+ 不做）+ 附件上限校验。**B5 基于 B1 数据模型**：boards.json 是字段唯一事实源，导出格式 = boards.json 裸快照，导入校验复用 B1 schema 校验器。B1 契约（feishu-b1-m2-kanban-api-contract.md）为数据层事实源。

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| 导出（全看板/单看板） | B5 | CON-R017 + PRD FR-16 | 导出 boards.json 快照（含 schema version + 完整数据），单看板/全看板可选 | `kanban:exportBoard` | 已定义 |
| 导入（合并/替换） | B5 | CON-R017 + PRD FR-16 | 校验 schema 后原子应用；非法文件报错且不破坏现有数据 | `kanban:importBoard` | 已定义 |
| 分享快照 | B5 | CON-R017 + §15.3 | 导出文件可发给他人 → 对方导入还原（M2 快照分享能力） | `kanban:exportBoard`/`kanban:importBoard` | 已定义 |
| 实时协作分享 | B5（M2+） | §15.3 | 需服务器+同步+权限模型，M2 不实做（仅导出分享） | —（记录 M2+） | 非目标 |
| 附件上限校验 | B5 | CON-R024 | 导入校验 attachment.size ≤ maxAttachmentSizeMB（默认 10） | `kanban:importBoard` | 已定义 |
| 归档完整性 | B5 | CON-R033 | archivedAt/archivedFromColumnId 随导出/导入完整保留（含归档 ticket） | `kanban:exportBoard`/`kanban:importBoard` | 已定义 |
| DSH_HOME 零接触 | B5 | CON-R017（CON-R002 延伸） | 导入写入 `<userData>/kanban/boards.json`，不碰 DSH_HOME | `kanban:importBoard` | 已定义 |

## 范围与非目标

### 范围

- 导出：当前看板（单看板）或全部看板 → JSON 文件（用户选路径），格式 = boards.json 快照（`{ version, boards[] }`）
- 导入：选择 JSON 文件 → 校验（JSON 可解析 / schema version 兼容 / B1 字段合法性 / 结构完整性 / 附件上限）→ 合并/替换 → 原子应用；任何校验失败拒绝导入且不破坏现有数据
- 合并冲突处理：导入看板 id 冲突 → 自动重 id + 内部引用重映射（不报错、确定性）
- 分享快照：导出文件可发他人 → 对方导入还原（M2 能力）；实时协作明确 M2+ 不做（需服务器 + 同步 + 权限模型，共识 §15.3）
- 附件上限校验：attachment.size ≤ maxAttachmentSizeMB（默认 10，CON-R024，SettingsProvider 可配）；导出文件含附件引用（path/size/name）

### 非目标

- 附件二进制 / executions log 内容随导出文件携带（导出仅含引用；换机还原附件需另行拷贝或重新上传，P2 增强项）
- 实时协作分享（M2+，需服务器 + 同步 + 权限模型，共识 §15.3；权限语义 M2+ 引入，Q-020 assignee 纯展示无权限）
- 多设备自动同步（O-4 定案，P2 导出/导入为过渡方案）
- 看板数据加密 / SQLite 迁移（O-3 定案，同步/云协作场景再评估）
- 执行引擎 / 状态机（B3）、执行集成 / 审批（B4）、UI（B2）

## 业务流程与状态

### 核心流程

```text
导出：用户选范围（单看板/全看板）→ 主进程序列化 boards.json 快照（{version, boards[]}）→ 保存对话框选路径 → 原子写 → 返回 {path, counts}
导入：用户选文件 + 模式（合并/替换）→ 主进程读文件 → 解析 JSON → version 兼容检查（过旧走 B1 migrate()）
     → 校验阶段（① 文件内部引用完整性 ② 结构完整性 ③ B1 schema 字段合法性 ④ 附件上限）——全部通过才进应用
     → 应用阶段：merge（先重映射再追加）/ replace（先备份 boards.preimport-<ts> 再整文件替换）→ 原子写 → 返回 {applied, ids}
```

> **校验/重映射顺序（P0-B5-1 定稿）**：**先校验后重映射**。校验阶段在导入文件**原始 id 空间**下执行（此时引用均为文件内部引用，可完整验证）——
> ① **文件内部**引用完整性：parentId/dependencies 指向导入文件内存在的 id，且满足 B1 约束（dependencies 仅子任务声明、同父下）；
> ② **跨现有看板引用**（导入任务引用现有看板任务/列 id，如重复导入时残留指向）→ 一律 **validation-error 拒绝**（明确规则）；
> ③ 结构完整性（columnId 指向导入文件内列等）；④ B1 schema 字段合法性；⑤ 附件上限。
> 应用阶段 merge 才执行重映射（冲突板重 id + 文件内部引用重映射），重映射后**再跑一次 B1 完整校验**（P1-B5-1）。
> 校验阶段任何失败 → 拒绝 + 现有数据零改动。

### 状态转换

| 当前状态 | 动作 | 目标状态 | 前置条件 | 冲突行为 | 依据 |
|---|---|---|---|---|---|
| 就绪 | 导出成功 | 就绪（文件生成） | 数据存在（空看板/空 boards 也合法导出） | 用户取消保存对话框 → 返回 `{cancelled:true}`，无文件生成 | FR-16 |
| 就绪 | 导出失败 | 就绪（不变） | 目标路径不可写/boardId 不存在 | export-io-error / export-not-found | FR-16 |
| 就绪 | 导入校验失败 | 就绪（零改动） | 文件损坏/版本不兼容/字段非法/结构非法/**跨现有看板引用**/附件超限 | 拒绝 + 报错（含具体原因），现有数据不动（P0-B5-1：校验先于重映射，文件内部引用 + 跨源引用均在此阶段判） | FR-16 |
| 就绪 | 导入合并成功 | 就绪（追加） | 校验通过 | 先重映射（冲突板重 id + 文件内部引用重映射）再追加；重映射后重申 B1 完整校验（P1-B5-1） | FR-16 |
| 就绪 | 导入替换成功 | 就绪（替换） | 校验通过 | 先备份 `boards.preimport-<ts>` 再整文件替换（原子写） | FR-16 |
| 就绪 | 导入应用失败 | 就绪（原数据保留） | 磁盘只读/满 | store-io-error；原 boards.json 不破坏 | CON-R017 |

## 接口清单

> B5 为本地导出/导入契约，无 HTTP paths；"接口" = IPC channel（主进程 KanbanStore/Transfer 层暴露，preload 桥接，renderer 消费）。导出/导入操作主进程处理文件读写（保存/打开对话框），renderer 只传范围与模式。

| # | 状态 | 方法 | 路径（IPC channel） | 用途 | 权限 | 幂等 |
|---|---|---|---|---|---|---|
| 1 | 已定义 | invoke | `kanban:exportBoard` | 导出看板（单看板/全看板）为 JSON 快照文件 | 无（壳内） | 读（导出） |
| 2 | 已定义 | invoke | `kanban:importBoard` | 导入 JSON 文件（合并/替换，校验后原子应用） | 无（壳内） | 否（合并追加/替换） |

## Schema 与枚举

> 字段结构唯一权威 = B1 契约 boards.json JSON Schema（导出文件复用同一结构，零格式漂移）；本节只列 B5 传输/响应专属结构，不复制 B1 字段细节。

### 导出文件（= boards.json 快照）

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| version | integer | 是 | 否 | 与当前 boards.json schema version 一致（B1） | 无 | 导出时快照当前 schema 版本 |
| boards | array[Board] | 是 | 否 | 全看板 = 完整数组；单看板 = 1 元素数组；空数组合法 | 无 | 看板快照（Board/Column/Task/Timeline/Attachment/ExecutionRecord 全字段，含归档字段） |

> **导出边界**：`attachments[]` 仅携带引用（name/path/size，B1 Attachment），**不含附件二进制**；timeline execution 记录保留 outputPath 引用，**不含 executions log 内容**。导出文件可被导入还原结构（同机/异机）；附件/日志二进制需另行拷贝或重新上传（P2 增强项）。
> **导入后缺失语义（P1-B5-2/P2-B5-1 对齐）**：附件二进制缺失 → 复用 B1 既有占位语义（PRD §9：评论显示"附件缺失"占位，不阻塞看板）；execution 记录 `outputPath` 指向文件不存在 → 执行记录详情按缺失处理（复用附件缺失占位语义，不阻塞）。

### 导入模式枚举

| 值 | 含义 | 行为 |
|---|---|---|
| merge | 合并 | 导入 boards 追加到现有 boards[]；导入看板 id 与现有冲突 → 自动重 id（b_<uuid> 新生成）+ 内部全部 id（列/任务/timeline）一并重映射 + 引用（parentId/dependencies/currentExecutionId/blockedFromColumnId/archivedFromColumnId）同步重映射；重映射后重申 B1 完整校验（P1-B5-1） |
| replace | 替换 | 导入数据成为整个 boards.json（整文件替换）；应用前先备份现有为 `boards.preimport-<ts>.json` |

> **校验/重映射顺序（P0-B5-1 定稿）**：校验阶段在导入文件原始 id 空间执行——① 文件内部引用完整性（parentId/dependencies 指向文件内 id + B1 约束）；② **跨现有看板引用 → validation-error 拒绝**（导入任务引用现有看板任务/列 id，重复导入残留引用即属此类）；③ 结构完整性；④ B1 字段合法性；⑤ 附件上限。全部通过才进应用。merge 应用 = 先重映射再追加（冲突板重 id + 文件内部引用重映射），重映射后重申 B1 完整校验（P1-B5-1）。合并非幂等（每次合并追加一份）。

### 公共异常集

#### KANBAN_EXPORT_ERROR（导出层）

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| export-not-found | boardId 不存在（已删除） | code + msg | 提示"看板已删除，自动刷新" | 否 |
| export-io-error | 文件写失败（路径不可写/磁盘满） | code + msg | 提示重选路径 | 是 |
| validation-error | boardId 格式非法 | code + msg + field | 提示具体字段 | 否 |

#### KANBAN_IMPORT_ERROR（导入层）

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| import-invalid-json | 文件非合法 JSON（解析失败） | code + msg | 提示"文件损坏或非 JSON" | 否 |
| import-corrupt | JSON 可解析但缺 version/boards 或顶层类型错误 | code + msg | 提示"文件损坏，非看板导出文件" | 否 |
| import-version-newer | 导入 schema version > 当前（需新版壳） | code + msg + version | 提示"导出文件来自更新版本，请升级壳" | 否 |
| import-version-older | 导入 schema version < 当前且 B1 migrate() 无迁移函数可到当前 | code + msg + version | 提示"导出文件版本过旧" | 否 |
| validation-error | 字段/结构校验失败（复用 B1 schema 校验 + 附件上限 + 文件内部引用完整性 + **跨现有看板引用拒绝** + merge 重映射后重申校验） | code + msg + field | 提示具体字段 | 否 |
| import-mode-invalid | mode 非法（非 merge/replace） | code + msg + field | 提示字段 | 否 |
| store-io-error | 应用时原子写失败（磁盘只读/满） | code + msg | 提示"导入未完成，现有数据未变"，可重试 | 是 |
| store-not-found | 透传 B1 store 校验（应用阶段内引用 B1 数据不存在等） | code + msg | 提示 | 否 |

> **原子性保障**：导入全流程"校验 → 应用"两段式——校验阶段（读文件 + 解析 + 版本 + 字段/结构/附件）全部通过后才进入应用阶段；任何校验失败即返回错误、现有 boards.json 零改动（满足 FR-16"导入非法文件报错且不破坏现有数据"）。

## 接口详情

### 1. exportBoard

`invoke kanban:exportBoard { boardId? }`

#### 用途与依据

- 使用场景：用户导出看板（单看板/全看板）为 JSON 文件（备份 / 迁移 / 分享）
- 共识：CON-R017（boards.json 快照格式）+ FR-16
- 验收：导出文件含 schema version + 完整数据；单看板/全看板可选

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 否 | `b_<uuid>`；缺省 = 导出全部看板 | 导出范围 |

#### 成功响应

- 响应 Schema：`ExportResult`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `path` | string | 是 | 否 | 用户确认的绝对路径 | 导出文件路径 |
| `scope` | string | 是 | 否 | `board`（单看板）/ `all`（全看板） | 导出范围 |
| `boardCount` | integer | 是 | 否 | ≥1 | 导出看板数 |
| `taskCount` | integer | 是 | 否 | ≥0 | 导出任务数（含子任务与归档） |
| `attachmentCount` | integer | 是 | 否 | ≥0 | 附件引用数 |
| `exportedAt` | string | 是 | 否 | ISO 8601 UTC | 导出时间 |

- 取消保存对话框（用户点取消）：

```json
{ "cancelled": true }
```

#### 失败响应

- 适用公共异常集：`KANBAN_EXPORT_ERROR`
- 无特有异常。

#### 幂等与并发

- 读操作（从内存态快照序列化），无幂等要求；重复导出生成独立文件。

### 2. importBoard

`invoke kanban:importBoard { filePath, mode }`

#### 用途与依据

- 使用场景：用户导入 JSON 文件（合并现有 / 替换全部）——还原备份、迁移数据、接收他人分享快照
- 共识：CON-R017（校验后原子写）+ CON-R024（附件上限）+ FR-16
- 验收：导出文件可被导入还原（同机/异机）；导入非法文件报错且不破坏现有数据

> **两段式执行（P0-B5-1 定稿）**：校验阶段（文件内部引用完整性 + 结构 + B1 schema 字段 + 附件上限，**在原始 id 空间**）全过 → 应用阶段（merge 先重映射再追加 + 重申 B1 校验 / replace 先备份再整文件替换 + 原子写）。任何校验失败 → 拒绝 + 现有数据零改动。

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | filePath | string | 是 | 绝对路径，主进程读文件 | 待导入 JSON 文件 |
| body | mode | string | 是 | `merge` / `replace` | 导入方式 |

#### 成功响应

- 响应 Schema：`ImportResult`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `applied.mode` | string | 是 | 否 | `merge` / `replace` | 已应用模式 |
| `applied.boardsImported` | integer | 是 | 否 | ≥1 | 导入看板数 |
| `applied.tasksImported` | integer | 是 | 否 | ≥0 | 导入任务数（含子任务与归档） |
| `ids.preserved` | array[string] | 是 | 否 | 空数组合法 | 保留原 id 的导入看板 id |
| `ids.regenerated` | array[string] | 是 | 否 | 空数组合法（merge 冲突才非空） | 冲突后重 id 的导入看板 id |

#### 失败响应

- 适用公共异常集：`KANBAN_IMPORT_ERROR`
- 无特有异常。

#### 幂等与并发

- 幂等键：无。merge 非幂等（每次合并追加一份，业务允许）；replace 幂等（同文件重复替换结果一致，备份覆盖）。
- 状态冲突：导入应用与并发写（防抖写）冲突 → store-io-error（重试）或 last-write-wins（原子写天然保证整文件一致性）。

## 数据库与外部系统影响

> 无外部系统。新增落盘物：导出 JSON 文件（用户选路径，可在 userData 内外）；导入 replace 备份 `<userData>/kanban/boards.preimport-<ts>.json`。不触 DSH_HOME（CON-R002）。

### 落盘

| 文件 | 说明 | 清理 |
|---|---|---|
| 导出 JSON（用户选路径） | boards.json 快照（`{version, boards[]}`） | 用户管理 |
| `boards.preimport-<ts>.json` | replace 导入前自动备份现有数据（与 B1 损坏备份 `boards.json.corrupt-<ts>` 命名区分） | 用户管理（不影响运行） |

## 联调与测试场景

| # | 场景 | 前置条件 | 请求/动作 | 预期结果 | 数据与审计结果 | 验收编号 |
|---|---|---|---|---|---|---|
| X1 | 全看板导出成功 | 2 看板含任务 | exportBoard{} | 文件生成，含 version+boards[]（2 项）+ 完整数据 | boardCount=2，taskCount 正确 | B5 验收 |
| X2 | 单看板导出成功 | 2 看板 | exportBoard{boardId:b_1} | 文件生成，boards[] 仅 1 项（b_1） | scope=board，boardCount=1 | B5 验收 |
| X3 | 导出还原（同机） | 导出全看板文件 | importBoard{filePath, mode:replace} | 数据完整还原 | boards.json 与导出前一致 | FR-16/B5 验收 |
| X4 | 导出还原（异机） | 导出文件 + 全新壳 | importBoard{filePath, mode:replace} | 看板结构还原；附件二进制缺失 → **复用 B1 既有占位语义**：评论显示"附件缺失"占位，不阻塞看板（PRD §9；P1-B5-2） | 附件引用在、按占位渲染，看板可用 | FR-16/B5 验收 |
| X5 | 导出取消 | 打开保存对话框 | 用户取消 | **cancelled:true**，无文件生成 | 无副作用 | B5 验收 |
| X6 | 导出看板不存在 | 单看板导出 | exportBoard{boardId:"b_不存在"} | **export-not-found** | 无文件生成 | B5 验收 |
| X7 | 导出路径不可写 | 目标目录只读 | exportBoard | **export-io-error**，提示重选路径 | 无文件生成 | B5 验收 |
| X8 | 导入成功（merge） | 现有 1 看板 + 导入 1 看板（id 不同） | importBoard{mode:merge} | 追加成功，导入看板保留原 id | boards 2 项，ids.preserved 含导入板 | B5 验收 |
| X9 | 导入成功（replace） | 现有 2 看板 + 导入 1 看板文件 | importBoard{mode:replace} | 整文件替换为导入 1 看板 | boards 1 项 + 备份 boards.preimport-<ts> 生成 | B5 验收 |
| X10 | 导入非法 JSON | 文本文件/损坏文件 | importBoard | **import-invalid-json**，现有数据零改动 | 报错 + 现有 boards.json 不变 | FR-16/B5 验收 |
| X11 | 导入损坏（缺 version/boards） | `{"foo":1}` | importBoard | **import-corrupt**，现有数据零改动 | 报错 + 现有 boards.json 不变 | FR-16/B5 验收 |
| X12 | 导入版本过新 | version=99 文件 | importBoard | **import-version-newer**（需新版壳），拒绝 | 现有数据不动 | B5 验收 |
| X13 | 导入版本过旧可迁移 | version=0 文件 + B1 migrate() 有迁移函数 | importBoard | **复用 B1 migrate()** 迁移至当前版本后导入成功（P2-B5-2，B5 不独立实现迁移） | version 升到当前 | B5 验收 |
| X14 | 导入版本过旧无迁移 | version 过旧且无迁移函数 | importBoard | **import-version-older**，拒绝 | 现有数据不动 | B5 验收 |
| X15 | 导入字段非法 | title 超长/auto 缺 AC | importBoard | **validation-error**（field 指向），现有数据零改动 | 报错 + 现有 boards.json 不变 | FR-16/B5 验收 |
| X16 | 导入结构非法 | task.columnId 指向不存在列 | importBoard | **validation-error**（引用完整性），现有数据零改动 | 报错 + 现有 boards.json 不变 | B5 验收 |
| X17 | 合并 id 冲突自动重映射 | 导入文件含与现有相同 b_id | importBoard{mode:merge} | 冲突看板重 id + 内部任务/列/timeline 重映射，dependencies/parentId 引用同步 | ids.regenerated 含冲突板；引用正确 | B5 验收 |
| X18 | 导入附件超限 | 附件 size > maxAttachmentSizeMB（配置 10） | importBoard | **validation-error**（field=attachments），现有数据零改动 | 报错 + 现有 boards.json 不变 | CON-R024/B5 验收 |
| X19 | 导入 replace 写失败 | userData 只读 | importBoard{mode:replace} | **store-io-error**，原数据不破坏 | 备份可能已生成，boards.json 原样 | CON-R017/B5 验收 |
| X20 | 导入 mode 非法 | — | importBoard{mode:"xxx"} | **import-mode-invalid** | 现有数据不动 | B5 验收 |
| X21 | 导入后可用性回归 | 导入看板 | 导入后 CRUD/流转 | 导入看板数据完整可用（CRUD/列/归档字段正确） | archivedAt/archivedFromColumnId 保留 | CON-R033/B5 验收 |
| X22 | 跨现有看板引用拒绝 | 导入任务引用现有看板任务/列 id | importBoard{mode:merge} | **validation-error**（跨现有看板引用一律拒绝，P0-B5-1），现有数据零改动 | 报错 + 现有 boards.json 不变 | B5 验收 |
| X23 | merge 重映射后重申校验 | 导入文件内部引用被重映射后触 B1 约束 | importBoard{mode:merge} | 重映射后**再跑一次 B1 完整校验**（P1-B5-1）；不过 → validation-error 拒绝，现有数据零改动 | 不追加 + 现有 boards.json 不变 | B5 验收 |
| X24 | replace 失败后备份可还原 | userData 只读导致 replace 失败 | importBoard{mode:replace} → 修复磁盘 → 手动用 boards.preimport-<ts> 还原 | **store-io-error**（应用失败）；备份保留；修复后用备份文件可手动还原原数据（P2-B5-3） | boards.preimport-<ts> 存在且可还原 | B5 验收 |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| 无 | — | — | — | — |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| 复用 B1 store 校验器 | 导入字段/结构校验复用 B1 schema 校验（单一事实源），B5 不复制校验逻辑 | phper666 | 本契约 | 已定 |
| IPC channel 命名与 preload 桥 | kanban:exportBoard/importBoard 沿用 `kanban:` 前缀（B1 协调已定），B2 消费同一 preload 桥 | phper666 | B2 契约 | 待定 |
| 附件上限配置读取 | 导入校验读取 maxAttachmentSizeMB（SettingsProvider，默认 10），B2 设置 UI 展示 | phper666 | B2 契约 | 待定 |
| 备份命名区分 | 导入 replace 备份 `boards.preimport-<ts>` 与 B1 损坏备份 `boards.json.corrupt-<ts>` 命名区分，防混淆 | phper666 | 本契约 | 已定 |
| 附件缺失占位语义来源 | 导入后附件缺失/executions log 缺失复用 PRD §9"附件缺失"占位语义（docs/prd/2026-08-19-m2-kanban-prd.md:517），B5 不另立语义 | phper666 | 本契约 | 已定 |
| schema 迁移复用 | 导入过旧 version 复用 B1 migrate()，B5 不独立实现迁移（与 B1 CON-R017 迁移函数单一事实源） | phper666 | 本契约 | 已定 |
| 实时协作边界 | M2 只做导出快照分享；实时协作（需服务器+同步+权限）M2+ 记录共识 §15.3，B5 不实做 | phper666 | 共识已定 | 已定 |

## 完成记录

> 交付后填写，结果必须有证据。

| 项 | 结果 |
|:---|:-----|
| 交付时间 | — |
| 验证结果 | — |
| 构建/发布 | — |
| 偏差处理 | — |

## 决策与踩坑

- 导出格式 = boards.json 裸快照（`{version, boards[]}`），不复包传输信封——导入校验直接复用 B1 schema 校验器，字段唯一事实源留在 B1，零格式漂移（复用场景：任何基于 B1 的本地传输契约）。
- 附件二进制 / executions log 内容不入导出文件（仅引用 name/path/size）——避免二进制打包复杂度；换机还原附件需另行拷贝或重传（P2 增强项，`ponytail:` 当前无二进制迁移需求，出现时再加打包格式）。
- 合并冲突 = 自动重 id + 内部引用重映射（不报错）——UUID 冲突仅"重复导入同一文件"等场景发生，确定性处理可测试，不引入用户交互。
- 校验/重映射顺序（P0-B5-1）：先校验后重映射——校验在导入文件原始 id 空间执行（文件内部引用可完整验证），跨现有看板引用一律拒绝（避免"导入引用现有"悬挂引用）；merge 应用才重映射。复用场景：任何"导入 + 引用重映射"传输契约。
- merge 重映射后重申 B1 完整校验（P1-B5-1）——重映射可能产生跨父依赖等 B1 约束违例（dependencies 仅同父子任务），重申拦截，防止脏数据入库。
- 附件缺失复用 B1 占位语义（P1-B5-2）——PRD §9"附件缺失 → '附件缺失'占位不阻塞"，导入后二进制缺失不另立语义，与运行期附件缺失行为一致。
- 替换导入先备份 `boards.preimport-<ts>`——用户主动破坏性操作（整文件替换）的保护，与 B1 损坏备份命名区分；失败后备份可手动还原。
- 导入两段式（校验全过 → 原子应用）——任何校验失败现有数据零改动，直接满足 FR-16"非法文件不破坏现有数据"，复用 B1 原子写。

## 变更记录

| 时间 | 类型 | 摘要 |
|---|---|---|
| 2026-08-21 | 初次生成 | 基于 t100105（B5）和共识 v1.4（§14.1/§15.3 + CON-R017/024/033）+ PRD FR-16 + B1 契约（boards.json 为字段事实源）生成契约草案 |
| 2026-08-21 | 复核修复 | ora-1：P0-B5-1 校验/重映射顺序定死（先校验后重映射，原始 id 空间校验文件内部引用，跨现有看板引用一律 validation-error，补 X22）；P1-B5-1 merge 重映射后重申 B1 完整校验（补 X23）；P1-B5-2 附件缺失复用 B1 占位语义（PRD §9，X4 对齐）；P2-B5-1 outputPath 缺失复用占位；P2-B5-2 迁移复用 B1 migrate()（X13）；P2-B5-3 replace 失败备份可手动还原（补 X24） |

## 自检记录

- 追踪完整性：PASS（B5→CON-R017/024/033 + §15.3 + FR-16→验收，追踪矩阵全覆盖）
- OpenAPI 一致性：不适用（本地导出/导入契约，无 OpenAPI yaml；导出格式=boards.json 快照，字段事实源在 B1 契约 JSON Schema）
- 示例与错误场景：PASS（24 个联调场景 X1~X24 含成功/失败/边界 + 公共异常集 KANBAN_EXPORT_ERROR/KANBAN_IMPORT_ERROR）
- 安全与敏感字段：PASS（无敏感字段；DSH_HOME 零接触——导入写入 userData/kanban，导出文件含附件引用不含二进制）
- 链接与格式：PASS
