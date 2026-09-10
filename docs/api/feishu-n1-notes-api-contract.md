# N1 存储与索引服务（主进程）契约

## 契约信息

- 工作项：N1 存储与索引服务（飞书 dsh-hull-desktop 清单 Todo 列，ticket guid `198bcd7a-cf20-4a22-9919-c2e8ed35834b`）
- 契约状态：已冻结（2026-09-11 复核通过）
- 版本：v1.0
- 适用需求：notes（共识 [共识-Hull桌面壳-笔记.md](../spec/共识-Hull桌面壳-笔记.md) v1.1）
- 最后更新：2026-09-11
- 说明：桌面壳内部模块契约（Electron，无 HTTP API 面）；本契约 = notes 主进程服务（Store/Scanner/Watch/Trash/路径安全）的 IPC 接口面与模块行为。IPC 封装、通道命名沿用 [feishu-s1-m1-api-contract.md](feishu-s1-m1-api-contract.md) 既有约定（`<module>:<verb><Noun>` + toResult 包裹）。

## 需求与共识追踪

> 共识规则全文见 [共识-Hull桌面壳-笔记.md](../spec/共识-Hull桌面壳-笔记.md) §8；背景见 [2026-09-07-notes-prd.md](../prd/2026-09-07-notes-prd.md)。

| 能力 | 共识规则 | 验收口径 | 接口 | 状态 |
|---|---|---|---|---|
| 笔记存储默认 `<userData>/notes/`，settings.notes.dir 可指向任意本地文件夹；绝不写 DSH_HOME | CON-R-notes-001 | 换目录不迁移、不触 DSH_HOME | settings 接线（§接口详情 11） | 已定义 |
| 事实源 = 磁盘 md 文件；内存索引仅查询加速可重建；保存前 mtime 乐观锁 + 冲突分流 | CON-R-notes-002 | 覆盖/另存冲突副本/放弃；删除后另存新文件/放弃 | notes:save（§接口详情 3） | 已定义 |
| 回收站固定 `<userData>/notes/.trash/`，TTL 30 天 + 容量 500MB + 启动/24h 检查；恢复冲突不覆盖 | CON-R-notes-007 | 恰好 30 天算过期；循环删最旧 | notes:delete/trashList/restore/purge（§接口详情 6-9） | 已定义 |
| IPC 通道集闭合 + `notes:indexChanged` 推送 + toResult 统一包装 | CON-R-notes-009 | 通道集 = 本契约 §接口清单，无新增 | 全部 IPC 通道 | 已定义 |
| 换目录不迁移 + 重扫；切换前置脏处理由渲染层协调 | CON-R-notes-010 | 切换后打开中的笔记失效清空 | settings 接线（§接口详情 11） | 已定义 |
| 性能与搜索口径：300 篇种子首行 <2s；标题+内容子串、大小写不敏感、updatedAt 倒序 | CON-R-notes-012 | e2e 计时断言（CI 抖动降级手动） | notes:search（§接口详情 10）+ §验收 | 已定义 |
| 路径安全：resolve 后必须位于 notes.dir/.trash 内；拒绝 `..`/绝对路径/隐藏段；basename(realpath) 校验 | CON-R-notes-013 | 对齐 CON-R-skills-007（src/skills/pathGuard.ts:21 `isWithinRoots`） | 所有收路径参数的通道 | 已定义 |

## 范围与非目标

### 范围

- **Store（笔记文件操作）**：save（原子写 temp+rename + mtime 乐观锁 + 冲突分流）/ create / move / get
- **Scanner（扫描索引）**：启动全量扫描（跳过隐藏目录与 .trash，仅 `.md`）→ 内存索引（路径/标题/frontmatter/内容摘要）；frontmatter 解析失败 = 三键视为空照常入索引；扫描异步不阻塞启动；索引可全量重建
- **Watch（增量监听）**：首选 chokidar；不可用降级 30s 定时重扫；自写回声 1s 窗口抑制；rename 按 delete+add
- **Trash（回收站）**：manifest（`<userData>/notes/trash.json`）+ 实体（`.trash/tr_<uuid>.md`）+ restore/purge + TTL/容量清理
- **路径安全**：所有路径参数守卫（CON-R-notes-013）
- **settings 接线**：`notesDir` 字段 + schemaVersion bump + 换目录重扫
- **IPC**：10 通道（闭合）+ 1 推送事件 + preload `window.notes` 薄封装

