# B4 执行集成与审批契约

## 契约信息

- 工作项：B4 执行集成与审批（飞书 dsh-hull-desktop 清单，t100104）
- 契约状态：已冻结（2026-08-21，ora-1 第二轮复核通过）
- 版本：v0.2
- 适用版本：M2（共识 v1.4）
- 最后更新：2026-08-21
- 说明：桌面壳本地执行集成契约（无 HTTP API 面）；核心 = ACP JSON-RPC stdio 集成（newSession/prompt/session.cancel/agent_message_chunk/request_permission 连接生命周期）+ permission_request 审批流（非阻塞弹窗/30s 超时 deny/FIFO/timeline 留痕）+ selfCheck 判定 + 多 agent 注册表（CON-R030）+ AC 修订入口。**B4 构建在 B3 ExecutionProvider 之上**——B4 提供 ACP Provider（B3 `execute()` 的默认实现），向 B2（UI）暴露审批/AC 修订交互契约。

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| ACP 接入（JSON-RPC stdio 生命周期） | B4 | CON-R019 + Q-018 | newSession/prompt/session.cancel/agent_message_chunk/request_permission 生命周期完整；dsh 能力边界明确（仅已提交文本、无会话恢复） | ACP Provider（B4 内部，实现 B3 ExecutionProvider）+ `kanban:onExecutionUpdate` | 已定义 |
| permission_request 审批流 | B4 | CON-R019 + Q-018 | 非阻塞确认框（任务上下文+agent 消息+批准/拒绝）→ 回 ACP（approve/deny+request id）→ 30s 超时自动 deny → 决策写 timeline（system,user）→ 多请求 FIFO | `kanban:onPermissionRequest` + `kanban:approvalRespond`（对齐 B3） | 已定义 |
| selfCheck 判定 | B4 | CON-R029 + Q-015 | selfCheck{passed,evidence}——passed=true→Verify/false→failed；超时/异常→failed | 结果回写（B4 集成层） | 已定义 |
| 多 agent 拓展（CON-R030） | B4 | CON-R030 + Q-024 | agentSpec{provider,agent,model,subagentPolicy}；ExecutionProvider 注册表可扩展；subagentPolicy auto/restricted 语义 | `kanban:getAgentProviders` + ProviderRegistry | 已定义 |
| 执行中修订 AC | B4 | CON-R021 + Q-022 | 编辑 AC=终止 ACP 进程；interrupted 两选一（重跑→queued/手动完成→Verify）；AC diff 写 timeline | `kanban:editAcceptanceCriteria` + `kanban:manualComplete`（B3） | 已定义 |
| 执行门控（auto 需 AC） | B4 | CON-R018 | auto 模式 AC 必填项缺失 → 不可提交执行 | 透传 B3 `kanban:executeTask` 门控 | 已定义 |

## 范围与非目标

### 范围

- ACP JSON-RPC stdio 集成契约：连接生命周期（spawn/newSession/prompt/session.cancel/agent_message_chunk/request_permission）、帧契约、dsh 能力边界
- permission_request 审批流：审批事件推送（onPermissionRequest）、响应回 ACP（approvalRespond，对齐 B3）、30s 超时自动 deny、多请求 FIFO、决策 timeline 留痕
- selfCheck 判定：passed=true→Verify / false→failed / 超时异常→failed；manual 无 selfCheck→结果回填评论
- 多 agent 注册表（CON-R030）：ProviderRegistry（register/list/resolve）、agentSpec{provider,agent,model,subagentPolicy} 语义、subagentPolicy auto/restricted
- AC 修订入口：running 中编辑 AC → 确认 → 终止 ACP 进程 → interrupted + AC diff timeline + 两选一（重跑/手动完成）
- B2 消费接口：审批弹窗交互（onPermissionRequest）+ AC 修订入口（editAcceptanceCriteria）+ agentSpec 选择（getAgentProviders）

### 非目标

- 执行引擎/状态机全迁移/并行调度/心跳超时/重启收敛（B3，B4 构建其上，不重复定义）
- 看板 UI/交互/拖拽（B2）
- 看板数据模型/持久化（B1，agentSpec 数据结构已入 B1 schema）
- 导出/导入（B5）
- 插件独立发布（O-5 定案，随壳分发）
- 任务级指定 agent/模型选择 UI（O-10 排后，agentSpec 数据结构留位）
- 多 agent 平台第二实现落地（U-002 P2，仅抽象 + 注册表先行）

## 业务流程与状态

### 核心流程

