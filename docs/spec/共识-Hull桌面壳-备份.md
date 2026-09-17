# Hull 桌面壳（数据备份与恢复）共识文档

> 版本：v1.1 · 更新：2026-09-17 · 维护者：phper666（PM） · 状态：已发布
> 数据来源：Hull Backup PRD（docs/prd/2026-09-11-backup-prd.md）+ 调研（docs/research/2026-09-17-backup调研.md）+ 用户决策 2026-09-17（7 项待拍板按推荐 + 扫描后 6 项决策 + v1 增加合并模式）+ 三角色扫描闭环（Q-077~Q-100）
> 关联：新增需求；需求标识 `backup`（PRD slug）；本模块不涉及多期拆分

## 1. 文档元信息

- **本版本变更**：v1.1——三角色扫描 24 条 Q-items（Q-077~Q-100）全数闭环回写。关键项：① 恢复替换单位改「白名单项集逐项」（不再整目录，dsh/node/corepack 不动）；② 白名单 9→7 项（排除 Partitions/shell 与 workflows/runs.json）；③ 恢复执行时机 = 运行期只校验+标记、启动早期执行；④ notesDir 重定位改「启动后提示重选」（恢复期不弹窗）；⑤ 恢复结果跨启动可见（.restore/result.json + 数据卡展示）；⑥ skills 路径跨机失效 → 标注不可用；⑦ **新增合并模式（merge）**：v1 支持 replace/merge 双模式（用户决策）。新增规则 CON-R-backup-011~016。
- **历史变更摘要**：v1.0 首次建立——从 backup PRD + 调研提取整理；登记 CON-R-backup-001~010、U-1~U-5；7 项决策定案。
- **状态说明**：v1.1 已发布；扫描闭环完成；子需求拆解（Gate B）随实现启动补。

## 2. 文档结构总览

- **覆盖**：Hull 用户数据的备份（导出）与恢复（导入，replace/merge 双模式）全部业务面——备份范围白名单、凭据边界、备份形式、一致性、恢复语义与原子性、路径迁移、入口与触发、校验规则、冲突可见性。
- **适用范围**：Hull 壳自有用户数据（`<userData>` 内白名单 + notes 默认目录）；**不覆盖** dsh 本体与运行时（CON-R003/R007 通道独立，可重装）、DSH_HOME 用户数据（CON-R002 红线）、connections 凭据（safeStorage 机器绑定，不可迁移）。
- **不做事项**（详见 §12）：跨机自动同步 / 云备份；凭据导出；DSH_HOME 迁移；备份包加密；增量/断点续传。

## 3. 领域术语表

| 术语 | 定义 | 出处 |
|:-----|:-----|:-----|
| 用户数据 | 用户创作或用户意图产生的数据：设置偏好、看板 boards.json、工作流定义、笔记 md、通知记录、Skills 禁用/删除状态等 | 调研 §二 |
| 派生数据 | 可从其他数据重建的数据：token 桶缓存、skills 哈希缓存、执行日志、Chromium 缓存 | 调研 §二 |
| 可重装产物 | 可通过网络重装的运行时文件：`dsh/` overlay、`node/`、`corepack/`（CON-R003/R007 通道） | 调研 §二 |
| 备份包 | 导出产物 = 用户选定目录下 `Hull备份-YYYYMMDD-HHmmss/` + `manifest.json`（v1 为目录形态，非压缩包） | PRD §目标 + Q-080 |
| manifest.json | 备份包元信息：formatVersion / exportedAt / appVersion / items[]（path,type,version,size）/ notesDirHint | 调研 §一 + Q-082 |
| 替换模式（replace） | 恢复模式一：包内数据整体替换本地对应项（非白名单不动） | Q-077 + 用户决策 |
| 合并模式（merge） | 恢复模式二：包内数据与本地数据并存合并，冲突不静默覆盖、以结果清单呈现 | 用户决策 2026-09-17 + Q-011 规则 |
| 预备份（.bak-&lt;ts&gt;） | 恢复前对将被替换项改名保留的兜底副本；恢复失败/启动自愈时回滚来源 | 调研 §四 + Q-087 |
| pending-restore 标记 | `<userData>/.restore/pending.json`：运行期写入，启动早期据此执行恢复（独立目录，不受白名单影响） | Q-078 |
| 重定位 | 恢复后 notesDir 原路径在新机器不存在 → 启动完成后提示用户重新选择笔记目录 | 调研 §三.2 + Q-095 |

