# B3 执行引擎与状态机契约

## 契约信息

- 工作项：B3 执行引擎与状态机（飞书 dsh-hull-desktop 清单，t100103）
- 契约状态：已冻结（2026-08-21，ora-1 第三轮复核通过）
- 版本：v0.2
- 适用版本：M2（共识 v1.4）
- 最后更新：2026-08-21
- 说明：桌面壳本地执行引擎契约（无 HTTP API 面）；核心 = ExecutionProvider 抽象 + ACP 默认实现 + 两级 mock 桩 + 状态机全迁移矩阵（双轨）+ 并行调度 + 父卡派生态 + 壳重启收敛 + 活动心跳超时 + 执行控制 IPC（B2/B4 消费）。**B3 与 B1 同主进程，直调 store 方法，不经 IPC**（B1 契约协调事项已定）；对外边界 = 执行控制 IPC channel。

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| ExecutionProvider 抽象 + ACP 默认实现 | B3 | CON-R019 + Q-024 | 抽象层解耦数据模型与执行协议；ACP 默认（JSON-RPC stdio）；两级 mock 桩（接口级内存桩 + ACP 帧协议桩）；HULL_EXEC_PROVIDER=mock 仅 debug | ExecutionProvider 接口 + `kanban:executeTask` | 已定义 |
| 状态机全迁移矩阵（双轨） | B3 | CON-R027/028/029 + Q-015/022/023 | 8 态全迁移 + Verify/Done 列轨 + 人工拖拽列迁移（双轨标注）+ 重跑规则 + 系统收敛 | 状态机引擎（内部）+ `kanban:getExecutionSnapshot` | 已定义 |
| 并行调度（maxParallelTasks=3） | B3 | CON-R023 + Q-016/025 | 空依赖入并行池并发 ≤3；依赖判据（succeeded/manual 按列 Done）；混合编排；执行记录 startedAt/finishedAt 时序双界断言 | 调度器（内部） | 已定义 |
| 依赖失败传播 + 死锁兜底 | B3 | CON-R023 + Q-016 | 被依赖 failed → 直接依赖方 queued→failed；无就绪+仍有 queued → 停止批处理+父 failed | 调度器（内部） | 已定义 |
| 父卡派生态（派生不持久化） | B3 | CON-R023/027 + Q-016 | 任一子 running/queued → 父 running/queued；流水线失败 → 父 failed；全 succeeded → 父 succeeded；父 currentExecutionId 恒空 | 派生态（内部） | 已定义 |
| 壳重启收敛 | B3 | CON-R023 + Q-017 | running/paused/interrupted→failed（"壳重启进程中断"）+补 finishedAt+清 currentExecutionId+system 事件；queued→重跑就绪检查；全量收敛后统一依赖重算 | 启动收敛（内部） | 已定义 |
| 活动心跳超时 | B3 | CON-R032 + Q-026 | 连续 maxExecutionIdleMinutes（默认 30）无活动事件→failed；非总时长；可手动"延长执行" | `kanban:extendExecution` | 已定义 |
| selfCheck 判定 | B3 | CON-R029 + Q-015 | passed=true→Verify；false/超时/异常→failed | 结果回写（内部） | 已定义 |
| 执行中修订 AC | B3 | CON-R021 + Q-022 | 编辑 AC=终止 ACP 进程；interrupted 两选一（重跑→queued / 手动完成→Verify）；partial 标"已废弃"；AC diff 留痕 | `kanban:cancelExecution`（进程终止侧）+ `kanban:manualComplete` | 已定义 |
| 执行控制 IPC（B2/B4 消费） | B3 | CON-R028 | 执行/取消/暂停/恢复/手动完成/审批响应/延长执行 + 错误码 | `kanban:executeTask` 等 7 控制原语 + 1 事件 | 已定义 |

## 范围与非目标

### 范围

- ExecutionProvider 抽象接口（TS 契约）+ ACP 默认实现（newSession/prompt/session.cancel/agent_message_chunk/request_permission）
- 两级 mock 桩：接口级内存桩（主，确定性事件注入）+ ACP 帧协议桩（可选，仅编解码验证）；`HULL_EXEC_PROVIDER=mock` 仅 debug/test 生效
- 状态机全迁移矩阵：8 态（idle/queued/running/paused/interrupted/cancelled/failed/succeeded）+ Verify/Done 列轨 + 人工拖拽列迁移（双轨标注）+ 重跑规则（任何态点执行→queued）+ 系统收敛（依赖失败/重启/并行组失败/心跳超时）
- 并行调度：maxParallelTasks=3（SettingsProvider 可配）；依赖判据（succeeded/manual 按列 Done）；混合编排（空依赖并行池 ≤3 + 有依赖串行）；失败传播；死锁兜底
- 父卡派生态（派生不持久化，父 currentExecutionId 恒空）
- 壳重启收敛（running/paused/interrupted→failed + queued 重跑就绪检查 + 统一依赖重算）
- 活动心跳超时（maxExecutionIdleMinutes=30，连续无活动才 failed）+ 手动"延长执行"
- selfCheck 判定（passed=true→Verify / false→failed）
- 执行中修订 AC（终止 ACP 进程 + interrupted 两选一）
- 执行控制 IPC（B2/B4 消费）：执行任务/取消/暂停/恢复/手动完成/审批响应/延长执行 + 执行快照查询 + 事件推送
- 执行记录时序：执行开始即写 execution 记录（startedAt），完成补 finishedAt（Q-025）

### 非目标

- ACP 真实接入细节/审批弹窗 UI/agent 会话管理（B4）
- 看板 UI/交互/拖拽（B2）
- 看板数据模型/持久化（B1，B3 直调 store）
- 导出/导入（B5）
- 插件独立发布（O-5，随壳分发）、任务级指定 agent/模型 UI（O-10 排后）、依赖图可视化（U-003 P2）
- 多 agent 平台第二实现（U-002 P2，ExecutionProvider 抽象已预留 provider 字段）

## 业务流程与状态

### 核心流程

```text
B2 点「执行」→ kanban:executeTask → 主进程门控（auto 需 AC 完整 / dsh 就绪 / 单卡单执行）→ 任务入队 queued
调度器：空依赖子任务入并行池（并发 ≤ maxParallelTasks=3）；有依赖 → 前驱 succeeded/manual 按列 Done 后入池
就绪 → provider.execute() → ACP spawn dsh 子进程（newSession + prompt 携带 taskId+AC）
执行中：agent_message_chunk 流式事件 = 活动心跳（重置 idle 计时器）；request_permission → 非阻塞确认框 → approvalRespond 回 ACP
完成 → ExecutionResult（exitCode/summary/outputPath/selfCheck）→ auto：passed=true→succeeded+列→Verify；false→failed；manual：结果回填评论，列流转手动
任何时刻 running/paused/interrupted/failed/succeeded 均可人工干预（取消/暂停/恢复/重跑/手动完成/AC 修订）
壳重启 → 启动收敛：running/paused/interrupted→failed + queued 重跑就绪检查 + 全量依赖重算
```

### 状态转换（状态机全迁移矩阵）

