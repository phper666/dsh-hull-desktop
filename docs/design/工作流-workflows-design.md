# 工作流（Workflows）技术方案

> 判级：**复杂**（新子系统：执行引擎 + 持久化 + 视图 + 菜单）→ 本文档
> 需求（用户 2026-08-31）：壳新增「工作流」菜单（设置之前），壳可配置工作流实现业务；**dsh + 面板（看板）加入工作流**。先调研后实现。

## 一、市场调研结论

- **n8n**：trigger → 顺序 action 节点（400+ connectors），节点式画布；sequential processing 简化数据流
- **Dify**：AI 原生编排（LLM pipeline），节点式
- **Zapier/Make**：trigger → action 模板化，连接器生态
- **共性提炼**：①触发器启动流 ②动作节点顺序执行 ③连接器承载集成 ④运行日志/重试
- 对 Hull 的取舍：不做可视化画布（体量过大），v1 采用 **「顺序步骤列表」编辑器**（GitHub Actions steps 同构）——够用、可控、留画布演进空间

## 二、v1 范围与模型

```
WorkflowDef { id, name, enabled, steps: WorkflowStep[] }
WorkflowStep { id, type, config }
WorkflowRun { id, workflowId, startedAt, finishedAt, status: running|success|failed, log[] }
```

- **触发**：v1 手动运行（工作流列表「运行」按钮）；定时（cron）/事件触发（dsh 事件）排 v2
- **步骤类型 v1**（WORKFLOW_STEP_TYPES 注册表，加类型 = 加处理器）：
  | type | 说明 | 依赖 |
  |:-----|:-----|:-----|
  | dsh-card | 看板建卡 + 可选立即派发执行（**dsh+面板联动**） | KanbanStore + ExecutionEngine |
  | http | 任意 webhook/API 调用（通用集成底座） | fetch |
  | notification | 系统通知 | Electron Notification |
  | delay | 延时 N 秒 | — |
- **执行语义**：顺序执行、单步失败即中止（fail-fast）、每步独立日志（ok/message/耗时）、运行记录 upsert 持久化（最近 50 条）
- **dsh+面板联动**：`dsh-card` 步骤 = KanbanStore.createTask（可带 labels/priority）→ `execute=true` 时 ExecutionEngine.executeTask 派发——工作流产出的任务直接进看板并由 dsh 执行

## 三、架构

```
src/workflows/
  types.ts            # 类型与步骤注册表
  WorkflowStore.ts    # workflows.json + runs.json（upsert，≤50 环形裁剪）
  WorkflowEngine.ts   # 顺序执行器（依赖 DI：store/kanban/exec/notify）
  WorkflowIpc.ts      # workflows:list/get/save/delete/run/runs
```

- 引擎 DI 最小接口（WorkflowStoreShape）避免与 KanbanStore 双向耦合；notify 注入 Electron Notification
- IPC：`workflows:*` 六原语；preload `window.workflows` 桥 + `hull.showWorkflows`

## 四、UI

- 导航「工作流」在工作台连接之后、设置之前
- 列表：卡片（名称/启用开关/步骤数/最近运行状态 + 运行/编辑/删除）
- 编辑器：名称 + 步骤列表（类型下拉 → 按 type 渲染配置表单；上移/下移/删除）+ 保存；运行结果 toast + 运行记录段
- 步骤配置表单按 type 渲染（dsh-card 的看板下拉复用 window.kanban.getBoards）

## 五、风险与回退

| 风险 | 缓解 |
|:-----|:-----|
| 步骤执行阻塞 UI | 引擎在 main 异步执行；渲染层轮询/最终结果返回 |
| dsh 未就绪时派发失败 | executeTask 返回 ok:false → 步骤 fail-fast 记录 |
| 运行日志膨胀 | ≤50 条环形裁剪 |

## 六、v2 规划（原始清单）

定时触发（cron）、事件触发（dsh 生命周期事件）、步骤间变量模板（`{{steps.1.output}}`）、工作台连接联动步骤（发短信/邮件）、可视化画布。

## 七、v2 设计（2026-09-02 定稿，判级：复杂 → 方案冻结）

> 判级：复杂——①调度子系统（cron 解析 + 主进程定时编排：生命周期/漂移/错过策略）②凭据安全敏感面（平台能力调用，main 侧解密）③渲染层编辑器 UI 增量。
> 范围（用户 2026-09-02 定）：定时触发（cron）+ connection-action 步骤（发短信/邮件）+ token-budget 步骤（Token 预算告警）。

