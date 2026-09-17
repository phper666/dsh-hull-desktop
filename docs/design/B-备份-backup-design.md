# 数据备份与恢复（backup）技术方案

> 需求标识：`backup` · 判级：**复杂**（新增模块 + 启动期状态机 + 数据安全路径；判级理由：跨模块数据面 + 原子替换状态机 + 安全敏感写路径）→ 本文即方案冻结输入
> 依据：共识 `docs/spec/共识-Hull桌面壳-备份.md` v1.1（CON-R-backup-001~016）、调研 `docs/research/2026-09-17-backup调研.md`
> 子需求：B1 备份引擎与门控 / B2 恢复替换（replace）/ B3 恢复合并（merge）/ B4 设置页「数据」区块与 IPC / B5 测试与验收（ticket：de822069 / ad2107c8 / 880c8f7d / ec42ce2d / 32ee28bc）
> 契约（并行）：`hull:backup` / `hull:restore` / `hull:getBackupStatus`；统一返回 `{ok, code?, message?, data?}`；e2e 注入 `HULL_E2E=1` 显式路径 + `HULL_E2E_FAIL_AT`
> 状态：**已冻结**（2026-09-17，owner 评审通过）· 实现须按 §9 冻结检查项逐条对照

**全局不变量（所有模块共享）**

1. 任何路径读写不得触碰 DSH_HOME 与 `<userData>/dsh`（CON-R-backup-004 + CON-R002 红线）；notesDir 相关判断统一调用 `forbiddenNotesDirReason(dir, userDataPath)`（src/notes/NotesService.ts:296）。
2. 备份包只含白名单 7 项（CON-R-backup-001），采用**白名单正列举**，禁止黑名单排除式拷贝。
3. 恢复的原子单位 = **白名单项**（不是整个 userData）：`.restore/`、`dsh/`、`node/`、`corepack/`、Chromium 各目录一律不动（CON-R-backup-006/007）。
4. 运行期恢复**零数据副作用**（只读 + 写 `.restore/pending.json`）；一切替换在启动期执行（CON-R-backup-007）。
5. 所有写盘走 `SkillFsOps.writeFileSyncAtomic` 或 temp+rename；新错误码一律 kebab（CON-R-backup-015）。

---

## 1. 模块划分与文件结构

```
src/backup/
  scope.ts            # 白名单/过滤/路径守卫（纯路径逻辑，无 IO 副作用）
  manifest.ts         # manifest schema + 构建 + 解析/兼容性校验（纯函数）
  errors.ts           # kebab 错误码 + BackupError
  gate.ts             # canBackup / canRestore / 与更新器互斥（纯函数 + 注入 deps）
  backupService.ts    # 运行期备份编排（B1）
  restoreService.ts   # 运行期恢复编排：校验/预演/写标记/取消（B2 运行期）
  restoreExecutor.ts  # 启动期执行器 + 状态机 + 自愈（B2 启动期）
  result.ts           # .restore/ 三文件 schema + 原子读写（pending/result）
  BackupIpc.ts        # IPC 注册 + 通道常量 + 返回形状包装（B4）
  merge/
    conflicts.ts      # 冲突清单 + 合并报告类型
    index.ts          # applyMerge 编排（按类分发）
    kanban.ts         # 看板类合并（复用 KanbanStore.importData merge 分支）
    notes.ts          # 笔记类合并（文件级 + 回收站）
    settings.ts       # 设置字段级合并（notesDir 特例）
    workflows.ts      # 工作流 id 冲突重 id 追加
    notifications.ts  # 通知追加去重 + ring cap + dismiss 并集
    skills.ts         # skills 索引并集 + 实体拷贝 + 路径失效标注
```

**子需求 ↔ 文件映射**：B1 → `scope/manifest/errors/gate/backupService`；B2 → `restoreService/restoreExecutor/result`；B3 → `merge/*`；B4 → `BackupIpc.ts` + `src/shared/ipc-channels.ts` + `src/preload/index.ts` + `src/renderer/shell.html`；B5 → `*.test.ts` + `tests/integration/backup*.test.ts` + `tests/e2e/backup*.spec.ts`。

### 1.1 scope.ts

```ts
export type ScopeItemId = 'settings' | 'kanban' | 'workflows' | 'notes' | 'notes-trash' | 'skills' | 'notifs';
export type ScopeItemKind = 'file' | 'tree';

export interface ScopeItem {
  id: ScopeItemId;
  kind: ScopeItemKind;
  /** userData 内相对路径（目录用无尾斜杠相对路径） */
  rel: string;
  /** 备份包内相对路径，缺省 = rel */
  packRel?: string;
  /** manifest.items[].version 提取器：读原始 JSON 取版本号，无版本 → null */
  versionOf?: (raw: unknown) => number | null;
  /** 允许缺失（缺失时该项不进 manifest.items，不失败） */
  optional?: boolean;
  /** 项内排除（如 notes 正文排除 .trash/ 与 trash.json，归 notes-trash 项） */
  exclude?: (relInItem: string) => boolean;
}

/** 7 项（以 CON-R-backup-001 为准；改分组只改本表） */
export const BACKUP_SCOPE: readonly ScopeItem[];

/** 拷贝期瞬态过滤（同时用于备份拷贝与恢复 staging 校验） */
export const EXCLUDE_NAME_PATTERNS: readonly RegExp[];
// [/\.tmp$/, /\.tmp-/, /\.bak-\d+$/, /\.corrupt-\d+$/, /(^|\/)[^/]*-staging(\/|$)/]

export interface ScopeCtx { userDataPath: string; notesDir: string }

/** 解析源绝对路径 / 包内相对路径；notes 项在 notesDir 外置时返回 null（= 不打包） */
export function resolveItemPaths(item: ScopeItem, ctx: ScopeCtx): { absSource: string; packRel: string } | null;

/** 枚举项内文件（相对路径数组；应用 exclude + EXCLUDE_NAME_PATTERNS；不拷贝） */
export function enumerateFiles(absSource: string, item: ScopeItem): string[];

/** realpath 前缀守卫：备份目标不得位于 userData 内（防自包含）；目标 == userData → true */
export function isInsideUserData(target: string, userDataPath: string): boolean;
```

