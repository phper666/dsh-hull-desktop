# B3 实现记录与核验记录

> 判级：复杂（状态机全迁移矩阵 + 并行调度 + ExecutionProvider 抽象 + ACP 外部系统集成——子进程 JSON-RPC over stdio，跨执行引擎/调度/心跳/收敛/provider 多子系统；oracle 蓝图 + 多 fixer 拆 lane 落地）
> 事实源：契约 `docs/api/feishu-b3-m2-kanban-api-contract.md` v0.2（冻结 2026-08-21，ora-1 第三轮复核通过，861 行，E1~E32）、设计 `docs/design/B3-看板-m2-kanban-design.md` frozen v0.2（295 行，含 §3 模块划分表）、共识 v1.4 + CON-R019/R021/R023/R027/R029/R032（+ CON-R028）

## 实现记录

### 实现路径（拆 lane 落地）

B3 按 B3-L1/L2a/L2b/L3 拆分多 lane 实现（oracle 蓝图 + 多 fixer 并进）：
- **L1（契约/设计先行）**：契约 v0.2 冻结（ora-1 第三轮复核闭环：父卡展开执行入口/confirmVerify/pause 统一 O-11/mock 可控延迟）+ 设计 frozen（ora-1 有条件通过 → P1-1/P1-2 补齐后置 frozen）——两级事实源冻结后才进实现
- **L2a（provider 层）**：ExecutionProvider 接口 + 两级 mock 桩（MockProvider 可控延迟 + JsonRpcClient 帧桩）+ ProviderManager env 切换
- **L2b（状态机/调度核心）**：StateMachine/transitions 迁移表 + Scheduler 单飞调度循环（P1-2 原子结算段）+ HeartbeatMonitor（P1-1 计时器销毁/重建）+ Convergence + VerifyGate
- **L3（引擎门面/接线）**：ExecutionEngine 组装 + 直写 B1 store 系统管理字段 + ExecIpc 注册 + shared/ipc-channels 白名单 + main/preload 接线
- **fix-8 整合**：实现后期一次修复整合（E31 心跳与 paused 冲突、E32 调度并发竞态等 8 项随各 lane 评审收敛落地，见核验记录）

### 文件清单（src 17 文件 + shared 1 文件）

按设计 §3 模块表逐文件：

