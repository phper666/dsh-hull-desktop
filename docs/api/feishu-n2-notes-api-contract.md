# N2 笔记视图（渲染层）契约

## 契约信息

- 工作项：N2 笔记视图（渲染层）：nav 入口 / 三区 / 自动保存 / 搜索 / 操作 / 回收站 UI（飞书 dsh-hull-desktop 清单，guid `b342c4bd-de2a-4b86-8299-7c56b28ea8a7`）
- 契约状态：已冻结（2026-09-11 复核通过）
- 版本：v1.0
- 适用版本：notes 需求（共识 v1.1）
- 最后更新：2026-09-11
- 说明：桌面壳内部模块契约（无 HTTP API 面）；本契约定义**渲染层行为**与**IPC 消费面**。IPC 通道全部复用 N1（CON-R-notes-009 闭合通道集），本契约不新造通道；通道 wire 形态（请求/响应字段）以 N1 契约为准。
- 依赖：N1 存储与索引服务（主进程）——契约冻结先于本契约实现

## 需求与共识追踪

| 能力 | 子需求 | 共识规则 | 验收标准 | 交互/接口 | 状态 |
|---|---|---|---|---|---|
| nav 第五入口 + view 5 态 | N2 | CON-R-notes-011、§12 视图边界 | 笔记入口位于任务看板后；默认视图仍=任务看板；upgrade 期间无额外门控 | I1 | 已定义 |
| 三区布局（树+列表+编辑器） | N2 | CON-R-notes-003/004、§12 | 树任意层级/折叠/子树计数/筛选作用子树；列表 updatedAt 倒序；编辑器三态 | I2~I4/I15 | 已定义 |
| 自动保存 + 冲突分流 | N2 | CON-R-notes-002/008 | debounce ~2s + 失焦/关窗 flush + Cmd/Ctrl+S；仅冲突/失败弹分流（三选/二选） | I5~I7 | 已定义 |
| 全局搜索 UI | N2 | CON-R-notes-003/012 | 搜索全局不受目录筛选影响；提示文案；标题+内容子串/大小写不敏感/updatedAt 倒序 | I8 | 已定义 |
| 笔记操作（新建/建目录/移动/删除） | N2 | §12、CON-R-notes-014、§7 | 命名 slug 规则；同目录同名拦截；一次确认可恢复文案 | I9~I12 | 已定义 |
| 回收站 UI | N2 | §12、CON-R-notes-007 | 底部入口含数量；内联视图；恢复冲突不覆盖 | I13 | 已定义 |
| 标题与文件名语义 | N2 | CON-R-notes-014 | title 单源=frontmatter；改标题不改文件名 | I16 | 已定义 |
| 就绪态占位 | N2 | CON-R-notes-006、§12 | boards/索引未就绪 → 徽章中性占位、就绪后统一刷新 | I17 | 已定义 |
| 视图边界 | N2 | §12（Q-076） | ellipsis、win 路径 `/` 显示、三空态 | §视图边界 | 已定义 |
| 渲染管线复用 | N2 | CON-R-notes-008（引 CON-R-editor-001/002/004） | markdown-it v14.1.0 + DOMPurify；destroy 纪律 | §渲染管线 | 已定义 |
| 性能验收 | N2 | CON-R-notes-012 | 种子 300 篇点 nav → 列表首行渲染 <2s（e2e） | TN2-01 | 已定义 |

## 范围与非目标

### 范围（渲染层）

- nav「笔记」入口接入与 `placeholder:notes` 视图 section（壳 view 机制扩展）
- 三区布局：目录树 / 笔记列表 / 编辑器及其头部 chips、底部字数
- 自动保存编排（debounce/flush/强制保存/冲突分流 UI）——保存执行在 N1
- 搜索框 UI 与结果列表（搜索执行在 N1）
- 操作 UI：新建笔记 / + 新建目录 / 移动到… / 删除（确认）/ 回收站内联视图（恢复 / 彻底删除）
- 空态与就绪态占位
- type 过滤徽章（双维过滤之渲染侧）

### 非目标

