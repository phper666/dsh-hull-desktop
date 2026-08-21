# B4 实现记录与核验记录

> 判级：**复杂**（外部系统集成——dsh ACP 子进程 JSON-RPC over stdio + ProviderRegistry 多 agent 注册表 + 审批流，跨 provider/approval/ipc 多模块，构建于 B3 ExecutionProvider 之上，非 greenfield）
> 事实源：设计 `docs/design/B4-执行集成-m2-kanban-design.md` **frozen v0.2**（251 行，ora-1 有条件通过 → P1-1/P2 补齐后置 frozen，2026-08-21）、契约 `docs/api/feishu-b4-m2-kanban-api-contract.md` v0.2（冻结 495 行，A1~A20，ora-1 第二轮复核通过）、共识 v1.4 + CON-R018/R019/R030（+ CON-R021/R029）

## 实现记录

### 实现路径

B4 全落盘于 B3 已冻结的 `src/exec/` 目录结构（不独立目录）：深化 B3 已有 `ACPProvider`/`JsonRpcClient`（审批事件/selfCheck 回传/帧用例补齐）+ 新增 `ProviderRegistry`/`ApprovalManager`/`AcEditor` + ExecIpc 4 通道（B4 3 invoke/event + getPendingApprovals 快照）+ main 装配 + preload 桥。审批流与 AC 修订执行侧副作用写 timeline 归属 B4（P1-1，复用 B1 store 写原语，不经 IPC，不新增第三写入入口）。

### 文件清单

| 文件 | 职责 | 契约/设计依据 |
|---|---|---|
| `src/exec/provider/ACPProvider.ts`（B3 已有，B4 深化） | ACP 默认实现：spawn dsh ACP（node --expose-internals \<bin\> acp，cwd=DSH_HOME/dsh，复用 M1 spawnArgs）+ 连接生命周期（newSession 30s 超时/prompt/session.cancel/agent_message_chunk=text_chunk/request_permission=permission_request）+ `respondPermission` 回 ACP 审批响应 + selfCheck 回传 + 崩溃→failed（P2-B4-2）+ 恰好一次 onResult | §4.1 / A1/A2/A3/A4/A9/A16/A20 |
| `src/exec/provider/JsonRpcClient.ts`（B3 已有，B4 补帧用例） | JSON-RPC 2.0 over stdio：行分隔帧、id 匹配、通知分发、8KB 截断、坏帧丢弃、dispose reject 全 pending、请求超时 | §4.1 / A24 帧桩 |
| `src/exec/provider/ProviderRegistry.ts`（B4 新增） | 多 agent 注册表：register 幂等（覆盖+日志）/resolve 双判（未注册+isReady 就绪检查→exec-provider-unavailable）/list available 口径一致/subagentPolicy auto/restricted 透传 | §4.4 / CON-R030 / A10/A11/A18/A19 |
| `src/exec/approval/ApprovalManager.ts`（B4 新增） | 审批流：FIFO 队列（queuePosition 连续重排）、deadlineAt 主进程计时（now+30s，P1-B4-1）、approve/deny 回 ACP（message 空省略 reason，P2-B4-1）、30s auto-deny、壳重启 pending 立即 auto-deny（Q-017）、决策写 timeline system 事件（P1-1）、幂等 exec-approval-not-pending | §4.2 / Q-018 / A3~A7/A17 |
| `src/exec/approval/AcEditor.ts`（B4 新增） | AC 修订：P2-B4-3 状态分流（running→中断链路 / 非 running→updateTask 普通编辑）、终止 ACP + interrupted + partial 标"已废弃（AC 修订）" + AC diff 写 timeline system 事件 + 新 AC 落字段 + 竞态复核（终止前仍 running）、缺必填 validation-error | §4.5 / CON-R021 / Q-022 / A12~A15 |
| `src/exec/ipc/ExecIpc.ts`（B4 深化） | B4 3 invoke/event 注册：editAcceptanceCriteria/getAgentProviders/approvalRespond（approvalRespond 列 B3 10 条内，B4 对齐消费）+ getPendingApprovals 快照；统一 {ok,code,message} 包裹 | §4.6 / 契约 §接口清单 |
| `src/exec/ExecutionEngine.ts`（B3，B4 接线） | respondApproval 转发到当前执行句柄（非 running→false）/interruptExecution（scheduler.cancel+interrupted+心跳 stop）/markExecutionDeprecated（execution 记录标废弃，execution 类条目 B3 调度层写权）/extendExecution 心跳 reset | §4.2/§4.5 桥 |
| `src/exec/scheduler/Scheduler.ts`（B3，B4 接线） | 执行句柄扩展 respondPermission（审批响应帧转发）；respondApproval 按 running 句柄派发 | §4.2 桥 |
| `src/main/index.ts` | main 装配：ExecutionEngine（store/providerManager 注入）→ execEngine.start()（壳重启收敛）→ ProviderRegistry 注册 'dsh'（isReady=runtime phase ready，与 executeTask 口径一致 P1-B4-2）→ ApprovalManager（respondApproval 经 engine 转发 + appendSystem timeline 直写 store）+ AcEditor（readStore/mutations/executionBridge/timelineStore 四注入面接线）→ registerExecIpc | P2-1 依赖注入 / P1-1 |
| `src/shared/ipc-channels.ts` | B4 3 channel 补全（KANBAN_B4_EXEC_IPC_CHANNELS：onPermissionRequest/editAcceptanceCriteria/getAgentProviders；approvalRespond 已列 B3）；白名单唯一常量源 18+10+3=31 共面 | B3 P2-5 |
| `src/preload/index.ts` | window.exec 桥：B3 9 invoke + B4 editAcceptanceCriteria/getAgentProviders + onPermissionRequest 订阅 + getPendingApprovals | §4.6 桥 |