### 1.2 manifest.ts

```ts
export const FORMAT_VERSION_CURRENT = 1;
export const FORMAT_VERSION_MIN = 1;
export const MANIFEST_FILENAME = 'manifest.json';

export interface ManifestItem {
  id: ScopeItemId;
  path: string;            // 包内相对路径（'/' 分隔）
  kind: ScopeItemKind;
  version: number | null;  // 该数据文件 schema 版本（settings.schemaVersion / boards.version / workflows.version …）
  size: number;            // 字节合计
  fileCount: number;
}

export interface Manifest {
  manifestVersion: number;   // 备份包格式版本（唯一兼容判据）
  appVersion: string;        // 导出时 Hull 版本（用户可见，用于"请升级到 ≥X"提示）
  platform: NodeJS.Platform;
  exportedAt: string;        // ISO8601
  notesDirHint: string;      // 导出时 settings.notesDir 原值（仅提示，不用于写入）
  items: ManifestItem[];
  counts: { files: number; bytes: number };
}

export function buildManifest(input: {
  appVersion: string; platform: NodeJS.Platform; exportedAt: Date;
  notesDirHint: string; items: ManifestItem[];
}): Manifest;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: BackupErrorCode; message: string };

export function parseManifest(raw: unknown): ParseResult<Manifest>;     // 结构 + 类型 + 必填 + 未知字段容忍
export function checkCompatibility(m: Manifest): ParseResult<Manifest>; // 区间校验
```

### 1.3 errors.ts

```ts
export type BackupErrorCode =
  // 备份（B1）
  | 'backup-busy' | 'backup-target-unwritable' | 'backup-target-inside-userdata'
  | 'backup-failed' | 'io-error'
  // 恢复：运行期（B2）
  | 'restore-source-invalid' | 'restore-manifest-missing' | 'restore-manifest-invalid'
  | 'restore-version-newer' | 'restore-version-too-old'
  | 'restore-migrate-preview-failed' | 'restore-already-pending' | 'restore-busy'
  // 恢复：启动期（B2）
  | 'restore-source-missing' | 'restore-apply-failed' | 'restore-verify-failed'
  | 'restore-rolled-back' | 'restore-manual-required'
  // 互斥（B4）
  | 'update-in-progress' | 'restore-pending';

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  constructor(code: BackupErrorCode, message: string);
}
```

> UI 可见错误码 = 共识 CON-R-backup-015 的 6 个（backup-target-unwritable / backup-failed / restore-manifest-invalid / restore-version-newer / restore-verify-failed / restore-rolled-back）；其余为内部码，UI 映射到最近集合（契约定稿映射表）。

### 1.4 gate.ts

```ts
export interface GateResult { ok: boolean; code?: BackupErrorCode; message?: string }

export interface GateDeps {
  /** 执行引擎 running/queued 任一非空（ExecutionEngine.getExecutionSnapshot，src/exec/ExecutionEngine.ts:187） */
  hasRunningExecutions(): boolean;
  /** dsh 安装或升级进行中（InstallFlow / UpgradeQueue） */
  isInstallOrUpgradeActive(): boolean;
  /** Hull 自更新进行中（HullUpdater.snapshot().phase） */
  isHullUpdateActive(): boolean;
  /** `.restore/pending.json` 存在（result.readPending != null） */
  hasPendingRestore(): boolean;
}

export function canBackup(deps: GateDeps): GateResult;      // 检查 hasRunningExecutions + isInstallOrUpgradeActive + isHullUpdateActive + hasPendingRestore
export function canRestore(deps: GateDeps): GateResult;     // 检查 isHullUpdateActive + isInstallOrUpgradeActive + hasPendingRestore
export function canStartUpdate(deps: GateDeps): GateResult; // 更新器入口前置：hasPendingRestore → 'restore-pending'
```

### 1.5 backupService.ts / restoreService.ts / restoreExecutor.ts

```ts
// ── B1：运行期备份 ──
export interface BackupServiceDeps {
  userDataPath: string;
  notesDir(): string;                 // NotesService.getNotesDir()
  flushAll(): void;                   // kanbanStore.flushSync()（src/kanban/KanbanStore.ts:318）
  gate: GateDeps;
  logger: RuntimeLogger;
  appVersion: string;
  now?: () => Date;
  failAt?: string;                    // HULL_E2E_FAIL_AT（仅 HULL_E2E=1 生效）
}
export interface BackupResult { backupDir: string; manifest: Manifest }
export class BackupService {
  constructor(deps: BackupServiceDeps);
  run(input: { targetDir: string }): Promise<BackupResult>;   // 失败抛 BackupError
  cleanupOrphans(parentDir: string, keep: number): number;    // 数据卡"清理旧备份"
}

// ── B2 运行期：校验 + 预演 + 写标记 ──
export interface RestoreServiceDeps {
  userDataPath: string; notesDir(): string; gate: GateDeps;
  logger: RuntimeLogger; now?: () => Date; failAt?: string;
}
export interface RestorePreview {
  mode: 'replace' | 'merge';
  manifest: Manifest;
  items: ManifestItem[];
  notesDirFallback: string | null;    // 非 null = 恢复后 notesDir 将回退（原路径不存在/非法）
  warnings: string[];
  mergePlan: string[] | null;         // merge 模式：各数据类将执行的动作摘要
}
export class RestoreService {
  constructor(deps: RestoreServiceDeps);
  inspect(input: { sourceDir: string; mode: 'replace' | 'merge' }): Promise<RestorePreview>;
  request(input: { sourceDir: string; mode: 'replace' | 'merge' }): Promise<{ pending: PendingFile; preview: RestorePreview }>;
  cancel(): boolean;                  // 仅 step='requested' && phase='forward'
  getPending(): PendingFile | null;
}

// ── B2 启动期：执行器 + 状态机 ──
export type RestoreStep = 'requested' | 'staged' | 'backedUp' | 'applied' | 'verified';
export type RestorePhase = 'forward' | 'rolling-back';

export interface ObservedState {
  hasPending: boolean; step: RestoreStep; phase: RestorePhase;
  sourceDirExists: boolean; incomingComplete: boolean; backupComplete: boolean;
  itemsInPlace: 'all' | 'partial' | 'missing-unknown';
}
export type HealAction = 'continue' | 'rollback' | 'finish' | 'cleanup' | 'manual';

/** 纯函数：自愈决策（单测主对象） */
export function decideHeal(s: ObservedState): HealAction;
export const STEP_ORDER: readonly RestoreStep[];
export function nextStep(s: RestoreStep): RestoreStep | null;

export interface RestoreExecutorDeps {
  userDataPath: string; logger: RuntimeLogger; failAt?: string; now?: () => Date;
}
export type RestoreOutcome =
  | { status: 'none' }
  | { status: 'success'; result: RestoreResult }
  | { status: 'rolledBack'; result: RestoreResult }
  | { status: 'failed'; result: RestoreResult };

/** 启动早期入口（幂等；内部捕获全部异常，绝不阻断启动） */
export function runRestoreIfPending(deps: RestoreExecutorDeps): RestoreOutcome;
```