> **双轨解耦（Q-013）**：下表 `执行态` = Task.executionStatus（8 态，系统流转）；`列` = Task.columnId（人工拖拽流转）。Verify/Done 是**列轨**状态（模板列 type=verify/done），非 executionStatus 取值——executionStatus 8 态见 B1 Schema。列迁移不改执行态；手动完成改执行态=succeeded + 列→verify（不绕过 Verify 把关，CON-R028）。

#### 执行态轨道（executionStatus，8 态）

| 当前执行态 | 动作 | 目标执行态 | 列变化 | 触发条件 | 冲突行为 | 依据 |
|:---|:---|:---|:---|:---|:---|:---|
| idle | 点「执行」 | queued | 不变 | auto 需 AC 必填项完整；manual 无门槛 | — | CON-R018/Q-023 |
| queued | 调度就绪 | running | 不变 | 有并行名额 + 依赖满足 + dsh 就绪 | — | §13/Q-016 |
| queued | 用户取消 | cancelled | 不变 | 用户干预 | — | §5.2 |
| queued | 系统收敛 | failed | 不变 | 依赖 failed（失败传播）/ 重启收敛后依赖仍不满足 | — | §13/Q-016/017 |
| running | 用户暂停 | paused | 不变 | **O-11 降级：kill ACP 进程 + 结果丢弃 + 标记 paused**（ACP 无暂停原生语义、无会话恢复） | — | O-11/CON-R028 |
| running | 用户编辑 AC | interrupted | 不变 | **编辑 AC = 终止当前 ACP 进程**（Q-022）；partial 标"已废弃（AC 修订）"+AC diff 留痕 | — | CON-R021/Q-022 |
| running | 用户取消 | cancelled | 不变 | session/cancel；超时 kill 进程 | — | §5.2 |
| running | 执行完成 | succeeded | **→ verify**（auto 自验通过自动流转） | selfCheck.passed=true | 完成但列由人工指定 → 标注"执行完成，列由人工指定"，不自动推进（CON-R029） | Q-015/CON-R029 |
| running | 执行失败 | failed | 不变 | selfCheck.passed=false / 心跳超时（连续 30min 无活动）/ 通道异常 | — | Q-015/Q-026 |
| paused | 用户恢复 | running | 不变 | 重入调度池 | — | §5.2 |
| paused | 用户取消 | cancelled | 不变 | 用户干预 | — | §5.2 |
| interrupted | 用户两选一① | queued | 不变 | 以新 AC 重跑（重新入队，现场结果可参考） | — | CON-R021/Q-022 |
| interrupted | 用户两选一② | succeeded | **→ verify** | 手动完成（仍走 Verify 把关，不绕过） | — | CON-R021/Q-022/CON-R028 |
| failed | 用户重试 | queued | 不变 | 任何执行态点「执行」→ queued（重跑规则合并） | — | §5.2/Q-023 |
| failed | 用户手动完成 | succeeded | **→ verify** | 手动完成（仍走 Verify 把关） | — | CON-R028 |
| failed | 改状态 | 不变 | → 任意列 | 人工拖拽（列迁移） | — | §5.3 |
| succeeded | 再次点「执行」 | queued | 不变 | 重跑规则（任何态点执行→queued） | — | Q-023 |
| succeeded | 人工确认（confirmVerify） | 不变 | **→ done** | Verify 把关通过（Done 需人工确认） | 拖到 Done 但未执行完成 → 确认弹窗（可强制通过） | CON-R028/O-6 |

#### 列轨道（人工拖拽，双轨标注）

| 当前列 | 动作 | 目标列 | 执行态变化 | 触发条件 | 冲突行为 | 依据 |
|:---|:---|:---|:---|:---|:---|:---|
| 任意列 | 人工拖拽/菜单 | 任意列 | **不变**（双轨解耦） | 人工移动最高优先级，系统不自动矫正 | 拖到 Done 但执行中/未执行 → "任务未完成执行，确认跳过？"；父卡拖 Done 但子任务未完成 → "子任务未全部完成，确认？"；执行中拖到其他列 → 执行不终止，列以人工为准 | CON-R020/Q-013/§5.3 |

#### 系统收敛（非用户触发，Q-023 重跑规则之系统侧）

| 触发 | 目标态 | 收敛动作 | 依据 |
|:---|:---|:---|:---|
| 依赖失败传播 | 直接依赖方 queued → failed | 被依赖 failed → 直接依赖方 failed（"依赖失败"，可重试） | §13/Q-016 |
| 壳重启收敛 | running/paused/interrupted → failed | 补 finishedAt + 清 currentExecutionId + system 事件（"壳重启进程中断"）；queued → 重跑就绪检查（依赖已收敛 failed → 转 failed"依赖失败"；仍满足 → 保留重调度 + system 事件"已重新排队"）；全量收敛后统一依赖重算 | Q-017 |
| 并行组失败（死锁兜底） | 无就绪 + 仍有 queued | 停止批处理 + 父级 failed（"依赖无法满足/疑似循环"）+ 人工处理 | §13/Q-016 |
| 心跳超时 | running → failed | 连续 maxExecutionIdleMinutes（默认 30）无活动事件 → "疑似卡死" → failed + 终止 ACP 进程 | CON-R032/Q-026 |

#### 父卡派生态（派生不持久化）

| 子任务集合状态 | 父卡派生执行态 | 说明 |
|:---|:---|:---|
| 任一子 running/queued | running/queued | 派生显示，不持久化独立值 |
| 流水线失败（任一子 failed / 并行组失败 / 死锁） | failed | 派生显示 |
| 全部子 succeeded | succeeded | 派生显示 |
| 父 currentExecutionId | **恒空** | 父不参与并行调度，无自身执行记录（Q-016） |

> **父卡执行/重跑入口（P1-B3-1）**：父卡无自身执行态，点「执行」= 展开全部**就绪**子任务重新入队（子任务各自 queued；running/queued 子任务跳过，见 executeTask 展开语义）；父卡 executionStatus 派生不持久化，currentExecutionId 恒空。

> 父卡列（columnId）聚合仍按 CON-R022（全 Done→Done / 任一 Blocked→Blocked / 否则 order 最大列），与执行态派生双独立。

## 接口清单

> B3 为本地执行引擎契约，无 HTTP paths；"接口" = 执行控制 IPC channel（主进程调度层暴露，preload 桥接，renderer/上层消费）。B3 内部（状态机/调度器/心跳）直调 B1 store，不经 IPC。

