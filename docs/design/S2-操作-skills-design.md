# S2 Skills 操作（移除/升级/禁用启用 + 回收站）技术方案

> 工作项：S2 Skills 操作——移除/升级/禁用启用 + 回收站（飞书 dsh-hull-desktop 清单，701e3597-3cb9-416c-80b0-cc826eb173da）
> 状态：**draft（撰写中）→ frozen（评审通过·冻结，可进实现）**
> 版本：0.1 · 2026-08-23
> 事实源：契约 `docs/api/feishu-s2-skills-api-contract.md` v0.2（冻结）；共识 `docs/spec/共识-Hull桌面壳-Skills检查器.md` v1.2（§14.1 子需求清单 + §13 后端任务规范 + CON-R-skills-003/004/008 + Q-031~035/Q-038）；PRD `docs/prd/2026-08-22-skills-checker-prd.md` v0.2；原型 `docs/prototype/2026-08-22-skills-checker-prototype.html`；S1 方案 `docs/design/S1-扫描搜索-skills-design.md`（SkillFsOps/pathGuard/工程基线承接）
> 判级：**复杂 + 安全敏感**。理由：破坏性写操作链（移除/升级原子替换回滚/移目录禁用）+ 回收站生命周期管理 + npx/git 子进程集成跨多子系统（skill 判级矩阵「状态机 + 外部系统集成」）；叠加安全敏感行——**直接变更用户 agent 配置目录（不可逆风险面）**：强制安全扫描（Semgrep 或等价工具）进实现纪律，缺工具必须换等价工具或安装，不得跳过。
> 依赖：S1（扫描快照 SkillEntry.paths/PathInfo、SkillFsOps 抽象层、pathGuard、哈希计算——全部复用不重写）。

---

## 1. 背景与范围

**定位**：S2 交付 Skills 检查器写面——在 S1 只读扫描之上提供受控的破坏性操作闭环。核心 = 移除（回收站备份→删除→日志）+ 一键升级（内容哈希对比 → 分级执行 → staging 原子替换 → 失败回滚）+ 禁用/启用（按物理路径粒度移目录真禁用）+ 回收站管理（TTL 30 天 / 500MB 上限 / 恢复冲突处理）+ 操作日志留痕。

**规则绑定**：CON-R-skills-003（二次确认+回收站 Q-035）、CON-R-skills-004（升级检测+执行分级 Q-033/Q-034）、CON-R-skills-008（按路径粒度移目录真禁用 Q-031/Q-032/T-4）、CON-R-skills-007（路径校验 Q-038，全部写通道前置）+ 共识 §5.3 并发冲突。

**范围**（契约 §范围，冻结）：
- 7 条新增 IPC 通道（`skills:*` 域）：remove / upgrade / setEnabled / getDisabledList / getTrashList / restoreFromTrash / getOperationLog
- 移除行为链：二次确认（UI 层）→ 路径校验 → mtime 冲突检查 → 回收站备份 → 删除 → 日志
- 升级行为链：upgradable 前置校验（主进程强制）→ 执行方式分级（npx skills update / source URL 重取 / git clone staging）→ 原子替换 → 失败回滚 → 日志
- 禁用/启行为链：按物理路径粒度 → symlink unlink / 实目录 rename 入 disabled → 映射记录 → 启用恢复 → 日志
- 回收站管理：TTL 30 天 + 500MB 上限（最旧先删）、条目查询、恢复冲突处理、惰性清理
- userData 状态文件 schema：disabled.json / trash.json / log/operations.jsonl / staging/
- 回收站 UI 载体：主视图工具条按钮 + 弹层面板（契约「页面交互规范」节）

**非目标**（契约 §非目标）：扫描/列表聚合/搜索/来源跳转/哈希计算与缓存（S1）；远程安装/卸载（T-2 不做）；skill 创建/编辑；CC 配置修改；多设备同步；DSH_HOME 任何读写（CON-R002 红线）。

**交付验收**：契约测试场景 O1~O23（确认流展示/备份日志/批量部分失败/mtime 冲突/TTL 清理/500MB 上限/恢复冲突/升级三 method/失败回滚/undetectable 拒绝/四级优先级/按路径禁用/symlink vs 实目录/启用恢复冲突/路径穿越拒绝/白名单外拒绝/日志查询/DSH_HOME 零接触/npx 降级）。