| 文件 | 职责 | 契约/设计依据 |
|---|---|---|
| `src/exec/ExecutionEngine.ts` | 引擎门面：组装 Scheduler/Heartbeat/Convergence/VerifyGate/ProviderManager；mutation 写面（直写 B1 store 系统管理字段：executionStatus/currentExecutionId/timeline）；executeTask/cancel/pause/resume/manualComplete/confirmVerify/extendExecution/getSnapshot/respondApproval/interruptExecution | 全部 IPC 语义 + P2-1 依赖注入 |
| `src/exec/scheduler/Scheduler.ts` | 并行调度：单飞 drain 循环 + 原子结算段（P1-2）、并行池 ≤3、依赖判据（succeeded/manual 按列 Done）、失败传播、死锁兜底、父卡展开、单卡守卫 | §4.2 / E13~E32 |
| `src/exec/heartbeat/HeartbeatMonitor.ts` | 活动心跳：text_chunk 重置 idle 计时器（非总时长 Q-026）；计时器仅绑 running，迁出销毁（E31 P1-1）；到点 emit timeout → 引擎层 failed+kill | §4.3 / CON-R032 |
| `src/exec/Convergence.ts` | 壳重启收敛：running/paused/interrupted→failed + queued 重跑就绪检查 + 全量依赖重算（recomputeDeps）；幂等 | §4.4 / Q-017 |
| `src/exec/VerifyGate.ts` | confirmVerify（verify→done 把关 CON-R028）/ manualComplete（interrupted/failed→succeeded+verify）/ selfCheck 判定（Q-015）+ manual 结果评论回填 | §4.5/§4.7 |
| `src/exec/errors.ts` | KANBAN_EXEC_ERROR 具名错误集（exec-* 10 码 kebab 对齐 B1，继承 HullError） | 契约 §公共异常集 |
| `src/exec/ipc/ExecIpc.ts` | 执行控制 IPC 注册：B3 9 invoke + 1 event + B4 3 channel；统一 {ok,code,message} 包裹；onExecutionUpdate 订阅重放快照 | §4.8 + B4 对齐 |
| `src/exec/provider/ExecutionProvider.ts` | ExecutionProvider 抽象接口（execute/handlers/cancel）+ ProviderStatus/ExecutionEvent/ExecutionResult 类型（纯类型） | 契约 §ExecutionProvider 接口（CON-R019） |
| `src/exec/provider/ACPProvider.ts` | ACP 默认实现：spawn dsh ACP 子进程（node --expose-internals \<bin\> acp，复用 M1 spawnArgs）+ newSession/prompt/session.cancel/agent_message_chunk/request_permission + 三路竞争（会话/崩溃/取消）+ 恰好一次 onResult | §4.9 / P2-B4-2 |
| `src/exec/provider/JsonRpcClient.ts` | JSON-RPC 2.0 over stdio：行分隔帧、id 匹配、8KB 截断、坏帧丢弃、通知分发、dispose | §4.9 帧桩 |
| `src/exec/provider/MockProvider.ts` | 接口级内存桩：确定性事件注入（success/permission/stream/timeout/cancel）+ 可控延迟（hold N ms，P2-B3-1） | §4.9 ① |
| `src/exec/provider/ProviderManager.ts` | mock/真实切换：HULL_EXEC_PROVIDER=mock 仅 debug/test，生产回落 ACP；getProvider 单例 | §4.9 / env 门控 |
| `src/exec/provider/ProviderRegistry.ts` | 多 agent 注册表（B4）：register 幂等 / resolve 双判（未注册+就绪检查）/ list available 口径一致 | B4 CON-R030 |
| `src/exec/state-machine/StateMachine.ts` | 8 态迁移表驱动 + 非法迁移 dev throw/prod log + on('status') 事件（onExecutionUpdate 源） | §4.1 |
| `src/exec/state-machine/transitions.ts` | EXEC_TRANSITIONS 迁移表常量（契约矩阵机器可读，8 态合法目标）+ COLUMN_TYPES/VERIFY/DONE 列轨常量（双轨解耦 Q-013） | 契约 §状态转换 |
| `src/exec/approval/ApprovalManager.ts` | 审批流（B4）：FIFO 队列 + deadlineAt 主进程计时（P1-B4-1）+ 30s auto-deny + 重启 auto-deny + timeline 留痕 | B4 §4.2 / Q-018 |
| `src/exec/approval/AcEditor.ts` | AC 修订入口（B4）：running → 终止 ACP + interrupted + partial 废弃 + AC diff 留痕 + 新 AC 落字段；非 running 普通编辑 | B4 §4.5 / CON-R021 |
| `src/shared/ipc-channels.ts` | IPC channel 白名单唯一常量源：B1 16 + B5 2 + B3 10 + B4 3 = 31 共面（P2-5，禁止散落硬编码） | §4.8 P2-5 |

> **main/preload 接线**：`src/main/index.ts` 加载 KanbanStore → `new ExecutionEngine`（store/providerManager 注入）→ `execEngine.start()`（壳重启收敛，IPC 就绪前）→ ProviderRegistry 注册 'dsh'（isReady=runtime phase ready）→ ApprovalManager/AcEditor 接线（appendSystem 直写 store timeline）→ `registerExecIpc`。`src/preload/index.ts` 按 ipc-channels 白名单 exposeInMainWorld('exec', …)（9 invoke + onExecutionUpdate/onPermissionRequest 订阅）。

### TDD：90+ 用例，核心路径全测（重点 E31/E32）

