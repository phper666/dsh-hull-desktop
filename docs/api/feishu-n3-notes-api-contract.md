# N3 笔记任务关联契约

## 契约信息

- 工作项：N3 任务关联（飞书 dsh-hull-desktop 清单 Todo 列，guid `588da3f3-7ff8-4b20-acf5-3492abb86e87`）
- 契约状态：已冻结（2026-09-11 复核通过）
- 版本：v1.0
- 适用版本：笔记共识 v1.1（`docs/spec/共识-Hull桌面壳-笔记.md`）
- 依赖：N1 存储与索引服务（主进程 IPC 面，CON-R-notes-009 通道集）
- 说明：桌面壳内部模块契约（无 HTTP API 面）；N3 不新增任何 IPC 通道——复用 N1 notes 通道 + 既有 kanban 通道 + 既有壳导航通道；跨模块跳转缺口以渲染层内部扩展点承接（见「开放问题」TBD）

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口/机制 | 状态 |
|---|---|---|---|---|---|
| 关联建立（搜索型选择器） | F5① | CON-R-notes-005 / §12 任务选择器 | 输入即过滤标题/id、updatedAt 倒序、`[看板]` 前缀平铺、Enter 选中首个、Esc/遮罩关闭；选中回写 frontmatter `task:` | `kanban:getBoards` + `kanban:getTasks` + `notes:save` | 已定义 |
| 关联解除（徽章 ×） | F5① | CON-R-notes-005 | 徽章 × 点击清空 `task:`；frontmatter 回写保真（key 级、未知键与键序保留） | `notes:save`（保真解析器） | 已定义 |
| 笔记 → 任务跳转 | F5② | CON-R-notes-005 | 任务徽章点击 → 切看板视图 + 打开对应 ticket 详情 | `hull:showBoard`（既有）+ 看板详情打开入口（见 TBD-2） | 已定义（入口待 N2/TBD-2） |
| 任务 → 笔记跳转（相关笔记行） | F5③ | CON-R-notes-005 / §12 看板侧 | 任务详情「相关笔记：N 篇」行 → 点击切笔记视图并打开该笔记 | 按 `task:` 反查（笔记索引聚合）+ 笔记视图切换（见 TBD-3） | 已定义（反查已定义，切换入口待 N2/TBD-3） |
| 看板卡片 📝 N 角标 | F5④ | CON-R-notes-005 / §12 看板侧 | 仅有 N≥1 关联笔记时显示；点角标（stopPropagation）→ 切笔记视图打开第一篇关联笔记；卡片其他区域 → 任务详情（既有 `data-detail` 路径） | 反查数据 + TBD-3 | 已定义（刷新时机已定义，切换入口待 N2/TBD-3） |
| 反查数据（task → 笔记列表） | F5③④ | CON-R-notes-002 / §13 | 由 N1 笔记索引 frontmatter `task` 字段聚合，无额外存储 | `notes:index` + `notes:indexChanged` | 已定义 |
| 未知任务降级 | F5⑤ | CON-R-notes-006 | `task:` 指向不存在 ticketId → 灰色「未知任务」不可点击不报错，**不清洗字段**；依赖未就绪 → 中性占位，就绪后统一刷新 | `kanban:getBoards`/`kanban:getTasks` 判定 | 已定义 |

来源材料：PRD `docs/prd/2026-09-07-notes-prd.md` §F5 · 原型 `docs/prototype/2026-09-07-notes-prototype.html` v0.5（选择器 `.picker-*` L401-436、任务徽章 `.chip.task`/`.badge-task` L301-338、相关笔记行 `.task-related` L363-376、角标 `.note-badge` L644-655、徽章点击 L1618-1624、角标点击 L1650-1660、相关笔记行点击 L1662-1667）

## 范围与非目标

### 范围