- 存储索引/扫描/watch/原子写/路径安全（N1）
- 任务关联选择器、📝 角标、相关笔记反查（N3；本契约只约定视图内任务徽章的就绪态占位与渲染）
- 设置页 notes.dir 目录选择器（N4；换目录后「存储目录已更改」清空回列表行为在本契约 I18 登记，触发源在 N4）
- 任务详情/看板侧任何改动；wikilink、拖拽移动、每日笔记（v1 不做，共识 §2）
- 新增任何 IPC 通道（消费 N1 闭合通道集，CON-R-notes-009）

## 业务流程与状态

### 核心流程（文本）

用户点 nav「笔记」→ 主进程切 view 到 `placeholder:notes` → section#notes 显示 → 渲染层拉 `notes:index` 建树/列表 → 点列表项 `notes:get` 打开编辑器 → 编辑（debounce ~2s 自动 `notes:save`）→ 切换/失焦/关窗 flush →（仅冲突/失败）分流弹窗 → 删除走确认 → `notes:delete` 移回收站 → 回收站内联视图恢复/彻底删除
外部（用户/Obsidian/dsh agent）改文件 → fs.watch → 主进程推 `notes:indexChanged` → 渲染层刷新树/列表

### 渲染层视图状态

| 状态 | 进入条件 | 行为 | 依据 |
|---|---|---|---|
| 列表态 | 视图首载 / 关闭编辑器 / 打开笔记失效清空 | 树+列表可见，编辑器空态 | §12 |
| 编辑态 | 选中列表项且 `notes:get` 成功 | 编辑器加载，头部 chips 显示 | §12 |
| 保存冲突态 | `notes:save` 返回冲突错误码 | 分流弹窗（三选/二选），阻断后续自动保存直至用户选择 | CON-R-notes-002/008 |
| 就绪未就绪态 | boards/索引未就绪 | 任务徽章中性占位（不标「未知任务」、不可判灰），就绪后统一刷新 | CON-R-notes-006 |

### 自动保存时序

| 触发 | 行为 | 静默/分流 | 依据 |
|---|---|---|---|
| 内容变化 | debounce ~2s 后 `notes:save` | 静默；失败/冲突 → 分流 | CON-R-notes-008 |
| 编辑器失焦 | 立即 flush 保存 | 同上 | CON-R-notes-008 |
| 切换笔记/切换视图 | 先 flush 再切换，无确认弹窗 | 静默（autosave 已落盘） | CON-R-notes-008 |
| 关窗 | 关窗前 flush | 静默；flush 失败/冲突不阻塞关窗（尽最大努力），下次打开走冲突分流 | CON-R-notes-008 |
| Cmd/Ctrl+S（编辑态） | 立即强制保存 | 同 debounce | CON-R-notes-008 |

## 接口清单

> 接口 = 渲染层交互契约；「IPC 消费」列引用 N1 通道名（CON-R-notes-009），wire 形态以 N1 契约为准。

