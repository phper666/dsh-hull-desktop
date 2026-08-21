# B3 执行引擎与状态机 技术方案

> 工作项：B3 执行引擎与状态机（飞书 dsh-hull-desktop 清单，t100103）
> 状态：draft（评审通过后置 frozen）
> 版本：0.1 · 2026-08-21
> 事实源：契约 `docs/api/feishu-b3-m2-kanban-api-contract.md` v0.2（冻结）；共识 `docs/spec/共识-Hull桌面壳-M2看板.md` v1.4（§5/§10/§13 + CON-R019/021/023/027/029）；PRD `docs/prd/2026-08-19-m2-kanban-prd.md`；M1 方案 `docs/design/S1-壳骨架-m1-design.md`（格式与工程基线参照）
> 判级：**复杂**。理由：状态机 + 并行调度 + ExecutionProvider 抽象 + ACP 外部系统集成（子进程 JSON-RPC）跨多子系统，契约含状态机全迁移矩阵与并行闭环（skill 判级矩阵"状态机 + 外部系统集成"）。

---

## 1. 背景与范围

**定位**：B3 交付看板执行引擎——把任务交给 agent 执行并回写看板。核心 = ExecutionProvider 抽象（默认 ACP / 备选插件 / 兜底 CLI）+ 状态机全迁移矩阵（双轨 executionStatus/columnId）+ 并行调度（maxParallelTasks=3 + 依赖判据 + 失败传播 + 死锁兜底 + 父卡展开）+ 活动心跳超时 + 壳重启收敛 + 执行控制 IPC（B2/B4 消费）。

**规则绑定**：CON-R019（执行通道抽象+ACP）、CON-R021（执行中修订 AC）、CON-R023（并行进 M2）、CON-R027（串行优先+无依赖并行）、CON-R029（结果回写）、CON-R032（心跳超时）+ Q-013/015/016/017/022/023/024/025/026。

**范围**（契约 §范围，冻结）：
- ExecutionProvider 抽象接口 + ACP 默认实现 + 两级 mock 桩
- 状态机全迁移矩阵（8 态 + Verify/Done 列轨 + 系统收敛）
- 并行调度（maxParallelTasks=3 + 依赖判据 + 失败传播 + 死锁兜底 + 父卡展开）
- 心跳超时（maxExecutionIdleMinutes=30 连续无活动）
- 壳重启收敛（running/paused/interrupted→failed + queued 重跑就绪检查）
- selfCheck 判定、confirmVerify（Verify→done 把关）、pause O-11（kill 进程+恢复重新执行）
- 执行控制 IPC 10 条（executeTask/cancel/pause/resume/manualComplete/confirmVerify/approvalRespond/extendExecution/getExecutionSnapshot/onExecutionUpdate）

**非目标**（契约 §非目标）：ACP 真实接入/审批弹窗 UI/agent 会话管理（B4，B3 仅提供控制 IPC）；看板 UI（B2）；数据模型/持久化（B1，B3 直调 store）；导出导入（B5）；插件独立发布（O-5）、任务级 agent 选择 UI（O-10）、依赖图可视化（U-003）、多 agent 第二平台落地（U-002）。

**交付验收**：契约测试场景 E1~E30（状态机迁移/并行/依赖/失败传播/死锁/重启收敛/心跳/selfCheck/父卡展开/confirmVerify/mock 桩）。

**范围剪裁说明（YAGNI）**：不引状态机库/队列库；AC 真伪环检测留 P2（Q-014）；依赖图可视化排后（U-003）；心跳窗口定时器不做持久化（重启收敛即清）。

---

## 2. 架构决策（含备选）

### D1 ExecutionProvider 抽象：接口注入 vs 直接 ACP 耦合

- **A**：定义 `ExecutionProvider` 接口（execute + handlers + cancel），ACP/插件/CLI 各自实现，引擎侧依赖接口
- **B**：引擎直接调 ACP 具体实现 → **选 A**

理由：契约 CON-R019 冻结抽象层，PRD §7.4 明确"换实现零数据改动"；B4 依赖此接口做多 agent 注册表（CON-R030，provider 字段扩展第二平台），直接耦合 ACP 会让 B4 无法插拔。代价：接口定义一次，ACP/CLI 两实现。

