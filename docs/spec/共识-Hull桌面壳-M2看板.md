# Hull 桌面壳（M2 任务看板）共识文档

> 版本：v1.3 · 更新：2026-08-20 · 维护者：phper666（PM） · 状态：已发布
> 数据来源：M2 PRD v0.6（docs/prd/2026-08-19-m2-kanban-prd.md）、交互原型 v6（docs/prototype/2026-08-19-m2-kanban-prototype.html）
> 关联：M2 任务看板（PRD 审核通过 2026-08-19，用户确认）

## 1. 文档元信息

- **本版本变更**：v1.3 三角色扫描 4 P2 回写 + 2 决策。① Q-026 执行超时修正为**活动心跳超时**（非总时长）：连续 N 分钟无活动事件 → 疑似卡死 → failed；阈值可配（maxExecutionIdleMinutes 默认 30）；用户可手动"延长执行"；② Q-027 Blocked 隐藏列语义（隐藏=过滤，解除回原列）；③ Q-028 agent 评论只读不可删；④ Q-029 加载 500ms 测量口径（≤5MB 数据集 + 冷启动计时）。决策：⑤ **多项目看板提前进 M2**（原 P2 FR-11 多看板提前，boards[] 顶层 + 创建/切换/独立列）；⑥ **实时协作分享记录为 M2+**（需服务器+同步，关联 O-4；M2 只做导出/导入分享 FR-16；权限模型 M2+）。Q-026~Q-029 已 closed 回写。
- **历史变更摘要**：（v1.2 三角色扫描 10 P1 回写 + 并行进 M2——O-9 变更 + maxParallelTasks 5→3；并行闭环/重启收敛/审批流/级联补全/assignee/空态三态/interrupted 修订/迁移矩阵三类/mock 桩/执行记录时序。v1.1 三角色扫描 3 P0 回写——executionStatus+currentExecutionId 双轨解耦/dependencies 自声明/selfCheck 判定信号；agentSpec 补 subagentPolicy + CON-R030 多 agent 派发。v1.0 为首次建立——从 M2 PRD v0.6 + 交互原型提取整理为业务事实源；登记规则 CON-R017~CON-R029；登记未决项 U-001~U-003；PRD 已定案 O-1~O-11 不重复登记。）

## 2. 文档结构总览

- **覆盖**：M2 任务看板全部业务面——看板（**多项目看板：boards[] 顶层，创建/切换/独立列配置**）/列/卡片/子任务/执行模式（manual/auto）/执行通道（ExecutionProvider/ACP/插件/CLI）/评论时间线/人工干预（暂停/取消/重试/AC 修订/手动完成）/自定义列/人工拖拽语义。
- **适用范围**：仅 Hull 壳内看板业务（规划/跟踪/持久化/执行编排）；**不覆盖** dsh 官方业务（agent 内部行为、官方 UI、会话内容）——那些是 dsh 的领域，Hull 只做容器与执行通道客户端。
- **不做事项（M2 明确排除）**：多设备同步（O-4 定案，P2 导出/导入为过渡）；看板数据加密（O-3 定案，同步/云协作场景再评估 SQLite）；插件独立发布（O-5 定案，随壳分发）；任务级指定 agent/模型（O-10 定案，agentSpec 留位功能排后）；并行依赖图可视化（P2 遗留待办）；多人协作/权限（**实时协作分享记录为 M2+**，见 §15.3）。

## 3. 领域术语表

| 术语 | 定义 | 出处 |
|:-----|:-----|:-----|
| 看板 | 一组列 + 一组卡片的容器；顶层数据为 boards[]，**M2 支持多项目看板（决策 1）：每 Board 独立列配置/任务，可创建/切换**；M2 默认单看板 | PRD §5 Schema + 决策 1 |
| 列 | 卡片的状态容器；默认预置 6 态模板列，可增删/改名/排序/改色/隐藏（模板列不可删） | PRD FR-2 |
| 卡片/任务 | 看板最小工作单元；标题必填，可含描述/标签/优先级/截止/执行模式/验收标准/时间线 | PRD FR-3 |
| 子任务 | 挂在父任务下的独立卡片（`parentId` 指向父卡）；单层嵌套（不可再嵌套，YAGNI） | PRD FR-7 |
| 父任务 | 含子任务的卡片；列状态默认由子任务聚合推导，人工移动可覆盖 | PRD FR-7/FR-4 |
| 执行模式 | 任务级配置 `executionMode`：manual（默认，结果手动放入 ticket）/ auto（AC 必填，验证通过自动流转） | PRD FR-6 |
| 验收标准（AC） | auto 模式必填四字段：what（做什么）/ expected（期望结果）/ verify（如何验证）强校验必填 + context（上下文）可选 | PRD FR-6/§5 |
| 执行记录 | timeline 中 type=execution 的条目；含状态/命令/起止时间/退出码/输出摘要/输出落盘路径 | PRD §5 Schema |
| 时间线（timeline） | 卡片内统一流：评论 + 执行记录 + 系统事件，按时间正序；评论可删，execution/system 只读 | PRD FR-9 |
| ExecutionProvider | 壳内执行抽象层接口（execute + handlers + cancel），数据模型与执行协议解耦，换实现零数据改动 | PRD §7.4 |
| ACP | Agent Client Protocol——dsh 官方协议（JSON-RPC over stdio）；壳 spawn dsh ACP 子进程发起 headless 任务 | PRD §7.4 |
| 状态流转 | 卡片在列间移动（菜单/拖拽）；Blocked 可进可出（记录 blockedFromColumnId，解除回原列） | PRD FR-4 |
| 聚合状态（父卡） | 父卡列由子任务推导：全 Done→父 Done；任一 Blocked→父 Blocked；否则取子任务列中 order 最大列 | PRD FR-7 |
| 人工干预 | 用户对执行的动作：暂停/取消/重试/手动完成/改状态/编辑 AC；全部写 timeline（system, user） | PRD FR-11 |
| 手动完成 | 用户人工标记完成；仍走 Verify 把关主流程（不绕过） | PRD FR-11 干预表 |
| 串行/并行 | 父任务子任务执行顺序：默认串行（逐步验证/依赖天然满足/失败定位准）；`dependencies` 为空（无依赖）才可并行（≤maxParallelTasks，默认 3）；并行进 M2 | PRD FR-11 + Q-016 |
| 父引用徽标 | 子卡常驻徽标（`↳ #父编号 缩略标题`），点击跳转父卡；子卡跨列后以普通卡独立显示 | PRD FR-8 |
| 来源模型（source） | timeline 条目来源对象 `{ type: user/agent/system, agentId?, provider? }`；provider 默认 'dsh' 预留其他平台 | PRD §5/FR-9 |
| agentSpec | 任务级 agent 指定 `{ provider?, agent?, model? }`；M2 默认不指定（走 dsh 默认会话），数据结构留位功能排后 | PRD §5/FR-11 |