### 非目标

- ❌ 视图/编辑器/自动保存策略/冲突分流 UI（N2，CON-R-notes-008；N1 只提供冲突错误码与策略参数）
- ❌ 任务关联交互（选择器/徽章/角标/反查，N3）；N1 仅提供 frontmatter 保真回写原语
- ❌ 设置页目录选择器 UI（N4）；N1 仅定义 settings 字段与主进程接线行为
- ❌ SQLite/FTS、wikilink、同步引擎、标签体系化（PRD §4 非目标）
- ❌ notes.dir 旧目录文件迁移（CON-R-notes-010，永不迁移）

## 业务流程与状态

### 核心流程

- **保存**：renderer 持有 `mtime` 基线（notes:get 返回）→ notes:save（默认校验 mtime）→ 冲突返回错误码携带 detected 信息（文件被改动）/ 专错误码（文件被删除）→ renderer 按 CON-R-notes-002 分流后携 strategy 重试
- **删除→恢复**：delete = 文件 rename 入 `.trash/tr_<uuid>.md` + manifest 追加条目（原相对路径/deletedAt/size）→ restore = rename 回 `notes.dir/<originalPath>`（被占用 → 冲突错误不覆盖）→ purge = 实体删除 + manifest 移除
- **回收站清理**：启动时 + 每 24h：先按 TTL（deletedAt 起算 ≥30 天）删，再按总容量（>500MB 循环删 deletedAt 最旧至 <500MB）
- **索引**：启动全量扫描（异步）→ watch 增量更新 → indexChanged 推送（renderer 重拉 notes:index）

### 状态机表

**索引状态机（主进程内存态）**

| 当前态 | 事件 | 次态 | 副作用 |
|---|---|---|---|
| （启动） | scan() 触发 | scanning | 异步全量扫描，不阻塞窗口 |
| scanning | 扫描完成 | ready | 推 `indexChanged{reason:"rescan"}` |
| scanning | 扫描失败（notes.dir 不可读） | degraded | 记日志；定时重扫兜底 |
| ready | watch 事件（非回声） | ready | 增量更新索引 + 推 `indexChanged{reason:"incremental"}` |
| ready | watch 初始化失败/失效 | degraded | 切 30s 定时全量重扫 |
| degraded | 重扫完成 | ready | 推 `indexChanged{reason:"rescan"}` |
| 任意 | notesDir 切换 | scanning | 旧索引废弃，全量重扫；推 `indexChanged{reason:"dir-changed"}` |

**笔记文件生命周期**（共识 §5）：`新建 → 编辑（自动保存，N2）→ 保存（原子写 + mtime 乐观锁）→ 删除（移 .trash/）→ 恢复 / 彻底删除`

**回收站条目状态机**

| 当前态 | 事件 | 次态 | 说明 |
|---|---|---|---|
| — | notes:delete | active | manifest 追加 + 实体入驻 |
| active | TTL 清理（age ≥30 天） | purged | 恰好 30 天算过期 |
| active | 容量超限循环删最旧 | purged | 删至总容量 <500MB |
| active | notes:restore 成功 | — | manifest 移除 + 实体移出 |
| active | notes:purge / notes:restore 冲突 | — | purge 成功移除条目；冲突则条目保留 |

## 接口清单

> 通道集闭合（CON-R-notes-009，v1.1 Q-064）。统一响应包裹 `IpcResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string }`（对齐 src/kanban/KanbanIpc.ts:39-52 `toResult`）；错误码见 §错误与异常。路径参数统一为相对 notes.dir 的相对路径，分隔符 `/`（win 路径统一 `/` 显示，共识 §12）。

