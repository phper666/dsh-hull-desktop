# 工作流通知优化 实现与核验记录

> 需求：工作流通知分不清来源 + 历史难找（用户 2026-09-03）
> 设计：docs/design/工作流-workflows-design.md §8（判级：常规偏复杂 → 方案冻结）
> 分支：feature/workflow-notify（worktree always）

## 实现记录

### 判级

**常规偏复杂**——UI 面板 + 跨进程通知 click 接线 + 引擎行为新增；无新子系统/无新存储/无安全面。UI 规范缺失登记降级（沿用 shell.html --hull-* 令牌，同前例）。

### 改动清单

| 文件 | 内容 |
|:-----|:-----|
| src/workflows/WorkflowEngine.ts | ①notify 标题带工作流名 `工作流 · <名称>`（notification 步骤 + 失败自动通知统一，runStep 参数传递不走实例字段——不同工作流可并发跑，字段会互踩）；②run 失败自动通知：title `…【失败】`，body 首条失败 message 截断 120 字；③notifyOnExceed 语义被失败自动通知取代（超限=步骤失败=自动通知），字段保留兼容不再单独发 |
| src/main/index.ts | 系统通知挂 click → 聚焦主窗口 + 切工作流视图（winMgr.show/focus/showWorkflows，复用 nav 同路径）；winMgr 晚于引擎构造 → `winMgrRef` 晚绑定引用，构造后回填 |
| src/renderer/shell.html | 侧边栏「通知」铃铛按钮（nav-items 与 nav-status 之间）+ 红色数字角标 `wf-badge-dot` |
| src/renderer/workflows.js | 角标逻辑（未读失败数 = status=failed 且 startedAt > localStorage `workflows:notifLastReadTs`；60s 轻轮询 + renderList 顺带刷）+ overlay 通知面板（全部/仅失败 chips、行=状态点+工作流名+定时徽标+相对时间+消息摘要、点击行切工作流视图、点外部关闭、打开即清角标）+ token-budget 表单移除 notifyOnExceed 开关 |
| src/renderer/workflows.css | 铃铛角标 + 面板样式（面板 left 212px 对齐 nav 200px 硬编码宽） |

### 验证

- typecheck ✓；单测 **843/843 绿**（引擎新增/改造 4 用例：标题标注、失败自动通知、成功不发、120 字截断）；e2e **31/31 绿**（铃铛在 #nav-items 外，navOrder 断言不受影响）
- 渲染层 node --check ✓（按 09-02 lesson 检测法核对他视图函数名残留：无）

### Code Review（AI review，solo 算数）

- **修复（实现中期）**：notifyTitle 原用实例字段承载——互斥是 per-workflow 的，不同工作流并发跑会互踩标题；改 runStep 参数传递。
- **修复（review）**：面板定位原写 `var(--hull-nav-width, 188px)`，实际 nav 是 200px 硬编码无该 token → 改 212px 并注记来源。
- 失败自动通知 try/catch 包裹（通知失败不影响运行记录落盘）；成功路径零通知（显式 notification 步骤除外）。
- 面板 chip/row 事件委托 + document click 关闭（豁免铃铛自身）；双击铃铛 toggle 语义正确。

### Semgrep

本次改动面（引擎通知/main 接线/渲染层 UI）无新增告警；Connections 模块 2 条存量已接受风险不受影响。

## 核验记录

对照设计 §8 逐条：

| 设计条目 | 证据 |
|:-----|:-----|
| 8.1 标题带来源（三处统一） | 引擎测试：步骤通知 `工作流 · 夜巡:开始`；失败 `工作流 · 夜巡【失败】:` |
| 8.1 失败自动通知（手动/定时统一、成功不发、截断 120） | 引擎测试 4 用例 |
| 8.1 notifyOnExceed 被取代（置不置都发、UI 移除开关） | 引擎测试 2 分支 + workflows.js 表单 |
| 8.1 点击跳转（聚焦+切视图，晚绑定） | main 接线；e2e 全绿（壳启动无回归）；真机点击待用户 dev 验证 |
| 8.2 角标=未读失败数/打开清零/localStorage | workflows.js；成功不计数防常亮 |
| 8.2 面板（chips/行/跳转/点外关闭） | workflows.js + css；node --check；真机走查待用户 dev 验证 |
| 8.2 零新增 IPC/存储 | 复用 workflows:runs + localStorage，无 schema 变更 |
| 8.3 非目标 | 未做按工作流通知开关/独立持久化/同步 ✓ |

**核验结论：通过**。风险项：通知点击跳转与面板交互属运行时行为，自动化覆盖有限（e2e 无 workflows 视图用例），依赖用户 dev 验证环节。