## 4. 模块概述

- **定位**：Hull 壳内任务看板——规划/跟踪开发工作 + 把任务交给 dsh agent 执行、结果回写看板，形成"规划 → 执行 → 验证 → 完成"闭环。
- **业务目标**：① 壳内可视化规划与跟踪（6 态列 + 卡片 + 子任务）；② 任务级执行模式（manual/auto）与 agent 执行闭环；③ 评论/执行记录统一时间线留痕；④ 数据本地 JSON 单文件、可迁移、损坏可重建。
- **参与角色**：当前 solo（pm/be/fe/qa = phper666）；用户是唯一操作者；agent（dsh）为执行方（非操作者）。
- **子模块清单**：看板数据层（boards.json 存储/原子写/损坏兜底）、看板 UI（列/卡片/详情侧板/弹窗/拖拽）、执行通道（ExecutionProvider：ACP 默认/插件备选/CLI 兜底）、评论时间线（timeline 统一流 + 附件）、设置项（maxAttachmentSizeMB / maxParallelTasks 进 SettingsProvider）。

## 5. 业务流程与状态机

### 5.1 任务执行状态机（FR-11）

```
idle → queued → running → succeeded → Verify（人工把关）→ Done
                ├──→ paused ──→ running（恢复）/ cancelled
                ├──→ interrupted（AC 修订）──→ queued（以新 AC 重跑）/ Verify（手动完成）
                ├──→ cancelled
                └──→ failed ──→ queued（重试）
```

> **双轨解耦（Q-013 结论）**：本状态机迁移作用于 Task `executionStatus`（执行生命周期）；`columnId`（看板列）是另一轨——人工拖拽改 columnId **不改** executionStatus；父任务聚合基于 columnId，executionStatus 提供补充信号（如执行中徽标、冲突提示依据）。两轨独立持久化、独立流转。

### 5.2 合法迁移矩阵

| 当前状态 | 合法迁移 | 触发条件 | 冲突行为 |
|:---------|:---------|:---------|:---------|
| idle | → queued | 点「执行」（auto 需 AC 必填项完整；manual 无门槛） | — |
| queued | → running / cancelled | 调度就绪 / 用户取消 | — |
| running | → paused / interrupted / cancelled / succeeded / failed | 用户暂停 / 用户编辑 AC / 用户取消 / 执行完成 / 执行失败 | 执行中拖到其他列：执行不终止，结果写 timeline，列以人工为准（标注"执行完成，列由人工指定"） |
| paused | → running / cancelled | 用户恢复 / 用户取消 | — |
| interrupted | → queued / Verify | 用户两选一：① 以新 AC 重跑 ② 手动完成（Q-022 修订，删除"继续原执行"） | — |
| failed | → queued / Verify / 改状态 | 用户重试 / 手动完成 / 改状态 | — |
| succeeded | → Verify（自动）/ 人工指定列 / queued（重跑） | auto 自验通过自动流转 / 人工拖拽 / 再次点「执行」重跑 | 拖到 Done 但未执行完成 → 确认弹窗（可强制通过） |
| Verify | → Done / queued（重跑） | 人工确认（把关主流程，不绕过）/ 再次点「执行」重跑 | — |

> **补充迁移三类（Q-023 结论）**：
> 1. **人工拖拽列迁移（通用）**：任何执行态 → 任意列，仅改 columnId **不改 executionStatus**（双轨解耦）；冲突确认可强制通过（§5.3）。
> 2. **重跑规则（执行重入 + 系统收敛，合并一条）**：任何执行态点「执行」→ queued（含 succeeded 重跑、failed 重试、interrupted 以新 AC 重跑）；系统收敛迁移（依赖失败/壳重启/并行组失败）→ 对应 failed/queued 状态（见 §13）。
> 3. 列迁移与重跑规则不新增专用迁移，合并入上述矩阵行。

### 5.3 人工拖拽语义（FR-4，最高优先级）

