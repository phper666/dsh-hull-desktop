# Hull 桌面壳数据备份与恢复接口契约

## 契约信息

- 载体：飞书任务清单 `dsh-hull-desktop`（子需求：B1 `de822069` / B2 `ad2107c8` / B3 `880c8f7d` / B4 `ec42ce2d` / B5 `32ee28bc`）
- 需求标识：`backup`
- 契约状态：**已冻结**（2026-09-17；冻结 = 全部接口行已冻结）
- 适用版本：Hull ≥ 0.1.9
- 最后更新：2026-09-17
- OpenAPI：**不适用**——本契约覆盖桌面壳本地 IPC（Electron main ↔ renderer），无 HTTP API 面
- 依据：共识 `docs/spec/共识-Hull桌面壳-备份.md` v1.1 · 技术方案 `docs/design/B-备份-backup-design.md`（已冻结）

## 需求与共识追踪

| 能力 | 子需求 | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| 备份（导出：门控/flush/白名单 7 项/manifest 最后原子写/失败清理） | B1 | CON-R-backup-001/002/003/005/012 | B1 ①~⑤（ticket） | `hull:backup` | 已冻结 |
| 恢复：运行期校验+标记 → 启动期执行（replace） | B2 | CON-R-backup-006/007/010/012/013 | B2 ①~④ | `hull:restore` | 已冻结 |
| 恢复：合并模式（merge，按类语义 + 冲突清单） | B3 | CON-R-backup-011 | B3 ①~③ | `hull:restore` | 已冻结 |
| 设置页「数据」区块 + 状态查询 | B4 | CON-R-backup-009/014/015 | B4 ①~④ | `hull:getBackupStatus` | 已冻结 |
| 测试与验收（单测/integration/e2e + 5 条断言） | B5 | CON-R-backup-016 | §联调与测试场景 | —（测试面） | 已冻结 |

## 范围与非目标

### 范围

- 备份：白名单 7 项 → `Hull备份-YYYYMMDD-HHmmss/` 目录包 + `manifest.json`（含门控、flush 一致性、失败清理）。
- 恢复：`replace` / `merge` 双模式；运行期（校验 + 迁移预演 + 写标记 + 提示重启）与启动期（预备份 → 应用 → 复校验 → 结果/回滚/自愈）两段式。
- 入口：设置页「数据」区块 + 4 个 IPC 通道（`hull:backup` / `hull:restore` / `hull:getBackupStatus` / `hull:restart`）。

### 非目标

- 凭据迁移（CON-R-backup-002，safeStorage 机器绑定，恢复后重填）；
- DSH_HOME 与 dsh 本体/运行时（CON-R-backup-004 红线）；
- 单文件 zip 包 / 自动备份 / 包加密 / 增量续传（U-3/U-4）；
- 合并模式的字段级冲突选择 UI（v1 冲突以结果清单呈现，U-6）；
- 跨机同步/云备份。

## 业务流程与状态

### 核心流程

```text
备份：用户点「备份」-> canBackup 门控 -> flush(kanban.flushSync + stores) -> 新建 Hull备份-<ts>/
      -> 白名单逐项拷贝（正列举） -> manifest.json 最后原子写 -> 完成提示（两条免责文案）

恢复（运行期，零数据副作用）：选包目录 -> parseManifest/兼容性/关键文件可解析/迁移预演/notesDir 红线
      -> 写 .restore/pending.json(step=requested, phase=forward) -> 提示「立即重启并恢复 / 稍后」

恢复（启动早期）：decideHeal -> staged(拷包入 incoming) -> backedUp(逐项 rename 为 .restore/backup/<rel>)
      -> applied(replace: 换入 / merge: reset 后按类合并) -> verified(复校验)
      -> 写 .restore/result.json + 清标记；任一步失败 -> phase=rolling-back -> 逐项回滚 -> result(rolledBack)
```

### 状态转换（`.restore/pending.json` 的 `step`/`phase`）