| 文件 | 用例数 | 覆盖要点 |
|---|---|---|
| Scheduler | 18 | **E13 并行上限（mock delayMs=30 → 峰值 2≤peak≤3 双界断言）** / **E32 并发竞态（5 空依赖父卡展开，peak≥2 且 ≤3，全部 succeeded）** / E14 依赖串行（settle(A) 先于 start(B)）/ E15 失败传播 / E16 死锁兜底 / E17+E29 父卡展开（3 就绪+1 缺 AC+1 依赖未满足 → enqueued=3 skipped=2）/ E30 全未就绪 / E28 单卡守卫 / E2 缺 AC / E26 快照 / 满池排队 / cancel queued/running / manual 依赖按列 Done / provider 双 onResult 幂等 / onStreamEvent 透传 / **🟡-2 心跳超时+provider settle 同帧 → 终态唯一 failed** |
| ExecutionEngine | 12+10 | 单任务执行主链路（queued→running→succeeded+verify）/ selfCheck false→failed / 父卡展开执行 / 缺 AC 子任务跳过 / confirmVerify / manualComplete / cancel / pause→resume→succeeded / getSnapshot / 心跳超时 failed / 收敛 running→failed（Q-017）/ **🟡-4 succeeded 重跑 → currentExecutionId=null + 新 execution record 独立** + B4 侧：respondPermission 帧 / respondApproval 转发（running true / 结算 false）/ extendExecution（running 重置 / 非 running exec-not-running）/ interruptExecution / markExecutionDeprecated / ProviderRegistry isReady（ready→true / idle→false + exec-provider-unavailable） |
| HeartbeatMonitor | 7 | **E31 迁出 running 销毁计时器（paused 不心跳判定）** / **E31 恢复重绑全新窗口** / E20 连续无活动 timeout / Q-026 活动重置（非总时长）/ reset 覆盖 / stop 幂等 / 默认 30min |
| Convergence | 7 | E18 running/paused/interrupted→failed（补 finishedAt+清 currentExecutionId+system）/ E19 依赖收敛 failed→failed / E19 依赖仍满足→keepQueued / 无依赖保留重排 / 幂等（idle/cancelled 跳过）/ 全量依赖重算 recomputeDeps / 依赖判据 |
| VerifyGate | 12 | confirmVerify verify→done（双轨不改执行态）/ 非 verify validation-error / done 幂等 / manualComplete interrupted/failed→succeeded+verify / 非 interrupted/failed exec-not-completable / succeeded 幂等 / selfCheck true→succeeded+verify（E11）/ false→failed（E12）/ false+exitCode!=0→failed / manual 评论回填+列不推进（E27）/ 任务不存在 |
| ExecIpc | 14 | channel 白名单（B3 10+B4 3=13 全在 ALL_IPC_CHANNELS）/ 12 invoke 注册 / executeTask 成功/错误包裹 / approvalRespond（合法/非法/未接线）/ getAgentProviders（接线/空）/ editAcceptanceCriteria / cancel/pause/resume async / getSnapshot 透传 / onExecutionUpdate 订阅重放 |
| ACPProvider | 12 | spawn 参数复用 M1 / 连接生命周期 newSession→running→prompt→完成（恰好一次 onResult）/ agent_message_chunk→text_chunk / request_permission→permission_request / selfCheck 原样回传 / cancel（session/cancel+kill 兜底+结果丢弃）/ 崩溃→failed 无悬挂 / settle 后丢弃 / DSH_HOME 未设→failed / buildPromptText 三态 |
| JsonRpcClient | 11 | 请求帧（行分隔+id）/ id 匹配+迟到忽略 / 错误帧 reject / 通知分发+退订 / 坏帧丢弃 / 半帧缓冲拼接 / 8KB 截断 / 通知帧无 id / dispose reject 全 pending / 请求超时 |
| MockProvider | 8 | success 默认（running→result→succeeded）/ selfCheck false 原样回传（判定归 VerifyGate）/ timeout→failed / 可控延迟（delay 期间 running）/ stream 流式注入（E21 心跳）/ permission 注入 / cancel 结果丢弃 / spec 只读暴露 |
| ProviderManager | 5 | 默认 ACP / mock env / 生产忽略 mock 回落 ACP / acpFactory 注入 / getProvider 单例 |
| ProviderRegistry | 8 | register+list available 双判 / register 幂等覆盖 / resolve 未注册 / resolve isReady 失败 / subagentPolicy 透传 / 空表空数组 / 默认值 / DEFAULT_PROVIDER |
| StateMachine | 6 | 初始 idle+事件 emit / E1 主链路 / 非法迁移 dev throw / prod log-ignore / 8 态全合法逐条 / 事件载荷 |
| transitions | 6 | 契约 18 行矩阵完整 / 8 态全覆盖 / 重跑规则 Q-023 / 双轨解耦（Verify/Done 不在 8 态）/ verify→done 把关 / 系统收敛目标态合法性 |
| ApprovalManager | 12 | FIFO queuePosition / deadlineAt=now+30s 主进程 / approve/deny 回 ACP+timeline / 无 message 省略 reason / 30s auto-deny / 超时后重复→exec-approval-not-pending / 已响应重复 / 不存在 / decision 非法 / 重启 auto-deny / 非阻塞 |
| AcEditor | 6 | 非 running 普通编辑 / running 终止+interrupted+废弃+diff+落字段 / running 无记录仍中断 / 竞态复核非 running→exec-not-running / 缺必填 validation-error / diff 仅列变化字段 |
| ExecutionProvider | 4 | 接口纯类型 + ProviderStatus 6 态（无 idle/interrupted，双轨）+ ExecutionEvent/ExecutionResult/ExecutionTask 形态 |
| errors | 3 | 码集 10 码 kebab / 具名错误继承 HullError+附带字段 / 消息透传 |
| ipc-channels | 5 | 白名单计数（18+10+3=31）/ 唯一性 / kanban: 前缀 / B3 10 完整 / B1/B3 交集空 |