**主进程装配点（B2/B4）**

```ts
// src/main/index.ts bootstrap()：顺序固定，插在 Logger 之后、其余服务之前
const logger = new Logger({ logDir: join(userDataPath, 'logs') });
runRestoreIfPending({ userDataPath, logger, failAt: e2eFailAt() });   // 早于 cleanupStaleDsh / SettingsProvider / overlay.ensure / winMgr.create
cleanupStaleDsh(userDataPath);
const settings = new SettingsProvider({ userDataPath, logger });
// …既有服务装配…
const backupService = new BackupService({ /* … kanbanStore.flushSync, notesService.getNotesDir, gateDeps … */ });
const restoreService = new RestoreService({ /* … */ });
registerBackupIpc({ backupService, restoreService, status: buildBackupStatus });
```

> 执行器不实例化 SettingsProvider；迁移预演走纯函数（§3.5）。`gateDeps.hasRunningExecutions` 装配点跟随现有 exec 注册函数（B4 接线）。

### 1.6 BackupIpc.ts / 数据结构读写

```ts
export const BACKUP_IPC_CHANNELS = ['hull:backup', 'hull:restore', 'hull:getBackupStatus'] as const;

export interface IpcResult<T> { ok: boolean; code?: string; message?: string; data?: T }

export interface BackupIpcDeps {
  backupService: BackupService;
  restoreService: RestoreService;
  status(): BackupStatus;
}
export function registerBackupIpc(deps: BackupIpcDeps): void;

export interface BackupStatus {
  canBackup: GateResult;
  canRestore: GateResult;
  pending: PendingSummary | null;     // { mode, sourceDir, createdAt }
  lastResult: RestoreResult | null;
  lastBackupDir: string | null;       // 由数据卡自行持久化（Partitions/shell localStorage）
  restoreBackupDir: string | null;    // `.restore/backup`（存在时）
}
```

通道 payload（定稿见契约）：

| 通道 | 入参 | data |
|:---|:---|:---|
| `hull:backup` | `{ action?: 'run' \| 'cleanup'; targetDir?: string }` | `{ backupDir, items, bytes }` |
| `hull:restore` | `{ action?: 'request' \| 'cancel'; mode?: 'replace'\|'merge'; sourceDir?: string }` | `{ restartRequired, preview }` / `{ cancelled: true }` |
| `hull:getBackupStatus` | `{}` | `BackupStatus` |

`targetDir` / `sourceDir` 在生产缺省走 `dialog:pickDirectory`（复用 src/main/index.ts:541-550）；仅 `HULL_E2E=1` 时接受显式入参（CON-R-backup-009/014）。

---

## 2. 关键流程与状态机

### 2.1 备份流程（B1，运行期完成）

1. `canBackup(gateDeps)` 不通过 → `BackupError(code)`（handler 内强制，渲染层禁用只是 UX）（CON-R-backup-005）。
2. `isInsideUserData(targetDir)` → 命中抛 `backup-target-inside-userdata`。
3. 目标目录可写预检（`fs.access(W_OK)` + 探测文件写删）→ 失败 `backup-target-unwritable`；空间不足不做预检，由写错误兜底（ENOSPC → `backup-failed`）。
4. `flushAll()`（kanban 防抖落盘；其余 store 同步原子写无需 flush）（CON-R-backup-005）。
5. 新建 `backupDir = <targetDir>/Hull备份-YYYYMMDD-HHmmss/`（已存在 → `-2`/`-3` 后缀）。
6. 按 `BACKUP_SCOPE` 逐项拷贝：`resolveItemPaths` → `enumerateFiles` → 逐文件 `copyFile`；单文件失败重试 1 次，仍失败**整体失败**（不允许静默跳过，保证包 == manifest 声明），warning 汇总在 message。
7. `buildManifest(...)`；`manifest.json` **最后**写入，走 `SkillFsOps.writeFileSyncAtomic`（= 完成标记）（CON-R-backup-003/012）。
8. 失败路径：best-effort `rm -rf backupDir`；删不掉 → rename `*.failed-<ts>` 并在返回 message 中给路径（CON-R-backup-012）。
9. 返回 `{ backupDir, manifest }`。

### 2.2 恢复运行期（B2，零数据副作用）