```text
B4 启动 → ProviderRegistry.register('dsh', ACPProviderFactory) → provider 列表就绪
B3 executeTask → 调度就绪 → 调 B4 ACPProvider.execute()
  spawn dsh ACP 子进程（JSON-RPC over stdio）→ newSession(cwd) → prompt(taskId+AC)
  agent_message_chunk 流式（仅已提交文本）= 活动心跳（B3 消费，Q-026）
  收到 session/request_permission → B4 生成审批事件 → kanban:onPermissionRequest → B2 非阻塞确认框（FIFO 排队）
    用户决策 → kanban:approvalRespond → B4 回 ACP approve/deny+requestId → 写 timeline（system,user）
    30s 无响应 → 自动 deny + 关弹窗 + timeline
  完成 → ExecutionResult(exitCode/summary/outputPath/selfCheck) → B4 判定
    auto + selfCheck.passed=true → succeeded + 列→verify（B3 自动流转）
    auto + selfCheck.passed=false / 超时 / 异常 → failed
    manual（无 selfCheck）→ 结果以评论回填 + 列流转手动
执行中 B2 编辑 AC → kanban:editAcceptanceCriteria → 警示确认 → 终止 ACP 进程 → interrupted + AC diff timeline + partial 标"已废弃" → 两选一（重跑 queued / 手动完成 Verify）
```

### ACP 连接生命周期（B4 集成层内部，非 Task 执行态）

> Task 执行态（8 态）状态机由 B3 定义，此处不重复。下表为 ACP 连接自身状态（壳侧视角）。

| 当前连接态 | 动作 | 目标态 | 触发条件 | 冲突行为 | 依据 |
|:---|:---|:---|:---|:---|:---|
| disconnected | spawn dsh ACP 子进程 | connecting | B3 调度就绪调 execute() | spawn 失败 → exec-provider-unavailable | CON-R019 |
| connecting | newSession 响应 | session_ready | ACP 返回 sessionId | 超时/无响应 → failed | CON-R019 |
| session_ready | prompt(taskId+AC) | executing | 会话就绪 | — | CON-R019 |
| executing | agent_message_chunk | executing | 流式事件（活动心跳） | — | Q-026 |
| executing | session/cancel | cancelled | 用户取消（B3 cancelExecution） | 无会话 → kill 进程 | O-11 |
| executing | 心跳超时 | terminated | 连续 maxExecutionIdleMinutes 无活动（B3） | kill 进程 | Q-026 |
| executing | AC 修订 | terminated | B4 editAcceptanceCriteria 触发 | 终止 ACP + interrupted | Q-022 |
| 任意态 | 壳退出 | terminated | 壳重启（B3 收敛：→failed"壳重启进程中断"） | ACP 进程随壳退出 | Q-017 |

### 审批请求状态（Q-018）

| 当前态 | 动作 | 目标态 | 触发条件 | 冲突行为 |
|:---|:---|:---|:---|:---|
| pending | 用户批准 | approved | approvalRespond{decision:'approve'} | — |
| pending | 用户拒绝 | denied | approvalRespond{decision:'deny'} | — |
| pending | 30s 无响应 | auto-denied | 超时定时器 | 自动 deny + 关弹窗 |
| approved/denied/auto-denied | 再次响应 | 不变 | 重复 approvalRespond | **exec-approval-not-pending** |

> FIFO：多请求按任务平铺排队（queuePosition），先到先响应；响应任一请求不阻塞其他请求。

## 接口清单

> B4 为本地执行集成契约，无 HTTP paths；"接口" = IPC channel（主进程 B4 集成层暴露，preload 桥接，B2 renderer 消费）。B3 已定义的执行控制 IPC（executeTask/cancel/pause/resume/manualComplete/extendExecution/getExecutionSnapshot/onExecutionUpdate）不重复，B4 仅对齐消费。

| # | 状态 | 方法 | 路径（IPC channel） | 用途 | 权限 | 幂等 |
|---|---|---|---|---|---|---|
| 1 | 已定义 | event | `kanban:onPermissionRequest` | 审批请求推送（B4→B2 弹窗触发） | 无（壳内） | — |
| 2 | 已定义 | invoke | `kanban:approvalRespond` | 审批响应回 ACP（对齐 B3 签名） | 无 | 否（一次性） |
| 3 | 已定义 | invoke | `kanban:editAcceptanceCriteria` | AC 修订入口（running 中编辑 AC） | 无 | 否（中断） |
| 4 | 已定义 | invoke | `kanban:getAgentProviders` | 查询已注册 provider（agentSpec 选择 UI） | 无 | 读 |

## Schema 与枚举

### ACP JSON-RPC 帧契约（JSON-RPC over stdio）

> B4 ACP Provider = B3 ExecutionProvider 的默认实现；帧方法名与共识 §10/PRD §7.4 对齐。

| 方向 | 方法/事件 | 参数/返回 | 说明 |
|:---|:---|:---|:---|
| 壳→dsh | newSession | 参数 `{ cwd }`；返回 `{ sessionId }` | 发起会话（壳 spawn dsh ACP 子进程） |
| 壳→dsh | prompt | 参数 `{ sessionId, text, resources? }` | 提交任务（text 携带 taskId+AC） |
| 壳→dsh | session/cancel | 参数 `{ sessionId }` | 取消执行（O-11；无会话则 kill 进程兜底） |
| dsh→壳 | agent_message_chunk | `{ sessionId, content }` | 流式事件，**仅已提交文本**；= 活动心跳（Q-026） |
| dsh→壳 | session/request_permission | `{ requestId, message }` | 机器审批请求（非阻塞确认框触发） |
| 壳→dsh | session/request_permission 响应 | `{ requestId, approved: boolean, reason? }` | 用户决策回 ACP（approve=approved:true / deny=approved:false） |