| # | 状态 | 方法 | 路径（IPC channel） | 用途 | 权限 | 幂等 |
|---|---|---|---|---|---|---|
| 1 | 已定义 | invoke | `kanban:executeTask` | 执行任务/重跑（任何态点执行→queued；**父卡=展开全部就绪子任务入队，子任务=单任务入队**） | 无（壳内） | 否（入队） |
| 2 | 已定义 | invoke | `kanban:cancelExecution` | 取消执行（queued/running/paused→cancelled） | 无 | 是 |
| 3 | 已定义 | invoke | `kanban:pauseExecution` | 暂停执行（running→paused，O-11 降级：kill ACP 进程 + 结果丢弃） | 无 | 是 |
| 4 | 已定义 | invoke | `kanban:resumeExecution` | 恢复执行（paused→running，重新执行） | 无 | 是 |
| 5 | 已定义 | invoke | `kanban:manualComplete` | 手动完成（interrupted/failed→succeeded + 列→verify） | 无 | 是 |
| 6 | 已定义 | invoke | `kanban:approvalRespond` | 审批响应（approve/deny + request id 回 ACP） | 无 | 否（一次性） |
| 7 | 已定义 | invoke | `kanban:extendExecution` | 延长执行（重置心跳窗口） | 无 | 是 |
| 8 | 已定义 | invoke | `kanban:confirmVerify` | Verify 人工确认（succeeded+verify 列 → done；CON-R028） | 无 | 是 |
| 9 | 已定义 | invoke | `kanban:getExecutionSnapshot` | 查询执行池快照（B2 UI 展示） | 无 | 读 |
| 10 | 已定义 | event | `kanban:onExecutionUpdate` | 执行状态/并行池变化推送（B3→B2） | 无 | — |

## Schema 与枚举

### ExecutionProvider 接口（TS 契约，壳内抽象层）

> 数据模型与执行协议解耦（CON-R019）；默认 ACP host / 备选 --patch 插件 / 兜底 CLI headless 均实现此接口。字段细节以本契约为准（本地契约无 OpenAPI yaml）。

```ts
// 执行提供方抽象：ACP 默认 / --patch 插件备选 / CLI headless 兜底
interface ExecutionProvider {
  execute(
    task: {
      taskId: string;                                     // t_<uuid>，作为执行标识
      title: string;                                      // 任务标题（进入 prompt）
      ac?: { what: string; expected: string; verify: string; context?: string }; // auto 模式 AC（四字段）
      agentSpec?: {
        provider?: string;                                // 默认 'dsh'（CON-R030 预留多平台）
        agent?: string;
        model?: string;
        subagentPolicy?: 'auto' | 'restricted';           // CON-R030
      };
    },
    handlers: {
      onEvent: (ev: ExecutionEvent) => void;              // 流式事件（含活动心跳）
      onStatus: (s: ProviderStatus) => void;              // 状态变更
      onResult: (r: ExecutionResult) => void;             // 最终结果
    },
  ): { cancel(): Promise<void> };                         // 取消执行（session/cancel；无会话则 kill）
}

type ProviderStatus = 'queued' | 'running' | 'paused' | 'cancelled' | 'failed' | 'succeeded';

type ExecutionEvent =
  | { kind: 'text_chunk'; text: string }                  // agent_message_chunk（仅已提交文本）→ 活动心跳
  | { kind: 'tool_call'; name: string; args: unknown }
  | { kind: 'permission_request'; id: string; message: string }; // session/request_permission 机器审批

type ExecutionResult = {
  exitCode: number;                                       // 0=成功
  summary: string;                                        // 输出摘要 ≤4KB（§9 常量）
  outputPath: string;                                     // kanban/executions/e_<uuid>.log
  selfCheck?: { passed: boolean; evidence?: string };     // Q-015 自验判定信号
};
```

### ACP 默认实现（JSON-RPC over stdio）

| 能力 | ACP 方法/事件 | 说明 |
|:---|:---|:---|
| 发起 | `newSession(cwd)` + `prompt`（文本+资源引用） | 携带 taskId + AC；壳 spawn dsh ACP 子进程 |
| 取消 | `session/cancel` | 无会话则 kill 进程（兜底） |
| 流式 | `agent_message_chunk` | 仅已提交文本；**作为活动心跳**（Q-026：持续收流式事件视为活跃） |
| 机器审批 | `session/request_permission` | 壳收 request_permission → 非阻塞确认框 → 用户决策回 ACP 响应（approve/deny + request id）→ 30s 超时自动 deny |
| 暂停 | 无原生语义（O-11） | 降级"标记暂停 + 结果丢弃 + kill 进程"；无会话恢复，恢复=重新执行 |

> 局限（deepwiki 官方事实）：无会话加载/恢复/列表、无图片/音频、无推理/工具实时视图。

### 两级 mock 桩（Q-024）

| 级别 | 名称 | 说明 | 生效 |
|:---|:---|:---|:---|
| ① | 接口级内存桩（主） | 实现 ExecutionProvider 接口；确定性事件注入：权限/超时/cancel/流式/selfCheck passed=false | `HULL_EXEC_PROVIDER=mock` |
| ② | ACP 帧协议桩（可选） | 仅验证 JSON-RPC 帧编解码（newSession/prompt/session.cancel 出入帧） | 同 env，debug/test |

> **两级桩关系（P2-B3-3）**：① 接口桩测试**调度/状态机**（B3 侧，主）；② 帧桩测试 **ACP 实现自身**（B4 侧，编解码）。帧桩可注入 ① 的 provider 背后验证真实 ACP 帧收发，但两者职责正交——① 不依赖 ②，② 不替代 ①。
>
> **mock 可控延迟（P2-B3-1）**：① 接口桩必须支持**可控执行延迟**（resolve 前 hold N ms），保证并行上限用例（E13）在 ≤3 并发窗口内出现**稳定 ≥2 峰值并发**——若 mock 即时完成（0 延迟），5 子任务会逐个瞬时完成、永远观察不到峰值 ≥2，用例假通过。延迟注入 + 双界断言（≥2 且 ≤3）共同保证并行观测口径（Q-025）。
>
> **环境门控**：`HULL_EXEC_PROVIDER=mock` 仅 debug/test 生效；生产环境忽略并回落默认 ACP 实现。真实 dsh 冒烟保留（Q-024）。

### ExecutionRecord 时序字段（B3 写，B1 Schema 承载）

| 字段 | 写入时机 | 说明 |
|:---|:---|:---|
| startedAt | 执行开始即写（Q-025） | 供并行观测/状态视图/重启收敛共同依赖 |
| finishedAt | 完成补写（Q-025） | 失败/取消/中断/重启收敛均补 |
| selfCheck | agent 完成回传（Q-015） | { passed, evidence? } |

### 并行调度内部状态（不持久化）

| 项 | 默认 | 说明 |
|:---|:---|:---|
| maxParallelTasks | 3（SettingsProvider 可配） | 空依赖子任务并行池并发上限（CON-R023/O-9） |
| maxExecutionIdleMinutes | 30（SettingsProvider 可配） | 连续无活动事件心跳超时（CON-R032/Q-026，非总时长） |

### 公共异常集

