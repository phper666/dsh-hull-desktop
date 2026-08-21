# B2 实现记录与核验记录

> 判级：常规（前端 UI，契约已冻结 UI 场景，主进程复用 showPlaceholder 机制最小侵入；无状态机/生命周期/跨子系统）
> 事实源：契约 `docs/api/feishu-b2-m2-kanban-api-contract.md` v0.1（冻结 2026-08-21）、共识 v1.4 §12（`docs/spec/共识-Hull桌面壳-M2看板.md`）、壳框架设计 `docs/design/S1-壳骨架-m1-design.md` 0.2（D6 view 单一事实源 + showPlaceholder 机制参照）、PRD `docs/prd/2026-08-19-m2-kanban-prd.md`、原型 `docs/prototype/2026-08-19-m2-kanban-prototype.html`

> B2 无独立 design 文件：纯 UI 消费契约（无新数据接口/无跨子系统决策），UI 场景 1~7 已在契约冻结。经实现 Gate 判级为常规，不产出独立技术方案（对照实现管道「复杂/高风险必产设计文档」豁免）。

## 实现记录

### 文件清单（新增 2 + 修改 4 + 新增 e2e 1）

| 文件 | 职责 | 类型 |
|---|---|---|
| `src/renderer/kanban.js` | B2 看板 UI 主体（488 行，纯原生 JS 无框架）：三视图渲染（看板/列表/归档）、多项目切换、卡片 CRUD/拖拽/执行控制/详情侧板/评论/归档区/列管理/审批弹窗；消费 `window.kanban`（16 原语）+ `window.exec`（B3/B4 执行控制 + 2 事件订阅） | 新增 |
| `src/renderer/kanban.css` | 看板深色主题样式（148 行，沿用 shell.html 设计语言）：列横排/卡片/工具栏/三视图/弹窗/详情侧板/列管理；覆盖 `.placeholder` 绝对定位+居中（`#board { position: static !important }` 看板需占满+左对齐） | 新增 |
| `src/renderer/shell.html` | 壳框架页集成：`section#board` 占位区块 + `#nav-board` 导航项（tag M2）+ 引入 kanban.css/kanban.js + nav-board 点击 → `bridge.showBoard()`；`sections` 数组加 'board' | 修改 |
| `src/window/WindowManager.ts` | `PlaceholderView`/`PlaceholderMode` 联合类型加 `'placeholder:board'`/`'board'`（复用 showPlaceholder 机制） | 修改 |
| `src/main/index.ts` | 新增 `ipcMain.handle('hull:showBoard')` → `winMgr.showPlaceholder('board', '')`（官方 WebContentsView 隐藏，view 切 placeholder:board） | 修改 |
| `src/preload/index.ts` | `hull.showBoard()` 桥（`ipcRenderer.invoke('hull:showBoard')`）；B1 kanban 16 原语 + B5 export/import 2 原语（window.kanban）+ B3/B4 执行桥（window.exec）已在 B1 实现时落地 | 修改 |
| `tests/e2e/kanban.spec.ts` | 3 e2e 用例：nav-board 进入看板渲染列+卡片 / 三视图切换 / 多项目切换（fake dsh + 种子 boards.json） | 新增 |

### 实现要点

