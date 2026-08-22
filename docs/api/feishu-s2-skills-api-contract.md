# S2 Skills 操作契约（移除/升级/禁用启用 + 回收站）

## 契约信息

- 工作项：S2 Skills 操作——移除/升级/禁用启用 + 回收站（飞书 dsh-hull-desktop 清单，701e3597-3cb9-416c-80b0-cc826eb173da）
- 契约状态：冻结（2026-08-23，复核修订 v0.2）
- 版本：v0.2
- 适用版本：Skills Checker（共识 v1.2 + PRD v0.2）
- 最后更新：2026-08-23
- 说明：桌面壳本地 fs 管理契约（无 HTTP API 面）；核心 = 7 条新增 IPC 通道 + 破坏性操作安全行为约束（二次确认/回收站备份/staging 原子替换回滚/按路径粒度禁用）+ userData 状态文件 schema；依赖 S1 扫描结果与 SkillFsOps 抽象层（Q-037）。判级：复杂 + 安全敏感（变更用户 agent 配置目录）。

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| 移除（二次确认+回收站备份） | S2 验收① | CON-R-skills-003 + Q-035/T-6 | 确认弹窗展示路径+影响平台+全局警示；确认后备份 `<userData>/skills/trash/` 再删除；日志留痕 | skills:remove / getTrashList / restoreFromTrash | 已定义 |
| 回收站策略 | S2 验收① | CON-R-skills-003 + Q-035 | TTL 30 天自动清理 + 容量上限 500MB（最旧先删）；条目记录原路径+删除时间；恢复冲突提示不覆盖 | getTrashList / restoreFromTrash | 已定义 |
| 升级检测（哈希对比） | S2 验收② | CON-R-skills-004 + Q-034 | 内容哈希对比；远端哈希四级优先级（skills-lock→平台 lock→cc-switch→git remote clone）；均无 unknown「无法检测」 | 检测态由 S1 提供；执行走 skills:upgrade | 已定义 |
| 升级执行分级 | S2 验收② | CON-R-skills-004 + Q-033/T-3 | npx skills update 优先；metadata.source 非 git 用 source URL 重取（staging→原子替换）；git clone 来源 clone 到 staging→原子替换（不原位 pull）；失败自动回滚 | skills:upgrade | 已定义 |
| 无来源禁用升级 | S2 验收② | CON-R-skills-004 + Q-033 | 无 source+无 lock → 升级入口禁用「无法检测版本」；主进程侧二次校验拒绝（不信任 UI 禁用） | skills:upgrade（拒绝码 skills-upgrade-undetectable） | 已定义 |
| 禁用/启用按路径粒度 | S2 验收③ | CON-R-skills-008 + Q-031/Q-032/T-4 | 每物理路径独立操作；symlink 来源移指针（源保留 SSOT）；实目录 rename 到 disabled 目录；映射记录原路径；agent 平台真生效（非壳内白名单） | skills:setEnabled / getDisabledList | 已定义 |
| 操作日志 | S2 验收④ | CON-R-skills-003/008 | 移除/升级/禁用/启用/恢复全部留痕，可查询 | skills:getOperationLog | 已定义 |
| 路径安全校验 | S2 全部写通道 | CON-R-skills-007 + Q-038 | basename(realpath) 校验拒绝 `../`、空名、非法字符；仅接受注册表目录内路径 | 全部写通道前置校验 | 已定义 |
| 并发冲突 | S2 全部写通道 | 共识 §5.3/§13 | 写前检查目录 mtime，冲突提示「已被外部修改，请刷新」 | 写通道拒绝码 skills-conflict | 已定义 |

## 范围与非目标

### 范围

- 7 条新增 IPC 通道（`skills:*` 域）：remove / upgrade / setEnabled / getDisabledList / getTrashList / restoreFromTrash / getOperationLog
- 移除行为链：二次确认（UI 层）→ 路径校验 → mtime 冲突检查 → 回收站备份 → 删除 → 日志
- 升级行为链：upgradable 前置校验 → 执行方式分级（npx skills update / source URL 重取 / git clone staging）→ 原子替换 → 失败回滚 → 日志
- 禁用/启行为链：按物理路径粒度 → symlink 移指针 / 实目录 rename 到 disabled → 映射记录 → 启用恢复 → 日志
- 回收站管理：TTL 30 天 + 500MB 上限（最旧先删）、条目查询、恢复冲突处理
- userData 状态文件 schema（disabled.json / trash.json / log/operations.jsonl）

### 非目标

- 扫描/列表聚合/搜索/来源跳转/哈希计算与缓存（S1，本契约消费其结果）
- 远程安装/卸载新 skill（T-2 定案不做）
- skill 创建/编辑（只读查看）
- CC 配置修改（不改 `~/.claude/settings.json` 等）
- 多设备同步/远程管理
- DSH_HOME 任何读写（CON-R002 红线）

## 业务流程与状态

### 核心流程