| # | 状态 | 交互 | 用途 | IPC 消费 | 幂等 |
|---|---|---|---|---|---|
| I1 | NEW | nav「笔记」入口 | 切 view 到 placeholder:notes，section#notes 显示 | `hull:showNotes`（壳 nav 通道，模式对齐 hull:showBoard/showSkills，实现形态见注记 ①） | 是 |
| I2 | NEW | 目录树浏览/折叠/选中 | 树渲染任意层级真实子文件夹；折叠展开；选中筛选作用子树 | `notes:index` | 是 |
| I3 | NEW | 列表渲染与排序 | updatedAt 倒序；项含 title/摘要/相对时间/type 徽章/任务徽章 | `notes:index` | 是 |
| I4 | NEW | 打开笔记 | 编辑器加载全文 + frontmatter chips | `notes:get` | 是 |
| I5 | NEW | 自动保存 | debounce ~2s / 失焦 flush / 切换 flush | `notes:save` | 是 |
| I6 | NEW | Cmd/Ctrl+S 强制保存 | 显式保存 | `notes:save` | 是 |
| I7 | NEW | 保存冲突/失败分流 | 文件改动三选 / 文件被删二选 | `notes:save`（参数形态以 N1 为准，见 TBD-1） | 是 |
| I8 | NEW | 全局搜索 | 输入即搜；结果列表同 I3 形态 | `notes:search` | 是 |
| I9 | NEW | 新建笔记 | 继承当前目录；命名 YYYY-MM-DD-<slug>.md；同目录同名 UI 拦截 | `notes:create` | 否 |
| I10 | NEW | + 新建目录 | 输入目录名（可用 `/` 建子目录） | `notes:create`（目录形态以 N1 为准，见 TBD-1） | 否 |
| I11 | NEW | 移动到… | 下拉选目录 | `notes:move` | 是 |
| I12 | NEW | 删除 | 一次确认，文案注明可恢复 | `notes:delete` | 是 |
| I13 | NEW | 回收站内联视图 | 底部入口含数量；原路径/删除时间/体积；恢复/彻底删除 | `notes:trashList` / `notes:restore` / `notes:purge` | restore 是 / purge 是（对已 purge 项幂等） |
| I14 | NEW | type 过滤徽章 | 与目录筛选双维过滤 | `notes:index` 结果渲染侧过滤 | 是 |
| I15 | NEW | 编辑器三态切换 | 编辑 / 分屏 / 预览 | 无（纯渲染层） | 是 |
| I16 | NEW | 编辑标题 | 写 frontmatter `title:` 键，不改文件名 | `notes:save` | 是 |
| I17 | NEW | 就绪态刷新 | boards/索引就绪后统一刷新徽章 | `notes:indexChanged`（事件） | 无 |
| I18 | NEW | 外部变更感知 | 收到事件刷新树/列表；打开中文件被外部删除 → 保持缓冲，保存走 I7 二选 | `notes:indexChanged`（事件） | 无 |
| I19 | NEW | 目录删除（仅空目录，CON-R-notes-015） | 目录行 hover × → 一次确认弹窗（「删除目录 X/？仅空目录可删，删除后不可恢复（不含回收站）」）→ `notes:rmdir`；非空拒绝提示「目录非空：先移空笔记/子目录再删」（渲染层预检 + N1 校验双保险）；被删目录为选中目录 → 选中回退根；根「全部笔记」行无删除入口 | `notes:rmdir`（N1 并行落地，未就绪 → 降级提示「通道未就绪」） | 是（重复删已删目录按 notes-not-found 提示） |

注记 ①：壳 nav→view 切换通道命名沿用既有 `hull:showBoard`/`hull:showSkills` 模式（见 `src/preload/index.ts`）；`hull:showNotes` 属壳 nav 通道（非 N1 notes:* 通道集），其登记与 N1/preload 契约合并收口——见 TBD-2。

## 数据结构（渲染层消费视图）

> wire 字段名以 N1 契约为准；下表为渲染层所需**语义字段**。

### NoteListItem（树/列表/搜索结果项）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| relativePath | string | 是 | 相对 notes.dir 路径（win 下统一 `/` 显示，§12 Q-076） |
| title | string | 是 | frontmatter `title:`，缺失回退文件名基名（CON-R-notes-014） |
| type | string \| null | 是 | frontmatter `type:`，空则不显示徽章 |
| taskId | string \| null | 是 | frontmatter `task:`，空则不显示任务徽章 |
| updatedAt | number | 是 | mtime（列表排序基准，倒序） |
| excerpt | string | 是 | 摘要：正文（去 frontmatter）起始纯文本，列表单行 ellipsis |
| 子树计数 | number | 是 | 目录树节点含子孙笔记数 |

### NoteDetail（编辑器态）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| relativePath / title / type / taskId | — | 是 | 同 NoteListItem；title/type/task 以头部 chips 呈现（title 显示、type/task 可点按 N3/过滤） |
| content | string | 是 | 全文（含 frontmatter，渲染层不拆写盘格式） |
| mtime | number | 是 | 保存 mtime 乐观锁基准（CON-R-notes-002） |

### SaveIntent（渲染层 → notes:save 语义）

| 字段 | 说明 |
|---|---|
| relativePath + content + baseMtime | 保存载荷；baseMtime 冲突 → N1 返回冲突错误码 → I7 分流 |
| 保存策略 | 覆盖 / 另存冲突副本（命名 `xxx (冲突副本 YYYY-MM-DD).md`）/ 放弃——请求参数形态 TBD-1 |

### TrashItem（回收站内联视图）

| 字段 | 说明 |
|---|---|
| 原路径 | 恢复目标（保留原相对路径，CON-R-notes-007） |
| 删除时间 | 记录时间戳展示 |
| 体积 | 文件大小 |