### ACP 能力边界（deepwiki 官方事实）

| 能力 | 状态 | 说明 |
|:---|:---|:---|
| 流式事件 | 仅已提交文本 | agent_message_chunk（无中间推理/工具实时视图） |
| 会话恢复 | 无 | 无会话加载/恢复/列表 → 壳重启依赖 B3 收敛（Q-017） |
| 暂停 | 无原生语义 | O-11：降级"标记暂停 + 结果丢弃保留现场" |
| 图片/音频 | 无 | 附件不参与 ACP 执行输入 |

### ProviderInfo（getAgentProviders 响应）

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| provider | string | 是 | 默认 'dsh'（CON-R030 预留其他平台） | 平台标识 |
| displayName | string | 是 | 平台显示名 | UI 展示 |
| available | boolean | 是 | dsh ACP 是否就绪可 spawn | 就绪状态 |
| supportsSubagent | boolean | 是 | 是否支持 subagentPolicy='auto' 编排 | 多 agent 编排能力 |

### 多 agent 注册表（ProviderRegistry，CON-R030）

| 项 | 类型 | 说明 |
|:---|:---|:---|
| register(provider, factory) | method | 注册执行平台（provider 标识）；**幂等——同 provider 重复注册 = 覆盖旧 factory（写日志），不报错**；M2 仅 'dsh' 注册 |
| list() | method | 列出已注册 provider（供 getAgentProviders） |
| resolve(provider) | method | 解析 agentSpec.provider 到对应 ExecutionProvider 实现；**未注册 → exec-provider-unavailable**（含可用性不一致判定） |
| subagentPolicy | enum | 'auto'（默认，允许 dsh 内部调用子 agent，含跨平台子 agent）/ 'restricted'（仅 dsh 自身，不调子 agent） |

> **resolve 失败语义与 available 口径（P1-B4-2，必读）**：
> - `resolve(provider)` 双重判定：① provider **未注册**（registry 无此键）→ `exec-provider-unavailable`；② 已注册但 **factory 就绪检查失败**（如 dsh ACP 不可 spawn）→ 同样 `exec-provider-unavailable`。
> - `getAgentProviders[].available` 与 executeTask 实际可用口径**一致**——available = resolve(provider) 当前能否通过（注册 + 就绪双判）；UI 显示 available=false 的 provider，executeTask 必回 `exec-provider-unavailable`；available=true 的 provider，executeTask 仅可能因瞬时故障失败（spawn 竞争），不存在"UI 显示可用但必然不可用"的常态不一致。
> - 重复 register 幂等（覆盖 + 日志），resolve/list/getAgentProviders 均以**最新注册**为准。

> agentSpec 字段（provider/agent/model/subagentPolicy）数据结构已入 B1 schema（B1 契约），B4 消费解析，不重复定义。

### 审批事件负载（onPermissionRequest）

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| boardId | string | 是 | 看板 id |
| taskId | string | 是 | 任务 id |
| title | string | 是 | 任务标题（弹窗上下文） |
| requestId | string | 是 | ACP request_permission 下发 id |
| message | string | 是 | agent 审批消息（弹窗展示） |
| queuePosition | integer | 是 | FIFO 排队位置（从 1 起） |
| deadlineAt | string | 是 | ISO 8601 UTC；推送时刻 + 30s | **超时截止时间（P1-B4-1）**——计时器归属 **B4 主进程**，deadlineAt 由主进程计算下发；B2 只据此展示倒计时，不自行起 30s 计时器 |

```json
{ "boardId": "b_2f5a1c00-0000-4000-8000-000000000001", "taskId": "t_1a2b3c4d-0000-4000-8000-000000000001", "title": "实现看板拖拽流转", "requestId": "req_0001", "message": "允许执行 git push 到 origin/main？", "queuePosition": 1, "deadlineAt": "2026-08-21T10:00:30.000Z" }
```

> **审批超时计时器生命周期（P1-B4-1，必读）**：
> 1. **计时器归属 = B4 主进程**，不依赖渲染层——pending 请求在主进程维护 deadlineAt（收到 request_permission 时刻 + 30s），到点由主进程执行 auto-deny + timeline 留痕 + 推送关弹窗；**B2 渲染层只读 deadlineAt 展示倒计时**（渲染延迟/崩溃不吃窗口）。
> 2. **B2 崩溃/弹窗关闭**：pending 请求计时器仍由主进程跑，30s 到点照常 auto-deny——agent 不悬挂；B2 重连后通过 `getPendingApprovals`（B4 内部重推或快照）恢复弹窗展示。
> 3. **壳重启**：pending 请求 → **立即 auto-deny + timeline 留痕**（对齐 B3 重启收敛 Q-017，主进程计时器随壳销毁无法延续，重启即判定超时拒绝）。

