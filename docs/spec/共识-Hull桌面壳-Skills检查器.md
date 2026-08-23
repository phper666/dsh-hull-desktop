# Hull 桌面壳（Skills 检查器）共识文档

> 版本：v1.4 · 更新：2026-08-24 · 维护者：phper666（PM） · 状态：已发布
> 数据来源：Skills Checker PRD v0.1（docs/prd/2026-08-22-skills-checker-prd.md）、交互原型（docs/prototype/2026-08-22-skills-checker-prototype.html）
> 关联：独立新需求（非 M2 看板增量）；需求标识 `skills`；B2 范围

## 1. 文档元信息

- **本版本变更**：v1.4 已发布——T-5 跨 agent 重叠展示定案关闭（实现已覆盖 §5.1 褶皱处理，确认定案，向后兼容不升主版本）：跨目录同名 skill 按 name 聚合、realpath 同源去重、平台徽标合并显示全部生效平台、全局路径优先展示（§5.3）；落地位置 SkillsScanner 七步管线（注册表遍历→realpath 解析去重→…→按 name 聚合）与前端平台筛选/多平台徽标。无新规则变化，T-5 由 open→已关闭。
- **历史变更摘要**：v1.3 已发布——Q-034 变更（CON-R-skills-004/005）：skills-lock.json 移除，升级检测只依赖标准位置（详见变更摘要-Skills检查器.md 2026-08-24 条目，实现已落地）。v1.2 已发布——BE/FE/QA 扫描待确认项 Q-031~Q-038 全部定案回写（均为确认/细化，向后兼容，不升主版本）：① **Q-031（BLOCKER）禁用按路径粒度**——每个物理路径独立禁用/启用；共享目录 skill 整体移出=全平台禁，平台专属副本单独禁；② **Q-032 禁用物理操作对象**——symlink 来源移除 symlink（源保留在原始仓库/SSOT），实目录来源 rename 到 disabled 目录，userData 记录被禁用路径+原路径映射；③ **Q-033 升级非 git/lock 来源**——无 source+无 lock → 升级入口禁用「无法检测版本」；有 metadata.source 非 git → 用 source URL 重新获取（staging→原子替换）；git clone 来源不原位 git pull（非原子），改 clone 到 staging→原子替换→失败回滚；④ **Q-034 远端哈希四级优先级**——skills-lock.json → 各平台 lock → cc-switch content_hash → git remote 临时 clone 计算，按 name 匹配、skills-lock 优先覆盖，均无 → unknown；⑤ **Q-035 回收站策略**——TTL 30 天自动清理 + 容量上限 500MB（最旧先删），恢复冲突提示，条目记录原路径+删除时间；⑥ **Q-036 搜索 UI 定型**——本地/远程两 tab 默认本地，远程结果展示名称/描述/来源/安装数、仅浏览标注「未安装」；⑦ **Q-037 破坏性操作可测性**——SkillFsOps 接口抽象 + 临时目录注入 e2e，真实目录留冒烟；⑧ **Q-038 路径穿越校验**——basename(realpath) 校验拒绝 ../空名/非法字符，openExternal 仅 ^https:// 白名单。
- **历史变更摘要**：v1.1 已发布——用户评审定案 T-1~T-4、T-6（T-5 保持 open）：① T-4 禁用=移目录真禁用（agent 平台真生效，否决壳内白名单）；② T-2 远程搜索接入、本地/远程分开展示（仅浏览不安装）；③ T-3 升级执行 npx skills update 优先/git pull 次选/不重 clone；④ T-1 远端哈希 skills-lock.json 优先/git remote 次选；⑤ T-6 移除前备份 userData 回收站；CON-R-skills-008 由「变更中」→「生效」（定案移目录），新增 CON-R-skills-010（本地/远程搜索分开）。v1.0 首次建立——从 Skills Checker PRD v0.1（待评审）+ 原型提取整理为业务事实源；登记 CON-R-skills-001~009（独立编号域）、未决项 T-1~T-6（PRD §10.2，评审前不关闭）。
- **状态说明**：v1.4 已发布（T-5 定案关闭 + Q-056 定案回写）；PRD 已升级至 v0.2 反映全部决策；T-1~T-6 全部关闭；扫描待确认项 Q-031~Q-038、Q-056 全部已关闭（§11.2）。

## 2. 文档结构总览

- **覆盖**：Hull 壳内 Skills 检查器（独立视图）全部业务面——agent→目录注册表与统一扫描聚合（claude-code/opencode/codex/gemini-cli/cursor/shared）、全局 vs 平台 scoped 判定、SKILL.md frontmatter 描述解析、来源解析（metadata.source）与点击跳转、升级检测（内容哈希）+ 一键升级、搜索/平台筛选/快捷开关、禁用/启用、移除。
- **适用范围**：仅 Hull 壳内 Skills 检查器（只读扫描 + 确认后写的文件系统管理）；**不覆盖** 各 agent 平台自身行为、官方 UI、dsh 内部——纯壳层增量能力。
- **不做事项（本轮明确排除）**：远程安装/卸载新 skill（远程仅浏览搜索，不落地安装，见 T-2）；skill 创建/编辑（只读查看，不改 SKILL.md 内容）；CC（Claude Code）配置修改（不改 `~/.claude/settings.json` 等）；多设备同步/远程管理；跨平台打包（延续 M1，仅 macOS Apple Silicon，代码跨平台友好）。
- **红线**：本功能只读写用户 agent 配置目录（`~/.claude`、`~/.config/opencode`、`~/.agents`、`~/.codex`、`~/.gemini`、`~/.cursor`、`~/.cc-switch`），不触 DSH_HOME（CON-R002 相容）；不 fork/patch 任何 agent 平台本体（CON-R001/CON-R004 相容，纯文件系统扫描与管理，不注入 dsh 内部）。