| # | 状态 | 通道 | 方向 | 请求参数 | 响应 data | 错误码 |
|---|---|---|---|---|---|---|
| 1 | NEW | notes:index | R→M | 无 | `{ ready: boolean; entries: NoteIndexEntry[] }` | notes-scan-error |
| 2 | NEW | notes:get | R→M | `path: string` | `NoteDetail` | notes-path-invalid / notes-not-found / notes-io-error |
| 3 | NEW | notes:save | R→M | `SaveInput` | `{ path: string; mtime: string }` | notes-path-invalid / notes-not-found / notes-conflict-modified / notes-conflict-deleted / notes-name-conflict / notes-io-error |
| 4 | NEW | notes:create | R→M | `dir?: string; title?: string` | `{ path: string; mtime: string }` | notes-path-invalid / notes-name-conflict / notes-io-error |
| 5 | NEW | notes:move | R→M | `path: string; targetDir: string` | `{ path: string; mtime: string }` | notes-path-invalid / notes-not-found / notes-name-conflict / notes-io-error |
| 6 | NEW | notes:delete | R→M | `path: string` | `{ trashId: string }` | notes-path-invalid / notes-not-found / notes-io-error |
| 7 | NEW | notes:trashList | R→M | 无 | `{ entries: TrashEntry[]; totalSizeBytes: number }` | notes-io-error |
| 8 | NEW | notes:restore | R→M | `trashId: string` | `{ restoredPath: string }` | notes-not-found / notes-restore-conflict / notes-io-error |
| 9 | NEW | notes:purge | R→M | `trashId: string` | `{}` | notes-not-found / notes-io-error |
| 10 | NEW | notes:search | R→M | `query: string` | `{ entries: NoteIndexEntry[] }` | notes-scan-error |
| 11 | NEW | notes:indexChanged | M→R（推送） | — | `IndexChangedPayload` | —（单向推送） |

- 接线：主进程 `registerNotesIpc(...)`，对齐 `registerKanbanIpc` 装配模式（src/main/index.ts:98）；preload `contextBridge.exposeInMainWorld('notes', {...})` 薄封装（对齐 src/preload/index.ts:134 `window.kanban` 模式）+ `onIndexChanged` 订阅。
- 幂等：save/create/move/delete/restore/purge 均按「当前磁盘态 + 参数」求值，重复调用语义由错误码表达（如二次 delete → notes-not-found），无独立幂等态。

## 数据结构（Schema）

### NoteIndexEntry（notes:index / notes:search 返回项）

| 字段 | 类型 | 语义 |
|---|---|---|
| path | string | 相对 notes.dir 路径，`/` 分隔（如 `工作/2026-09-07-xxx.md`） |
| title | string | frontmatter `title:`；缺失/解析失败回退文件名基名（CON-R-notes-014） |
| frontmatter | `{ title: string\|null; type: string\|null; task: string\|null; tags: string[]\|null }` | 三键（type/task/tags）解析失败全视为 `null`，照常入索引（CON-R-notes-005）；title 并入顶层 |
| snippet | string | 正文（去 frontmatter）前 200 字符，换行折叠为空格（列表摘要，共识 §12「摘要」） |
| updatedAt | string | 文件 mtime（ISO 8601），列表排序键（updatedAt 倒序） |

> 目录树由渲染层按 `entries[].path` 派生（N2 职责）；N1 不单独下发树结构。

### NoteDetail（notes:get 返回）

| 字段 | 类型 | 语义 |
|---|---|---|
| path | string | 同上（相对路径） |
| content | string | 文件全文（含 frontmatter 原文） |
| frontmatter | 同 NoteIndexEntry.frontmatter | 供头部 chips（title/type/task）与 N3 回写 |
| mtime | string | 文件 mtime（ISO）——**保存乐观锁基线**（CON-R-notes-002） |

