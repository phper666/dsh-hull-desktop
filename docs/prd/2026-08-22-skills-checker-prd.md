# Hull Desktop（dsh-hull-desktop）Skills Checker PRD

> 版本：v0.2　|　日期：2026-08-22　|　状态：已定案（用户评审确认决策）
> 范围：B2 —— 壳内 Skills 检查器（独立视图）

---

## 1. 背景与定位

Hull Desktop 壳内已接入多 agent 工作流（任务看板、共识/契约/实现管道）。团队通过 `npx skills add` / 各 agent 平台按目录约定安装 skills，但这些 skills 散落在多个 agent 平台的目录里（`~/.claude/skills/`、`~/.config/opencode/skills/`、`~/.agents/skills/`、`~/.codex/skills/`、`~/.gemini/skills/`、`~/.cursor/skills/`），存在几类痛点：

- **看不清**：同一个 skill 到底在哪些 agent 平台生效？全局还是仅某平台？SKILL.md 的功能描述在哪看？
- **找不到源头**：skill 从哪个 GitHub 仓库装的？没记录来源就无法升级、无法定位维护方。
- **升级靠手记**：没有统一入口检查 skill 是否有新版，升级要自己记 git remote 去 pull。
- **清理靠命令行**：移除/禁用某个 skill 要手敲 rm / 改目录，易误删。

**Skills Checker 目标**：在壳内提供一个**独立视图**，统一扫描各 agent 平台的 skill 目录，展示全局/平台归属、功能描述、来源地址（可点击跳转）、版本升级检测（一键升级），并支持搜索、按平台筛选、禁用/启用、移除。

**红线检查**：本功能读写的是**用户 agent 配置目录**（`~/.claude`、`~/.config/opencode`、`~/.agents`、`~/.codex`、`~/.gemini`、`~/.cursor`、`~/.cc-switch`）——**非 DSH_HOME**，不触 CON-R002。破坏性操作（移除/升级/禁用）走确认流程；功能为壳层增量能力，不 fork/patch 任何 agent 平台本体，不触 CON-R001/CON-R004（纯文件系统扫描与管理，不注入 dsh 内部）。

## 2. 目标用户与场景

| 用户 | 场景 |
|---|---|
| 程序员（主力） | 装了很多 skills 但记不清各平台生效范围，要统一查看/搜索/升级/清理 |
| 团队协作成员 | 装了团队共识流程类 skills（phper666-* 系列），要核对来源仓库、升级到最新、禁用不需要的 |
| 多 agent 用户 | 同时用 claude-code / opencode / codex / gemini-cli / cursor，需要按平台筛选各平台实际生效的 skills |

**核心用户故事**：*"我是一个装了一堆 skills 的开发者，我希望在壳里打开 Skills 检查器，一眼看到每个 skill 在哪些 agent 平台生效、描述是啥、从哪来的，点来源就能跳到仓库，有新版就点一下升级，不想要的能搜索到并禁用/移除。"*

## 3. 产品原则（不变量）

1. **只读扫描 + 确认后写**：扫描/检测只读；移除/升级/禁用/启用为破坏性操作，必须二次确认。
2. **官方目录约定**：agent→path 映射与各平台官方 skills 目录约定一致（硬编码注册表，见 §5.1）。
3. **不动 DSH_HOME**：本功能只读写用户 agent 配置目录，绝不触碰 `~/.dsh`（CON-R002）。
4. **升级检测 = 内容哈希**：本地 SHA-256（path+content 排序）对比远端哈希，非版本号对比（生态无统一 version 字段）。
5. **来源解析可降级**：metadata.source → lock 文件 → 构建 GitHub URL，三级解析，取不到则显示「来源未知」。
6. **壳层增量**：功能完全在壳内，不注入/不 patch 任何 agent 平台（CON-R001/CON-R004 相容）。

## 4. 范围

### 4.1 In Scope

- **独立视图**：新增壳导航项「Skills」，右侧占位视图切换为 Skills Checker（复用 S8 占位区块切换机制）。
- **统一扫描与列表**：扫描 6 个 agent 目录 + shared 目录，聚合 skill 列表，标记全局/平台归属。
- **功能描述**：解析 SKILL.md frontmatter（name/description/license/compatibility/metadata）。
- **来源地址**：解析源头（metadata.source → lock → 构建 GitHub URL），点击 `shell.openExternal` 跳转。
- **版本升级检测**：本地内容哈希 + 远端哈希对比，有新版 → 升级徽标 + 一键升级。
- **搜索**：按名称/描述/来源关键词过滤（本地搜索）+ 远程 marketplace 检索（本地/远程两个独立入口，分开展示）。
- **平台筛选**：按生效平台（claude-code / opencode / codex / gemini-cli / cursor / shared）筛选。
- **禁用/启用**：切换 skill 生效状态（移目录真禁用，方案见 FR-9 T-4 定案）。
- **移除**：确认后删除 skill 目录（移除前备份到 userData 回收站）。
- **状态栏/总计**：显示已扫描 skill 总数、可升级数、已禁用数。