- 笔记编辑器头部「＋ 关联任务」选择器（搜索/排序/平铺/键盘交互）
- frontmatter `task:` 的建立/解除回写（key 级保真，沿用 skills frontmatter 解析器；解析失败改文件头注入新块、正文不动）
- 笔记侧任务徽章三态：有效关联（可点跳转）/ 未知任务（灰色不可点）/ 未关联
- 任务详情「相关笔记：N 篇」行（按 `task:` 反查、updatedAt 倒序）
- 看板卡片 `📝 N` 角标渲染与点击行为
- 反查聚合（渲染层内存计算：笔记索引 → task→notes 映射）与刷新时机

### 非目标

- 不新建 IPC 通道（notes 与 kanban 通道集均闭合；扩展建议见「开放问题」）
- 不改 boards.json 结构（CON-R-editor-003）；任务与关联关系不落看板侧存储——反查唯一来源 = 笔记文件 frontmatter
- 不做任务侧嵌入笔记列表（PRD Q2 定案：只做跳转链接）
- 不自动清洗失效 `task:` 字段（CON-R-notes-006）
- 不做手填 ticketId（全程点选，CON-R-notes-005）
- 选择器不做分页/虚拟滚动（v1 任务量级几十~几百）

## 业务流程与状态

### 关联生命周期（文本流程）

```
未关联 → 「＋ 关联任务」→ 选择器（getBoards + getTasks 组装候选）
      → Enter/点选候选 → flush 编辑器脏内容 → notes:save（key 级写 task: <ticketId>）
      → 索引增量更新（notes:indexChanged）→ 徽章转「有效关联」/ 角标计数 +1
已关联 → 徽章 × → notes:save（清除 task 键或置空）→ 未关联 / 角标计数 -1
已关联 → ticketId 失效（任务被删/跨机）→ 徽章灰色「未知任务」（字段保留）
       → 任务重建（同 id 出现）→ 自动回「有效关联」
```

### 任务徽章状态机

| 当前态 | 触发 | 目标态 | 依据 |
|---|---|---|---|
| 未关联 | 选择器选中候选 | 有效关联 | CON-R-notes-005 |
| 有效关联 | 徽章 × | 未关联 | CON-R-notes-005 |
| 有效关联 | ticketId 在 boards 中查无（getBoards+getTasks 全量核对） | 未知任务（降级） | CON-R-notes-006 |
| 未知任务 | 同 id 任务重建/重关联 | 有效关联 | CON-R-notes-006 |
| 任意态 | boards 或笔记索引未就绪 | 中性占位（不标未知、不渲染角标）→ 数据就绪后统一刷新 | CON-R-notes-006（Q-070） |

### 反查数据流与刷新时机

- **数据来源**：N1 `notes:index` 返回的索引条目（含 frontmatter `task`）；渲染层据此构建 `Map<ticketId, NoteRef[]>`（按 updatedAt 倒序），**无独立存储、无主进程聚合**——映射为派生数据，可随时由索引重建（对齐 CON-R-notes-002「索引非事实源」精神）
- **刷新触发**：
  1. `notes:indexChanged` 推送事件（N1 fs.watch 增量后推）→ 重建映射 → 徽章/角标/相关笔记行统一重算
  2. 看板数据变化（任务增删改）：kanban 侧无推送事件（KanbanIpc 仅 handle 模式，代码证据：`src/kanban/KanbanIpc.ts:62-111`，无 `webContents.send`）→ 刷新落在看板模块既有渲染周期（render/re-render 时以最新映射重画角标与徽章态）；任务删除导致的角标滞后容忍至下次 render
  3. 视图进入（笔记视图/看板视图 nav 切换）→ 拉取一次最新索引与 boards（对齐壳内其他模块「nav 进入触发刷新」惯例，如 `src/renderer/connections.js:209`）
- **就绪判定**：`notes:index` 与 `kanban:getBoards` 首次调用均成功返回 → 就绪；任一失败/未返回 → 降级态（徽章中性占位、角标不显示），不显示「未知任务」

## 接口清单

N3 不新增 IPC 通道。消费面如下：

