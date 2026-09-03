# 全绿测试盲区：内存态渲染的写后刷新与无 UI 覆盖通道，只有真实场景双向核对能抓

| 项 | 内容 |
|:---|:-----|
| 背景 | 看板（M2）单测 852 + 存量 e2e（kanban/timeline 全套）全绿，用户要求「真实场景测试」后，自建 Playwright Electron 全真实壳脚本（31 场景，每步操作同时核对 DOM 与 boards.json 落盘），一轮抓出 4 个真 bug（2 P1 + 2 P2），其中「新建列 100% 失败」「卡片永不进 Blocked 列」属功能完全不可用级 |
| 决策或坑 | 坑有三层叠加：① **渲染层是「内存态 currentBoard + 整页 innerHTML 重渲染」架构**，写操作成功后必须显式重取数据（loadBoard）——漏掉的写 handler（✓ 确认完成）数据已落盘但 UI 分叉，且视图切换只 render() 内存态不救；② **无 UI 覆盖的 IPC 通道传参错误零告警**——promptNewColumn 拿 updateColumn(columnId=null) 当创建用，preload patch 类型是 unknown、TS 不报错、运行时才 store-not-found；③ **单测断言元数据字段漏主字段**——moveTask 进 Blocked 只断言 blockedFromColumnId，没断言 columnId 本身，主功能（落列）坏了测试照样绿。存量 e2e 只测渲染路径（列渲染/视图切换/markdown），列管理与 Blocked 拖入无 e2e |
| 影响 | 不这样做：功能不可用级 bug 随版本发布（新建列自功能合入起就是坏的）；每个写 handler 都可能复制「✓ 不刷新」模式；壳页 partition 非持久这类「设计前提被后续需求（Q-053 localStorage）悄悄打破」的腐化无检测点。修复成本事后 >1 天（定位 + 全链路补原语 + 三层测试），场景测试当天即可暴露 |
| 适用范围 | 适用：本项目壳内所有「内存态渲染 + IPC 原语」的 renderer 模块（tokens/skills/connections/workflows 同构）与任何 Electron 壳的 UI 测试策略——验收口径 = 真实壳场景测试（操作后 UI/DOM 与落盘双向核对），单测须断言主字段而非仅元数据，新增写 handler 对照「成功路径是否重取数据」检查单。不适用：纯计算/聚合逻辑（单测足够）、官方 Web UI（CON-R001 零注入不可测） |
| 来源 | 出生：散任务「看板真实场景测试 4 缺陷修复」（docs/records/KB-真实场景4缺陷-kanban-record.md）+ 来源 PRD（2026-08-19-m2-kanban-prd.md）；引用：B1 契约版本记录 2026-09-03 行、变更摘要-M2看板 2026-09-03 条、kanban-bugfix.spec.ts（回归载体）、KanbanStore.test.ts K16/K17（主字段断言先例） |
| 引用 | 首次引用：本记录（KB record 验证节 + tests/e2e/kanban-bugfix.spec.ts 场景设计）；后续复用 +1 待记（下一个 renderer 模块场景测试/写 handler 评审时引用） |