```text
S1 扫描列表（paths/localHash/remoteHash/upgradable/enabled/source）→ 用户选中操作
移除：确认弹窗（路径+影响平台+全局警示）→ skills:remove → 校验+mtime 检查 → move 入回收站 → 索引记录 → 日志 → 刷新列表
升级：确认弹窗（来源+哈希对照）→ skills:upgrade → 校验+mtime 检查 → 分级获取新版到 staging → 原子替换 → 失败回滚 → 日志 → 刷新
禁用：开关 → skills:setEnabled{enabled:false} → symlink unlink / 实目录 rename 入 disabled → 映射记录 → 日志
启用：开关 → skills:setEnabled{enabled:true} → 查映射 → rename 回原位 / 重建 symlink → 日志
恢复：回收站面板 → skills:restoreFromTrash → 目标占用检查 → move 回原路径 → 日志
```

### 状态转换（skill 物理路径视角）

| 当前状态 | 动作 | 目标状态 | 前置条件 | 冲突行为 | 依据 |
|---|---|---|---|---|---|
| enabled（在 agent 目录） | setEnabled false | disabled | 路径存在且在注册表白名单内 | mtime 冲突拒做 | Q-031/Q-032 |
| disabled | setEnabled true | enabled | 映射记录存在且原路径空闲 | 原路径被占用 → restore-conflict | Q-032 |
| enabled | remove | trashed | 二次确认已过（UI 层） | mtime 冲突拒做 | Q-035 |
| trashed | restoreFromTrash | enabled | 原路径空闲 | 占用 → restore-conflict 不覆盖 | Q-035 |
| trashed | TTL 30 天 / 500MB 超限 | purged（真删） | 自动清理 | 最旧先删 | Q-035 |
| upgradable | upgrade | latest（或失败回原版） | remoteHash ≠ localHash 且来源可解析 | 失败回滚保留原目录 | Q-033 |

## 接口清单

> S2 为本地 fs 管理契约，无 HTTP paths；"接口" = IPC 通道（主进程 SkillsOps 暴露，preload 桥接 `window.skills`，renderer 消费）。全部为 **NEW** 通道；响应统一包裹 `{ ok:true, data } | { ok:false, code, message }`（对齐 KanbanIpcResult 形态）。通道命名须登记进 src/shared/ipc-channels.ts 白名单（SKILLS_IPC_CHANNELS）。

| # | 状态 | 方法 | 路径（IPC channel） | 用途 | 权限 | 幂等 |
|---|---|---|---|---|---|---|
| 1 | NEW | invoke | `skills:remove` | 移除 skill（回收站备份→删除→日志） | 壳内+二次确认（UI 弹窗后调用） | 否（删除） |
| 2 | NEW | invoke | `skills:upgrade` | 一键升级（staging→原子替换→失败回滚） | 壳内+二次确认（UI 弹窗后调用） | 否 |
| 3 | NEW | invoke | `skills:setEnabled` | 禁用/启用（按物理路径粒度移目录） | 壳内 | 是 |
| 4 | NEW | invoke | `skills:getDisabledList` | 查询已禁用路径+映射记录 | 无（壳内读） | 读 |
| 5 | NEW | invoke | `skills:getTrashList` | 查询回收站条目（原路径+删除时间） | 无（壳内读） | 读 |
| 6 | NEW | invoke | `skills:restoreFromTrash` | 回收站恢复到原路径 | 壳内+冲突提示 | 否 |
| 7 | NEW | invoke | `skills:getOperationLog` | 查询破坏性操作日志 | 无（壳内读） | 读 |

> 无事件通道：升级进度 v1 为不确定态 spinner（invoke 返回终态即 FR-6「进度展示+成功/失败回显」最小满足）；如需细粒度进度另立 event 通道（开放问题 O-1）。

## Schema 与枚举

### userData 状态布局（CON-R-skills-006，不触 DSH_HOME）

```text
<userData>/skills/
├── disabled/<disabledId>/      # 实目录来源禁用存储（symlink 来源无实体，仅索引记录）
├── disabled.json               # 禁用映射索引
├── trash/<trashId>/            # 回收站条目（原目录整体 move 入驻）
├── trash.json                  # 回收站索引
├── staging/                    # 升级临时区（成功清理/失败回滚后清理）
└── log/operations.jsonl        # 操作日志（append-only JSON Lines；v1 不做滚动轮转——仅破坏性操作留痕、量级小；启动时 >10MB 则截断保留最近 1000 行）
```

### disabled.json 顶层

| 字段 | 类型 | 必填 | 可空 | 约束 | 说明 |
|---|---|---|---|---|---|
| version | integer | 是 | 否 | 默认 1 | schema 版本 |
| entries | array[DisabledEntry] | 是 | 否 | 空数组合法 | 禁用映射列表 |