**范围剪裁说明（YAGNI）**：升级进度不做 event 通道（v1 不确定态 spinner + 终态回显，开放问题 O-1 实现期评估）；operations.jsonl 不做滚动轮转（仅启动 >10MB 截断保留 1000 行）；回收站清理不做常驻定时器（惰性策略：getTrashList/remove 触发 + 启动清扫）；不做操作撤销栈（回收站恢复即兜底）。

---

## 2. 架构决策（含备选）

### D1 破坏性操作守卫分层：UI 二次确认 + 主进程强制校验 vs 仅 UI 确认

- **A**：两层——renderer 确认弹窗（物理路径+受影响平台清单+「不可恢复」警示；全局 skill 额外警示「影响所有 agent 平台」）为主进程放行前提的体验层；main 侧路径校验/mtime 检查/undetectable 拒绝/单飞互斥**内置强制**（不信任 renderer）
- **B**：仅 UI 弹窗确认，main 直接收调用执行 → renderer 被注入或 bug 时无兜底，破坏性操作直达用户目录 → **选 A**

理由：契约行为契约明定「IPC 收到调用即视为已确认，主进程不再重复弹窗，但路径校验/mtime 检查不可跳过（不信任 renderer）」；安全边界三处 main 强制（路径校验/来源解析 main 侧闭环防注入下载地址/守卫内置 SkillsOps）。同 path 写操作单飞互斥：进行中再触发任一写操作 → `skills-op-in-progress`（壳内互斥，区别于 skills-conflict 的外部修改语义），实现为 per-path 内存锁 Map（§4.3）。

### D2 移除 = 回收站备份而非直删：move 入 trash + TTL/容量惰性清理 vs 直接 rm

- **A**：整目录 move 到 `<userData>/skills/trash/tr_<uuid>/`（原子 rename；跨卷降级 copy+delete 先复制校验再删源）+ trash.json 索引（originalPath/deletedAt/sizeBytes/platforms）→ TTL 30 天自动清理 + 总量 >500MB 最旧先删；恢复时目标占用 → restore-conflict 不覆盖
- **B**：确认后直接 rm -rf → 误删不可恢复，违背 T-6 定案 → **选 A**

理由：CON-R-skills-003 + Q-035 冻结备份策略；用户 agent 目录是壳外资产，误删代价不可逆。uuid 目录名规避同名撞名（同 skill 多路径先后移入）；sizeBytes 入索引使 500MB 判定免重复 du 扫描。跨卷降级：userData 与 agent 目录可能不同卷（rename EXDEV）→ copy+delete，copy 中途失败清理半成品、trash 条目保留可重试（原目录未动=未删语义保持）。清理触发惰性化：getTrashList/remove 时顺带 + 壳启动清扫一次，无常驻定时器。

### D3 升级执行：staging 原子替换 + 失败回滚 vs 原位覆盖 vs 原位 git pull

- **A**：新版落 `<userData>/skills/staging/<uuid>/` → 完整性校验（SKILL.md 存在 + frontmatter name 一致）→ 原目录 rename → staging-backup、staging rename → 原路径 → 成功清 backup/staging；任一步失败 → backup rename 回原路径（回滚保留原版本）→ 清 staging → 日志 rolledBack=true
- **B**：新文件直接覆盖原目录 → 中途失败留下半新半旧混合态，违背 FR-6「失败不破坏现有 skill」
- **C**：git clone 来源原位 `git pull` → 非原子（Q-033 明示否决），pull 冲突/中断即脏工作区 → **选 A**

理由：CON-R-skills-004 + Q-033 冻结；rename 同卷内原子，两段 rename 窗口极小且失败可逆向（backup 还在）。执行方式分级（T-3/Q-033）：a) `npx skills update` 可用 → method=npx-skills-update（**单路径语义待实测 O-2**——CLI 可能项目级粒度不支持定向更新，不可达则该分支移除统一走 b/c，O23 降级场景已覆盖）；b) metadata.source 存在且非 git → source URL 重取（method=source-fetch）；c) git clone 来源 → clone 到 staging（method=git-staging）。前置主进程强制：remoteHash=unknown（四级来源均无）→ `skills-upgrade-undetectable` 拒绝（UI 禁用仅为体验层）；npx/git 子进程超时上限 120s，超时视为失败走回滚。