## 3. 领域术语表

| 术语 | 定义 | 出处 |
|:-----|:-----|:-----|
| skill | 装在某 agent 平台目录下、含 SKILL.md 的能力单元；本功能的最小管理单位 | PRD §1/§5 |
| 全局 skill | 存在于 `~/.agents/skills/`（universal，所有平台生效）或 realpath 指向共享目录的 skill | PRD §5.1/FR-2 |
| 平台 scoped skill | 仅特定平台生效的 skill；`~/.claude/skills/`=claude-code+opencode，`~/.config/opencode/skills/`=opencode 专属 | PRD §5.1/FR-2 |
| SKILL.md frontmatter | skill 目录内 SKILL.md 开头的 YAML 元数据：name（必填）/description（必填）/license/compatibility/metadata | PRD §5.2 |
| 内容哈希 | SHA-256 覆盖 skill 文件夹全部文件（path+content 排序后计算），升级检测判据，非版本号 | PRD §3.4/§5.3 |
| 来源解析 | 一级解析 skill 来源 URL（Q-034 v1.3 变更：lock 二级降级移除）：frontmatter `metadata.source` 匹配 `^https://` → 采用；无则「来源未知」 | PRD §3.5/§5.4 |
| 禁用/启用 | 切换 skill 生效状态的语义（T-4 定案 = 移目录真禁用；Q-031/Q-032 细化 = **按物理路径粒度**）：禁用 = 将该物理路径移出 agent 读取目录（symlink 来源 → 移除 symlink，源保留在原始仓库/SSOT；实目录来源 → rename 到 `<userData>/skills/disabled/<skill-name>/`），启用 = 恢复 symlink / rename 回原路径；agent 平台真生效，非壳内白名单 | PRD FR-9/T-4/Q-031/Q-032 |
| 注册表 | agent→目录映射（§5.1 硬编码），官方目录约定的单点维护 | PRD §5.1/§7 |
| 重叠褶皱 | 同一 skill 被多 agent 读取（如 `~/.agents/skills/` 下 skill 多平台生效）；按 skill 名聚合、平台徽标显示全部生效平台；symlink realpath 同源去重 | PRD §5.1 |
| 原子替换 | 升级执行方式兜底：staging → 替换 → 失败回滚，不破坏现有 skill | PRD FR-6/§7 |
| 升级执行方式 | 升级 skill 的执行路径（T-3 定案；Q-033 细化）：优先 `npx skills update`；git clone 来源**不原位 git pull**（非原子），改 clone 到 staging → 原子替换 → 失败回滚；有 metadata.source 非 git 来源用 source URL 重新获取（staging→原子替换） | PRD FR-6/T-3/Q-033 |
| 远端哈希 | 远端 skill 内容哈希来源（T-1 定案；Q-034 v1.3 变更，skills-lock.json 移除）：① 各平台 lock（`.arkcli-managed-skills.json` 等，name→sha256，标准位置）→ ② frontmatter metadata.source 推断 → ③ cc-switch content_hash（表空待办）→ ④ git remote 临时 clone（网络成本待办）；均无则 unknown「无法检测」 | PRD §5.3/T-1/Q-034 |
| 远程搜索 | 对远端 skills marketplace 的检索（`npx skills find <q>` / skills.sh API）；与本地扫描结果分开展示，仅浏览不安装 | PRD FR-7/T-2 |
| 回收站 | userData 回收站（`<userData>/skills/trash/`）——移除 skill 前备份目标，可恢复防误删；条目记录原路径+删除时间；TTL 30 天自动清理 + 容量上限 500MB（Q-035 定案） | PRD FR-5/T-6/Q-035 |

## 4. 模块概述

- **定位**：Hull 壳内 Skills 检查器——统一扫描各 agent 平台 skill 目录，解决「看不清/找不到源头/升级靠手记/清理靠命令行」四痛点，形成「查看 → 搜索/筛选 → 来源跳转 → 升级 → 禁用/移除」闭环。
- **业务目标**：① 统一扫描聚合展示全局/平台归属；② SKILL.md 描述解析 + 来源解析（metadata.source）可跳转；③ 内容哈希升级检测 + 一键升级（原子替换/回滚）；④ 搜索 + 平台筛选 + 禁用/移除管理，破坏性操作全部二次确认。
- **参与角色**：当前 solo（pm/be/fe/qa = phper666）；用户是唯一操作者；无 agent 执行方。
- **子模块清单**：agent 目录扫描器（注册表遍历/聚合/symlink 解析）、SKILL.md frontmatter 解析器、来源解析器（metadata.source）、哈希计算与缓存、升级执行器（原子替换）、壳 userData 状态层（disabled 目录/回收站/哈希缓存/操作日志，`<userData>/skills/`）、Skills 检查器视图 UI（含本地/远程双搜索）。

## 5. 业务流程与状态机

### 5.1 主流程（进入视图 → 操作）

1. 进入「Skills」视图 → 触发异步扫描（FR-10：后台任务，UI 先骨架/部分结果，不阻塞）；
2. 遍历 §5.1 注册表目录 → 聚合 skill 列表（按 name 去重，跨目录合并平台徽标；realpath 同源去重）；
3. 解析 SKILL.md frontmatter（描述/元数据）+ 来源解析（metadata.source）；
4. 哈希计算（缓存命中则跳过）→ 与远端哈希对比 → 标记可升级徽标；
5. 用户操作：搜索/筛选（即时过滤）→ 查看详情/来源跳转 → 升级/禁用/移除（均二次确认）→ 刷新列表与计数。

