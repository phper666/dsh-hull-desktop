# N-笔记-notes 技术设计（N1~N4）

| 项 | 值 |
|---|---|
| 状态 | **frozen**（评审通过·冻结；评审记录见 §8） |
| 判级 | 复杂（一句理由：跨 main/renderer 双进程、涉及文件系统事实源 + 乐观锁冲突分流 + 跨模块任务关联 + 设置迁移，契约 4 份已冻结） |
| 需求标识 | notes（N1~N4） |
| 日期 | 2026-09-11 |

## 1. 背景与范围

- 共识：[共识-Hull桌面壳-笔记.md](../spec/共识-Hull桌面壳-笔记.md) v1.1（业务规则 CON-R-notes-001~014）
- 契约（均已冻结 v1.0，**接口以契约为准，本文只写 how，不改接口**）：
  - [feishu-n1-notes-api-contract.md](../api/feishu-n1-notes-api-contract.md) — 存储与索引服务（主进程）
  - [feishu-n2-notes-api-contract.md](../api/feishu-n2-notes-api-contract.md) — 笔记视图（渲染层）
  - [feishu-n3-notes-api-contract.md](../api/feishu-n3-notes-api-contract.md) — 笔记任务关联
  - [feishu-n4-notes-api-contract.md](../api/feishu-n4-notes-api-contract.md) — 笔记设置集成
- PRD：[2026-09-07-notes-prd.md](../prd/2026-09-07-notes-prd.md) · 原型：[2026-09-07-notes-prototype.html](../prototype/2026-09-07-notes-prototype.html)

### 范围映射

| 子需求 | 内容 | 规则绑定 | 契约 |
|---|---|---|---|
| N1 | Store（原子写+乐观锁+冲突分流）/ Scanner / Watch / Trash / 路径安全 / IPC 10+1 通道 / settings 接线 | 001/002/007/009/010/012/013 | N1 |
| N2 | 渲染层视图：nav 入口 / 三区布局 / 自动保存 / 搜索 / 操作 / 回收站 UI / 冲突分流 UI | 002/003/004/008/012/014 | N2 |
| N3 | 任务关联：选择器 / 徽章双向跳转 / 看板角标 / 反查映射 / 未知任务降级 | 005/006 | N3 |
| N4 | 设置集成：目录选择器复用 / 路径显示复制 / schemaVersion 3→4 / 换目录重扫 | 001/010 | N4 |

共同不做（共识 §2）：非 `.md` 文件、标签管理页、笔记间双链、多窗口、云同步。

## 2. 架构决策（含备选）

### D1 存储形态：md 文件为事实源 + trash.json manifest（备选：SQLite）

- **B：SQLite 单库存笔记**——事务强、查询强。
- **A（选定）：磁盘 md 文件为唯一事实源** + `<userData>/notes/trash.json` manifest 管回收站。
- 理由：CON-R-notes-002 定死「事实源 = 磁盘 md 文件」——用户可用任意编辑器/git 直接操作 notes.dir（PRD agent 协同故事的前提）；SQLite 使外部编辑不可见、违背需求本质；量级（300 篇 × ~10KB）无 SQLite 必要。回收站 manifest 原子写 temp+rename + 损坏备份重建，模式直接镜像 `src/kanban/KanbanStore.ts:295-303`（原子写）与 `src/kanban/KanbanStore.ts:258-263`（corrupt-<ts> 备份重建）。

### D2 索引：内存重建 + watch 增量（备选：持久化索引文件）

