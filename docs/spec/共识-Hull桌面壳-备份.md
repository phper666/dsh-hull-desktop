# Hull 桌面壳（数据备份与恢复）共识文档

> 版本：v1.0 · 更新：2026-09-17 · 维护者：phper666（PM） · 状态：已发布
> 数据来源：Hull Backup PRD（docs/prd/2026-09-11-backup-prd.md）+ 调研（docs/research/2026-09-17-backup调研.md）+ 用户决策 2026-09-17（7 项待拍板全按调研推荐定案）
> 关联：新增需求；需求标识 `backup`（PRD slug）；本模块不涉及多期拆分

## 1. 文档元信息

- **本版本变更**：v1.0 首次建立——从 backup PRD + 调研结论提取整理为业务事实源；登记 CON-R-backup-001~010、U-1~U-5。
- **历史变更摘要**：无（首版）。
- **状态说明**：v1.0 已发布（用户 2026-09-17 确认 7 项决策）。**三角色扫描未跑、子需求未拆解**——用户决策「落共识，暂不开实现」，扫描/契约/实现随实现启动时补（顺序仍为 扫描 → 契约）。

## 2. 文档结构总览

- **覆盖**：Hull 用户数据的备份（导出）与恢复（导入）全部业务面——备份范围白名单、凭据边界、备份形式、一致性、恢复语义与原子性、路径迁移、入口与触发、校验规则。
- **适用范围**：Hull 壳自有用户数据（`<userData>` 内白名单 + notes 默认目录）；**不覆盖** dsh 本体与运行时（CON-R003/R007 通道独立，可重装）、DSH_HOME 用户数据（CON-R002 红线）、connections 凭据（safeStorage 机器绑定，不可迁移）。
- **不做事项**（详见 §12）：跨机自动同步 / 云备份；字段级 merge 与选择性恢复；凭据导出；DSH_HOME 迁移。

## 3. 领域术语表

| 术语 | 定义 | 出处 |
|:-----|:-----|:-----|
| 用户数据 | 用户创作或用户意图产生的数据：设置偏好、看板 boards.json、工作流定义、笔记 md、通知记录、Skills 禁用/删除状态等 | 调研 §二 |
| 派生数据 | 可从其他数据重建的数据：token 桶缓存、skills 哈希缓存、执行日志、Chromium 缓存 | 调研 §二 |
| 可重装产物 | 可通过网络重装的运行时文件：`dsh/` overlay、`node/`、`corepack/`（CON-R003/R007 通道） | 调研 §二 |
| 备份包 | 导出产物 = 用户选定目录下的一份数据副本 + `manifest.json`（v1 为目录形态，非压缩包） | PRD §目标 |
| manifest.json | 备份包的元信息文件：格式版本、导出时间、应用版本、项清单、notes 原路径提示 | 调研 §一 |
| 预备份（.bak-&lt;ts&gt;） | 恢复前对现有数据整目录改名保留的兜底副本；恢复失败/启动自愈时回滚来源 | 调研 §四 |
| 重定位 | 恢复时 notesDir 原路径在新机器不存在 → 用户重新选择笔记目录（或回默认目录） | 调研 §三.2 |

## 4. 功能需求（PRD + 调研提取）

### 4.1 备份范围（FR-1）

- **白名单（实测 ≈364KB，9 项）**：
  | 项 | 路径 | 性质 |
  |:---|:-----|:-----|
  | 设置 | `settings.json` | 用户偏好（含 notesDir/theme/packageManager/notifPrefs） |
  | 看板 | `kanban/boards.json` | 用户内容（boards/columns/tasks/timeline/comments） |
  | 工作流定义 | `workflows/workflows.json` | 用户内容 |
  | 笔记 | `notes/**/*.md`（notesDir 默认目录内） | 用户内容（可外置，见 4.7） |
  | 笔记回收站 | `notes/trash.json` + `notes/.trash/` | 用户内容 |
  | Skills 状态 | `skills/disabled.json`、`skills/trash.json`、`skills/trash/` | 用户意图（禁用/删除过哪些 skill） |
  | 通知记录 | `notifications/notifications.json` | 派生但有状态价值（未读等） |
  | 免打扰 | `dismiss.json` | 时效性标记 |
  | 视图偏好 | `Partitions/shell/`（渲染层 localStorage） | 用户偏好（可选纳入） |