| # | 通道/机制 | 方向 | 用途 | 代码证据 |
|---|---|---|---|---|
| 1 | `notes:index` | R→M | 拉取全量笔记索引（含 frontmatter `task`）构建反查映射；选择器/徽章/角标/相关笔记行的数据源 | CON-R-notes-009 通道集（N1 契约定义，实现于 N1） |
| 2 | `notes:save` | R→M | 关联/解除回写：flush 编辑器 → key 级更新 `task:` → 原子写回（mtime 乐观锁沿用 CON-R-notes-002 分流） | CON-R-notes-009 / 002（N1） |
| 3 | `notes:indexChanged`（推送事件） | M→R | 索引增量后刷新反查映射与全部关联 UI | CON-R-notes-009（N1） |
| 4 | `kanban:getBoards` | R→M | 选择器候选的看板名前缀 + 任务有效性判定范围 | `src/kanban/KanbanIpc.ts:62`；preload `src/preload/index.ts` |
| 5 | `kanban:getTasks(boardId)` | R→M | 选择器候选（id/title/updatedAt，`Task` 见 `src/kanban/types.ts:90-121`）+ ticketId 存在性判定 | `src/kanban/KanbanIpc.ts:68` |
| 6 | `hull:showBoard` | R→M | 笔记任务徽章点击 → 壳切看板视图 | `src/main/index.ts:775`、`src/window/WindowManager.ts:246`、`src/preload/index.ts:49` |
| 7 | 看板详情打开（模块内） | R 内部 | 到达看板视图后打开对应 ticket 详情——复用既有 `openDetail(taskId)`（`src/renderer/kanban.js:1143`）与 `data-detail` 委托路径（`src/renderer/kanban.js:596`）；跨模块触达方式见 TBD-2 | 既有函数 |
| 8 | 笔记视图程序化切换（含打开指定笔记） | R 内部 | 任务详情相关笔记行 / 卡片角标 → 切笔记视图并打开目标笔记；入口由 N2 提供（镜像 `hull:showBoard` nav 接入模式），见 TBD-3 | N2 契约 |

### 既有通道充足性结论

- **ticket 下拉/查找**：`kanban:getBoards` + `kanban:getTasks` 已覆盖（候选 = 遍历 boards → 逐 board getTasks → 渲染层过滤/排序）。N+1 次调用，v1 任务量级（几十~几百）可接受；如后续量级需要单次聚合，最小扩展点见 TBD-1。**不阻塞 N3。**
- **ticket 详情打开**：`openDetail(taskId)` 存在但为看板模块内部函数，无跨模块入口 → TBD-2（渲染层内部扩展，无新 IPC）。
- **看板数据变化推送**：无 → 刷新依赖渲染周期（见「刷新时机」），非阻塞。

## 数据结构

### 反查映射（渲染层派生，非持久化）

```ts
/** 由 notes:index 条目聚合；task 字段为空/解析失败的笔记不参与 */
interface TaskNoteRef {
  path: string;        // 笔记相对路径（notes.dir 内）
  title: string;       // frontmatter title（缺失回退文件名基名，CON-R-notes-014）
  updatedAt: string;   // 索引条目时间戳
}
type TaskNotesMap = Map<string /* ticketId */, TaskNoteRef[]>; // 值按 updatedAt 倒序
```

### 关联回写（经 notes:save，key 级保真）

| 操作 | frontmatter 变更 | 保真要求 |
|---|---|---|
| 建立关联 | `task: <ticketId>`（已有 task 键 → 覆盖值；无键 → 追加） | 仅 key 级更新，未知键与键序保留（skills frontmatter 解析器，CON-R-notes-005） |
| 解除关联 | 移除 `task` 键（或置空，以解析器实现为准，二选一全链路一致） | 同上；解析失败 → 文件头注入新块，正文不动 |
| 回写时序 | 编辑器脏内容先 flush（autosave flush），再执行 task 更新保存 | 沿用 mtime 乐观锁；冲突走 CON-R-notes-002 分流 |