#### KANBAN_EXEC_ERROR（执行引擎层，与 B1 KANBAN_STORE_ERROR 并存对齐）

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| exec-not-found | 任务/看板 id 不存在（已删除） | code + msg | 提示"数据已删除，自动刷新" | 否 |
| exec-provider-unavailable | dsh ACP 未就绪 / spawn 失败 | code + msg | 提示"执行通道未就绪，请检查 dsh" | 是（通道恢复后） |
| exec-state-conflict | 状态冲突（running/queued 中重复 executeTask；单卡单执行守卫） | code + msg + taskId + currentStatus | 提示当前状态，执行中按钮禁用 | 否 |
| exec-not-cancellable | 非 queued/running/paused 不可取消 | code + msg + currentStatus | 提示当前状态 | 否 |
| exec-not-running | 非 running 不可暂停/延长执行 | code + msg + currentStatus | 提示当前状态 | 否 |
| exec-not-paused | 非 paused 不可恢复 | code + msg + currentStatus | 提示当前状态 | 否 |
| exec-not-completable | 非 interrupted/failed 不可手动完成 | code + msg + currentStatus | 提示当前状态 | 否 |
| exec-approval-not-pending | requestId 不存在/已响应 | code + msg + requestId | 提示"审批已处理" | 否 |
| exec-timeout-heartbeat | 心跳超时 → failed（回写 failed 记录） | code + msg（含"疑似卡死"） | 提示可重试 | 是 |
| validation-error | 参数校验失败（auto 缺 AC 必填项、decision 非法、taskId 空） | code + msg + field | 提示具体字段 | 否 |
| store-not-found | 透传 B1 store 校验（deleteTask/deleteBoard 执行态守卫等，见 B1 KANBAN_STORE_ERROR） | code + msg | 提示 | 否 |

## 接口详情

### 1. executeTask

`invoke kanban:executeTask { boardId, taskId }`

#### 用途与依据

- 使用场景：B2 卡片「执行」按钮；任何执行态点「执行」→ queued（重跑规则 Q-023，含 succeeded 重跑、failed 重试、interrupted 以新 AC 重跑）
- **执行入口语义（P0-B3-1/P1-B3-1，必读）**：
  - **taskId = 子任务**：单任务入队 → queued（常规路径）。
  - **taskId = 父卡**：**展开全部就绪子任务入队**——B3 逐子任务判定「就绪」= ① auto 需 AC 完整（CON-R018）② 依赖判据满足（succeeded/manual 按列 Done）③ 当前非 running/queued（单卡单执行守卫）；就绪子任务全部置 queued 入并行池/调度队列（并行池 ≤3，其余排队），不满足就绪的子任务保持原态不入队。**父卡无自身执行态**（派生不持久化，父 currentExecutionId 恒空）——父卡点执行 = 批量展开，不是父卡自身执行。
  - **父卡展开与父卡重跑**：父卡任一态点执行 → 同样展开全部就绪子任务重新入队（已 running/queued 的子任务跳过，其余重跑）。
- 共识：CON-R018/023 + Q-023/Q-016
- 验收：B3 验收（状态机 + 执行触发 + 父卡展开）

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | taskId | string | 是 | `t_<uuid>` | 任务 id（子任务单执行；父卡=批量展开就绪子任务） |

#### 成功响应

- 响应 Schema：`{ taskId, kind: 'single'|'parent_expand', executionStatus?, currentExecutionId?, enqueued: string[], skipped: string[] }`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `taskId` | string | 是 | 否 | 请求入参 | 任务 id |
| `kind` | string | 是 | 否 | 'single' / 'parent_expand' | 执行入口类型 |
| `executionStatus` | string | 否 | 是 | 'queued'（kind=single 时） | 单任务入队结果；parent_expand 不返回 |
| `currentExecutionId` | string | 否 | 是 | 系统生成 `e_<uuid>`（kind=single 时） | 新执行记录 id（kind=parent_expand 恒空，父卡无自身执行） |
| `enqueued` | array[string] | 是 | 否 | 入队任务 id 数组（kind=parent_expand 为就绪子任务集；kind=single 为 [taskId]） | 已入队任务 |
| `skipped` | array[string] | 是 | 否 | 未就绪子任务 id 数组（kind=parent_expand 时非空；kind=single 恒空） | 未入队原因见旁路：running/queued 跳过、auto 缺 AC、依赖未满足 |

```json
// kind=single
{ "code": 0, "msg": "success", "data": { "taskId": "t_1a2b3c4d-0000-4000-8000-000000000001", "kind": "single", "executionStatus": "queued", "currentExecutionId": "e_9f8e7d6c-0000-4000-8000-000000000001", "enqueued": ["t_1a2b3c4d-0000-4000-8000-000000000001"], "skipped": [] } }
// kind=parent_expand
{ "code": 0, "msg": "success", "data": { "taskId": "t_2b3c4d5e-0000-4000-8000-000000000002", "kind": "parent_expand", "executionStatus": null, "currentExecutionId": null, "enqueued": ["t_3c4d5e6f-...", "t_4d5e6f70-..."], "skipped": ["t_5e6f7081-..."] } }
```

#### 失败响应

- 适用公共异常集：`KANBAN_EXEC_ERROR` + `KANBAN_STORE_ERROR`（透传）
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---|---|---|
| validation-error | auto 缺 AC 必填项（CON-R018 门控，单子任务路径）；taskId 空 | code+msg+field | 提示 AC 未填完整 | 否 |
| exec-state-conflict | running/queued 中重复触发（单卡单执行守卫，子任务路径） | code+msg+currentStatus | 执行中按钮禁用 | 否 |
| exec-provider-unavailable | dsh ACP 未就绪 | code+msg | 提示执行通道未就绪 | 是 |
| exec-not-found | 任务/看板不存在 | code+msg | 提示已删除 | 否 |

> 父卡展开路径：单子任务失败不阻断整体（skipped 旁路记录），仅当**全部子任务均未就绪**且无任何入队时返回成功（enqueued=[]，skipped=全部）——UI 提示"无可执行子任务"。

#### 幂等与并发

- 幂等键：无（每次点执行入队新执行）
- 重复请求：running/queued 中重复 → exec-state-conflict（单卡单执行守卫，子任务路径）；父卡展开对 running/queued 子任务跳过（不入队）
- 状态冲突：任何态均允许入队（重跑规则），仅 running/queued 冲突

#### 副作用与审计

- 数据写入：B3 直调 B1 store——子任务路径写 execution 记录（type=execution, status=queued, startedAt=now）+ 设 Task.executionStatus=queued + currentExecutionId（B1 updateTask 不写执行态，B3 调度层写）；父卡展开对每个入队子任务同上；**父卡自身不写执行记录、不改 executionStatus**
- 外部调用：ACP spawn（dsh 子进程，随调度就绪逐任务）
- 审计事件：system 事件"已入队/重跑"（父卡展开为各子任务"已入队"事件 + 父卡"父任务执行已展开"事件）

#### 测试要点

- 成功：idle 子任务点执行 → queued；succeeded 重跑 → queued；failed 重试 → queued
- **父卡展开（P0-B3-1）**：父卡含 5 子任务（3 就绪 + 2 running）→ enqueued=3 就绪子任务入队、skipped=2 running 子任务；父卡自身 executionStatus 不变、currentExecutionId 恒空
- 参数：auto 缺 AC → validation-error
- 冲突：running 中重复触发 → exec-state-conflict
- 外部依赖：dsh 未就绪 → exec-provider-unavailable
- 边界：父卡全部子任务未就绪 → enqueued=[] skipped=全部，提示"无可执行子任务"