- 人工移动（菜单/拖拽）直接生效，系统**不自动矫正**（永不覆盖人工状态）。
- 冲突提示（可强制通过）：拖到 Done 但执行中/未执行 → "任务未完成执行，确认跳过？"；父卡拖 Done 但子任务未完成 → "子任务未全部完成，确认？"；执行中拖到其他列 → 执行不终止，列以人工为准。
- 聚合自动重算：子卡拖拽 → 父卡进度/状态即时重算（父卡未被人工锁定前提下；父卡人工拖拽后聚合不覆盖，除非用户再次移动）。
- 拖拽动作写 timeline（system 记录：from→to、时间、user）。

### 5.4 执行中修订 AC 流程（FR-11）

1. running 中用户编辑 AC → 弹窗警示"将中断当前执行"；
2. **编辑 AC = 终止当前 ACP 进程**（Q-022 修订）；当前执行标记 `interrupted`（原因：AC 修订），partial 结果保留进 timeline 并标注"已废弃（AC 修订）"；
3. AC diff 写入 timeline（system 记录：变更前后对照、时间、操作人）；
4. 用户两选一：① 以新 AC 重新执行（重新入队 → queued，现场结果可参考）② 手动完成（不重跑 → Verify）；~~③ 仅记录修订继续原执行~~（已删除，agent 仍按旧 AC 与验证以新 AC 为准语义冲突，Q-022）；
5. 验证以最新 AC 为准；重跑后新执行记录追加。

### 5.5 父任务聚合规则（FR-7）

- 全部子任务在 Done 列 → 父卡自动移到 Done；
- 任一子任务在 Blocked → 父卡 Blocked（解除后按规则重算）；
- 否则父卡列 = 子任务所在列中 order 最大的列（进度最靠后）；
- 父卡列默认由聚合推导；人工移动父卡为最高优先级可覆盖（带冲突确认，见 5.3）。

## 6. 角色与权限矩阵

| 操作 | 用户 | 壳（系统） | agent | 说明 |
|:-----|:-----|:-----------|:------|:-----|
| 创建/编辑/删除卡片 | ✅ | — | — | 删除父卡级联删子任务（二次确认） |
| 列管理（增删改/排序/改色/隐藏） | ✅ | — | — | 模板列不可删 |
| 状态流转（菜单/拖拽） | ✅ | 聚合推导（父卡默认） | — | 人工移动最高优先级，不自动矫正 |
| 执行（触发 agent） | ✅ | 门控校验（auto 需 AC 完整） | 执行 | 单卡单执行，执行中按钮禁用 |
| 执行干预（暂停/取消/重试/AC 修订/手动完成/改状态） | ✅ | 记录 timeline | — | 干预后仍走 Verify 把关 |
| 评论/附件 | ✅ | 执行结果回写（manual 评论 / auto 记录） | 结果来源 | 评论可删，execution/system 只读 |
| 设置（附件上限/并行上限） | ✅ | 持久化 | — | 进 SettingsProvider |
| 看板数据读写 | — | ✅ 原子写/损坏兜底 | — | 不触 DSH_HOME（CON-R002） |

## 7. 字段业务定义

### 7.0 Board（看板/项目，决策 1：多项目看板提前进 M2）

> 顶层数据为 `boards[]` 数组，M2 支持多项目看板——每个 Board 独立列配置 + 任务集合，可创建/切换。M2 默认单看板起步，多项目为增量能力。

| 字段 | 语义 | 必填 | 来源 | 枚举/默认 |
|:-----|:-----|:-----|:-----|:----------|
| id | 看板唯一标识 | 是 | 系统 | b_<uuid> |
| name | 看板名（项目名） | 是 | 用户 | 可重命名 |
| columns | 列配置（独立于其他看板） | 是 | 用户 | 默认 6 态模板列 |
| tasks | 任务集合（该看板下任务） | 是 | 用户 | 空起步 |
| order | 看板排序 | 是 | 系统 | 数字 |
| createdAt / updatedAt | 创建/更新时间 | 是 | 系统 | ISO 时间戳 |

### 7.1 Task（任务/卡片）

| 字段 | 语义 | 必填 | 来源 | 枚举/默认 | 敏感性 |
|:-----|:-----|:-----|:-----|:----------|:-------|
| id | 任务唯一标识 | 是 | 系统 | t_<uuid> | 无 |
| parentId | 非空即子任务（指向父任务 id） | 否 | 用户 | 单层嵌套 | 无 |
| columnId | 所在列 | 是 | 用户/聚合 | 默认 Todo | 无 |
| title | 标题 | 是 | 用户 | ≤200 字符 | 无 |
| executionMode | 执行模式 | 是 | 用户 | manual（默认）/ auto | 无 |
| executionStatus | 执行生命周期状态（Q-013） | 是 | 系统 | idle（默认）/ queued / running / paused / interrupted / cancelled / failed / succeeded；与 columnId 双轨解耦 | 无 |
| currentExecutionId | 当前执行指向 timeline execution 条目 | 否 | 系统 | 可空（idle/failed 等无进行中执行时为空） | 无 |
| acceptanceCriteria | 验收标准 | auto 必填 | 用户 | what/expected/verify 强校验必填 + context 可选 | 无 |
| agentSpec | agent 指定 | 否 | 用户（M2 不指定） | provider 默认 'dsh'；agent/model 可空；subagentPolicy: 'auto'（默认）/ 'restricted' | 无 |
| dependencies | 依赖子任务 ID 数组（Q-014） | 否 | 用户 | 仅子任务可声明（同父下）；空 = 无依赖可并行；用户自声明不校验真伪（P2 加环检测） | 无 |
| description | 描述（Markdown） | 否 | 用户 | P1 | 无 |
| labels | 标签（彩色小徽标，用户可配颜色） | 否 | 用户 | 数组 | 无 |
| priority | 优先级 | 否 | 用户 | P0/P1/P2/无（默认 P2） | 无 |
| assignee | 负责人（Q-020） | 否 | 用户 | 可空；默认空或系统用户名（不引 createdBy）；纯展示/筛选，无权限语义；筛选器随 FR-14（P2）交付 | 无 |
| dueDate | 截止日期 | 否 | 用户 | 日期，可空 | 无 |
| order | 列内排序 | 是 | 系统 | 数字 | 无 |
| blockedFromColumnId | Blocked 来源列 | 否 | 系统 | 解除时恢复 | 无 |
| createdAt / updatedAt | 创建/更新时间 | 是 | 系统 | ISO 时间戳 | 无 |
| timeline | 统一时间线 | 是 | 系统 | 数组（见 7.4） | 无 |