### 5.2 状态

- **skill 启用状态**（Q-031 定案：按物理路径粒度）：enabled（生效）/ disabled（已禁用，T-4 定案 = 该物理路径已移出 agent 读取目录）；**每个物理路径独立禁用/启用**——共享目录（`~/.agents/skills/`）skill 整体移出 = 全平台禁，平台专属副本（`~/.claude/skills/` 等）单独禁只影响该平台；列表条目 enabled 为各路径聚合展示，操作按路径逐条执行。
- **升级状态**：latest（本地=远端哈希）/ upgradable（不一致，显示可升级徽标）/ unknown（远端不可获取，「无法检测版本」，升级入口禁用）。
- **来源状态**：resolved（已解析 URL）/ unknown（「来源未知」，跳转/升级禁用）。

### 5.3 异常分支（PRD §8 摘要）

- agent 目录不存在 → 跳过该目录，筛选下拉保留但计数 0，标注「未安装」；
- SKILL.md 缺失/解析失败 → 按目录名列出，描述「无描述/无法解析」；
- 来源 URL 缺失 → 「来源未知」，跳转/升级禁用；
- 远端哈希获取失败（断网/lock 缺失）→ 不显示升级徽标，本地列表不受影响；
- 移除/升级中途失败 → 提示错误；升级失败自动回滚；移除失败保留原目录；
- 权限不足 → 报错 + 提示 `open` 手动处理，不静默失败；
- symlink 循环/异常路径 → realpath 检测循环，跳过异常项不阻塞整体扫描；
- 同 skill 多处版本不同 → 以全局（shared）为准标记，平台徽标注明各路径，升级按目录逐处处理；
- 壳与 agent 同时操作 → 写前检查目录 mtime，冲突提示「已被外部修改，请刷新」；
- 路径穿越/非法路径（Q-038）→ 所有 skill 目录名经 `basename(realpath(path))` 校验，拒绝 `../`、空名、非法字符；校验失败拒绝操作并报错，不静默；
- 回收站恢复冲突（Q-035）→ 恢复时目标路径被占用 → 提示冲突（先移走冲突项或手动处理），不覆盖。

## 6. 角色与权限矩阵

| 操作 | 用户 | 壳（系统） | 说明 |
|:-----|:-----|:-----------|:-----|
| 扫描/查看（列表/描述/平台归属） | ✅ | 后台扫描+缓存 | 只读，不触 DSH_HOME（CON-R002） |
| 搜索/筛选 | ✅ | — | 名称/描述/来源关键词 + 平台 + 快捷开关 |
| 来源跳转（openExternal） | ✅ | preload 桥 + https 白名单校验 | 拒绝 file:/javascript: 等 |
| 升级（一键） | ✅ | 原子替换+失败回滚 | 二次确认（含哈希对照+来源） |
| 移除 | ✅ | 删除目录 | 二次确认（路径+影响平台）；全局 skill 额外警示 |
| 禁用/启用 | ✅ | 按物理路径粒度移目录（disabled 目录 ↔ 原路径；symlink 来源移除 symlink） | T-4/Q-031/Q-032 定案：真禁用（agent 平台生效），不破坏 SKILL.md 内容；操作日志留痕 |
| 注册表维护（agent→目录映射） | — | ✅ 硬编码单点 | §5.1 集中维护，升级/迁移成本低 |

## 7. 字段业务定义

### 7.1 Skill 列表条目（聚合后）

| 字段 | 语义 | 必填 | 来源 | 枚举/默认 |
|:-----|:-----|:-----|:-----|:----------|
| name | skill 名（按 name 聚合去重） | 是 | 目录名/SKILL.md | — |
| scope | 全局/平台 scoped | 是 | 目录位置+realpath | global / scoped |
| platforms | 全部生效平台 | 是 | 目录位置解析 | claude-code/opencode/codex/gemini-cli/cursor/shared |
| description | frontmatter description（列表截断 2 行，详情可展开） | 是（展示层可占位） | SKILL.md frontmatter | 缺失→「无描述」占位 |
| source | 解析后来源 URL | 否 | 一级解析（metadata.source） | 无→「来源未知」 |
| paths | 物理路径数组（跨目录逐条） | 是 | 扫描 | — |
| localHash / remoteHash | 本地/远端内容哈希 | 升级时展示 | 哈希计算/远端 | — |
| upgradable | 可升级标记 | 否 | 本地 vs 远端哈希 | latest/upgradable/unknown |
| enabled | 启用状态（Q-031：按物理路径粒度，paths 逐条独立） | 是 | 目录实际位置（disabled 目录 vs agent 读取目录） | true/false |

### 7.2 SKILL.md frontmatter

| 字段 | 语义 | 必填 | 说明 |
|:-----|:-----|:-----|:-----|
| name | skill 名 | 是 | — |
| description | 功能描述 | 是 | 列表展示 |
| license | 许可证 | 否 | — |
| compatibility | 兼容性声明 | 否 | — |
| metadata | string map | 否 | `metadata.source: <github-url>` 为社区约定（opencode 原生），无标准 version 字段 → 升级检测走内容哈希 |

### 7.3 壳 userData 状态（`<userData>/skills/`）