### selfCheck 判定规则（Q-015）

| selfCheck | 模式 | 结果 | 说明 |
|:---|:---|:---|:---|
| passed=true | auto | succeeded + 列→verify | 自动流转 Verify（CON-R029） |
| passed=false | auto | failed | 明确失败信号 |
| 超时/异常 | auto | failed | 心跳超时（B3）/通道异常 |
| 无 selfCheck | manual | 结果回填评论 + 列流转手动 | 不自动推进（CON-R029） |

> ExecutionRecord.selfCheck 字段（{ passed, evidence? }）已入 B1 schema，B4 集成层写判定。

### 公共异常集

> 复用 B3 已定义 `KANBAN_EXEC_ERROR`（exec-* 集 + validation-error/store-not-found）。下表列 B4 特有/本契约高频触发的错误码语义（与 B3 全集一致，不重复定义全集）。

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| exec-not-running | 非 running 时 editAcceptanceCriteria（AC 修订仅 running 门控） | code + msg + currentStatus | 提示当前状态 | 否 |
| exec-approval-not-pending | approvalRespond 时 requestId 不存在/已响应（含 30s 超时已 auto-deny） | code + msg + requestId | 提示"审批已处理" | 否 |
| exec-provider-unavailable | agentSpec.provider 未注册 / dsh ACP 未就绪 / spawn 失败 | code + msg | 提示"执行通道未就绪，请检查 dsh" | 是 |
| validation-error | AC 修订缺必填（what/expected/verify）；decision 非法 | code + msg + field | 提示字段 | 否 |
| exec-not-found | 任务/看板 id 不存在 | code + msg | 提示"数据已删除，自动刷新" | 否 |

## 接口详情

### 1. onPermissionRequest

`event kanban:onPermissionRequest`

#### 用途与依据

- 使用场景：ACP 收到 session/request_permission → B4 推送审批事件 → B2 弹出非阻塞确认框（任务上下文 + agent 消息 + 批准/拒绝）
- 共识：CON-R019 + Q-018
- 验收：B4 验收（审批流弹窗交互）

#### 事件负载

见 Schema 章「审批事件负载」：boardId/taskId/title/requestId/message/queuePosition/deadlineAt。

```json
{ "boardId": "b_2f5a1c00-0000-4000-8000-000000000001", "taskId": "t_1a2b3c4d-0000-4000-8000-000000000001", "title": "实现看板拖拽流转", "requestId": "req_0001", "message": "允许执行 git push 到 origin/main？", "queuePosition": 1, "deadlineAt": "2026-08-21T10:00:30.000Z" }
```

#### 交互约束（B2 消费）

- 弹窗**非阻塞**：不阻断看板操作；多个审批请求 FIFO 排队（queuePosition 提示）
- **超时倒计时（P1-B4-1）**：计时器归属 **B4 主进程**（deadlineAt 主进程计算下发）；B2 只读 deadlineAt 展示倒计时，**不自行起 30s 计时器**；超时由主进程 auto-deny + timeline 留痕 + 推送关弹窗（B2 监听 close 事件）；已超时请求不再可响应
- **B2 崩溃/重连**：pending 请求计时器仍由主进程跑，30s 到点照常 auto-deny（B2 崩溃不影响）；B2 重连后经 B4 内部快照重推恢复弹窗展示
- 批准/拒绝 → 调 `kanban:approvalRespond`（对齐 B3 签名）

#### 失败响应

- 事件通道，无失败响应（B4 侧生成失败不影响推送）。

#### 测试要点

- 成功：request_permission → 弹窗触发，负载字段完整（含 deadlineAt）
- 边界：多请求 FIFO queuePosition 正确；超时自动关弹窗；**B2 崩溃后 30s 仍 auto-deny（P1-B4-1 A17）**；壳重启 pending 立即 auto-deny

### 2. approvalRespond

`invoke kanban:approvalRespond { boardId, taskId, requestId, decision, message? }`

#### 用途与依据

- 使用场景：B2 审批弹窗 → 用户批准/拒绝 → 回 ACP 响应（approve/deny + request id，防 agent 悬挂）；30s 超时自动 deny（Q-018）
- 共识：CON-R019 + Q-018
- 验收：B4 验收（审批流批准/拒绝/超时）；签名与 B3 一致（B3 已定义控制 IPC，此处对齐消费，不重复定义）
- 说明：本接口由 B3 契约定义（`kanban:approvalRespond`），B4 为审批流集成侧消费方 + 明确 30s 超时/FIFO/timeline 语义

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | taskId | string | 是 | `t_<uuid>` | 任务 id |
| body | requestId | string | 是 | ACP request_permission 下发 id | 审批请求 id |
| body | decision | string | 是 | 'approve' / 'deny' | 用户决策 |
| body | message | string | 否 | ≤500 字符 | 审批附加说明（写 timeline） |