### TDD：59 用例（B4 核心路径全测，443 全绿含入）

| 文件 | 用例数 | 覆盖要点 |
|---|---|---|
| JsonRpcClient | 11 | 请求帧（行分隔+id 自增）/id 不匹配+迟到忽略/错误帧 reject/通知分发+退订/坏帧丢弃/半帧缓冲拼接/8KB 截断/通知帧无 id/dispose reject 全 pending/请求超时 |
| ACPProvider | 12 | **spawn 参数复用 M1（node --expose-internals \<bin\> acp，cwd=DSH_HOME/dsh）**/连接生命周期 newSession→running→prompt→完成（恰好一次 onResult，A1）/agent_message_chunk→text_chunk（A2）/request_permission→permission_request（A3/A4）/selfCheck 原样回传（A9，判定归 VerifyGate）/cancel（session/cancel+kill 兜底+结果丢弃，幂等）/崩溃→failed 无悬挂（A20/P2-B4-2）/settle 后丢弃/DSH_HOME 未设→failed（A16，不 spawn）/buildPromptText 三态 |
| ApprovalManager | 12 | **FIFO queuePosition 1/2/3 + 响应重排连续 + 非阻塞**/deadlineAt=now+30s 主进程（P1-B4-1）/approve 回 ACP approved:true+timeline/无 message 省略 reason（P2-B4-1）/deny approved:false+timeline/30s 超时 auto-deny+timeline"审批超时自动拒绝"（A5/A17，B2 崩溃不吃窗口）/超时后重复→exec-approval-not-pending/已响应重复/不存在/decision 非法 validation-error/壳重启 pending 立即 auto-deny（Q-017）/非阻塞队列 3 逐一响应 |
| AcEditor | 6 | 非 running→updateTask 普通编辑（P2-B4-3）/running→终止 ACP+interrupted+partial 标废弃+AC diff 留痕+新 AC 生效（A12）/running 无执行记录仍中断/竞态复核非 running→exec-not-running（A14）/缺必填 validation-error（A15，field 精确）/diff 仅列变化字段 |
| ProviderRegistry | 8 | register+list available 双判（P1-B4-2）/register 幂等覆盖+日志（A18）/resolve 未注册→exec-provider-unavailable（A19）/resolve isReady 失败双判②/subagentPolicy auto/restricted 透传（A11）/空表空数组/缺省默认值/DEFAULT_PROVIDER=dsh |
| ExecutionEngineClose | 10 | ACPProvider.respondPermission 发审批响应帧/respondApproval 转发 running true + 结算 false/extendExecution running 重置 idleResetAt + 非 running exec-not-running/interruptExecution（cancel+interrupted+心跳 stop）/markExecutionDeprecated 标废弃/**ProviderRegistry isReady：runtime ready→available=true / idle→available=false+resolve 抛 exec-provider-unavailable**/Scheduler.respondApproval 转发 |
| ExecIpc（B4 侧，计入 B3 表） | 14 | channel 白名单（B3 10+B4 3=13 全在 ALL_IPC_CHANNELS）/12 invoke 注册（含 getPendingApprovals）/approvalRespond（合法/非法/未接线）/getAgentProviders（接线/空）/editAcceptanceCriteria（接线/未接线 exec-not-running 兜底） |
| ipc-channels | 5 | 白名单计数 18+10+3=31/唯一性/kanban: 前缀/B3 10 完整/B1/B3 交集空 |