## 4. 功能需求（PRD + 调研提取）

### 4.1 备份范围（FR-1）

- **白名单（7 项，实测 ≈360KB）**：
  | 项 | 路径 | 性质 |
  |:---|:-----|:-----|
  | 设置 | `settings.json` | 用户偏好（含 notesDir/theme/packageManager/notifPrefs） |
  | 看板 | `kanban/boards.json` | 用户内容（boards/columns/tasks/timeline/comments） |
  | 工作流定义 | `workflows/workflows.json` | 用户内容 |
  | 笔记 | `notes/**/*.md`（notesDir 默认目录内） | 用户内容（可外置，见 4.7） |
  | 笔记回收站 | `notes/trash.json` + `notes/.trash/` | 用户内容 |
  | Skills 状态 | `skills/disabled.json`、`skills/trash.json`、`skills/trash/` | 用户意图（禁用/删除过哪些 skill） |
  | 通知与免打扰 | `notifications/notifications.json` + `dismiss.json` | 派生但有状态价值（未读等） |
- **排除**（v1.1 冻结）：
  - 可重装产物：`dsh/`、`dsh-previous/`、`node/`、`corepack/`；
  - 派生缓存：`token-buckets.json`、`skills/hash-cache.json`、`skills/remote-sig-cache.json`、`kanban/executions/*.log`、Chromium 缓存（`Cache/`、`Code Cache/`、`GPUCache/`、`Dawn*Cache/`、`IndexedDB/`）；
  - **`Partitions/shell/`（Q-089）**：壳 UI 视图/列宽记忆（localStorage leveldb）；运行中拷贝可能不一致，收益 < 风险 → 不备份（后果：新机视图/列宽回默认），登记 v2 候选；
  - **`workflows/runs.json`（Q-089）**：工作流运行历史（通知徽标数据源）→ 不随包（后果：运行记录清空，工作流定义不受影响）；
  - 瞬态与日志：`*-staging/`、`*.tmp`、`*.tmp-*`、`*.bak-<ts>`、`*.corrupt-<ts>`、`logs/`；
  - 更新器缓存（userData 外，启动重建）。

### 4.2 凭据边界（FR-2）

- `connections/connections.json` **不进备份包**：safeStorage 加密绑机器 + OS 用户密钥（macOS Keychain / Windows DPAPI / Linux 钱包），异机必然无法解密，原样拷贝 = 无效资产。
- 恢复后在「工作台连接」重新填写（v1 仅 4 平台：SF/阿里云短信/腾讯云短信/SMTP）。
- 「用户口令重新加密的凭据包」为 v2 候选（U-2）。

### 4.3 备份形式（FR-3）

- **目录拷贝**：在用户选定目录下**新建 `Hull备份-YYYYMMDD-HHmmss/`**（重名自增后缀）；根目录写 `manifest.json`。
- **`manifest.json` 最后原子写**——它存在即代表本次备份完成（半成品识别依据，Q-081）。
- 目标目录校验：realpath 前缀检查，**拒绝目标位于 `<userData>` 内**（防自包含/空间翻倍，Q-080）。
- 单文件 zip 包延后（U-3）；若后续要做，走系统自带 bsdtar（mac / win10+ / linux），不引入第三方压缩依赖。

### 4.4 备份一致性（FR-4）

