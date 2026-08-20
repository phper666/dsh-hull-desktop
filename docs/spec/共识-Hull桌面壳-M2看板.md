# Hull 桌面壳（M2 任务看板）共识文档

> 版本：v1.0 · 更新：2026-08-19 · 维护者：phper666（PM） · 状态：已发布
> 数据来源：M2 PRD v0.6（docs/prd/2026-08-19-m2-kanban-prd.md）、交互原型 v6（docs/prototype/m2-kanban.html）
> 关联：M2 任务看板（PRD 审核通过 2026-08-19，用户确认）

## 1. 文档元信息

- **本版本变更**：首次建立——从 M2 PRD v0.6 + 交互原型提取整理为业务事实源；登记规则 CON-R017~CON-R029（所属模块=看板）；登记未决项 U-001~U-003（PRD §12 遗留待办，下期承接）；PRD 已定案 O-1~O-11 不重复登记（引用 §11 说明）。
- **历史变更摘要**：无（首版）。

## 2. 文档结构总览

- **覆盖**：M2 任务看板全部业务面——看板/列/卡片/子任务/执行模式（manual/auto）/执行通道（ExecutionProvider/ACP/插件/CLI）/评论时间线/人工干预（暂停/取消/重试/AC 修订/手动完成）/自定义列/人工拖拽语义。
- **适用范围**：仅 Hull 壳内看板业务（规划/跟踪/持久化/执行编排）；**不覆盖** dsh 官方业务（agent 内部行为、官方 UI、会话内容）——那些是 dsh 的领域，Hull 只做容器与执行通道客户端。
- **不做事项（M2 明确排除）**：多设备同步（O-4 定案，P2 导出/导入为过渡）；看板数据加密（O-3 定案，同步/云协作场景再评估 SQLite）；插件独立发布（O-5 定案，随壳分发）；任务级指定 agent/模型（O-10 定案，agentSpec 留位功能排后）；并行依赖图可视化（P2 遗留待办）；多人协作/权限。

## 3. 领域术语表

| 术语 | 定义 | 出处 |
|:-----|:-----|:-----|
| 看板 | 一组列 + 一组卡片的容器；顶层数据为 boards[]，M2 默认单看板，多看板 P2 | PRD §5 Schema |
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
| 串行/并行 | 父任务子任务执行顺序：默认串行（逐步验证/依赖天然满足/失败定位准）；显式声明无依赖才可并行（≤maxParallelTasks） | PRD FR-11 |
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
                ├──→ interrupted（AC 修订）──→ queued（以新 AC 重跑）/ Verify（手动完成）/ running（继续原执行，不推荐）
                ├──→ cancelled
                └──→ failed ──→ queued（重试）