> 注：任务预估 B4 用例 23+26=49（ApprovalManager 15/ExecutionEngineClose 11 预估）——实测 ApprovalManager 12、ProviderRegistry 8、ExecutionEngineClose 10（ProviderRegistry/ExecutionEngineClose 已计入 B3 表，B4 侧新增文件 = JsonRpcClient 11 + ACPProvider 12 + ApprovalManager 12 + AcEditor 6 = 41；加上 ProviderRegistry 8 + ExecutionEngineClose 10 = 59）。443 全绿含入，无 B4 专属失败。

### 质量

- `npm run typecheck`（tsc --noEmit）：干净
- `npm test`（test:unit + test:integration）：**443 pass + 8 pass 全绿**（unit 443 / 0 fail ~30s；integration 8 / 0 fail）
- B4 核心用例全绿：ApprovalManager 12 / ACPProvider 12 / AcEditor 6 / JsonRpcClient 11 / ProviderRegistry 8 / ExecutionEngineClose 10

## 核验记录

### 实现偏离（实现 vs 设计蓝图，方案 §8 待填项）

| 偏离 | 设计蓝图 | 实现 | 原因/取舍 |
|---|---|---|---|
| ACP spawn 参数未定子命令签名 | dsh ACP 可执行路径复用 M1 spawnArgs | 约定 `node --expose-internals <bin> acp` + `cwd=${DSH_HOME}/dsh`（与 M1 web 子命令同构；子命令签名未确定，spawn 参数收敛 ACPProvider 单一修改点，官方发布后回归 A1~A7/A17） | 未确定 dsh ACP 子命令签名的约定承载，帧契约单一修改点语义 |
| newSession 超时 | 契约仅"超时→failed"无具体值 | 30s 默认（sendRequest 默认 timeoutMs=30_000 + newSession 独立 30s timer） | 与 JsonRpcClient 请求超时口径一致，未上浮到契约 |
| AcEditor running 路径两选一接线 | §4.5 running 修订 → 重跑/手动完成两选一 | AcEditor 类内不实现两选一；running 路径走 `executionBridge` 接口（cancelExecution/markInterrupted/markExecutionDeprecated 注入），重跑（executeTask）/手动完成（manualComplete）由上层接线时选 | 依赖注入面（design §3 依赖：AcEditor→StateMachine/KanbanStore 桥），两选一接线归 B4Ipc/上层 |
| onPermissionRequest 实时推送未接 engine 事件 | §4.6 onPermissionRequest event 推送 | ApprovalManager.handlePermissionRequest 持 onRequest 回调（B4 内触发）；**ExecIpc 仅注册 getPendingApprovals 快照通道**，permission 事件推送链（permission_request 事件 → ApprovalManager 的接线）与 onExecutionUpdate 状态即时推送同样**首载重放快照模式**（B3 🟢-2 注记延续） | 事件风暴防护（P2-4 节流口径）+ 接线点归上层（B2 消费时接 B4Ipc 推送），与 B3 onExecutionUpdate 首载重放对齐 |

### 核验要点（任务指定）

- **P1-1 timeline 写入归属已落地**：B4 `ApprovalManager`/`AcEditor` 写 **system 事件**（source.type=system，author=system/user，经 main `appendSystem` 直写 B1 store timeline，不经 IPC、不新增第三写入入口）；execution 记录（type=execution）仍仅 B3 调度层写（markExecutionDeprecated 走 execEngine 桥）；与 B1 updateTask 纯数据编辑边界、B3 VerifyGate 判定边界均无重叠
- **桥接 4 处 TODO 收口**：
  1. respondApproval→ACP：`ApprovalManager.respondApproval` 回调 → main 注入 `execEngine.respondApproval` → Scheduler 转发到当前执行句柄 `respondPermission` → ACPProvider 发 session/request_permission 响应帧
  2. AcEditor executionBridge：main 注入 `execEngine.cancel` + `interruptExecution`（interrupted+心跳 stop）+ `markExecutionDeprecated`
  3. extendExecution 心跳 reset：`execEngine.extendExecution` → `heartbeat.reset(taskId)`（running 门控，非 running exec-not-running）
  4. ProviderRegistry isReady→RuntimeManager：registry 注册 `isReady: () => runtime.snapshot().phase === 'ready'`（延迟闭包，runtime 初始化后取；available 与 executeTask 口径一致 P1-B4-2）

### 契约 A 场景覆盖对照（A1~A20 单元级证据）