### D4 禁用/启用：按物理路径粒度移目录真禁用 vs 壳内白名单过滤

- **A**：每物理路径独立操作——symlink 来源 → `unlink` symlink（源保留原始仓库/SSOT），DisabledEntry.kind=symlink 记 symlinkTarget 无实体入驻；实目录来源 → rename 到 `<userData>/skills/disabled/d_<uuid>/`（kind=dir）；disabled.json 记录被禁用路径+原路径映射；启用 = 据映射 rename 回原位 / 重建 symlink
- **B**：壳内白名单过滤（扫描结果标记 disabled 不动盘）→ agent 平台照常加载该 skill，「禁用」名不符实（T-4 评审明确否决）→ **选 A**

理由：T-4 定案「移目录真禁用，agent 平台真生效」；Q-031 细化按路径粒度（共享目录 `~/.agents/skills/` 整体移出=全平台禁，平台专属副本单独禁只影响该平台）；Q-032 细化物理操作对象（symlink 移指针不碰 SSOT 源，实目录 rename 保 SKILL.md 内容完好）。`d_<uuid>` 目录名规避同 skill 多路径禁用撞名（契约决策与踩坑项）。启用冲突：原路径被外部重建占用 → restore-conflict 不覆盖；已禁用再禁用 → validation-error 提示刷新不改盘。isSymlink 判定复用 S1 PathInfo（lstat 已扫，不二次 stat）。

### D5 并发守卫：写前 mtime 检查 vs 写锁文件 vs 不设防

- **A**：写前 `stat(path).mtimeMs` 对比 S1 扫描快照 PathInfo.mtimeMs，不一致 → `skills-conflict`「已被外部修改，请刷新」（刷新后可重试）
- **B**：跨进程文件锁（lockfile）→ agent 平台不遵守壳的锁协议，锁不住真实并发源 → **选 A**
- **C**：不设防 → 壳与 agent 同时操作同一目录，静默数据竞争 → **选 A**

理由：共识 §5.3/§13 冻结 mtime 检查；agent 平台是壳外独立进程，唯一可行的冲突检测是乐观并发（写前比对快照）。已知天花板：mtime 比对是检测窗口非互斥窗口（检查后、写入前仍有微小竞态窗），标记 `ponytail:` 注释——桌面单用户场景下窗口实际风险极低，彻底方案需 inode 快照对比，收益不值。skills-conflict（外部修改）与 skills-op-in-progress（壳内单飞）两个错误码语义严格分离（契约复核修订定案）。

### D6 操作日志：append-only JSONL + 启动截断 vs SQLite vs 轮转日志库

- **A**：`<userData>/skills/log/operations.jsonl` append-only JSON Lines（ts/action/paths/result/detail）；启动时 >10MB 则截断保留最近 1000 行；getOperationLog 读尾 N 条时间倒序返回
- **B**：SQLite 表 → 单表追加场景引依赖过重，壳内无既得 sqlite 设施 → **选 A**
- **C**：winston 等轮转日志库 → 又一依赖，JSONL 手写 ~40 行足够 → **选 A**

理由：CON-R-skills-003/008 要求破坏性操作全留痕（remove/upgrade/disable/enable/restore/purge 六 action）；JSONL 追加写崩溃安全（半行损坏跳过该行不影响其余）；量级评估=仅破坏性操作入账，10MB 截断阈值实际多年难触达（防御性上限）。detail 记 method/rolledBack/error code（审计可归因）。purge（TTL/容量清理）同样入日志——真删也是破坏性动作。

### D7 回收站 UI 载体：主视图工具条按钮 + 弹层面板 vs 独立视图/侧栏

- **A**：Skills 主视图工具条新增「回收站」按钮（与「重新扫描」同排，带条目计数徽标）→ 点击弹层面板逐条展示 TrashEntry（skill 名/原路径/删除时间/体积）+ 每条「恢复」按钮
- **B**：回收站独立成 nav 视图 → 低频功能占一级导航位，不值 → **选 A**