| 当前状态 | 动作 | 目标状态 | 前置条件 | 冲突行为 | 依据 |
|---|---|---|---|---|---|
| requested(forward) | 启动执行 | staged | 包目录存在且校验已过 | 包缺失 → failed(`restore-source-missing`)，现数据零改动 | CON-R-backup-007 |
| staged(forward) | 预备份 | backedUp | incoming 完整 | incoming 缺失/不完整 → 重做 staging，二次失败 → rollback | 007/012 |
| backedUp(forward) | 应用 | applied | 各项目标已备（源缺+目标在=已完成） | — | 006/011 |
| applied(forward) | 复校验 | verified | — | 校验失败 → rolling-back | 010 |
| verified(forward) | 收尾 | 标记清除 + result(success) | — | — | 013 |
| 任一(forward) | 任一步抛错 | rolling-back | — | 逐项回滚 → result(rolledBack/failed) | 007 |
| rolling-back | 续做回滚 | 标记清除 + result | — | 现场不可判定（既不在原位也不在备） → manual(failed) | 007/012 |

## 接口清单

> 均为 Electron IPC（`ipcRenderer.invoke` ↔ `ipcMain.handle`）；统一返回 `IpcResult<T> = {ok, code?, message?, data?}`。本表为导航摘要，字段细节见「接口详情」。
> 通道常量入 `src/shared/ipc-channels.ts` 的 `BACKUP_IPC_CHANNELS` 并加入 `ALL_IPC_CHANNELS`（CON-R-backup-014）。

| # | 状态 | 通道 | 用途 | 权限 | 幂等 |
|---|---|---|---|---|---|
| 1 | 已冻结 | `hull:backup` | 执行备份 / 清理旧备份 | 渲染层经 preload 桥（`window.hull.backup`）；仅本机 | 每次新建目录（天然幂等） |
| 2 | 已冻结 | `hull:restore` | 请求恢复（request）/ 取消（cancel） | 同上 | request 覆盖写标记；cancel 幂等 |
| 3 | 已冻结 | `hull:getBackupStatus` | 读取门控/待恢复/最近结果/备份目录 | 同上 | 只读 |
| 4 | 已冻结 | `hull:restart` | 重启应用以执行待恢复（仅 pending 存在且无更新/执行在途时允许） | 同上 | 幂等（无 pending 时拒绝） |
| 复用 | 已存在 | `dialog:pickDirectory` / `hull:openDataDir` / `hull:openPath` | 目标/包目录选择；打开数据目录 | 既有 | 既有 |

## Schema 与枚举

### Manifest（备份包根 `manifest.json`）

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|:---:|:---:|---|---|---|
| `manifestVersion` | number | 是 | 否 | 整数 ≥1；当前 `1` | — | 包格式版本，唯一兼容判据 |
| `appVersion` | string | 是 | 否 | semver | — | 导出时 Hull 版本（"请升级到 ≥X"） |
| `platform` | `'darwin'\|'win32'\|'linux'` | 是 | 否 | 枚举 | — | 仅提示 |
| `exportedAt` | string | 是 | 否 | ISO8601 | — | 展示/排序 |
| `notesDirHint` | string | 是 | 否 | 绝对路径 | 含用户名路径（提示用） | 原 notesDir，不写盘 |
| `items[]` | `ManifestItem[]` | 是 | 否 | ≥1 | — | 见下 |
| `counts` | `{files:number,bytes:number}` | 是 | 否 | 与 items 合计一致 | — | 校验用 |

### ManifestItem

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|:---:|---|---|
| `id` | `ScopeItemId` | 是 | 枚举（7 项） | 白名单项 |
| `path` | string | 是 | 包内相对路径，`/` 分隔 | — |
| `kind` | `'file'\|'tree'` | 是 | 枚举 | — |
| `version` | number \| null | 是 | 对应数据文件 schema 版本 | settings=4 / boards=2 / workflows=1 / notifications=1 / 其余 null |
| `size` | number | 是 | ≥0 | 字节合计 |
| `fileCount` | number | 是 | ≥0 | 文件数 |