### 7.2 Column（列）

| 字段 | 语义 | 必填 | 来源 | 枚举/默认 |
|:-----|:-----|:-----|:-----|:----------|
| id | 列唯一标识 | 是 | 系统 | c_<uuid> |
| type | 模板列类型 | 模板列有 | 系统 | backlog/todo/in_progress/verify/done/blocked（唯一、不可删） |
| name | 列名 | 是 | 用户 | 默认 6 态模板名 |
| order | 列排序 | 是 | 系统 | 数字 |
| color | 列头色带（列语义） | 是 | 用户 | 十六进制色值 |
| hidden | 隐藏/显示 | 是 | 用户 | 默认 false（Blocked 默认显示） |

### 7.3 SubTask（子任务）

- 子任务 = 普通 Task + 非空 `parentId`；无独立实体，平铺于 tasks[]。
- 单层嵌套（子任务不可再拆子任务，YAGNI）。
- 子任务默认继承父任务 executionMode，可单独覆盖。

### 7.4 Timeline 条目（Comment / ExecutionRecord / SystemEvent）

| 字段 | 语义 | 必填 | 枚举/默认 |
|:-----|:-----|:-----|:----------|
| id | 条目唯一标识 | 是 | tl_<uuid> |
| type | 条目类型 | 是 | comment / execution / system |
| content | 评论文本 / 执行摘要 / 事件描述 | 是 | — |
| attachments | 附件引用（name/path/size） | 否 | 落盘 userData/kanban/attachments/ |
| createdAt | 时间 | 是 | ISO 时间戳 |
| author | 显示名 | 否 | 可空 |
| source | 来源对象 | 是 | { type: user/agent/system, agentId?, provider? } |
| execution | 执行详情（type=execution 时携带） | 否 | { status, command, startedAt, finishedAt, exitCode, outputPath, selfCheck } |
| selfCheck | auto 自验判定信号（Q-015） | 否 | { passed: boolean, evidence?: string }；agent 完成返回 passed=true → 流转 Verify；false/超时/异常 → failed |

- 约束：execution 记录恒为 agent 来源；system 事件恒为 system 来源；评论可为 user 或 agent（人工把关需区分内容可信来源）；**评论删除权限（Q-028）**——user 评论可删（附件一并删除）；**agent 评论（含执行结果回填）只读不可删**（保执行记录一致性），需删走"删除执行记录"流程；execution/system 只读。

### 7.5 设置项（SettingsProvider）

| 字段 | 语义 | 默认 | 说明 |
|:-----|:-----|:-----|:-----|
| maxAttachmentSizeMB | 附件单文件上限 | 10 | 超限拒绝上传并提示 |
| maxParallelTasks | 并行执行并发上限 | 3 | 显式声明无依赖才可并行；默认 3（用户拍板"5 个太多"，v1.2） |
| maxExecutionIdleMinutes | 执行活动心跳超时（Q-026） | 30 | 连续 N 分钟无任何活动事件（agent_message_chunk 流式）→ 疑似卡死 → failed；非总时长限制；用户可手动"延长执行"（重设心跳窗口） |

## 8. 业务规则清单