1. `canRestore(gateDeps)` → 拒绝码 `update-in-progress` / `restore-already-pending`。
2. 解析 `sourceDir`（显式入参或 `dialog:pickDirectory`）；`manifest.json` 缺失 → `restore-manifest-missing`。
3. `parseManifest` → `checkCompatibility` → 关键文件解析 + 迁移预演 + notesDir 检查（§3）→ 任一失败整包拒绝（CON-R-backup-010）。
4. 生成 `RestorePreview`（含 `notesDirFallback` / `mergePlan`）。
5. 原子写 `.restore/pending.json`（`step:'requested'`, `phase:'forward'`）；已存在旧标记 → 覆盖（覆盖即"重新选择"语义，幂等）。
6. 返回 `{ restartRequired: true, preview }`；渲染层提示「立即重启 / 稍后」（CON-R-backup-013）。
7. `cancel()`：删 `pending.json`（仅 `step='requested' && phase='forward'`）。

### 2.3 启动期执行器（B2）

```
Logger → runRestoreIfPending:
  pending 不存在 → 清理空 .restore → none
  观察态采样(ObservedState) → decideHeal
    manual  → 写 result(failed, restore-manual-required)；保留现场；return failed
    finish  → 收尾（verify 通过 或 源缺失失败）
    cleanup → 删标记/空目录 → none
    rollback→ 续做回滚 → result(rolledBack)
    continue→ 逐 step 推进：
      S1 staged   : rm .restore/incoming* → 拷包内 → incoming.tmp → rename incoming → step=staged
      S2 backedUp : 逐项 rename userData/<rel> → .restore/backup/<rel>（源缺+目标在 = 已完成）→ step=backedUp
      S3 applied  : replace → 逐项 move incoming/<packRel> → userData/<rel>
                    merge   → ① resetItemsFromBackup()（把 userData 项恢复为预备份基线，保证可重入）
                              ② applyMerge(ctx)（§4）
                    → step=applied
      S4 verified : 复校验（§3.3）→ 失败转 rollback；通过 → step=verified
      收尾        : writeResult(success) → clearPending（先 result 后清标记）
  任一 step 抛错 → phase='rolling-back' 落盘 → rollback()
  rollback(): 逐项 rm userData/<rel>（内容都在 backup/incoming，安全）→ rename backup/<rel> → userData/<rel>
              → writeResult(rolledBack|failed) → clearPending
```

### 2.4 步骤幂等性与崩溃点

| step | 动作 | 幂等实现 | 崩溃后现场 |
|:---|:---|:---|:---|
| requested | 写标记（无 FS 变更） | 覆盖写 | 只有标记 |
| staged | 拷包内 → `.restore/incoming.tmp/` → rename `incoming/` | 每轮重建 `incoming*` | incoming 完整或不存在（无半成品） |
| backedUp | 逐项 rename userData → `.restore/backup/` | 源缺+目标在 → 视为已完成 | 部分项已备 |
| applied | replace：逐项 move；merge：先 reset 再合并 | replace：目标已在 → 跳过；merge：reset 保证从确定基线重跑 | 部分项已应用 |
| verified | 复校验（只读） | 只读，天然幂等 | 校验结果不落盘（由标记 step 表达） |
| 收尾 | writeResult → clearPending | 重跑安全（result 覆盖写） | result 已写/标记未清 |
| rolling-back | 逐项回滚 | 源缺 → 跳过 | 部分项已回 |

### 2.5 自愈决策表（`decideHeal` 定版）

| # | 观察态 | 动作 | 结果 |
|:--|:---|:---|:---|
| 1 | 无 pending + `.restore` 无 incoming/backup | `cleanup` | none（删空目录） |
| 2 | 无 pending + `.restore/backup` 有内容 + 现数据项齐全 | `cleanup`（保留 backup，记 warning） | none |
| 3 | 无 pending + `.restore/backup` 有内容 + 现数据项缺失 | `rollback` | rolledBack（补齐缺项） |
| 4 | pending（forward, requested）+ sourceDir 存在 | `continue` | 从 staged 起 |
| 5 | pending（forward, requested）+ sourceDir 不存在 | `finish` | failed(`restore-source-missing`)，现数据零改动 |
| 6 | pending（forward, staged/backedUp/applied）+ incoming 完整 | `continue` | 续推 |
| 7 | pending（forward, staged+）+ incoming 缺失/不完整 | `continue`→重做 staging；二次失败 `rollback` | 成功 / rolledBack |
| 8 | pending（forward, verified） | `finish` | success（仅收尾） |
| 9 | pending（rolling-back） | `rollback` | 续做回滚 |
| 10 | 任一步 + 现数据项"既不在原位也不在 backup" | `manual` | failed(`restore-manual-required`)，不猜测不动现场 |
| 11 | pending + backup 与 incoming 均缺失且 step ≥ backedUp | `manual` | failed(`restore-manual-required`) |

> #10/#11 判定不做启发式：`phase` 字段显式表达正向/回滚，递归场景全可判定。

---

## 3. 校验器设计

### 3.1 manifest schema（定稿）

| 字段 | 类型 | 必填 | 说明 |
|:---|:---|:---:|:---|
| `manifestVersion` | `number`（整数 ≥1） | ✔ | 包格式版本；唯一兼容判据 |
| `appVersion` | `string` | ✔ | 导出时 Hull 版本；用于"请升级到 ≥X" |
| `platform` | `'darwin'\|'win32'\|'linux'` | ✔ | 仅提示 |
| `exportedAt` | `string` ISO8601 | ✔ | 展示与排序 |
| `notesDirHint` | `string` | ✔ | 原 notesDir（仅提示，不落盘） |
| `items[]` | `ManifestItem[]` | ✔ | 见下 |
| `counts` | `{files:number,bytes:number}` | ✔ | 校验用（与 items 合计一致） |

`ManifestItem`：`id`（七选一）、`path`（包内相对，`/` 分隔）、`kind`、`version`（`number\|null`）、`size`、`fileCount`。