#### 成功响应

- 响应 Schema：`{ taskId, requestId, decision }`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `taskId` | string | 是 | 否 | 请求入参 | 任务 id |
| `requestId` | string | 是 | 否 | 请求入参 | 审批请求 id |
| `decision` | string | 是 | 否 | 'approve'/'deny' | 回执 |

```json
{ "code": 0, "msg": "success", "data": { "taskId": "t_1a2b3c4d-0000-4000-8000-000000000001", "requestId": "req_0001", "decision": "approve" } }
```

#### 失败响应

- 适用公共异常集：`KANBAN_EXEC_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| exec-approval-not-pending | requestId 不存在/已响应（含 30s 超时已自动 deny） | code+msg+requestId | 提示"审批已处理" | 否 |
| validation-error | decision 非法（非 approve/deny）；message 超长 | code+msg+field | 提示字段 | 否 |
| exec-not-found | 任务/看板不存在 | code+msg | 提示已删除 | 否 |

#### 幂等与并发

- 幂等键：requestId（一次性）
- 重复请求：已响应 → exec-approval-not-pending
- 并发：多请求并行按任务平铺/FIFO 排队；响应任一不阻塞其他

#### 副作用与审计

- 数据写入：决策写 timeline（system,user）——"审批 {approve/deny}: {message}"（Q-018）
- 外部调用：ACP 响应（approve/deny + request id）；30s 超时自动 deny + 关弹窗
- **message → reason 映射（P2-B4-1）**：approvalRespond.message（≤500 字符）映射为 ACP `session/request_permission` 响应帧的 `reason` 字段（`{ requestId, approved, reason }`）；message 为空时 reason 省略（approved 仍必填）

#### 测试要点

- 成功：approve/deny → ACP 响应 + timeline 决策留痕
- 冲突：已响应/超时后再次响应 → exec-approval-not-pending
- 边界：30s 超时自动 deny

### 3. editAcceptanceCriteria

`invoke kanban:editAcceptanceCriteria { boardId, taskId, acceptanceCriteria }`

#### 用途与依据

- 使用场景：B2 详情侧板/AC 修订弹窗（仅 running 中 auto 任务）；编辑 AC = 终止当前 ACP 进程（Q-022），执行标 interrupted，partial 标"已废弃（AC 修订）"，AC diff 写 timeline
- 共识：CON-R021 + Q-022
- 验收：B4 验收（AC 修订流程）
- 边界说明：**非 running** 状态编辑 AC 走 B1 `kanban:updateTask` 普通编辑（不触发中断）；本接口仅承接 running 中修订
- **B2 按状态分流（P2-B4-3）**：B2 编辑 AC 前查 Task.executionStatus——`running` → 走本接口（editAcceptanceCriteria，弹窗警示"将中断当前执行"）；`非 running`（idle/queued/paused/interrupted/failed/succeeded）→ 走 B1 `kanban:updateTask` 普通编辑（不中断执行、无 diff 留痕要求）；本接口对非 running 请求统一回 `exec-not-running` 兜底（双保险）

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | taskId | string | 是 | `t_<uuid>` | 任务 id |
| body | acceptanceCriteria.what | string | 是 | 非空 | AC-做什么 |
| body | acceptanceCriteria.expected | string | 是 | 非空 | AC-期望结果 |
| body | acceptanceCriteria.verify | string | 是 | 非空 | AC-如何验证 |
| body | acceptanceCriteria.context | string | 否 | 可空 | AC-上下文 |

#### 成功响应

- 响应 Schema：`{ taskId, executionStatus: 'interrupted', previousExecutionId }`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `taskId` | string | 是 | 否 | 请求入参 | 任务 id |
| `executionStatus` | string | 是 | 否 | 'interrupted' | 中断结果（AC 修订） |
| `previousExecutionId` | string | 是 | 否 | 系统生成 `e_<uuid>` | 被中断的执行记录 id（partial 标"已废弃"） |

```json
{ "code": 0, "msg": "success", "data": { "taskId": "t_1a2b3c4d-0000-4000-8000-000000000001", "executionStatus": "interrupted", "previousExecutionId": "e_9f8e7d6c-0000-4000-8000-000000000001" } }
```

#### 失败响应

- 适用公共异常集：`KANBAN_EXEC_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| exec-not-running | 非 running（AC 修订仅 running 门控；非 running 走 B1 updateTask） | code+msg+currentStatus | 提示"仅执行中可修订"，引导走普通编辑 | 否 |
| validation-error | AC 缺必填（what/expected/verify） | code+msg+field | 提示字段 | 否 |
| exec-not-found | 任务/看板不存在 | code+msg | 提示已删除 | 否 |

#### 幂等与并发