### PendingFile（`<userData>/.restore/pending.json`）

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|:---:|---|---|
| `version` | `1` | 是 | 常量 | 结构版本 |
| `mode` | `'replace'\|'merge'` | 是 | 枚举 | 恢复模式 |
| `phase` | `'forward'\|'rolling-back'` | 是 | 枚举 | 自愈判定关键位 |
| `step` | `RestoreStep` | 是 | 枚举 | 最后完成步 |
| `sourceDir` | string | 是 | 绝对路径 | 备份包根 |
| `items` | `ScopeItemId[]` | 是 | ≥1 | 本次涉及的项 |
| `createdAt` | string | 是 | ISO8601 | — |
| `failAt` | string \| null | 是 | 生产恒 null | e2e 注入点 |

### RestoreResult（`<userData>/.restore/result.json`）

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|:---:|---|---|
| `version` | `1` | 是 | 常量 | — |
| `mode` | `'replace'\|'merge'` | 是 | 枚举 | — |
| `status` | `'success'\|'rolledBack'\|'failed'` | 是 | 枚举 | 结果可见 |
| `finishedAt` | string | 是 | ISO8601 | — |
| `bakDir` | string \| null | 是 | 绝对路径 | `.restore/backup`（人工兜底入口） |
| `notices[]` | `{code,message}[]` | 是 | 如 `notes-dir-fallback` | 用户可见提示 |
| `merge` | `MergeReport \| null` | 是 | merge 模式填 | 合并报告 |
| `error` | `{code,message} \| null` | 是 | failed 时填 | — |

### MergeReport / ConflictEntry

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `classes` | `Record<ConflictKind,{added,updated,skipped}>` | 是 | 按类统计 |
| `conflicts[]` | `ConflictEntry[]` | 是 | 冲突清单（不静默覆盖） |
| `notices[]` | `{code,message}[]` | 是 | — |

`ConflictEntry`：`kind: 'note'|'kanban'|'workflow'|'skill'|'setting'|'notif'`、`path?/id?`、`resolution: 'renamed'|'appended'|'kept-local'|'overwritten'|'missing-path'|'skipped-identical'`、`detail?`。

### BackupStatus / GateResult

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `canBackup` | `GateResult` | 是 | `{ok:boolean, code?, message?}` |
| `canRestore` | `GateResult` | 是 | 同上 |
| `pending` | `{mode,sourceDir,createdAt} \| null` | 是 | 待恢复标记摘要 |
| `lastResult` | `RestoreResult \| null` | 是 | 最近一次恢复结果 |
| `lastBackupDir` | string \| null | 是 | 最近备份目录（渲染层持久化） |
| `restoreBackupDir` | string \| null | 是 | 活跃 `.restore/backup`（仅恢复进行中存在；成功后归档为 `backup-<ts>/`，路径由 `result.bakDir` 指向） |

### 枚举与状态

| 类型 | 值 | 含义 | 可用于请求 | 可出现在响应 |
|---|---|---|---|:---:|
| `ScopeItemId` | `settings` / `kanban` / `workflows` / `notes` / `notes-trash` / `skills` / `notifs` | 白名单 7 项 | 是（内部） | 是 |
| `RestoreStep` | `requested` / `staged` / `backedUp` / `applied` / `verified` | 启动期推进步 | 否 | 是 |
| `RestorePhase` | `forward` / `rolling-back` | 正向/回滚 | 否 | 是 |
| `mode` | `replace` / `merge` | 恢复模式 | 是 | 是 |
| `status` | `success` / `rolledBack` / `failed` | 恢复结果 | 否 | 是 |
| `Resolution` | `renamed` / `appended` / `kept-local` / `overwritten` / `missing-path` / `skipped-identical` | 冲突处置 | 否 | 是 |