### 选择器候选条目

```ts
interface TaskPickerItem {
  id: string;          // ticketId
  title: string;
  boardName: string;   // `[看板]` 前缀来源
  updatedAt: string;   // 排序键，倒序
}
```

- 候选范围：全部看板全部任务（`kanban:getBoards` × `kanban:getTasks`）；已归档任务（`archivedAt` 非空，`src/kanban/types.ts:113`）是否入选 → 见 TBD-4（默认建议：入选并标注，因其 id 仍可被 `task:` 引用且仍可跳详情）
- 过滤：输入子串大小写不敏感匹配 `title` 或 `id`；空输入 = 全量候选
- 排序：`updatedAt` 倒序；平铺展示格式 `[看板名] id 标题 + 相对时间`（原型 `.picker-item`，L417-436）
- 键盘：Enter = 选中首个候选；Esc = 关闭；点击遮罩 = 关闭（§12 任务选择器）

### 徽章/角标渲染态

| 位置 | 态 | 条件 | 行为 |
|---|---|---|---|
| 笔记列表项 / 编辑器头部 chip | 有效关联 | task 非空且 ticketId 存在 | 点击 → `hull:showBoard` + 打开该 ticket 详情 |
| 笔记列表项 / 编辑器头部 chip | 未知任务 | task 非空且查无 ticketId | 灰色、不可点击、不报错、不清洗字段（CON-R-notes-006） |
| 笔记列表项 / 编辑器头部 chip | 未关联 | task 空 | 显示「＋ 关联任务」入口 |
| 任意 | 中性占位 | boards/索引未就绪 | 不标未知、不可点；就绪后统一刷新（Q-070） |
| 看板卡片 | `📝 N` 角标 | TaskNotesMap 中 N≥1 | stopPropagation 后点击 → 切笔记视图打开第一篇（updatedAt 最新）关联笔记；卡片其他区域 → 既有详情路径（原型 L1650-1660 行为基线） |
| 看板卡片 | 无角标 | N=0 或依赖未就绪 | 不渲染（CON-R-notes-006） |

## 错误与异常

| 场景 | 行为 | 依据 |
|---|---|---|
| `notes:save` 冲突（mtime 变化） | 走 CON-R-notes-002 三选/二选分流；关联操作中止，frontmatter 不变 | CON-R-notes-002 |
| `notes:save` 失败（磁盘/权限） | 徽章回滚到操作前态 + 错误提示；索引由 notes:indexChanged 纠正 | CON-R-notes-009 toResult |
| `kanban:getBoards`/`getTasks` 失败 | 视为依赖未就绪：徽章中性占位、角标不显示；不显示「未知任务」 | CON-R-notes-006 |
| ticketId 查无（数据就绪前提下） | 灰色「未知任务」，不可点击，不清洗 `task:` 字段 | CON-R-notes-006 |
| frontmatter 解析失败（关联回写时） | 不改写既有块，文件头注入新 `task:` 块，正文不动 | CON-R-notes-005 |
| 反查映射源笔记被删（.trash/外部删除） | notes:indexChanged 触发映射重建，角标/相关笔记行随之减少；无残留死链 | 索引为唯一来源 |