### D2 ACP 接入：子进程 JSON-RPC stdio vs 内嵌库

- **A**：壳 spawn dsh ACP 子进程，JSON-RPC over stdio（newSession/prompt/session.cancel/agent_message_chunk/request_permission）
- **B**：内嵌 dsh 库进程内调用 → **选 A**

理由：dsh 官方 ACP host 即子进程形态（共识 §10，deepwiki 官方事实）；内嵌库破坏壳/dsh 边界（CON-R001 纯壳、零注入官方），且 dsh 无官方可内嵌 JS 库。子进程形态与 M1 RuntimeManager spawn dsh 同构（复用进程管理经验）。

### D3 状态机实现：手写 switch/迁移表 vs 状态机库（xstate）

- **A**：手写——`executionStatus` 字段 + `TRANSITIONS` 迁移表 + 非法迁移 dev throw/prod log，EventEmitter 事件
- **B**：xstate 等状态机库 → **选 A**

理由：契约冻结 8 态 + Verify/Done 列轨双轨解耦（Q-013），迁移矩阵明确可落为表驱动；M1 S1 已有手写状态机先例（RuntimeManager phase + 迁移表，D7 同款决策）。xstate 引入重依赖，8 态矩阵不值得；且**执行态与列轨双独立持久化**，xstate 无法表达"列迁移不改执行态"的跨轨道约束（需外部联动，手写更直接）。

### D4 并行调度：自实现调度器 vs 引入队列库

- **A**：自实现——按依赖拓扑分批（就绪集入并行池，并发 ≤3），scheduler 直调 provider + store
- **B**：bull/queue 等队列库 → **选 A**

理由：调度规模 = 单看板子任务并行 ≤3，依赖判据（succeeded/manual 按列 Done）+ 失败传播 + 死锁兜底是**看板业务逻辑**，队列库不承载业务依赖判据，仍需包一层；自实现约 200 行（拓扑分批 + 池计数），YAGNI 不引库。限制天花板：无持久化队列/崩溃恢复（重启收敛即兜底，见 §4.4），多机/跨进程调度不做（M2 单进程桌面）。

### D5 mock 桩：接口级内存桩 vs 协议级帧桩

- **A**：两级都做——① 接口级内存桩（实现 ExecutionProvider，确定性事件注入 + 可控延迟）② ACP 帧协议桩（仅验证 JSON-RPC 帧编解码）
- **B**：只做接口桩 → **选 A（两级）**

理由：契约 Q-024 冻结两级；接口桩测调度/状态机（B3 主），帧桩测 ACP 实现编解码（B4 侧）；职责正交（①不依赖②、②不替代①，P2-B3-3 已注明）。帧桩成本低（一个帧编解码测试文件），为 B4 的 ACP 实现单测打底。

---

