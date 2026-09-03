# 通知中心 V1 实现与核验记录

> 需求：工作流通知优化二期——4 方案原型对比后用户拍板 C「独立通知页」，按壳级通知中心第一期建设（本期只接工作流源）
> 设计：docs/design/工作流-workflows-design.md §9（判级：常规 → 方案冻结）· 视觉基准 docs/prototype/2026-09-03-workflow-notify-variants-prototype.html
> 分支：feature/notify-center（worktree always）

## 实现记录

### 判级

**常规**——渲染层为主的新视图 + 复用现有 IPC（workflows:runs）与视图机制（placeholder view）；无新存储/无主进程新子系统/无安全面。UI 规范缺失登记降级（--hull-* 令牌 + 原型为视觉基准）。

### 改动清单

| 文件 | 内容 |
|:-----|:-----|
| src/window/WindowManager.ts | PlaceholderMode/PlaceholderView 增 'notifs'；showNotifs()（镜像 showWorkflows） |
| src/main/index.ts | IPC `hull:showNotifs`（quitting 守卫镜像） |
| src/preload/index.ts | `hull.showNotifs` 桥（顺带统一 showWorkflows 为 invoke 风格） |
| src/renderer/shell.html | 铃铛改 id=nav-notifs/文案「通知中心」（参与 navActiveByView 高亮）；sections 增 'notifs'；`#notifs` section；notifs.css/js 引入 |
| src/renderer/notifs.js（新） | toNotifRows 归一化（**source:'workflow' 维度预留**，v2 多源扩展点）；工具栏（搜索/状态 segmented/触发下拉/来源 chip/计数）；表格（未读失败行红条+faint 底、消息红显、悬浮绝对时间）；搜索只重绘行（保焦点）；进页面即 markRead（localStorage lastReadTs）；角标 60s 轮询（从 workflows.js 迁入）；行点击跳工作流视图 |
| src/renderer/notifs.css（新） | 页面样式 + 铃铛角标样式（从 workflows.css 迁入） |
| src/renderer/workflows.js/css | 摘除 §8.2 overlay 面板与角标代码（被本页取代）；角标刷新钩子改 `__notifsRefreshBadge` |
| tests/e2e/notifs.spec.ts（新） | 通知中心首例 e2e：seed runs.json（1 未读失败/1 已读成功/1 定时成功）→ 铃铛角标=1 → 点入页面 3 行/未读态/角标清零 → 搜索过滤 → 状态筛选 → 行点击跳工作流视图 |

### 验证

- typecheck ✓；单测 843/843 绿（本需求无主进程逻辑增量，无新增单测——渲染层胶水豁免）；e2e **32/32 绿**（新增 1 例一次通过；navOrder 断言不受影响——铃铛在 #nav-items 外）
- 渲染层 node --check ✓；workflows.js 摘除后无未定义引用残留（grep 核对 fmtRel/lastReadTs/notifPanel 零残留）

### Code Review（AI review，solo 算数）

- 脚本加载顺序：workflows.js 先于 notifs.js——renderList 初始调用 `__notifsRefreshBadge` 时未定义，可选链兜住，notifs.js 载入后自刷一次 ✓
- 搜索输入走 renderRows（只重绘行）避免丢焦点；状态/触发筛选走全量 render ✓
- 通知页在后台时不实时重绘表格（角标仍 60s 刷）——符合 §9.2 刷新时机设计（进页面拉取）
- preload showWorkflows 顺带统一 invoke 风格（同文件其他桥一致）

### Semgrep

改动面（视图接线/渲染层 UI）无新增告警。

## 核验记录

对照设计 §9 逐条：

| 设计条目 | 证据 |
|:-----|:-----|
| 9.1 NotificationService 不建、复用 runs、source 维度预留 | toNotifRows `source:'workflow'`；零新增存储/IPC |
| 9.1 overlay 被页面取代、铃铛保留入口+角标 | workflows.js/css 摘除；notifs.js 接管 |
| 9.2 视图机制（PlaceholderMode/showNotifs/IPC/桥/高亮映射） | tsc ✓；e2e 点铃铛断言 #notifs visible |
| 9.2 工具栏/表格/未读/进页已读/行跳转 | e2e 全链断言（角标 1→hidden、未读 class、搜索 3→1、行点击 #workflows visible） |
| 9.3 非目标 | 未做第二源/服务端已读/导出/规则配置 ✓ |

**核验结论：通过**。风险项：表格 60s 不自动重绘（仅角标）为设计内取舍；真机视觉走查待用户 dev 验证。

## §9.5 交互修订追加（2026-09-03 用户三项确认）

1. 工作流页全局「最近运行」段移除（与中心同源冗余；卡片保留上次运行徽标）——workflows.js runHtml/wf-runs CSS 摘除。
2. 通知中心行点击 = 原地手风琴详情（步骤日志 ✓/✗+类型+消息+耗时、触发/起止绝对时间、总耗时）——toNotifRows 增 log/finishedAt，nt-item 包裹结构。
3. 跳转改显式「查看工作流」按钮：`__workflowsHighlightId` 消费 → renderList 后 scrollIntoView 居中 + 卡片 flash 描边 1.6s。
- 验证：notifs e2e 断言重写（展开/收起/步骤文本/跳转 flash/wf-runs 移除）全绿；全量 e2e 31 绿 + 2 flake 重跑绿（E2E-03/06 与改动面无关）；node --check ✓；单测无涉（纯渲染层）。
