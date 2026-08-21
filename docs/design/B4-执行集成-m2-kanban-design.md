# B4 执行集成与审批 技术方案

> 工作项：B4 执行集成与审批（飞书 dsh-hull-desktop 清单，t100104）
> 状态：draft（评审通过后置 frozen）
> 版本：0.1 · 2026-08-21
> 事实源：契约 `docs/api/feishu-b4-m2-kanban-api-contract.md` v0.2（冻结）；B3 技术方案 `docs/design/B3-看板-m2-kanban-design.md` v0.2（frozen，技术基础）；共识 `docs/spec/共识-Hull桌面壳-M2看板.md` v1.4（§7.4/§10/§13 + CON-R018/019/030）；PRD `docs/prd/2026-08-19-m2-kanban-prd.md`；M1 方案 `docs/design/S1-壳骨架-m1-design.md`（格式参照）
> 判级：**复杂**。理由：外部系统集成（dsh ACP 子进程 JSON-RPC + ProviderRegistry 多 agent 注册表）跨外部系统与多模块（skill 判级矩阵"外部系统集成"）。**注意：B4 构建于 B3 ExecutionProvider 之上（非 greenfield）**——复用 B3 已冻结决策（D1~D5/模块划分/§4.10），本方案只深化 B4 专属面（ACP 帧契约、审批流、ProviderRegistry、AC 修订）。

---

## 1. 背景与范围

**定位**：B4 交付执行集成与审批——B4 提供 ACP Provider（B3 `execute()` 的默认实现），把 dsh ACP 子进程接到执行引擎上，并承接审批流（permission_request）、selfCheck 判定、多 agent 注册表（ProviderRegistry）、AC 修订入口。**B4 向 B2（UI）暴露审批/AC 修订交互契约**（onPermissionRequest/approvalRespond/editAcceptanceCriteria/getAgentProviders）。

**规则绑定**：CON-R018（auto 需 AC 门控）、CON-R019（执行通道抽象+ACP）、CON-R030（多 agent 平台派发）+ Q-015/018/022/024 + P1-B4-1（审批计时器主进程归属）/P1-B4-2（ProviderRegistry 失败语义）/P2-B4-1~3（reason 映射/dsh 崩溃/状态分流）。

**范围**（契约 §范围，冻结）：
- ACP JSON-RPC stdio 集成：连接生命周期（newSession/prompt/session.cancel/agent_message_chunk/request_permission）、帧契约、dsh 能力边界
- 审批流：deadlineAt 主进程计时 + 非阻塞弹窗 + 回 ACP 响应 + 30s 超时 deny + FIFO + 重启 pending 立即 deny + timeline 留痕
- selfCheck 判定（passed=true→Verify/false→failed）
- ProviderRegistry 多 agent（register 幂等/resolve 双判/available 口径一致）
- AC 修订（editAcceptanceCriteria running 门控 + 终止 ACP + AC diff timeline + 两选一）
- B2 消费接口（onPermissionRequest/approvalRespond/editAcceptanceCriteria/getAgentProviders）

**非目标**：看板 UI（B2）；执行引擎核心——状态机/并行调度/心跳/重启收敛/confirmVerify/执行控制 IPC（B3，B4 构建其上）；看板数据模型/持久化（B1，agentSpec 已入 B1 schema）；导出导入（B5）；插件独立发布（O-5）、任务级 agent 选择 UI（O-10）、多 agent 第二平台落地（U-002，仅注册表先行）。

**交付验收**：契约测试场景 A1~A20（ACP 接入/审批批准拒绝超时 FIFO/selfCheck 两态/多 agent provider 切换/subagentPolicy/AC 修订/dsh 崩溃 + 审批计时器主进程 A17 + 注册表幂等 A18/A19）。

**范围剪裁说明（YAGNI）**：不引 JSON-RPC 库（手写帧编解码，规模小）；不做第二 provider 平台真实实现（U-002，注册表 + 接口预留）；审批弹窗 UI 属 B2（B4 只推事件 + 收响应）；不做 ACP 会话恢复（O-11 定死，B3 pause 已承接）。