### SaveInput（notes:save 请求）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| path | string | 是 | 相对路径 |
| content | string | 是 | 全文（含 frontmatter，编辑器持有） |
| expectedMtime | string | 是 | 乐观锁基线（来自 notes:get / 上次 save） |
| frontmatterPatch | `{ title?: string; type?: string; task?: string\|null; tags?: string[] }` | 否 | key 级回写：仅更新给定键，未知键与键序保留（沿用 src/skills/frontmatter.ts:84 行级文本操作模式）；解析失败 → 不改写原块，文件头注入新 frontmatter 块（正文不动，CON-R-notes-005） |
| strategy | `'overwrite' \| 'saveAsCopy'` | 否 | 冲突分流执行（CON-R-notes-002）：缺省 = 先校验，冲突即返回错误；`overwrite` = 跳过 mtime 校验覆盖（文件已被删除时仍拒绝，不静默重建原路径）；`saveAsCopy` = 写入冲突副本（命名见下） |

冲突副本命名：`<基名> (冲突副本 YYYY-MM-DD).md`（CON-R-notes-008），写入原文件同目录；`TBD（待确认）`：同名冲突副本已存在时的后缀策略（建议追加序号 `(冲突副本 YYYY-MM-DD) 2`，待复核定案）。

### TrashEntry（notes:trashList 返回项 / `<userData>/notes/trash.json` entries[]）

| 字段 | 类型 | 语义 |
|---|---|---|
| id | string | `tr_<uuid>`（= `.trash/` 内实体名 `tr_<uuid>.md`；对齐 src/skills/types.ts:85） |
| originalPath | string | 删除时相对 notes.dir 的原路径（恢复目标） |
| deletedAt | string | 删除时间（ISO）——**TTL age 唯一基准**（CON-R-notes-007） |
| sizeBytes | number | 条目体积（500MB 容量上限计算；对齐 src/skills/types.ts:91） |

### IndexChangedPayload（notes:indexChanged 推送）

| 字段 | 类型 | 语义 |
|---|---|---|
| reason | `'incremental' \| 'rescan' \| 'dir-changed'` | incremental = watch 增量；rescan = 全量重扫完成（启动/降级）；dir-changed = notes.dir 切换。渲染层收到后统一重拉 notes:index（增量细节仅主进程内存索引内部消化，不透传 diff——量级几十~几百，重拉成本低） |

### HullSettings 扩展（settings 接线）

| 字段 | 类型 | 默认值 | 语义 |
|---|---|---|---|
| notesDir | string | `<userData>/notes/` | 笔记根目录；可改任意本地文件夹；改路径不迁移旧文件（CON-R-notes-001/010） |
| schemaVersion | number | 4（bump） | 当前 `SCHEMA_VERSION_CURRENT = 3`（src/settings/SettingsProvider.ts:49）→ bump 为 4（共识 §7 明确要求 schema bump）；**无迁移语义**：旧 settings.json 缺 notesDir → 读路径默认值补齐（对齐 SettingsProvider.ts:128 既有字段缺省 coerce 模式，不搬数据） |

### 回收站物理布局

| 路径 | 内容 |
|---|---|
| `<userData>/notes/.trash/` | 实体：`tr_<uuid>.md`（内容原样）。**固定 userData、独立于 notes.dir**（改址不跟随，避免污染用户 git 仓库，CON-R-notes-007） |
| `<userData>/notes/trash.json` | manifest：`{ entries: TrashEntry[] }`；原子写 temp+rename（对齐 src/kanban/KanbanStore.ts:296-299）；损坏 → 备份 `trash.json.corrupt-<ts>` + 重建空清单（对齐 KanbanStore.ts:263 backupAndRebuild）；`.trash` 中无清单条目的孤儿文件保留不展示，`TBD（待确认）`：是否纳入 TTL 清理 |

## 错误与异常

> 错误码经 HullError（src/shared/errors.ts:11）携带，toResult 转 `{ ok:false, code, message }`。冲突系错误在 data 缺省包裹外**于 message 中携带 detected 信息**，并按 skillsHandlers 惯例（src/skills/ipc/skillsHandlers.ts:15）在失败分支扩展字段透传。