### 7.1 定时触发（cron）

- 数据模型：`WorkflowDef` 增 `trigger?: { type: 'cron'; expr: string } | null`——字段级扩展，workflows.json version 不 bump（对齐 theme 字段扩展先例）；无 trigger = v1 手动语义，读侧容错。
- cron 解析器（`src/workflows/cron.ts`，零新依赖，标准库优先）：5 字段（分 时 日 月 周，本地时区），支持 `* , - /`；星期 0/7=周日；`parseCron(expr)` 校验 + `cronNext(expr, from: Date)` 下次触发计算——纯函数、确定性可单测。DOW 与 DOM 同时受限时按 cron 标准语义为「或」（vixie cron 约定）。
- 调度器（`src/workflows/WorkflowScheduler.ts`）：主进程单例；`reschedule(defs)` 全量重算（save/delete/启停/壳启动时调用）→ 每工作流一个 timer 指向下次触发点；触发前对齐校验（目标分钟已过才触发，否则重算——覆盖 setTimeout 漂移/休眠唤醒）；错过策略 = **不补跑**（skip missed，只跑未来）；触发 = `engine.run(id)`，已在运行则跳过本次（hull.log 留痕）；`dispose()` 清全部 timer（before-quit）。
- 引擎互斥：WorkflowEngine 加 `running: Set<workflowId>`，run() 入口同工作流已在跑 → 抛错「上一次运行尚未结束」——手动/调度共用，防并发写同一 runs.json。
- IPC：新增 `workflows:cronPreview { expr }` → `{ valid, next: ISO[3], error? }`（渲染层校验/预览共用 main 解析器，渲染层零复制）；`workflows:list` 响应由 IPC 层注入 `nextRunAt`（enabled + cron 项），列表 UI 零成本显示。

### 7.2 connection-action 步骤（工作台连接联动）

- 类型 `connection-action`，config = `{ connectionId, params }`（params 为 JSON 字符串，按平台 schema）；v2 各平台仅一种能力 `send`，action 不单设。
- 能力层（`src/connections/Actions.ts`）：`invokeConnectionAction(platform, fields(解密后), params) → VerifyResult`：
  - **smtp**：v1 握手状态机扩展为发信——EHLO → `MAIL FROM`（params.from 或 username）→ `RCPT TO`（params.to，逗号分隔逐个）→ `DATA`（From/To/Subject 头 + 空行 + body + `.`）→ 250 → QUIT。纯 node:net/tls，无 nodemailer。头注入防护：to/subject/from 含 CR/LF 即拒绝。
  - **aliyun-sms**：`buildAliyunQueryString` 参数化（action + 业务参数注入，保留原签名向后兼容旧单测）→ `SendSms`（PhoneNumbers/TemplateCode/TemplateParam）→ `Code=OK` 成功。
  - **tencent-sms**：`buildTc3Authorization` 已参数化直接复用 → `SendSms`（PhoneNumberSet/TemplateId/TemplateParamSet）。
  - **salesforce**：v2 无能力调用（SOQL/记录操作语义未定）——步骤执行即报「该平台暂不支持动作」，留扩展点。
- 安全（继承 connections 设计红线）：凭据解密只在 main（ConnectionsStore.getCredentials）；错误信息不含 secret；运行日志 message 对收件人掩码（手机号 `138****5678`、邮箱 `a***b@x.com`）；连接不存在/已删 → 步骤失败。
- 引擎 DI：deps 增 `invokeAction?: (connectionId: string, params: Record<string, string>) => Promise<{ ok: boolean; message: string }>`（main 装配 ConnectionsStore+Actions；单测注入 fake）。

### 7.3 token-budget 步骤（Token 预算告警）

- 类型 `token-budget`，config = `{ period: 'day'|'month'|'all', thresholdTokens, notifyOnExceed? }`。
- 执行：deps 增 `tokenUsage?: (period) => Promise<{ totalTokens: number }>`（main 装配 scanAllSources + summarize 包装；day/month 走 rangeCutoffMs 同款日历对齐语义）→ totalTokens ≥ threshold → 超限：notifyOnExceed='true' 时发系统通知 + **步骤 fail**（message 带用量/阈值）→ fail-fast 中止后续步骤、run=failed（运行记录可见告警）；未超限 → message「今日用量 X / 阈值 Y」。
- 性能：全平台扫描秒级，cron 日级场景可接受；不额外缓存。

### 7.4 UI（renderer/workflows.js）