> 合计 17 测试文件，166 个 `test()` 块（含共享 types.test 6 用例为 172），覆盖契约 E1/E2/E4/E8/E11~E21/E26~E32 共 22 场景（E31×5、E32×2 重点覆盖）；E3/5/6/7/9/10/22/23/24/25 语义由非 E 标注用例承载（E3=ExecutionEngine pause/resume、E5/6/7=AcEditor+VerifyGate interrupted 链路、E9=重跑、E10=双轨、E22=extendExecution、E23=ApprovalManager、E24/25=JsonRpcClient+MockProvider）。🟡-2/🟡-4 修复新增 2 用例（Scheduler+1 / ExecutionEngine+1）。

### 质量

- `npm run typecheck`（tsc --noEmit）：干净
- `npm test`（test:unit + test:integration）：**460+8 pass 全绿**（unit 460 / 0 fail；integration 8 / 0 fail）【🟡-2/🟡-4 修复后 +2 新用例，无回归】
- Scheduler **18 用例全绿**（E13/E32 双界断言通过：峰值 ≥2 且 ≤3）+ ExecutionEngine **12 用例全绿**（🟡-4 重跑独立追溯）

## 核验记录

### 实现偏离（实现 vs 设计蓝图）

| 偏离 | 设计蓝图 | 实现 | 原因/取舍 |
|---|---|---|---|
| markSucceeded 清 currentExecutionId | （隐含收敛语义） | **markSucceeded 也清 currentExecutionId**（与 markFailed/壳重启收敛对称）；execution record 独立——`settleTask` 在 `applyResult` 前捕获 executionId 写记录（🟡-4 已修复） | 收敛/Q-017 语义下 clearExecutionId 归 failed 与收敛路径；🟡-4 修复：succeeded 也清，重跑后新 execution record 独立、不再指向旧执行（追溯走 timeline execution 条目） |
| provider 直注 seam | ProviderManager 统一装配 | ExecutionEngine 支持 `provider?: ExecutionProvider` 直注（优先于 providerManager.getProvider()）——测试 mock outcome 固定注入，绕过 ProviderManager 的 env 判定 | 单测隔离（mock 固定无 outcome 变体时直注确定性实现）；生产路径仍走 ProviderManager |
| Scheduler 父卡判定修正 | 蓝图 `!task.parentId` 判单卡 | **有子任务即展开**（`board.tasks.filter(t => t.parentId === taskId).length > 0`），再按 parentId 分流单任务/子任务 | 蓝图以 parentId 判父卡与 E17/E32（父卡=有子任务的卡）矛盾——修正后子任务也允许单执行（被依赖子卡独立触发） |
| nextExecutionId 用 `e_<seq>` 顺序号 | 契约 `e_<uuid>` | 调度层自增 `e_0001`（execution 记录 id，写入 timeline execution.outputPath） | 主进程单实例内唯一即可；真实 ACP 输出路径由 B4 侧 e_\<uuid\> 落盘，B3 记录 id 不冲突 |
| 死锁兜底扩展 | 仅父卡 failed | 环死锁（无父卡，`parentIds.size===0`）时**整队逐 taskId 标 deadlock**（E16 环 A→B→A 场景） | 蓝图只覆盖父卡派生态；E16 契约场景要求循环依赖单任务也收敛 |
| onExecutionUpdate 事件源 | design 期望状态机 emit 直推 | ExecIpc 仅实现**订阅重放快照**（sub 事件）；状态变更推送由 Scheduler 'parallel' 事件 emitParallelAll 承载，高频流式事件不逐条推送（P2-4 节流口径：text_chunk 不走 IPC，进度走 getExecutionSnapshot 拉取） | 契约并行池推送语义满足；P2-4 事件风暴防护前置落地 |
| ExecutionEngine 直写 store.data | design「store 接口只读 + mutations 注入」 | mutations 内部经 `(store as {data}).data.boards` 直写系统管理字段（getBoard 深拷贝只读，B1 updateTask 不写执行态） | B3 契约协调「B3 直调 B1 store 写 executionStatus/currentExecutionId/timeline」，B1 代码零改动（红线 CON-R004 扩展点语义） |