- 幂等键：无（每次修订触发中断）
- 重复请求：已 interrupted 后再次修订 → exec-not-running（不再中断）
- 状态冲突：running 中编辑 → 警示确认（B2 弹窗"将中断当前执行"）后提交

#### 副作用与审计

- 数据写入：AC diff 写 timeline（system 记录：变更前后对照/时间/操作人，CON-R021）；partial 执行结果保留进 timeline 并标注"已废弃（AC 修订）"；新 AC 落 Task.acceptanceCriteria
- 外部调用：**终止当前 ACP 进程**（session/cancel 或 kill）
- 审计事件：system 事件"执行已中断（AC 修订）"

#### 测试要点

- 成功：running → interrupted + ACP 进程终止 + AC diff 留痕 + partial 标废弃
- 参数：AC 缺必填 → validation-error
- 冲突：非 running → exec-not-running（走 B1 updateTask）
- 外部依赖：ACP 进程终止正确（无残留子进程）

### 4. getAgentProviders

`invoke kanban:getAgentProviders`

#### 用途与依据

- 使用场景：B2 agentSpec 选择 UI（provider/agent/model/subagentPolicy）；M2 默认不指定 agent/模型（O-10 排后），provider 列表供状态展示与预留
- 共识：CON-R030
- 验收：B4 验收（多 agent provider 列表）

#### 请求

无请求体。

#### 成功响应

- 响应 Schema：`array[ProviderInfo]`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `[]` | array[ProviderInfo] | 是 | 否 | 空数组合法（无注册 provider） | provider 列表 |
| `[].provider` | string | 是 | 否 | 默认 'dsh' | 平台标识 |
| `[].displayName` | string | 是 | 否 | 平台显示名 | UI 展示 |
| `[].available` | boolean | 是 | 否 | dsh ACP 就绪状态 | 可执行性 |
| `[].supportsSubagent` | boolean | 是 | 否 | subagentPolicy='auto' 支持度 | 编排能力 |

```json
{ "code": 0, "msg": "success", "data": [ { "provider": "dsh", "displayName": "DeepSeek Harness", "available": true, "supportsSubagent": true } ] }
```

#### 失败响应

- 适用公共异常集：`KANBAN_EXEC_ERROR`
- 无特有异常。

#### 幂等与并发

- 读操作，无幂等要求；返回注册表当前快照。

#### 测试要点

- 成功：'dsh' 已注册 → 列表返回；available 反映 dsh 就绪
- 边界：无注册 provider → 空数组

## 数据库与外部系统影响

> 无数据模型变更（agentSpec/subagentPolicy 已入 B1 schema）；执行记录/selfCheck 字段已入 B1。B4 新增落盘物 = executions log（B1 目录约定）。

### 外部系统

| 系统 | 调用 | 超时 | 重试 | 幂等/结果确认 |
|---|---|---|---|---|
| dsh ACP 子进程 | JSON-RPC over stdio（newSession/prompt/session.cancel/request_permission/agent_message_chunk） | 审批 30s 超时自动 deny（**主进程计时器，deadlineAt 起算**）；心跳超时（B3，maxExecutionIdleMinutes=30） | 通道失败不自动重试（exec-provider-unavailable，用户重试） | session/cancel；requestId 幂等；完成以 ExecutionResult 回传；**子进程意外退出 → failed + exec-provider-unavailable（P2-B4-2）** |
| executions log | 写 `<userData>/kanban/executions/e_<uuid>.log` | — | — | 随卡片删除级联清理（Q-019） |
| B1 store 直调 | 同主进程直调（不经 IPC） | — | — | 幂等见各 IPC |

## 联调与测试场景