| code | 触发条件 | 扩展字段 | 关联规则 |
|---|---|---|---|
| notes-path-invalid | 路径参数 resolve 后越出 notes.dir；含 `..` 段；绝对路径；任一路径段以 `.` 开头（隐藏段）；文件名 basename(realpath) 校验不过 | `path` | CON-R-notes-013 |
| notes-not-found | 目标笔记/回收站条目不存在（含重复 delete、二次 restore/purge） | `path` 或 `trashId` | — |
| notes-conflict-modified | save 时磁盘 mtime ≠ expectedMtime（文件被外部改动） | `detected: { diskMtime: string }` | CON-R-notes-002 三选 |
| notes-conflict-deleted | save 时目标文件已不存在（文件被外部删除） | — | CON-R-notes-002 二选（不静默重建原路径） |
| notes-restore-conflict | restore 时 `notes.dir/<originalPath>` 已被占用；**不覆盖** | `targetPath` | CON-R-notes-007（对齐 CON-R-skills-003） |
| notes-name-conflict | create 同目录同名 / move 目标同名 | `targetPath` | 共识 §7「同目录同名冲突 UI 拦截」 |
| notes-io-error | 文件系统读写失败（rename/删除/manifest 写盘等） | `path`（若有） | — |
| notes-scan-error | notes.dir 不可读等扫描失败 | `path`（notes.dir） | 对齐 src/skills/errors.ts:7 scan-error 命名 |
| unknown | 非 HullError 异常兜底 | — | toResult 惯例 |

## 接口详情

### 1. notes:index

- 语义：读取内存索引快照（updatedAt 倒序全量）。仅读快照，不触发扫描；全量重建为服务内部动作（启动/降级重扫/dir 切换），无 IPC（共识 §5「索引可全量重建」）。
- 响应：`{ ready: boolean; entries: NoteIndexEntry[] }`；`ready=false` 表示扫描未完成（entries 可能为空或部分），渲染层按就绪态中性占位（Q-070 精神），就绪后收 indexChanged 再刷新。
- 扫描口径：启动全量扫描 notes.dir，跳过隐藏目录（任一段 `.` 开头）与 `.trash`，仅 `.md` 文件（§9）；扫描异步不阻塞启动（CON-R-skills-009 精神）。

### 2. notes:get

- 语义：读取单篇全文 + frontmatter + mtime 基线（编辑器打开）。
- 路径守卫：notes-path-invalid（§错误与异常）。

### 3. notes:save

- 语义：原子写 temp+rename（对齐 src/kanban/KanbanStore.ts:296-299 模式）+ 前置 mtime 乐观锁校验（CON-R-notes-002）。
- 流程：
  1. `strategy` 缺省：磁盘 mtime 与 `expectedMtime` 比对——不一致 → notes-conflict-modified（携 detected.diskMtime）；文件不存在 → notes-conflict-deleted。均**不写盘**。
  2. `strategy='overwrite'`：跳过 mtime 校验覆盖写（文件已删除 → 仍返回 notes-conflict-deleted）。
  3. `strategy='saveAsCopy'`：不写原路径，写冲突副本（`<基名> (冲突副本 YYYY-MM-DD).md`），响应 path = 副本路径。
  4. 若含 `frontmatterPatch`：写盘后行级回写指定键（未知键/键序保留）；frontmatter 解析失败 → 不改写原块，文件头注入新 frontmatter 块，正文不动（CON-R-notes-005）。
- 响应：`{ path, mtime }`（mtime = 新基线，后续 save 用）。
- 索引联动：成功后主动更新内存索引 + 推 `indexChanged{reason:"incremental"}`（自写事件经回声抑制，见 §Watch 细节）。

### 4. notes:create

- 语义：快速捕捉/新建（§12「新建，继承当前目录」）。
- 参数：`dir`（相对目录，缺省 = notes.dir 根）；`title`（可选，slug 来源 + frontmatter `title:` 预写；缺省不写 frontmatter，标题回退文件名基名，CON-R-notes-014）。
- 命名：`YYYY-MM-DD-<slug>.md`（slug 由 title 生成；slug 空 → 时间戳序号，§9/§7）；同目录同名 → notes-name-conflict（UI 拦截，§7）。
- 响应：`{ path, mtime }`。

### 5. notes:move

- 语义：移动到目标目录（磁盘 rename，索引跟随，§7「手动移动 = 磁盘操作，索引跟随」）。
- 校验：`targetDir` 必须为 notes.dir 下已存在的真实子目录（路径守卫 + 存在性）；目标同名 → notes-name-conflict（不覆盖）。