- 备份前 **flush 清单**（Q-085）：`kanbanStore.flushSync()`（src/kanban/KanbanStore.ts:318 已公开）+ 各 store 落盘（settings/workflows/notifications/dismiss 均为原子写）。
- 拷贝按白名单**正列举**逐项进行；文件在拷贝窗口被 rename 走（ENOENT）→ 重试 1 次后跳过并在结果中汇总 warning。
- **门控清单（Q-086，主进程强制）**：`canBackup()` = 无执行中/排队任务 + dsh 安装/升级非进行中 + skills 升级非进行中 + Hull 自更新非进行中 + 无未完成 pending-restore；渲染层按钮禁用仅为 UX，IPC handler 内二次校验并返回明确错误码；dsh 空闲运行不门控（其数据在 DSH_HOME，不入包）。

### 4.5 恢复语义（FR-5）

```
选择备份目录 → 校验（manifest + 兼容性 + 迁移预演，见 §4.10）
  → 选择模式（replace / merge）
  → 运行期：写 <userData>/.restore/pending.json（记录 backupRoot/bakRoot/mode/items/step）+ 提示重启
  → 重启后启动早期执行：
       ① 将被替换/合并涉及的本地项 rename → <name>.bak-<ISO8601 秒>-<n>
       ② 按模式应用包内数据（replace=白名单逐项换入；merge=按 §4.9 逐类合并）
       ③ 启动校验（settings/boards 可解析 + 迁移链）
       ④ 失败 → 回滚 .bak；成功 → 写 .restore/result.json
```

- **替换单位 = 白名单项集逐项**（Q-077，非整目录）：`dsh/`、`dsh-previous/`、`node/`、`corepack/`、`Partitions/`、`Singleton*` 等非白名单一律不动 → 恢复后无需重装 dsh，`.bak` 仅占数百 KB。
- **执行时机**（Q-079）：运行期只做校验 + 写标记；全部文件操作在下次启动早期完成（避免运行中写入被旧包覆盖，出现「设置回滚」）。
- 要求应用未运行：与 dsh 升级 staging→替换→验证→回滚同构（CON-R005）。
- 三态自愈（Q-078）：标记 + 完整 staging → 继续执行；标记 + 半成品 → 从 `.bak` 回滚；无标记 + `.restore/` 残留 → 清理。
- 与更新通道互斥（Q-088）：存在未完成 pending-restore 时，禁用 Hull/dsh 更新入口（或互斥拒绝 + 文案说明优先级）。

### 4.6 入口与触发（FR-6）

- **仅手动**：设置页新增「数据」区块——备份 / 恢复 / 打开数据目录（既有 `open-data-dir` 按钮迁入并保留原 DOM id，Q-092）。
- 退出时自动备份 / 定时备份 = 延后（U-4）。

### 4.7 路径迁移（FR-7）

- notesDir 外置目录（用户自选的绝对路径）内容**不打包**——manifest 记录原路径提示（notesDirHint）。
- 恢复后原路径不存在 → **不在恢复期弹窗**（启动早期无 BrowserWindow，弹窗阻塞启动，Q-095）：保留本地/默认（`<userData>/notes`），启动完成后在设置页数据卡提示「原笔记目录不存在，点击重选」（复用 `dialog:pickDirectory` + `setSettings`，N4 既有接线）。
- 包内 settings.notesDir 红线校验（Q-090）：校验阶段跑 `isAbsolute` + `forbiddenNotesDirReason`；非法 → 恢复时置为默认目录并记入结果提示（不整包拒绝）。
- Skills 禁用/删除记录（`disabled.json` 的 `originalPath` 为绝对路径）：新机路径不一致时**标注「路径不存在」+ 启用/恢复按钮禁用**，不自动清洗、不自动重映射（Q-084；重映射 v2 候选）。

### 4.8 dsh 数据边界（FR-8）

- **不含 DSH_HOME**（`~/.dsh`，含会话历史；CON-R002 红线——Hull 只读不写）。
- **不含 dsh 本体/运行时**（overlay、node、corepack；CON-R003/R007 随装随建，换机重装即可）。
- DSH_HOME 只读快照导出 = v2 候选（U-1），需明确红线措辞。