### 错误码（kebab；UI 可见 6 = 共识 CON-R-backup-015）

| 错误码 | 层 | UI 展示 | 触发条件 | 渲染层处理 | 可重试 |
|---|---|---|---|:---:|
| `backup-target-unwritable` | 备份 | 直接 | 目标不可写/空间不足 | 提示路径 + 重试入口 | 是 |
| `backup-failed` | 备份 | 直接 | 拷贝/写盘失败（含 ENOSPC） | 提示 + 重试 | 是 |
| `restore-manifest-invalid` | 恢复·运行期 | 直接 | manifest 缺失/损坏/结构非法 | 提示更换包目录 | 否 |
| `restore-version-newer` | 恢复·运行期 | 直接 | `manifestVersion` 或数据版本高于当前 | 提示升级 Hull 到 ≥appVersion | 否 |
| `restore-verify-failed` | 恢复·启动期 | 直接 | 应用后复校验失败 | 结果卡展示（已自动回滚） | 否 |
| `restore-rolled-back` | 恢复·启动期 | 直接 | 失败后回滚成功（结果态） | 结果卡展示 `.bak` 路径 | 否 |
| `backup-busy` | 门控 | 置灰+原因 | 执行中/排队任务存在 | 按钮禁用 + 原因文案 | 是 |
| `update-in-progress` | 门控 | 置灰+原因 | dsh 安装/升级、Hull 自更新进行中 | 同上 | 是 |
| `restore-pending` / `restore-already-pending` | 门控 | 置灰+原因 | 已有未完成恢复标记 | 同上（可先取消） | 是 |
| `backup-target-inside-userdata` | 备份 | 映射 `backup-target-unwritable` | 目标位于 userData 内 | 提示改选目录 | 是 |
| `restore-version-too-old` / `restore-migrate-preview-failed` / `restore-source-invalid` / `restore-source-missing` / `restore-apply-failed` / `restore-busy` / `restore-manual-required` / `io-error` | 内部 | 映射至最近集合（`restore-manifest-invalid` / `restore-verify-failed` / `backup-failed`）+ message 透传 | 见技术方案 §1.3 | 展示 message | 视码 |

## 接口详情

### 1. 执行备份 `hull:backup`

#### 用途与依据

- 使用场景：设置页「数据」区块点「备份」；或清理旧备份目录。
- 共识：CON-R-backup-001/002/003/005/012；验收：B1 ①~⑤。

#### 鉴权与隔离

- 无网络、无多租户；仅本机渲染层经 preload 桥（`window.hull.backup`）调用，主进程 handler 内强制门控。
- `targetDir`：生产缺省走 `dialog:pickDirectory`；`HULL_E2E=1` 时接受显式入参（生产忽略）。

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|:---:|---|---|
| payload | `action` | `'run'\|'cleanup'` | 否 | 缺省 `run` | 执行备份 / 清理无 manifest 的旧目录 |
| payload | `targetDir` | string | 条件 | `run` 时缺省弹目录选择；绝对路径 | 目标父目录 |

```json
{ "action": "run", "targetDir": "/Users/liyuzhao/Backups" }
```

#### 成功响应

- `ok: true`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|:---:|:---:|---|---|
| `data.backupDir` | string | 是 | 否 | 服务端生成 | 本次包目录绝对路径 |
| `data.items` | `ScopeItemId[]` | 是 | 否 | 白名单 | 实际打包项 |
| `data.bytes` | number | 是 | 否 | 统计 | 字节合计 |

```json
{ "ok": true, "data": { "backupDir": "/Users/liyuzhao/Backups/Hull备份-20260917-1305", "items": ["settings","kanban","workflows","notes","notes-trash","skills","notifs"], "bytes": 372480 } }
```

#### 失败响应

- 适用错误码：见「错误码」表（直接码 + 映射码）。
- 本接口特有：`backup-target-inside-userdata`、`backup-busy`、`backup-target-unwritable`。

