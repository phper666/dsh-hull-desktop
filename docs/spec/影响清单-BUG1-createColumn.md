# 影响清单（BUG-1 新增 kanban:createColumn，2026-09-03）

> 触发：看板真实场景测试 BUG-1 修复新增 IPC 原语（变更传播 Phase 2/3；附加性变更，AI 直接自动更新）。
> 详情见 docs/records/KB-真实场景4缺陷-kanban-record.md。

| 受影响产物 | 路径/ticket | 处理方式 | 责任人 | 状态 |
|:-----------|:------------|:---------|:-------|:-----|
| B1 契约 | docs/api/feishu-b1-m2-kanban-api-contract.md | 已自动更新（接口清单 #17 + §12a + 版本记录） | liyuzhao（solo） | 已确认 |
| IPC 白名单（shared + KanbanIpc 双份） | src/shared/ipc-channels.ts · src/kanban/KanbanIpc.ts | 已同步（18→19；计数断言更新 44→45） | liyuzhao（solo） | 已确认 |
| preload 桥 | src/preload/index.ts | 已同步（createColumn 方法） | liyuzhao（solo） | 已确认 |
| B2 契约（看板 UI） | docs/api/feishu-b2-m2-kanban-api-contract.md | 核对不涉及——UI 行为修复，无接口/场景变化 | liyuzhao（solo） | 已核对 |
| B3 契约（执行引擎） | docs/api/feishu-b3-m2-kanban-api-contract.md | 核对不涉及——moveTask blocked 分支补 columnId 属 B1 数据层语义澄清，引擎消费的「出 Blocked 回来源列」行为不变 | liyuzhao（solo） | 已核对 |
| 测试矩阵 | KanbanStore.test.ts（K16/K17 补断言）+ tests/e2e/kanban-bugfix.spec.ts（新增 4 用例） | 已更新并全绿 | liyuzhao（solo） | 已确认 |