### 4.9 合并模式（merge，Q-011/用户决策 2026-09-17）

> 总原则：**不静默覆盖、冲突可见**——所有冲突以恢复结果清单呈现；本地与包内数据都不丢。

| 数据 | 合并语义 |
|:-----|:---------|
| 看板 `kanban/boards.json` | **复用 B5 merge**（`KanbanStore.importData` merge 分支）：先校验后应用、冲突板重 id + 文件内部引用重映射、追加（非幂等，每次追加一份） |
| 笔记 `notes/**` | 文件级：包内文件本地不存在 → 拷入；同名且内容 hash 相同 → 跳过；同名不同内容 → **保留双方**（本地不动，包内版本落 `原名 (恢复冲突 YYYYMMDD-HHmmss).md`）并列入冲突清单 |
| 设置 `settings.json` | 字段级：包内字段覆盖本地同名键；本地独有键保留；`notesDir` 按 §4.7 处理（非法/不存在 → 保留本地值 + 提示） |
| 工作流 `workflows.json` | id 冲突且内容不同 → 重 id 追加为新工作流；内容相同 → 跳过 |
| 通知 `notifications.json` | 追加 + 按 id 去重；沿用既有 ring cap 裁剪 |
| Skills 状态 | 索引并集（路径不存在条目标注不可用）；`skills/trash/` 实体不覆盖（同名跳过） |
| `dismiss.json` | 日期键并集 |

### 4.10 校验规则（FR-10）

- manifest 必填字段校验 + `formatVersion` 区间检查（唯一兼容判据）+ items[] 完整性。
- **关键文件实际可解析**（settings.json / boards.json 顶层结构）——不只校验 JSON 结构（Q-082）。
- **迁移预演**（Q-083）：替换/合并前用 migrate 纯函数对包内 settings/boards 预演迁移，失败 → 整包拒绝（现数据零改动），杜绝「恢复后 boards 被静默重建为空」。
- schemaVersion 高于当前 → 拒绝（不半应用）；低于 → 走迁移链。
- 仅接受校验通过的备份目录。

## 5. 流程与状态

| 流程 | 步骤 | 失败行为 |
|:-----|:-----|:---------|
| 备份 | 门控校验 → flush → 新建 `Hull备份-<ts>/` → 白名单逐项拷贝 → manifest 最后原子写 → 完成提示 | 目标不可写/空间不足 → 报错中止；本次目录 best-effort 删除（删不掉 rename `*.failed-<ts>` 并给路径） |
| 恢复（运行期） | 选目录 → 校验 + 迁移预演 → 选模式（replace/merge）→ 写 `.restore/pending.json` → 提示「立即重启并恢复 / 稍后」 | 校验失败 → 拒绝，现数据零改动 |
| 恢复（启动期） | 读标记 → 预备份 `.bak-<ISO8601 秒>-<n>` → 按模式应用 → 启动校验 → 写 `.restore/result.json` | 任一失败 → 回滚 `.bak` + 结果记录「已回滚」 |
| 崩溃自愈 | 启动早期检测残留（标记/staging/.bak） | 自动继续或回滚（对齐 `UpgradeExecutor.selfHeal` 模式） |
| 结果可见 | 启动后设置页数据卡展示一次结果（成功/失败原因/已回滚到 `.bak-<ts>`） | — |

- v1 无中间态：不做增量备份 / 断点续传 / 后台常驻。

## 6. 异常分支

- 备份目标目录不可写 / 空间不足 → 报错中止，零副作用 + 残留清理（§5）。
- manifest 缺失 / 格式版本不兼容 / 关键文件损坏 / 迁移预演失败 → 拒绝恢复，现数据零改动。
- schemaVersion 高于当前应用支持 → 拒绝（不半应用）；低于 → 走迁移链。
- 恢复过程中崩溃 → 下次启动自愈（继续或回滚）。
- notesDir 原路径不存在 → 保留本地值 + 启动后提示重选（不阻塞）。
- 合并模式下冲突 → 保留双方 + 结果清单（不静默覆盖）。
- 恢复后 dsh 未安装 → 正常引导态（与本功能无关，不互相阻塞）。