---

## 2. 架构决策（含备选）

### D1 ACP 接入：复用 B3 ACPProvider vs B4 独立实现

- **A**：复用 B3 `src/exec/provider/ACPProvider.ts` + `JsonRpcClient.ts`——B4 在 B3 已有子进程 JSON-RPC 骨架上**深化**帧契约（审批事件/selfCheck 回传/心跳复用）
- **B**：B4 独立实现一套 ACP 集成 → **选 A**

理由：B3 已冻结 D2（子进程 JSON-RPC stdio）+ D5（帧桩）决策，且 B3 `ACPProvider` 就是"B3 `execute()` 的默认实现"（B4 契约明确定位）。独立实现 = 重复 spawn/帧编解码/进程管理，且与 B3 心跳（agent_message_chunk 即心跳信号）割裂。B4 深化点：request_permission → 审批事件、ExecutionResult.selfCheck 回传、`HULL_EXEC_PROVIDER=mock` 时回落 MockProvider（B3 ProviderManager 已处理）。

### D2 审批流：主进程 deadlineAt 计时 vs 渲染层计时

- **A**：B4 主进程持 pending 请求 deadlineAt（收到 request_permission + 30s），到点 auto-deny + timeline；B2 只读 deadlineAt 展示倒计时
- **B**：B2 渲染层起 30s 计时器 → **选 A**

理由：契约 P1-B4-1 已冻结（ora-1 修复）——渲染层计时在 B2 崩溃/重绘延迟下永不超时、agent 永久悬挂；主进程计时与执行引擎同生命周期，B2 崩溃不影响 30s 兜底，壳重启 pending 立即 deny 与 B3 重启收敛（Q-017）对齐。

### D3 ProviderRegistry：注册表集中 vs 硬编码 provider

- **A**：`ProviderRegistry`（register/list/resolve）集中管理 provider → factory 映射，register 幂等（覆盖+日志），resolve 双判（注册+就绪）
- **B**：switch/if 硬编码 provider → **选 A**

理由：CON-R030 冻结多 agent 可扩展（provider 字段预留第二平台）；硬编码在 U-002 接入第二平台时需改执行引擎本体，注册表则零改动（B3 ExecutionProvider 接口即扩展点）。register 幂等/resolve 双判/available 口径一致（P1-B4-2）已冻结，注册表是这些语义的唯一落点。

### D4 AC 修订：新 IPC editAcceptanceCriteria vs 复用 updateTask

- **A**：新 IPC `kanban:editAcceptanceCriteria`（running 门控：终止 ACP + interrupted + AC diff + 两选一）
- **B**：复用 B1 `kanban:updateTask` 编辑 AC → **选 A**

理由：契约 Q-022/CON-R021 冻结——running 中编辑 AC = 终止 ACP 进程 + interrupted + partial 标"已废弃" + diff 留痕，这是**执行侧副作用**（B1 updateTask 无此语义，纯数据编辑）；复用 updateTask 会绕过中断/留痕链路。非 running 编辑仍走 B1 updateTask（P2-B4-3 B2 状态分流）。

### D5 JsonRpcClient 帧桩：复用 B3 vs B4 独立

- **A**：复用 B3 `JsonRpcClient` 帧桩（帧编解码验证，B3 D5 决策）
- **B**：B4 独立帧桩 → **选 A**

理由：B3 已冻结 D5"两级桩职责正交"（接口桩测调度/状态机 = B3 主，帧桩测 ACP 编解码 = B4 侧）——帧桩就是为 B4 ACP 实现单测打底；复用同一 JsonRpcClient，B4 只补 request_permission/selfCheck 相关帧用例，不重复实现。

---

## 3. 模块划分