| 错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---|---|:---:|
| `backup-target-inside-userdata` | 目标位于 `<userData>` 内 | `code` + `message`（含路径） | 提示改选目录 | 是 |
| `backup-busy` | 执行中/升级中/已有 pending | `code` + `message` | 按钮禁用 + 原因 | 是 |

#### 幂等与并发

- 每次 `run` 新建独立目录（重名自增），不覆盖历史包 → 天然幂等。
- 并发：主进程串行化（同一时刻至多一个备份任务）；重复请求返回 `backup-busy`。

#### 副作用与审计

- 数据写入：仅用户选定目标目录（写 `Hull备份-<ts>/`）；**不写** userData 任何白名单项。
- 审计：`logs/hull.log` 记 `backup start/finish/fail`（含目标路径、项数、字节数；不含文件内容）。

#### 测试要点

- 成功：7 项 + manifest 齐全；守卫断言通过（不含 dsh/Cache/token-buckets）。
- 参数：目标在 userData 内 → 拒绝；目标只读 → 拒绝且零残留。
- 冲突：执行中任务存在 → `backup-busy`；已有 pending → `restore-pending`。
- 异常：ENOSPC → `backup-failed` + 本次目录被清理（或 rename `*.failed-<ts>`）。

### 2. 恢复 `hull:restore`

#### 用途与依据

- 使用场景：设置页点「恢复」→ 选包目录 + 选模式（replace/merge）→ 确认；或取消待恢复标记。
- 共识：CON-R-backup-006/007/010/011/012/013；验收：B2 ①~④ / B3 ①~③。

#### 鉴权与隔离

- 同 1；`sourceDir` 生产缺省弹目录选择，`HULL_E2E=1` 接受显式入参。

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|:---:|---|---|
| payload | `action` | `'request'\|'cancel'` | 否 | 缺省 `request` | 请求恢复 / 取消（仅 `step=requested`） |
| payload | `mode` | `'replace'\|'merge'` | 条件 | `request` 必填 | 恢复模式 |
| payload | `sourceDir` | string | 条件 | `request` 时缺省弹目录选择 | 备份包根（含 manifest.json） |

```json
{ "action": "request", "mode": "merge", "sourceDir": "/Users/liyuzhao/Backups/Hull备份-20260917-1305" }
```

#### 成功响应

- `ok: true`

| 字段路径 | 类型 | 必有 | 可空 | 来源/约束 | 说明 |
|---|---|:---:|:---:|---|---|
| `data.restartRequired` | boolean | 是 | 否 | 恒 true（request） | 需重启生效 |
| `data.preview.mode` | `'replace'\|'merge'` | 是 | 否 | — | 模式回显 |
| `data.preview.items[]` | `ManifestItem[]` | 是 | 否 | 包内清单 | 将恢复的项 |
| `data.preview.notesDirFallback` | string \| null | 是 | 是 | 非 null = 将回退 | 笔记目录回退提示 |
| `data.preview.warnings[]` | string[] | 是 | 否 | — | 用户可见提示（免责/回退） |
| `data.preview.mergePlan[]` | string[] \| null | 是 | 是 | merge 模式 | 各数据类动作摘要 |
| `data.cancelled` | boolean | 条件 | 否 | cancel 时 true | 取消结果 |

```json
{ "ok": true, "data": { "restartRequired": true, "preview": { "mode": "replace", "items": [{ "id": "settings", "path": "settings.json", "kind": "file", "version": 4, "size": 401, "fileCount": 1 }], "notesDirFallback": null, "warnings": ["包内不含凭据（工作台连接需重新填写）"], "mergePlan": null } } }
```

#### 失败响应