| 编号 | 规则描述 | 来源 | 当前结论 | 变更状态 |
|:-----|:---------|:-----|:---------|:---------|
| CON-R017 | 看板数据归属：`<userData>/kanban/boards.json`，JSON 单文件 + schema version + 原子写（temp+rename，复用 settings.json 模式），不碰 DSH_HOME | PRD §5/FR-5 | 生效 | 稳定 |
| CON-R018 | 执行模式：manual（默认）/auto；auto 必填 AC 四字段（what/expected/verify 强校验必填 + context 可选），未填不可提交执行 | PRD FR-6 | 生效 | 稳定 |
| CON-R019 | 执行通道：ExecutionProvider 抽象 + ACP 默认实现（JSON-RPC stdio / newSession+prompt / session/cancel / 仅已提交文本）；--patch 插件备选；CLI headless 兜底 | PRD §7.4 | 生效 | 稳定 |
| CON-R020 | 人工拖拽最高优先级：直接生效、系统不自动矫正（永不覆盖人工状态）、冲突确认可强制通过、拖拽写 timeline | PRD FR-4 | 生效 | 稳定 |
| CON-R021 | 执行中修订 AC：编辑 AC = 终止当前 ACP 进程、执行标 interrupted、partial 标"已废弃（AC 修订）"、AC diff 留痕（前后对照/时间/操作人）、验证以最新 AC 为准、重跑后新执行记录追加；interrupted 收敛两选一（以新 AC 重跑 → queued / 手动完成 → Verify），不支持"继续原执行" | PRD FR-11 + Q-022 | 生效 | 修订（v1.2） |
| CON-R022 | 父任务聚合：全 Done→父 Done；任一 Blocked→父 Blocked；否则父列 = 子任务列中 order 最大列；父卡默认聚合推导、人工移动可覆盖 | PRD FR-7/FR-4 | 生效 | 稳定 |
| CON-R023 | 并行执行进 M2（O-9 变更）：maxParallelTasks 默认 3 可配置；`dependencies` 为空（无依赖）才可并行；依赖判据/失败传播/死锁兜底见 §13 | PRD FR-11/§7.3 + Q-016 | 生效 | 修订（v1.2） |
| CON-R024 | 附件上限：maxAttachmentSizeMB 默认 10 可配置；删除卡片级联清理评论 + 附件（含磁盘文件） | PRD FR-9/§7.3 | 生效 | 稳定 |
| CON-R025 | 评论来源区分：timeline.source{type, agentId, provider}，provider 默认 'dsh' 预留多 agent 平台 | PRD §5/FR-9 | 生效 | 稳定 |
| CON-R026 | 子任务跨列：子卡独立显示（非常驻父卡下）+ 父引用徽标（↳ #父编号 缩略标题）+ 父卡跨列聚合（进度条/展开列表） | PRD FR-8 | 生效 | 稳定 |
| CON-R027 | 执行顺序：父任务子任务默认串行（逐步验证/依赖天然满足/失败定位准）；无依赖子任务可并行（并行进 M2，O-9 变更） | PRD FR-11 | 生效 | 修订（v1.2） |
| CON-R028 | 干预后仍走 Verify 把关：暂停/取消/重试/手动完成/改状态均不绕过人工把关 | PRD FR-11 | 生效 | 稳定 |
| CON-R029 | 执行结果回写：auto 验证通过→自动流转 Verify；manual 结果以评论回填、列流转手动；执行完成但列由人工指定时不自动推进 | PRD FR-11/FR-9 | 生效 | 稳定 |
| CON-R030 | 多 agent 平台派发：agentSpec.subagentPolicy 'auto'（默认，允许内部调用子 agent，含跨平台子 agent，dsh 原生 ACP client/subagent 编排能力）/ 'restricted'（仅 dsh 自身，不调子 agent）；ExecutionProvider 可扩展多平台（provider 字段标识），dsh 作 ACP client 可编排跨平台子 agent | 共识 v1.1（用户新增） | 生效 | 新增 |
| CON-R031 | 多项目看板（决策 1）：boards[] 顶层，每 Board 独立列配置/任务，可创建/切换；M2 默认单看板起步 | 共识 v1.3 | 生效 | 新增 |
| CON-R032 | 执行活动心跳超时（Q-026）：连续 maxExecutionIdleMinutes（默认 30，可配）无活动事件 → 疑似卡死 → failed；非总时长限制；用户可手动"延长执行" | 共识 v1.3 | 生效 | 新增 |

## 9. 枚举值与常量

- **6 态模板列**：backlog（排期池）/ todo（待办）/ in_progress（进行中）/ verify（验证审查）/ done（完成）/ blocked（阻塞，可进可出，解除回原列）。
- **优先级**：P0 / P1 / P2 / 无（默认 P2）；卡片左侧色条色板：P0 红 / P1 琥珀 / P2 蓝 / 无优先级灰（枚举色板，非每卡随机色）。
- **执行状态**：idle（未执行）/ queued（排队中）/ running（执行中）/ paused（已暂停）/ interrupted（已中断，AC 修订）/ cancelled（已取消）/ failed（失败）/ succeeded（成功）。
- **来源类型**：user / agent / system。
- **timeline type**：comment / execution / system。
- **颜色语义（三色分层）**：卡片左侧色条 = 优先级；标签 = 彩色小徽标（用户可配）；列头色带 = 列语义（列自定义配置）。
- **常量**：标题 ≤200 字符（原型 120 为简化，以 PRD 为准）；**执行超时 = 活动心跳超时（Q-026）**——连续 `maxExecutionIdleMinutes`（默认 30）无活动事件 → 疑似卡死 → failed（非总时长限制，持续输出的长任务不超时；插件侧原 30min 固定超时废弃）；输出摘要截断 4KB；写盘防抖 500ms；附件路径 `<userData>/kanban/attachments/<timelineId>/`；执行输出 `<userData>/kanban/executions/e_<uuid>.log`；**boards.json ≤5MB 时加载 <500ms（Q-029 测量口径）：构造 ≤5MB 数据集（1000+ 卡）+ 冷启动（无缓存）计时基准 ≤500ms 验收**。

## 10. 第三方对接

| 外部系统 | 用途 | 关键点 |
|:---------|:-----|:-------|
| dsh ACP（Agent Client Protocol） | 默认执行通道（壳 spawn dsh ACP 子进程，JSON-RPC over stdio） | newSession(cwd) + prompt（文本+资源引用）发起；session/cancel 取消；**agent_message_chunk 流式（仅已提交文本）——即活动心跳（Q-026）：持续收流式事件视为活跃不超时**；**session/request_permission 机器审批流（Q-018）**：壳收 request_permission → 弹非阻塞确认框（任务/执行上下文 + agent 消息 + 批准/拒绝）→ 用户决策回 ACP 响应（approve/deny + request id，防 agent 悬挂）→ 30s 超时自动 deny + 关弹窗 → 决策写 timeline（system, user）→ 多请求并行按任务平铺/FIFO 排队；局限：无会话加载/恢复/列表、无图片/音频、无推理/工具实时视图；暂停无原生语义 → 降级"标记暂停 + 结果丢弃保留现场" |
| dsh --patch 插件（hull-kanban-executor） | 备选执行通道（随壳分发，O-5 定案） | ctx.tools.register('hull.kanban.execute')；agent 执行中可查/回写看板（harness.handle / host.call IPC）；独立发布时换进程内 ctx.agents 实现（接口/数据模型零改动） |
| dsh CLI headless | 兜底执行通道 | spawn `dsh run <prompt>`，解析 stdout/退出码；无事件流（仅开始/结束），暂停/取消降级为 kill 进程 |
| 多 agent 平台（provider 扩展，CON-R030） | ExecutionProvider 可扩展执行平台 | provider 字段标识平台（默认 'dsh'）；dsh 作 ACP client 可编排跨平台子 agent（subagentPolicy='auto' 时）；restricted 仅 dsh 自身不调子 agent |