- **B：持久化索引**（如 hash-cache 式落盘，`src/skills/SkillsScanner.ts:94` 先例）。
- **A（选定）：纯内存索引，启动全量扫描 + watch 增量**，随时可全量重建。
- 理由：CON-R-notes-002「索引非事实源」；300 篇全量重建本身就在 <2s 验收内（CON-R-notes-012），持久化省不了多少却引入「索引与磁盘不一致」的失效窗口与版本治理；skills 的 hash-cache 存在理由是**目录哈希计算昂贵**（递归 SHA），笔记扫描只是读文件 + 行级解析，成本模型不同。状态机 scanning/ready/degraded 对齐 `src/skills/SkillsScanner.ts:64,121-128`（幂等 scan + 快照原子替换）。
- **watch 库选型：引入 chokidar（必要性成立）**：① 三端打包（PK1）含 Linux，Node `fs.watch` 递归仅 darwin/win 支持，Linux 需自写逐目录挂载 + 新建目录补挂逻辑；② chokidar 提供 rename→add/unlink 归一（契约 §Watch 细节要求 rename 按 delete+add 处理）与忽略规则，自写等价逻辑 ~80 行且需平台分支。备选降级路径（若 PM 否决依赖）：fs.watch 递归（darwin/win）+ Linux 逐目录 watch + 失效即切 30s 定时全量重扫——契约「watch 不可用 → 降级 30s 重扫」路径原样承接，接口不变。→ **需 PM 确认项，见 §7**。

### D3 搜索：内存子串扫描（备选：FTS/倒排）

- **B：FTS**（SQLite FTS5 或自建倒排）。
- **A（选定）：notes:search 在内存索引上做标题 + 全文子串匹配**（大小写不敏感，updatedAt 倒序，契约 §接口详情 10）。
- 理由：契约明确「无分词/无模糊」（CON-R-notes-012）——FTS 的分词优势用不上；300 篇 × 10KB ≈ 3MB 文本，`String.toLowerCase().includes()` 扫一遍 <10ms；FTS 需持久化索引（与 D2 矛盾）+ 分词器依赖。YAGNI。

### D4 自动保存实现点：renderer debounce + notes:save 乐观锁（备选：main 侧 debounce）

- **B：main 侧 debounce**（渲染层只发 dirty 信号）。
- **A（选定）：渲染层持有编辑缓冲，debounce ~2s / 失焦 / 切换 / Cmd+S 触发 flush，全部经 notes:save（expectedMtime 乐观锁）落盘**。
- 理由：debounce/blur/快捷键/切换 flush 全是 UI 语义（N2 契约 §自动保存时序已定死），main 侧没有编辑器上下文，做 debounce 需新增通道反向同步编辑缓冲——凭空多一条状态复制链。正确性不由 debounce 保证，由 notes:save 的 mtime 乐观锁（CON-R-notes-002）+ 冲突分流保证；渲染层只管「何时发」，main 只管「怎么安全落盘」。

### D5 外部写入回声抑制：已知路径 1s 窗口（备选：全量 mtime 比对）

- **B：每次自写后记录全量路径→mtime 快照，watch 事件与快照比对**。
- **A（选定）：主进程写操作（save/create/move/delete/restore/purge）登记「本次写过的绝对路径集合」，watch 回调命中该集合且距写盘 <1s 的事件静默吞掉**（契约 §Watch 细节 v1.1 Q-074 定死 1s 窗口）。
- 理由：契约已定 1s 窗口语义；自写路径集合精确且生命周期短（1s 后自动清理），实现是 `Set<string>` + 时间戳，无快照维护成本。残余风险（1s 内外部改同路径被吞）有兜底：乐观锁在保存时必与磁盘 mtime 比对，事实源正确性不依赖索引新鲜度；显示层最坏滞后到下一个事件/重扫。

### D6 renderer 模块形态：新建 notes.js / notes.css + shell section 挂载（备选：塞进 shell.html 内联）

- **B：shell.html 内联**（view 状态机就在 shell.html）。
- **A（选定）：`src/renderer/notes.js` + `src/renderer/notes.css` 独立模块，shell.html 新增 `<section id="notes">` + `<script src="notes.js">`**。
- 理由：壳内既有模块全是此形态（kanban.js/tokens.js/connections.js/workflows.js/notifs.js，`src/renderer/shell.html:1607-1615` 挂载、`:526-547` section 挂载）；shell.html 已 1600+ 行，内联只会加速腐化。view 态接入点：`'placeholder:notes': 'nav-notes'` 加入 VIEW→NAV 表（`src/renderer/shell.html:805-811`），nav 按钮插于「任务看板」后（`src/renderer/shell.html:466-467`），setView 机制（`:748,753-756`）零改动。EasyMDE/markdown-it/DOMPurify 走既有 vendored 全局（`src/renderer/kanban.js:68-91` 同管线）。