### 4.2 Out of Scope（本轮不做）

- **远程安装/卸载新 skill**（远程仅浏览搜索结果，不落地安装）。
- **skill 创建/编辑**（只读查看，不改 SKILL.md 内容）。
- **CC（Claude Code）配置修改**（不改 `~/.claude/settings.json` 等配置）。
- **多设备同步 / 远程管理**。
- **跨平台打包**（延续 M1，仅 macOS Apple Silicon，代码跨平台友好）。

## 5. 数据模型与检测机制

### 5.1 Agent → 目录注册表（硬编码）

| Agent | 目录 |
|---|---|
| claude-code | `~/.claude/skills/` |
| opencode | `~/.config/opencode/skills/`（**同时读取** `~/.claude/skills/` 与 `~/.agents/skills/`） |
| codex | `~/.codex/skills/` |
| gemini-cli | `~/.gemini/skills/` |
| cursor | `~/.cursor/skills/` |
| shared / universal | `~/.agents/skills/` |

**全局 vs 平台 scoped 判定** = 文件系统位置 + symlink 解析（`realpath`）：

- `~/.agents/skills/` = universal（所有平台）；
- `~/.claude/skills/` = claude-code + opencode（opencode 会读）；
- `~/.config/opencode/skills/` = opencode 专属。

**重叠褶皱**：同一 skill 可能被多个 agent 读取（如 `~/.agents/skills/` 下的 skill，opencode 与其它平台都生效）；列表按 skill 名聚合，平台徽标显示全部生效平台。物理路径经 symlink 解析后，`~/.agents/skills` 与 `~/.claude/skills` 若 realpath 指向同一目录，避免重复计入。

### 5.2 Skill 元数据（SKILL.md frontmatter）

- `name`（必填）、`description`（必填）、`license`、`compatibility`、`metadata`（string map）。
- `metadata.source: <github-url>` 为社区约定（opencode 原生），无标准 version 字段 → 升级检测不走版本号，走内容哈希。

### 5.3 升级检测 = 内容哈希（生态共识）

- **本地哈希**：SHA-256 覆盖 skill 文件夹全部文件（path+content，排序后），保证顺序无关。
- **远端哈希来源（§12 T-1 定案）**：优先本机 skills-lock.json（`~/AI/skills-lock.json`）记录；次选 git remote tree SHA 计算；均无 → 「无法检测」。
- 对比一致 → 最新；不一致 → 可升级徽标。

### 5.4 来源地址解析顺序

1. SKILL.md frontmatter `metadata.source`（优先级最高，直接可用）；
2. lock 文件 `source` + `skillPath` → 构建 `https://github.com/<owner>/<repo>/tree/<branch>/<skillPath>`；
3. 均无 → 显示「来源未知」，升级入口禁用。

### 5.5 参考实现

cc-switch（https://github.com/farion1231/cc-switch，本机 `~/.cc-switch/cc-switch.db`）：skills 表含 per-agent 布尔（enabled_claude/enabled_codex/enabled_gemini/enabled_opencode/enabled_hermes）、content_hash、readme_url。本功能参考其 per-agent 生效布尔 + content_hash 思路，但数据自管（壳 userData），不依赖 cc-switch 运行。

## 6. 功能需求

### FR-1 导航入口激活（独立视图）

- `shell.html` 新增 nav 项「Skills」，点击切换右侧内容区为 Skills Checker 视图（复用 S8 占位区块切换，主进程驱动）。
- 视图为壳内页面（`file:` 协议，partition 'shell' + preload 桥），与官方 WebContentsView 互斥显示。
- 验收：点击「Skills」→ 右侧显示检查器视图；点击「dsh web」→ 切回官方 UI；视图互斥不干扰。

### FR-2 统一扫描与列表展示（全局 vs 平台 scoped）