示例：

```json
{
  "manifestVersion": 1,
  "appVersion": "0.1.9",
  "platform": "darwin",
  "exportedAt": "2026-09-17T13:05:22.123Z",
  "notesDirHint": "/Users/liyuzhao/AI/notes",
  "items": [
    { "id": "settings", "path": "settings.json", "kind": "file", "version": 4, "size": 401, "fileCount": 1 },
    { "id": "kanban", "path": "kanban/boards.json", "kind": "file", "version": 2, "size": 53641, "fileCount": 1 },
    { "id": "notes", "path": "notes", "kind": "tree", "version": null, "size": 12288, "fileCount": 7 }
  ],
  "counts": { "files": 9, "bytes": 372480 }
}
```

### 3.2 兼容性区间（`checkCompatibility`）

| 条件 | 结果 | 错误码 |
|:---|:---|:---|
| `manifestVersion > FORMAT_VERSION_CURRENT` | 拒绝（不半应用） | `restore-version-newer`（message 携最低 Hull 版本） |
| `manifestVersion < FORMAT_VERSION_MIN` | 拒绝 | `restore-version-too-old` |
| `items[].version > 当前对应 schema` | 拒绝整包 | `restore-version-newer` |
| `items[].version < 当前` | 放行 → 预演迁移链 | — |
| `items[].version === null`（无版本文件） | 放行 | — |

### 3.3 关键文件可解析校验（`inspect` 内只读执行，`verified` 步复跑同一函数）

```ts
export interface ValidateInput { stagedRoot: string; manifest: Manifest; userDataPath: string }
export interface ValidateOutput { ok: true; notices: ResultNotice[] } | { ok: false; code: BackupErrorCode; message: string }
export function validateDataFiles(input: ValidateInput): ValidateOutput;
```

检查项（任一失败 → 整包拒绝/回滚）：
1. `manifest.items[].path` 实存且 `size/fileCount` 与 manifest 一致。
2. JSON 文件可解析且顶层结构正确：`settings.json`（对象 + `schemaVersion` 数值）、`kanban/boards.json`（`version:number` + `boards:[]`）、`workflows/workflows.json`（对象/数组按 types.ts）、`notifications/notifications.json`（`version` + `notifications:[]`）。
3. `trash.json`（notes / skills）`entries[]` 元素形状（id/originalPath/deletedAt）。
4. `notes/**` 仅 `*.md`（不校验 frontmatter 语义）。
5. 不含 `dsh/`、`node/`、`corepack/`、`Partitions/`、`.restore/`、`token-buckets.json`、`skills/hash-cache.json`、`skills/remote-sig-cache.json`、`skills/staging/`、`kanban/executions/`、`workflows/runs.json`、`logs/`（**守卫断言**，防包被伪造为"全量包"）。

### 3.4 notesDir 红线（`notesDirHint` 与包内 `settings.notesDir` 双源）

```ts
export function resolveNotesDir(raw: unknown, ctx: {
  userDataPath: string;
  exists(p: string): boolean;
}): { value: string; fallback: string | null; notice: ResultNotice | null };

// 判定顺序（第一项失败即回退默认 join(userDataPath,'notes')）：
//   ① typeof raw === 'string' && isAbsolute(raw)
//   ② forbiddenNotesDirReason(raw, userDataPath) === null      // src/notes/NotesService.ts:296
//   ③ exists(raw)                                              // 异机路径不存在 → 回退
```

- 回退时产出 notice `notes-dir-fallback`（写进 `result.notices`，UI 展示"笔记目录已回退，请到设置页重新选择"）；`notesDirHint` 仅用于提示原路径，不写盘（CON-R-backup-008）。

### 3.5 迁移预演（复用既有 migrate 的纯函数化）

```ts
// settings：从 SettingsProvider.migrate 抽出字段补齐逻辑（行为等价，既有单测兜底）
export function migrateSettingsObject(raw: Record<string, unknown>, userDataPath: string): HullSettings;

// kanban：从 KanbanStore.migrate 抽出（可抛 HullError('migrate-failed')）
export function migrateKanbanData(data: KanbanData): KanbanData;

export function previewMigrations(input: {
  settingsRaw: unknown; boardsRaw: unknown; workflowsRaw: unknown;
  userDataPath: string;
}): { ok: true; settings: HullSettings; boards: KanbanData } | { ok: false; code: BackupErrorCode; message: string };
```

- 实现方式：**纯函数抽取 + 类方法改为调用同一纯函数**（`SettingsProvider.migrate()` / `KanbanStore.migrate()` 语义不变，避免双份迁移逻辑漂移）。
- `boards` 高于当前或迁移抛错 → `restore-migrate-preview-failed` → **运行期拒绝且不写标记**，杜绝 KanbanStore.load 的 `backupAndRebuild` 在半应用状态下静默重建（CON-R-backup-010）。

---

## 4. merge 引擎设计（B3）

编排（`merge/index.ts`）：

```ts
export interface MergeContext {
  userDataPath: string;
  backupRoot: string;      // 预备份根：本地旧数据
  incomingRoot: string;    // 已 staging 的包内容根
  settingsLocal: HullSettings;
  settingsIncoming: HullSettings;
  logger: RuntimeLogger;
  now(): Date;
  uuid(): string;
}
export function applyMerge(ctx: MergeContext): MergeReport;   // 逐类调用；任一类抛错 → 整体失败 → 回滚
```

通用纪律：**先 reset 再合并**（§2.3 S3），每类合并结果用 `SkillFsOps.writeFileSyncAtomic` 落盘；所有"跳过/改名/追加"进冲突清单（`merge/conflicts.ts`）：