| 错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---|---|:---:|
| `restore-manifest-invalid` | manifest 缺失/损坏/结构非法 | `code` + `message` | 提示更换包目录 | 否 |
| `restore-version-newer` | 格式或数据版本高于当前 | `code` + `message`（含最低 Hull 版本） | 提示升级 | 否 |
| `restore-migrate-preview-failed` | 包内数据迁移预演失败 | `code` + `message` | 提示包不可用（现数据零改动） | 否 |
| `restore-already-pending` | 已有未完成标记 | `code` + `message` | 提示先取消或重启 | 是 |

#### 幂等与并发

- `request`：同 `sourceDir` 重复请求 = 覆盖写标记（幂等）；不同包重复请求 = 以最后一次为准。
- `cancel`：幂等（无标记时返回 `ok:true` + `cancelled:false`? → 定义：无标记返回 `ok:false, code:'restore-source-invalid'`? 定版：`cancel` 在无标记时 `{ok:true, data:{cancelled:false}}`，不报错）。

#### 副作用与审计

- 运行期数据写入：仅 `<userData>/.restore/pending.json`（原子写）；**不触碰任何白名单项**。
- 实际替换发生在下次启动早期（见技术方案 §2.3）；结果写 `.restore/result.json`。
- 审计：`logs/hull.log` 记 `restore request/execute/rollback`（含 mode、项数、结果码；不含文件内容）。

#### 测试要点

- 成功：请求后 `pending.json` 存在且字段正确；重启后数据生效 + `result.json.status='success'`。
- 参数：`mode` 缺失 → 校验失败；`sourceDir` 无 manifest → `restore-manifest-invalid`。
- 冲突：已有 pending → `restore-already-pending`；更新进行中 → `update-in-progress`。
- 兼容：`manifestVersion=2` → `restore-version-newer` 且零改动。
- 异常：半成品（注入崩溃）→ 下次启动 `rolledBack` 且数据 hash 复原。

### 3. 状态查询 `hull:getBackupStatus`

#### 用途与依据

- 使用场景：设置页「数据」区块初始化/刷新（按钮可用态、待恢复提示、最近结果卡）。
- 共识：CON-R-backup-009/014/015；验收：B4 ①~④。

#### 请求

无请求体（`ipcRenderer.invoke('hull:getBackupStatus')`）。

#### 成功响应

见「Schema 与枚举 · BackupStatus」；示例：

```json
{ "ok": true, "data": { "canBackup": { "ok": true }, "canRestore": { "ok": true }, "pending": null, "lastResult": { "version": 1, "mode": "replace", "status": "success", "finishedAt": "2026-09-17T13:10:44.000Z", "bakDir": "/…/.restore/backup", "notices": [], "merge": null, "error": null }, "lastBackupDir": null, "restoreBackupDir": "/…/.restore/backup" } }
```

#### 失败响应

- 只读接口，无特有异常；异常时 `{ok:false, code:'io-error', message}`。

#### 幂等与并发

- 只读，天然幂等。

#### 副作用与审计

- 无写入、无外部调用。

#### 测试要点

- 成功：门控字段与实际状态一致；`pending` 随标记出现/消失。
- 边界：`result.json` 损坏 → `lastResult=null` + message（不阻塞）。

### 4. 重启应用 `hull:restart`

#### 用途与依据

- 使用场景：恢复确认弹窗「立即重启并恢复」——先写 pending，再重启应用触发启动期执行。
- 共识：CON-R-backup-013（「立即重启并恢复 / 稍后」确认）；验收：B2 ①。

#### 鉴权与隔离

- 同 1；无入参。

#### 请求

无请求体（`ipcRenderer.invoke('hull:restart')`）。

#### 成功响应

- `ok: true, data: { restarted: true }`（应用退出并由既有退出编排 `quitOrchestration({relaunch:true})` 重启；响应先于编排延时返回）。

#### 失败响应

| 错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---|---|---|:---:|
| `restore-source-invalid` | 无待执行恢复（pending 不存在） | `code` + `message` | 提示"没有待执行的恢复" | 是 |
| `update-in-progress` | dsh 安装/升级、skills 升级、Hull 自更新在途 | `code` + `message` | 提示稍后 | 是 |
| `backup-busy` | 看板执行中/排队任务存在 | `code` + `message` | 提示稍后 | 是 |