### DisabledEntry

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| id | string | 是 | 否 | `d_<uuid>` | 无 | 禁用条目唯一标识（=disabled 目录名） |
| skillName | string | 是 | 否 | ≤200 字符 | 无 | skill 名（展示用） |
| originalPath | string | 是 | 否 | 注册表目录内绝对路径 | 无 | 原物理路径（启用恢复目标） |
| kind | string | 是 | 否 | dir / symlink | 无 | 来源类型：dir=实目录已 rename 入驻；symlink=仅移指针，源保留 SSOT（无实体目录） |
| symlinkTarget | string | 否 | kind=symlink 必填 | 绝对路径 | 无 | 原 symlink 指向（重建用） |
| affectedPlatforms | array[string] | 是 | 否 | §9 平台枚举子集 | 无 | 该路径受影响平台（快照，展示用） |
| disabledAt | string | 是 | 否 | ISO 8601 UTC | 无 | 禁用时间 |

### trash.json 顶层

| 字段 | 类型 | 必填 | 可空 | 约束 | 说明 |
|---|---|---|---|---|---|
| version | integer | 是 | 否 | 默认 1 | schema 版本 |
| entries | array[TrashEntry] | 是 | 否 | 空数组合法 | 回收站条目列表 |

### TrashEntry

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| id | string | 是 | 否 | `tr_<uuid>`（=trash 目录名） | 无 | 条目唯一标识 |
| skillName | string | 是 | 否 | ≤200 字符 | 无 | skill 名 |
| originalPath | string | 是 | 否 | 注册表目录内绝对路径 | 无 | 原物理路径（恢复目标） |
| deletedAt | string | 是 | 否 | ISO 8601 UTC | 无 | 删除时间（TTL 计算基准） |
| sizeBytes | integer | 是 | 否 | ≥0 | 无 | 条目体积（500MB 上限计算） |
| affectedPlatforms | array[string] | 是 | 否 | §9 平台枚举子集 | 无 | 受影响平台快照 |

### OperationLogEntry（operations.jsonl 单行）

| 字段 | 类型 | 必填 | 可空 | 约束 | 说明 |
|---|---|---|---|---|---|
| ts | string | 是 | 否 | ISO 8601 UTC | 操作时间 |
| action | string | 是 | 否 | remove / upgrade / disable / enable / restore / purge | 操作类型 |
| paths | array[string] | 是 | 否 | ≥1 | 涉及物理路径 |
| result | string | 是 | 否 | success / failed | 结果 |
| detail | object | 否 | 是 | — | 补充信息（method=升级执行方式、rolledBack、error code 等） |

### 枚举与状态

| 类型 | 值 | 含义 | 可用于请求 | 可出现在响应 |
|---|---|---|---|---|
| action | remove/upgrade/disable/enable/restore/purge | 操作日志动作 | 否（系统生成） | 是 |
| result | success/failed | 日志结果 | 否 | 是 |
| upgrade.method | npx-skills-update/source-fetch/git-staging | 升级执行方式（Q-033 分级） | 否（系统选择） | 是 |
| kind | dir/symlink | 禁用条目来源类型 | 否（系统判定） | 是 |
| 平台 | claude-code/opencode/codex/gemini-cli/cursor/shared | 生效平台 | 否（S1 解析） | 是 |

## 行为契约（破坏性操作安全约束）

> 本节为 S2 核心行为约束，实现与测试均以此为准。所有写操作收敛于 SkillFsOps 抽象层（Q-037），测试经 DI/env 注入临时目录。

### 移除（CON-R-skills-003 + Q-035）

执行序列（单 path）：

```text
① 路径校验（Q-038：basename(realpath) 拒绝 ../、空名、非法字符；必须在注册表目录白名单内）
② mtime 冲突检查（vs S1 扫描快照）→ 冲突拒做 skills-conflict
③ 备份：整目录 move 到 <userData>/skills/trash/tr_<uuid>/（原子 rename；跨卷降级 copy+delete）
④ 索引：trash.json 追加 TrashEntry（originalPath + deletedAt + sizeBytes + platforms）
⑤ 触发回收站惰性清理（TTL 30 天过期项删除；总量 >500MB 最旧先删）
⑥ 写操作日志（action=remove, result=success）
失败任一步：原目录不动（move 失败=未删），已入索引则回滚索引行，日志记 failed
```

约束：

- 二次确认归属 renderer UI 弹窗（§12 移除确认弹窗：物理路径+受影响平台清单+「不可恢复」警示；全局 skill 额外警示「移除后影响所有 agent 平台」）；IPC 收到调用即视为已确认，主进程不再重复弹窗，但**路径校验/mtime 检查不可跳过**（不信任 renderer）。
- 批量请求 `paths[]` 逐条独立执行，返回逐条结果；部分失败不回滚已成功条目。
- 恢复冲突（Q-035）：restoreFromTrash 目标 originalPath 已被占用 → restore-conflict，提示「先移走冲突项或手动处理」，**不覆盖**。
- 恢复跨卷降级：trash（userData 卷）与原路径可能跨卷，move 降级 copy+delete——先完整复制并校验，再删源；copy 中途失败清理半成品、trash 条目保留可重试。