理由：契约「页面交互规范」节冻结（复核修订新增——此前 getTrashList/restoreFromTrash 无 UI 挂载点）；弹层与既有确认弹窗同层叠机制，不加 nav 复杂度（VIEW_TO_NAV 映射不动）。恢复交互状态机：成功 → 条目出列+面板刷新+主列表刷新；restore-conflict → 条目切冲突提示态保留可重试；skills-not-found（已被清理）→ 提示刷新回收站。面板空态「回收站为空」；徽标随 remove/getTrashList 即时刷新。共识 §12 补行走协调事项（下次共识修订）。

---

## 3. 模块划分

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `src/skills/SkillFsOps.ts`（扩展） | S1 只读接口上扩展写面：move/rename/unlink/rm/mkdir/cp（含跨卷 copy+delete 降级封装） | — | Q-037 |
| `src/skills/guards.ts` | 写通道公共前置链：pathGuard 校验 → mtime 冲突检查 → per-path 单飞锁获取/释放（D1/D5） | pathGuard、SkillsScanner 快照 | 全部写通道 |
| `src/skills/OperationLog.ts` | operations.jsonl 追加写 + 启动截断（>10MB 留 1000 行）+ 尾读 N 条倒序（D6） | SkillFsOps | skills:getOperationLog |
| `src/skills/TrashManager.ts` | 回收站：move 入驻 + trash.json 索引（temp+rename 原子写）+ TTL/容量惰性清理 + 恢复（冲突检测/跨卷降级）（D2） | SkillFsOps、OperationLog | remove/getTrashList/restoreFromTrash |
| `src/skills/UpgradeExecutor.ts` | 升级：upgradable 前置强制校验 → 分级获取（npx/source-fetch/git-staging）→ staging 完整性校验 → 两段 rename 原子替换 → 失败回滚（D3） | SkillFsOps、sourceResolver、hash、OperationLog | skills:upgrade |
| `src/skills/DisableManager.ts` | 禁用/启用：symlink unlink vs 实目录 rename 分派 + disabled.json 映射 + 启用恢复/冲突（D4） | SkillFsOps、OperationLog | setEnabled/getDisabledList |
| `src/skills/SkillsOps.ts` | 门面：7 channel 编排入口，装配 guards + 三管理器 + 日志，错误码统一抛 HullError（kebab） | 上列全部 | SKILLS_OP_ERROR |
| `src/skills/errors.ts`（扩展） | 8 错误码具名集：validation-error/skills-not-found/skills-conflict/skills-op-in-progress/restore-conflict/skills-upgrade-undetectable/skills-upgrade-failed/skills-io-error | shared/errors | 公共异常集 |
| `src/skills/ipc/SkillsIpc.ts`（扩展） | +7 channel 注册（S1 5 条共面，合计 12 条 skills:* + hull:showSkills） | SkillsOps | 全部 IPC |
| `src/renderer/skills.js`（扩展） | 确认弹窗（移除/升级两形态）+ 启用开关 + 回收站按钮/弹层/恢复冲突态 + 错误提示文案映射 | window.skills 桥 | 页面交互规范 |

**依赖方向**（单向，无环）：`SkillsIpc → SkillsOps → {guards, TrashManager, UpgradeExecutor, DisableManager, OperationLog}`；三者平行互不依赖，共享 guards 前置链与 OperationLog 落账；`SkillsOps → SkillsScanner`（只读快照消费：PathInfo.mtimeMs/isSymlink/upgradable/source）。

**S1↔S2 边界**：S2 不重扫——mtime/isSymlink/upgradable 全部取自 S1 快照（契约协调事项「S1 供给接口」已定）；S2 写操作成功后触发增量重扫（scanner.scan() 幂等重启，哈希缓存命中仅变动路径重算），列表与计数即时反映。

---

## 4. 关键机制实现形态

### 4.1 原子替换（staging → 替换 → 回滚，升级核心）