## 7. 安全与红线

- **CON-R002 不破**：备份/恢复均不读写 DSH_HOME。
- **CON-R003 不破**：dsh 升级通道独立，备份不含 dsh 本体（Q-077 替换单位不涉及非白名单项）。
- **CON-R005 对齐**：恢复 = staging → 替换 → 验证 → 回滚同构。
- **CON-R004**：备份/恢复能力在主进程实现，渲染层经 preload 桥访问。
- 备份包含设置与看板内容（可能含敏感文本），**不含任何凭据**（FR-2）；包文件落在用户显式选择的目录，由用户自行保管（v1 不做包级加密）。
- 恢复仅接受 manifest 校验通过的备份目录；merge 模式不静默覆盖（冲突可见）。

## 8. 未决项登记

| 编号 | 问题 | 负责人 | 阻断等级 | 状态 | 结论 | 回写位置 |
|:-----|:-----|:-------|:---------|:-----|:-----|:---------|
| U-1 | DSH_HOME 只读快照导出（dsh 会话历史迁移） | PM | P2 | open | — | §4.8（v2 讨论） |
| U-2 | 凭据口令加密包（connections 随包迁移） | PM | P2 | open | — | §4.2（v2 候选） |
| U-3 | 单文件 zip 包形态 | PM | P2 | open | — | §4.3（延后；若做走系统 bsdtar） |
| U-4 | 退出时/定时自动备份 | PM | P2 | open | — | §4.6 |
| U-5 | 看板附件二进制纳入（依赖上传能力 P2 落地） | PM | P2 | open | — | §4.1（能力落地后补白名单） |
| U-6 | Partitions/shell 视图记忆纳入 + 合并模式冲突可视化增强 | PM | P2 | open | — | §4.1/§4.9（v2） |
| U-7 | skills 禁用记录路径自动重映射 | PM | P2 | open | — | §4.7（v2） |

## 9. 扫描待确认项

> **Q-077~Q-100 全部 closed**（2026-09-17，三角色扫描：BE 13 / FE 5 / QA 4；17 条已有答案自动关闭）。结论已全数回写本共识 v1.1（§4.1~§4.10、§11、CON-R-backup-001~016）；载体：飞书 q-item 清单 `dsh-hull-desktop-q-item`。
>
> 关键闭环（P0/语义级）：Q-077 替换单位=白名单逐项 / Q-078 标记落点 `.restore/pending.json` / Q-079 运行期校验+启动期执行 / Q-089 白名单 9→7 / Q-090 notesDir 红线校验 / Q-095 启动后提示重选 / Q-094 结果跨启动可见 / Q-084 skills 路径标注不可用。

## 10. 规则编号（CON-R-backup-001~016）