| 项 | 语义 | 说明 |
|:---|:-----|:-----|
| disabled 目录 | 已禁用 skill 实际存储（T-4 定案移目录方案；Q-032 细化操作对象） | `<userData>/skills/disabled/<skill-name>/`；实目录来源 rename 到此，symlink 来源仅移除 symlink（源保留在原始仓库/SSOT）；**映射记录**：userData 记录被禁用路径+原路径映射，启用时据此恢复 |
| 回收站 | 移除前备份（T-6 定案；Q-035 细化策略） | 移除前将目录移入 `<userData>/skills/trash/`，可恢复；条目记录原路径+删除时间；**TTL 30 天自动清理 + 容量上限 500MB（超出最旧先删）**；恢复时目标路径被占用 → 提示冲突；操作日志留痕 |
| 哈希缓存 | 内容哈希缓存 | 目录 mtime 变化才重算（FR-10） |
| 操作日志 | 破坏性操作留痕 | 移除/升级/禁用写壳事件日志 |

## 8. 业务规则清单

| 编号 | 规则描述 | 来源 | 当前结论 | 变更状态 |
|:-----|:---------|:-----|:---------|:---------|
| CON-R-skills-001 | Agent→目录注册表硬编码：claude-code=`~/.claude/skills/`、opencode=`~/.config/opencode/skills/`（**同时读取** `~/.claude/skills/` 与 `~/.agents/skills/`）、codex=`~/.codex/skills/`、gemini-cli=`~/.gemini/skills/`、cursor=`~/.cursor/skills/`、shared=`~/.agents/skills/`；单点集中维护（§5.1），目录约定变化只改此处 | PRD §5.1/§7 | 生效 | 稳定 |
| CON-R-skills-002 | 全局 vs 平台 scoped 判定 = 目录位置 + symlink realpath 解析：`~/.agents/skills/`=universal（所有平台）；`~/.claude/skills/`=claude-code+opencode（opencode 会读）；`~/.config/opencode/skills/`=opencode 专属；列表按 skill 名聚合、平台徽标显示全部生效平台；realpath 同源避免重复计入 | PRD §5.1/FR-2 | 生效 | 稳定 |
| CON-R-skills-003 | 破坏性操作（移除/升级/禁用）必须二次确认，展示物理路径 + 受影响平台清单；全局 skill 移除额外警示（影响所有平台）；移除前备份到 userData 回收站（`<userData>/skills/trash/`，可恢复）；回收站策略（Q-035 定案）：条目记录原路径+删除时间，TTL 30 天自动清理 + 容量上限 500MB（超出最旧先删），恢复时目标路径被占用 → 提示冲突；操作日志留痕 | PRD §3.1/FR-5/§8/T-6/Q-035 | 生效 | 稳定 |
| CON-R-skills-004 | 升级检测 = 内容哈希（SHA-256 覆盖 skill 文件夹全部文件，path+content 排序，顺序无关）对比远端哈希，非版本号对比（生态无统一 version 字段）；远端哈希来源（Q-034 v1.3 变更：skills-lock.json 移除——历史静态快照无持续生成者，升级检测只依赖标准位置）：① 各平台 lock（`.arkcli-managed-skills.json` 等，name→sha256）→ ② frontmatter metadata.source 推断 → ③ cc-switch content_hash（表空待办）→ ④ git remote 临时 clone（网络成本待办）；均无 → unknown「无法检测」；升级执行（T-3/Q-033 定案）：优先 `npx skills update`（不依赖 source URL，npx 官方通道）；无 source+无远端哈希 → 升级入口禁用显示「无法检测版本」；有 metadata.source 非 git → 用 source URL 重新获取（staging→原子替换）；git clone 来源不原位 git pull（非原子），改 clone 到 staging → 原子替换 → 失败回滚 | PRD §3.4/§5.3/§6/D-3/T-1/T-3/Q-033/Q-034 | 生效 | 稳定 |
| CON-R-skills-005 | 来源解析一级（Q-034 v1.3 变更：lock 二级降级移除——来源只认 frontmatter `metadata.source`）：① SKILL.md frontmatter `metadata.source` 匹配 `^https://` → 采用；无 → 显示「来源未知」，跳转/升级 git 轨禁用（npx 轨升级仍可用，不依赖 source） | PRD §3.5/§5.4/D-4 | 生效 | 稳定 |
| CON-R-skills-006 | 数据归属壳 userData（`<userData>/skills/`：disabled 目录/回收站/哈希缓存/操作日志），不写 agent 目录之外系统区域，不触 DSH_HOME（CON-R002 相容） | PRD §3.3/§7/D-2 | 生效 | 稳定 |
| CON-R-skills-007 | 安全校验（Q-038 定案）：openExternal 仅接受 `^https://` 白名单 URL（拒 file:/javascript:/data: 等）；所有 skill 目录名经 `basename(realpath(path))` 校验，拒绝 `../`、空名、非法字符（防路径穿越）；renderer 仅经 preload 桥访问壳能力 | PRD §7 安全/Q-038 | 生效 | 稳定 |
| CON-R-skills-008 | 禁用/启用 = 移目录真禁用（T-4 定案；Q-031/Q-032 细化）：**按物理路径粒度**——每个物理路径独立禁用/启用，共享目录（`~/.agents/skills/`）skill 整体移出=全平台禁，平台专属副本单独禁；物理操作对象：symlink 来源 → 移除 symlink（改指针，源保留在原始仓库/SSOT），实目录来源 → rename 到 `<userData>/skills/disabled/<skill-name>/`；userData 记录被禁用路径+原路径映射，启用 = 恢复 symlink / rename 回原路径；agent 平台真生效（非壳内白名单）；不破坏 SKILL.md 内容 | PRD FR-9/T-4/Q-031/Q-032 | 生效 | 稳定 |
| CON-R-skills-009 | 扫描异步 + 哈希缓存：扫描为后台任务不阻塞交互；内容哈希缓存（目录 mtime 变化才重算）；首屏 <2s（200+ skill）；哈希后台线程/分批执行 | PRD FR-10/§7 | 生效 | 稳定 |
| CON-R-skills-010 | 搜索分本地/远程两场景且分开（T-2 定案；Q-036 细化 UI）：UI 两个 tab（「本地」/「远程」），**默认本地**；本地 tab 过滤已扫描列表（名称/描述/来源）；远程 tab 调 `npx skills find <q>` 展示 marketplace 结果（名称/描述/来源/安装数），远程结果仅浏览——无 enable/disable/升级操作，仅来源跳转，标注「未安装」 | PRD FR-7/T-2/Q-036 | 生效 | 稳定 |