- 进入视图触发扫描：遍历 §5.1 注册表目录，聚合为 skill 列表（按 name 去重，跨目录同 skill 合并平台徽标）。
- 每条 skill 展示：名称、功能描述（frontmatter description 截断）、平台徽标（claude/opencode/codex/gemini/cursor/shared）、全局/平台 scoped 标识、来源地址、升级徽标、启用状态。
- 全局判定 = 存在于 `~/.agents/skills/`（universal）或 realpath 指向共享目录；否则按生效平台标 scoped。
- 顶部状态：已扫描总数 / 可升级数 / 已禁用数。
- 验收：扫描 6 目录聚合正确；同 skill 跨目录合并为一个条目且平台徽标完整；全局 skill 明确标记「全局」，平台 skill 标记具体平台；symlink 重复（realpath 同源）不重复计数。

### FR-3 功能描述展示

- 解析 SKILL.md frontmatter description（必填字段），列表展示（截断 2 行，详情可展开/悬浮查看全文）。
- 缺失 description 的 skill 显示「无描述」占位。
- 验收：description 正常解析展示；缺失时占位不报错。

### FR-4 源头地址可点击跳转

- 按 §5.4 三级顺序解析 source URL。
- 列表显示来源链接（图标 + 仓库名），点击经 preload 桥调用 `shell.openExternal` 跳转浏览器。
- 解析失败显示「来源未知」，链接置灰不可点。
- 验收：metadata.source 存在 → 点击跳转该 URL；仅有 lock 信息 → 跳转构建的 GitHub tree URL；均无 → 置灰「来源未知」，不误跳。

### FR-5 移除 skill

- 每条 skill 提供「移除」操作 → 二次确认弹窗（显示将删除的物理路径 + 受影响平台清单，明确「移除 = 删除该 skill 目录/文件，不可恢复」）。
- 确认后删除对应 skill 目录（跨平台同名的逐目录删除；全局 skill 移除提示影响所有平台）。
- 移除完成刷新列表，顶部计数更新；操作日志写入壳事件日志。
- 验收：移除前必弹确认（含路径 + 影响平台）；确认后目录实际删除、列表即时刷新；全局 skill 移除有额外警示；取消不产生任何变更。

### FR-6 版本升级检测 + 一键升级

- 本地内容哈希计算（§5.3）→ 对比远端哈希 → 不一致则显示「可升级」徽标。
- 点「升级」→ 确认弹窗（当前哈希 → 远端哈希，来源 URL）→ 执行升级（§12 T-3 定案：优先 `npx skills update`，symlink 来源次选 git pull，不重 clone）。
- 升级进度展示；成功/失败回显；升级失败不破坏现有 skill（原子替换：staging → 替换，失败回滚）。
- 远端哈希不可获取（无 lock、无 source）→ 不显示升级徽标，提示「无法检测版本」。
- 验收：本地/远端哈希一致的 skill 无升级徽标；不一致有徽标且点升级可执行；升级失败回滚到原版本；无来源 skill 显示「无法检测」且升级入口禁用。

### FR-7 搜索（本地 + 远程，分开）

- **本地搜索**：顶部本地搜索框，实时过滤已扫描 skill 列表——按名称 / 描述 / 来源关键词（大小写不敏感，支持中文）。
- **远程搜索**：独立远程搜索入口（tab），检索远端 skills marketplace（`npx skills find <q>` / skills.sh API）；本地/远程结果永不混合在同一列表，切换入口清空对方结果。
- **远程安装边界**：远程搜索结果仅浏览（详情/来源跳转），不提供安装/卸载；远程不可用时提示「远程不可用」，不影响本地列表。
- 无匹配 → 空态提示「未找到匹配的 skill」。
- 验收：本地关键词输入即时过滤；远程搜索返回 marketplace 结果且与本地列表分开展示；远程无安装入口；无结果显示空态；清除搜索恢复全量。

### FR-8 平台筛选

- 平台筛选下拉（全部 / claude-code / opencode / codex / gemini-cli / cursor / shared）+「仅看可升级」「仅看已禁用」快捷开关。
- 筛选与搜索可组合。
- 验收：按平台筛选只显示该平台生效的 skill（opencode 选中时含 `~/.claude` 与 `~/.agents` 读取的）；组合筛选即时生效；无匹配显示空态。

### FR-9 禁用 / 启用

- 每条 skill 提供启用/禁用开关。
- **禁用语义（§12 T-4 定案 = 移目录真禁用）**：禁用 = 将 skill 目录物理移出 agent 读取目录到 disabled 目录（如 `<userData>/skills/disabled/<skill-name>/`）；启用 = 移回原目录。agent 平台真生效——skill 对 agent 完全不可加载，非壳内白名单。
- 禁用/启用即时反映到列表状态与计数；移动失败不破坏原目录。
- 验收：禁用后该 skill 在 agent 平台真实不可加载（`~/.claude`、`~/.config/opencode` 等目录中已不在读取位置）；启用后恢复原位；列表标记「已禁用」且「仅看已禁用」可筛出；不破坏 SKILL.md 文件内容。