## 3. 模块划分

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `src/exec/ExecutionEngine.ts` | 执行引擎门面：入口分发（executeTask 父卡展开/单任务）、编排调度/状态机/心跳/收敛、执行控制 IPC 注册与桥接 | Scheduler、StateMachine、HeartbeatMonitor、ProviderManager、KanbanStore | 全部 IPC |
| `src/exec/provider/ExecutionProvider.ts` | ExecutionProvider 抽象接口（TS 契约：execute/handlers/cancel）+ ProviderStatus/ExecutionEvent/ExecutionResult 类型 | —（纯类型） | ExecutionProvider 接口 |
| `src/exec/provider/ACPProvider.ts` | ACP 默认实现：spawn dsh 子进程 + JSON-RPC 帧编解码（newSession/prompt/session.cancel/agent_message_chunk/request_permission） | JsonRpcClient | — |
| `src/exec/provider/JsonRpcClient.ts` | JSON-RPC over stdio 客户端：帧编解码、请求/响应/通知分发、stdout/stderr 行缓冲 | — | — |
| `src/exec/provider/MockProvider.ts` | 接口级内存桩：确定性事件注入（权限/超时/cancel/流式/selfCheck false）+ 可控延迟（resolve 前 hold N ms，P2-B3-1） | — | — |
| `src/exec/provider/ProviderManager.ts` | 两级桩/真实 provider 切换（`HULL_EXEC_PROVIDER=mock` 仅 debug）+ provider 生命周期 | ProviderRegistry（B4 消费） | — |
| `src/exec/scheduler/Scheduler.ts` | 并行调度：拓扑分批就绪集、并行池（≤3）、依赖判据、失败传播、死锁兜底、父卡展开 | StateMachine、KanbanStore | — |
| `src/exec/state-machine/StateMachine.ts` | 执行态 8 态迁移表驱动 + 非法迁移防护 + 事件 emit | — | — |
| `src/exec/state-machine/transitions.ts` | 迁移表常量（执行态轨道 + 列轨道 + 系统收敛，契约 §状态转换） | — | — |
| `src/exec/heartbeat/HeartbeatMonitor.ts` | 活动心跳：agent_message_chunk 重置 idle 计时器；连续 maxExecutionIdleMinutes 无活动 → failed + kill 进程 | StateMachine、ACPProvider | — |
| `src/exec/Convergence.ts` | 壳重启收敛：running/paused/interrupted→failed + queued 重跑就绪检查 + 全量依赖重算 | StateMachine、Scheduler | — |
| `src/exec/VerifyGate.ts` | confirmVerify（verify 列→done）+ manualComplete（interrupted/failed→succeeded+verify）+ selfCheck 判定 | StateMachine、KanbanStore | confirmVerify/manualComplete |
| `src/exec/ipc/ExecIpc.ts` | 执行控制 IPC channel 注册（10 条）+ preload 桥 | ExecutionEngine | 全部 IPC |
| `src/exec/errors.ts` | KANBAN_EXEC_ERROR 具名错误（exec-* 集，kebab 对齐 B1） | — | — |

**依赖方向**（单向，无环）：`ExecIpc → ExecutionEngine → {Scheduler, StateMachine, HeartbeatMonitor, VerifyGate, Convergence, ProviderManager, KanbanStore}`；`Scheduler → {StateMachine, KanbanStore, ProviderManager}`；`ProviderManager → {ACPProvider, MockProvider}`；`ACPProvider → JsonRpcClient`。

> **B3↔B1 直调**：ExecutionEngine/Scheduler 直调 B1 store（同主进程，不经 IPC）——写 execution 记录、executionStatus/currentExecutionId、moveTask（列流转）、system 事件；B1 updateTask 不写执行态（B1 契约约束）。**B3↔B4**：B4 提供 ACP Provider（B3 `execute()` 默认实现）+ 审批事件 + AC 修订入口；B3 提供控制 IPC 与 `KANBAN_EXEC_ERROR`。

**执行控制 IPC 边界**（B2/B4 消费）：executeTask（父卡展开）/cancel/pause/resume/manualComplete/confirmVerify/approvalRespond/extendExecution/getExecutionSnapshot（invoke）+ onExecutionUpdate（event）。

---

## 4. 关键机制实现形态

### 4.1 状态机（8 态 + 双轨）

```
idle → queued → running → succeeded → Verify（列轨 verify）→ Done（列轨 done）
               ├→ paused（O-11：kill 进程+结果丢弃）→ running（恢复=重新执行）
               ├→ interrupted（AC 修订）→ queued（重跑）/ succeeded→verify（手动完成）
               ├→ cancelled
               └→ failed → queued（重试）
```

- `StateMachine`：`executionStatus` 私有字段 + `TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]>` 迁移表（契约 §执行态轨道 18 行）+ 非法迁移 dev throw / prod log 忽略（复用 M1 D7 模式）；`on('status', cb)` 事件 → `onExecutionUpdate` 推送源
- **双轨解耦（Q-013）**：executionStatus 与 columnId 独立持久化、独立流转——状态机只写 executionStatus；列迁移走 B1 `moveTask`（改 columnId 不改执行态）；Verify/Done 是**列轨**（columnId type=verify/done），**不在** 8 态枚举内
- `transitions.ts` 常量 = 契约矩阵机器可读形态，单测对着表测非法迁移