### 升级（CON-R-skills-004 + Q-033/Q-034）

前置（主进程强制，不信任 UI 禁用态）：

- 目标路径 upgradable（localHash ≠ remoteHash）；remoteHash=unknown（四级来源均无，Q-034）→ 拒绝 `skills-upgrade-undetectable`（UI 侧对应入口禁用显示「无法检测版本」，Q-033）。
- 远端哈希四级优先级（Q-034）：① skills-lock.json（权威，`~/AI/skills-lock.json`）→ ② 各平台 lock（`.arkcli-managed-skills.json` 等）→ ③ cc-switch content_hash → ④ git remote 临时 clone 计算；按 name 匹配、skills-lock 优先覆盖。

执行序列：

```text
① 路径校验 + mtime 冲突检查（同移除）
② 解析执行方式（Q-033/T-3 分级）：
   a. npx skills update 可用 → method=npx-skills-update
   b. metadata.source 存在且非 git → 用 source URL 重新获取 → method=source-fetch
   c. git clone 来源 → clone 到 staging（不原位 git pull，非原子）→ method=git-staging
③ 新版落 <userData>/skills/staging/<uuid>/ → 完整性校验（SKILL.md 存在 + frontmatter name 一致）
④ 原子替换：原目录 rename → staging-backup；staging rename → 原路径
⑤ 成功：删 staging-backup + 清 staging → 日志（method 记录）
⑥ 失败（③/④ 任一步）：staging-backup rename 回原路径（回滚，保留原版本）→ 清 staging → 日志（result=failed, rolledBack=true）
```

约束：

- 升级失败**必须**回滚到原版本，不破坏现有 skill（FR-6）；回滚本身失败 → skills-io-error + 提示手动处理（`open` 打开目录）。
- 同 skill 多处安装且版本不同 → 按目录逐处升级（每次调用一个 path）。
- npx/git 子进程超时上限 120s，超时视为失败走回滚。

### 禁用/启用（CON-R-skills-008 + Q-031/Q-032）

- **按物理路径粒度**（Q-031）：一次调用只操作一个 path；共享目录（`~/.agents/skills/`）skill 整体移出 = 全平台禁；平台专属副本单独禁只影响该平台。
- 物理操作对象（Q-032）：
  - symlink 来源 → `unlink` symlink（改指针，源保留在原始仓库/SSOT）；DisabledEntry.kind=symlink，记录 symlinkTarget，无实体目录入驻。
  - 实目录来源 → `rename` 到 `<userData>/skills/disabled/d_<uuid>/`；kind=dir。
- 映射记录：disabled.json 记录被禁用路径+原路径映射；启用 = 据映射 rename 回原路径 / 重建 symlink。
- 启用冲突：原路径已被占用（外部重建同名目录）→ restore-conflict，不覆盖。
- **agent 平台真生效**（T-4 定案）：禁用后该路径不在 agent 读取位置，agent 完全不可加载；非壳内白名单过滤。
- 不破坏 SKILL.md 内容；移动失败不破坏原目录。

### 并发与安全（全部写通道）

- 写前 mtime 检查：目标目录 mtime ≠ S1 扫描快照 → `skills-conflict`「已被外部修改，请刷新」（共识 §5.3）。
- 同路径写操作单飞（single-flight）：同一物理路径已有写操作（remove/upgrade/setEnabled/restore）进行中，再触发任一写操作 → `skills-op-in-progress`「操作进行中，请稍后」（壳内互斥，区别于 skills-conflict 的外部修改语义）。
- 路径校验（Q-038）：basename(realpath) 拒绝 `../`、空名、非法字符；path 必须落在注册表目录（含 disabled/trash 白名单域）内，否则 validation-error。防路径穿越为**主进程强制**，renderer 输入不可信。
- 权限不足 → skills-io-error + 提示以 `open` 手动处理，不静默失败。
- DSH_HOME 零接触（CON-R002）：全部读写限于注册表目录 + `<userData>/skills/`。

## 页面交互规范（renderer，回收站载体）

> 复核修订新增：getTrashList/restoreFromTrash 此前无 UI 挂载点（共识 §12 无回收站行）。本节为操作性行为规范；共识 §12 补行见协调事项。

- **入口**：Skills 主视图工具条新增「回收站」按钮（与「重新扫描」同排）；按钮带条目计数徽标（trash.json 条目数，进入视图时经 getTrashList 刷新）。
- **回收站弹层**：点击弹出面板，逐条展示 TrashEntry 字段——skill 名 / 原路径 / 删除时间 / 体积（sizeBytes 格式化）+ 每条「恢复」按钮。
- **恢复交互**：点「恢复」→ `skills:restoreFromTrash { trashId }`；
  - 成功 → 条目出列、面板刷新、主列表刷新（该 skill 回到 enabled 态）。
  - `restore-conflict` → 面板内该条目切冲突提示态：「原路径已被占用，先移走冲突项或手动处理」，不覆盖、条目保留可重试。
  - `skills-not-found`（已被 TTL/容量清理）→ 提示刷新回收站。