### FR-10 扫描性能与缓存

- 扫描为异步后台任务，UI 先展示骨架/部分结果，不阻塞交互。
- 内容哈希计算结果缓存（skill 目录 mtime 变化才重算）。
- 验收：>200 个 skill 时首屏渲染 < 2s；哈希计算在后台线程/分批执行，不卡 UI；目录未变化时二次扫描命中缓存。

## 7. 非功能需求

| 项 | 要求 |
|---|---|
| 平台 | 仅打包 macOS Apple Silicon（延续 M1）；代码跨平台友好（process.platform 分支、path 处理从第一天写好） |
| 性能 | 扫描 + 哈希异步化；首屏 < 2s（200+ skill）；哈希缓存；UI 不阻塞 |
| 安全 | 破坏性操作（移除/升级/禁用）二次确认；renderer 仅经 preload 桥访问壳能力；`shell.openExternal` 只接受解析后的 https URL（白名单校验，拒绝 file:/javascript: 等） |
| 数据 | 壳自身状态（disabled 目录/回收站、哈希缓存、操作日志）存 `<userData>/skills/`；不写 agent 目录之外的系统区域；不触 DSH_HOME |
| 稳定性 | 升级原子替换 + 失败回滚；移除/禁用操作失败提示且不破坏既有 skill 文件 |
| 兼容 | 各 agent 平台目录约定变化 → 注册表集中维护（§5.1 单点），升级/迁移成本低 |

## 8. 异常与边界

| 场景 | 行为 |
|---|---|
| agent 目录不存在（未装某 agent） | 扫描跳过该目录，平台筛选下拉仍保留但计数为 0，标注「未安装」 |
| SKILL.md 缺失/frontmatter 解析失败 | skill 仍列出（按目录名），描述显示「无描述/无法解析」，来源未知 |
| 来源 URL 缺失 | 显示「来源未知」，跳转/升级禁用 |
| 远端哈希获取失败（断网/lock 缺失） | 不显示升级徽标，提示「无法检测版本」；本地列表不受影响 |
| 移除/升级中途失败 | 提示错误；升级失败自动回滚到原版本；移除失败保留原目录（回收站副本可恢复） |
| 目标目录权限不足 | 操作报错 + 提示以 `open` 打开目录手动处理；不静默失败 |
| symlink 循环/异常路径 | 扫描时 realpath 检测循环引用，跳过异常项，不阻塞整体扫描 |
| 同 skill 多处安装且版本不同 | 以全局（shared）为准标记，平台徽标注明各路径；升级按目录逐处处理 |
| 壳与 agent 同时操作同一 skill 目录 | 写操作前检查目录 mtime，冲突提示「已被外部修改，请刷新」 |

## 9. 依赖与风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 各 agent 平台 skills 目录约定无官方统一规范 | 扫描遗漏/误判 | 注册表集中维护（§5.1）；实现期逐一验证；opencode 多目录读取特性（§5.1）单独处理 |
| 升级方案 | 升级行为一致性 | §12 T-3 已定案：`npx skills update` 优先 / git pull 次选 / 不重 clone；原子替换 + 回滚兜底（FR-6） |
| metadata.source 为社区约定，非标准 | 部分 skill 无来源 | 三级解析降级（§5.4）；无来源显示「来源未知」 |
| 内容哈希生态共识但无唯一权威实现 | 本地/远端哈希口径不一致 | 对齐 skills-lock.json / cc-switch content_hash 口径；实现期以 lock 文件实测为准 |
| 破坏性操作误删用户 skill | 数据丢失 | 二次确认 + 展示路径/影响平台；移除前备份到 userData 回收站（`<userData>/skills/trash/`，可恢复）；操作日志留痕 |
| 远端哈希获取 = git 计算/API 调用 | 网络依赖、耗时长 | 优先 skills-lock.json（本机缓存、零网络），次选 git remote tree SHA；后台异步 + 缓存（FR-10）；失败降级为「无法检测」 |

## 10. 开放问题

### 10.1 已定案