- **排除**（可重装 / 派生 / 瞬态）：`dsh/`、`dsh-previous/`、`node/`、`corepack/`；`Cache/`、`Code Cache/`、`GPUCache/`、`Dawn*Cache/`、`IndexedDB/`；`token-buckets.json`；`skills/hash-cache.json`、`skills/remote-sig-cache.json`；`kanban/executions/*.log`；`logs/`；`*-staging/`、`*.tmp`、`*.bak-<ts>`、`*.corrupt-<ts>`；更新器缓存（userData 外，启动重建）。
- 依据：调研 §二（本机实测：userData 总量 1.2GB，其中用户数据仅 ≈364KB）。

### 4.2 凭据边界（FR-2）

- `connections/connections.json` **不进备份包**：safeStorage 加密绑机器 + OS 用户密钥（macOS Keychain / Windows DPAPI / Linux 钱包），异机必然无法解密，原样拷贝 = 无效资产。
- 恢复后在「工作台连接」重新填写（v1 仅 4 平台：SF/阿里云短信/腾讯云短信/SMTP）。
- 「用户口令重新加密的凭据包」为 v2 候选（U-2）。

### 4.3 备份形式（FR-3）

- **v1 = 目录拷贝**：导出到用户选定文件夹，目录根部写入 `manifest.json`（格式版本 / 导出时间 / 应用版本 / 项清单 / notes 原路径提示）。
- 单文件 zip 包延后（U-3）；若后续要做，走系统自带 bsdtar（mac / win10+ / linux），不引入第三方压缩依赖。

### 4.4 备份一致性（FR-4）

- 备份前先 flush 各 store（settings / kanban / notes / workflows 均为 temp+rename 原子写，拷贝到的是完整文件）。
- 存在执行中任务时禁用备份按钮并提示「建议退出 Hull 后备份」（执行日志为追加流式写，可能截断；该数据本身已排除）。

### 4.5 恢复语义（FR-5）

```
选择备份目录 → 校验（manifest + schemaVersion 兼容）
  → 现数据整目录 rename 为 <name>.bak-<ts>（预备份）
  → 备份内容换入 userData
  → 启动校验（settings/boards 可解析 + 跑 schema 迁移）
  → 失败 → rename 回 .bak-<ts>（现数据零改动原则）
```

- **全量替换**，不做字段级 merge、不做选择性恢复。
- 恢复后按 `schemaVersion` 跑迁移链（对齐 `SettingsProvider.migrate` / `KanbanStore.migrate` 既有机制）。
- 要求应用未运行：写 `pending-restore` 标记 → 重启后启动早期执行（与 dsh 升级 staging→替换→验证→回滚同构，CON-R005）。

### 4.6 入口与触发（FR-6）

- **仅手动**：设置页新增「数据」区块——备份 / 恢复 / 打开数据目录（后者复用既有 `hull:openDataDir`）。
- 退出时自动备份 / 定时备份 = 延后（U-4）。

### 4.7 路径迁移（FR-7）

- notesDir 外置目录（用户自选的绝对路径）内容**不打包**——manifest 记录原路径提示。
- 恢复时原路径不存在 → 弹**重定位**对话框（复用 `dialog:pickDirectory`）或回默认目录 `<userData>/notes`；不阻塞其余数据恢复。
- Skills 禁用/删除状态（`disabled.json` 的 `originalPath` 为绝对路径）：新机器 home 布局一致可直接生效；不一致时按「原路径不存在」降级（提示手动处理），不静默改写。

### 4.8 dsh 数据边界（FR-8）

- **不含 DSH_HOME**（`~/.dsh`，含会话历史；CON-R002 红线——Hull 只读不写）。
- **不含 dsh 本体/运行时**（overlay、node、corepack；CON-R003/R007 随装随建，换机重装即可）。
- DSH_HOME 只读快照导出 = v2 候选（U-1），需明确红线措辞。

## 5. 流程与状态

| 流程 | 步骤 | 失败行为 |
|:-----|:-----|:---------|
| 备份 | 入口 → flush → 白名单拷贝 → manifest 生成 → 完成提示 | 目标目录不可写 → 报错中止；现数据不动 |
| 恢复 | 选目录 → 校验 → 预备份 → 替换 → 启动校验 → 完成 | 校验失败 → 拒绝，现数据零改动；替换后校验失败 → 回滚 .bak-<ts> |
| 崩溃自愈 | 启动早期检测残留（pending-restore / .bak-<ts> + 新数据不完整） | 自动回滚（对齐 `UpgradeExecutor.selfHeal` 模式） |

- v1 无中间态：不做增量备份 / 断点续传 / 后台常驻。

## 6. 异常分支