#### 幂等与并发

- 门控通过才执行；`quitting` 已置位时重复调用不叠加退出流程。

#### 副作用与审计

- 退出/重启应用；`logs/hull.log` 记 `restart for pending restore`。

#### 测试要点

- 成功：pending 存在 → `ok:true` 且应用重启后恢复执行。
- 拒绝：无 pending → `restore-source-invalid`；更新在途 → `update-in-progress`。

## 联调与测试场景

| 场景 | 前置条件 | 请求/动作 | 预期结果 | 数据与审计结果 | 验收编号 |
|---|---|---|---|---|---|
| 备份 happy | 无执行中任务 | `hull:backup{action:'run',targetDir}` | `ok:true` + backupDir | 目标含 7 项 + manifest；不含 dsh/Cache/token-buckets；日志记 finish | B1 ④/⑤ |
| 备份门控 | 存在执行中任务 | `hull:backup` | `ok:false, code:'backup-busy'` | 零写入 | B1 ① |
| 备份目标非法 | targetDir 在 userData 内 | `hull:backup` | `ok:false, code:'backup-target-inside-userdata'` | 零写入 | B1 ③ |
| 备份失败清理 | 注入写失败（ENOSPC） | `hull:backup` | `ok:false, code:'backup-failed'` | 本次目录被清理/改名；现数据不变 | B1 ⑤ |
| 恢复请求（replace） | 有效包 | `hull:restore{action:'request',mode:'replace',sourceDir}` | `ok:true, restartRequired:true` | `pending.json` 写入（step=requested） | B2 ① |
| 恢复生效（replace） | 上一步后重启 | 二次启动 | 启动早期完成替换 | settings=包内、boards=当前版本、`.restore/backup` 存在、`result.status='success'` | B2 ② |
| 恢复拒绝（高版本） | 手写 `manifestVersion=2` 包 | `hull:restore` | `ok:false, code:'restore-version-newer'` | 无 pending；现数据 hash 不变 | B2 ④/共识 010 |
| 迁移预演失败 | 包内 boards.version 高于当前 | `hull:restore` | `ok:false, code:'restore-migrate-preview-failed'` | 无 pending；不触发 backupAndRebuild | B2 ④ |
| 半成品自愈 | 注入 `restore-after-stage:exit` 后重启 | 二次启动 | 自动回滚 | 数据 hash 复原；`result.status='rolledBack'` | B2 ③/共识 007 |
| 合并模式 | 本地/包内各有同名不同内容笔记 + 同 id 工作流 | `hull:restore{mode:'merge'}` → 重启 | `ok:true`；冲突可见 | 双份笔记（改名）；工作流重 id；`merge.conflicts` 非空 | B3 ①② |
| 取消恢复 | 已写标记（未重启） | `hull:restore{action:'cancel'}` | `ok:true, cancelled:true` | `pending.json` 删除；零其他写入 | B2 运行期 |
| 门控互斥 | 已有 pending | 触发 Hull/dsh 更新入口 | 拒绝 `restore-pending` | 更新不启动 | 共识 007 |
| 重启执行 | pending 存在、无更新/执行在途 | `hull:restart` | `ok:true` + 应用重启 | 重启后启动期执行恢复 | B2 ① |
| 重启拒绝 | 无 pending | `hull:restart` | `ok:false, code:'restore-source-invalid'` | 应用不重启 | 契约 · 门控 |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| — | 无未关闭项（扫描 Q-077~Q-100 全闭环，2026-09-17） | — | v2 候选见共识 U-1~U-7（不阻塞 v1） | closed |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| `KanbanStore.importData` merge 复用边界（B3 看板类合并；确认其内部"导入前自动备份"在 merge 语境下的行为） | 看板模块（同仓库） | BE | 实现 B3 前 | 已定（技术方案 §4.1；必要时禁用重复备份） |
| `.restore/backup` 清理交互（数据卡手动清理入口） | 设置页（B4） | FE | 实现 B4 前 | 已定（技术方案 §2.3/共识 012） |