### 2. cancelExecution

`invoke kanban:cancelExecution { boardId, taskId }`

#### 用途与依据

- 使用场景：B2 取消按钮（queued/running/paused）；running 时先调 provider.cancel()（session/cancel），超时 kill 进程
- 共识：CON-R028（干预后仍走 Verify 把关——cancel 不走 Verify，取消即终止）；O-11
- 验收：B3 验收（状态机取消迁移）

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | taskId | string | 是 | `t_<uuid>` | 任务 id |

#### 成功响应

- 响应 Schema：`{ taskId, executionStatus: 'cancelled' }`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `taskId` | string | 是 | 否 | 请求入参 | 任务 id |
| `executionStatus` | string | 是 | 否 | 'cancelled' | 取消结果 |

```json
{ "code": 0, "msg": "success", "data": { "taskId": "t_1a2b3c4d-0000-4000-8000-000000000001", "executionStatus": "cancelled" } }
```

#### 失败响应

- 适用公共异常集：`KANBAN_EXEC_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| exec-not-cancellable | 非 queued/running/paused（如 idle/succeeded/failed） | code+msg+currentStatus | 提示当前状态 | 否 |
| exec-not-found | 任务/看板不存在 | code+msg | 提示已删除 | 否 |

#### 幂等与并发

- 幂等：是（cancelled 再取消结果一致；provider.cancel 幂等）
- 冲突行为：取消中任务已完成 → 以实际完成态为准，返回 cancelled 语义保留

#### 副作用与审计

- 数据写入：execution 记录 status=finishedAt 补写 + 终止进程；system 事件"已取消"
- 外部调用：provider.cancel()（session/cancel；无会话 kill）

#### 测试要点

- 成功：queued/running/paused → cancelled
- 冲突：idle 取消 → exec-not-cancellable
- 外部依赖：ACP 无会话 → kill 进程路径

### 3. pauseExecution

`invoke kanban:pauseExecution { boardId, taskId }`

#### 用途与依据

- 使用场景：B2 暂停按钮（仅 running）
- 共识：O-11（ACP 无暂停原生语义、无会话恢复 → **暂停 = 终止 ACP 进程 + 结果丢弃 + 标记 paused**；恢复无法还原现场，重新执行）
- 验收：B3 验收（暂停迁移）

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | taskId | string | 是 | `t_<uuid>` | 任务 id |

#### 成功响应

- 响应 Schema：`{ taskId, executionStatus: 'paused', previousExecutionId }`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `taskId` | string | 是 | 否 | 请求入参 | 任务 id |
| `executionStatus` | string | 是 | 否 | 'paused' | 暂停结果 |
| `previousExecutionId` | string | 是 | 否 | 系统生成 `e_<uuid>` | 被暂停执行记录 id（partial 标"已废弃（暂停）"） |

#### 失败响应

- 适用公共异常集：`KANBAN_EXEC_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---|---|---|
| exec-not-running | 非 running（如 queued/idle/succeeded） | code+msg+currentStatus | 提示当前状态 | 否 |
| exec-not-found | 任务/看板不存在 | code+msg | 提示已删除 | 否 |

#### 幂等与并发

- 幂等：是（paused 再暂停结果一致）

#### 副作用与审计

- 数据写入：execution 记录 status=paused + finishedAt 补写 + partial 结果丢弃标"已废弃（暂停）"；system 事件"已暂停"
- 外部调用：**kill 当前 ACP 进程**（O-11：ACP 无会话恢复，保留进程无法续跑——暂停即终止现场，恢复时重新执行）

#### 测试要点

- 成功：running → paused（ACP 进程已终止）
- 冲突：queued 暂停 → exec-not-running
- 边界：paused 后 ACP 进程确认已终止（无残留子进程）

### 4. resumeExecution

`invoke kanban:resumeExecution { boardId, taskId }`

#### 用途与依据

- 使用场景：B2 恢复按钮（仅 paused）
- 共识：§5.2（paused → running）；O-11（无会话恢复 → 恢复 = **重新执行**，非还原现场）；CON-R028
- 验收：B3 验收（恢复迁移）

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | taskId | string | 是 | `t_<uuid>` | 任务 id |

#### 成功响应

- 响应 Schema：`{ taskId, executionStatus: 'running', newExecutionId }`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `taskId` | string | 是 | 否 | 请求入参 | 任务 id |
| `executionStatus` | string | 是 | 否 | 'running' | 恢复结果 |
| `newExecutionId` | string | 是 | 否 | 系统生成 `e_<uuid>` | 新执行记录 id（恢复 = 重新执行，新记录） |

#### 失败响应

- 适用公共异常集：`KANBAN_EXEC_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---|---|---|
| exec-not-paused | 非 paused（如 running/idle） | code+msg+currentStatus | 提示当前状态 | 否 |
| exec-not-found | 任务/看板不存在 | code+msg | 提示已删除 | 否 |

#### 幂等与并发

- 幂等：是（running 状态一致；重复恢复在 running 态被 exec-not-paused 拦截）

#### 副作用与审计

- 数据写入：新 execution 记录（status=running, startedAt=now）+ 设 Task.executionStatus=running + currentExecutionId=newExecutionId；system 事件"已恢复（重新执行）"
- 外部调用：重新 spawn ACP + newSession + prompt（O-11 无会话恢复，从零开始）

#### 测试要点

- 成功：paused → running（newExecutionId 为新记录）
- 冲突：running 恢复 → exec-not-paused

### 5. manualComplete

`invoke kanban:manualComplete { boardId, taskId }`

#### 用途与依据

- 使用场景：B2 手动完成按钮（interrupted/failed）；手动完成 = 用户人工标记完成，仍走 Verify 把关（CON-R028，不绕过）
- 共识：CON-R021/Q-022（interrupted 两选一②）；CON-R028
- 验收：B3 验收（手动完成迁移）

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | taskId | string | 是 | `t_<uuid>` | 任务 id |

#### 成功响应

- 响应 Schema：`{ taskId, executionStatus: 'succeeded', columnId }`（columnId=verify 列）

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `taskId` | string | 是 | 否 | 请求入参 | 任务 id |
| `executionStatus` | string | 是 | 否 | 'succeeded' | 手动完成结果 |
| `columnId` | string | 是 | 否 | 系统流转 verify 列 | 目标列（仍走 Verify 把关） |

#### 失败响应

- 适用公共异常集：`KANBAN_EXEC_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| exec-not-completable | 非 interrupted/failed（如 running/queued/idle） | code+msg+currentStatus | 提示当前状态 | 否 |
| exec-not-found | 任务/看板不存在 | code+msg | 提示已删除 | 否 |

#### 幂等与并发

- 幂等：是（succeeded 再手动完成结果一致）

#### 副作用与审计

- 数据写入：Task.executionStatus=succeeded + columnId→verify（B3 直调 store moveTask 语义）；execution 记录 finishedAt 补写；system 事件"手动完成"
- 审计：手动完成不绕过 Verify 把关（CON-R028）

#### 测试要点