> 构建于 B3 `src/exec/`（frozen 目录结构），B4 深化/新增以下模块，不独立目录。

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `src/exec/provider/ACPProvider.ts`（B3 已有，B4 深化） | ACP 默认实现：spawn dsh + JSON-RPC 帧收发；**深化：request_permission → 审批事件、ExecutionResult.selfCheck 回传** | JsonRpcClient、ProviderRegistry（resolve self） | — |
| `src/exec/provider/JsonRpcClient.ts`（B3 已有，复用） | JSON-RPC over stdio：帧编解码、请求/响应/通知分发、行缓冲 | — | 帧桩（B4 补审批/selfCheck 帧用例） |
| `src/exec/provider/ProviderRegistry.ts`（B4 新增） | 多 agent 注册表：register（幂等覆盖+日志）/list/resolve（注册+就绪双判→exec-provider-unavailable）；subagentPolicy 语义 | ExecutionProvider 接口 | getAgentProviders（数据源） |
| `src/exec/approval/ApprovalManager.ts`（B4 新增） | 审批流：pending 队列（FIFO）、deadlineAt 主进程计时、30s 超时 auto-deny、壳重启 pending 立即 deny、决策写 timeline | ProviderRegistry、JsonRpcClient | onPermissionRequest/approvalRespond |
| `src/exec/ac-editing/AcEditor.ts`（B4 新增） | AC 修订：running 门控、终止 ACP 进程、interrupted + partial 标废弃、AC diff timeline、两选一接线（重跑=executeTask / 手动完成=manualComplete） | StateMachine（B3）、KanbanStore（B1 直调） | editAcceptanceCriteria |
| `src/exec/ipc/B4Ipc.ts`（B4 新增） | B4 IPC 注册：onPermissionRequest（event）/approvalRespond/editAcceptanceCriteria/getAgentProviders；approvalRespond 对齐 B3 ExecIpc | ApprovalManager、AcEditor、ProviderRegistry | 4 条 B4 IPC |
| `src/exec/VerifyGate.ts`（B3，B4 复用） | selfCheck 判定（passed→Verify/false→failed）——B4 消费回传信号 | — | — |

**依赖方向**（单向，无环）：`B4Ipc → {ApprovalManager, AcEditor, ProviderRegistry}`；`ApprovalManager → {ProviderRegistry, JsonRpcClient}`；`AcEditor → {StateMachine, KanbanStore}`；`ACPProvider/ProviderManager（B3）→ JsonRpcClient`；`ProviderManager → {ACPProvider, MockProvider, ProviderRegistry}`。

> **B3↔B4 边界（复用 B3 frozen）**：B4 提供 ACP Provider（B3 `execute()` 默认实现）+ 审批事件 + AC 修订入口；B3 提供调度/状态机/执行控制 IPC（executeTask/cancel/pause/resume/manualComplete/confirmVerify/approvalRespond/extendExecution/getExecutionSnapshot/onExecutionUpdate）+ `KANBAN_EXEC_ERROR`。B4 不重复定义状态机与调度（B4 契约 §协调已定）。KanbanStore 依赖注入（B3 P2-1）与 spawn 参数复用 M1 spawnArgs.ts（B3 P2-3）沿用。

**B4 IPC 边界**（B2 消费）：onPermissionRequest（event）/ approvalRespond / editAcceptanceCriteria / getAgentProviders——channel 集中维护于 `src/shared/ipc-channels.ts`（B3 P2-5 已定，B1/B2/B3/B4 共用 ~32 channel）。

---

## 4. 关键机制实现形态

### 4.1 ACP JSON-RPC 帧契约（连接生命周期）

```
B4 启动 → ProviderRegistry.register('dsh', ACPProviderFactory)
execute() 被 B3 调度调用:
  spawn dsh ACP 子进程（JSON-RPC over stdio，可执行路径复用 M1 spawnArgs.ts，B3 P2-3）
  → newSession(cwd) → { sessionId }
  → prompt(sessionId, text(taskId+AC)) → 流式
  ← agent_message_chunk（仅已提交文本）= B3 心跳信号（Q-026）
  ← session/request_permission { requestId, message } → ApprovalManager 审批事件（§4.2）
  → session/request_permission 响应 { requestId, approved, reason? }（§4.2）
  完成 → ExecutionResult { exitCode, summary, outputPath, selfCheck } → VerifyGate 判定（§4.3）
  取消 → session/cancel（B3 cancelExecution 触发）；无会话 → kill 进程（O-11）
```