### 4.2 并行调度（maxParallelTasks=3 + 依赖 + 失败传播 + 死锁 + 父卡展开）

```
executeTask(taskId):
  task 为子任务 → 单任务入队 queued
  task 为父卡 → 展开：逐子任务判「就绪」（①auto AC 完整 ②依赖判据满足 ③非 running/queued）
               就绪 → queued 入调度队列；未就绪 → skipped（返回 enqueued[]/skipped[]，P0-B3-1）

Scheduler 主循环:
  while 并行池 running 数 < maxParallelTasks(3):
    就绪集 = 队列中 依赖满足 的子任务（依赖判据：被依赖 executionStatus==succeeded；
             manual 子任务作依赖 → 按列 Done 判，防死锁 Q-016）
    无就绪且仍有 queued → 死锁兜底：停止批处理 + 父 failed（"依赖无法满足/疑似循环"）
    从就绪集取任务 → provider.execute()（ACP spawn）→ running
  完成任务 → succeeded/failed → 释放池位 → 重算就绪集（后置依赖 startedAt ≥ 前驱 finishedAt，Q-025 时序断言）

失败传播: 被依赖 failed → 直接依赖方 queued → failed（"依赖失败"，可重试）
父卡派生态（不持久化）: 任一子 running/queued→父 running/queued；流水线失败→父 failed；
                         全 succeeded→父 succeeded；父 currentExecutionId 恒空（Q-016）
```

- **并行观测（Q-025）**：执行开始即写 execution 记录（startedAt），完成补 finishedAt；`getExecutionSnapshot` + `onExecutionUpdate.parallel`（running=实际执行数≤3 不含 paused、queued=排队数、父子不重复计，P2-B3-2）供双界断言（≥2 且 ≤3）
- **单卡单执行守卫**：exec-state-conflict（running/queued 中重复 executeTask）

### 4.3 心跳超时（maxExecutionIdleMinutes=30 连续无活动）

- `HeartbeatMonitor`：running 任务绑定 idle 计时器（30min，SettingsProvider 可配）；`agent_message_chunk` 流式事件 = 活动心跳 → 重置计时器（**非总时长**——持续输出长任务不超时，Q-026）
- 计时器到点 → `failed("疑似卡死")` + kill ACP 进程 + `exec-timeout-heartbeat` 回写 failed 记录
- `extendExecution`：用户手动重置 idle 窗口（idleResetAt）
- 计时器仅内存态，不持久化（壳重启由收敛兜底）

### 4.4 壳重启收敛（Q-017）

```
壳启动 → Convergence.run():
  1. running/paused/interrupted → failed（"壳重启进程中断"）+ 补 finishedAt + 清 currentExecutionId + system 事件
  2. queued → 重跑就绪检查：依赖已收敛 failed → 转 failed（"依赖失败"）；仍满足 → 保留重调度 + system 事件"已重新排队"
  3. 全量收敛后 → 统一触发依赖重算（Scheduler 重算父卡派生态）
```

- 收敛在 KanbanStore 加载完成后、IPC 就绪前执行（防 UI 读到未收敛态）
- 幂等：重复收敛对已 failed 任务无操作

### 4.5 confirmVerify（Verify→done 把关，CON-R028）

- `confirmVerify(boardId, taskId)`：仅 columnId=verify 列可确认 → moveTask 到 done 列；executionStatus 保持 succeeded（双轨不改执行态）；非 verify 列 → validation-error
- 双路径到 done：confirmVerify（把关通过）/ moveTask 到 done（人工拖拽，未执行完成走确认弹窗强制通过）；manualComplete/自验通过均止步 verify，人工确认才 done——不绕过把关

### 4.6 pause O-11（kill 进程 + 结果丢弃 + 恢复重新执行）

- `pauseExecution`：kill ACP 进程 + 结果丢弃（partial 标"已废弃（暂停）"）+ 标记 paused + 补 finishedAt + previousExecutionId（P1-B3-3）
- `resumeExecution`：**重新执行**——重新 spawn ACP + newSession + prompt，新 execution 记录（newExecutionId）（O-11 无会话恢复，不承诺"从现场继续"）
- 与 cancel 区分：paused 保留任务态可恢复；cancelled 终止不可恢复