### D7 frontmatter 回写：复用 skills/frontmatter.ts 的「最小解析器 + 行级文本操作」模式，泛化为通用键（备选：引 YAML 库）

- **B：引 gray-matter/js-yaml**——解析强但重排键序、引入依赖，违背「未知键与键序保留」（CON-R-notes-005）。
- **A（选定）：新建 `src/notes/frontmatter.ts`，算法与 `src/skills/frontmatter.ts:24-69`（parseFrontmatter：--- 边界 + 行级 key:value、坏行跳过永不抛错）同构，键集泛化为任意 key → string**（skills 版 `assign()` 硬编码四键且忽略未知键，`src/skills/frontmatter.ts:71-79`，不满足保真，故不直接 import）。回写 = key 级行级重建，模式对齐 `setMetadataSource`（`src/skills/frontmatter.ts:87-124`：定位键行替换 / 块尾追加，不重排其它行）。
- 解析失败/无 frontmatter：不改写原块，文件头注入新 frontmatter 块，正文逐字节不动（契约 §接口详情 3-4，CON-R-notes-005）。tags 数组值按行内 `[a, b]` 文本处理，不引 YAML。

## 3. 模块划分

### main 进程

| 文件 | 职责 | N |
|---|---|---|
| `src/notes/types.ts` | NoteIndexEntry / NoteDetail / SaveInput / TrashEntry / IndexChangedPayload / 错误码常量（契约 §Schema 原样落型） | N1 |
| `src/notes/pathGuard.ts` | 路径安全：resolve 后须在 notes.dir 内；拒 `..`/绝对路径/隐藏段；basename(realpath) 校验（CON-R-notes-013），镜像 `src/skills/pathGuard.ts:21` isWithinRoots 模式（不反向依赖 skills 模块） | N1 |
| `src/notes/frontmatter.ts` | 通用键 frontmatter 解析 + key 级回写（D7） | N1 |
| `src/notes/NotesStore.ts` | 文件操作：get / save（原子写 + mtime 乐观锁 + 三种 strategy）/ create / move；冲突副本命名 | N1 |
| `src/notes/NotesScanner.ts` | 启动全量扫描（跳隐藏目录与 .trash，仅 .md）→ 内存索引；scanning/ready/degraded 状态机；全量重建 | N1 |
| `src/notes/NotesWatcher.ts` | chokidar 封装：增量事件 → 索引更新 → indexChanged 推送；回声抑制（D5）；失效降级 30s 重扫 | N1 |
| `src/notes/NotesTrash.ts` | .trash 实体 + trash.json manifest（原子写 + 损坏重建）；restore 冲突不覆盖；TTL 30d / 500MB 清理（启动 + 每 24h + trashList 惰性触发） | N1 |
| `src/notes/NotesIpc.ts` | `registerNotesIpc(...)`：10 通道 handle + toResult 包装（对齐 `src/kanban/KanbanIpc.ts:46-52,55-96`）；失败分支扩展字段透传对齐 `src/skills/ipc/skillsHandlers.ts:15` | N1 |
| `src/settings/SettingsProvider.ts`（改） | notesDir 字段 + SCHEMA_VERSION 3→4（`src/settings/SettingsProvider.ts:49`）+ migrate() 补默认 null（`:200-246` 模式不变）+ set 后 `emit('changed')`（`:192` 既有） | N4 |
| `src/main/index.ts`（改） | 装配：new NotesService → `registerNotesIpc`（对齐 `src/main/index.ts:98` registerKanbanIpc）；`settings.on('changed')` → 校验新目录（存在、为目录、不在 DSH_HOME 内）→ `setNotesDir` 重扫；`hull:showNotes` 镜像 `hull:showBoard`（`:775-787`）；dialog:pickDirectory / hull:copyText 复用零改动（`:516,:895`） | N1/N4 |

### renderer 进程