- **帧编解码**（`JsonRpcClient`，复用 B3）：行缓冲 + JSON.parse；请求带 id 匹配响应；通知（agent_message_chunk/request_permission）事件分发；单行上限 8KB 截断（防畸形，对齐 B1 写盘防抖口径）
- **能力边界**（deepwiki 官方事实，契约 §ACP 能力边界）：仅已提交文本、无会话恢复/列表、无图片/音频、无推理/工具实时视图——B4 不承诺这些能力

### 4.2 审批流（deadlineAt 主进程计时，P1-B4-1）

```
ACP request_permission 到达 → ApprovalManager:
  pending 入队（FIFO，queuePosition）→ deadlineAt = now + 30s（主进程计算）
  → 推送 onPermissionRequest（含 deadlineAt；B2 只读展示倒计时，不自行计时）
  → 用户决策 → approvalRespond { decision, message? } → 回 ACP { requestId, approved, reason? }
       reason = message 映射（P2-B4-1：message 空则省略 reason，approved 必填）
  → 决策写 timeline（system,user）"审批 {approve/deny}: {message}"
  30s 到点（主进程计时器）→ 自动 deny + timeline"审批超时自动拒绝" + 推送关弹窗
  B2 崩溃 → 主进程计时器照跑，30s 照常 deny（agent 不悬挂）
  壳重启 → pending 立即 auto-deny + timeline（对齐 B3 重启收敛 Q-017）
```

- **计时器归属 = B4 主进程**（契约 P1-B4-1 冻结）：B2 崩溃/重绘延迟不吃窗口；deadlineAt 由主进程计算下发
- **FIFO**：多请求按任务平铺排队（queuePosition 1/2/3…），响应任一不阻塞其他；重复响应 requestId → exec-approval-not-pending
- **弹窗非阻塞**（B2 消费）：不阻断看板操作；已超时请求不再可响应

### 4.3 selfCheck 判定（Q-015）

- ACP 完成回传 `ExecutionResult.selfCheck { passed, evidence? }` → VerifyGate（B3 复用）
- auto：passed=true → succeeded + 列→verify（自动流转 CON-R029）；passed=false / 超时 / 异常 → failed
- manual（无 selfCheck）→ 结果以评论回填（agent 来源，Q-028 只读）+ 列流转手动（不自动推进）
- 不用"无异常即通过"（selfCheck 显式可测）

### 4.4 ProviderRegistry（register 幂等 / resolve 双判 / available 口径一致，P1-B4-2）

- `register(provider, factory)`：**幂等**——同 provider 重复注册 = 覆盖旧 factory + 写日志，不报错；M2 仅 'dsh' 注册
- `resolve(provider)`：**双重判定**——① 未注册（registry 无键）→ exec-provider-unavailable；② 已注册但 factory 就绪检查失败（dsh 不可 spawn）→ 同样 exec-provider-unavailable
- **available 口径一致**：`getAgentProviders[].available` = resolve(provider) 能否通过（注册+就绪双判）——UI 显示 available=false 的 provider，executeTask 必回 exec-provider-unavailable；available=true 仅可能瞬时故障（spawn 竞争），无"显示可用但必然不可用"常态不一致
- `list()`：供 getAgentProviders 快照（ProviderInfo：provider/displayName/available/supportsSubagent）
- **subagentPolicy**（CON-R030）：'auto'（默认，dsh 内部可调子 agent 含跨平台）/ 'restricted'（仅 dsh 自身）——B4 透传 agentSpec 语义，不实现子 agent 编排本身（dsh ACP client 原生能力）

