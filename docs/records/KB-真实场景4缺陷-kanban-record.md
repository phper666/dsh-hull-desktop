# Bug 修复记录：看板真实场景测试 4 缺陷（新建列 / Blocked 落列 / ✓ 刷新 / 视图记忆）

> 日期：2026-09-03 · 类型：Bug（散任务，复杂管道） · 关联规则：CON-R020（语义不变）、Q-027/Q-053（语义不变）、CON-R-timeline-005（落地修复） · 驱动：真实场景测试（Playwright Electron 全真实壳，31 场景，2026-09-03）

## 判级

- **复杂**（跨 5 层：store / IPC 白名单×2 / preload / renderer / WindowManager；新增 IPC 原语属契约面变化）→ 完整管道：测试（单测补断言+新增用例、回归 e2e 4 用例、真实场景脚本 31 场景）→ typecheck（tsc）→ AI review（solo 算数）→ Semgrep 无工具跳过（非安全敏感，风险项记录）

## 现象（真实场景测试发现，此前单测 852 + 存量 e2e 全绿）

| # | 级别 | 现象 | 根因 |
|:--|:--|:--|:--|
| BUG-1 | P1 | 「列管理→＋新建列」100% 弹「创建失败：列不存在」 | renderer `promptNewColumn` 走 `updateColumn(boardId, null, {name})`，store 无创建列原语，columnId=null 必抛 store-not-found |
| BUG-3 | P1 | 拖卡进 Blocked 列卡片原地不动，Blocked 列计数恒 0 | `moveTask` blocked 分支只写 `blockedFromColumnId`，漏 `task.columnId = toColumnId`；K16 单测只断言元数据字段故漏网 |
| BUG-2 | P2 | Verify 列「✓ 确认完成」后卡片不移动（数据已落 Done） | `data-verify` handler 成功路径缺 `loadBoard`；且视图切换只 `render()` 内存态，分叉到切看板/重启才收敛 |
| BUG-4 | P2 | 视图记忆（Q-053 `kanban:lastView`）跨重启丢失 | 壳页 partition `'shell'` 非持久，localStorage 不落盘；「壳页无持久数据」的设计前提随 Q-053 引入 localStorage 后失效 |

## 修复

| 文件 | 变更 |
|:-----|:-----|
| src/kanban/KanbanStore.ts | blocked 分支补 `task.columnId = toColumnId`（出 Blocked 回来源列 P2-4 语义不变）；新增 `createColumn` 原语（追加列尾、type=null、trim+≤200 校验） |
| src/kanban/KanbanIpc.ts + src/shared/ipc-channels.ts | `kanban:createColumn` channel 白名单同步（18→19，共面 44→45）+ handler 注册 |
| src/preload/index.ts | `createColumn` 桥方法 |
| src/renderer/kanban.js | `promptNewColumn` 改调 `createColumn`；`data-verify` 成功路径补 `await loadBoard` |
| src/window/WindowManager.ts | partition `'shell'`→`'persist:shell'`（Q-053 localStorage 落 userData/Partitions/shell）+ 过时注释更正 |
| docs/api/feishu-b1-m2-kanban-api-contract.md | 增量增补：接口清单 #17 + §12a createColumn + 版本记录（附加性变更） |
| src/kanban/KanbanStore.test.ts | K16/K17 补 columnId 断言；新增 createColumn 生命周期测试 |
| tests/e2e/kanban-bugfix.spec.ts（新增） | 4 缺陷各 1 回归用例（含跨重启双 launch 验证视图记忆） |

## 验证

| 项 | 结果 |
|:---|:-----|
| typecheck + 单测 | ✅ tsc 无错；852/852（含新增用例与计数断言 19/45） |
| 回归 e2e | ✅ kanban-bugfix 4/4 |
| 存量 e2e（分区改动波及面） | ✅ kanban + kanban-timeline 22/22、settings + cold-start 6/6 |
| 真实场景脚本（断言翻转复跑） | ✅ 31/31，零控制台错误/页面异常，boards.json 双向核对一致 |
| lint | ⚠️ 项目无 lint 脚本，跳过（风险项记录，同 PK2 先例） |
| Semgrep | ⚠️ 未安装，非安全敏感跳过（风险项记录） |
| AI review（solo） | ✅ 无新增问题——复查确认：persist:shell 不影响官方 view（独立 webPreferences 默认 session，CON-R001 零注入不变）；e2e 各测试独立临时 userData 无跨测试污染 |

## 遗留/跟进

- 观察项（非缺陷，未处理）：弹窗挂载于 `boardRoot`，任意重渲染会抹掉打开中的弹窗（含未提交内容）且跳过关闭清理栈；看板级操作（删除/重命名看板）与导出/导入有 IPC 桥但无 UI 入口
- Blocked「拖出回来源列、落点忽略」为 P2-4 设计语义，UX 上易误解（拖到 In Progress 实际回 Backlog），留产品确认