## 9. 枚举值与常量

- **平台**：claude-code / opencode / codex / gemini-cli / cursor / shared（全局）。
- **scope**：global（全局）/ scoped（平台限定）。
- **升级状态**：latest（最新）/ upgradable（可升级）/ unknown（无法检测版本，升级禁用）。
- **来源状态**：resolved / unknown（「来源未知」）。
- **skill 启用状态**：enabled / disabled。
- **扫描目录清单**：`~/.claude/skills/`、`~/.config/opencode/skills/`、`~/.agents/skills/`、`~/.codex/skills/`、`~/.gemini/skills/`、`~/.cursor/skills/`（+ 参考 `~/.cc-switch/` 只读，数据自管不依赖其运行）。
- **常量**：描述列表截断 2 行（详情可展开/悬浮）；内容哈希 SHA-256；首屏性能 <2s（200+ skill）；升级原子替换（staging → 替换 → 失败回滚）；回收站 TTL 30 天 + 容量上限 500MB（Q-035）。

## 10. 第三方对接

| 外部系统 | 用途 | 关键点 |
|:---------|:-----|:-------|
| agent 平台 skill 目录（claude-code/opencode/codex/gemini-cli/cursor） | 统一扫描数据源 | 目录约定硬编码注册表（§5.1）；opencode 多目录读取（`~/.claude` + `~/.agents` + 自身）单独处理；目录不存在→跳过标「未安装」 |
| 远端哈希来源（T-1/Q-034 定案，v1.3 变更） | 升级检测对比 | 来源优先级：① 各平台 lock（`.arkcli-managed-skills.json` 等，name→sha256，标准位置）→ ② frontmatter metadata.source 推断 → ③ cc-switch content_hash（表空待办）→ ④ git remote 临时 clone（网络成本待办）；skills-lock.json 已移除（历史静态快照无持续生成者，不再读取）；均无 → unknown「无法检测」、升级禁用 |
| cc-switch（只读） | 远端哈希来源 ③（Q-034）：content_hash；另参考 per-agent 生效布尔思路 | `~/.cc-switch/cc-switch.db` skills 表含 enabled_claude/enabled_codex/enabled_gemini/enabled_opencode/enabled_hermes、content_hash、readme_url；数据自管（壳 userData），不依赖 cc-switch 运行 |
| shell.openExternal | 来源跳转浏览器 | 仅 https URL 白名单校验（CON-R-skills-007） |
| 远程 marketplace 搜索（`npx skills find <q>` / skills.sh API） | 远程 skills 检索（T-2 定案） | 本地/远程搜索分开两个入口（UI tab 区分），互不混合；远程仅浏览搜索结果，不落地安装 |

## 11. 未决项登记

> PRD §10.1 D-1~D-4 已定案（独立视图/壳 userData 归属/内容哈希/三级来源解析），不重复登记；此处登记 PRD §10.2 T-1~T-6（评审定案后回写本共识并发布）+ BE/FE/QA 扫描待确认项 Q-031~Q-038（§11.2，v1.2 全部定案回写）。

### 11.1 PRD 未决项（T-1~T-6）

| 编号 | 问题 | 负责人 | 阻断等级 | 状态 | 结论 | 回写位置 |
|:-----|:-----|:-------|:---------|:-----|:-----|:---------|
| T-1 | 远端哈希从哪拿？git remote / skills.sh API / cc-switch db？ | PM | P0 | 已关闭 | **各平台 lock（`.arkcli-managed-skills.json` 等）优先，次选 frontmatter metadata.source 推断，均无则「无法检测」**（v1.3 变更：skills-lock.json 移除） | §10/CON-R-skills-004 |
| T-2 | 是否支持 marketplace 搜索（`npx skills find`）还是仅本地？ | PM | P1 | 已关闭 | **接入远程搜索（本地/远程分开两个入口）；远程仅浏览不安装**（v1.2 经 Q-036 细化 UI：两 tab 默认本地、远程结果字段与「未安装」标注） | §2/§10/§12/CON-R-skills-010 |
| T-3 | 升级执行方式：`npx skills update` / git pull / 重 clone？ | PM | P0 | 已关闭 | **优先 `npx skills update`；symlink 来源次选 git pull；不重 clone；原子替换+失败回滚兜底（FR-6）**（v1.2 经 Q-033 细化：git clone 来源不原位 pull，改 clone 到 staging 原子替换） | §3/§5.1/§13/CON-R-skills-004 |
| T-4 | 禁用语义：移目录 vs 壳内白名单？ | PM | P1 | 已关闭 | **移目录真禁用：禁用移出 agent 读取目录到 `<userData>/skills/disabled/<skill-name>/`，启用移回；agent 平台真生效（否决壳内白名单）**（v1.2 经 Q-031/Q-032 细化：按路径粒度 + symlink/实目录操作对象区分） | §3/§6/§7.3/CON-R-skills-008 |
| T-5 | 跨 agent 依赖：opencode 读取多个目录的生效集合如何展示？ | PM | P1 | 已关闭 | **按 name 聚合 + realpath 同源去重 + 平台徽标合并显示全部生效平台 + 全局路径优先展示（§5.3）；实现已覆盖（SkillsScanner 七步管线 + 前端平台筛选/徽标）** | §3/CON-R-skills-002 |
| T-6 | 移除前是否备份到 userData 回收站？ | PM | P2 | 已关闭 | **备份：移除前移入 `<userData>/skills/trash/`，可恢复**（v1.2 经 Q-035 细化清理策略：TTL 30 天 + 500MB 上限） | §7.3/CON-R-skills-003 |