| 场景 | 契约要求 | 单元级证据 | 状态 |
|---|---|---|---|
| A1 ACP 接入成功 | 连接生命周期完整 + executions log + system 事件 | ACPProvider 连接生命周期（newSession→running→prompt→完成） | 单元级 ✓（真实 dsh spawn 集成待 electron 二进制） |
| A2 ACP 能力边界 | 仅已提交文本流式 | agent_message_chunk→text_chunk（ACPProvider+JsonRpcClient） | ✓ |
| A3 审批流批准 | 弹窗触发→ACP approve→timeline | ApprovalManager approve（回 ACP approved:true + timeline"审批 approve"） | ✓ |
| A4 审批流拒绝 | ACP deny + timeline | ApprovalManager deny | ✓ |
| A5 审批 30s 超时 | 主进程到 deadlineAt auto-deny + timeline"审批超时自动拒绝" | ApprovalManager 30s auto-deny（A5/A17，mock 时钟） | ✓ |
| A6 审批 FIFO 多请求 | queuePosition 1/2/3 互不阻塞 | ApprovalManager FIFO + 非阻塞 | ✓ |
| A7 审批已响应冲突 | exec-approval-not-pending | ApprovalManager 已响应/超时/不存在 3 态幂等 | ✓ |
| A8 selfCheck true | →succeeded+verify | VerifyGate E11（B3）+ ACPProvider selfCheck 原样回传 | ✓ |
| A9 selfCheck false | →failed | ACPProvider selfCheck false 原样回传（判定归 VerifyGate E12） | ✓ |
| A10 多 agent provider 切换 | 列表正确 + resolve 到对应实现 | ProviderRegistry register+list+resolve | ✓ |
| A11 subagentPolicy | auto/restricted 按策略派发 | ProviderRegistry subagentPolicy 透传（auto 默认/restricted） | ✓ |
| A12 AC 修订成功 | interrupted + 终止 + diff 留痕 + partial 标废弃 | AcEditor running 路径（cancel+interrupted+markExecutionDeprecated+buildDiff） | ✓ |
| A13 AC 修订两选一 | 重跑→queued / 手动完成→Verify | 两选一接线归上层（executionBridge 接口注入）；重跑/手动完成语义由 B3 executeTask/manualComplete 承接 | 桥接层 ✓（接线点归 B4Ipc） |
| A14 AC 修订非 running | exec-not-running（走 B1 updateTask） | AcEditor 非 running→updateTask 普通编辑 + 竞态复核 exec-not-running | ✓ |
| A15 AC 修订缺必填 | validation-error（field 精确） | AcEditor 缺必填（what/expected/verify） | ✓ |
| A16 dsh 未就绪 | exec-provider-unavailable，不 spawn | ACPProvider DSH_HOME 未设→failed + ProviderRegistry resolve isReady 失败 | ✓ |
| A17 审批计时器归属主进程 | B2 崩溃 30s 仍 auto-deny | ApprovalManager 主进程计时（P1-B4-1，A5/A17） | ✓ |
| A18 重复 register 幂等 | 覆盖+日志，resolve/list 以最新为准 | ProviderRegistry register 幂等 | ✓ |
| A19 resolve 未注册 | available=false + exec-provider-unavailable 口径一致 | ProviderRegistry resolve 未注册 + isReady 双判 + list available | ✓ |
| A20 执行中 dsh 崩溃 | →failed + finishedAt + 重试 exec-provider-unavailable | ACPProvider 崩溃→failed 无悬挂 + ExecutionEngineClose respondApproval 结算 false | ✓ |

### Code Review

- 未单独跑 B4 专项双席 review（构建于 B3，B3 已双席 review + fix-8 整合；B4 复用 B3 frozen 决策 D1~D5）；B4 实现偏离显式登记（见上表），P1-1/P1-B4-1/P1-B4-2 契约冻结项逐条核验落地（见核验要点），无架构级回 draft 项

### Semgrep

- 未跑（当前环境无 Semgrep 配置，延续 B3 口径）；风险登记由 Code Review + 全量单测兜底（M1 S1 已跑 0 findings）

### 风险登记

- 🟢-3：ACP spawn 子命令签名未确定（约定 `node --expose-internals <bin> acp`）——官方 dsh ACP 子命令发布后需回归 A1~A7/A17，spawn 参数收敛 ACPProvider 单一修改点
- 🟢-4：onPermissionRequest/onExecutionUpdate 事件推送为"首载重放快照"模式（实时推送未接 engine EventEmitter）——B2 接入审批弹窗时需核对 permission 事件→ApprovalManager 接线 + webContents.send 推送点
- 🟡-3：AcEditor 两选一（重跑/手动完成）接线归上层（executionBridge 接口注入）——B4Ipc/上层接线时需保证 interrupted 后两选一不遗漏
- 🟢-5：main `appendSystem` 为 store 内部 timeline 直推（B1 P1-1 ① 层 system 类别）——与 B3 execution 记录写入（② 层）同进程直写 store.data，B1 代码零改动（CON-R004 扩展点语义）
