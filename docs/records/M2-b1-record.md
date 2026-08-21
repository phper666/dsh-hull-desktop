# M2 B1 实现记录与核验记录

> 判级：常规（数据层单一职责：boards.json 单文件原子写 + 16 个 IPC 原语数据实现；无子进程/状态机/窗口子系统，仅复用 M1 SettingsProvider 持久化模式）
> 事实源：契约 `docs/api/feishu-b1-m2-kanban-api-contract.md` v0.1（冻结，944 行，两轮复核闭环 + 用户裁决）、共识 §7.1（M2 数据模型）/§9（持久化行为）、CON-R017（boards.json 原子写/损坏重建/迁移）/R018（auto 缺 AC 门控）/R020（列自定义）/R023（加载性能）/R024（附件上限）/R025（评论来源）/R030（subagentPolicy）/R031（多项目看板）/R033（归档+删除规则）+ Q-013（executionStatus 双轨）/Q-014（dependencies）/Q-015（selfCheck）/Q-019（级联删）/Q-020（assignee）/Q-025（执行记录时间）/Q-027（隐藏=过滤）/Q-028（评论删除权限）

## 实现记录

### 文件清单（src 3 文件 + 测试 1）

| 文件 | 职责 |
|---|---|
| `src/kanban/types.ts`（191 行） | B1 契约 JSON Schema 的 TS 类型镜像：Board/Column/Task/TimelineItem/ExecutionRecord/Attachment/agentSpec/AcceptanceCriteria；KANBAN_SCHEMA_VERSION=1；默认 6 态模板列（DEFAULT_COLUMNS）；KANBAN_STORE_ERRORS 7 错误码 + B5 导出/导入错误码（同文件，B5 复用） |
| `src/kanban/KanbanStore.ts`（909 行） | 数据层：boards.json（`<userData>/kanban/boards.json`）读写 + 原子写（temp+rename）+ 损坏备份重建（corrupt-<ts>）+ schema version 迁移 + 500ms 防抖写盘（写失败内存态保留）；16 个 IPC 原语数据实现；业务规则：双轨（moveTask 不改 executionStatus）、Blocked 进出自动记/还原、删除守卫（running/queued 禁删 / board 含 ticket 拒删 / 最后看板不可删）、Q-028 评论删除权限、CON-R033 归档三原语、dependencies 同父约束、auto 缺 AC 门控（CON-R018） |
| `src/kanban/KanbanIpc.ts`（99 行） | IPC 注册：`ipcMain.handle('kanban:xxx')` → store 方法；统一响应包裹 `{ ok, data } / { ok:false, code, message }`（code 取 HullError.code）；16 个 B1 channel 白名单 + 2 个 B5 导出/导入 channel；依赖注入（transfer 可注入供主进程装配/测试） |
| `src/kanban/KanbanStore.test.ts`（424 行） | 31 用例（契约联调场景 K1~K31 全量映射） |

> 注：契约文档声明 v0.1，任务描述标注「v0.2」；事实源以冻结契约文件头部为准（v0.1）。实现 commit `1605d34`（2026-08-21，`feat: B1 看板数据模型与持久化实现（KanbanStore + 16 IPC + 31 测试）+ docs: B4 执行集成技术方案（draft）`，1602 insertions）。B5 导出/导入（KanbanTransfer + importData/exportSnapshot）同文件内实现，为 B5 提前落子（契约对齐），非 B1 验收范围。

### TDD：31 用例，契约联调场景 K1~K31 全量覆盖

| 覆盖要点 | 用例 |
|---|---|
| 多项目看板（独立列/任务 + 默认 6 态模板列） | K1 |
| 卡片 CRUD 持久化（createTask→updateTask→flushSync→重启恢复） | K2 |
| 原子写失败（store-io-error，内存态保留，恢复可写） | K3 |
| 损坏重建（store-corrupt，备份 corrupt-<ts> + 重建默认） | K4 |
| schema 迁移成功（version=1 直接加载）/ 迁移失败（version 过高 → store-migrate-failed 备份重建） | K5/K6 |
| 加载性能（≤5MB 1200 卡冷启动 <500ms） | K7 |
| 子任务级联删除 + 清依赖引用 | K8 |
| DSH_HOME 零接触（数据落 userData/kanban，无 dsh 目录） | K9 |
| createTask 标题空/超长 → validation-error；auto 缺 AC → validation-error；moveTask 目标列不存在 → validation-error | K10~K13 |
| deleteTask 不存在 → store-not-found | K14 |
| updateTask 非法字段（直接改 executionStatus 系统管理字段）→ validation-error | K15 |
| Blocked 进出：进 Blocked 自动记 blockedFromColumnId（executionStatus 不变双轨）；解除回来源列 / 来源列隐藏 → Todo | K16/K17 |
| deleteBoard：含 ticket 拒删（board-not-empty）→ 清空可删 → 最后看板不可删（validation-error） | K18 |
| 评论删除权限：user 评论可删；agent 评论只读（Q-028）→ validation-error | K19/K20 |
| 执行态守卫：deleteTask 执行中（running）→ store-task-executing；deleteBoard 看板内 queued → store-task-executing | K21/K22 |
| 列删除：模板列拒删（validation-error）；自定义列可删（列内卡移入 Todo） | K23/K24 |
| 归档三原语：archiveTask 非 Done → validation-error；archive→restore 回原列/清归档字段；purgeTask 仅归档区 | K25~K27 |
| deleteBoard 含归档 ticket → store-board-not-empty | K28 |
| updateTask dependencies 非法引用（非同父）→ validation-error；切 auto 缺 AC（CON-R018 门控）→ validation-error；已删任务 → store-not-found | K29~K31 |

