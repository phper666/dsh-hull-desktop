# UI 载体迁移 + 编排层零改动（安全敏感重构的安全边界）

| 项 | 内容 |
|:---|:-----|
| 背景 | M1-重构（m1refactor）把设置独立窗口、升级原生 dialog 收进壳内右侧视图。判级复杂+安全敏感，红线 CON-R005（升级原子性）要求不破坏编排。 |
| 决策或坑 | 用「UI 载体迁移 + 编排层零改动」二分：**主进程编排层**（UpgradeQueue/SwapManager/Updater/HullUpdater 状态机、原子替换、验证、回滚）**零改动**，只删 `dialog.showMessageBox` 调用点、改推送 hull:status 由 shell.html 渲染。升级原子性通过「只删 dialog 调用、状态机不动」达成。 |
| 影响 | 不这样做：编排层与渲染层耦合重构，R005 原子性极易被破坏（改状态机 = 引入回归面）。这样：安全面收敛到「确认/进度/失败提示的呈现载体」，编排层回归风险归零，评审/核验只需盯 UI 载体。 |
| 适用范围 | 任何「把原生 UI（dialog/BrowserWindow）收进壳内/web UI」的重构——安全敏感（资金/数据/权限/原子性）尤甚；不适用需真改编排行为的功能演进。 |
| 来源 | 出生：子需求 m1refactor（S6'/S3'/S8'）+ 来源 PRD 2026-08-14-m1-prd.md；引用：共识 v1.6 §14.1-R、契约 S3 v0.3（CON-R005）、docs/design/M1-重构-壳内视图-m1refactor-design.md §4.5、commit b8d9d10 |
| 引用 | 首次引用：本 lesson 出生（2026-08-22） |