| 编号 | 问题 | 结论 |
|:-----|:-----|:-----|
| D-1 | UI 形态：设置卡片 vs 独立视图？ | **独立视图**——新增 nav 项 + 占位视图，与看板同级（已确认） |
| D-2 | 数据归属？ | 壳 userData（`<userData>/skills/`），不写 DSH_HOME（CON-R002 相容） |
| D-3 | 升级检测机制？ | 内容哈希（SHA-256，path+content 排序），非版本号（生态无统一 version） |
| D-4 | 来源解析顺序？ | metadata.source → lock source+skillPath → 构建 GitHub URL；三级降级（§5.4） |

### 10.2 未决项（评审定案）

| 编号 | 问题 | 结论 |
|:-----|:-----|:-----|
| T-1 | 远端哈希从哪拿？git remote / skills.sh API / cc-switch db？ | **skills-lock.json 记录优先（`~/AI/skills-lock.json`），次选 git remote tree SHA 计算；均无则「无法检测」**（已关闭） |
| T-2 | 是否支持 marketplace 搜索（`npx skills find`）还是仅本地？ | **接入远程搜索，本地/远程分开两个入口；远程仅浏览不安装**（已关闭） |
| T-3 | 升级执行方式：`npx skills update` / git pull / 重 clone？ | **优先 `npx skills update`；symlink 来源次选 git pull；不重 clone；原子替换+失败回滚兜底**（已关闭） |
| T-4 | 禁用语义：移目录 vs 壳内白名单？ | **移目录真禁用：禁用移出 agent 读取目录到 `<userData>/skills/disabled/<skill-name>/`，启用移回；agent 平台真生效（否决壳内白名单）**（已关闭） |
| T-5 | 跨 agent 依赖：opencode 读取多个目录的生效集合如何展示？ | §5.1 褶皱处理已给初版，评审确认（保持 open） |
| T-6 | 移除前是否备份到 userData 回收站？ | **备份：移除前移入 `<userData>/skills/trash/`，可恢复**（已关闭） |

## 11. 完成定义（Done of Done）

- [ ] 导航「Skills」入口激活，独立视图可切换（FR-1）
- [ ] 6 目录 + shared 统一扫描聚合，全局/scoped 判定正确（FR-2）
- [ ] 描述解析、来源解析与点击跳转（shell.openExternal）可用（FR-3/FR-4）
- [ ] 移除流程：确认弹窗 + 实际删除 + 刷新（FR-5）
- [ ] 升级检测（内容哈希）与一键升级、失败回滚（FR-6）
- [ ] 搜索 + 平台筛选 + 可升级/已禁用快捷开关组合生效（FR-7/FR-8）
- [ ] 禁用/启用方案定案并可用（FR-9 + T-4 移目录真禁用）
- [ ] 扫描异步 + 哈希缓存，性能达标（FR-10）
- [ ] 破坏性操作全部二次确认；操作日志留痕；openExternal 白名单校验
- [ ] 本地/远程搜索两入口分开生效（FR-7）
- [ ] 移除前备份回收站（FR-5 + T-6）
- [ ] T-1~T-4、T-6 未决项已定案并回写 PRD；T-5 保持 open 待评审
- [ ] README「功能状态」更新；PRD 各验收项有对应测试用例

## 12. 开放问题已定案（评审结论）

> v0.2：用户评审已定案，回写共识 v1.1；此处保留决策记录供实现参考。

- **T-1 远端哈希**：skills-lock.json 优先（本机缓存零网络）→ git remote tree SHA 次选 → 均无「无法检测」。
- **T-2 远程搜索**：接入远程 marketplace 检索（`npx skills find <q>` / skills.sh API），与本地搜索分两个入口（tab），仅浏览不安装。
- **T-3 升级执行**：`npx skills update` 优先；symlink 来源 git pull 次选；不重 clone；原子替换 + 失败回滚兜底（FR-6）。
- **T-4 禁用语义**：移目录真禁用——禁用 = skill 目录移出 agent 读取目录到 `<userData>/skills/disabled/<skill-name>/`，启用 = 移回；agent 平台真生效（否决壳内白名单）。
- **T-5 跨 agent 重叠展示**：保持 open，评审确认 §5.1 褶皱处理。
- **T-6 移除备份**：移除前备份到 userData 回收站（`<userData>/skills/trash/`），可恢复防误删。

## 13. 原型索引

原型见 `docs/prototype/2026-08-22-skills-checker-prototype.html`：独立视图全貌（skill 列表 + 平台徽标）、搜索/筛选、来源跳转、升级徽标与确认、移除确认、禁用/启用开关、空态与「来源未知」降级展示，共 1 屏交互原型。