- **面板空态**：「回收站为空」。移除/清空后即时刷新徽标。

## 公共异常集

#### SKILLS_OP_ERROR（本地 fs 管理层）

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---:|
| validation-error | 路径穿越/空名/非法字符/不在注册表白名单内（Q-038）；参数缺失或类型错 | code+msg(+field) | 提示具体原因 | 否 |
| skills-not-found | 目标路径不存在（已被外部删除/已移除） | code+msg | 提示「已不存在，请刷新」 | 否 |
| skills-conflict | 写前 mtime 冲突（壳与 agent 同时操作，外部修改） | code+msg | 提示「已被外部修改，请刷新」→ 刷新后重试 | 是（刷新后） |
| skills-op-in-progress | 同一物理路径已有写操作进行中（壳内单飞互斥，非外部修改） | code+msg | 提示「操作进行中，请稍后」，完成后可重试 | 是 |
| restore-conflict | 恢复/启用目标路径被占用（Q-035） | code+msg+targetPath | 提示「先移走冲突项或手动处理」，不覆盖 | 否 |
| skills-upgrade-undetectable | 无 source+无 lock，远端哈希 unknown（Q-033） | code+msg | 升级入口禁用「无法检测版本」 | 否 |
| skills-upgrade-failed | 升级执行失败（已自动回滚） | code+msg+method+rolledBack=true | 提示失败已回滚，可重试 | 是 |
| skills-io-error | fs 操作失败（权限不足/磁盘满/回滚也失败） | code+msg | 报错 + 提示 `open` 手动处理，不静默 | 否 |

## 接口详情

### 1. remove

`invoke skills:remove { paths }`

#### 用途与依据

- 使用场景：移除确认弹窗点「确认移除」后调用
- 共识：CON-R-skills-003 + Q-035/T-6；PRD FR-5
- 验收：移除前必经 UI 二次确认（路径+影响平台+全局警示）；确认后目录入回收站再删除；取消不产生任何变更（不发 IPC 即无副作用）

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | paths | array[string] | 是 | ≥1；每项为注册表目录内绝对路径 | 待移除物理路径（跨平台同名逐目录传入） |

#### 成功响应

- 响应 Schema：逐条结果

| 字段路径 | 类型 | 必有 | 可空 | 说明 |
|---|---|---|---|---|
| `results[]` | array | 是 | 否 | 与请求 paths 等长等序 |
| `[].path` | string | 是 | 否 | 对应请求路径 |
| `[].status` | string | 是 | 否 | removed / failed |
| `[].trashId` | string | status=removed 必有 | — | 回收站条目 id（tr_<uuid>） |
| `[].code` | string | status=failed 必有 | — | SKILLS_OP_ERROR 错误码 |

#### 失败响应

- 整体失败仅参数非法（validation-error）；业务失败逐条反映于 results[]。

#### 幂等与并发

- 幂等：否（删除语义；重复请求对已删路径返回 skills-not-found 于该条目）
- 并发：写前 mtime 检查；批量内逐条串行执行

### 2. upgrade

`invoke skills:upgrade { path }`

#### 用途与依据

- 使用场景：升级确认弹窗（来源 URL+本地/远端哈希对照）点「确认升级」后调用
- 共识：CON-R-skills-004 + Q-033/Q-034；PRD FR-6
- 验收：可升级才可点；无来源禁用「无法检测版本」（主进程同样拒绝）；失败自动回滚到原版本

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | path | string | 是 | 注册表目录内绝对路径 | 待升级物理路径（逐处升级） |

> 来源解析（source URL/lock）由主进程基于 S1 扫描数据完成，不经 IPC 传 URL——防 renderer 注入任意下载地址（安全边界）。

#### 成功响应

| 字段路径 | 类型 | 必有 | 可空 | 说明 |
|---|---|---|---|---|
| `path` | string | 是 | 否 | 升级后路径 |
| `method` | string | 是 | 否 | npx-skills-update / source-fetch / git-staging |
| `newHash` | string | 是 | 否 | 升级后本地内容哈希 |

#### 失败响应

- 适用公共异常集：SKILLS_OP_ERROR
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---:|
| skills-upgrade-undetectable | 无 source+无 lock（Q-033） | code+msg | 入口禁用「无法检测版本」 | 否 |
| skills-upgrade-failed | 获取/替换失败（已回滚） | code+msg+method+rolledBack=true | 提示失败已回滚 | 是 |
| skills-op-in-progress | 同一 path 升级进行中重复调用（单飞互斥） | code+msg | 提示「操作进行中，请稍后」 | 是（完成后） |

#### 幂等与并发

- 幂等：否（网络/远端状态变化）；重复调用前应重新扫描确认仍 upgradable
- 并发：写前 mtime 检查；同一 path 同时仅允许一个升级（进行中重复调用 → **skills-op-in-progress**）

### 3. setEnabled

`invoke skills:setEnabled { path, enabled }`