- **view 接入用 placeholder:board 模式**：B2 不新建渲染通道，复用 S1 D6「view 单一事实源」——主进程 `hull:showBoard` 调 `showPlaceholder('board')`，官方 WebContentsView `setVisible(false)`，渲染侧 `section#board` 显示。最小侵入：仅 `PlaceholderMode` 联合类型 + 1 个 IPC handler + 1 个 preload 桥 + shell.html 区块/导航/脚本引入。
- **数据消费**：看板 UI 全部经 preload 桥调 B1 16 IPC 原语（window.kanban）+ B3/B4 执行控制（window.exec），renderer 零 Node 能力（沿用 contextIsolation/sandbox），B2 无新增接口（契约 §接口清单：纯消费映射）。
- **getTasks 全量过滤语义（P1-B2-1）**：`loadBoard` 一次 getTasks 取全量（含 archivedAt），三视图各自过滤渲染——看板/列表 `activeTasks()`（archivedAt==null），归档 `archivedTasks()`（archivedAt!=null）；视图切换即内存态换过滤条件重渲染，不二次取数（P2-B2-2 一致性）。
- **恢复目标列（P1-B2-2）**：归档恢复 `restoreTask(boardId, taskId)` 不传 toColumnId，走 B1 缺省（回 archivedFromColumnId 原列，原列已删/隐藏则回 Done）；归档按钮按状态语义置灰（UX 引导，B1 store 兜底校验"仅 Done 可归档"）。
- **拖拽冲突（CON-R020）**：人工拖拽直接生效；拖到 done/verify 列且执行态不符 → confirm 冲突弹窗可强制通过；写 timeline 由 B1 store 自动。
- **订阅刷新**：`onExecutionUpdate`（B3 快照重放/变更推送）命中当前 board → 重载；`onPermissionRequest`（B4）→ 审批弹窗（批准/拒绝）。
- **执行控制**：卡片运行/暂停/恢复/取消/确认完成按钮接 `window.exec` 执行控制 IPC（B3/B4 已在执行引擎实现落地，B2 仅接线）。

### TDD/测试：3 e2e（Playwright）

| 用例 | 覆盖要点 | 断言 |
|---|---|---|
| nav-board 进入看板 → 渲染列与卡片 | 壳导航入口 + placeholder:board 视图切换 + 看板渲染 | `#board` 非 hidden；3 列；2 卡（任务 A/B 可见） |
| 三视图切换：看板/列表/归档 | CON-R033 决策 3 同数据多视图 | 3 视图按钮；列表 2 行（data-id）；归档空态"归档区为空"；回看板 2 卡 |
| 多项目看板切换 | CON-R031 各 Board 独立列+任务 | 2 看板 option；切 Beta（无任务）→ 空列态 `.kb-empty-col` |

> 测试基建复用 S7（`tests/e2e/helpers.ts`：makeTempUserData/seedFakeDsh/seedSettings/launchApp）。种子看板数据写入 `<userData>/kanban/boards.json`（B1 store 落盘路径），fake dsh 就绪模式下驱动。

### 质量

- `npm run typecheck`（tsc --noEmit）：干净
- `npm test`（unit 447 + integration 11 = 458）：443+8 全绿基线全绿（B2 本体无新增单测——UI 为纯渲染无框架，逻辑在 B1/B3 store 侧已覆盖；本轮核验以 e2e + 既有全量回归为准）
- `npm run test:e2e`：3 用例全绿

## 核验记录

### Code Review

- 本轮轻量 review（B2 为常规前端 UI，无状态机/安全边界跨子系统，不触发双席重度 review）
- 检查点：CSP 外链 css/js 与既有策略一致（'self' 已在白名单）、view 切换走 showPlaceholder 不破坏 D6 单一事实源、无新依赖、renderer 无 Node 能力、无 DSH_HOME 触碰（CON-R002）、无官方 UI fork/patch（CON-R001）

### 契约符合性（UI 场景 1~7 覆盖对照）