```ts
export type ConflictKind = 'note' | 'kanban' | 'workflow' | 'skill' | 'setting';
export type Resolution = 'renamed' | 'appended' | 'kept-local' | 'overwritten' | 'missing-path' | 'skipped-identical';
export interface ConflictEntry { kind: ConflictKind; path?: string; id?: string; resolution: Resolution; detail?: string }
export interface MergeReport {
  classes: Record<ConflictKind, { added: number; updated: number; skipped: number }>;
  conflicts: ConflictEntry[];
  notices: ResultNotice[];
}
```

### 4.1 看板（`merge/kanban.ts`）

```ts
export function mergeKanban(ctx: {
  userDataPath: string; backupBoardsPath: string; logger: RuntimeLogger;
}): { report: MergeReport; boards: KanbanData };
```

调用边界（复用 `KanbanStore.importData` merge 分支，src/kanban/KanbanStore.ts:847）：
1. 启动期执行器已把**包内** boards 换入 `userData/kanban/boards.json`（作为基底）。
2. 在临时实例上导入本地旧数据：`const store = new KanbanStore({ userDataPath, logger: NOOP_LOGGER }); store.importData(backupBoardsData, 'merge'); store.dispose();`
   —— 语义 = "把恢复前本机的看板作为待导入内容追加到恢复后的集合"，id 冲突走既有重映射（不覆盖包内）。
3. `importData` 的冲突/统计结果映射为 `MergeReport`（conflicts 记 `resolution:'appended'`）。
4. 不新增 id 重映射逻辑；若 `importData` 内部有"导入前自动备份"行为，在 merge 语境下指向 `.restore/backup/` 或按需禁用重复备份（避免二次写盘）。

### 4.2 笔记（`merge/notes.ts`）

```ts
export function mergeNotes(ctx: {
  userDataPath: string; backupNotesRoot: string; incomingNotesRoot: string; now(): Date;
}): { report: MergeReport };
```

- 基线：`userData/notes` 以包内内容为准（replace 式换入），再并入本地（`backup/notes`）。
- 文件级规则（仅 `*.md`；`.trash/` 与 `trash.json` 归 4.2b）：
  - 相对路径不存在 → 拷贝（`added`）。
  - 存在且内容 hash 相同 → 跳过（`skipped-identical`）。
  - 存在且内容不同 → **本地保留原名**，包内版本落 `<basename> (恢复冲突 YYYYMMDD-HHmmss).md`（同目录；重名递增 `-2`）；冲突记 `resolution:'renamed'`（CON-R-backup-011）。
- 4.2b 回收站：`trash.json` 条目按 `id` 去重并集，实体 `tr_<uuid>.md` 缺失者从 `backup/notes/.trash/` 拷入；`deletedAt` 排序不变。

### 4.3 设置（`merge/settings.ts`）

```ts
export function mergeSettings(local: HullSettings, incoming: unknown, ctx: {
  userDataPath: string; exists(p: string): boolean;
}): { value: HullSettings; conflicts: ConflictEntry[]; notices: ResultNotice[] };
```

- 字段级：`value = { ...local, ...incoming }`（包内覆盖同名键，本地独有键保留）。
- 写盘前跑读路径归一化链（与 `SettingsProvider.set` 对称）：theme 白名单、`isValidPkgMgr`、`normalizeNotifPrefs`、`isValidRegistry`、`channel/pinnedVersion` 约束；任一非法 → 回退本地值 + `resolution:'kept-local'`。
- `schemaVersion` 一律写 `SCHEMA_VERSION_CURRENT`（包内低版本已在预演补字段）。
- **notesDir 特例**：`resolveNotesDir(incoming.notesDir, ctx)`（§3.4）→ 合法且存在取包内值；否则回退默认 + notice。**不保留本地 notesDir**（避免双源）。

### 4.4 工作流（`merge/workflows.ts`）

```ts
export function mergeWorkflows(local: WorkflowsFile, incoming: unknown, ctx: { uuid(): string }): {
  value: WorkflowsFile; conflicts: ConflictEntry[];
};
```

- 以包内为基底；本地工作流逐条追加。
- `id` 与基底冲突 → 重生成 `wf_<uuid>` 后追加（`resolution:'appended'`，detail 记 `oldId`）；`name` 相同不合并、不覆盖。
- `runs.json` 不入包也不并入（v1 明确排除）。

### 4.5 通知与 dismiss（`merge/notifications.ts`）

```ts
export function mergeNotifications(local: unknown, incoming: unknown): { value: NotificationsFile; conflicts: ConflictEntry[] };
export function mergeDismiss(local: unknown, incoming: unknown): DismissFile;   // 每 channel 取较新日期
```

- 通知：基底 = 包内；本地条目按 `id` 去重追加；合并后按现有 ring cap 裁剪（cap 常量以 NotificationService 为准），裁剪记 `skipped`。
- dismiss：`{ dsh?, hull? }` 逐键取新（ISO 日期字符串直接比较）。

### 4.6 skills 索引并集（`merge/skills.ts`）

```ts
export function mergeSkillsState(ctx: {
  userDataPath: string; backupSkillsRoot: string; incomingSkillsRoot: string;
}): { report: MergeReport; notices: ResultNotice[] };
```

- `disabled.json`：entries 按 `skillName` 去重并集；`trash.json`：entries 按 `id` 去重并集；索引原子写。
- 实体：`skills/disabled/d_<uuid>/`、`skills/trash/tr_<uuid>/` 缺失者从 `backup/skills/` 拷入（本地实体仍在原位则不重复拷）。
- `originalPath` 不存在（`!existsSync`）→ 条目追加 `missingPath?: true` 标注（仅展示用）；`resolution:'missing-path'` 进冲突清单；**不自动清洗条目、不重映射**（CON-R-backup-008）。

---

## 5. 门控与互斥

### 5.1 `canBackup` / `canRestore` 检查项