## 11. 未决项登记

> PRD O-1~O-11 已全部定案（见 PRD §11.1），不重复登记；此处仅登记 PRD §12 遗留待办（下期承接，文档头"遗留待办"清单同步）。Q-013~Q-029 为三角色扫描问题（载体：飞书 q-item 清单 `dsh-hull-desktop-q-item`）；Q-013~Q-029 已全部确认闭环。

| 编号 | 问题 | 负责人 | 阻断等级 | 状态 | 结论 | 回写位置 |
|:-----|:-----|:-------|:---------|:-----|:-----|:---------|
| Q-013 | executionStatus 未入 Task schema | PM | P0 | closed | 增 executionStatus（8 态）+ currentExecutionId；执行生命周期与 columnId 双轨解耦 | §7.1/§5.1 |
| Q-014 | dependencies 字段缺失 | PM | P0 | closed | 增 dependencies: string[]（子任务自声明，空=无依赖可并行）；父任务不参与并行调度；自声明不校验真伪（P2 加环检测） | §7.1 |
| Q-015 | auto 自验判定信号未定义 | PM | P0 | closed | execution 记录增 selfCheck: { passed, evidence? }；passed=true→Verify，false/超时/异常→failed | §7.4/§13 |
| Q-016 | 并行调度规则未闭环 | PM | P1 | closed | 依赖判据（succeeded/manual 按列 Done）；混合编排（空依赖→并行池≤3）；失败传播（直接依赖方→failed）；死锁兜底（停止批处理+父 failed）；父卡派生态 | §13 |
| Q-017 | 壳重启后执行态恢复未定义 | PM | P1 | closed | running/paused/interrupted→failed（"壳重启进程中断"）+补 finishedAt+清 currentExecutionId+system 事件；queued→重跑就绪检查；全量收敛后统一依赖重算 | §13 |
| Q-018 | permission_request 审批流缺失 | PM | P1 | closed | 非阻塞确认框（上下文+消息+批准/拒绝）→ ACP 响应（approve/deny+request id）；30s 超时自动 deny；决策写 timeline；多请求 FIFO | §10 |
| Q-019 | 级联删除漏 executions log | PM | P1 | closed | 补 executions/*.log 清理；执行态检查（running/queued 禁删）；从调度队列摘除；清理其他子任务 dependencies 引用 | §13 |
| Q-020 | 负责人字段缺失 | PM | P1 | closed | §7.1 增 assignee（可空，纯展示/筛选无权限语义）；筛选器随 FR-14（P2）；schema 向后兼容 | §7.1 |
| Q-021 | 空态三态未定义 | PM | P1 | closed | 空列（"新建任务"引导）/筛选无结果（清除筛选按钮）/空看板（自动建 6 列） | §12 |
| Q-022 | interrupted 继续原执行语义矛盾 | PM | P1 | closed | 删"继续原执行"，interrupted 收敛两选一；编辑 AC=终止 ACP 进程；全量同步 | §5.1/§5.2/§5.4/§12/CON-R021 |
| Q-023 | 状态机迁移矩阵不完整 | PM | P1 | closed | 补三类：列迁移（不改 executionStatus）/重跑规则（任何态点执行→queued）/系统收敛；②③合并为重跑规则 | §5.2 |
| Q-024 | ACP 无 mock/桩定义 | PM | P1 | closed | 两级替身：接口级内存桩（主）+ ACP 帧协议桩（可选）；HULL_EXEC_PROVIDER=mock 仅 debug/test；真实冒烟保留 | §13 |
| Q-025 | 并行上限无观测口径 | PM | P1 | closed | 执行开始即写 execution 记录（startedAt），完成补 finishedAt；断言双界（≥2 且 ≤3）；mock 可控延迟；依赖分批时序断言 | §13 |
| Q-026 | 执行超时仅插件侧 | PM | P2 | closed | 修正为**活动心跳超时**（非总时长）：连续 maxExecutionIdleMinutes（默认 30）无活动事件→疑似卡死→failed；阈值可配；用户可手动"延长执行" | §9/§7.5/§13 |
| Q-027 | Blocked 隐藏时解除语义 | PM | P2 | closed | 隐藏列=卡片不显示（视为过滤），数据保留；解除 Blocked 回原列重新显示 | §12 |
| Q-028 | agent 评论删除权限 | PM | P2 | closed | user 评论可删；agent 评论（含执行回填）只读不可删（保执行记录一致性）；需删走"删除执行记录"流程 | §7.4 |
| Q-029 | 加载 500ms 无测量口径 | PM | P2 | closed | 构造 ≤5MB 数据集（1000+ 卡）+ 冷启动（无缓存）计时；冷启动 ≤500ms 验收 | §9 |
| U-001 | agentSpec 任务级指定（provider/agent/model 选择 UI） | PM | P2 | open | 数据结构已入 schema 留位（O-10 定案），功能排后；触发：多 agent 平台接入 | PRD §12 |
| U-002 | 多 agent 平台接入（provider 抽象落地） | PM | P2 | open | ExecutionProvider 已抽象（§7.4），provider 字段预留；触发：接入第二个平台 | PRD §12 |
| U-003 | 并行增强（依赖图可视化） | PM | P2 | open | 并行执行已进 M2（O-9 变更，依赖声明+maxParallelTasks=3）；依赖图可视化仍 P2 排后 | PRD §12 |

## 12. 页面交互规范

| 页面/组件 | 角色 | 功能 | 权限 | 数据范围 |
|:----------|:-----|:-----|:-----|:---------|
| 看板主界面 | 用户 | 左侧 Hull 导航（dsh web/设置/升级/任务看板）+ 右侧看板视图；**多项目看板（决策 1）：看板切换器/创建看板按钮，各看板独立列+任务**；工具栏（搜索/优先级筛选/状态筛选/标签筛选/清除/管理列/新建任务）；列（300px，列头色带=列颜色，卡片数徽标）；卡片（左侧色条=优先级、模式徽标、父引用徽标、标签、进度条+展开子任务列表、截止/负责人、执行状态徽标、←/→/agent 按钮） | 全量 | 看板数据 |
| 详情侧板 | 用户 | 标题/描述/元信息/父任务面包屑（点击跳父）/执行模式（auto 四字段 or manual AI 结果）/执行流程步骤条/子任务列表（点击跳子）/附件（上限提示）/时间线 tab + 评论 tab/干预按钮区 | 全量 | 单卡片 |
| 编辑弹窗 | 用户 | 标题/描述/执行模式切换（auto 显示四字段，manual 显示 AI 结果输入）/依赖子任务 ID（逗号分隔，留空=无依赖可并行）/优先级/状态/截止/**负责人（assignee，可空，Q-020）**/标签；auto 必填项缺失标红拦截 | 全量 | 单卡片 |
| 列管理弹窗 | 用户 | 列列表（序号/颜色选择器/名称/上移下移/删除，模板列锁定）+ 重置默认/新增列/保存；删除列时列内卡片移入 Todo | 全量 | 看板列 |
| AC 修订弹窗 | 用户 | 警示条（"修改验收标准将中断当前执行"）+ 四字段 + 提交修订；提交后执行 interrupted + diff 留痕 | 仅 running 中 auto 任务 | 单卡片 |
| 执行流程步骤条 | 用户 | idle→queued→running→verify→done 步骤条 + 分支（失败/已取消/已中断（AC 修订）） | 只读 | 单卡片 |
| 干预按钮区 | 用户 | running→暂停/编辑 AC/取消；queued→取消；paused→恢复/取消；interrupted→以新 AC 重执行/手动完成（Q-022 修订，删"继续原执行"）；failed→重试；success/idle/failed→手动完成/改状态/重跑（任何态可点执行重跑，Q-023 重跑规则） | 全量 | 单卡片 |
| 时间线 | 用户 | 评论+执行记录统一流；agent 来源带 AI 徽标（agentId 显示），user 评论无徽标，execution 恒显 AI 标识；评论 tab 含输入框 | 评论可写，execution/system 只读 | 单卡片 |