- 列表卡：有 cron 的显示「下次运行 <本地时间>」（list 注入 nextRunAt）。
- 编辑器：名称下触发区（radio 手动/定时；定时 → cron 输入框 + 预览/错误提示，debounce 300ms 调 workflows:cronPreview）。
- 步骤表单新增：connection-action（连接下拉 = window.connections.list() 过滤 smtp/aliyun-sms/tencent-sms，选中后按平台渲染 params 字段：smtp→to/subject/body/from(可选)；aliyun-sms→phoneNumbers/templateCode/templateParam；tencent-sms→phoneNumberSet/templateId/templateParamSet）；token-budget（period 下拉 + thresholdTokens 数字 + notifyOnExceed 开关）。

### 7.5 非目标（v2 明确不做）

事件触发（dsh 生命周期事件，需官方扩展点调研）· 步骤间变量模板 · 错过补跑（catch-up）· salesforce 能力调用 · 可视化画布。

### 7.6 风险与回退

| 风险 | 缓解 |
|:-----|:-----|
| setTimeout 漂移/休眠唤醒失准 | 触发时对齐校验（now ≥ 目标分钟才触发，否则重算）；分钟级粒度足够 |
| cron 表达式写错 | save 时 parseCron 校验拒绝；UI debounce 预览所见即所得 |
| 同工作流并发触发互踩 runs.json | 引擎 per-workflow 互斥锁（手动/调度共用） |
| 定时自动触发无人工把关误发外部消息 | 用户显式配置即授权；运行日志留痕可查；外部通知类不涉 CON-R028（看板执行 Verify 把关不适用） |
| SMTP 头注入 | to/subject/from 含 CR/LF 直接拒绝 |

## 八、通知优化（2026-09-03 定稿，判级：常规偏复杂 → 方案冻结）

> 需求（用户 2026-09-03）：多个工作流的通知分不清来源；通知多了难找历史。P0（标注+跳转）+ P1（站内通知中心）都做。
> 判级理由：UI 面板 + 跨进程通知 click 接线 + 引擎行为新增；无新子系统/无新存储/无安全面。

### 8.1 P0 通知标注 + 点击跳转 + 失败自动通知

- **标题带来源**：引擎 notify 调用 title = `工作流 · <名称>`（notification 步骤 / token-budget 超限 / 失败自动通知三处统一）。
- **失败自动通知（新增行为）**：run 结束 failed → 系统通知，title `工作流 · <名称>【失败】`，body = 首个失败步骤 message（120 字截断）。手动/定时统一发（异步执行时窗口可能在任何视图，toast 覆盖不了）；成功不发（notification 步骤仍按配置发）。**notifyOnExceed 语义被取代**：超限=步骤失败=run 失败=自动通知，字段保留兼容但不再单独发（避免重复），UI 表单移除该开关。
- **点击跳转**：系统通知 click → 聚焦主窗口 + 切工作流视图（复用 winMgr.showWorkflows()，与 nav 点击同路径，主进程单一事实源）。winMgr 晚于引擎构造 → notify 闭包持有晚绑定引用。

### 8.2 P1 站内通知中心

- **入口**：侧边栏 nav 区「工作流」项下铃铛按钮 + 红色数字角标。角标 = 未读**失败**数（成功不计数，防定时高频成功常亮）；打开面板即清零（localStorage `workflows:notifLastReadTs`）。
- **数据**：复用 `workflows:runs`（最近 50 条跨工作流），零新增 IPC/存储/schema。
- **面板**：overlay 弹层（点击铃铛开合，点外部关闭），列表 = 运行倒序，filter chips（全部/仅失败）；行 = 状态点 + 工作流名 + 定时/手动徽标 + 时间 + 消息摘要（失败红显首条错误）。点击行 → 切工作流视图。
- **刷新**：打开面板时拉取；60s 轻轮询刷角标（实时性由 8.1 系统通知承担，角标只做补漏）；工作流视图刷新时顺带刷。
- **UI 规范**：沿用 shell.html --hull-* 令牌体系（docs/ui/ 缺失登记降级，同前例）。

### 8.3 非目标

按工作流的通知开关/免打扰时段 · 通知中心独立持久化（维持 runs.json 50 条）· 多设备同步（O-4）。

### 8.4 实现管道

TDD 核心路径：引擎标题组合 + 失败自动通知（WorkflowEngine.test 扩展）；其余为渲染层胶水（node --check + 手动走查）。工程基线三问全 ✓。