| 检查 | 备份 | 恢复（运行期） | 命中码 |
|:---|:---:|:---:|:---|
| exec `running` / `queued` 非空 | ✔（拒绝） | — | `backup-busy` |
| dsh 安装 / 升级进行中 | ✔ | ✔ | `backup-busy` / `update-in-progress` |
| Hull 自更新进行中 | ✔ | ✔ | `backup-busy` / `update-in-progress` |
| 已有 `pending.json` | ✔（拒绝） | ✔（拒绝，可先 cancel） | `restore-pending` / `restore-already-pending` |

### 5.2 调用点（主进程强制 + 渲染层 UX）

| 位置 | 调用 | 行为 |
|:---|:---|:---|
| `hull:backup` handler | `canBackup(deps)` | 不通过直接返回 `{ok:false, code, message}` |
| `hull:restore` handler（action=request） | `canRestore(deps)` | 同上 |
| `hull:restore` handler（action=cancel） | 仅 `step='requested'` | 删标记 |
| Hull 更新入口 / dsh 升级入口 | `canStartUpdate(deps)` | 有 pending → `{ok:false, code:'restore-pending'}`（互斥：写标记后禁用更新入口） |
| 渲染层设置页 | `hull:getBackupStatus` | 按 `canBackup/canRestore` 置灰按钮 + 提示原因 |

互补方向：更新进行中时 `canRestore` 直接拒绝（**更新时拒绝恢复**），双保险覆盖 Q-088 时序竞争。

---

## 6. 数据结构定稿

### 6.1 `manifest.json`（备份包根，见 §3.1）

### 6.2 `<userData>/.restore/pending.json`

| 字段 | 类型 | 必填 | 说明 |
|:---|:---|:---:|:---|
| `version` | `1` | ✔ | 结构版本 |
| `mode` | `'replace'\|'merge'` | ✔ | 双模式 |
| `phase` | `'forward'\|'rolling-back'` | ✔ | 正向/回滚，自愈判定关键位 |
| `step` | `'requested'\|'staged'\|'backedUp'\|'applied'\|'verified'` | ✔ | 最后完成步 |
| `sourceDir` | `string`（绝对） | ✔ | 备份包根 |
| `items` | `ScopeItemId[]` | ✔ | 本次涉及的项 |
| `createdAt` | ISO8601 | ✔ | — |
| `failAt` | `string \| null` | ✔ | e2e 注入点（生产恒 null） |

```json
{
  "version": 1,
  "mode": "replace",
  "phase": "forward",
  "step": "requested",
  "sourceDir": "/Users/liyuzhao/Backups/Hull备份-20260917-1305",
  "items": ["settings", "kanban", "workflows", "notes", "notes-trash", "skills", "notifs"],
  "createdAt": "2026-09-17T13:06:01.000Z",
  "failAt": null
}
```

### 6.3 `<userData>/.restore/result.json`

| 字段 | 类型 | 必填 | 说明 |
|:---|:---|:---:|:---|
| `version` | `1` | ✔ | — |
| `mode` | `'replace'\|'merge'` | ✔ | — |
| `status` | `'success'\|'rolledBack'\|'failed'` | ✔ | 结果可见（CON-R-backup-013） |
| `finishedAt` | ISO8601 | ✔ | — |
| `bakDir` | `string \| null` | ✔ | `.restore/backup` 绝对路径（人工兜底入口） |
| `notices` | `{code,message}[]` | ✔ | 如 `notes-dir-fallback` |
| `merge` | `MergeReport \| null` | ✔ | merge 模式填，replace 为 null |
| `error` | `{code,message} \| null` | ✔ | failed 时填 |

```json
{
  "version": 1,
  "mode": "merge",
  "status": "success",
  "finishedAt": "2026-09-17T13:10:44.000Z",
  "bakDir": "/Users/liyuzhao/Library/Application Support/dsh-hull-desktop/.restore/backup",
  "notices": [{ "code": "notes-dir-fallback", "message": "原笔记目录不存在，已回退默认目录" }],
  "merge": {
    "classes": { "note": { "added": 3, "updated": 0, "skipped": 1 } },
    "conflicts": [{ "kind": "note", "path": "a.md", "resolution": "renamed", "detail": "pkg → a (恢复冲突 20260917-131044).md" }],
    "notices": []
  },
  "error": null
}
```

### 6.4 `.restore/` 目录约定

```
.restore/
  pending.json      # 运行期写，收尾/取消时删
  result.json       # 启动期写，下次恢复覆盖
  incoming/         # staging（rename 式原子就绪）
  incoming.tmp/     # staging 中间态
  backup/           # 预备份（逐项原目录树；成功后保留供人工兜底）
```

`.restore/` 不属白名单项；守卫断言已排除（§3.3-5）。

---

## 7. 测试方案（B5）

### 7.1 单测（`src/backup/*.test.ts`，`node --test`）

| 对象 | 用例（要点） |
|:---|:---|
| `decideHeal`（纯函数） | 表驱动 ≥11 条，覆盖 §2.5 全表（含 #10/#11 manual、rolling-back 续做） |
| `nextStep` / `STEP_ORDER` | 边界：终点 `verified→null`；未知 step 抛错 |
| `checkCompatibility` | `manifestVersion` = 0 / 1 / 2 三态；`items[].version` > 当前 |
| `parseManifest` | 缺必填、类型错、额外字段容忍、`counts` 不一致 |
| `resolveNotesDir` | 相对路径 / `DSH_HOME` 内 / `<userData>/dsh` 内 / 不存在 → 回退 + notice |
| `mergeSettings` | 覆盖/保留本地独有/非法值回退/notesDir 回退 |
| `mergeNotes` | 同 hash 跳过、差异改名（含重名递增）、目录创建 |
| `mergeWorkflows` | id 冲突重 id、name 相同追加 |
| `mergeNotifications` | id 去重、cap 裁剪、dismiss 取新 |
| `isInsideUserData` / `resolveItemPaths` | 目标 = userData、子目录、realpath 符号链接绕过 |

### 7.2 integration（`tests/integration/backup/*.test.ts`，真 FS + 临时目录）