```
upgrade(path):
  guards 前置（校验+mtime+单飞锁）
  upgradable 校验：快照 remoteHash=null → skills-upgrade-undetectable（主进程强制）
  解析执行方式（Q-033 分级）：npx 可用(实测 O-2) → source-fetch → git-staging
  stagingDir = <userData>/skills/staging/<uuid>/
  try:
    获取新版到 stagingDir（npx update / fetch+解包 / git clone --depth 1）
    完整性校验：stagingDir/SKILL.md 存在 && frontmatter.name === 快照 name
    backupDir = staging/<uuid>.backup/
    rename(path → backupDir)          # ① 原版让位（同卷原子）
    rename(stagingDir → path)         # ② 新版就位
    rm -rf backupDir；重算该路径 localHash（不走缓存）
    日志 success(detail.method)；返回 { path, method, newHash }
  catch:
    if exists(path) 且来自②后失败: rename(path → stagingDir)   # 让位
    if exists(backupDir): rename(backupDir → path)              # 回滚原版本
    rm -rf stagingDir
    日志 failed(rolledBack=true)
    throw skills-upgrade-failed（回滚本身也失败 → skills-io-error + 提示 open 手动处理）
  finally:
    释放单飞锁；触发增量重扫
```

- 两段 rename 窗口内崩溃（①后②前）：backupDir 持有原版、原路径空缺——启动清扫时检测 `staging/*.backup/` 存在且对应注册表路径空缺 → 自动 rename 回原路径（自愈），日志记 restored-on-boot
- 子进程约束：npx/git 均 spawn 参数数组（不经 shell）；120s 超时 kill 视为失败走回滚；clone 只写 staging 不污染用户仓库
- 同 skill 多处安装版本不同 → 每次调用一个 path 逐处升级（UI 逐条触发，无批量升级原语）

### 4.2 mtime 守卫（乐观并发检测）

- 判据：`stat(target).mtimeMs !== snapshotPathInfo.mtimeMs` → skills-conflict（外部修改语义，刷新后可重试）
- 适用：remove/upgrade/setEnabled/restoreFromTrash 全部写通道（restore 的目标是 originalPath 占用检查 + 同款 mtime 逻辑）
- 与单飞互斥的次序：**先单飞锁后 mtime 检查**——锁内做检查保证「检查→写」段内无壳内并发；壳外并发靠 mtime 本身检测（D5 天花板已知并注释）
- 快照陈旧兜底：S1 ready 后用户长时间停留，agent 改了目录 → mtime 必不一致 → 提示刷新，重扫后再操作（正确性优先于便利）

### 4.3 单飞互斥（per-path 写锁）

- `Map<absPath, Promise>` 内存锁：写操作进入时 set，finally delete；同 path 任一写操作进行中再触发 → skills-op-in-progress「操作进行中，请稍后」
- 粒度 = 物理路径（非 skill name）：同 skill 多路径可并行操作（互不影响）；trash/staging 内部区不参与锁（管理器内部串行由门面保证）
- 锁不持久化：壳崩溃即清（半途操作的盘上一致性由各行为链自身的失败回滚 + 启动自愈兜底，不依赖锁存活）

### 4.4 回收站生命周期（TTL 30 天 / 500MB / 恢复冲突）

```
remove(path):
  guards → move(path → trash/tr_<uuid>/)（EXDEV → cp+verify+rm 降级）
  trash.json 追加 TrashEntry{originalPath, deletedAt, sizeBytes, platforms}
  惰性清理：deletedAt < now-30d 条目 rm（action=purge 入日志）；
            ΣsizeBytes > 500MB → 按 deletedAt 最旧先删至 ≤500MB
  日志 success；返回 { status:'removed', trashId }

restoreFromTrash(trashId):
  guards（目标=originalPath）
  exists(originalPath) → restore-conflict（不覆盖，条目保留可重试）
  move(trash 条目 → originalPath)（跨卷降级同 remove；copy 中途失败清半成品保条目）
  trash.json 出列；日志 success
```

- trash.json/disabled.json 写入一律 temp+rename 原子写（SettingsProvider.set 先例）；损坏 → 告警 + 按空列表重建（孤儿目录启动清扫时归档，不静默真删）
- purge 是真删（rm -rf）——唯一不可恢复点，入日志 action=purge；TTL/容量阈值常量化（30 天/500MB，契约 §9）

### 4.5 禁用/启用分派（symlink vs 实目录）

```
setEnabled(path, false):
  guards → lstat 判 isSymlink（S1 PathInfo 一致，以现场 lstat 为准）
  symlink → unlink(path)；entry={kind:'symlink', symlinkTarget:readlink(path)}
  实目录 → rename(path → disabled/d_<uuid>/)；entry={kind:'dir'}
  disabled.json 追加；日志 success；返回 entryId

setEnabled(path, true):
  guards → disabled.json 按 originalPath 反查 entry（无 → validation-error）
  原路径 exists → restore-conflict
  kind=symlink → symlink(entry.symlinkTarget → path)
  kind=dir    → rename(disabled/d_<uuid>/ → path)
  disabled.json 出列；日志 success
```