- 备份目标目录不可写 / 空间不足 → 报错中止，零副作用。
- manifest 缺失 / 格式版本不兼容 / 文件损坏 → 拒绝恢复，现数据零改动。
- schemaVersion 高于当前应用支持 → 拒绝（不半应用）；低于 → 走迁移链。
- 恢复过程中崩溃 → 下次启动自愈回滚。
- notesDir 原路径不存在 → 重定位或回默认（不阻塞）。
- 恢复后 dsh 未安装 → 正常引导态（与本功能无关，不互相阻塞）。

## 7. 安全与红线

- **CON-R002 不破**：备份/恢复均不读写 DSH_HOME。
- **CON-R003 不破**：dsh 升级通道独立，备份不含 dsh 本体。
- **CON-R005 对齐**：恢复 = staging → 替换 → 验证 → 回滚同构。
- **CON-R004**：备份/恢复能力在主进程实现，渲染层经 preload 桥访问。
- 备份包含设置与看板内容（可能含敏感文本），**不含任何凭据**（FR-2）；包文件落在用户显式选择的目录，由用户自行保管（v1 不做包级加密）。
- 恢复仅接受 manifest 校验通过的备份目录，不接受任意目录任意覆盖（防误操作）。

## 8. 未决项登记

| 编号 | 问题 | 负责人 | 阻断等级 | 状态 | 结论 | 回写位置 |
|:-----|:-----|:-------|:---------|:-----|:-----|:---------|
| U-1 | DSH_HOME 只读快照导出（dsh 会话历史迁移） | PM | P2 | open | — | §4.8（v2 讨论） |
| U-2 | 凭据口令加密包（connections 随包迁移） | PM | P2 | open | — | §4.2（v2 候选） |
| U-3 | 单文件 zip 包形态 | PM | P2 | open | — | §4.3（延后；若做走系统 bsdtar） |
| U-4 | 退出时/定时自动备份 | PM | P2 | open | — | §4.6 |
| U-5 | 看板附件二进制纳入（依赖上传能力 P2 落地） | PM | P2 | open | — | §4.1（能力落地后补白名单） |

## 9. 扫描待确认项

> 未跑：本次只落共识基线，三角色扫描随实现启动时补（顺序仍为 扫描 → 契约）。届时本表登记 Q-items 及结论。

## 10. 规则编号（CON-R-backup-001~010）

| 编号 | 规则 | 来源 | 当前结论 | 变更状态 |
|:-----|:-----|:-----|:---------|:---------|
| CON-R-backup-001 | 备份范围 = 用户数据白名单（9 项，实测 ≈364KB）：settings.json / kanban/boards.json / workflows/workflows.json / notes（默认目录内 + 回收站）/ notifications + dismiss / skills 状态 / 视图偏好；排除可重装产物（dsh/dsh-previous/node/corepack）、派生缓存（token-buckets、skills 哈希/远端缓存、executions 日志、Chromium 缓存）、瞬态（staging/tmp/bak/corrupt）、logs、更新器缓存 | 调研 §二（本机实测） | 生效 | 稳定 |
| CON-R-backup-002 | connections 凭据不进包：safeStorage 加密绑机器 + OS 用户密钥，异机不可解密；恢复后用户在「工作台连接」重填（v1 四平台） | 调研 §三.1 | 生效 | 稳定 |
| CON-R-backup-003 | 备份形式 = 目录拷贝 + manifest.json（格式版本/导出时间/应用版本/项清单/notes 原路径提示）；单文件 zip 延后，若做走系统 bsdtar 不引依赖 | PRD §形式 + 调研 §一 | 生效 | 稳定 |
| CON-R-backup-004 | 边界 = 不含 DSH_HOME（CON-R002 红线）与 dsh 本体/运行时（CON-R003/R007 可重装）；DSH_HOME 会话历史迁移仅作为 v2 候选讨论 | PRD §边界 + 调研 §三.3 | 生效 | 稳定 |
| CON-R-backup-005 | 备份一致性：备份前 flush 各 store；存在执行中任务时禁用备份并提示「建议退出后备份」 | 调研 §三.4 | 生效 | 稳定 |
| CON-R-backup-006 | 恢复 = 全量替换（不做字段级 merge/选择性恢复）：校验通过后现数据 rename 为 `.bak-<ts>` 预备份 → 换入 → 失败回滚；校验失败拒绝且现数据零改动 | PRD §继承语义 + 调研 §四 | 生效 | 稳定 |
| CON-R-backup-007 | 恢复原子性与自愈：写 `pending-restore` 标记 → 重启后启动早期执行；恢复后按 schemaVersion 跑迁移链；崩溃残留下次启动自愈回滚（对齐 CON-R005 / UpgradeExecutor.selfHeal） | 调研 §四 | 生效 | 稳定 |
| CON-R-backup-008 | notesDir 外置目录内容不打包（manifest 记原路径提示）；恢复时路径不存在 → 重定位弹窗（复用 dialog:pickDirectory）或回默认目录，不阻塞其余数据 | 调研 §三.2 | 生效 | 稳定 |
| CON-R-backup-009 | 入口与触发：设置页「数据」区块（备份/恢复/打开数据目录）；v1 仅手动触发，自动/定时备份延后 | PRD §触发 | 生效 | 稳定 |
| CON-R-backup-010 | 恢复校验 = manifest 校验 + schemaVersion 兼容检查（高于当前 → 拒绝不半应用；低于 → 走迁移链）；仅接受校验通过的备份目录，防误覆盖 | 调研 §四 | 生效 | 稳定 |