## 交互行为契约（接口详情）

### I1 nav 入口与 view 态

- nav 顺序按共识 v1.0 定案：笔记位于**任务看板之后**（dsh web / 任务看板 / 笔记 / 设置 口径，CON-R-notes-011）；与壳内其他扩展入口（tokens/connections 等）的相对次序以壳 nav 实现为准（见注记 ②）
- view 机制新增 `placeholder:notes` 态（CON-R-notes-011「4→5 态」口径；映射模式对齐 shell.html `VIEW→NAV` 表，`'placeholder:notes': 'nav-notes'`）
- 默认视图仍=任务看板；upgrade 进行中笔记入口**无额外门控**（可正常进入，§12 视图边界）
- 注记 ②：CON-R-notes-011 的「4→5 态」写于壳 nav 尚为 4 入口时期；当前 `src/renderer/shell.html` nav 已含 skills/tokens/connections/workflows/notifs 多入口。本契约只约束：新增 placeholder:notes 态 + 笔记入口插于任务看板后，不改动其他入口——共识侧口径已于 2026-09-11 契约复核修正（W-N2-1 已解决）

### I2 目录树

- 数据 = notes.dir 真实子文件夹，**任意层级**（VS Code 资源管理器心智，CON-R-notes-003）；跳过隐藏目录与 .trash（N1 侧保证）
- 可折叠展开；节点显示子树笔记计数
- 选中节点 → 列表筛选作用于**整棵子树**；未选中 → 全部
- 系统**永不自动归类**，树纯展示（CON-R-notes-003）

### I3/I4 列表与编辑器

- 列表 updatedAt 倒序（CON-R-notes-012）；项含标题/摘要/相对时间/type 徽章/任务徽章（任务徽章渲染与降级细节属 N3，N2 只承载展示位 + 就绪态 I17）
- 编辑器：EasyMDE 实例，编辑/分屏/预览三态（I15）；头部 chips：title（显示）/ type / task / 相对路径；底部字数（正文去 frontmatter 字符数）
- 渲染管线：markdown-it（锁 v14.1.0）→ DOMPurify 全量消毒，唯一用户内容进 HTML 出口（CON-R-editor-002/004，沿用 kanban.js E1 mdRender 管线）
- destroy 纪律（CON-R-editor-001）：切换笔记/关闭视图/section 销毁前 `editor.destroy()`；每开新建实例不复用（Q-041 模式）；`autoDownloadFontAwesome: false`（禁运行时 CDN 注入，CSP）

### I5~I7 保存与分流

- 自动保存行为按时序表（§业务流程与状态）
- 仅两种情况弹分流 UI（CON-R-notes-002）：
  - **文件被改动**（baseMtime 不符）→ 三选：覆盖 / 另存冲突副本 / 放弃；冲突副本命名 `xxx (冲突副本 YYYY-MM-DD).md`（CON-R-notes-008）
  - **文件被删除** → 二选：另存为新文件 / 放弃（不静默重建原路径）
- 分流期间暂停该笔记自动保存计时；用户选择后恢复或清空编辑器

### I8 搜索

- 搜索框提示文案：「搜索标题与内容…」+ 辅助提示「搜索为全局，不受目录筛选影响」（§12）
- 匹配语义（N1 执行，N2 呈现）：标题+内容子串、大小写不敏感、updatedAt 倒序、无分词/模糊（CON-R-notes-012）
- 结果列表形态同 I3；空查询回常规列表

### I9~I12 操作

- **新建**：继承当前目录（未选中目录 → 根目录）；命名 `YYYY-MM-DD-<slug>.md`，slug 取自输入标题 slug 化，空则时间戳序号（CON-R-notes-014）；同目录同名冲突 → UI 拦截提示（§7 文件名规则）；成功后直接进入编辑态
- **+ 新建目录**：输入框允许 `/` 建子目录（原型行为）；建目录为磁盘操作，索引经 `notes:indexChanged` 跟随
- **移动到…**：下拉选目标目录 → `notes:move`；移动后打开中笔记路径失效 → 重拉后保持编辑或回列表（提示）
- **删除**：一次确认，文案注明「可在回收站恢复」；确认后 `notes:delete` 移 `.trash/`

