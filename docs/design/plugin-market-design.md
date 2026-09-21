# 插件市场（plugin-market）技术方案

> 需求标识：`plugin-market` · 判级：**复杂**（新模块 + dsh CLI 子进程通道 + 外部 registry 集成 + 安全敏感安装路径 + 新导航视图）→ 本文即方案冻结输入
> 依据：共识 `docs/spec/共识-Hull桌面壳-插件市场.md` v2.1（CON-R-plugin-001~012）、调研 `docs/research/2026-09-21-plugin-market调研.md` v2、契约 `docs/api/feishu-plugin-market-api-contract.md`（已冻结）
> 子需求：P1 dsh CLI 通道 / P2 registry 发现与白名单 / P3 安装编排 / P4 插件页 UI / P5 测试验收（ticket：d57af7df / 7ee9c080 / 235c90eb / dccd870e / b8ca1656）
> 状态：**已冻结**（2026-09-21，owner 评审通过）

**全局不变量**

1. 插件一切能力走 dsh 官方扩展点：Hull **只调用 `dsh plugin` CLI**，不直接写 `$DSH_HOME`（CON-R002 精神：dsh 数据官方化；CON-R004 合规）。
2. 安装请求只接受 `entryId`（主进程反查 registry URL），渲染层不传 URL（白名单防绕过）。
3. 插件操作与 dsh 升级/壳自更新互斥（复用 backup 门控模式）。
4. 所有 dsh 子进程调用统一走 `DshCliRunner`（单一通道，超时/解析/互斥一处收敛）。

---

## 1. 模块划分与文件结构

```
src/plugins/
  cli.ts           # DshCliRunner：dsh CLI 子进程通道（P1）
  profile.ts       # profile 'hull' 管理（创建/校验存在性）（P1）
  registry.ts      # plugins.json 拉取/1h 缓存/snapshot 兜底/时钟注入（P2）
  whitelist.ts     # 来源白名单校验（逐字命中 registry 条目 + https）（P2）
  manifest.ts      # npm pack 临时解析 cordis.patch.yml → PluginPreview（P3）
  installer.ts     # 安装/更新/卸载编排状态机（P3）
  gate.ts          # canOperatePlugin 门控（复用 backup gate 语义）（P3）
  PluginsIpc.ts    # IPC 注册 + 返回形状（P4 接线）
  types.ts         # RegistryEntry/InstalledPlugin/PluginPreview/错误码
```

**子需求 ↔ 文件**：P1 → `cli/profile`；P2 → `registry/whitelist`；P3 → `manifest/installer/gate`；P4 → `PluginsIpc` + `src/shared/ipc-channels.ts` + `src/preload/index.ts` + `src/renderer/plugins.js` + shell.html section；P5 → 各 `*.test.ts` + `tests/integration/plugins/*` + `tests/e2e/plugins.spec.ts`。

### 1.1 cli.ts — DshCliRunner（P1）

```ts
export type DshPluginCommand = 'add' | 'update' | 'remove' | 'list';

export interface DshCliOptions {
  userDataPath: string;      // overlay bin 解析（resolveNodePath）
  profile: string;           // 默认 'hull'（CON-R-plugin-012）
  timeoutMs?: number;        // 默认 120_000
  logger: RuntimeLogger;
  now?: () => Date;
  failAt?: string;           // HULL_E2E_FAIL_AT（仅 HULL_E2E=1）
}

export class DshCliRunner {
  run(cmd: DshPluginCommand, args: string[]): Promise<DshCliResult>;
  // DshCliResult = { ok:true, stdout, parsed? } | { ok:false, code, message, stderrTail }
}

// 实现要点：
// - spawn(node, [bin, 'plugin', '--profile', profile, cmd, ...args], { env: { ...process.env }, stdio: ['pipe','pipe','pipe'] })
//   bin = join(userDataPath, 'dsh', 'bin', 'dsh')（overlay；resolveNodePath 解析 node）
// - 输出解析：优先 JSON（dsh 若支持 --json）；否则行解析/整段捕获，失败路径透传 stderrTail（截断 2KB）
// - 超时：120s 硬超时 → kill(SIGTERM) → 5s 宽限 → SIGKILL → plugin-install-failed(timeout)
// - 与升级互斥：runner 内部 in-flight 计数 + 调用方 gate 前置
// - DSH_HOME：不注入（dsh 管理自己的 $DSH_HOME；Hull 不触碰）
```

### 1.2 profile.ts — profile 'hull' 管理（P1）

```ts
export const HULL_PLUGIN_PROFILE = 'hull';

// ensureProfile(): 调 dsh 列表/校验 profile 存在；不存在 → dsh 侧创建（插件操作前置）
// 只读 reconcile：list 解析按 profile 过滤 bundles
```