#### 用途与依据

- 使用场景：列表项启用/禁用开关切换
- 共识：CON-R-skills-008 + Q-031/Q-032/T-4；PRD FR-9
- 验收：禁用后 agent 平台真实不可加载；启用恢复原位；按路径粒度互不影响

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | path | string | 是 | 注册表目录内绝对路径 | 目标物理路径（单路径粒度） |
| body | enabled | boolean | 是 | — | false=禁用 / true=启用 |

#### 成功响应

| 字段路径 | 类型 | 必有 | 可空 | 说明 |
|---|---|---|---|---|
| `path` | string | 是 | 否 | 目标路径 |
| `enabled` | boolean | 是 | 否 | 操作后状态 |
| `entryId` | string | 禁用时必有 | — | d_<uuid>（禁用映射 id；启用时清映射不返回） |

#### 失败响应

- 适用公共异常集：SKILLS_OP_ERROR
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---:|
| restore-conflict | 启用时原路径被占用 | code+msg+targetPath | 提示冲突不覆盖 | 否 |
| validation-error | 对已禁用路径再次禁用（无对应 enabled 路径） | code+msg | 提示状态已变化请刷新 | 否 |

#### 幂等与并发

- 幂等：是（同状态重复设置结果一致；已禁用再禁用 → validation-error 提示刷新，不改盘）

### 4. getDisabledList

`invoke skills:getDisabledList`

#### 用途与依据

- 使用场景：「仅看已禁用」筛选 + 启用恢复映射查询
- 共识：CON-R-skills-008 + Q-032（映射记录）

#### 请求

无请求体。

#### 成功响应

- 响应 Schema：`{ entries: DisabledEntry[] }`（见 Schema 章；含 originalPath/kind/symlinkTarget/disabledAt）

#### 失败响应

- 仅 skills-io-error（索引损坏时按空列表重建并告警日志，不阻塞 UI）。

#### 幂等与并发

- 读操作，返回当前映射快照。

### 5. getTrashList

`invoke skills:getTrashList`

#### 用途与依据

- 使用场景：回收站面板展示（skill 名/原路径/删除时间/体积）+ 恢复入口
- 共识：CON-R-skills-003 + Q-035

#### 请求

无请求体。

#### 成功响应

- 响应 Schema：`{ entries: TrashEntry[], totalSizeBytes: integer }`（见 Schema 章）

#### 失败响应

- 仅 skills-io-error（索引损坏按空列表重建并告警）。

#### 幂等与并发

- 读操作；调用时顺带触发 TTL/容量惰性清理，返回清理后的快照。

### 6. restoreFromTrash

`invoke skills:restoreFromTrash { trashId }`

#### 用途与依据

- 使用场景：回收站面板「恢复」按钮
- 共识：CON-R-skills-003 + Q-035（恢复冲突提示）
- 验收：恢复回原路径；目标被占用提示冲突不覆盖

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | trashId | string | 是 | `tr_<uuid>` | 回收站条目 id |

#### 成功响应

| 字段路径 | 类型 | 必有 | 可空 | 说明 |
|---|---|---|---|---|
| `restoredPath` | string | 是 | 否 | 恢复后原路径 |

#### 失败响应

- 适用公共异常集：SKILLS_OP_ERROR
- 特有异常：

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---:|
| restore-conflict | originalPath 已被占用（Q-035） | code+msg+targetPath | 提示先移走冲突项 | 否 |
| skills-not-found | trashId 不存在（已过期清理） | code+msg | 提示刷新回收站 | 否 |

#### 幂等与并发

- 幂等：否（恢复后条目出列；重复请求 → skills-not-found）

### 7. getOperationLog

`invoke skills:getOperationLog { limit? }`

#### 用途与依据

- 使用场景：操作留痕审计（S2 验收④）
- 共识：CON-R-skills-003/008

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | limit | integer | 否 | 默认 200，最大 1000 | 最近 N 条 |

#### 成功响应

- 响应 Schema：`{ entries: OperationLogEntry[] }`（时间倒序；见 Schema 章）

#### 失败响应

- 仅 skills-io-error（日志缺失按空数组返回，不阻塞）。

#### 幂等与并发

- 读操作。

## 数据库与外部系统影响

> 无数据库。外部影响面 = 用户 agent 配置目录（注册表白名单内，写操作仅 remove/upgrade/setEnabled 三类）+ 壳 `<userData>/skills/`。不触 DSH_HOME（CON-R002）。git/npx 子进程仅访问 source 解析出的远端仓库（clone 只写 staging，不污染用户仓库）。

## 联调与测试场景

> e2e 经 SkillFsOps 注入临时目录模拟 agent 目录（Q-037）；真实目录操作留冒烟。编号 O1~O23。