| 编号 | 规则 | 来源 | 当前结论 | 变更状态 |
|:-----|:-----|:-----|:---------|:---------|
| CON-R-backup-001 | 备份范围 = 用户数据白名单 **7 项**（settings.json / kanban/boards.json / workflows/workflows.json / notes 默认目录+回收站 / notifications + dismiss / skills 状态）；排除可重装产物、派生缓存、**Partitions/shell（Q-089）**、**workflows/runs.json（Q-089）**、executions 日志、logs、Chromium 缓存、瞬态 | 调研 §二 + Q-089 | 生效 | v1.1 修订 |
| CON-R-backup-002 | connections 凭据不进包（safeStorage 绑机器 + OS 用户密钥，异机不可解密）；恢复后重填（v1 四平台） | 调研 §三.1 | 生效 | 稳定 |
| CON-R-backup-003 | 备份形式 = 目录拷贝：所选目录下新建 `Hull备份-YYYYMMDD-HHmmss/`（重名自增）；realpath 校验拒绝目标位于 `<userData>` 内；manifest.json **最后原子写**（完成标记） | Q-080 + Q-081 | 生效 | v1.1 修订 |
| CON-R-backup-004 | 边界 = 不含 DSH_HOME（CON-R002 红线）与 dsh 本体/运行时（CON-R003/R007 可重装） | PRD + 调研 | 生效 | 稳定 |
| CON-R-backup-005 | 一致性：备份前 flush（kanbanStore.flushSync + 各 store 落盘）；门控 `canBackup()`（无执行中/排队任务 + dsh 安装/升级非进行中 + skills 升级非进行中 + Hull 自更新非进行中 + 无 pending-restore），主进程强制校验；dsh 空闲运行不门控 | Q-085 + Q-086 | 生效 | v1.1 修订 |
| CON-R-backup-006 | 恢复双模式 **replace / merge**；**替换单位 = 白名单项集逐项**（`<name>.bak-<ts>`），非白名单（dsh/dsh-previous/node/corepack/Partitions/Singleton*）一律不动；不做静默覆盖 | Q-077 + 用户决策 | 生效 | v1.1 修订 |
| CON-R-backup-007 | 执行时机与原子性：运行期只做校验 + 写 `<userData>/.restore/pending.json` + 提示重启；文件操作在启动早期执行；三态自愈（继续/回滚/清理）；与更新通道互斥（pending-restore 存在时禁用 Hull/dsh 更新入口） | Q-078/079/088 | 生效 | v1.1 修订 |
| CON-R-backup-008 | 路径迁移：notesDir 外置内容不打包（manifest 记原路径）；原路径不存在 → 保留本地值/默认目录 + **启动后数据卡提示重选**（恢复期不弹窗）；skills 路径失效 → 标注「路径不存在」+ 按钮禁用，不自动清洗/重映射 | Q-084/095 + 调研 §三.2 | 生效 | v1.1 修订 |
| CON-R-backup-009 | 入口与触发：设置页「数据」区块（备份/恢复/打开数据目录——既有 open-data-dir 迁入保留原 id）；v1 仅手动触发 | Q-092 + PRD | 生效 | v1.1 修订 |
| CON-R-backup-010 | 校验：manifest + schemaVersion 兼容（高拒低迁）+ **迁移预演**（包内 settings/boards，失败整包拒绝）+ **包内 notesDir 红线校验**（非法→置默认并记提示）；仅接受校验通过的备份目录 | Q-082/083/090 | 生效 | v1.1 修订 |
| CON-R-backup-011 | **合并模式（merge）**：按类合并——看板复用 B5 merge（冲突板重 id + 引用重映射 + 追加）；笔记文件级保留双方（同名不同内容 → 包内版本落 `原名 (恢复冲突 YYYYMMDD-HHmmss).md`）；设置字段级（包内覆盖同名键、本地独有保留）；工作流 id 冲突重 id 追加；通知追加去重；skills 索引并集；dismiss 并集。总原则：不静默覆盖、冲突以结果清单呈现 | 用户决策 2026-09-17 | 生效 | 新增 |
| CON-R-backup-012 | 中间产物与失败清理：预备份命名 `bak-<ISO8601 秒>-<n>`（n 自增防撞）；备份失败 best-effort 删本次目录（删不掉 rename `*.failed-<ts>` 并提示路径）；瞬态过滤含 `*.tmp-*`；ENOENT 重试 1 次后跳过并汇总 warning | Q-081/087 | 生效 | 新增 |
| CON-R-backup-013 | 结果可见性：恢复结果写 `<userData>/.restore/result.json`，启动后设置页数据卡展示一次（成功 / 失败原因 / 已回滚到 `.bak-<ts>`）；恢复确认提供「立即重启并恢复 / 稍后」 | Q-094 | 生效 | 新增 |
| CON-R-backup-014 | IPC：新增 `hull:backup` / `hull:restore` / `hull:getBackupStatus`（入 BACKUP_IPC_CHANNELS + ALL 清单）；挂 `window.hull.*`；返回统一 `{ok, code?, message?, data?}`；e2e 预留显式路径参数（仅 `HULL_E2E=1` 生效） | Q-091/097 | 生效 | 新增 |
| CON-R-backup-015 | UI 交互：进度 spinner + 结果 toast；v1 不提供取消；失败提示含目标路径 + 重试；成功固定两条免责文案（不含凭据 / 外置笔记与运行记录不随包）；错误码 kebab（backup-target-unwritable / backup-failed / restore-manifest-invalid / restore-version-newer / restore-verify-failed / restore-rolled-back） | Q-093/096 | 生效 | 新增 |
| CON-R-backup-016 | 测试与验收：状态机纯函数单测 + 临时目录 integration（只读/ENOSPC/EXDEV/版本拒绝/半成品）+ e2e 三条（happy / 高版本拒绝 / 半成品自愈）+ 合并场景用例；验收 4 条断言（备份含 7 项 + manifest 齐全且不含 dsh/Cache/token-buckets；恢复后 settings/boards 生效 + `.bak` 存在；拒绝时现数据 hash 不变；半成品自愈回滚） | Q-098/099/100 | 生效 | 新增 |