| 文件 | 职责 | N |
|---|---|---|
| `src/renderer/notes.js` | 视图状态机（列表态/编辑态/保存冲突态/就绪态）+ 目录树（按 entries[].path 派生）+ 列表 + 编辑器（EasyMDE 工厂模式对齐 `src/renderer/kanban.js:80-91`）+ 自动保存编排（D4）+ 搜索 UI + 操作（新建/移动/删除/回收站）+ 冲突分流弹窗 + 任务关联 UI（选择器/徽章）+ TaskNotesMap 反查派生 | N2/N3 |
| `src/renderer/notes.css` | 三区布局与组件样式（设计令牌复用 T1） | N2 |
| `src/renderer/shell.html`（改） | nav 按钮 + `<section id="notes">` + VIEW→NAV 表项 + script/css 挂载（D6） | N2 |
| `src/renderer/kanban.js`（小改） | 📝 角标渲染 + openDetail 跨模块触达点（暴露既有 `openDetail`，`src/renderer/kanban.js:1143`，TBD-2 渲染层内部扩展，无新 IPC） | N3 |
| `src/preload/index.ts`（改） | `window.notes` 桥：10 invoke 原语 + `onIndexChanged` 订阅（ipcRenderer.on 白名单封装），模式对齐 `window.kanban`（`src/preload/index.ts:176-195`）；`hull.showNotes`（`:27` pickDirectory 同款） | N1/N2 |

### 依赖方向（单向，禁止反向）

```
main/index.ts ──装配──▶ NotesIpc ──▶ NotesStore/NotesScanner/NotesTrash/NotesWatcher ──▶ frontmatter/pathGuard/types
                          ▲ settings.on('changed')（SettingsProvider 不依赖 notes）
renderer: shell.html ──▶ notes.js ──(仅经桥)──▶ window.notes / window.hull / window.kanban（kanban.js 与 notes.js 互不 import，跨模块跳转经 DOM 事件/暴露函数，TBD-2/3）
preload: 桥薄封装，不持业务态
```

## 4. 关键机制实现形态

### 4.1 原子写 + mtime 乐观锁 + 冲突分流

1. **写盘**：`writeFileSync(path.tmp)` → `renameSync(tmp, path)`，对齐 `src/kanban/KanbanStore.ts:295-303`。同盘 rename 原子，无需 fsync 级保证（笔记非交易数据，崩溃最坏丢一篇草稿——与看板 500ms 防抖同风险档，接受）。
2. **校验**（save strategy 缺省，写盘前）：`statSync` 磁盘 mtime ≠ expectedMtime → `notes-conflict-modified`（detected.diskMtime）；文件不存在 → `notes-conflict-deleted`。均不写盘。
3. **strategy='overwrite'**：跳过 mtime 校验；文件已删除仍拒（不静默重建）。**strategy='saveAsCopy'**：写 `<基名> (冲突副本 YYYY-MM-DD).md`（同名已存在追加序号——契约 TBD 项，按建议实现 `(冲突副本 YYYY-MM-DD) 2`，实现时以契约定稿为准）。
4. **frontmatterPatch**：写盘后对落盘内容做 key 级回写（4.5），一次性完成——注意契约流程是「写盘后回写」，实现为：content 与 patch 合成最终文本后**单次原子写**（等价且少一次 IO，不违背契约可观察行为：最终文件 = 全文 + patch 生效）。
5. **渲染层分流**：notes-conflict-modified → 三选弹窗（覆盖=overwrite / 另存冲突副本=saveAsCopy / 放弃）；notes-conflict-deleted → 二选（另存新文件=saveAsCopy / 放弃）。冲突态阻断自动保存直至用户选择（N2 契约视图状态）。弹窗用渲染层 modal 纪律（对齐 `src/renderer/kanban.js:1059-1067`，Esc/遮罩关闭）。

### 4.2 索引重建/增量 + indexChanged 节流