### 4.7 selfCheck 判定（Q-015）

- ACP 完成回传 `ExecutionResult.selfCheck { passed, evidence? }`
- auto：passed=true → succeeded + 列→verify（自动流转 CON-R029）；passed=false / 超时 / 异常 → failed
- manual（无 selfCheck）→ 结果以评论回填（agent 来源，Q-028 只读）+ 列流转手动（不自动推进）
- 不用"无异常即通过"（selfCheck 显式可测）

### 4.8 执行控制 IPC（B2/B4 消费）

| channel | 语义 | 关键返回/错误 |
|---|---|---|
| `kanban:executeTask` | 执行/重跑/父卡展开 | kind single/parent_expand + enqueued[]/skipped[]；exec-state-conflict/validation-error/exec-provider-unavailable |
| `kanban:cancelExecution` | 取消 queued/running/paused | exec-not-cancellable |
| `kanban:pauseExecution` | 暂停 running（kill 进程） | paused + previousExecutionId；exec-not-running |
| `kanban:resumeExecution` | 恢复 paused（重新执行） | running + newExecutionId；exec-not-paused |
| `kanban:manualComplete` | interrupted/failed→succeeded+verify | exec-not-completable |
| `kanban:confirmVerify` | verify→done 把关 | validation-error（非 verify 列） |
| `kanban:approvalRespond` | 审批响应（B4 消费，对齐签名） | exec-approval-not-pending |
| `kanban:extendExecution` | 重置心跳窗口 | exec-not-running |
| `kanban:getExecutionSnapshot` | 执行池快照 | running/queued/maxParallel |
| `kanban:onExecutionUpdate`（event） | 状态/并行池/审批/心跳/收敛推送 | — |

- 错误码统一 `KANBAN_EXEC_ERROR`（exec-* 集，errors.ts 具名错误，kebab 对齐 B1）
- preload 桥：主进程注册 + preload contextBridge 暴露（复用 M1 preload 模式，白名单 channel）

### 4.9 两级 mock 桩（Q-024）

- ① `MockProvider`：实现 ExecutionProvider；确定性事件注入（权限/超时/cancel/流式/selfCheck false）+ 可控延迟（hold N ms 保证并行峰值 ≥2，P2-B3-1）
- ② `JsonRpcClient` 帧桩：仅验证 JSON-RPC 帧编解码（newSession/prompt/session.cancel 出入帧）
- `HULL_EXEC_PROVIDER=mock` 仅 debug/test 生效；生产忽略回落 ACP（ProviderManager 判定）

---

## 5. 工程基线

**判级**：复杂（头部一致）。

| 项 | 现状 | B3 动作 |
|---|---|---|
| git | ✅（M1 全程使用） | 直接复用 |
| 脚手架 | ✅（package.json：main dist/main/index.js + tsc 构建） | 直接复用，`src/exec/` 新增模块 |
| 测试框架 | ✅（node:test 单测/集成 + Playwright e2e，M1 已有 222+8+8 用例） | 复用——单测 `src/exec/**/*.test.ts`（同目录 co-located，node:test），集成 `tests/integration/`，e2e `tests/e2e/` |
| 脚本 | `test:unit`/`test:integration`/`test:e2e`/`typecheck` | 直接复用 |

**技术栈决策**：跟随 M1 既有栈——Electron ^43 + TypeScript（tsc 编译 dist）+ node:test（单测/集成）+ Playwright（e2e），**不引入新框架**（不引状态机库/队列库/xstate/vitest，YAGNI）。`HULL_EXEC_PROVIDER` env 注入 mock（复用 M1 env 注入先例 HULL_PROBE_TARGET）。

---

## 6. 目录/工程结构