### 11.2 扫描待确认项（BE/FE/QA 扫描，v1.2 定案回写）

> BE/FE/QA 三方扫描产出 8 项待确认（Q-031~Q-038，v1.2 定案回写）+ Q-056（8-23 扫描补充，v1.4 定案回写），PM solo 决策全部定案；结论已织入业务事实章节（见回写位置列）。

| 编号 | 问题 | 负责人 | 阻断等级 | 状态 | 结论 | 回写位置 |
|:-----|:-----|:-------|:---------|:-----|:-----|:---------|
| Q-031 | 移目录真禁用与共享目录冲突：共享目录 skill 移出后全平台失效，如何按平台禁用？ | PM | BLOCKER | 已关闭 | **按路径粒度：每个物理路径独立禁用/启用；共享目录（`~/.agents/skills/`）skill 整体移出=全平台禁，平台专属副本（`~/.claude/skills/` 等）单独禁只影响该平台** | §5.2/§7.1/CON-R-skills-008 |
| Q-032 | 禁用的物理操作对象是什么（symlink vs 实目录）？ | PM | P0 | 已关闭 | **逐物理路径操作：symlink 来源 → 移除 symlink（改指针，源保留在原始仓库/SSOT）；实目录来源 → rename 到 `<userData>/skills/disabled/<skill-name>/`；壳 userData 记录被禁用路径+原路径映射；启用 = 恢复 symlink / rename 回原路径** | §3/§7.3/§13/CON-R-skills-008 |
| Q-033 | 非 git/非 lock 来源 skill 如何升级？git clone 来源能否原位 git pull？ | PM | P0 | 已关闭 | **无 source + 无 lock 条目 → 无法确定远端 → 升级入口禁用显示「无法检测版本」；有 metadata.source 但非 git → 用 source URL 重新获取（staging → 原子替换）；git clone 来源升级不 git pull 原位（非原子），改 clone 到 staging → 原子替换 → 失败回滚** | §13/CON-R-skills-004 |
| Q-034 | 远端哈希来源优先级如何排？多来源冲突以谁为准？ | PM | P1 | 已关闭 | **① 各平台 lock（`.arkcli-managed-skills.json` 等）→ ② frontmatter metadata.source 推断 → ③ cc-switch content_hash → ④ git remote 临时 clone 计算；skills-lock.json 已移除（v1.3 变更）；无任何来源 → unknown** | §10/CON-R-skills-004 |
| Q-035 | 回收站如何清理？恢复时目标路径被占用怎么办？ | PM | P2 | 已关闭 | **TTL 30 天自动清理 + 容量上限 500MB（超出最旧先删）；恢复时目标路径被占用 → 提示冲突（先移走冲突项或手动处理）；回收站条目记录原路径+删除时间** | §5.3/§7.3/§9/§13/CON-R-skills-003 |
| Q-036 | 本地/远程搜索 UI 形态？远程结果可执行哪些操作？ | PM | P1 | 已关闭 | **两个 tab（「本地」/「远程」），默认本地；本地 tab 过滤已扫描列表；远程 tab 调 `npx skills find <q>` 展示 marketplace 结果（名称/描述/来源/安装数），远程结果仅浏览（无 enable/disable/升级，仅来源跳转），标注「未安装」** | §12/CON-R-skills-010 |
| Q-037 | 破坏性操作（移除/禁用/升级）如何做 e2e 测试而不碰真实 agent 目录？ | PM | P1 | 已关闭 | **fs 操作抽象层（SkillFsOps 接口）+ 测试注入临时目录（DI/env）；e2e 用临时目录模拟 agent 目录验证移除/禁用/升级；真实目录操作留冒烟；复用 M2 两级 mock 桩模式** | §13 |
| Q-038 | 路径穿越与外链安全如何校验？ | PM | P0 | 已关闭 | **所有 skill 目录名经 `basename(realpath(path))` 校验，拒绝 `../`、空名、非法字符；openExternal 仅接受 `^https://` 白名单（拒 file:/javascript:/data:）** | §5.3/§8 异常/CON-R-skills-007 |
| Q-056 | 升级检测与来源解耦展示 + skills-lock 硬编码路径可移植性 | PM | P2 | 已关闭 | **① UI 解耦：可升级依据 = 哈希对比（平台 lock），与来源链接独立；无 source 升级按钮 tooltip「经 npx skills update 官方通道升级（无需来源链接）」，详情加「升级通道」说明（commit 88ab12a）；② 可移植性：skills-lock.json 读取移除（个人快照无持续生成者），远端哈希只依赖标准位置 .arkcli 平台 lock + metadata.source 推断，不做可配置（Q-034 v1.3 变更，commit f42c787）** | §3/§10/CON-R-skills-004/010 |

## 12. 页面交互规范