- 启动：`scanner.scan()` 异步触发（幂等，scanning 中重入返回同一 Promise，对齐 `src/skills/SkillsScanner.ts:121-128`），不阻塞窗口；完成后推 `indexChanged{reason:'rescan'}`。
- 全量扫描：递归 readdir（跳过 `.` 开头目录与 `.trash`，仅 `.md`）→ 限并发读文件（并发 8）→ 单次 read 派生 frontmatter + snippet（前 200 字符，换行折叠）+ mtime。快照原子替换（构建完新 Map 再整体 swap，旧快照持续可读——`src/skills/SkillsScanner.ts:105` 模式）。
- 增量：watch 事件（经回声抑制）→ 单文件重读/删除 → 更新 Map 对应项 → 推 `indexChanged{reason:'incremental'}`。
- **节流**：批量外部写入（git pull、批量粘贴）会在窗口内产生大量事件 → 同一 reason 的推送 500ms 合并（防抖），渲染层本来就走「重拉 notes:index 全量」，无需 diff。

### 4.3 watch 回声抑制 + 30s 降级重扫

- 自写登记：NotesStore/Trash 每次成功写/删后调 `watcher.markSelfWritten(absPath)`（Set + 时间戳，1s 过期）。watch 回调先查集合，命中即吞（D5）。
- rename → delete+add 两条事件处理（契约 §Watch 细节）。
- chokidar 初始化失败或运行中 error/close → 状态机切 degraded，启动 30s setInterval 全量重扫（`reason:'rescan'`），重扫成功且能重建 watch 则回 ready。
- notes.dir 切换：destroy 旧 watch → 新目录全量重扫 → `indexChanged{reason:'dir-changed'}`（`setNotesDir` 幂等：同目录重复设置直接返回）。

### 4.4 trash 生命周期

- **delete**：`renameSync(notes.dir/path, .trash/tr_<uuid>.md)` + manifest 追加条目（id/originalPath/deletedAt/sizeBytes，对齐 `src/skills/types.ts:85,91` 命名先例）。manifest 原子写；`tr_<uuid>` 碰撞概率忽略（uuid）。
- **restore**：目标 `notes.dir/<originalPath>` 存在 → `notes-restore-conflict`（不覆盖，targetPath 透传）；否则 rename 回 + manifest 移除。
- **purge**：unlink 实体 + manifest 移除；实体已丢失仍移除 manifest（幂等收敛）。
- **TTL/容量清理**：启动时 + 每 24h 定时 + trashList 调用惰性触发；先删 age ≥30 天（deletedAt 起算，恰好 30 天算过期），再循环删 deletedAt 最旧至总容量 <500MB。删除以 manifest 条目为准，实体 unlink 失败（如 Windows 占用）跳过记日志，下次清理重试。
- **manifest 损坏**：备份 `trash.json.corrupt-<ts>` + 重建空清单（对齐 `src/kanban/KanbanStore.ts:258-263`）；`.trash` 中无 manifest 条目的孤儿文件保留不展示（契约 TBD，v1 不纳入 TTL 清理）。
- **物理位置**：固定 `<userData>/notes/.trash/`，独立于 notes.dir（改址不跟随，避免污染用户 git 仓库，CON-R-notes-007）。

### 4.5 frontmatter key 级回写保真

- 输入 = 文件全文 + patch（title/type/task/tags，task:null 表清除）。
- 有合法 frontmatter：在 `---` 块内按行定位 patch 键 → 原行替换（值经 stripQuotes 同款处理）；键不存在 → 闭合 `---` 前追加；未知键与键序原样保留（行级操作天然保真，D7）。
- 解析失败/无 frontmatter：`---\ntitle: ...\n---\n\n` 注入文件头，正文逐字节不动。
- 冲突副本 / parse-fail 均有单元测试锁定（§5）。

### 4.6 自动保存 flush 时机与视图切换交互

| 触发 | 行为 |
|---|---|
| 内容变化 | debounce ~2s → notes:save（携带最新 expectedMtime） |
| 编辑器失焦 | 立即 flush |
| 切换笔记 / 切换视图（nav） | 先 flush（await 或标记 pending）再切换；save 在途时目标视图照常切换，save 结果不阻塞 UI |
| 关窗 | 尽最大努力 flush，失败/冲突不阻塞关窗，下次打开走冲突分流 |
| Cmd/Ctrl+S | 立即保存（keydown 拦截，仅编辑态） |

- **save 在途防重**：同一笔记同时只允许一个在途 save（inFlight 标记），debounce 期间新变更合并进缓冲，在途返回后若有新变更再排下一次。save 响应的 mtime 恒更新为本地基线（乐观锁链条不断）。
- **冲突态交互**：进入冲突态后暂停自动保存并挂起缓冲，用户三选/二选后按所选 strategy 重发；「放弃」则丢弃缓冲回读磁盘态。

