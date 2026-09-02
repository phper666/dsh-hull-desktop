# 工作流 v2 实现与核验记录

> 需求：工作流 v2——cron 定时触发 + connection-action（工作台连接联动）+ token-budget（Token 预算告警）
> 设计：docs/design/工作流-workflows-design.md §7（判级：复杂 → 方案冻结）
> 分支：feature/workflows-v2（worktree always）

## 实现记录

### 判级

**复杂**。理由：①调度子系统（cron 解析 + 主进程定时编排：生命周期/漂移/超长 delay 分片/错过策略）②凭据安全敏感面（平台能力调用，main 侧解密，外部副作用）③渲染层编辑器 UI 增量（触发区 + 两种新步骤表单）。

### 工程基线三问

git ✓（worktree feature/workflows-v2）· 脚手架 ✓（Electron + tsc 既有）· 测试框架 ✓（node:test + Playwright 既有）。

### 改动清单

| 文件 | 内容 |
|:-----|:-----|
| src/workflows/cron.ts（+test） | 5 字段 cron 解析器（\*/,-/ 语法、7→0 归并、vixie DOM/DOW 或语义）+ cronNext（日扫描 + 当日时点扫描，严格大于 from，6 年兜底） |
| src/workflows/types.ts | WorkflowStepType 增 connection-action/token-budget；WorkflowDef.trigger?（字段级扩展不 bump version）；WorkflowRun.trigger（manual/cron）；WORKFLOW_STEP_TYPES 注册 |
| src/workflows/WorkflowEngine.ts | per-workflow 互斥锁（手动/定时共用）；connection-action 步骤（params JSON 对象校验 + invokeAction DI）；token-budget 步骤（period 日历对齐 + 阈值 + 超限 notify+fail-fast）；run(id, source) 触发来源按次传递 |
| src/workflows/WorkflowScheduler.ts（+test） | 定时调度器：reschedule 全量重算 / 超长 delay 按 2^31-1 分片（到点对齐校验，未达目标分钟只重排）/ 错过不补跑 / engine 抛错吞掉留日志仍重排 / dispose |
| src/workflows/WorkflowStore.ts（+test） | save 校验 trigger（parseCron 拒非法）；trigger 持久化 + 清除（null）；v1 存量无 trigger 读侧容错 |
| src/workflows/WorkflowIpc.ts | workflows:cronPreview（校验 + 下 3 次预览，渲染层零解析）；list 注入 nextRunAt；save/delete 后 reschedule |
| src/connections/Actions.ts（+test） | 能力层：sendAliyunSms（SendSms 签名复用）/ sendTencentSms（TC3 复用，SendStatusSet 逐号判定）/ sendSmtp（AUTH 双 334 + MAIL/RCPT/DATA 点填充 + RFC2047 主题）/ maskRecipient（收件人掩码）/ invokeConnectionAction 派发（salesforce 明确不支持） |
| src/connections/PlatformRegistry.ts | buildAliyunSignedQuery 参数化（action+业务参数；buildAliyunQueryString 委托兼容）；sendFetch 30s；**顺带修复 v1 verifySmtp 的 AUTH 状态机 bug**（漏第二次 334 密码挑战，认证路径从未被真实验证过） |
| src/main/index.ts | 引擎装配 invokeAction（getCredentials 解密→Actions）/ tokenUsage（scanAllSources+summarize）；调度器创建 + 启动排期 + before-quit dispose |
| src/preload/index.ts | workflows.cronPreview 桥 |
| src/renderer/workflows.js/css | 列表「下次运行」+ 运行记录定时徽标；编辑器触发区（手动/cron radio + 表达式输入 + 300ms debounce 预览/错误）；connection-action 表单（连接下拉过滤三平台 + 按平台动态参数）；token-budget 表单；**顺带删除 void loadList 死引用**（lesson 同款，main 上由 feature/ui-polish 持有修复，本分支重写自然消除） |
| tests/e2e/cold-start.spec.ts | **顺带修复存量断言漂移**：navOrder 补 nav-tokens/nav-connections/nav-workflows（tokens/connections/workflows v1 上线时未更新，main 上 E2E-01 已红） |
| tests/e2e/settings.spec.ts | **顺带修复存量断言漂移**：T2 显式 seed theme=dark（CON-R-theme-004 默认改 system 后，未设置 theme 跟随 OS 导致默认断言不稳） |

### 验证

- typecheck ✓ 干净
- 单测 **840/840 绿**（新增 cron 11 + Actions 8 + 引擎 5 + 调度器 8 + store 3）
- 集成 8/8 绿；e2e **27/27 绿**（含两处存量漂移修复后）
- SMTP 状态机用本地 net 假服务器真实 socket 集成测（断言信封命令 + DATA 内容 + 点填充 + RFC2047）

### Code Review（AI review，solo 算数）

- **修复**：triggerSource 原设计为引擎级静态 dep——cron 触发的运行也会标 manual。改为 run(id, source) 按次参数，调度器传 'cron'，IPC 手动运行缺省 'manual'（补测试断言）。
- maskRecipient 对 +86 前缀归一（13 位以上剥 86）后掩码。
- 渲染层全部插值过 esc()；cronPreview 结果经 textContent 注入；params 重建式序列化（清空字段即移除键）。
- 调度器 fire 后无论成败重排（deleted workflow 由下次 reschedule 收敛）。

### Semgrep

2 条 `bypass-tls-verification`（verifySmtp 存量 + sendSmtp 同款）：SMTP 用户服务器普遍自签证书，strict TLS 会让连接大面积失败；**登记为已接受风险**（MTM 风险面=SMTP 明文凭据，与 v1 验证路径一致）；后续可加「严格 TLS」开关。非本次新增风险面。

## 核验记录

对照设计 §7 逐条（工作流无独立契约/PRD，设计文档为事实源）：

| 设计条目 | 证据 |
|:-----|:-----|
| §7.1 trigger 字段级扩展不 bump version | WorkflowStore.test：version===1 断言 + v1 存量加载容错 |
| §7.1 cron 解析器/或语义/7=0 | cron.test 11 用例（含 2/29 闰年、跨年、OR 语义） |
| §7.1 调度器（分片/不补跑/互斥吞错/dispose） | WorkflowScheduler.test 8 用例 |
| §7.1 cronPreview IPC + list nextRunAt | WorkflowIpc 实现；渲染层 debounce 预览消费 |
| §7.2 三平台能力 + salesforce 拒绝 | Actions.test（fake fetch + 本地假 SMTP 服务器）；invokeConnectionAction 派发 |
| §7.2 安全（main 侧解密/掩码/头注入防护/连接不存在报错） | main 装配 getCredentials 单点；maskRecipient 单测；CRLF rejects 单测；引擎缺连接报错单测 |
| §7.3 token-budget（日历对齐/超限 fail+notify/未装配报错） | 引擎测试 4 分支 |
| §7.4 UI（列表下次运行/触发区/两新表单） | workflows.js 重写；node --check 语法过；e2e 无 workflows 选择器（无回归面） |
| §7.5 非目标 | 未实现事件触发/变量模板/补跑/salesforce 动作/画布 ✓ |

**核验结论：通过**（判级匹配复杂；设计/实现/测试三层一致；存量漂移修复已登记于改动清单）。
风险项：semgrep 2 条已接受风险（如上）；cron 调度依赖壳常驻（托盘常驻模式，T1-06 语义），壳退出即停调度（重启后错过不补跑）——符合设计定案。