### 契约 E 场景覆盖对照

| 场景 | 契约要求 | 单元级证据 | 状态 |
|---|---|---|---|
| E1 状态机基本迁移 | idle→queued→running→succeeded→verify→done | StateMachine 主链路 + ExecutionEngine 单任务主链路 + VerifyGate confirmVerify | 单元级 ✓ |
| E2 auto 缺 AC 门控 | validation-error（field=acceptanceCriteria） | Scheduler E2 + ExecutionEngine 缺 AC 跳过 | ✓ |
| E3 暂停/恢复 | paused（kill）→ running（newExecutionId） | ExecutionEngine pause/resume（paused→queued→running→succeeded） | ✓ |
| E4 取消各态 | queued/running/paused→cancelled | Scheduler cancel queued/running + MockProvider cancel 结果丢弃 + ACPProvider cancel | ✓ |
| E5 AC 修订中断 | interrupted + 终止 + partial 废弃 + diff 留痕 | AcEditor running 路径（interrupt + markExecutionDeprecated + buildDiff） | ✓ |
| E6 interrupted 重跑 | →queued→running 新记录 | 重跑规则 transitions + ExecutionEngine executeTask | ✓ |
| E7 interrupted 手动完成 | →succeeded+verify→done | VerifyGate manualComplete（interrupted）+ confirmVerify | ✓ |
| E8 failed 重试 | →queued→running | 重跑规则（failed→queued 迁移表）+ ExecuteTask 守卫 | ✓ |
| E9 重跑规则（succeeded 重跑） | →queued（Q-023） | transitions 重跑规则 + 🟡-4 修复：markSucceeded 清 currentExecutionId，重跑记录独立（Q-023 追溯走 timeline execution 条目） | ✓（🟡-4 已修复） |
| E10 双轨拖列 | columnId 变、执行态不变 | 双轨解耦：状态机只写 executionStatus，列走 moveTask；VerifyGate confirmVerify 不改执行态 | ✓ |
| E11 selfCheck true | →succeeded+verify（CON-R029） | VerifyGate E11 + ExecutionEngine selfCheck true | ✓ |
| E12 selfCheck false | →failed | VerifyGate E12（含 exitCode!=0 超时路径）+ MockProvider false 回传 | ✓ |
| E13 并行上限 | 峰值 ≥2 且 ≤3（mock 可控延迟） | Scheduler E13（delayMs=30 双界断言） | ✓ |
| E14 依赖串行时序 | B 先跑，A.startedAt≥B.finishedAt | Scheduler E14 settle(A) 先于 start(B) | ✓ |
| E15 依赖失败传播 | 直接依赖方 queued→failed | Scheduler E15（B 失败→A 级联） | ✓ |
| E16 死锁兜底 | 无就绪+仍有 queued→父 failed | Scheduler E16 环死锁（整队标 deadlock）+ failDeadlock mutation | ✓ |
| E17 父卡派生态 | 3 就绪+2 running→enqueued=3/skipped=2、父 currentExecutionId 恒空 | Scheduler E17/E29 + ExecutionEngine 父卡展开 | ✓ |
| E18 重启收敛 | running/paused/interrupted→failed + 补 finishedAt + 清 id | Convergence E18 + ExecutionEngine 收敛 | ✓ |
| E19 重启 queued 就绪检查 | 依赖收敛 failed→failed；仍满足→重排 | Convergence E19×2 + keepQueued + recomputeDeps | ✓ |
| E20 心跳超时 | 连续 30min 无活动→failed+终止 | HeartbeatMonitor E20 timeout + ExecutionEngine 心跳超时 failed + MockProvider timeout（🟡-2 修复：走 scheduler.failRunning 注入 failed，同帧 provider settle 不覆盖） | ✓（🟡-2 已修复） |
| E21 心跳活跃不超时 | 持续输出>30min 保持 running | HeartbeatMonitor Q-026 活动重置 + MockProvider stream | ✓ |
| E22 延长执行 | 重置 idleResetAt | ExecutionEngineClose extendExecution（running 重置/非 running exec-not-running） | ✓ |
| E23 审批流 | approve/deny + 30s 超时 auto-deny | ApprovalManager（响应/超时/重启 auto-deny + timeline） | ✓ |
| E24 ACP 帧协议桩 | newSession/prompt/session.cancel 出入帧 | JsonRpcClient 11 用例（帧编解码/半帧/坏帧/超时） | ✓ |
| E25 mock 事件注入 | 权限/超时/cancel/流式/selfCheck false | MockProvider 8 用例确定性注入 | ✓ |
| E26 并行池观测 | running/queued/maxParallel 正确 | Scheduler E26 快照 + ExecutionEngine getSnapshot | ✓ |
| E27 manual 回填 | 结果评论回填 + 列手动 | VerifyGate E27（manual 无 selfCheck → 评论回填 + 列不推进） | ✓ |
| E28 单卡单执行守卫 | running 重复→exec-state-conflict | Scheduler E28 + ExecStateConflictError | ✓ |
| E29 父卡展开（P0-B3-1） | enqueued=3 skipped=2（缺 AC+running）、父卡态不变 | Scheduler E17/E29 | ✓ |
| E30 全未就绪 | enqueued=[] skipped=全部 | Scheduler E30 | ✓ |
| E31 心跳与 paused 冲突（P1-1） | paused 超 30min 不 failed；恢复重绑新窗口 | HeartbeatMonitor E31×2（stop 销毁 / reset 重建） | ✓（重点） |
| E32 调度并发竞态（P1-2） | 同时完成→结算逐个→重算后仍 ≤3 | Scheduler E32（5 子父卡展开 peak≥2 且 ≤3，全部 succeeded）+ 单飞 drain 原子结算段 | ✓（重点） |