### 4.7 路径安全校验点

- **唯一入口**：NotesIpc 每个收路径参数的通道第一步调 `pathGuard.resolveSafe(notesDir, relPath)`，通过后才进 Store/Trash——不在各方法内散落校验（单点强制，对齐 CON-R-skills-007）。
- 规则：resolve 后必须位于 notes.dir 内；拒 `..` 段、绝对路径、任一 `.` 开头隐藏段；文件名 basename(realpath) 校验防符号链接逃逸。违规 → `notes-path-invalid`。trashId 走 `^tr_<uuid>$` 白名单校验。
- 校验以 notes.dir **生效路径**为准（notesDir ?? userData/notes），notes.dir 本身不在 DSH_HOME 内的校验在 settings 接线侧（N4）。

### 4.8 性能路径（300 篇 <2s）

- **并行读**：全量扫描限并发（8）批量读文件，单次 read 同时派生 frontmatter/snippet/mtime，不做二次 stat/read。
- **仅内存索引**：无持久化 IO（D2）；启动即后台扫，用户点 nav 时大概率已 ready。
- **一次取数**：渲染层首载只 invoke 一次 `notes:index`，树/列表/type 徽章/TaskNotesMap 全部由同一份 entries 派生，零重复请求。
- **渲染**：列表增量 DOM 构建（无框架，同 kanban.js 惯例）；编辑器 EasyMDE 实例仅打开时创建、关闭即 destroy（Q-041 纪律，`src/renderer/kanban.js:80-91,1009`）。
- e2e 计时断言见 §5；CI 抖动降级手动（契约 T1-01 口径）。

## 5. 工程基线

**三问核验**：

1. git ✓（feature/notes worktree，分支就绪）
2. 脚手架 ✓（Electron + TypeScript 既有工程，main/preload/renderer 目录结构成型）
3. 测试框架 ✓（node:test 单测既有惯例 + Playwright e2e 既有管线，跟随 S7 测试验收口径）

**技术栈**：全跟随既有栈——TypeScript / node:fs / Web Components-free 原生 DOM / EasyMDE + markdown-it + DOMPurify（vendored，CON-R-editor-001/004 复用）。**新增运行时依赖仅 chokidar ^4**（理由见 D2；若 PM 否决 → fs.watch 降级路径已定义，接口不变）。

**测试分层计划**：

| 层 | 范围 | 关键用例 |
|---|---|---|
| 单元（node:test） | NotesStore / NotesTrash / frontmatter / pathGuard / NotesScanner | 原子写崩溃残留（.tmp 不影响旧文件）；mtime 冲突三分支（缺省/overwrite/saveAsCopy）；frontmatter 保真（未知键/键序/parse-fail 头注入）；路径逃逸用例（`..`/绝对/隐藏段/符号链接）；manifest 损坏重建；TTL 边界（恰好 30 天）；扫描跳过隐藏目录与 .trash |
| 集成（node:test，临时目录） | watch → index → IPC 管线 | 外部写文件 → 索引更新 → indexChanged 收到；回声抑制（自写 1s 内事件不推送）；watch 失效 → degraded → 30s 重扫（用短间隔注入时钟）；setNotesDir 重扫 + dir-changed |
| e2e（Playwright） | 视图主链路 + 跨模块 + 冲突 | 300 篇种子首行 <2s 计时（T1-01）；nav 进入→打开→编辑→自动保存→外部改→三选→另存副本；删除→回收站→恢复（占位/冲突各一）；任务关联：选择器回写 task → 看板角标计数 → 点角标切视图打开笔记；就绪态占位（TN2-12） |

## 6. 目录/工程结构（新增/修改）