- 成功：interrupted → succeeded + 列 verify；failed → succeeded + 列 verify
- 冲突：running 手动完成 → exec-not-completable
- 边界：verify 人工确认 → done（见 confirmVerify）

### 5b. confirmVerify

`invoke kanban:confirmVerify { boardId, taskId }`

#### 用途与依据

- 使用场景：B2 Verify 列人工确认按钮（successed + verify 列 → done）；Verify 把关通过，Done 需人工确认（CON-R028/O-6）
- 共识：CON-R028 + O-6；状态机"Verify → Done 人工确认"迁移
- 验收：B3 验收（Verify 把关链路完整：手动完成/自验通过 → verify → 人工确认 → done）

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | taskId | string | 是 | `t_<uuid>` | 任务 id |

#### 成功响应

- 响应 Schema：`{ taskId, columnId, executionStatus }`（columnId=done 列）

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `taskId` | string | 是 | 否 | 请求入参 | 任务 id |
| `columnId` | string | 是 | 否 | done 列 id | 确认后目标列 |
| `executionStatus` | string | 是 | 否 | 'succeeded'（保持，不改执行态） | 执行态不变（双轨） |

#### 失败响应

- 适用公共异常集：`KANBAN_EXEC_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---|---|---|
| validation-error | 任务不在 verify 列（非 Verify 态不可确认） | code+msg+field | 提示当前列 | 否 |
| exec-not-found | 任务/看板不存在 | code+msg | 提示已删除 | 否 |

#### 幂等与并发

- 幂等：是（done 再确认结果一致；已在 done 列则结果一致返回）

#### 副作用与审计

- 数据写入：columnId → done 列（B3 直调 store moveTask 语义）；system 事件"已确认完成（Verify 把关通过）"；executionStatus 不变（succeeded）
- 审计：不绕过 Verify 把关——仅 verify 列任务可确认

#### 测试要点

- 成功：succeeded+verify 列 → done 列
- 冲突：非 verify 列确认 → validation-error
- 边界：confirmVerify 与 moveTask 到 done（人工拖拽）双路径均到 done，确认弹窗仅后者（拖拽未执行完成强制通过）

### 6. approvalRespond

`invoke kanban:approvalRespond { boardId, taskId, requestId, decision, message? }`

#### 用途与依据

- 使用场景：B4 审批弹窗 → 用户决策 → 回 ACP 响应（approve/deny + request id，防 agent 悬挂）；30s 超时自动 deny + 关弹窗（Q-018）
- 共识：CON-R019 + Q-018
- 验收：B4 验收（审批流）+ B3 提供控制 IPC

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | taskId | string | 是 | `t_<uuid>` | 任务 id |
| body | requestId | string | 是 | ACP request_permission 下发的 id | 审批请求 id |
| body | decision | string | 是 | 'approve' / 'deny' | 用户决策 |
| body | message | string | 否 | ≤500 字符 | 审批附加说明（写 timeline） |

#### 成功响应

- 响应 Schema：`{ taskId, requestId, decision }`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `taskId` | string | 是 | 否 | 请求入参 | 任务 id |
| `requestId` | string | 是 | 否 | 请求入参 | 审批请求 id |
| `decision` | string | 是 | 否 | 'approve'/'deny' | 回执 |

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
- 并发：多请求并行按任务平铺/FIFO 排队（Q-018）

#### 副作用与审计

- 数据写入：决策写 timeline（system, user）——"审批 {approve/deny}: {message}"
- 外部调用：ACP 响应（approve/deny + request id）；30s 超时自动 deny + 关弹窗

#### 测试要点

- 成功：approve/deny → ACP 响应 + timeline 决策留痕
- 冲突：已响应/超时后再次响应 → exec-approval-not-pending
- 边界：30s 超时自动 deny

### 7. extendExecution

`invoke kanban:extendExecution { boardId, taskId }`

#### 用途与依据

- 使用场景：B2「延长执行」按钮；用户手动延长 = 重置心跳窗口（Q-026）
- 共识：CON-R032/Q-026
- 验收：B3 验收（心跳超时边界）

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | boardId | string | 是 | `b_<uuid>` | 看板 id |
| body | taskId | string | 是 | `t_<uuid>` | 任务 id |

#### 成功响应

- 响应 Schema：`{ taskId, executionStatus: 'running', idleResetAt }`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `taskId` | string | 是 | 否 | 请求入参 | 任务 id |
| `executionStatus` | string | 是 | 否 | 'running' | 保持 running |
| `idleResetAt` | string | 是 | 否 | 系统生成 ISO 8601 UTC | 心跳窗口重置时间 |

#### 失败响应

- 适用公共异常集：`KANBAN_EXEC_ERROR`
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---:|---|---|:---:|
| exec-not-running | 非 running（无需延长） | code+msg+currentStatus | 提示当前状态 | 否 |
| exec-not-found | 任务/看板不存在 | code+msg | 提示已删除 | 否 |

#### 幂等与并发

- 幂等：是（每次延长重置窗口，重复调用无副作用）

#### 副作用与审计

- 数据写入：system 事件"已延长执行（重置心跳窗口）"
- 外部调用：无

#### 测试要点

- 成功：running → 重置 idleResetAt
- 冲突：非 running → exec-not-running

### 8. getExecutionSnapshot

`invoke kanban:getExecutionSnapshot { boardId? }`

#### 用途与依据

- 使用场景：B2 加载执行状态视图/并行池展示（无需逐任务轮询）
- 共识：CON-R023/Q-025（并行观测口径）
- 验收：B3 验收（并行池展示）

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| query | boardId | string | 否 | `b_<uuid>`；缺省全看板 | 看板 id |

#### 成功响应

- 响应 Schema：`{ running: TaskSummary[], queued: TaskSummary[], maxParallel: number }`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|---|---|---|---|
| `running[]` | array[TaskSummary] | 是 | 否 | 空数组合法 | 执行中任务 |
| `queued[]` | array[TaskSummary] | 是 | 否 | 空数组合法 | 排队任务 |
| `maxParallel` | integer | 是 | 否 | SettingsProvider 当前值（默认 3） | 并行上限 |

> `TaskSummary = { taskId, title, executionStatus, currentExecutionId, startedAt? }`（执行态派生/记录字段）。

#### 失败响应

- 适用公共异常集：`KANBAN_EXEC_ERROR`
- 无特有异常。

#### 幂等与并发

- 读操作，无幂等要求；返回内存态快照。

#### 测试要点

- 成功：并行池 ≥2 且 ≤3 时快照正确（Q-025 双界断言）

### 9. onExecutionUpdate

`event kanban:onExecutionUpdate`

#### 用途与依据

- 使用场景：B3 → B2 状态/并行池变化推送（状态变更、审批请求、心跳超时、重启收敛）
- 共识：CON-R028/Q-026
- 验收：B3 验收（状态视图刷新）

#### 事件负载

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| boardId | string | 是 | 看板 id |
| taskId | string | 是 | 任务 id |
| executionStatus | string | 是 | 8 态 |
| currentExecutionId | string | 否 | 可空（收敛后清空） |
| parallel | object | 否 | `{ running: n, queued: n }` 并行池计数（变化时带）；**口径（P2-B3-2）**：`running` = 当前实际执行中子任务数（≤maxParallelTasks，不含 paused）；`queued` = 并行池内排队子任务数（含有依赖待前驱的）；均为**当前看板内**聚合计数，父子任务不重复计数（父卡派生态不计入） |
| idleResetAt | string | 否 | 心跳窗口（extend/heartbeat 场景带） |

```json
{ "boardId": "b_2f5a1c00-0000-4000-8000-000000000001", "taskId": "t_1a2b3c4d-0000-4000-8000-000000000001", "executionStatus": "running", "currentExecutionId": "e_9f8e7d6c-0000-4000-8000-000000000001", "parallel": { "running": 2, "queued": 1 } }
```

#### 测试要点

- 成功：状态变更即时推送；并行池计数正确
- 边界：审批请求推送（B4 消费开弹窗）；心跳超时推送

## 数据库与外部系统影响

> 无独立数据库（数据落 B1 boards.json，B3 直调 store 方法）。B3 新增落盘物：执行输出日志。

### 外部系统/落盘

| 系统 | 调用 | 超时 | 重试 | 幂等/结果确认 |
|---|---|---|---|---|
| dsh ACP 子进程 | JSON-RPC over stdio（newSession/prompt/session.cancel/request_permission/agent_message_chunk） | 心跳超时 maxExecutionIdleMinutes=30（连续无活动） | 通道失败不自动重试（exec-provider-unavailable，用户重试） | session/cancel；完成以 ExecutionResult 回传 |
| executions log | 写 `<userData>/kanban/executions/e_<uuid>.log` | — | — | 随卡片删除级联清理（Q-019） |
| B1 store 直调 | 同主进程直调（不经 IPC） | — | — | 幂等见各 IPC |

## 联调与测试场景

| # | 场景 | 前置条件 | 请求/动作 | 预期结果 | 数据与审计结果 | 验收编号 |
|---|---|---|---|---|---|---|
| E1 | 状态机基本迁移 | idle auto 任务（AC 完整）+ mock | executeTask → 调度 → 完成(selfCheck true) → 人工确认 | idle→queued→running→succeeded→verify→done | execution 记录 startedAt/finishedAt + system 事件 | B3 验收 |
| E2 | auto 缺 AC 门控 | auto 任务无 AC | executeTask | **validation-error**（field=acceptanceCriteria，CON-R018） | 不入队 | B3 验收 |
| E3 | 暂停/恢复 | running | pauseExecution（kill ACP 进程）→ resumeExecution（重新执行） | paused（ACP 已终止）→ running（newExecutionId 新记录） | system 事件"已暂停/已恢复（重新执行）" | O-11 |
| E4 | 取消（各态） | queued/running/paused | cancelExecution | → cancelled | ACP session/cancel + finishedAt 补写 | B3 验收 |
| E5 | AC 修订中断 | running | 编辑 AC | interrupted + ACP 进程终止 + partial 标"已废弃（AC 修订）" + AC diff 留痕 | system 事件 + diff 对照 | CON-R021 |
| E6 | interrupted 重跑 | interrupted | 两选一① 以新 AC 重跑 | → queued → running（新执行记录追加） | 新 execution 记录 | Q-022 |
| E7 | interrupted 手动完成 | interrupted | 两选一② 手动完成（manualComplete）→ verify 人工确认（confirmVerify） | → succeeded + 列→verify → 确认 → done | system 事件"手动完成/已确认完成" | Q-022/CON-R028 |
| E8 | failed 重试 | failed | executeTask | → queued → running | 新 execution 记录 | B3 验收 |
| E9 | 重跑规则（succeeded 重跑） | succeeded | executeTask | → queued（重跑规则 Q-023） | 新 execution 记录 | Q-023 |
| E10 | 双轨：执行中拖列 | running | moveTask 到其他列 | columnId 变、executionStatus 不变（Q-013） | system 事件 from→to/user | CON-R020 |
| E11 | selfCheck true | running 完成 | mock 注入 selfCheck{passed:true} | → succeeded + 列→verify（自动流转 CON-R029） | execution 记录 selfCheck | Q-015 |
| E12 | selfCheck false | running 完成 | mock 注入 selfCheck{passed:false} | → failed | execution 记录 selfCheck | Q-015 |
| E13 | 并行上限 | 5 个空依赖子任务 + **mock 可控延迟**（保证稳定 ≥2 峰值） | executeTask 父卡（展开入队） | 峰值并发 ≥2 且 ≤3（Q-025 双界断言） | 并行观测 + onExecutionUpdate parallel | CON-R023 |
| E14 | 依赖串行时序 | 子 A 依赖 B（A→B） | 执行 | B 先跑，A.startedAt ≥ B.finishedAt | 时序断言 | Q-016 |
| E15 | 依赖失败传播 | 依赖目标 failed | 被依赖 failed | 直接依赖方 queued→failed（"依赖失败"，可重试） | system 事件"依赖失败" | Q-016 |
| E16 | 死锁兜底 | 循环依赖/无法满足 | 调度 | 无就绪+仍有 queued → 停止批处理 + 父 failed（"依赖无法满足/疑似循环"） | 父 failed + 人工处理提示 | Q-016 |
| E17 | 父卡派生态 + 执行入口 | 父卡含多子（3 就绪 + 2 running） | executeTask 父卡（展开） | enqueued=3 就绪子任务、skipped=2 running 子任务；父卡自身态不变、currentExecutionId 恒空；子态变化 → 父派生 running/succeeded | 派生不持久化 + 批量展开 | Q-016 |
| E18 | 重启收敛 | running/paused/interrupted 任务 | 壳重启 | → failed（"壳重启进程中断"）+ 补 finishedAt + 清 currentExecutionId + system 事件 | 收敛后 execution 记录完整 | Q-017 |
| E19 | 重启 queued 就绪检查 | queued 任务依赖方已收敛 failed | 壳重启 | → failed（"依赖失败"）；依赖仍满足 → 保留重调度 + "已重新排队" | 全量收敛后统一依赖重算 | Q-017 |
| E20 | 心跳超时 | running 无活动 | mock 连续 30min 无 text_chunk | → failed（"疑似卡死"）+ 终止 ACP 进程 | exec-timeout-heartbeat 回写 | CON-R032/Q-026 |
| E21 | 心跳活跃不超时 | running 持续输出 | mock 持续 text_chunk >30min | 不超时，保持 running | 活动事件重置 idle 计时器 | Q-026 |
| E22 | 延长执行 | running | extendExecution | 重置心跳窗口 idleResetAt | system 事件"已延长执行" | Q-026 |
| E23 | 审批流 | ACP 发 request_permission | approvalRespond approve/deny；超时 | ACP 响应 + timeline 决策留痕；30s 超时自动 deny | system 事件 | Q-018 |
| E24 | ACP 帧协议桩 | HULL_EXEC_PROVIDER=mock | 帧编解码验证 | newSession/prompt/session.cancel 出入帧正确 | 仅 debug/test | Q-024 |
| E25 | mock 事件注入 | mock 桩 | 注入权限/超时/cancel/流式/selfCheck false | 各事件驱动状态机正确 | 确定性事件 | Q-024 |
| E26 | 并行池观测 | mock 可控延迟 | getExecutionSnapshot | running/queued/maxParallel 正确 | 双界断言 | Q-025 |
| E27 | manual 模式回填 | manual 任务 | executeTask 完成（mock） | 结果以评论回填（agent 来源，Q-028 只读）+ 列流转手动（不自动推进） | timeline comment | CON-R029 |
| E28 | 单卡单执行守卫 | running | executeTask 同任务 | **exec-state-conflict**（执行中按钮禁用） | 不入队 | CON-R023 |
| E29 | 父卡执行展开（P0-B3-1） | 父卡含 5 子任务（3 就绪含依赖满足 + 1 auto 缺 AC + 1 running） | executeTask 父卡 | kind=parent_expand；enqueued=3、skipped=2（缺 AC + running）；父卡自身 executionStatus 不变、currentExecutionId 恒空 | 批量入队 + system 事件"父任务执行已展开" | Q-016 |
| E30 | 父卡展开全未就绪 | 父卡子任务全 running/缺 AC | executeTask 父卡 | 成功返回 enqueued=[] skipped=全部；UI 提示"无可执行子任务" | 不入队 | CON-R018 |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| 无 | — | — | — | — |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| B3↔B1 store 直调 | B3 与 B1 同主进程直调 store 方法，不经 IPC（B1 协调已定）；execution 记录/executionStatus/currentExecutionId 由 B3 写，B1 updateTask 不写 | phper666 | B3 契约 | 已定 |
| 执行控制 IPC 边界 | B3 提供 executeTask（父卡展开）/cancel/pause/resume/manualComplete/confirmVerify/approvalRespond/extendExecution/getExecutionSnapshot/onExecutionUpdate；B2 消费 UI 控制，B4 消费审批（request_permission 侧 ACP 接入属 B4） | phper666 | B3 契约 | 已定 |
| IPC channel 命名与 preload 桥 | B2/B3/B4 消费同一 preload 桥；channel 前缀 `kanban:`（沿用 B1） | phper666 | B2 契约 | 待定 |
| 错误码对齐 | B3 新增 `KANBAN_EXEC_ERROR`（exec-* 集），与 B1 `KANBAN_STORE_ERROR` 并存；validation-error/store-not-found 命名复用对齐 | phper666 | 本契约 | 已定 |
| HULL_EXEC_PROVIDER=mock 门控 | 仅 debug/test 生效；生产忽略回落 ACP；真实 dsh 冒烟保留（Q-024） | phper666 | B4 契约 | 已定 |
| 心跳超时配置 | maxExecutionIdleMinutes/maxParallelTasks 进 SettingsProvider（B3 读取，B2 设置 UI） | phper666 | B2 契约 | 待定 |

## 完成记录

> 交付后填写，结果必须有证据。

| 项 | 结果 |
|:---|:-----|
| 交付时间 | — |
| 验证结果 | — |
| 构建/发布 | — |
| 偏差处理 | — |

## 决策与踩坑

- B3 契约形态 = 本地执行引擎契约（同 B1/B2 模式，无 HTTP API 面）：ExecutionProvider 接口（TS）+ 状态机矩阵 + IPC 执行控制原语，无 OpenAPI yaml。复用场景：B4 契约同构（执行集成侧）。
- Verify/Done 是列轨（columnId type=verify/done），非 executionStatus 8 态之一——状态机矩阵用"执行态轨道 + 列轨道 + 系统收敛"三表表达双轨解耦（Q-013），避免把列态混入执行态。
- 手动完成 = 改执行态 succeeded + 列→verify（仍走 Verify 把关，CON-R028）；不绕过人工把关语义与 O-6（Verify 需人工确认）一致。
- 父卡执行态派生不持久化（Q-016）——父 currentExecutionId 恒空，避免父卡独立执行记录与子卡混乱。
- 心跳超时 = 活动心跳（Q-026），非总时长：agent_message_chunk 流式事件即心跳信号，持续输出的长任务不超时，仅"连续 30min 无活动"判卡死。复用场景：任何长任务执行通道。
- 错误码对齐 B1 风格（kebab 化、语义化命名）：exec-* 集 + validation-error/store-not-found 复用命名，避免跨契约同一错误码歧义。
- 执行入口双语义（ora-1 修复）：executeTask 对父卡 = 展开全部就绪子任务入队（父卡无自身执行态、currentExecutionId 恒空），对子任务 = 单任务入队——响应加 kind/enqueued/skipped 展开结果，E13/E29/E30 由此可执行。复用场景：任何父→子批量编排入口。
- 暂停语义统一 O-11（ora-1 修复）：ACP 无会话恢复 → 暂停 = kill 进程 + 结果丢弃 + 标记 paused；恢复 = 重新执行（新 execution 记录），不承诺"从现场继续"。原"保留现场恢复"表述与 O-11 矛盾，已废弃。
- Verify 把关链路补全（ora-1 修复）：confirmVerify 原语承接 verify 列 → done（CON-R028），与 moveTask 到 done（人工拖拽）双路径并存；手动完成/自验通过均止步 verify，人工确认才 done——不绕过把关。

## 变更记录

| 时间 | 类型 | 摘要 |
|---|---|---|
| 2026-08-21 | 初次生成 | 基于 t100103（B3）和共识 v1.4（§5/§7.4/§8/§10/§13/§14.1 + Q-015/016/017/022/024/025/026）生成契约草案 |
| 2026-08-21 | 复核修复 | ora-1 退回修复：P0-B3-1 executeTask 补父卡展开语义（kind/enqueued/skipped + 就绪判定）；P1-B3-1 定死父卡执行/重跑规则（展开重新入队，父卡无自身执行态）；P1-B3-2 补 confirmVerify 原语（verify→done 人工确认，CON-R028）；P1-B3-3 pause/resume 统一 O-11（kill 进程 + 结果丢弃 + 恢复重新执行）；P2-B3-1 mock 可控延迟保证峰值 ≥2；P2-B3-2 onExecutionUpdate parallel 计数口径（父子不重复计）；P2-B3-3 两级桩职责正交注明；测试补 E29/E30 + 改 E3/E7/E13/E17；契约状态改待评审（第三轮） |

## 自检记录

- 追踪完整性：PASS（B3→CON-R019/021/023/027/028/029/032 + Q-015/016/017/022/023/024/025/026→验收，追踪矩阵全覆盖；ora-1 修复后补 Q-016 父卡执行入口 + CON-R028 Verify 确认链路）
- OpenAPI 一致性：不适用（本地执行引擎契约，无 OpenAPI yaml；ExecutionProvider TS 接口即字段唯一事实源）
- 示例与错误场景：PASS（30 个联调场景 E1~E30 含成功/失败/边界 + 公共异常集 KANBAN_EXEC_ERROR + ExecutionProvider 接口示例）
- 安全与敏感字段：PASS（无敏感字段；DSH_HOME 零接触——数据落 B1 userData，B3 只写 executions log）
- 链接与格式：PASS