### 1.3 registry.ts — 市场数据（P2）

```ts
export interface RegistryOptions {
  url: string;              // 默认社区 dsh-market plugins.json（settings.pluginRegistry 可配）
  cacheTtlMs: number;       // 默认 1h
  snapshotPath: string;     // 打包 assets/plugins-registry-snapshot.json（内置兜底）
  fetchImpl?: typeof fetch; // 注入可测
  now?: () => Date;
  logger: RuntimeLogger;
}

export async function loadRegistry(opts, forceRefresh: boolean):
  Promise<{ entries: RegistryEntry[]; source: 'remote'|'cache'|'snapshot'; fetchedAt?: string }>;
// 拉取 → 内存缓存（TTL）→ 失败回落 snapshot/缓存 → 降级标记
// 快照打包：构建脚本复制 assets/plugins-registry-snapshot.json（实现时从社区 registry 生成初始快照）
```

### 1.4 whitelist.ts — 白名单（P2）

```ts
export function isWhitelisted(entryId: string, entries: RegistryEntry[]): RegistryEntry | null;
// entryId 必须逐字命中列表条目稳定标识（实现 = name 或 name+owner 组合）；条目 url 必须 ^https://
// 防注入：渲染层只传 entryId；URL/install 字段一律由主进程从条目反查，不拼接用户输入
```

### 1.5 manifest.ts — 安装预览（P3）

```ts
export async function previewBundle(url: string, tmpRoot: string): Promise<PluginPreview>;
// npm pack <url> 到临时目录（只读解析，不安装）→ 读 package.json#dsh.bundle + cordis.patch.yml → 摘要
// 解析失败 → previewUnavailable + 不阻断（安装仍可继续，提示无法预览）
// 临时目录用完即清
```

### 1.6 installer.ts — 编排状态机（P3）

```ts
export type InstallStep = 'idle' | 'validating' | 'preview-ready' | 'installing' | 'verifying' | 'done';

export class PluginInstaller {
  install(entryId): { preview }  // 白名单 → preview（两段式第一段）
  install(entryId, confirm): { installed }  // 确认后：dsh add → verify → done
  update(id): { updated }
  uninstall(id): { removed }
  // 失败清理：add 失败/验证失败 → 调 dsh remove（该次痕迹）→ 回 idle + 报错
  // in-flight 单飞：并发请求 → plugin-busy
}
```

### 1.7 gate.ts — 门控（P3）

```ts
export function canOperatePlugin(deps: GateDeps): GateResult;
// 复用 backup gate：dsh 升级/安装中、壳自更新中、插件 in-flight → 拒绝（plugin-busy）
// 接线：既有更新入口（upgradeDsh/downloadHullUpdate/rollbackDsh）前置插件 in-flight 检查（反向互斥）
```

### 1.8 PluginsIpc.ts + 装配（P4）

- 6 通道 `hull:pluginListRegistry / getInstalledPlugins / pluginInstall / pluginUpdate / pluginUninstall / getPluginStatus` 入 `PLUGIN_IPC_CHANNELS` + `ALL_IPC_CHANNELS`（计数断言同步，64→70）；
- `src/main/index.ts`：`registerPluginsIpc({ cli, registry, installer, gate })`；bootstrap 装配（与 backup 服务并列）；
- preload 挂 `window.hull.plugin*`。

### 1.9 renderer（P4）

- `shell.html`：新增 `section#plugin`（nav「插件」在 Skills 后）+ view 状态机新增 `plugin` 态（复用 board/notes 模式）；
- `src/renderer/plugins.js`：市场/已安装双 tab、安装两段式确认（信任 + patch 预览）、卸载确认、降级空态、kebab 错误码映射（参照 tokens.js/skills.js 模式）。

---

## 2. 关键流程与状态机

### 2.1 安装（两段式）

```
market tab 点安装 → hull:pluginInstall{entryId}
  → gate（无 in-flight/升级）→ whitelist（反查条目）→ previewBundle（npm pack 临时解析）
  → 返回 stage=preview（信任+patch 摘要展示）
用户确认 → hull:pluginInstall{entryId, confirm:true}
  → dsh plugin add --profile hull <url>（120s 超时）
  → verify（dsh list 含 bundle + profile 文件就位）
  → 回显 installed（热挂载由 dsh 原生，通常免重启）
失败 → 清理该次痕迹（dsh remove）→ 报 plugin-install-failed（透传 stderr 摘要）
```

### 2.2 更新 / 卸载

```
更新：registry vs installed 版本 → hull:pluginUpdate{id} → dsh 更新 → 回显（dsh 侧管理旧版）
卸载：UI 二次确认 → hull:pluginUninstall{id} → dsh plugin remove → 回显
```

### 2.3 reconcile