### 4.5 AC 修订（editAcceptanceCriteria running 门控，Q-022）

```
B2 编辑 AC → 查 executionStatus（P2-B4-3 状态分流）:
  running → editAcceptanceCriteria:
    弹窗警示"将中断当前执行"（B2）→ 提交
    → 终止当前 ACP 进程（session/cancel 或 kill）→ 执行 interrupted
    → partial 标"已废弃（AC 修订）" + AC diff 写 timeline（前后对照/时间/操作人，CON-R021）
    → 新 AC 落 Task.acceptanceCriteria（B1 直调 updateTask 字段）
    → 两选一接线: ① 以新 AC 重跑 → B3 executeTask（queued）② 手动完成 → B3 manualComplete（succeeded+verify）
  非 running → B1 kanban:updateTask 普通编辑（不中断、无 diff 要求）
  本接口对非 running 请求统一回 exec-not-running 兜底（双保险）
```

- **running 门控**：仅 running 中 auto 任务可走本接口；重复修订（已 interrupted）→ exec-not-running（不再中断）
- **diff 留痕**：AC 修订写 timeline system 记录（变更前后对照），验证以最新 AC 为准（Q-022）

### 4.6 B2 消费接口（B2 UI 交互契约）

| channel | 方向 | 语义 | 关键返回/错误 |
|---|---|---|---|
| `kanban:onPermissionRequest` | event | 审批请求推送（deadlineAt/queuePosition/title/message）→ B2 非阻塞弹窗 | — |
| `kanban:approvalRespond` | invoke | 审批响应回 ACP（对齐 B3 签名） | exec-approval-not-pending/validation-error |
| `kanban:editAcceptanceCriteria` | invoke | AC 修订（running 门控） | exec-not-running/validation-error |
| `kanban:getAgentProviders` | invoke | provider 列表（agentSpec 选择 UI 数据源） | — |

- preload 桥：channel 集中维护 `src/shared/ipc-channels.ts`（B3 P2-5，B1/B2/B3/B4 ~32 channel 共面），白名单清单唯一常量源

---

## 5. 工程基线

**判级**：复杂（头部一致，非 greenfield——构建于 B3）。

| 项 | 现状 | B4 动作 |
|---|---|---|
| git | ✅（M1 全程 + B3 已进实现管道） | 直接复用 |
| 脚手架 | ✅（package.json：main dist/main/index.js + tsc 构建） | 直接复用，`src/exec/` 扩展 |
| 测试框架 | ✅（node:test 单测/集成 + Playwright e2e，M1 222+8+8 + B3 用例） | 复用——单测 `src/exec/**/*.test.ts`，集成 `tests/integration/`（mock provider 驱动审批/selfCheck），e2e `tests/e2e/` |
| 脚本 | `test:unit`/`test:integration`/`test:e2e`/`typecheck` | 直接复用 |

**技术栈决策**：跟随 M1/B3 既有栈——Electron ^43 + TypeScript（tsc）+ node:test（单测/集成）+ Playwright（e2e），**不引入新框架**（不引 JSON-RPC 库/xstate/队列库，YAGNI）。`HULL_EXEC_PROVIDER=mock` env 门控（B3 已定，B4 审批/selfCheck 集成测试复用 B3 两级 mock）。

---

## 6. 目录/工程结构