| 场景 | 构造 | 断言 |
|:---|:---|:---|
| 只读目标 | `chmod 0o500` 目标目录 | `backup-target-unwritable`；目标零残留；现数据 hash 不变 |
| ENOSPC | 注入 write 抛 `ENOSPC` | `backup-failed`；本次 `Hull备份-*` 被清理；现数据 hash 不变 |
| 目标在 userData 内 | `targetDir = <userData>/x` | `backup-target-inside-userdata`，零写入 |
| 高版本拒绝 | 手写 `manifestVersion=2` 包 | `restore-version-newer`；`pending.json` 未写；现数据 hash 不变 |
| 低版本迁移 | `settings.schemaVersion=3` + `boards.version=1` 包 | 预演通过；启动期后 settings=4、boards=2，内容值保留 |
| 迁移预演失败 | `boards.version=3`（高于当前） | 运行期 `restore-migrate-preview-failed`；不写标记；不触发 `backupAndRebuild` |
| 半成品自愈 | 手工构造 `step='staged'` + `incoming/` 缺文件 → `runRestoreIfPending` | `rolledBack`；现数据全部 hash 复原；`result.json.status='rolledBack'` |
| 回滚中断 | 构造 `phase='rolling-back'` + 部分项已回 | 续做完成回滚；幂等 |
| merge 冲突 | 本地/包内各一份同名不同内容笔记 + 同 id 工作流 | 双份笔记都在（改名规则命中）；工作流 id 重生成；`result.merge.conflicts` 非空 |
| 守卫断言 | 伪造含 `dsh/`、`Partitions/`、`token-buckets.json` 的包 | 校验失败拒绝 |

### 7.3 e2e（`tests/e2e/backup.spec.ts`，Playwright + `HULL_USER_DATA` 隔离）

```ts
const app = await launchApp({
  userData: tmp.dir,
  env: { HULL_E2E_FAIL_AT: 'restore-after-stage:exit' },   // ':exit' → app.exit(86) 制造崩溃窗口；缺省 → throw
});
await shellPage(app)!.evaluate(() => (window as any).hull.restore({ action: 'request', mode: 'replace', sourceDir: '<abs>' }));
```

| 用例 | 步骤 | 断言 |
|:---|:---|:---|
| happy（replace） | 备份 → 改 settings/boards → `hull:restore` → 重启（二次 `launchApp` 同 `tmp.dir`） | 目标目录含 7 项 + `manifest.json` 且不含 `dsh/`/`token-buckets.json`；重启后 settings = 包内、boards.version = 当前；`result.json.status='success'`；DOM 数据卡展示 |
| 高版本拒绝 | 手写 `manifestVersion=2` 包 → 请求恢复 | 返回 `restore-version-newer`；DOM 提示可见；无 `pending.json` |
| 半成品自愈 | `HULL_E2E_FAIL_AT=restore-after-stage:exit` 首次启动 → 二次启动 | `rolledBack`；数据复原；`result.json.status='rolledBack'` |
| merge | 本地/包内各一份笔记 + ticket；`mode:'merge'` → 重启 | 双方数据都在；冲突笔记改名；`result.merge.conflicts.length > 0` |
| 门控 | 执行中任务点备份 | `hull:backup` 返回 `backup-busy`；按钮禁用态 |

复用既有 `makeTempUserData` / `launchApp` / `__hullTest.quit`（tests/e2e/helpers.ts、cold-start.spec.ts）。

### 7.4 验收口径（CON-R-backup-016，可观察）

1. 备份：目标目录出现 7 项对应文件 + `manifest.json`；守卫断言通过。
2. 恢复（replace）：重启后 settings 值 = 包内、boards 迁移至当前版本、`.restore/backup/` 存在。
3. 拒绝路径：返回对应 kebab code，且现数据全量 hash 前后不变。
4. 结果可见：`result.json` 存在且数据卡展示最近一次结果。
5. merge：冲突清单非空且双方数据均可检索。

---

## 8. 风险与开放点

| # | 项 | 结论/延后 |
|:--|:---|:---|
| R1 | 逐文件 `sha256` 完整性校验 | v2（v1 用 size/fileCount + 可解析校验） |
| R2 | `.restore/backup/` 清理策略 | v1 保留最近一次 + 数据卡手动清理；自动策略 v2 |
| R3 | `Partitions/shell` 纳入 | v2（U-6） |
| R4 | `workflows/runs.json` 纳入 | v2（v1 明确排除） |
| R5 | 笔记 frontmatter 语义冲突（同 `task` 引用） | 不做（v1 仅文件级） |
| R6 | Windows 长路径 / rename EBUSY | v1：重试 + 明确文案；长路径前缀加固 v2 |
| R7 | 恢复期耗时（大 notes）启动反馈 | v1：启动画面文案"正在恢复数据"；进度条 v2 |
| R8 | Hull 已更新后执行恢复（appVersion 变化） | v1 照常执行（manifestVersion 区间已挡格式不兼容） |
| R9 | 备份包加密 | v2 |
| R10 | `.restore/backup/` 被手动删除 | 决策表 #9/#11 → `restore-manual-required`，不猜测 |

---

## 9. 冻结检查（实现对照 checklist）

① 白名单 7 项与 CON-R-backup-001 一致；② replace/merge 双模式均走"预备份 + 可回滚"；③ 运行期零数据副作用；④ `.restore/pending.json` 字段与 §6.2 一致；⑤ `canBackup/canRestore` 调用点齐（§5.2）；⑥ 迁移预演纯函数化，不在半应用状态下触发 `backupAndRebuild`；⑦ 错误码全部 kebab、无新增通道（仅三通道）。

## 10. 核验记录

> 交付核验时对照本方案逐项核验，偏离清单与处理结论记录于此。

| 日期 | 项 | 结论 |
|:-----|:---|:-----|
| — | 待实现完成后核验 | — |