### I13 回收站

- 入口：视图底部，含当前数量徽标；点击 → 内联视图（非新 section）
- 列表项：原路径 / 删除时间 / 体积
- 恢复：`notes:restore`；原路径被占用 → 冲突提示**不覆盖**（CON-R-notes-007，对齐 CON-R-skills-003）
- 彻底删除：确认弹窗（不可恢复文案）→ `notes:purge`

### I16 标题语义（CON-R-notes-014）

- 编辑器头部 title 输入 → 保存时写 frontmatter `title:` 键，**不改文件名**
- frontmatter 回写保真：key 级更新、未知键与键序保留（CON-R-notes-005 精神，执行在 N1 解析/回写）
- 「重命名文件」为独立动作，**可选提供**（共识未强制）——若提供复用 `notes:move`（同目录改名）；是否 v1 实现 → TBD-3

### I17 就绪态（CON-R-notes-006）

- boards/索引未就绪：任务徽章中性占位（不标「未知任务」、不置灰）；📝 角标不显示（角标本体属 N3，此处约定 N2 视图内不依赖未就绪数据渲染）
- 就绪后（经 `notes:indexChanged` / 看板数据到达）统一刷新，无需手动操作

### 视图边界（§12 Q-076）

- 列表 chip / 路径超长 → ellipsis（CSS 截断，不折行撑爆）
- win 路径显示统一 `/` 分隔
- 空态三型：无笔记（CTA=新建）/ 搜索无结果 / 目录为空
- 相对路径 chip 显示相对 notes.dir 路径

## 错误与异常

| 场景 | 渲染层行为 | 依据 |
|---|---|---|
| notes:save 冲突（文件改动） | 三选分流弹窗 | CON-R-notes-002 |
| notes:save 冲突（文件被删） | 二选分流弹窗 | CON-R-notes-002 |
| notes:save 其他失败（磁盘/权限） | 非阻塞错误提示 + 保留编辑器缓冲；不静默丢内容 | CON-R-notes-002 精神 |
| notes:restore 冲突（原路径占用） | 提示不覆盖，项留在回收站 | CON-R-notes-007 |
| notes:create 同目录同名 | UI 拦截提示，不入请求或按 N1 错误码提示（TBD-1） | §7 |
| 通道错误（N1 toResult 包装） | 统一 toast/提示，不崩溃；索引类错误提示可重试（索引可重建） | CON-R-notes-009 |
| 打开中笔记被外部删除 | 保持缓冲，保存时走二选分流 | CON-R-notes-002 |
| 换 notes.dir（N4 触发） | 打开中笔记失效清空回列表 + 提示「存储目录已更改」 | CON-R-notes-010 |

## IPC 消费面汇总（闭合，不新造）

| 通道 | 方向 | N2 使用场景 |
|---|---|---|
| `notes:index` | invoke | I2 树 / I3 列表 / I14 过滤基础数据 |
| `notes:get` | invoke | I4 打开笔记 |
| `notes:save` | invoke | I5 自动保存 / I6 强制保存 / I7 分流后续保存 / I16 标题写入 |
| `notes:create` | invoke | I9 新建笔记 / I10 新建目录（形态 TBD-1） |
| `notes:move` | invoke | I11 移动到… / I16 可选「重命名文件」（TBD-3） |
| `notes:delete` | invoke | I12 删除 |
| `notes:trashList` | invoke | I13 回收站列表（顺带惰性 TTL 清理，N1 侧） |
| `notes:restore` | invoke | I13 恢复 |
| `notes:purge` | invoke | I13 彻底删除 |
| `notes:search` | invoke | I8 搜索 |
| `notes:indexChanged` | 事件（主→渲染） | I17 就绪刷新 / I18 外部变更感知（fs.watch 推送，不轮询） |
| `notes:rmdir` | invoke | I19 目录删除（仅空目录；N1 并行落地——通道未就绪时渲染层降级提示，落地后自动打通） |
| `hull:showNotes` | invoke | I1 nav 切 view（壳 nav 通道，见 TBD-2） |

- preload 暴露形态：`window.notes` 桥，模式对齐 `window.skills`/`window.kanban`（contextBridge 薄封装、白名单固定、不透传任意通道）