> **空态三态（Q-021 结论）**：① 空列——无卡片，显示"新建任务"引导按钮；② 筛选无结果——显示"无匹配卡片"提示 + 清除筛选按钮；③ 空看板——罕见兜底（首进自动建 6 态模板列，正常不出现）。

> **隐藏列语义（Q-027 结论）**：隐藏列 = 该列卡片不显示（视为过滤），数据保留不展示；解除 Blocked（blockedFromColumnId）后卡片自动回原列重新显示；被隐藏的 Blocked 列内卡片不显示在任一列区。

## 13. 后端任务规范

- **执行调度（Q-016 并行闭环）**：父任务执行 = 子任务默认串行依次执行（前序失败中止后续）；`dependencies` 为空的子任务入**并行池**，并发数 ≤ maxParallelTasks（默认 3）；有依赖 → 前驱 succeeded 后入池。
  - **依赖满足判据**：被依赖子任务 `executionStatus == succeeded`；manual 子任务作依赖 → 按列 Done 判（防死锁）。
  - **依赖失败传播**：被依赖 failed → 直接依赖方 queued → failed（"依赖失败"，可重试）。
  - **死锁兜底**：无就绪 + 仍有 queued → 停止批处理 + 父级 failed（"依赖无法满足/疑似循环"）+ 人工处理。
  - **父卡执行态（派生，不持久化）**：任一子 running/queued → 父 running/queued；流水线失败 → 父 failed；全部 succeeded → 父 succeeded；父 currentExecutionId 恒空。
  - 依赖为用户自声明（Q-014：仅子任务、同父下、不校验真伪，P2 加环检测）；父任务不参与并行调度。