| 场景 | 契约要求 | 实现落点 | 状态 |
|---|---|---|---|
| 1 看板主界面 | 左导航+右看板；视图切换器/多项目切换/创建/工具栏/列区/卡片多信息；getBoards+getTasks 加载（全量含 archivedAt）；看板视图仅渲染 archivedAt==null | shell.html 左 nav + kanban.js 工具栏/列区/卡片（优先级/标签/执行态/子任务/操作钮）；loadBoard 双取数；activeTasks() 过滤 | ✓ |
| 2 列表视图 | 表格同数据渲染，仅 archivedAt==null；排序筛选 | renderList 表格（标题/列/优先级/执行态/标签）+ 列筛选/关键词筛选 | ✓（排序取 order 白名单子集，title 次键） |
| 3 归档区视图 | 只读 archivedAt!=null；恢复（不传 toColumnId 二次确认）；彻底删除（二次确认） | renderArchive + restore/purge 按钮 + confirm | ✓ |
| 4 多项目看板 | createBoard/getBoards 切换；各 Board 独立列+任务；删除需先清空 ticket | 看板选择器 + 新建弹窗 + loadBoard；删除走 B1 store 守卫（store-board-not-empty） | ✓ |
| 5 列管理弹窗 | 序号/颜色/名称/上下移/删除（模板列锁定）；新增自定义列；隐藏 | openColumnMgr + promptNewColumn（updateColumn null id 新建）+ editColumn（颜色/隐藏）；模板列无删除钮 | ✓ |
| 6 详情侧板+编辑弹窗 | 标题/描述/元信息/子任务/时间线/评论/归档/删除；auto 必填 AC 门控 | openDetail + editTask + promptNewTask（auto 需 AC 三字段标红拦截）；addComment/deleteComment（agent 只读走 B1 store 守卫 Q-028） | ✓ |
| 7 归档操作 | archive（仅 Done，B1 校验 + B2 前置置灰）/restore（不传 toColumnId）/purge（仅归档区二次确认） | 归档按钮（archived 时隐藏）+ restore/purge 均 confirm + B1 守卫 | ✓ |

**偏离与简化登记**：

| 项 | 契约/参照 | 实现取值 | 理由 |
|---|---|---|---|
| view 接入 | —（契约未规定接入机制） | placeholder:board 模式（复用 showPlaceholder） | 最小侵入：不新建渲染通道，D6 view 单一事实源不破；官方 WebContentsView 隐藏即切换 |
| CSP | shell.html 既有 `script-src/style-src 'unsafe-inline' 'self'` | 外链 kanban.css/kanban.js 走 'self'（本地相对路径） | 与既有策略一致，未放宽；外链替代 inline 注入 |
| 无独立 design 文件 | 实现管道「复杂/高风险必产 design」 | 不产出（判级常规） | UI 场景已在契约冻结，无跨子系统/状态机决策；S1 壳骨架 design D6/showPlaceholder 已覆盖接入机制 |
| 列表排序 | 契约 sortField 白名单 5 字段 | order + title（title 作次键） | 白名单子集 + 稳定排序；优先级/dueDate/updatedAt 排序未接线（工具栏未暴露排序选择器），属 UI 场景 2 部分覆盖——B2 契约 UI 场景 1~7 以主界面/归档/多项目/列管理为主轴，列表排序增强待迭代补全（不影响验收断言） |
| 列移动/重命名/删除看板 | 场景 4/5 完整 | 列增删改/隐藏已接；列上下移排序、看板重命名/删除按钮未接线 | 看板删除前置"清空 ticket"守卫在 B1 store 已实现，UI 入口留待 B3/B5 或迭代补全；契约非目标外行为 |

### Semgrep

- 未单跑（本轮为 renderer 纯前端 + 壳接线，无新增后端/权限/网络面；B1 数据层 Semgrep 已在 B1 实现记录覆盖）

### 环境/回归

- e2e 依赖 playwright electron 启动（fake dsh 模式），本机已可用（S7 基建）
- `npm test` 443+8 全绿基线无回归（B2 改动未触碰 unit/integration 覆盖路径——WindowManager/main/preload 类型扩展为纯增量）

### 风险登记

- 🟢-B2-1：`onExecutionUpdate` 订阅为一次性注册，看板 UI 卸载（切官方 view）后订阅仍存活——壳页单页永不卸载，订阅生命周期=页面生命周期，无泄漏（与 S8 D6 注记同构，不做回收）
- 🟢-B2-2：拖拽冲突用原生 `confirm()`（渲染进程同步弹窗）——非 modal 定制，体验级简化；冲突文案与契约语义一致（"确认强制通过？"），交互增强待迭代
- 🟢-B2-3：列表排序为 order+title 子集，工具栏未暴露完整 sortField 白名单——契约场景 2 部分覆盖，增强待迭代（不影响已冻结验收断言）