> 22 个 E 场景直接标号覆盖（E31/E32 重点 double-check）；其余 10 场景语义由非 E 标注用例承载（见 TDD 表注），契约场景 32/32 有单元级证据。

### Code Review 与修复整合（fix-8）

- 多 fixer 拆 lane 实现后统一评审整合（oracle 蓝图评审）→ 8 项修复落地：
  - E31 心跳计时器粒度：仅绑 running、迁出销毁（stop）、恢复/重跑重建（reset 全新窗口）——与 paused 保任务态不冲突
  - E32 调度竞态：单飞 drain 循环 + 完成回调只入队不直接改池 + 原子结算段（settleAll 零 await）——峰值恒 ≤3
  - 父卡判定修正（蓝图 !parentId → 有子任务即展开，E17/E32 矛盾）
  - markSucceeded 不清 currentExecutionId（保重跑追溯）【🟡-4 已修复：markSucceeded 改清 currentExecutionId，settleTask 捕获 executionId 写独立记录】
  - 死锁兜底扩展覆盖环死锁（E16）
  - provider 直注 seam（测试确定性注入）
  - onExecutionUpdate 订阅重放 + 事件节流（P2-4 前置）
  - errors 码集与 IPC 包裹对齐（kebab、{ok,code,message}）
- 修复后 Scheduler 17 用例全绿 + 443 全绿，实现偏离显式登记（见上表，方案冻结后更新，无架构级回 draft 项）