```
src/
├── exec/                          # B3 执行引擎（新增）
│   ├── ExecutionEngine.ts         # 门面：入口分发 + 编排 + IPC 桥
│   ├── Convergence.ts             # 壳重启收敛
│   ├── VerifyGate.ts              # confirmVerify/manualComplete/selfCheck 判定
│   ├── errors.ts                  # KANBAN_EXEC_ERROR（exec-* 集）
│   ├── provider/
│   │   ├── ExecutionProvider.ts   # 抽象接口 + 类型（TS 契约）
│   │   ├── ACPProvider.ts         # ACP 默认实现
│   │   ├── JsonRpcClient.ts       # JSON-RPC stdio 客户端 + 帧桩
│   │   ├── MockProvider.ts        # 接口级内存桩（确定性事件 + 可控延迟）
│   │   └── ProviderManager.ts     # mock/真实切换（HULL_EXEC_PROVIDER）
│   ├── scheduler/
│   │   └── Scheduler.ts           # 并行调度（拓扑分批/依赖/失败传播/死锁/父卡展开）
│   ├── state-machine/
│   │   ├── StateMachine.ts        # 8 态迁移表驱动 + 事件
│   │   └── transitions.ts         # 迁移表常量（契约矩阵机器可读）
│   ├── heartbeat/
│   │   └── HeartbeatMonitor.ts    # 活动心跳（30min 连续无活动）
│   └── ipc/
│       └── ExecIpc.ts             # 执行控制 IPC 注册（10 条）
├── main/index.ts                  # app 生命周期：加载 store → 重启收敛 → 注册 ExecIpc
├── preload/index.ts               # 扩展执行控制 channel（白名单）
└── shared/
    ├── types.ts                   # 扩展 Task/ExecutionRecord 相关类型（引用 B1）
    └── errors.ts                  # 扩展 KANBAN_EXEC_ERROR
tests/
├── integration/                   # 集成：调度/收敛/心跳（mock provider 驱动）
└── e2e/                           # e2e：执行主链路（B3+B1+B2 打通）
```

> 执行控制 IPC 的 preload 桥与 B1 channel 共存于同一 preload（B2/B3/B4 消费同一桥，协调已定）。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| ACP 仅已提交文本/无推理/工具实时视图 | 用户不可见中间过程 | 契约能力边界明确（§ACP 能力）；流式 text_chunk 作心跳与进度信号；B4 审批流承接 request_permission | B3+B4 |
| ACP 无会话恢复（O-11） | 暂停/重启无法续跑现场 | pause=kill+结果丢弃+恢复重新执行（P1-B3-3 定死）；重启收敛（Q-017）兜底 | B3 |
| dsh ACP 子进程意外崩溃 | 执行挂起不收敛 | exit 非 0/断连 → 执行 failed + finishedAt 补写 + exec-provider-unavailable；心跳超时兜底 | B3+B4 |
| 并行竞态（依赖判据/池位释放） | 超过 maxParallel 或依赖违反 | 调度单线程主循环（Node 单进程）+ 就绪集判定原子化；Q-025 时序断言（后置 startedAt ≥ 前驱 finishedAt）守护 | B3 |
| 心跳误判（持续输出任务被超时） | 长任务误杀 | 活动心跳语义：agent_message_chunk 重置计时器，非总时长；extendExecution 手动延长 | B3 |
| 重启收敛数据一致性（半写执行记录） | 记录不完整 | 收敛补 finishedAt + 清 currentExecutionId + system 事件；幂等收敛；收敛在 IPC 就绪前执行 | B3 |
| 父卡展开语义误判（就绪判定） | 漏执行/重复执行 | 就绪三判（AC/依赖/非 running-queued）逐子任务独立；skipped[] 旁路可见 | B3 |
| 状态机非法迁移 | 状态脏 | 迁移表驱动 + dev throw/prod log（复用 M1 D7） | B3 |

---

## 8. 核验记录（交付核验时填写）

| 项 | 结果 |
|:---|:-----|
| 状态 | draft（评审通过后置 frozen） |
| 评审 | —（待评审，机制 + 日期 + 结论） |
| 实现偏离 | —（实现 vs 方案，交付核验时填） |

> 冻结门：本方案评审通过后，状态置 frozen，方可进实现（skill 纪律：评审不过不得带病进实现）。