## 11. 页面交互规范

| 页面/组件 | 角色 | 功能 | 权限 | 数据范围 |
|:----------|:-----|:-----|:-----|:---------|
| 设置页「数据」区块（笔记卡之后） | 用户 | 备份（选目标目录）/ 恢复（选备份目录 + 选模式 replace/merge）/ 打开数据目录（原 open-data-dir 迁入保留 id）/ 最近一次备份时间 | 全量 | 本机 userData + 用户选定目录 |
| 备份进度与结果 | 用户 | spinner + 结果 toast；失败含目标路径 + 重试；成功含两条免责文案；v1 无取消 | 全量 | — |
| 恢复确认与重启 | 用户 | 校验通过后弹「立即重启并恢复 / 稍后（下次启动自动执行）」 | 全量 | — |
| 恢复结果卡 | 用户 | 启动后展示一次：成功 / 失败原因 / 已回滚到 `.bak-<ts>` | 全量 | — |
| 笔记目录重定位提示 | 用户 | 原 notesDir 不存在时提示「重新选择笔记目录」（复用 dialog:pickDirectory） | 全量 | 用户自选目录 |

## 12. 不做事项

- 跨机自动同步 / 云备份 / 定期自动备份（v1 仅手动，U-4）；
- 凭据导出（v2 候选 U-2）；
- DSH_HOME 迁移（红线 CON-R002；只读快照 v2 才讨论 U-1）；
- dsh 本体/node/corepack 打包（可重装，CON-R003/R007）；
- 备份包加密（包内不含凭据；由用户自行保管）；
- 增量/断点续传/后台常驻服务；
- 合并模式的字段级冲突选择 UI（v1 冲突以结果清单呈现 + 保留双方；可视化增强 v2，U-6）。

## 13. 依赖与复用

- **入口复用**：`hull:openDataDir`、`dialog:pickDirectory`、`hull:openPath`（无新 IPC 风险面）；
- **看板合并复用**：`KanbanStore.importData` merge 分支（B5 已验证：冲突板重 id + 引用重映射 + 先校验后应用）；
- **原子写复用**：`SkillFsOps.writeFileSyncAtomic`、`KanbanTransfer.writeExportFile` 模式；
- **自愈/迁移复用**：`UpgradeExecutor.selfHeal`（崩溃窗口恢复）、`SettingsProvider.migrate`、`KanbanStore.migrate`；
- **笔记冲突语义复用**：CON-R-notes-002（保存冲突分流/冲突不覆盖）；
- **测试隔离**：`HULL_USER_DATA` 环境变量 + `HULL_E2E=1` 显式路径参数。

## 14. 子需求清单