- **壳重启执行态收敛（Q-017）**：启动时收敛——running/paused/interrupted → failed（"壳重启进程中断"）+ 补 finishedAt + 清 currentExecutionId + system 事件；queued → 重跑就绪检查（依赖已收敛 failed → 转 failed"依赖失败"；仍满足 → 保留重调度 + system 事件"已重新排队"）；全量收敛后统一触发依赖重算。
- **自验判定信号（Q-015）**：auto 模式 agent 完成返回 `selfCheck.passed=true` → 自动流转 Verify；`passed=false` / 超时 / 异常 → failed。不用"无异常即通过"（selfCheck 明确可测）。
- **执行记录时序（Q-025）**：执行开始即写 execution 记录（`startedAt`），完成补 `finishedAt`——供并行观测、状态视图、重启收敛共同依赖；Q-025 用例断言双界（峰值并发 ≥2 且 ≤3）、mock 可控延迟、依赖分批时序（后置 startedAt ≥ 前驱 finishedAt）。
- **测试替身（Q-024）**：两级——① ExecutionProvider 接口级内存桩（主，确定性事件注入：权限/超时/cancel/流式/selfCheck passed=false）；② ACP 帧协议桩（可选，仅验证编解码）。`HULL_EXEC_PROVIDER=mock` 仅 debug/test 生效；真实 dsh 冒烟保留。
- **活动心跳超时（Q-026）**：执行超时 = 活动心跳——ACP 持续收流式事件（agent_message_chunk）视为活跃不超时；**连续 `maxExecutionIdleMinutes`（默认 30，可配）无任何活动事件** → 判定"疑似卡死" → failed + 终止进程；非总时长限制（持续输出 3 小时的任务不超时，卡死 30min 无输出的任务超时）；用户可手动"延长执行"（重设心跳窗口）。
- **聚合重算**：子卡流转/新增/删除 → 父卡状态即时重算（全 Done/任一 Blocked/order 最大列）；父卡被人工拖拽锁定后聚合不覆盖（除非用户再次移动）。
- **级联清理（Q-019 补全）**：删除卡片 → 级联删除子任务 + 全部评论 + 附件磁盘文件 + **executions/\*.log**（与 PRD R4 滚动清理互补）；**删除前检查全部子任务执行态**（任一 running/queued → 禁止删除）；**被删任务从调度队列摘除**；**清理其他子任务 dependencies 中对该任务的引用**（二次确认）。
- **原子写**：boards.json 写临时文件 → rename 覆盖；变更即写（防抖 500ms）；写失败提示且内存态保留。
- **损坏兜底**：解析失败 → 备份 `boards.json.corrupt-<ts>` → 重建默认看板并提示；schema version 不兼容 → 迁移函数，迁移失败走备份重建。
- **执行结果回写**：manual 模式 → 结果以评论追加（通道回传自动追加 / 用户手动粘贴）；auto 模式 → 写 execution 记录 + 自验通过自动流转 Verify；执行完成但列由人工指定 → 标注"执行完成，列由人工指定"，不自动推进。
- **执行门控**：auto 模式 AC 必填项未填完整 → 执行禁用；dsh 未就绪 → 执行禁用并提示；单卡单执行（执行中按钮禁用）。

## 14. 端差异汇总

本模块不涉及（单端桌面应用，无多端差异）。

## 15. 附录与版本记录

### 15.1 文档关联

- **关联**：PRD（docs/prd/2026-08-19-m2-kanban-prd.md）、原型（docs/prototype/2026-08-19-m2-kanban-prototype.html）、规则索引（docs/spec/规则索引.md）、M1 共识（docs/spec/共识-Hull桌面壳-M1.md）。

### 15.2 版本记录

| 版本 | 日期 | 变更摘要条目 | 说明 |
|:-----|:-----|:-------------|:-----|
| v1.3 | 2026-08-20 | 变更摘要-M2看板.md 已登记（2026-08-20） | 4 P2 回写（心跳超时/隐藏列语义/agent 评论只读/500ms 测量口径）+ 多项目看板提前进 M2 + 实时协作记录 M2+ |
| v1.2 | 2026-08-20 | 变更摘要-M2看板.md 已登记（2026-08-20） | 并行进 M2（O-9 变更）+ maxParallelTasks 5→3；10 P1 回写：并行闭环/重启收敛/审批流/级联补全/assignee/空态三态/interrupted 修订/迁移矩阵三类/mock 桩/执行记录时序 |
| v1.1 | 2026-08-20 | 变更摘要-M2看板.md 已登记（2026-08-20） | 三角色扫描 3 P0 回写：executionStatus+currentExecutionId（双轨解耦）/dependencies（自声明）/selfCheck 判定信号；agentSpec 补 subagentPolicy + CON-R030 多 agent 平台派发 |
| v1.0 | 2026-08-19 | 变更摘要-M2看板.md 已登记（2026-08-20） | 首次建立：从 M2 PRD v0.6 + 原型提取整理为业务事实源；登记 CON-R017~CON-R029、U-001~U-003 |

### 15.3 后续规划（M2+）

> 记录 M2 明确后置/不实做项，供后续里程碑规划承接。

| 项 | 阶段 | 说明 |
|:---|:-----|:-----|
| **实时协作分享** | M2+（不实做） | 需服务器 + 同步（关联 O-4 同步后置）；他人实时可见/可编辑；**M2 只做"导出分享"**（导出看板/ticket JSON → 可导入，FR-16 导出/导入承载） |
| **权限模型** | M2+ | 被分享人可看/可改需权限语义；M2 无权限语义（Q-020 明确 assignee 纯展示/筛选无权限）；实时协作需权限，M2+ 引入 |
| 多项目看板 | **已提前进 M2**（决策 1） | 原 P2（FR-11 多看板）提前；boards[] 顶层 + 创建/切换/独立列，见 §7.0/§12 |
| 导出/导入 | M2（FR-16 承载） | 导出分享的基础；与实时协作区分 |