```

### 5.2 合法迁移矩阵

| 当前状态 | 合法迁移 | 触发条件 | 冲突行为 |
|:---------|:---------|:---------|:---------|
| idle | → queued | 点「执行」（auto 需 AC 必填项完整；manual 无门槛） | — |
| queued | → running / cancelled | 调度就绪 / 用户取消 | — |
| running | → paused / interrupted / cancelled / succeeded / failed | 用户暂停 / 用户编辑 AC / 用户取消 / 执行完成 / 执行失败 | 执行中拖到其他列：执行不终止，结果写 timeline，列以人工为准（标注"执行完成，列由人工指定"） |
| paused | → running / cancelled | 用户恢复 / 用户取消 | — |
| interrupted | → queued / Verify / running | 用户三选：① 以新 AC 重跑 ② 手动完成 ③ 继续原执行（不推荐，agent 仍按旧 AC） | — |
| failed | → queued / Verify / 改状态 | 用户重试 / 手动完成 / 改状态 | — |
| succeeded | → Verify（自动）/ 人工指定列 | auto 自验通过自动流转 / 人工拖拽 | 拖到 Done 但未执行完成 → 确认弹窗（可强制通过） |
| Verify | → Done | 人工确认（把关主流程，不绕过） | — |

### 5.3 人工拖拽语义（FR-4，最高优先级）

- 人工移动（菜单/拖拽）直接生效，系统**不自动矫正**（永不覆盖人工状态）。
- 冲突提示（可强制通过）：拖到 Done 但执行中/未执行 → "任务未完成执行，确认跳过？"；父卡拖 Done 但子任务未完成 → "子任务未全部完成，确认？"；执行中拖到其他列 → 执行不终止，列以人工为准。
- 聚合自动重算：子卡拖拽 → 父卡进度/状态即时重算（父卡未被人工锁定前提下；父卡人工拖拽后聚合不覆盖，除非用户再次移动）。
- 拖拽动作写 timeline（system 记录：from→to、时间、user）。

### 5.4 执行中修订 AC 流程（FR-11）

1. running 中用户编辑 AC → 弹窗警示"将中断当前执行"；
2. 当前执行标记 `interrupted`（原因：AC 修订），partial 结果保留进 timeline 并标注"已废弃（AC 修订）"；
3. AC diff 写入 timeline（system 记录：变更前后对照、时间、操作人）；
4. 用户三选：① 以新 AC 重新执行（重新入队，现场结果可参考）② 手动完成（不重跑）③ 仅记录修订继续原执行（不推荐，agent 仍按旧 AC）；
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

### 7.1 Task（任务/卡片）

| 字段 | 语义 | 必填 | 来源 | 枚举/默认 | 敏感性 |
|:-----|:-----|:-----|:-----|:----------|:-------|
| id | 任务唯一标识 | 是 | 系统 | t_<uuid> | 无 |
| parentId | 非空即子任务（指向父任务 id） | 否 | 用户 | 单层嵌套 | 无 |
| columnId | 所在列 | 是 | 用户/聚合 | 默认 Todo | 无 |
| title | 标题 | 是 | 用户 | ≤200 字符 | 无 |
| executionMode | 执行模式 | 是 | 用户 | manual（默认）/ auto | 无 |
| acceptanceCriteria | 验收标准 | auto 必填 | 用户 | what/expected/verify 强校验必填 + context 可选 | 无 |
| agentSpec | agent 指定 | 否 | 用户（M2 不指定） | provider 默认 'dsh'；agent/model 可空 | 无 |
| description | 描述（Markdown） | 否 | 用户 | P1 | 无 |
| labels | 标签（彩色小徽标，用户可配颜色） | 否 | 用户 | 数组 | 无 |
| priority | 优先级 | 否 | 用户 | P0/P1/P2/无（默认 P2） | 无 |
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
| execution | 执行详情（type=execution 时携带） | 否 | { status, command, startedAt, finishedAt, exitCode, outputPath } |

- 约束：execution 记录恒为 agent 来源；system 事件恒为 system 来源；评论可为 user 或 agent（人工把关需区分内容可信来源）；评论可删除（附件一并删除），execution/system 只读。

### 7.5 设置项（SettingsProvider）

| 字段 | 语义 | 默认 | 说明 |
|:-----|:-----|:-----|:-----|
| maxAttachmentSizeMB | 附件单文件上限 | 10 | 超限拒绝上传并提示 |
| maxParallelTasks | 并行执行并发上限 | 5 | 显式声明无依赖才可并行 |

## 8. 业务规则清单

| 编号 | 规则描述 | 来源 | 当前结论 | 变更状态 |
|:-----|:---------|:-----|:---------|:---------|
| CON-R017 | 看板数据归属：`<userData>/kanban/boards.json`，JSON 单文件 + schema version + 原子写（temp+rename，复用 settings.json 模式），不碰 DSH_HOME | PRD §5/FR-5 | 生效 | 稳定 |
| CON-R018 | 执行模式：manual（默认）/auto；auto 必填 AC 四字段（what/expected/verify 强校验必填 + context 可选），未填不可提交执行 | PRD FR-6 | 生效 | 稳定 |
| CON-R019 | 执行通道：ExecutionProvider 抽象 + ACP 默认实现（JSON-RPC stdio / newSession+prompt / session/cancel / 仅已提交文本）；--patch 插件备选；CLI headless 兜底 | PRD §7.4 | 生效 | 稳定 |
| CON-R020 | 人工拖拽最高优先级：直接生效、系统不自动矫正（永不覆盖人工状态）、冲突确认可强制通过、拖拽写 timeline | PRD FR-4 | 生效 | 稳定 |
| CON-R021 | 执行中修订 AC：中断执行（interrupted）、partial 标"已废弃（AC 修订）"、AC diff 留痕（前后对照/时间/操作人）、验证以最新 AC 为准 | PRD FR-11 | 生效 | 稳定 |
| CON-R022 | 父任务聚合：全 Done→父 Done；任一 Blocked→父 Blocked；否则父列 = 子任务列中 order 最大列；父卡默认聚合推导、人工移动可覆盖 | PRD FR-7/FR-4 | 生效 | 稳定 |
| CON-R023 | 并行上限：maxParallelTasks 默认 5 可配置；显式声明"无依赖"才可并行；并行属 P2 增强，M2 默认串行 | PRD FR-11/§7.3 | 生效 | 稳定 |
| CON-R024 | 附件上限：maxAttachmentSizeMB 默认 10 可配置；删除卡片级联清理评论 + 附件（含磁盘文件） | PRD FR-9/§7.3 | 生效 | 稳定 |
| CON-R025 | 评论来源区分：timeline.source{type, agentId, provider}，provider 默认 'dsh' 预留多 agent 平台 | PRD §5/FR-9 | 生效 | 稳定 |
| CON-R026 | 子任务跨列：子卡独立显示（非常驻父卡下）+ 父引用徽标（↳ #父编号 缩略标题）+ 父卡跨列聚合（进度条/展开列表） | PRD FR-8 | 生效 | 稳定 |
| CON-R027 | 执行顺序：父任务子任务默认串行（逐步验证/依赖天然满足/失败定位准）；无依赖并行（P2 增强） | PRD FR-11 | 生效 | 稳定 |
| CON-R028 | 干预后仍走 Verify 把关：暂停/取消/重试/手动完成/改状态均不绕过人工把关 | PRD FR-11 | 生效 | 稳定 |
| CON-R029 | 执行结果回写：auto 验证通过→自动流转 Verify；manual 结果以评论回填、列流转手动；执行完成但列由人工指定时不自动推进 | PRD FR-11/FR-9 | 生效 | 稳定 |

## 9. 枚举值与常量

- **6 态模板列**：backlog（排期池）/ todo（待办）/ in_progress（进行中）/ verify（验证审查）/ done（完成）/ blocked（阻塞，可进可出，解除回原列）。
- **优先级**：P0 / P1 / P2 / 无（默认 P2）；卡片左侧色条色板：P0 红 / P1 琥珀 / P2 蓝 / 无优先级灰（枚举色板，非每卡随机色）。
- **执行状态**：idle（未执行）/ queued（排队中）/ running（执行中）/ paused（已暂停）/ interrupted（已中断，AC 修订）/ cancelled（已取消）/ failed（失败）/ succeeded（成功）。
- **来源类型**：user / agent / system。
- **timeline type**：comment / execution / system。
- **颜色语义（三色分层）**：卡片左侧色条 = 优先级；标签 = 彩色小徽标（用户可配）；列头色带 = 列语义（列自定义配置）。
- **常量**：标题 ≤200 字符（原型 120 为简化，以 PRD 为准）；执行超时 30min（插件侧）；输出摘要截断 4KB；写盘防抖 500ms；附件路径 `<userData>/kanban/attachments/<timelineId>/`；执行输出 `<userData>/kanban/executions/e_<uuid>.log`；boards.json ≤5MB 时加载 <500ms。

## 10. 第三方对接

| 外部系统 | 用途 | 关键点 |
|:---------|:-----|:-------|
| dsh ACP（Agent Client Protocol） | 默认执行通道（壳 spawn dsh ACP 子进程，JSON-RPC over stdio） | newSession(cwd) + prompt（文本+资源引用）发起；session/cancel 取消；agent_message_chunk 流式（仅已提交文本）；session/request_permission 机器审批；局限：无会话加载/恢复/列表、无图片/音频、无推理/工具实时视图；暂停无原生语义 → 降级"标记暂停 + 结果丢弃保留现场" |
| dsh --patch 插件（hull-kanban-executor） | 备选执行通道（随壳分发，O-5 定案） | ctx.tools.register('hull.kanban.execute')；agent 执行中可查/回写看板（harness.handle / host.call IPC）；独立发布时换进程内 ctx.agents 实现（接口/数据模型零改动） |
| dsh CLI headless | 兜底执行通道 | spawn `dsh run <prompt>`，解析 stdout/退出码；无事件流（仅开始/结束），暂停/取消降级为 kill 进程 |

## 11. 未决项登记

> PRD O-1~O-11 已全部定案（见 PRD §11.1），不重复登记；此处仅登记 PRD §12 遗留待办（下期承接，文档头"遗留待办"清单同步）。

| 编号 | 问题 | 负责人 | 阻断等级 | 状态 | 结论 | 回写位置 |
|:-----|:-----|:-------|:---------|:-----|:-----|:---------|
| U-001 | agentSpec 任务级指定（provider/agent/model 选择 UI） | PM | P2 | open | 数据结构已入 schema 留位（O-10 定案），功能排后；触发：多 agent 平台接入 | PRD §12 |
| U-002 | 多 agent 平台接入（provider 抽象落地） | PM | P2 | open | ExecutionProvider 已抽象（§7.4），provider 字段预留；触发：接入第二个平台 | PRD §12 |
| U-003 | 并行增强（依赖图可视化） | PM | P2 | open | 并行基础已定（O-9：显式声明无依赖 + maxParallelTasks=5）；触发：并行执行实际使用后 | PRD §12 |

## 12. 页面交互规范

| 页面/组件 | 角色 | 功能 | 权限 | 数据范围 |
|:----------|:-----|:-----|:-----|:---------|
| 看板主界面 | 用户 | 左侧 Hull 导航（dsh web/设置/升级/任务看板）+ 右侧看板视图；工具栏（搜索/优先级筛选/状态筛选/标签筛选/清除/管理列/新建任务）；列（300px，列头色带=列颜色，卡片数徽标）；卡片（左侧色条=优先级、模式徽标、父引用徽标、标签、进度条+展开子任务列表、截止/负责人、执行状态徽标、←/→/agent 按钮） | 全量 | 看板数据 |
| 详情侧板 | 用户 | 标题/描述/元信息/父任务面包屑（点击跳父）/执行模式（auto 四字段 or manual AI 结果）/执行流程步骤条/子任务列表（点击跳子）/附件（上限提示）/时间线 tab + 评论 tab/干预按钮区 | 全量 | 单卡片 |
| 编辑弹窗 | 用户 | 标题/描述/执行模式切换（auto 显示四字段，manual 显示 AI 结果输入）/依赖子任务 ID（逗号分隔，留空=无依赖可并行）/优先级/状态/截止/负责人/标签；auto 必填项缺失标红拦截 | 全量 | 单卡片 |
| 列管理弹窗 | 用户 | 列列表（序号/颜色选择器/名称/上移下移/删除，模板列锁定）+ 重置默认/新增列/保存；删除列时列内卡片移入 Todo | 全量 | 看板列 |
| AC 修订弹窗 | 用户 | 警示条（"修改验收标准将中断当前执行"）+ 四字段 + 提交修订；提交后执行 interrupted + diff 留痕 | 仅 running 中 auto 任务 | 单卡片 |
| 执行流程步骤条 | 用户 | idle→queued→running→verify→done 步骤条 + 分支（失败/已取消/已中断（AC 修订）） | 只读 | 单卡片 |
| 干预按钮区 | 用户 | running→暂停/编辑 AC/取消；queued→取消；paused→恢复/取消；interrupted→以新 AC 重执行/手动完成/继续原执行（不推荐）；failed→重试；success/idle/failed→手动完成/改状态 | 全量 | 单卡片 |
| 时间线 | 用户 | 评论+执行记录统一流；agent 来源带 AI 徽标（agentId 显示），user 评论无徽标，execution 恒显 AI 标识；评论 tab 含输入框 | 评论可写，execution/system 只读 | 单卡片 |

## 13. 后端任务规范

- **执行调度**：父任务执行 = 子任务默认串行依次执行（前序失败中止后续）；显式声明无依赖的子任务可并行，并发数 ≤ maxParallelTasks（默认 5）；调度逻辑参考原型 runChildrenBatch（就绪子任务按依赖满足度分批启动）。
- **聚合重算**：子卡流转/新增/删除 → 父卡状态即时重算（全 Done/任一 Blocked/order 最大列）；父卡被人工拖拽锁定后聚合不覆盖（除非用户再次移动）。
- **级联清理**：删除卡片 → 级联删除子任务 + 全部评论 + 附件磁盘文件（二次确认）。
- **原子写**：boards.json 写临时文件 → rename 覆盖；变更即写（防抖 500ms）；写失败提示且内存态保留。
- **损坏兜底**：解析失败 → 备份 `boards.json.corrupt-<ts>` → 重建默认看板并提示；schema version 不兼容 → 迁移函数，迁移失败走备份重建。
- **执行结果回写**：manual 模式 → 结果以评论追加（通道回传自动追加 / 用户手动粘贴）；auto 模式 → 写 execution 记录 + 自验通过自动流转 Verify；执行完成但列由人工指定 → 标注"执行完成，列由人工指定"，不自动推进。
- **执行门控**：auto 模式 AC 必填项未填完整 → 执行禁用；dsh 未就绪 → 执行禁用并提示；单卡单执行（执行中按钮禁用）。

## 14. 端差异汇总

本模块不涉及（单端桌面应用，无多端差异）。

## 15. 附录与版本记录

### 15.1 文档关联

- **关联**：PRD（docs/prd/2026-08-19-m2-kanban-prd.md）、原型（docs/prototype/m2-kanban.html）、规则索引（docs/spec/规则索引.md）、M1 共识（docs/spec/共识-Hull桌面壳-M1.md）。

### 15.2 版本记录

| 版本 | 日期 | 变更摘要条目 | 说明 |
|:-----|:-----|:-------------|:-----|
| v1.0 | 2026-08-19 | 变更摘要-M2看板.md 已登记（2026-08-20） | 首次建立：从 M2 PRD v0.6 + 原型提取整理为业务事实源；登记 CON-R017~CON-R029、U-001~U-003 |