| # | 场景 | 前置条件 | 请求/动作 | 预期结果 | 数据与审计结果 | 验收编号 |
|---|---|---|---|---|---|---|
| O1 | 移除二次确认展示 | 列表含全局+平台 skill | 点「移除」 | 弹窗展示物理路径+受影响平台；全局 skill 额外警示「影响所有平台」；取消零变更 | 无 IPC 调用、无盘上变更 | S2①/FR-5 |
| O2 | 移除成功+备份+日志 | 确认弹窗通过 | skills:remove{paths:[p]} | 原目录消失；trash/tr_x/ 有完整副本 | trash.json 新增条目（原路径+deletedAt）；operations.jsonl action=remove success | S2①/Q-035 |
| O3 | 移除批量部分失败 | paths 含有效+已删路径 | skills:remove{paths:[p1,p2]} | p1 removed；p2 failed(skills-not-found)；p1 不回滚 | results 逐条反映 | S2① |
| O4 | 移除 mtime 冲突 | 外部改动目标目录 | skills:remove | **skills-conflict**「已被外部修改，请刷新」 | 原目录保留 | §5.3 |
| O5 | 回收站 TTL 清理 | 构造 deletedAt=31 天前条目 | getTrashList | 过期条目被清理（真删） | trash.json 出列；日志 action=purge | Q-035 |
| O6 | 回收站 500MB 上限 | 构造总量 >500MB 多条目 | getTrashList | 最旧条目先删至 ≤500MB | trash.json 出列最旧 | Q-035 |
| O7 | 回收站恢复成功 | trashed 条目+原路径空闲 | restoreFromTrash | 目录回到 originalPath | trash.json 出列；日志 action=restore | Q-035 |
| O8 | 恢复冲突不覆盖 | trashed 条目+原路径被占 | restoreFromTrash | **restore-conflict**；占用项不被覆盖 | trash 条目保留 | Q-035 |
| O9 | 升级成功（npx） | upgradable + mock npx 成功退出（e2e 注入 fake npx 可执行；或实测 CLI 支持单路径定向更新，见开放问题 O-2） | skills:upgrade | method=npx-skills-update；newHash 更新 | 原目录内容更新；日志 action=upgrade success | S2②/FR-6 |
| O10 | 升级成功（git staging） | git clone 来源 | skills:upgrade | method=git-staging；staging→原子替换；原位无 .git pull 痕迹 | 替换原子（无中间缺失态）；日志含 method | Q-033 |
| O11 | 升级失败自动回滚 | 注入 clone/替换失败 | skills:upgrade | **skills-upgrade-failed**+rolledBack=true；原版本完好 | 日志 result=failed rolledBack | FR-6/Q-033 |
| O12 | 无来源升级拒绝 | 无 source+无 lock | skills:upgrade | **skills-upgrade-undetectable**；UI 入口禁用「无法检测版本」 | 不产生盘上变更 | Q-033 |
| O13 | 远端哈希四级优先级 | 同 name 多来源并存 | 升级检测 | 按 skills-lock→平台 lock→cc-switch→git remote 取值；skills-lock 优先覆盖 | 检测态正确 | Q-034 |
| O14 | 按路径禁用（平台副本） | 同 skill 在 shared+claude 各一路径 | setEnabled{claude 路径,false} | 仅 claude 平台失效；shared 路径照常生效 | disabled.json 新增 1 条目 | Q-031 |
| O15 | 共享目录整体禁用 | skill 在 ~/.agents/skills/ | setEnabled{false} | 全平台失效（真禁用） | 各 agent 均不可加载 | Q-031/T-4 |
| O16 | symlink 来源禁用 | 路径为 symlink | setEnabled{false} | symlink 被 unlink；源目录（SSOT）完好 | entry kind=symlink+symlinkTarget | Q-032 |
| O17 | 实目录来源禁用 | 路径为实目录 | setEnabled{false} | rename 入 disabled/d_x/ | entry kind=dir+originalPath 映射 | Q-032 |
| O18 | 启用恢复+冲突 | 禁用条目 | setEnabled{true} | rename 回原位/重建 symlink；原路径被占 → **restore-conflict** 不覆盖 | 映射清除（成功时） | Q-032/Q-035 |
| O19 | 路径穿越拒绝 | — | remove{paths:["~/.claude/skills/../.."]} | **validation-error**（Q-038） | 零盘上变更 | Q-038 |
| O20 | 非 white-list 路径拒绝 | — | remove{paths:["/etc"]} | **validation-error**（不在注册表白名单） | 零盘上变更 | Q-038 |
| O21 | 操作日志留痕查询 | 执行过 remove/upgrade/disable | getOperationLog | 时间倒序全量动作可查（action/paths/result/detail） | operations.jsonl 完整 | S2④ |
| O22 | DSH_HOME 零接触 | — | 全部操作 | 不读写 DSH_HOME | 变更仅在注册表目录+userData | CON-R002 |
| O23 | npx 不可用/失败降级 | upgradable + npx 命令不存在或执行失败/超时 | skills:upgrade | 按 T-3 分级降级：method=source-fetch 或 git-staging 完成升级；npx 失败不整体失败 | 日志含实际 method；原目录内容更新 | Q-033/T-3 |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| O-1 | 升级细粒度进度是否需要 event 通道（如 onSkillsOpProgress） | skills:upgrade | v1 不确定态 spinner + 终态回显（满足 FR-6 最小验收） | open（实现期评估） |
| O-2 | `npx skills update` 单路径语义待实测：CLI 可能是项目级/全局粒度，不支持单 skill 定向更新 → method=npx-skills-update 分支不可达 | skills:upgrade（method=npx-skills-update） | 实现期实测 CLI；支持则 O9 按真实前置执行，不支持则该分支移除、统一走 source-fetch/git-staging（O23 降级路径已覆盖） | open（实现期关闭） |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| S1 依赖接口 | S1 提供：扫描列表（paths/localHash/remoteHash/upgradable/enabled/source/affectedPlatforms）+ SkillFsOps 抽象层 + mtime 快照（本契约写前检查消费） | phper666 | S1 契约/设计冻结 | 待定（S1 先行） |
| IPC channel 白名单登记 | SKILLS_IPC_CHANNELS 7 通道加入 src/shared/ipc-channels.ts（ALL_IPC_CHANNELS 共面）+ preload window.skills 桥 | phper666 | S2 实现 | 待定 |
| 响应包裹形态统一 | `{ ok:true, data } \| { ok:false, code, message }` 对齐 KanbanIpcResult；错误码 kebab-case | phper666 | S2 实现 | 已定（本契约） |
| 远端哈希口径 | 与 skills-lock.json / cc-switch content_hash 口径实测对齐（PRD §9 风险项） | phper666 | S2 实现期 | 待定 |
| 破坏性操作守卫归属 | 路径校验+mtime 检查+undetectable 拒绝均在主进程 SkillsOps 内置（不信任 renderer），UI 禁用仅为体验层 | phper666 | 已闭环（本契约） | 已闭环 |
| 共识 §12 回收站补行 | 共识 §12 页面交互规范补「回收站」入口行（主视图工具条按钮→弹层面板），操作性规范以本契约「页面交互规范」节为准 | phper666 | 下次共识修订 | 待定 |