```
src/exec/                              # B3 执行引擎（frozen，B4 构建其上）
├── provider/
│   ├── ExecutionProvider.ts           # 抽象接口（B3 已冻结，复用）
│   ├── ACPProvider.ts                 # ACP 默认实现（B3 已有；B4 深化：审批事件/selfCheck 回传）
│   ├── JsonRpcClient.ts               # JSON-RPC stdio（B3 已有；B4 补帧用例）
│   ├── MockProvider.ts                # 接口级内存桩（B3 已冻结，复用）
│   ├── ProviderManager.ts             # mock/真实切换（B3 已冻结，复用）
│   └── ProviderRegistry.ts            # 【B4 新增】多 agent 注册表（register/list/resolve 双判）
├── approval/
│   └── ApprovalManager.ts             # 【B4 新增】审批流（deadlineAt 主进程计时/FIFO/30s deny/重启 deny）
├── ac-editing/
│   └── AcEditor.ts                    # 【B4 新增】AC 修订（running 门控/终止 ACP/AC diff/两选一）
├── ipc/
│   ├── ExecIpc.ts                     # B3 执行控制 IPC（10 条，复用）
│   └── B4Ipc.ts                       # 【B4 新增】onPermissionRequest/approvalRespond/editAcceptanceCriteria/getAgentProviders
├── ExecutionEngine.ts                 # B3 门面（B4 接线：ProviderRegistry 注册 + B4Ipc）
├── Convergence.ts / VerifyGate.ts     # B3（VerifyGate 消费 selfCheck）
├── scheduler/ state-machine/ heartbeat/  # B3（复用）
└── errors.ts                          # KANBAN_EXEC_ERROR（复用）
src/shared/ipc-channels.ts             # 【B3 P2-5】channel 白名单集中维护（B1~B4 ~32 channel）
tests/integration/                     # B4 集成：审批流（mock）/selfCheck/ProviderRegistry（mock provider）
tests/e2e/                             # e2e：审批弹窗主链路（B3+B4+B2 打通）
```

> B4 构建于 B3，不独立目录——`src/exec/` 内新增 approval/、ac-editing/、provider/ProviderRegistry.ts，深化 ACPProvider/JsonRpcClient。preload 桥与 B1/B2/B3 channel 共存（ipc-channels.ts 唯一源）。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| ACP 帧编解码错误（半帧/超长/畸形 JSON） | 帧解析失败/执行悬挂 | JsonRpcClient 行缓冲 + 单行 8KB 截断 + JSON.parse 容错（坏帧丢弃 + 日志 + 心跳超时兜底） | B3+B4 |
| 审批超时悬挂（B2 崩溃/渲染延迟） | agent 永久悬挂 | 主进程 deadlineAt 计时（P1-B4-1）+ 30s 自动 deny + 壳重启 pending 立即 deny | B4 |
| ProviderRegistry 冲突（重复注册/未注册 resolve） | 解析错误/可用性误判 | register 幂等（覆盖+日志）+ resolve 双判（注册+就绪）+ available 与 executeTask 口径一致（P1-B4-2） | B4 |
| AC 修订竞态（编辑与执行完成并发） | 已完成任务被误中断 | running 门控 + 幂等（已 interrupted 再修订 → exec-not-running）+ 终止进程前复核 executionStatus 仍 running | B4 |
| dsh ACP 子进程崩溃 | 执行/审批挂起 | 子进程 exit 非 0/断连 → 执行 failed + 审批 pending 立即 deny + exec-provider-unavailable（P2-B4-2） | B3+B4 |
| ACP 帧协议版本漂移（request_permission 字段变化） | 审批流解析失败 | 帧契约收敛 JsonRpcClient 单一修改点；官方发布后回归 A1~A7/A23 | B4 起持续 |
| 审批高频弹窗（多请求风暴） | UI 阻塞/用户负担 | FIFO 排队 + 非阻塞弹窗 + queuePosition 提示（Q-018）；不做弹窗合并（审批是独立决策，YAGNI） | B4+B2 |

---

## 8. 核验记录（交付核验时填写）

| 项 | 结果 |
|:---|:-----|
| 状态 | draft（评审通过后置 frozen） |
| 评审 | —（待评审，机制 + 日期 + 结论） |
| 实现偏离 | —（实现 vs 方案，交付核验时填） |

> 冻结门：本方案评审通过后，状态置 frozen，方可进实现（skill 纪律：评审不过不得带病进实现）。B4 复用 B3 已冻结决策（D1~D5/模块/§4.10），本方案仅 B4 专属面（ACP 帧契约深化、审批流、ProviderRegistry、AC 修订）。