## 联调与测试场景

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| TN2-01 | 性能验收（CON-R-notes-012） | 种子 300 篇（含子目录、平均 ~10KB）冷启动后点 nav「笔记」，e2e 计时 | 列表首行渲染 <2s（CI 抖动降级手动计时） |
| TN2-02 | 自动保存 debounce | 编辑后静置 | ~2s 内触发保存，无弹窗 |
| TN2-03 | 失焦/切视图 flush | 编辑后立刻点其他视图 | 内容已落盘，无确认弹窗 |
| TN2-04 | Cmd/Ctrl+S | 编辑中按快捷键 | 立即保存 |
| TN2-05 | 冲突三选 | 外部改文件后壳内保存 | 弹三选；选「另存冲突副本」→ 生成 `xxx (冲突副本 YYYY-MM-DD).md` |
| TN2-06 | 冲突二选 | 外部删打开中文件后保存 | 弹二选；不静默重建原路径 |
| TN2-07 | 搜索全局性 | 选中某目录后搜索另一目录关键词 | 结果不受目录筛选影响；提示文案可见 |
| TN2-08 | 目录树筛选作用子树 | 选中含子目录节点 | 列表仅显示该子树笔记 |
| TN2-09 | 新建命名 | 无 slug 输入新建 | 生成 `YYYY-MM-DD-<时间戳序号>.md`；同目录同名 → 拦截 |
| TN2-10 | 标题不改文件名 | 编辑器改 title 保存 | frontmatter title 更新；文件名不变 |
| TN2-11 | 回收站闭环 | 删除 → 回收站恢复（占位/不占位各一） | 占位 → 原路径恢复；占用 → 冲突提示不覆盖 |
| TN2-12 | 就绪态占位 | boards 未就绪打开笔记视图 | 徽章中性占位不标未知；就绪后统一刷新 |
| TN2-13 | 外部变更 | 外部编辑器改文件 | indexChanged → 树/列表自动刷新 |
| TN2-14 | 空态三型 | 空目录 / 无笔记 / 无结果搜索 | 三空态正确呈现；无笔记含新建 CTA |
| TN2-15 | 渲染安全 | 笔记含 `<script>`/XSS 载荷 | 预览经 DOMPurify，载荷不执行 |
| TN2-16 | destroy 纪律 | 反复切换笔记/视图 | 无 EasyMDE 实例泄漏（内存/重复绑定检查） |

## 开放问题

- W-N2-1（已解决，2026-09-11 契约复核）：共识 CON-R-notes-011 措辞已修正（「view 机制新增 notes 态，态序按 shell 现状」，非「4→5」计数）；实现按「新增 placeholder:notes 态 + 插于任务看板后」执行不变。
- TBD-1（P1，阻塞实现不阻塞本契约复核）：notes:save/create 冲突分流与建目录的请求参数/错误码形态——待 N1 契约冻结后回填本契约 §数据结构/§错误与异常。
- TBD-2（P2）：`hull:showNotes` 壳 nav 通道登记位置（N1 契约 vs preload 桥契约）——建议随 N1 契约一并冻结。
- TBD-3（P2）：「重命名文件」动作 v1 是否提供（共识标可选）——实现取舍待确认；若提供复用 notes:move。

## 变更记录

- 2026-09-11：v1.1 增补——新增 **I19 目录删除（仅空目录，CON-R-notes-015）**：目录行 hover × + 一次确认 + `notes:rmdir`（N1 并行落地，未就绪降级提示）；非空拒绝双保险（渲染层 subtreeCount 预检 + N1 校验）；被删选中目录回退根。共识 v1.2 §12 口径。
- 2026-09-11：新建契约 v0.1 草稿（待复核冻结）。依据：共识-Hull桌面壳-笔记 v1.1（§5/§7/§8/§12/§14）+ PRD v0.3 + 原型 v0.5 + S1-M1 契约格式；代码参照 src/renderer/shell.html / kanban.js / skills.js / src/preload/index.ts

## 自检记录

- 规则绑定 002/003/004/008/012/014 全覆盖 + §12 全项；IPC 面闭合引用 N1 通道名，零新造（壳 nav 通道单列注记）
- TBD 3 项已标（均为 N1 依赖/可选动作，非共识歧义）
