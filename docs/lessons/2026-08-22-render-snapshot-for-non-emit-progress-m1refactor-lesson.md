# 渲染侧消费既有快照补足编排层不 emit 的进度

| 项 | 内容 |
|:---|:-----|
| 背景 | M1-重构（m1refactor）升级确认流壳内化后，升级进度条依赖 hull:status 推送渲染。发现 `Updater.this.pct` 中间值（50/90/95）**不独立 emit** status 事件——仅 `transition()` 末尾 emit，且顺序「先 transition（pct 旧值）→ 后赋 pct」。 |
| 决策或坑 | 编排层 `this.pct` 赋值点不伴随 emit（Updater 不订阅 overlay 'progress'，overlay 细粒度进度不流入 snapshot）。若渲染只依赖事件推送，进度会卡在 transition 边界步进（installing 50% → swapping 90%），非平滑。**解法：渲染侧 250ms tick 消费既有 `getDshStatus()` 实时快照补重渲**——编排层零改动（CON-R005）下补 UI 实时性。 |
| 影响 | 不这样做：进度条卡「准备…」或步进跳变，用户误以为升级卡死。这样做：进度按 250ms 实时刷新，无需改编排层。注意代价：依赖轮询频率，细粒度 npm 进度（overlay installStatus.progress）仍未透传——如需可后续加订阅，YAGNI 不预做。 |
| 适用范围 | 编排层是黑盒/冻结（契约锁定零改动）时，渲染侧补 UI 实时性的通用手法——任何「事件推送携带粗步进、有实时快照可用」的场景；不适用编排层允许改动且需平滑进度的场景。 |
| 来源 | 出生：子需求 m1refactor（S3'）+ 来源 PRD 2026-08-14-m1-prd.md；引用：src/updater/Updater.ts（transition emit 语义，line 360/236/250/272/286）、docs/design/M1-重构-壳内视图-m1refactor-design.md §4.5、commit dbe5309（P2/M4 修复） |
| 引用 | 首次引用：本 lesson 出生（2026-08-22） |