| 页面/组件 | 角色 | 功能 | 权限 | 数据范围 |
|:----------|:-----|:-----|:-----|:---------|
| 导航「Skills」入口 | 用户 | 左侧 Hull 导航新增「Skills」，点击切换右侧内容区为 Skills Checker 视图（复用 S8 占位区块切换，主进程驱动）；与官方 WebContentsView 互斥显示 | 全量 | 视图切换 |
| 搜索工具条 | 用户 | 两个独立 tab（Q-036 定案）：① 「本地」tab（**默认选中**）——搜索框过滤已扫描列表（名称/描述/来源关键词，大小写不敏感支持中文）；② 「远程」tab——调 `npx skills find <q>` 展示 marketplace 结果（名称/描述/来源/安装数），结果仅浏览：无 enable/disable/升级操作，仅来源跳转，每条标注「未安装」；本地/远程结果永不混合在同一列表；切换 tab 清空对方结果 | 全量 | 本地：skill 列表；远程：marketplace 结果 |
| Skills 检查器主视图 | 用户 | 工具条（本地/远程搜索 tab + 平台筛选下拉/「仅看可升级」「仅看已禁用」开关/重新扫描）+ 状态栏（共 N 个 skill/可升级/已禁用/全局）+ skill 列表（名称/描述截断/平台徽标/全局-scoped 标识/来源链接/升级徽标/启用状态/操作按钮） | 全量 | skill 列表 |
| skill 列表项 | 用户 | 名称 + 描述（截断 2 行，可展开/悬浮查看全文）+ 平台徽标（全部生效平台）+ 来源链接（点击跳转，置灰=来源未知）+ 升级徽标（▲ 可升级）+ 启用/禁用开关 + 移除/升级按钮 | 全量 | 单 skill |
| 移除确认弹窗 | 用户 | 显示将删除的物理路径 + 受影响平台清单 + 「不可恢复」警示；全局 skill 额外警示「移除后影响所有 agent 平台」；确认→删除目录→刷新列表→顶部计数更新；取消不产生变更 | 确认后执行 | 单 skill |
| 升级确认弹窗 | 用户 | 显示来源 URL + 本地/远端哈希对照；警示「原子替换，失败自动回滚」；确认→执行升级→进度展示→成功/失败回显 | 确认后执行 | 单 skill |
| 空态 | 用户 | 搜索/筛选无匹配 → 「未找到匹配的 skill，试试调整搜索词或筛选条件」；清除筛选恢复全量 | 只读 | — |

## 13. 后端任务规范

- **扫描（FR-2/FR-10）**：进入视图触发后台异步扫描；遍历 §5.1 注册表目录 → 聚合（按 name 去重，跨目录同 skill 合并平台徽标）；symlink realpath 解析去重（同源不重复计数）；UI 先骨架/部分结果不阻塞。
- **哈希计算与缓存（CON-R-skills-009）**：SHA-256（path+content 排序）；结果缓存，目录 mtime 变化才重算；后台线程/分批执行，不卡 UI；>200 skill 首屏 <2s。
- **升级执行（FR-6，T-3/Q-033 定案）**：优先 `npx skills update`；无 source + 无 lock 条目 → 无法确定远端 → 升级入口禁用显示「无法检测版本」；有 metadata.source 但非 git → 用 source URL 重新获取（staging → 原子替换）；git clone 来源**不原位 git pull**（非原子），改 clone 到 staging → 原子替换 → 失败自动回滚；进度展示；失败不破坏现有 skill；远端不可获取 → 不显示升级徽标、「无法检测版本」。
- **移除执行（FR-5，Q-035 细化）**：确认后先将 skill 目录移入 userData 回收站（`<userData>/skills/trash/`，T-6 定案，可恢复）；回收站条目记录原路径+删除时间；TTL 30 天自动清理 + 容量上限 500MB（超出最旧先删）；恢复时目标路径被占用 → 提示冲突（先移走冲突项或手动处理）；跨平台同名逐目录处理；全局 skill 移除提示影响所有平台；移除完成刷新列表+计数；操作日志写壳事件日志。
- **禁用/启用（FR-9，T-4/Q-031/Q-032 定案）**：按物理路径粒度——每个物理路径独立禁用/启用，共享目录（`~/.agents/skills/`）skill 整体移出=全平台禁，平台专属副本单独禁只影响该平台；物理操作对象逐路径区分：symlink 来源 → 移除 symlink（改指针，源保留在原始仓库/SSOT），实目录来源 → rename 到 disabled 目录（`<userData>/skills/disabled/<skill-name>/`）；userData 记录被禁用路径+原路径映射，启用 = 恢复 symlink / rename 回原路径；agent 平台真生效；不破坏 SKILL.md 内容；状态即时反映列表与计数；移动失败不破坏原目录。
- **远程搜索（FR-7，T-2 定案）**：远程 marketplace 检索（`npx skills find <q>` / skills.sh API）；本地/远程分开展示；仅浏览不安装；失败提示「远程不可用」，不影响本地列表。
- **并发冲突（§8 异常）**：写操作前检查目录 mtime，壳与 agent 同时操作 → 冲突提示「已被外部修改，请刷新」。
- **来源解析（CON-R-skills-005）**：frontmatter metadata.source 一级解析；无 → 「来源未知」，git 轨升级禁用（npx 轨不依赖 source 仍可用）。
- **路径安全校验（Q-038）**：所有 skill 目录名经 `basename(realpath(path))` 校验，拒绝 `../`、空名、非法字符（防路径穿越）；openExternal 仅接受 `^https://` 白名单（拒 file:/javascript:/data:）。
- **fs 抽象与可测性（Q-037）**：破坏性 fs 操作收敛到抽象层（SkillFsOps 接口），测试经 DI/env 注入临时目录；e2e 用临时目录模拟 agent 目录验证移除/禁用/升级，真实目录操作留冒烟；复用 M2 两级 mock 桩模式。

## 14. 端差异汇总

- 本模块不涉及多端差异（单端桌面应用）。
- 平台范围延续 M1：仅打包 macOS Apple Silicon；代码跨平台友好（process.platform 分支、path 处理从第一天写好）。