### 6. notes:delete

- 语义：文件 rename 入 `.trash/tr_<uuid>.md` + manifest 原子写追加条目（CON-R-notes-007）。一次确认由渲染层负责（§12）。
- 响应：`{ trashId }`。

### 7. notes:trashList

- 语义：manifest 快照 + `totalSizeBytes`（.trash 实际体积合计；对齐 skills:getTrashList 返回形态 src/skills/ipc/skillsHandlers.ts:40）。

### 8. notes:restore

- 语义：rename 回 `notes.dir/<originalPath>`——**恢复目标 = 当前 notes.dir + 记录的原相对路径**（回收站固定 + 相对路径语义的直接推论；换目录后恢复落到新目录，符合「改址不跟随 + 不迁移」组合）。父目录不存在则自动创建。
- 冲突：目标被占用 → notes-restore-conflict（携 targetPath），**不覆盖**，条目保留。

### 9. notes:purge

- 语义：实体删除 + manifest 移除条目，不可逆。

### 10. notes:search

- 语义：标题 + 内容子串匹配，大小写不敏感，updatedAt 倒序；无分词/无模糊（CON-R-notes-012）。搜索永远全局，不受目录筛选影响（CON-R-notes-003——筛选是渲染层行为）。
- `query` 空串：返回全部条目（等价 notes:index 排序结果）。

### 11. settings 接线（notesDir；非 notes:* 通道）

- 字段读写走既有 settings 通道（SettingsProvider）；N1 定义主进程行为：
  - 监听 SettingsProvider `changed` 事件 → 校验新目录（须存在且为目录；不得位于 DSH_HOME 内，CON-R-notes-001；不合法 → 拒绝切换并维持旧目录）→ 服务内 `setNotesDir(dir)`：旧索引废弃 → 全量重扫 → 推 `indexChanged{reason:"dir-changed"}`（换目录重扫、不迁移，CON-R-notes-010）。
  - **切换前置脏处理为渲染层协调**（N2/N4：脏笔记先走保存/放弃，切换后打开中的笔记失效清空回列表）；N1 保证 `setNotesDir` 幂等（同目录重复设置无副作用）。
- schemaVersion bump 3→4，无迁移语义（§Schema 表）。

### Watch 细节（Scanner/Watch 内部行为，无独立 IPC）

- 首选 chokidar 监听 notes.dir（递归）；初始化失败/运行中失效 → 降级 30s 定时全量重扫（§9）。
- 自写回声：主进程自身写盘（save/create/move/delete/restore/purge）后 1s 窗口内的对应路径 watch 事件静默吞掉（索引已由写操作主动更新，防双推）。
- rename 事件 = delete + add 处理（共识 §13）。
- 增量事件 → 更新内存索引 → 推 `indexChanged{reason:"incremental"}`。

## 联调与测试场景

### 成功

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| T1-01 | 300 篇种子性能（CON-R-notes-012） | 种子 300 篇（含子目录、平均 ~10KB），冷启动后点 nav「笔记」，e2e 计时 | 列表首行渲染 <2s（CI 抖动降级手动） |
| T1-02 | 启动全量扫描 | 预置含子目录/隐藏目录/.trash 的 notes.dir，启动 | 仅可见 `.md` 入索引；隐藏目录与 .trash 跳过 |
| T1-03 | 保存基线路径 | get → 修改 → save（无 strategy） | 落盘成功；响应 mtime 为新基线；frontmatter 未知键与键序保留 |
| T1-04 | frontmatter 保真回写 | save 携 frontmatterPatch.task | 仅该键更新；未知键/键序不动（CON-R-notes-005） |
| T1-05 | 解析失败头注入 | 对无/坏 frontmatter 文件 save 携 patch | 文件头注入新块，正文逐字节不动 |
| T1-06 | 删除→恢复 | delete → trashList → restore | 实体入 .trash、manifest 四字段正确；恢复回原相对路径，内容原样 |
| T1-07 | 冲突副本 | 制造 mtime 冲突 → save strategy='saveAsCopy' | 原路径不动；生成 `xxx (冲突副本 YYYY-MM-DD).md` |
| T1-08 | 搜索 | 混合大小写关键词 search | 标题+内容命中、大小写不敏感、updatedAt 倒序 |
| T1-09 | 换目录重扫 | settings 改 notesDir 为另一有效目录 | 旧目录文件不动；索引全量重建；收到 dir-changed 推送；旧 settings 文件无 notesDir 时读路径默认补齐 |