| # | 场景 | 前置条件 | 请求/动作 | 预期结果 | 数据与审计结果 | 验收编号 |
|---|---|---|---|---|---|---|
| A1 | ACP 接入成功 | dsh ACP 就绪 + mock/真实 | executeTask → spawn → newSession → prompt → 流式 → 完成 | 连接生命周期完整，execution 记录 startedAt/finishedAt + 列→verify | executions log + system 事件 | CON-R019 |
| A2 | ACP 能力边界 | dsh 就绪 | 流式观察 | 仅 agent_message_chunk（已提交文本）；无推理/工具实时视图 | — | CON-R019 |
| A3 | 审批流批准 | ACP 发 request_permission | onPermissionRequest → approvalRespond{decision:'approve'} | 弹窗触发 → ACP 响应 approve → 执行继续 | timeline"审批 approve"（system,user） | Q-018 |
| A4 | 审批流拒绝 | ACP 发 request_permission | approvalRespond{decision:'deny'} | ACP 响应 deny → 执行按 agent 处理 | timeline"审批 deny" | Q-018 |
| A5 | 审批 30s 超时 | 弹窗无响应 | 等待 >30s | 主进程到 deadlineAt 自动 deny + 关弹窗 + timeline"审批超时自动拒绝" | timeline 留痕；deadlineAt 起算 | Q-018 |
| A6 | 审批 FIFO 多请求 | 3 个并发 request_permission | 依次响应 | queuePosition 1/2/3 正确；先到先响应；互不阻塞 | 多请求按任务平铺 | Q-018 |
| A7 | 审批已响应冲突 | request 已响应/已超时 | 再次 approvalRespond | **exec-approval-not-pending**（提示"审批已处理"） | 不重复响应 ACP | Q-018 |
| A8 | selfCheck true | auto 任务 + mock | 完成注入 passed=true | → succeeded + 列→verify（自动流转 CON-R029） | execution 记录 selfCheck | Q-015 |
| A9 | selfCheck false | auto 任务 + mock | 完成注入 passed=false | → failed | execution 记录 selfCheck | Q-015 |
| A10 | 多 agent provider 切换 | 注册 2 provider | getAgentProviders + agentSpec.provider 解析 | 列表正确；resolve 到对应实现 | — | CON-R030 |
| A11 | subagentPolicy auto/restricted | agentSpec 设置 | auto → dsh 内部可调子 agent（含跨平台）；restricted → 仅 dsh 自身 | 按策略派发 | — | CON-R030 |
| A12 | AC 修订成功 | running auto 任务 | editAcceptanceCriteria（完整 AC） | interrupted + ACP 进程终止 + AC diff timeline + partial 标"已废弃" | previousExecutionId 正确 | CON-R021/Q-022 |
| A13 | AC 修订两选一 | interrupted | ① 以新 AC 重跑（B3 executeTask）② 手动完成（B3 manualComplete） | ①→queued→running（新执行记录）②→succeeded+列→verify | 新 execution 记录 / system 事件 | Q-022 |
| A14 | AC 修订非 running | idle/succeeded 任务 | editAcceptanceCriteria | **exec-not-running**（提示走 B1 updateTask 普通编辑） | 不中断 | CON-R021 |
| A15 | AC 修订缺必填 | running auto 任务 | editAcceptanceCriteria{AC 缺 verify} | **validation-error**（field=verify） | 不中断不落盘 | CON-R018 |
| A16 | dsh 未就绪 | dsh ACP 不可用 | executeTask | **exec-provider-unavailable**（执行通道未就绪提示） | 不 spawn | CON-R019 |
| A17 | 审批计时器归属主进程（P1-B4-1） | pending 审批请求 + **B2 渲染层崩溃** | 等待 >30s（B2 已崩溃） | 主进程仍到 deadlineAt auto-deny + timeline 留痕——agent 不悬挂 | timeline"审批超时自动拒绝" | Q-018 |
| A18 | 重复 register 幂等（P1-B4-2） | 'dsh' 已注册 | 再次 register('dsh', 新 factory) | 覆盖旧 factory + 写日志；resolve/list 以最新为准，不报错 | 注册表单条 'dsh' | CON-R030 |
| A19 | resolve 未注册 provider（P1-B4-2） | registry 无 'other' | getAgentProviders 显示 'other' 或 agentSpec.provider='other' 执行 | getAgentProviders available=false；executeTask → **exec-provider-unavailable** | UI 与执行口径一致 | CON-R030 |
| A20 | 执行中 dsh 崩溃（P2-B4-2） | running 执行中 ACP 子进程意外退出 | 子进程 exit 非 0 / spawn 端到端断开 | 执行 → failed（"执行通道异常"）+ execution 记录 finishedAt 补写 + onExecutionUpdate；重试时 **exec-provider-unavailable**（通道未就绪） | system 事件 + failed 记录 | Q-015 |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| 无 | — | — | — | — |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| B4↔B3 边界 | B4 提供 ACP Provider（B3 `execute()` 默认实现）+ 审批事件 + AC 修订入口；B3 提供调度/状态机/执行控制 IPC——不重复定义状态机与调度 | phper666 | B4 契约 | 已定 |
| approvalRespond 对齐 | B3 已定义 `kanban:approvalRespond` 控制 IPC，B4 审批流消费并补 30s 超时/FIFO/timeline 语义——签名一致不冲突 | phper666 | 本契约 | 已定 |
| 审批计时器归属 | **B4 主进程**持有 pending deadlineAt，B2 只读展示倒计时（P1-B4-1）；壳重启 pending 立即 auto-deny（对齐 B3 Q-017） | phper666 | 本契约 | 已定 |
| AC 修订入口归属 | B4 提供 `kanban:editAcceptanceCriteria`（running 门控）；非 running AC 编辑走 B1 `kanban:updateTask`——B2 按状态分流 | phper666 | B2 契约 | 已定 |
| B2 消费 | B2 消费 onPermissionRequest 弹窗 + approvalRespond + editAcceptanceCriteria 入口 + getAgentProviders agentSpec 选择；IPC channel 前缀 `kanban:`（沿用 B1/B3） | phper666 | B2 契约 | 待定 |
| 错误码对齐 | B4 复用 B3 `KANBAN_EXEC_ERROR`（exec-* 集），不重复定义全集；validation-error/store-not-found 命名对齐 | phper666 | 本契约 | 已定 |
| mock 门控 | 审批/selfCheck 集成测试用 B3 两级 mock 桩（HULL_EXEC_PROVIDER=mock 仅 debug）；真实 dsh 冒烟保留 | phper666 | 本契约 | 已定 |