## 联调与测试场景

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| T3-01 | 建立关联 | 编辑笔记 → ＋ 关联任务 → 输入过滤 → Enter 选中首个 | frontmatter 出现 `task: <id>`；徽章转有效关联；角标计数 +1 |
| T3-02 | 选择器过滤与排序 | 输入标题子串 / id 子串 | 大小写不敏感命中；候选 updatedAt 倒序；`[看板] id 标题` 格式 |
| T3-03 | Esc/遮罩关闭 | 打开选择器 → Esc；再打开 → 点遮罩 | 两次均关闭，无残留弹层，frontmatter 不变 |
| T3-04 | 解除关联 | 徽章 × | `task:` 键清除；frontmatter 其余未知键与键序不变 |
| T3-05 | frontmatter 保真 | 笔记含自定义键（如 `foo: bar`）+ 非默认键序 → 关联/解除 | 自定义键保留、键序保留；解析失败笔记 → 文件头注入新块，正文不动 |
| T3-06 | 笔记徽章跳转 | 点击有效关联徽章 | 切到看板视图并打开对应 ticket 详情 |
| T3-07 | 相关笔记行 | 打开有关联笔记的任务详情 | 「相关笔记：N 篇」；点击行 → 切笔记视图并打开该笔记 |
| T3-08 | 卡片角标 | 看板卡片显示 📝 N | 点角标 → 直达第一篇关联笔记（不触发详情）；点卡片其他区域 → 详情 |
| T3-09 | 未知任务降级 | 关联后从 boards.json 删除该任务（或导入无此 id 的 boards） | 徽章灰色「未知任务」不可点；`task:` 字段仍在文件中 |
| T3-10 | 任务重建恢复 | T3-09 后重建同 id 任务 | 徽章自动回「有效关联」 |
| T3-11 | 依赖未就绪 | 启动后 boards/索引未返回前查看徽章/角标 | 中性占位、角标不显示；就绪后统一刷新 |
| T3-12 | 外部编辑同步 | 用外部编辑器改某笔记 `task:` 字段 | notes:indexChanged → 反查映射更新，徽章/角标/相关笔记行同步 |
| T3-13 | 回写冲突 | 关联操作期间外部改文件 | 走 002 分流弹窗；确认后徽章与文件一致 |

## 开放问题

| 编号 | 问题 | 影响 | 建议 | 阻断 |
|---|---|---|---|---|
| TBD-1 | kanban 无跨看板任务聚合通道 | 选择器需 N+1 次 getTasks | v1 沿用 getBoards+getTasks 组合（量级可接受）；如需单次拉取，最小扩展 = 新增 `kanban:listAllTasks` 只读通道（需走 kanban 契约变更传播），非 N3 必须 | 否 |
| TBD-2 | 「打开指定 ticket 详情」无跨模块入口 | T3-06 徽章跳转的后半程 | `openDetail(taskId)`（kanban.js:1143）为看板模块内部函数；建议 kanban 模块暴露渲染层内部入口（导出 init API 或 CustomEvent），**无新 IPC 通道**；实现形态与 kanban 维护者确认 | 是（跳转功能冻结前需定） |
| TBD-3 | 看板 → 笔记视图程序化切换入口 | T3-07/T3-08 前半程 | N2 建立 nav-notes 后，提供镜像 `hull:showBoard` 模式的入口（如 `hull:showNotes`，含打开指定笔记参数）；归属 N2 契约，N3 只消费 | 是（依赖 N2 契约冻结） |
| TBD-4 | 已归档任务是否进选择器候选 | 候选口径 | 默认建议：入选（archivedAt 非空仍可跳详情、仍可被 task 引用）；如定案排除则「未知任务」判定仍需包含归档任务（避免误降级） | 否 |

## 协调事项

- TBD-2 需 kanban 模块（M2 侧）确认渲染层入口暴露方式
- TBD-3 归属 N2 契约，冻结时序：N1 → N2/N3 并行，N3 消费面以本契约「接口清单」#8 为准

## 变更记录

- 2026-09-11：新建契约 v0.1 草稿（待复核冻结）——依据共识 v1.1（CON-R-notes-005/006 + §12 + §7 task 字段）、PRD v0.3 F5、原型 v0.5；不新增 IPC 通道，缺口以 TBD-1~4 登记

## 自检记录

- 追踪矩阵完整（能力 ↔ 规则 ↔ 接口）；徽章状态机含降级/恢复路径；异常与测试场景齐备
- 既有通道引用均带代码证据（文件:行）；无虚构通道；4 项 TBD 均不虚构、不越权定案