```
进入插件页/启动 → hull:getInstalledPlugins → dsh list（profile hull）→ 与 registry 匹配
  → InstalledPlugin.status（installed / updatable / deprecated）
dsh 不可达 → plugin-profile-missing 降级（已安装 tab 提示 + 市场 tab 可浏览）
```

### 2.4 崩溃/异常

- dsh 子进程超时/被杀 → 明确错误码 + stderr 摘要；in-flight 复位；
- 安装中断（应用退出）→ dsh 侧 add 已完成则下次 reconcile 可见；未完成则由 dsh 侧状态为准（Hull 不猜测）；
- registry 拉取失败 → snapshot/缓存兜底（数据可用性优先）。

---

## 3. 数据结构定稿

### 3.1 RegistryEntry / InstalledPlugin / PluginPreview

见契约 §Schema（字段与类型以契约为准，类型定义在 `src/plugins/types.ts` 单点）。

### 3.2 设置项（settings.json 字段级扩展，不 bump schemaVersion）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `pluginRegistry` | string | 社区 dsh-market plugins.json URL | registry 源（可配） |

### 3.3 状态/结果

- 安装编排 step（§1.6）；IPC 返回统一 `{ok, code?, message?, data?}`（契约 §接口清单）。

---

## 4. 安全设计

1. **白名单逐字命中**：渲染层只传 entryId；URL/install 由主进程反查；非 https 拒绝（Q-105）。
2. **两段式确认**：安装前展示来源 + patch 摘要（Q-106）；卸载二次确认。
3. **不直写 DSH_HOME**：一切经 `dsh plugin`（CON-R002/CON-R004）。
4. **禁 build script**：dsh/pnpm 默认行为（Hull 不传放开参数）。
5. **超时/互斥**：120s 硬超时 + 与升级/自更新互斥（gate）。
6. 错误信息不泄敏感内容（stderr 截断 2KB；不含 token/路径全量）。

---

## 5. 测试方案（P5）

### 5.1 单测（`src/plugins/*.test.ts`）

| 对象 | 用例 |
|:---|:---|
| `whitelist` | entryId 命中/未命中/url 非 https/大小写敏感 |
| `registry` | 首拉/cache 命中/过期重拉/失败回落 snapshot/refresh 强制（时钟注入） |
| `manifest` | pack 解析 patch 摘要/解析失败 previewUnavailable/临时目录清理 |
| `installer` | 状态机全路径（含失败清理、并发 plugin-busy） |
| `gate` | 门控矩阵（升级/自更新/in-flight） |
| `cli` | 参数组装（--profile hull）/超时 kill/非零退出透传/JSON vs 文本解析 |

### 5.2 integration（`tests/integration/plugins/*.test.ts`，真 FS + 临时目录）

- fake dsh 插件子命令 mock（HULL_E2E）：`plugin add/update/remove/list --profile hull` → fixture profile/bundle 状态；
- registry 本地 fixture（`HULL_E2E_REGISTRY` file:// 或临时 http server）；
- 安装→验证→卸载全链；白名单拒绝零副作用；add 失败清理；registry 不可达 snapshot 兜底。

### 5.3 e2e（`tests/e2e/plugins.spec.ts`，HULL_USER_DATA 隔离）

- 验收 5 断言：安装生效（fake dsh bundle 可见）/ 更新版本变化 / 卸载恢复 / 白名单外拒绝 / registry 不可达降级（snapshot 可用）；
- 注入点：`HULL_E2E_REGISTRY`、`HULL_E2E_FAIL_AT=plugin-add:exit`（崩溃窗口可测，沿用 backup 模式）。

---

## 6. 风险与开放点

| # | 项 | 结论/延后 |
|:--|:---|:---|
| R1 | `dsh plugin` 子命令参数面（add/update/remove/list + --profile）以实测为准 | v0.1.5-rc.2 已确认存在 plugin 子命令；参数面实现时实测 + 契约协调事项 |
| R2 | 热挂载行为随 dsh 版本差异 | 按 dsh 能力；Hull 回显「已生效」以 dsh 侧为准（U-6） |
| R3 | registry 默认源可用性 | snapshot 兜底 + 可配 URL（settings.pluginRegistry） |
| R4 | npm pack 预览成本（网络） | 仅安装前一次；失败降级「无法预览」不阻断（Q-106） |
| R5 | 插件签名/哈希（U-4/U-5） | v2 |
| R6 | 严格 versions.json 映射（U-3） | v2（v1 用 minDshVersion 提示） |
| R7 | 官方桌面壳市场未来上线（U-2） | 评估接入官方 registry |

## 7. 核验记录

> 交付核验时对照本方案逐项核验，偏离清单与处理结论记录于此。

| 日期 | 项 | 结论 |
|:-----|:---|:-----|
| — | 待实现完成后核验 | — |