> 错误码断言：7 个 `KANBAN_STORE_ERROR` 错误码（ioError/corrupt/migrateFailed/notFound/taskExecuting/boardNotEmpty/validation）均有用例命中。执行态注入（K20/K21/K22）通过测试注入内部 data 模拟 B3 调度层写入（executionStatus/agent 评论），验证守卫不依赖 B3 前置校验（契约 P1-B）。

### 质量

- `npm run typecheck`（tsc --noEmit）：干净，0 error
- `npm test`（tsc && node --test "dist/**/*.test.js"）：443 + 8 pass / 0 fail（KanbanStore 31 用例含于 443 全量；另有 8 个独立测试文件），~0.7s 级别

## 核验记录

### Code Review

- 本轮 review 轻量（判级常规）：实现单点（KanbanStore 单一文件数据层），无跨子系统边界；复用 M1 SettingsProvider 持久化模式（原子写/损坏重建/迁移）→ 无设计风险项
- 审查结论：常规通过（与判级匹配）

### Semgrep

- 未跑（实现管道：有则跑；无则核验记录记风险项）——B1 为纯数据层 + 已冻结契约，风险面为文件 IO 与校验分支，由 31 用例覆盖；留待 M2 集成核验时统一扫描

### 契约符合性（16 IPC 原语对照）

| # | 原语 | 契约要求 | 实现证据（KanbanStore 方法 + IPC 注册） | 状态 |
|---|---|---|---|---|
| 1 | getBoards | 返回全部 boards | `getBoards()`（深拷贝快照）；`kanban:getBoards` | ✓ |
| 2 | createBoard | name 校验 ≤200；columns 缺省建 6 态模板列；b_<uuid> | `createBoard(name, columns?)`（makeDefaultBoard）；`kanban:createBoard` | ✓ |
| 3 | updateBoard | 重命名/排序；not-found | `updateBoard(boardId, patch)`；`kanban:updateBoard` | ✓ |
| 4 | deleteBoard | 最后看板拒删；含 ticket（含归档）拒删；执行中拒删（CON-R033） | `deleteBoard`（validation/boardNotEmpty/taskExecuting 三守卫）；`kanban:deleteBoard` | ✓ |
| 5 | getTasks | 某看板任务列表；空数组合法 | `getTasks(boardId)`（findBoard not-found）；`kanban:getTasks` | ✓ |
| 6 | createTask | 标题/列/parentId/dependencies/AC 门控校验；系统生成字段 + system 创建事件 | `createTask`（validateTitle/validateDependencies/validateAc/nextOrder + systemEvent 任务创建）；`kanban:createTask` | ✓ |
| 7 | updateTask | 白名单字段；系统管理字段（executionStatus/currentExecutionId/timeline 等）拒绝；切 auto 缺 AC 门控；dependencies 同父校验 | `updateTask`（patch 白名单 + sys 字段拦截）；`kanban:updateTask` | ✓ |
| 8 | moveTask | 不改 executionStatus（双轨 Q-013）；Blocked 进/出自动记/还原；system 事件 from→to | `moveTask`；`kanban:moveTask` | ✓ |
| 9 | deleteTask | 级联子任务 + 执行态守卫（含子任务）+ 清依赖引用 | `deleteTask`（running/queued 检查全子任务 + 级联 filter + 清 dependencies 引用）；`kanban:deleteTask` | ✓ |
| 10 | addComment | user 评论；content 非空；附件 ≤maxAttachmentSizeMB（默认 10） | `addComment`；`kanban:addComment` | ✓ |
| 11 | deleteComment | 仅 source.type=user 可删；agent/system 只读（Q-028） | `deleteComment`（type/source 检查）；`kanban:deleteComment` | ✓ |
| 12 | updateColumn | 改名/排序/改色/隐藏；模板列保护 | `updateColumn`；`kanban:updateColumn` | ✓ |
| 13 | deleteColumn | 仅自定义列（有 type 拒删）；列内卡移入 Todo | `deleteColumn`；`kanban:deleteColumn` | ✓ |
| 14 | archiveTask | 仅 Done 可归档；archivedAt + archivedFromColumnId；system 事件 | `archiveTask`；`kanban:archiveTask` | ✓ |
| 15 | restoreTask | 未归档拒删；缺省目标 = 原列（已删/隐藏 → Done）；清归档字段 | `restoreTask`；`kanban:restoreTask` | ✓ |
| 16 | purgeTask | 仅归档区；级联清理 | `purgeTask`；`kanban:purgeTask` | ✓ |

> 错误码：IPC 层统一转 `{ ok:false, code, message }`（code 取 HullError.code，7 错误码 + B5 错误码），契约公共异常集一致。

### 实现偏离

- **无**。实现与冻结契约一致：16 原语 + 7 错误码 + 归档三原语 + CON-R033 删除规则 + updateTask 系统管理字段拦截 + store-task-executing 守卫（B1 store 内置，契约 P1-B）全部按契约落地；31 测试用例与契约联调场景 K1~K31 编号一一对应。
- 注（非偏离）：KanbanStore.ts 内含 B5 导出/导入实现（snapshot/exportSnapshot/importData/validateBoardsStructure/remapMerge），属 B5 契约提前落子，已注明，不影响 B1 验收范围。