## 完成记录

> 交付后填写，结果必须有证据。

| 项 | 结果 |
|:---|:-----|
| 交付时间 | — |
| 验证结果 | — |
| 构建/发布 | — |
| 偏差处理 | — |

## 决策与踩坑

- 契约形态沿用 M2 本地数据契约模式（B1 先例）：桌面壳无 HTTP API 面，接口清单用 IPC 通道表达；新增 `skills:*` 域与 kanban:* 共面，白名单集中登记 ipc-channels.ts。
- 安全边界三处主进程强制（不信任 renderer）：① 路径校验（Q-038 basename(realpath)+注册表白名单）；② 升级来源解析在 main 侧（不经 IPC 传 URL，防注入下载地址）；③ undetectable/mtime 守卫内置 SkillsOps。
- 禁用存储用 `d_<uuid>` 目录名而非 skill-name 直命名：同 skill 多路径禁用会撞名，uuid+映射索引（disabled.json）规避。
- 回收站清理采用惰性策略（getTrashList/remove 时触发 + 启动清扫），不引入定时器常驻。

## 变更记录

| 时间 | 类型 | 摘要 |
|---|---|---|
| 2026-08-23 | 初次生成 | 基于 S2（飞书 701e3597）+ 共识 v1.2 §14.1/§13/CON-R-skills-003/004/008 + Q-031~035 生成契约草案；7 条 NEW IPC 通道 + 行为契约 + 22 测试场景 |
| 2026-08-23 | 复核修订 | FE/QA 契约复核退回项修复：① 新增「页面交互规范」节声明回收站 UI 载体（工具条入口+弹层+恢复冲突态），共识 §12 补行入协调事项；② 拆分 skills-op-in-progress 错误码（同路径写操作单飞互斥），skills-conflict 收敛为仅 mtime 外部修改语义，异常集/升级失败表/幂等并发三处同步；③ O9 前置改可构造（mock npx/实测 CLI）+ 开放问题新增 O-2（npx 单路径语义待实测）+ 新增 O23 npx 不可用降级场景；MINOR：恢复跨卷降级 copy+delete 说明、operations.jsonl 明确不轮转+启动截断策略。O1~O23、错误码 8 个 |

## 自检记录

- 追踪完整性：PASS（S2 验收①~④→CON-R-skills-003/004/008 + Q-031/032/033/034/035 + Q-038/CON-R-skills-007，追踪矩阵全覆盖）
- OpenAPI 一致性：不适用（本地 fs 管理契约，无 OpenAPI yaml；userData JSON 文件 schema 即字段唯一事实源）
- 示例与错误场景：PASS（23 个联调场景 O1~O23 含成功/失败/边界/安全/降级 + 公共异常集 8 错误码）
- 安全与敏感字段：PASS（路径穿越校验、注册表白名单、来源解析 main 侧闭环、DSH_HOME 零接触声明）
- 链接与格式：PASS