## 完成记录

> 交付后填写（结果需证据）。

| 项 | 结果 |
|:---|:-----|
| 交付时间 | 2026-09-17（feature/backup） |
| 验证结果 | 单测 1212/1212 ✅ · integration 24/24 ✅ · e2e 4/4 ✅ · semgrep 0 findings ✅ · tsc 0 error ✅ |
| 构建/发布 | 未发布（待用户验收后走 PR 合并 → 发版另行安排） |
| 偏差处理 | 4 轮 oracle 评审全部修复；设计级偏离 D1~D5 已回写技术方案（见 `docs/records/B-备份-backup-record.md` §四）；契约本文件变更记录 v1.1 同步 |

## 决策与踩坑

- **白名单正列举而非黑名单排除**：数据目录主体（1.2GB）是可重装产物与缓存，黑名单易漏（`skills/staging/`、`.tmp-<pid>-<ts>` 等实测漏网）→ 正列举 + 守卫断言（包内出现排除项即校验失败）。复用场景：任何"从大目录挑小集合"的导出功能。
- **先 reset 再 merge 保证可重入**：merge 崩溃后重跑需确定基线 → 应用阶段先把 userData 项重置为预备份基线，再从包内容合并；避免"半合并"状态累积。复用场景：一切可重入的合并/导入器。
- **`.restore/` 独立目录不受白名单影响**：标记/结果/staging/预备份都放 `.restore/`，恢复过程自身不搬运自己 → 自愈判定可全枚举（11 行决策表）。复用场景：需要跨重启续做的两步式操作。
- **safeStorage 密文不可跨机**：凭据不进包（解密只可能在本机钥匙串）→ 恢复后重填；避免"看似备份了凭据"的假象。复用场景：任何含 OS 绑定密钥的导出功能。
- **回滚既要幂等又要不留残留**：显式回滚 = 无条件删包内路径 + copy 式还原（backup 不消费）→ 任意崩溃点重跑收敛；而"无 pending 的补齐通道"必须 **repair-only**（只补缺失、不删不覆盖），否则旧备份会在日后静默覆盖当前数据（复验发现的真 🔴）。复用场景：任何"备份-回滚-补齐"三态功能。

## 变更记录

| 时间 | 类型 | 摘要 |
|---|---|---|
| 2026-09-17 | 初次生成 | 基于共识 v1.1 + 技术方案（B-备份-backup-design）生成契约；覆盖 B1~B5；状态=已冻结 |
| 2026-09-17 | 变更（核验期同步） | ① 新增 `hull:restart` 通道（共识 013「立即重启」落地；门控 = pending 必需 + 更新/执行在途拒绝；走既有退出编排）；② `ConflictKind` 增 `'notif'`（通知冲突不再借 workflow）；③ 白名单 skills 项含 `skills/disabled/` 实体（共识 v1.2）；④ 回滚语义：成功归档 `backup-<ts>/`、孤儿保留 `backup-orphan-<ts>/`、`#3` 补齐通道 repair-only、显式回滚 copy 式；⑤ `restoreBackupDir` 语义澄清（活跃态） |

## 自检记录

- 追踪完整性：PASS（每接口可追溯至子需求/共识规则/验收；追踪表齐）
- OpenAPI 一致性：不适用（本地 IPC，无 HTTP/OpenAPI 面）
- 示例与错误场景：PASS（请求/成功/失败示例齐；错误码表含触发条件与处理）
- 安全与敏感字段：PASS（无凭据入包/入响应；`notesDirHint` 明示为路径提示；日志不含文件内容）
- 链接与格式：PASS（引用路径有效：共识 v1.1 / 技术方案 / 调研）