## 完成记录

> 交付后填写，结果必须有证据。

| 项 | 结果 |
|:---|:-----|
| 交付时间 | — |
| 验证结果 | — |
| 构建/发布 | — |
| 偏差处理 | — |

## 决策与踩坑

- B4 契约形态 = 执行集成契约（同 B1/B3 模式，无 HTTP API 面）：ACP JSON-RPC 帧契约 + 审批/AC 修订 IPC + ProviderRegistry，无 OpenAPI yaml。
- ACP 能力边界（deepwiki 官方事实）：仅已提交文本流式、无会话加载/恢复/列表 → 暂停降级"标记暂停 + 结果丢弃保留现场"（O-11）、壳重启收敛依赖 B3（Q-017）。复用场景：任何 ACP 集成层设计。
- 审批超时策略（Q-018）：30s 超时自动 deny 防 agent 悬挂 + 关弹窗；FIFO 按任务平铺排队（queuePosition）。复用场景：任何"机器请求→人工确认"流。
- 多 agent 注册表先行（CON-R030）：M2 仅 'dsh' 注册，provider 抽象 + 注册表预留 U-002 接入第二平台；subagentPolicy='auto' 时 dsh 作 ACP client 可编排跨平台子 agent。
- selfCheck 判定信号明确可测（Q-015）：不用"无异常即通过"——passed 显式 true/false，false/超时/异常→failed。
- AC 修订边界：editAcceptanceCriteria 仅承接 running 中修订（终止 ACP + interrupted + diff 留痕）；非 running 普通编辑走 B1 updateTask——避免两个入口语义混淆。
- 审批计时器归属主进程（ora-1 修复，P1-B4-1）：pending 请求由 B4 主进程持 deadlineAt 并计时，B2 只读展示倒计时——渲染层崩溃不吃窗口、不悬挂 agent；壳重启 pending 立即 auto-deny（对齐 B3 重启收敛 Q-017）。复用场景：任何"机器请求→人工确认"超时设计。
- ProviderRegistry 失败语义（ora-1 修复，P1-B4-2）：register 幂等（重复注册覆盖 + 日志）；resolve 未注册/就绪失败 → exec-provider-unavailable；getAgentProviders.available 与 executeTask 实际可用口径一致（注册 + 就绪双判）。复用场景：任何可插拔执行平台注册表。
- 执行中 dsh 崩溃（ora-1 修复，P2-B4-2）：ACP 子进程意外退出 → 执行 failed + 记录 finishedAt + 重试时 exec-provider-unavailable；不能挂起不收敛。

## 变更记录

| 时间 | 类型 | 摘要 |
|---|---|---|
| 2026-08-21 | 初次生成 | 基于 t100104（B4）和共识 v1.4（§7.4/§8/§10/§13/§14.1 + Q-015/018/022/024）生成契约草案，构建于 B3 执行引擎契约之上 |
| 2026-08-21 | 复核修复 | ora-1 退回修复：P1-B4-1 审批计时器归属定死主进程（deadlineAt 主进程计算、B2 只读倒计时、B2 崩溃 30s 仍 auto-deny、壳重启 pending 立即 auto-deny 对齐 B3 Q-017）；P1-B4-2 ProviderRegistry 失败语义（register 幂等覆盖+日志、resolve 未注册/就绪失败→exec-provider-unavailable、available 与 executeTask 口径一致）；P2-B4-1 approvalRespond.message→ACP reason 映射；P2-B4-2 执行中 dsh 崩溃→failed+exec-provider-unavailable；P2-B4-3 B2 按状态分流（running→editAcceptanceCriteria，否则→updateTask）注明；测试补 A17~A20 + 改 A5；契约状态改待评审（第二轮复核） |

## 自检记录

- 追踪完整性：PASS（B4→CON-R018/019/021/029/030 + Q-015/017/018/022/024/026→验收，追踪矩阵全覆盖；与 B3 边界不重复；ora-1 修复后补 P1-B4-1/P1-B4-2/P2 追踪）
- OpenAPI 一致性：不适用（本地执行集成契约，无 OpenAPI yaml；ACP JSON-RPC 帧契约 + ExecutionProvider 即字段事实源）
- 示例与错误场景：PASS（20 个联调场景 A1~A20 含成功/失败/边界 + 公共异常集复用 KANBAN_EXEC_ERROR + 审批事件示例）
- 安全与敏感字段：PASS（无敏感字段；DSH_HOME 零接触；审批 message ≤500 字符无敏感数据要求）
- 链接与格式：PASS