> **Gate B 通过（2026-09-17）**：按 v1.1 范围（含合并模式）拆解 5 个子需求；ticket 已落 `dsh-hull-desktop` 清单（Todo 列）；实现顺序 B1 → B2 → B3 → B4 → B5。

| # | 子需求 | 验收标准（可测试，摘要） | 规则绑定 | 依赖 | 来源 PRD | ticket |
|:--|:-------|:-------------------------|:---------|:-----|:---------|:-------|
| B1 | 备份引擎与门控 | 门控 canBackup() 主进程强制 + flush 清单 + `Hull备份-<ts>/` 形态 + 7 项白名单 + manifest 最后原子写 + 失败清理 | CON-R-backup-001/002/003/005/012 | 无 | backup PRD | de822069 |
| B2 | 恢复引擎·替换模式（replace） | 运行期校验+标记 → 启动期逐项 `.bak` 替换 → 迁移校验 → 失败回滚；非白名单不动；拒绝零改动 | CON-R-backup-006/007/010/012/013 | B1 | backup PRD | ad2107c8 |
| B3 | 恢复引擎·合并模式（merge） | 按类合并（看板复用 B5 merge / 笔记保留双方 / 设置字段级 / 工作流重 id / 通知去重 / skills 并集 / dismiss 并集）+ 冲突清单 | CON-R-backup-011 | B2 | backup PRD | 880c8f7d |
| B4 | 设置页「数据」区块与 IPC | 3 IPC 通道入清单 + 数据区块（含模式选择）+ 交互/错误码/结果卡/重定位提示 | CON-R-backup-009/014/015 | B1/B2/B3 | backup PRD | ec42ce2d |
| B5 | 测试与验收（双模式） | 单测 + integration + e2e 三路径 + 合并用例 + 4 条断言 | CON-R-backup-016 | B1~B4 | backup PRD | 32ee28bc |

> ticket 描述 = 验收点快照 + 指针（「依据：共识 v1.1 §X；冲突时以共识为准」）；共识变更时只改共识正文，不回写历史 ticket 快照。

## 15. 附录

### 15.1 关联

- PRD（docs/prd/2026-09-11-backup-prd.md）、调研（docs/research/2026-09-17-backup调研.md）、规则索引（docs/spec/规则索引.md）、M1 共识（CON-R002/CON-R003/CON-R005 引用）、M2 看板共识（B5 merge 复用）。

### 15.2 版本记录

| 版本 | 日期 | 变更摘要条目 | 说明 |
|:-----|:-----|:-------------|:-----|
| v1.1 | 2026-09-17 | 已登记（已发布） | 扫描 Q-077~Q-100 全数闭环回写：替换单位改白名单逐项、白名单 9→7、运行期校验+启动期执行、notesDir 启动后提示重选、结果跨启动可见、skills 路径标注不可用；**新增合并模式（merge）**（用户决策）；新增 CON-R-backup-011~016；U-6/U-7 登记 |
| v1.0 | 2026-09-17 | 已登记（已发布） | 首次建立：从 backup PRD + 调研提取；登记 CON-R-backup-001~010、U-1~U-5；7 项决策用户确认 |

### 15.3 后续规划

| 项 | 状态 | 说明 |
|:---|:-----|:-----|
| 子需求拆解 + 契约 + 判级/设计 | 进行中 | 本次实现启动：拆解（含 merge）→ 契约 → 技术方案 → 实现管道 |
| DSH_HOME 只读快照 | 排后（U-1） | 红线措辞需明确 |
| 凭据口令加密包 | 排后（U-2） | 需口令 UX + 弱 keyring 风险提示 |
| 单文件 zip 包 | 排后（U-3） | 走系统 bsdtar |
| 自动/定时备份 | 排后（U-4） | — |
| 附件二进制纳入 | 排后（U-5） | 依赖附件上传能力（P2）落地 |
| Partitions/shell 视图记忆 + 合并冲突可视化 | 排后（U-6） | v2 |
| skills 禁用记录路径自动重映射 | 排后（U-7） | v2 |