- agent 平台真生效验证口径：禁用后路径不在 agent 读取位置（O14/O15 e2e 断言盘上事实，不 mock agent 行为）
- 不破坏 SKILL.md：unlink 只删链接、rename 整体搬移，内容零触碰（O16/O17 验证源目录/实体完好）

### 4.6 IPC 与 UI 接线

| channel | 关键返回/错误 |
|---|---|
| `skills:remove { paths[] }` | results[] 逐条 removed/failed(+trashId/code)；validation-error/skills-conflict/skills-op-in-progress/skills-not-found |
| `skills:upgrade { path }` | { path, method, newHash }；skills-upgrade-undetectable/skills-upgrade-failed(+rolledBack)/skills-conflict/skills-op-in-progress |
| `skills:setEnabled { path, enabled }` | { path, enabled, entryId? }；restore-conflict/validation-error |
| `skills:getDisabledList` | { entries: DisabledEntry[] }（损坏按空列表重建告警） |
| `skills:getTrashList` | { entries: TrashEntry[], totalSizeBytes }（顺带惰性清理） |
| `skills:restoreFromTrash { trashId }` | { restoredPath }；restore-conflict/skills-not-found |
| `skills:getOperationLog { limit? }` | { entries: OperationLogEntry[] } 时间倒序（默认 200 最大 1000） |

- 来源解析（source URL/lock）main 侧基于 S1 数据完成，不经 IPC 传 URL——防 renderer 注入任意下载地址（安全边界，契约决策项）
- UI 确认流：移除弹窗（路径+影响平台+全局警示）→ 确认才发 IPC，取消零请求零变更（O1）；升级弹窗（来源 URL+本地/远端哈希对照+「原子替换，失败自动回滚」警示）；错误码 → 中文文案集中映射表（8 码全覆盖，含 skills-io-error 的「open 手动处理」提示）

---

## 5. 工程基线

**判级**：复杂 + 安全敏感（头部一致）。

| 项 | 现状 | S2 动作 |
|---|---|---|
| git | ✅（M1 全程使用） | 直接复用 |
| 脚手架 | ✅（package.json tsc 构建） | 直接复用，`src/skills/` 扩展模块 |
| 测试框架 | ✅（node:test co-located + Playwright e2e） | 复用框架，**新增**：`src/skills/*.test.ts`（TrashManager TTL/容量/恢复冲突、UpgradeExecutor 三 method/回滚/自愈、DisableManager symlink/实目录/冲突、guards 单飞/mtime、OperationLog 截断——全部 SkillFsOps 注入临时目录）+ `tests/e2e/` 用例（确认流取消零变更/移除备份恢复/禁用启用盘上断言，HULL_E2E 注入临时 HOME） |
| 安全扫描 | Semgrep 待确认安装 | **实现纪律强制项**：Semgrep 或等价工具扫描通过方可交付；缺工具必须安装或换等价，不得跳过（判级安全敏感行） |
| 真实目录冒烟 | — | e2e 全程临时目录（Q-037）；真实 `~/.claude` 等目录操作仅留人工冒烟清单（移除→回收站→恢复一条链） |

**技术栈决策**：跟随 M1/M2/S1 既有栈——Electron + TypeScript + node:test + Playwright，**不引入新依赖**（无 SQLite/日志库/锁库；JSONL/temp+rename/per-path Map 全部手写最小实现）。env 注入沿用 HULL_E2E（临时 HOME 根注入，SkillFsOps 工厂参数化）。

---

## 6. 目录/工程结构