```
src/
├── notes/                      # 全新目录（main 进程）
│   ├── types.ts                # NEW 数据结构与错误码
│   ├── pathGuard.ts            # NEW 路径安全
│   ├── frontmatter.ts          # NEW 通用键解析 + key 级回写
│   ├── NotesStore.ts           # NEW 文件操作 + 乐观锁 + 冲突分流
│   ├── NotesScanner.ts         # NEW 扫描 + 内存索引
│   ├── NotesWatcher.ts         # NEW chokidar 封装 + 回声抑制 + 降级
│   ├── NotesTrash.ts           # NEW 回收站
│   └── NotesIpc.ts             # NEW IPC 注册（10+1 通道）
├── settings/SettingsProvider.ts  # MOD notesDir + schemaVersion 4
├── main/index.ts                 # MOD 装配 + settings 订阅 + hull:showNotes
├── preload/index.ts              # MOD window.notes 桥 + hull.showNotes
└── renderer/
    ├── notes.js                # NEW 视图逻辑
    ├── notes.css               # NEW 样式
    ├── shell.html              # MOD nav/section/VIEW→NAV/script 挂载
    └── kanban.js               # MOD 角标 + openDetail 暴露（N3 TBD-2）
docs/design/N-笔记-notes-design.md  # 本文档
```

## 7. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | **fs.watch 跨平台差异**（Linux 无递归、Windows 事件抖动） | 首选 chokidar 归一（D2）；watch 失效统一降级 30s 重扫；乐观锁保证事实源正确性不依赖 watch |
| R2 | **大目录扫描**（用户指向超大目录，如整仓 git repo） | 仅 `.md` 入索引；隐藏目录/.trash/node_modules 等点开头目录全跳过；扫描异步不阻塞；索引条目只存元数据+200 字符摘要，内存有界（但 10 万篇级文件量会慢——v1 验收口径 300 篇，超界不在范围） |
| R3 | **冲突副本命名碰撞**（同日多次另存、同名副本已存在） | 追加序号策略（契约 TBD 建议项），实现前以契约定稿为准；单元测试锁定 |
| R4 | **外部半写文件**（编辑器原子写中途被扫到） | chokidar awaitWriteFinish（~300ms）过滤半写；解析失败按「三键视为空」照常入索引（CON-R-notes-005），下次事件自动修正 |
| R5 | **trash 孤儿文件**（manifest 损坏重建后 .trash 残留实体） | 保留不展示（契约 TBD 口径）；磁盘占用由 500MB 容量清理的 manifest 侧推进，孤儿实体不计入——若用户报告再议纳入清理（登记开放项） |
| R6 | **EasyMDE 实例生命周期泄漏**（频繁切换笔记/视图） | 沿用 Q-041 纪律：每开新建、关即 destroy，关闭清理栈模式对齐 `src/renderer/kanban.js:1009`；e2e TN2-16 反复切换验证 |
| R7 | **chokidar 新增依赖（已确认）** | Q-074 定案已批准「首选 chokidar」（必要性论证见 D2）；fs.watch 降级路径备而不用，接口不变 |

## 8. 核验记录

### 评审记录
- 评审机制：self-check（团队配置未配置评审机制，按默认）· 评审人：AI · 日期：2026-09-11 · 结论：**通过**
- 依据：结构完整（8 节）/ 4 份冻结契约逐项对齐（接口以契约为准）/ 7 项架构决策含备选与理由 / 8 项关键机制实现形态明确 / 风险 7 条均有对策；R7 chokidar 经 Q-074 定案确认

### 交付核验（2026-09-11，ora-1 四层核验）
- 判级匹配：✅（实际复杂度 = 复杂：跨进程 + 文件事实源 + 乐观锁 + 跨模块关联；实现纪律完整执行：TDD + oracle 评审 + semgrep）
- 设计对照：✅ PASS——D1~D7 逐项落实；有意偏离 1 处已备案（notes:mkdir 第 11 通道，v1.1 集成期 Q-075，契约已回写）
- 契约对照：✅ PASS——4 份契约逐项核对；评审修复（strategy 白名单 / win sep 归一）已回写 N1 契约 v1.1 变更记录
- 测试：typecheck clean · unit 1077/1077（notes 套件 61 用例）· e2e notes 6 + kanban 8 + settings 3 全绿 · semgrep 0 findings
- review：oracle 评审 4🟠 + 6🟡 全部修复（11 项，均配回归测试）