### 失败

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| T2-01 | 保存冲突（改动） | 外部改文件 → save（旧 expectedMtime） | notes-conflict-modified + detected.diskMtime；磁盘零改动 |
| T2-02 | 保存冲突（删除） | 外部删文件 → save | notes-conflict-deleted；原路径不静默重建 |
| T2-03 | overwrite 遇删除 | 文件已删 → save strategy='overwrite' | 仍 notes-conflict-deleted（不重建原路径） |
| T2-04 | 恢复冲突 | 占用原路径后 restore | notes-restore-conflict + targetPath；条目保留、占用文件零改动 |
| T2-05 | 同名拦截 | create/move 目标同名 | notes-name-conflict；不覆盖 |
| T2-06 | 路径越界 | 传 `../x.md` / 绝对路径 / `.hidden/a.md` | notes-path-invalid |
| T2-07 | trash.json 损坏 | 写入非法 JSON 后 trashList | 备份 corrupt-<ts> + 返回空清单；壳不崩 |

### 边界

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| T3-01 | watch 降级 | 用不可监听目录（或模拟 watch 失败） | 切 30s 定时重扫；期间外部改动经重扫进索引 |
| T3-02 | 自写回声 | save 后立即观察 watch 事件 | 1s 窗口内回声被吞，不重复推送（索引已由 save 更新） |
| T3-03 | rename 事件 | 外部 mv a.md b.md | 索引按 delete+add 处理，最终态正确 |
| T3-04 | frontmatter 解析失败入索引 | 预置坏 frontmatter 文件 | 三键视为空、title 回退文件名基名，照常入索引与搜索 |
| T3-05 | 恰好 30 天过期 | 构造 deletedAt = now-30d 条目，触发清理 | 被清（≥30 天即清）；now-30d+1s 不清 |
| T3-06 | 容量循环删最旧 | .trash 总量 >500MB 触发清理 | 按 deletedAt 最旧循环删至 <500MB；manifest 同步 |
| T3-07 | 清理时机 | 启动 + 模拟 24h 定时 | 两个时机各执行一次（§9） |
| T3-08 | 换目录后恢复 | 改 notesDir 后 restore 旧条目 | 恢复到**当前** notes.dir/<originalPath>（父目录自动创建） |
| T3-09 | 空目录/空搜索 | 空 notes.dir；query 空串 | index 空列表 ready；search 返回全部 |
| T3-10 | win 路径显示 | Windows 下 trashList/index | 路径分隔符统一 `/`（共识 §12） |

## 开放问题

| # | 问题 | 状态 |
|---|---|---|
| Q-1 | 冲突副本同名碰撞后缀策略（建议追加序号） | TBD（待确认，见 §SaveInput） |
| Q-2 | manifest 损坏重建后 .trash 孤儿文件是否纳入 TTL 清理 | TBD（待确认，见 §回收站物理布局） |

## 变更记录

- 2026-09-11：新建契约（v0.1 草稿，待复核冻结）——N1 存储与索引服务：10 IPC 通道（闭合，CON-R-notes-009）+ notes:indexChanged 推送；Store（原子写 + mtime 乐观锁 + 冲突分流，CON-R-notes-002）；Scanner/Watch（chokidar 首选 + 30s 降级 + 1s 回声抑制，§13）；Trash（固定 .trash + trash.json manifest + TTL 30d/500MB，CON-R-notes-007）；路径安全（CON-R-notes-013）；settings 接线（notesDir + schemaVersion 3→4 无迁移，CON-R-notes-001/010）；性能验收 300 篇 <2s（CON-R-notes-012）。