```
src/skills/                          # S1 建立，S2 扩展（标 ★ 为 S2 新增/改动）
├── SkillFsOps.ts                    # ★ 扩展写面 move/unlink/rm/cp（跨卷降级封装）
├── guards.ts                        # ★ 写通道前置链（校验+mtime+单飞锁）
├── OperationLog.ts                  # ★ operations.jsonl 追加/截断/尾读
├── TrashManager.ts                  # ★ 回收站（备份/索引/TTL/容量/恢复）
├── UpgradeExecutor.ts               # ★ 升级（分级获取/原子替换/回滚/启动自愈）
├── DisableManager.ts                # ★ 禁用启用（symlink/实目录分派+映射）
├── SkillsOps.ts                     # ★ 门面（7 channel 编排装配）
├── errors.ts                        # ★ 扩展 8 错误码（SKILLS_OP_ERROR 集）
├── ipc/SkillsIpc.ts                 # ★ 扩展 +7 channel（合计 12 skills:* 面）
├── *.test.ts                        # ★ 新增操作层/回收站/升级/禁用/日志单测
└── （S1 既有：registry/SkillsScanner/frontmatter/sourceResolver/hash/remoteHash/pathGuard/searchRemote）
<userData>/skills/                   # 运行时布局（契约 Schema 章）
├── disabled/<d_uuid>/               # 实目录禁用存储
├── disabled.json                    # 禁用映射索引
├── trash/<tr_uuid>/                 # 回收站条目
├── trash.json                       # 回收站索引
├── staging/                         # 升级临时区（成功/回滚后清理；*.backup 自愈扫描）
├── hash-cache.json                  # S1 哈希缓存
└── log/operations.jsonl             # 操作日志（>10MB 启动截断留 1000 行）
src/renderer/skills.js               # ★ 扩展：确认弹窗/开关/回收站弹层/错误文案映射
tests/e2e/                           # ★ 新增 skills-ops.e2e.js（确认流/移除/禁用链路）
```

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| 移除/禁用直接变更用户 agent 配置目录，bug 即不可逆损失 | 用户资产损坏 | 四层防护：UI 二次确认（路径+平台+全局警示）→ 主进程强制校验（白名单域+穿越拒绝）→ 回收站备份可恢复 → 操作日志可审计；e2e 临时目录全覆盖 + 真实目录仅人工冒烟 | S2 |
| `npx skills update` 单路径语义未实测（O-2） | method=npx-skills-update 分支可能不可达 | 实现期实测 CLI；不支持定向更新则移除该分支统一走 source-fetch/git-staging（O23 降级已覆盖）；分支可达性与实测结论记入方案偏离 | S2 |
| 升级两段 rename 窗口崩溃 | 原路径空缺、原版滞留 backup | 启动自愈：staging/*.backup 扫描 + 注册表路径空缺 → 自动还原 + 日志；回滚本身失败 → skills-io-error + open 手动处理提示 | S2 |
| 并发竞态（agent 平台同时写目录） | 半写状态/数据丢失 | 写前 mtime 乐观检测（skills-conflict 刷新重试）+ 壳内 per-path 单飞互斥；已知检测窗口天花板 ponytail 注释标记（单用户桌面场景风险极低） | S2 |
| 跨卷 move（EXDEV） | rename 抛错中断操作 | cp+verify+rm 降级封装于 SkillFsOps.move；copy 中途失败清半成品、原数据不动（remove 场景 trash 条目保留可重试） | S2 |
| trash.json/disabled.json 损坏 | 索引与盘上实态脱节 | temp+rename 原子写；损坏告警+空列表重建；孤儿目录启动清扫归档不静默真删 | S2 |
| 回收站吞盘（大 skill 大量移入） | userData 膨胀 | 500MB 容量上限最旧先删 + TTL 30 天双阈值；sizeBytes 入索引免重复扫描；惰性触发无常驻开销 | S2 |
| symlink 误伤 SSOT 源 | 用户原始仓库被改 | 禁用只 unlink 指针（lstat 判定先行）；symlinkTarget 入映射供精确重建；O16 断言源目录完好 | S2 |
| 权限不足/磁盘满中途失败 | 半完成操作 | 各行为链失败即回滚（move 失败=未删语义）；skills-io-error 显式报错 + open 手动处理，不静默失败（§5.3） | S2 |

---

## 8. 核验记录（交付核验时填写）

| 项 | 结果 |
|:---|:-----|
| 状态 | draft（评审通过后置 frozen，评审记录在此留痕：评审人/机制 + 日期 + 结论） |
| 实现偏离 | —（实现 vs 方案，交付核验时填；有意偏离更新本方案+记录理由，架构级偏离回 draft 重评） |