### 14.1 子需求清单

> 判级：复杂 + 安全敏感（新增 fs-management 子系统 + 变更用户 agent 配置目录）——S1/S2 实现前均需技术方案文档（docs/design/，方案冻结后进实现管道）。交付顺序：S1 → S2（S2 依赖 S1 扫描结果）。飞书 ticket：S1 `a639af53-ff91-478b-8cb6-e13102427069`、S2 `701e3597-3cb9-416c-80b0-cc826eb173da`。

| # | 子需求 | 验收标准（可测试） | 规则绑定 | 依赖 | 来源 PRD | 飞书 ticket |
|:--|:-------|:-------------------|:---------|:-----|:---------|:------------|
| S1 | Skills 扫描/列表/搜索 | 独立视图 nav 接入（FR-1）；扫描 6 目录聚合正确+全局判定+realpath 去重（FR-2）；描述解析+缺失占位（FR-3）；来源解析（metadata.source）+点击跳转+置灰（FR-4）；本地/远程搜索双 tab 分离+远程仅浏览（FR-7/Q-036）；平台筛选组合（FR-8）；首屏 <2s+异步+哈希缓存（FR-10）；路径穿越校验（Q-038）；fs 抽象层 SkillFsOps+测试注入（Q-037） | CON-R-skills-001/002/005/006/007/009/010 | — | 2026-08-22-skills-checker-prd.md | a639af53-ff91-478b-8cb6-e13102427069 |
| S2 | Skills 操作（移除/升级/禁用/启用 + 回收站） | 移除二次确认+路径/影响平台展示+回收站备份（FR-5/Q-035）；升级内容哈希对比+一键升级（npx skills update/git clone staging 原子替换回滚）+无来源禁用（FR-6/Q-033/Q-034）；禁用/启用按路径粒度移目录真禁用（FR-9/Q-031/Q-032）；操作日志留痕 | CON-R-skills-003/004/008 | S1 | 2026-08-22-skills-checker-prd.md | 701e3597-3cb9-416c-80b0-cc826eb173da |

## 15. 附录与版本记录

### 15.1 文档关联

- **关联**：PRD（docs/prd/2026-08-22-skills-checker-prd.md）、原型（docs/prototype/2026-08-22-skills-checker-prototype.html）、规则索引（docs/spec/规则索引.md）、M2 共识（docs/spec/共识-Hull桌面壳-M2看板.md）、M1 共识（docs/spec/共识-Hull桌面壳-M1.md）。

### 15.2 版本记录

| 版本 | 日期 | 变更摘要条目 | 说明 |
|:-----|:-----|:-------------|:-----|
| v1.4 | 2026-08-24 | 已登记（已发布） | T-5 跨 agent 重叠展示定案关闭（实现已覆盖 §5.1 褶皱处理）：按 name 聚合 + realpath 同源去重 + 平台徽标合并 + 全局优先展示；无新规则变化，向后兼容 |
| v1.3 | 2026-08-24 | 已登记（已发布） | Q-034 变更（CON-R-skills-004/005）：skills-lock.json 移除，升级检测只依赖标准位置；T-1 结论同步（各平台 lock → metadata.source 推断，均无则 unknown） |
| v1.2 | 2026-08-22 | 已登记（已发布） | BE/FE/QA 扫描待确认项 Q-031~Q-038 全部定案回写（确认/细化，向后兼容）：禁用按路径粒度（Q-031）、symlink/实目录操作对象区分+映射记录（Q-032）、非 git 来源升级路径+git 不原位 pull（Q-033）、远端哈希四级优先级（Q-034）、回收站 TTL 30 天+500MB（Q-035）、搜索两 tab 默认本地+远程「未安装」（Q-036）、SkillFsOps 抽象+临时目录 e2e（Q-037）、路径穿越校验+openExternal ^https://（Q-038）；CON-R-skills-003/004/007/008/010 描述细化；T-1/T-2/T-3/T-4/T-6 结论标注 v1.2 细化来源 |
| v1.1 | 2026-08-22 | 待登记（已发布） | 用户评审定案 T-1~T-4、T-6（T-5 保持 open）：禁用=移目录真禁用（T-4）、远程搜索接入本地/远程分开（T-2）、升级 npx skills update 优先/git pull 次选（T-3）、远端哈希 skills-lock 优先/git remote 次选（T-1）、移除前备份回收站（T-6）；CON-R-skills-008 定案生效、新增 CON-R-skills-010；对应 PRD 升级至 v0.2 |
| v1.0 | 2026-08-22 | 待登记（草稿，未发布） | 首次建立：从 Skills Checker PRD v0.1（待评审）+ 原型提取；登记 CON-R-skills-001~009、T-1~T-6 |

### 15.3 后续规划

> 记录本轮明确排除/未决项，供评审与后续承接。

| 项 | 状态 | 说明 |
|:---|:-----|:-----|
| 远程安装/卸载新 skill | 本轮不做 | 远程仅浏览搜索，不落地安装（T-2 定案）；后续可承接安装流程 |
| skill 创建/编辑 | 本轮不做 | 只读查看，不改 SKILL.md 内容 |
| CC（Claude Code）配置修改 | 本轮不做 | 不改 `~/.claude/settings.json` 等配置 |
| 多设备同步/远程管理 | 本轮不做 | — |
| 跨平台打包 | 延续 M1 | 仅 macOS Apple Silicon，代码跨平台友好 |
| 跨 agent 重叠展示（T-5） | 已关闭（v1.4） | §5.1 褶皱处理定案：聚合 + realpath 去重 + 平台徽标合并，实现已覆盖 |