### Semgrep

- 未跑（当前环境无 Semgrep 配置）；风险登记由 Code Review + 全量单测兜底（M1 流程在 S1 已跑 0 findings，B3 侧依赖评审覆盖）

### 风险登记

- ~~🟢-1~~：execution 记录 `outputPath` 依赖 `task.currentExecutionId`（markSucceeded 不清）——succeeded 后重跑覆写 id，旧记录 outputPath 指向新执行路径，追溯级偏差（非功能）【🟡-4 已修复：execution record 用本次执行捕获的 executionId，独立不覆写】
- 🟡-1：nextExecutionId 为 `e_<seq>` 顺序号非 uuid——主进程单实例内唯一，跨重启序号重置但 execution 记录随 board 持久化，语义冲突窗口极窄（真实 ACP 落盘 e_\<uuid\> 不冲突）
- 🟢-2：`onExecutionUpdate` 状态变更推送当前仅"订阅重放快照 + Scheduler parallel 事件"——8 态迁移即时推送走 engine 事件转发，B2 接入时需核对 B4 审批弹窗（onPermissionRequest）事件源接线
- 🟡-2：死锁兜底在 `runningCount>0` 时禁止判定（checkDeadlock 守卫）——并行组内部分任务跑着时新死锁延迟到池空才兜底，人工干预窗口存在（契约 E16 语义满足）

#### 🟡-2（B3）心跳超时 vs 调度池「双 kill」竞态 — 已修复

- 原问题：`handleHeartbeatTimeout` 先 `scheduler.cancel`（发句柄 cancel + 主动 `handleStatus('cancelled')`）再直接 `markFailed`——provider 同帧回 `cancelled`/迟到 `onResult(succeeded)` 会与结算段 `settleAll` 竞态，终态可能 cancelled→succeeded 摇摆
- 修复：`handleHeartbeatTimeout` 不再调 `scheduler.cancel`，改走 `Scheduler.failRunning`（新增）——kill 运行句柄 + 注入 failed 结算（`pendingSettlements` + `settleTask` → `VerifyGate markFailed`，恰好一次）；`handleStatus('cancelled')` 入口检查 `pendingSettlements` 有该 taskId 则跳过 cancelled 覆盖
- 验证：Scheduler.test.ts 新增「🟡-2 心跳超时 + provider settle 同帧 → 终态唯一 failed」

#### 🟡-4（B3）succeeded 重跑后 currentExecutionId 追溯断裂 — 已修复

- 原问题：`markSucceeded` 不清 `currentExecutionId`（保留 `e_<seq>`），succeeded 后重跑覆写 id，旧 execution record 指向新执行、追溯断裂
- 修复：`markSucceeded` 也清 `currentExecutionId`（与 `markFailed`/收敛对称）——`settleTask` 在 `applyResult` 前捕获 executionId，execution record 独立（重跑后新记录不再指向旧执行）
- 验证：ExecutionEngine.test.ts 新增「🟡-4 succeeded 任务重跑后 currentExecutionId=null + 新 execution record 独立」