## 11. 页面交互规范

| 页面/组件 | 角色 | 功能 | 权限 | 数据范围 |
|:----------|:-----|:-----|:-----|:---------|
| 设置页「数据」区块 | 用户 | 备份（选目标目录）/ 恢复（选备份目录）/ 打开数据目录 | 全量 | 本机 userData + 用户选定目录 |
| 重定位对话框 | 用户 | notesDir 原路径不存在时重新选择笔记目录（或回默认） | 全量 | 用户自选目录 |
| 备份/恢复进度与结果提示 | 用户 | 进行中状态、成功/失败原因 | 全量 | — |

## 12. 不做事项

- 跨机自动同步 / 云备份 / 定期自动备份（v1 仅手动，U-4）；
- 字段级 merge / 选择性恢复（v1 全量替换）；
- 凭据导出（v2 候选 U-2）；
- DSH_HOME 迁移（红线 CON-R002；只读快照 v2 才讨论 U-1）；
- dsh 本体/node/corepack 打包（可重装，CON-R003/R007）；
- 备份包加密（包内不含凭据；由用户自行保管）；
- 增量/断点续传/后台常驻服务。

## 13. 依赖与复用

- **入口复用**：`hull:openDataDir`、`dialog:pickDirectory`、`hull:openPath`（无新 IPC 风险面）；
- **原子写复用**：`SkillFsOps.writeFileSyncAtomic`、`KanbanTransfer.writeExportFile` 模式；
- **自愈/迁移复用**：`UpgradeExecutor.selfHeal`（崩溃窗口恢复）、`SettingsProvider.migrate`、`KanbanStore.migrate`；
- **回收站模式复用**（如需"恢复前自动备份"）：`TrashManager` / `NotesTrash`；
- **测试隔离**：`HULL_USER_DATA` 环境变量（e2e 用独立 userData 目录）。

## 14. 子需求清单

> **待拆解**——用户决策「落共识，暂不开实现」；实现启动时补：扫描 → 子需求拆解（Gate B）→ 契约。

## 15. 附录

### 15.1 关联

- PRD（docs/prd/2026-09-11-backup-prd.md）、调研（docs/research/2026-09-17-backup调研.md）、规则索引（docs/spec/规则索引.md）、M1 共识（CON-R002/CON-R003/CON-R005 引用）。

### 15.2 版本记录

| 版本 | 日期 | 变更摘要条目 | 说明 |
|:-----|:-----|:-------------|:-----|
| v1.0 | 2026-09-17 | 已登记（已发布） | 首次建立：从 backup PRD + 调研（含本机实测数据盘点）提取；登记 CON-R-backup-001~010、U-1~U-5；7 项决策用户确认（凭据不进包/目录拷贝/不含 DSH_HOME/外置笔记重定位/含通知与视图偏好排除日志/全量替换加预备份/仅手动备份） |

### 15.3 后续规划

| 项 | 状态 | 说明 |
|:---|:-----|:-----|
| 三角色扫描 + 子需求拆解 | 待实现启动 | 顺序固定：扫描 → 契约；本共识已就绪可作扫描输入 |
| DSH_HOME 只读快照 | 排后（U-1） | 红线措辞需明确 |
| 凭据口令加密包 | 排后（U-2） | 需口令 UX + 弱 keyring 风险提示 |
| 单文件 zip 包 | 排后（U-3） | 走系统 bsdtar |
| 自动/定时备份 | 排后（U-4） | — |
| 附件二进制纳入 | 排后（U-5） | 依赖附件上传能力（P2）落地 |
