# Hull 桌面壳插件市场接口契约

## 契约信息

- 载体：飞书任务清单 `dsh-hull-desktop`（子需求：P1 `d57af7df` / P2 `7ee9c080` / P3 `235c90eb` / P4 `dccd870e` / P5 `b8ca1656`）
- 需求标识：`plugin-market`
- 契约状态：**已冻结**（2026-09-21；冻结 = 全部接口行已冻结）
- 适用版本：Hull ≥ 0.1.9 · dsh ≥ 0.1.5-rc.2（`dsh plugin` 子命令实测存在）
- 最后更新：2026-09-21
- OpenAPI：**不适用**——本地 IPC（Electron main ↔ renderer），无 HTTP API 面（registry 拉取为主进程出站请求，见 §8）
- 依据：共识 `docs/spec/共识-Hull桌面壳-插件市场.md` v2.1 · 调研 `docs/research/2026-09-21-plugin-market调研.md` v2

## 需求与共识追踪

| 能力 | 子需求 | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| dsh CLI 通道 + profile 管理 | P1 | CON-R-plugin-004/011/012 | P1 ①~④（ticket） | `hull:plugin*`（全部） | 已冻结 |
| registry 发现与白名单 | P2 | CON-R-plugin-002/005 | P2 ①~④ | `hull:pluginListRegistry` | 已冻结 |
| 安装/更新/卸载编排 | P3 | CON-R-plugin-004/005/007 | P3 ①~④ | `hull:pluginInstall/Update/Uninstall` | 已冻结 |
| 插件页 UI（双 tab） | P4 | CON-R-plugin-008/009/010 | P4 ①~⑤ | `hull:getPluginStatus` + 桥 | 已冻结 |
| 测试与验收（5 断言） | P5 | CON-R-plugin-010 | P5 ①~④ | —（测试面） | 已冻结 |

## 范围与非目标

### 范围

- 市场发现（plugins.json registry 拉取/缓存/snapshot）、白名单校验、安装/更新/卸载编排（**委托 `dsh plugin`**）、reconcile 状态回显、互斥门控、插件页 UI。

### 非目标

- 实现 dsh 侧插件能力（bundle 加载/热挂载——dsh 原生，Hull 只调用）；
- 自建注册表后端（registry = JSON 文件，提交=PR）；
- 插件签名/沙箱（v2，U-4/U-5）、versions.json 严格映射（v2，U-3）；
- 直接写 DSH_HOME（CON-R002：插件数据由 dsh 管理，Hull 经 `dsh plugin` 委托，只读回显）。

## 业务流程与状态

### 核心流程

```text
安装：市场选择 → hull:pluginInstall{entryId} → 主进程：白名单校验 → npm pack 临时解析 cordis.patch.yml（预览）
     → dsh plugin add --profile hull <url> → 验证（dsh 列表含 bundle + 文件就位）→ 回显（热挂载由 dsh 原生）
更新：版本检测（registry vs 已装）→ hull:pluginUpdate{id} → dsh 更新 → 回显
卸载：hull:pluginUninstall{id}（UI 二次确认后）→ dsh plugin remove → 回显
reconcile：进入插件页/启动 → hull:getPluginStatus → 主进程调 dsh 列表 → 匹配 registry 出 可更新/已装/未装
```

### 状态转换（安装编排）

| 当前 | 动作 | 目标 | 前置 | 冲突行为 | 依据 |
|---|---|---|---|---|---|
| idle | install 请求 | validating | 白名单通过、无 in-flight | 门控拒绝 `plugin-busy` | CON-R-plugin-004/009 |
| validating | pack 解析 | preview-ready | manifest 可解析 | 失败 → idle（原样报错） | Q-103/106 |
| preview-ready | 用户确认（渲染层） | installing | — | 取消 → idle | CON-R-plugin-005 |
| installing | dsh plugin add | verifying | 子进程成功 | 失败 → 清理该次痕迹 → idle | Q-103 |
| verifying | 验证 bundle 就位 | done | 列表含 bundle + 文件存在 | 失败 → 清理 → idle | Q-103 |
| 任一 | 互斥命中 | idle | 升级/自更新 in-flight | 拒绝 `plugin-busy` | CON-R-plugin-007 |

## 接口清单

> 均为 Electron IPC（`ipcRenderer.invoke` ↔ `ipcMain.handle`）；统一返回 `IpcResult<T> = {ok, code?, message?, data?}`；通道常量入 `src/shared/ipc-channels.ts` 的 `PLUGIN_IPC_CHANNELS` + `ALL_IPC_CHANNELS`。

| # | 状态 | 通道 | 用途 | 权限 | 幂等 |
|---|---|---|---|---|---|
| 1 | 已冻结 | `hull:pluginListRegistry` | 市场列表（registry 拉取/缓存/snapshot） | 渲染层经 preload 桥 | 只读（缓存幂等） |
| 2 | 已冻结 | `hull:getInstalledPlugins` | reconcile：已装插件（dsh 列表 + profile hull） | 同上 | 只读 |
| 3 | 已冻结 | `hull:pluginInstall` | 安装（白名单校验 + pack 预览 + 委托 add） | 同上 | 同 entry 重复请求 → `plugin-busy`（in-flight） |
| 4 | 已冻结 | `hull:pluginUpdate` | 更新（版本检测 + 委托） | 同上 | 同上 |
| 5 | 已冻结 | `hull:pluginUninstall` | 卸载（委托 remove） | 同上 | 已卸载 → `plugin-not-installed` |
| 6 | 已冻结 | `hull:getPluginStatus` | 门控/进行中/已装概览（UI 初始化） | 同上 | 只读 |
| 复用 | 已存在 | `dialog:pickDirectory` / `hull:openPath` / `hull:openDataDir` | 通用 | 既有 | 既有 |

## Schema 与枚举

### RegistryEntry（plugins.json 条目）

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|:---:|---|---|
| `name` | string | 是 | 非空 | 插件名（展示；**与 owner 组成稳定标识**） |
| `owner` | string | 否 | — | 作者/仓库 owner（缺省 `''`） |
| `url` | string | 是 | https | 安装源（npm / github:owner/repo / tgz，dsh 原生支持） |
| `category` | string | 否 | — | 分类（市场 tab 筛选） |
| `install` | string | 否 | — | 安装命令提示（dsh-market 兼容字段） |
| `deprecated` | boolean | 否 | 缺省 false | 弃用标记（UI 禁用安装 + 提示） |
| `minDshVersion` | string | 否 | semver | 最低 dsh 版本；低于当前 → preview 提示（不拦截） |

> **entryId 稳定标识 = `${name}#${owner}`（owner 缺省 `''` → `name#`）**——评审实证真实 registry 182 组重名（同 name 不同 owner/url），name 单键反查会装错插件；复合键逐字命中杜绝。渲染层与主进程统一用该复合键（`entryId()` helper 单点）。

### InstalledPlugin（reconcile 结果）

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `id` | string | 是 | bundle id（dsh 列表解析） |
| `name` | string | 是 | 名称 |
| `version` | string | 是 | 已装版本 |
| `registryVersion` | string \| null | 是 | registry 对应版本（可更新判定） |
| `status` | `'installed'\|'updatable'\|'deprecated'` | 是 | 状态徽标 |

### PluginPreview（安装前预览，Q-106）

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `id` | string | 是 | bundle id |
| `version` | string | 是 | 待装版本 |
| `patchSummary` | string \| null | 是 | cordis.patch.yml 摘要（解析失败 → null + `previewUnavailable` 标记，不阻断） |
| `sourceUrl` | string | 是 | 来源 URL（信任明示展示） |

### 错误码（kebab；UI 直接展示）

| 错误码 | 触发 | 渲染层处理 | 可重试 |
|---|---|:---:|:---:|
| `plugin-registry-unreachable` | registry 拉取失败且无 snapshot | 降级提示 + snapshot 可用标注 | 是 |
| `plugin-not-whitelisted` | URL 不在当前 registry 列表/非 https | 拒绝 + 提示 | 否 |
| `plugin-install-failed` | dsh add 失败/超时/验证失败 | 透传 dsh 输出摘要 | 是 |
| `plugin-update-failed` | 更新失败 | 同上 | 是 |
| `plugin-uninstall-failed` | 卸载失败 | 同上 | 是 |
| `plugin-profile-missing` | profile `hull` 创建/校验失败 | 提示 | 是 |
| `plugin-busy` | in-flight 或升级/自更新进行中 | 置灰 + 原因 | 是 |
| `plugin-not-installed` | 卸载/更新不存在的插件 | 提示 | 否 |
| `plugin-version-too-old` | minDshVersion 不满足（安装前提示，不强制拦截） | 提示 | 否 |

## 接口详情

### 1. 市场列表 `hull:pluginListRegistry`

- 用途：市场 tab 数据源（registry 拉取 + 1h 缓存 + snapshot 兜底 + 手动刷新）。
- 请求：`{ refresh?: boolean }`（refresh=true 强制重拉，忽略缓存；失败回落缓存/snapshot）。
- 成功：`data: { entries: RegistryEntry[], source: 'remote'|'cache'|'snapshot', fetchedAt?: string }`。
- 失败：`plugin-registry-unreachable`（entries 仍返回 snapshot/缓存数据，source 标注）。
- 幂等：缓存 TTL 内重复请求直接返回（时钟注入可测）。
- 测试要点：首次拉取 / 缓存命中 / 过期重拉 / registry 失败回落 snapshot / refresh 强制。

### 2. 已装列表 `hull:getInstalledPlugins`

- 用途：已安装 tab 数据源（reconcile：dsh 列表按 profile hull）。
- 成功：`data: { plugins: InstalledPlugin[] }`。
- 失败：dsh 不可达 → `{ok:false, code:'plugin-profile-missing', message}` + 渲染层降级（已安装 tab 降级提示）。
- 测试要点：reconcile 正常 / dsh 不可达降级 / 版本匹配出 updatable。

### 3. 安装 `hull:pluginInstall`

- 请求：`{ entryId: string }`（entryId = **`name#owner` 复合键**，主进程反查条目 URL——**不接受直接传 URL**，防白名单绕过）。
- 成功（两段式）：
  - 第一阶段（未确认）：`data: { stage: 'preview', preview: PluginPreview }` → 渲染层弹信任+变更明示确认；
  - 第二阶段（确认后）：`{ entryId, confirm: true }` → 执行安装 → `data: { stage: 'done', installed: InstalledPlugin }`。
- 失败：`plugin-not-whitelisted` / `plugin-install-failed` / `plugin-busy`。
- 幂等/并发：in-flight 期间重复请求 → `plugin-busy`。
- 副作用：`dsh plugin add --profile hull <url>`（子进程）；失败清理该次痕迹。
- 测试要点：白名单拒绝 / 预览解析 / 确认后安装 / add 失败清理 / 并发拒绝。

### 4. 更新 `hull:pluginUpdate`

- 请求：`{ id: string }`。
- 成功：`data: { updated: InstalledPlugin }`。
- 失败：`plugin-update-failed` / `plugin-not-installed` / `plugin-busy`。
- 测试要点：更新成功版本变化 / 未安装拒绝 / 失败透传。

### 5. 卸载 `hull:pluginUninstall`

- 请求：`{ id: string }`（UI 二次确认后）。
- 成功：`data: { removed: true }`。
- 失败：`plugin-uninstall-failed` / `plugin-not-installed`。
- 测试要点：卸载成功 / 二次确认在渲染层 / 失败透传。

### 6. 状态 `hull:getPluginStatus`

- 用途：插件页初始化（门控可操作态 + 进行中 + 已装概览）。
- 成功：`data: { canOperate: GateResult, inflight: null | {kind,id}, installedCount: number }`。
- 失败：只读，异常 → `io-error`。
- 测试要点：门控矩阵（升级/自更新 in-flight → canOperate=false）。

## 联调与测试场景

| 场景 | 前置 | 动作 | 预期 | 验收编号 |
|---|---|---|---|---|
| 市场加载 | registry 可达 | `pluginListRegistry` | entries + source=remote | P2 ① |
| 市场降级 | registry 不可达 | 同上 | snapshot 数据 + `plugin-registry-unreachable` | P2 ④/P5 |
| 白名单拒绝 | entryId 不存在/URL 非 https | `pluginInstall{entryId}` | `plugin-not-whitelisted`，零副作用 | P2 ②/P5 |
| 安装预览 | 白名单通过 | `pluginInstall{entryId}` | stage=preview + patchSummary | P3 ① |
| 安装完成 | confirm | `pluginInstall{entryId, confirm:true}` | dsh 列表含 bundle + done | P3 ①/P5 |
| 安装失败清理 | add 失败（注入） | 同上 | `plugin-install-failed` + 无残留 | P3 ① |
| 更新 | 版本旧 | `pluginUpdate{id}` | version 变化 | P3 ②/P5 |
| 卸载 | 已装 | `pluginUninstall{id}` | removed + 列表消失 | P3 ③/P5 |
| 门控互斥 | 升级 in-flight | 任一插件操作 | `plugin-busy` | P3 ④ |
| reconcile | 进入插件页 | `getInstalledPlugins` | 状态匹配（可更新/已装） | P1 ③/P4 |
| minDshVersion | 当前 dsh 过低 | 安装 | 提示（不拦截） | P2 ③ |
| e2e 隔离 | HULL_E2E | 全流程 | fake dsh mock + 本地 registry fixture | P5 ① |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| — | 无未关闭项（扫描 Q-101~Q-117 全闭环） | — | v2 候选见共识 U-2~U-6 | closed |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| `dsh plugin` 子命令参数面（add/update/remove/list + --profile）以实测为准（v0.1.5-rc.2 已确认存在 plugin 子命令，缺 --profile 报错） | dsh（外部） | BE | 实现 P1 前 | 已确认存在；参数面实现时实测 |
| registry 默认源（社区 dsh-market plugins.json）可达性与结构 | dsh-market（外部） | PM | 实现 P2 前 | 已确认存在；实现时以 snapshot 兜底 |

## 完成记录

> 交付后填写。

| 项 | 结果 |
|:---|:-----|
| 交付时间 | 2026-09-21（feature/plugin-market） |
| 验证结果 | 单测 1343/1343 ✅ · integration 40/40 ✅ · e2e plugins 3/3（5 断言）+ cold-start 4/4 ✅ · semgrep 0 ✅ · tsc 0 ✅ |
| 构建/发布 | 未发布（待用户验收后走 PR 合并） |
| 偏差处理 | oracle 评审 1 轮全修（🔴2/🟠4/🟡 关键 4）；设计级偏离 D1~D5 已回写设计核验记录（见 `docs/records/plugin-market-record.md` §四） |

## 决策与踩坑

- **委托 dsh 而非自造**：插件安装/更新/卸载全部走 `dsh plugin`（官方扩展点）——零自造格式、热挂载/生命周期 dsh 兜底；Hull 只做白名单 + 编排 + 回显。复用场景：凡宿主工具已有官方插件机制的壳，市场层只做发现与编排。
- **白名单「逐字命中」而非前缀匹配**：安装请求只传 entryId，主进程反查 registry 条目 URL——防渲染层注入任意 URL 绕过白名单。复用场景：一切「白名单 + 用户可触发安装」的入口。
- **`--profile` 独立管理**：插件装到独立 profile `hull`，不污染用户业务 profile；reconcile 只读该 profile，避免与用户手工装的插件混淆。复用场景：托管工具为宿主创建专属 profile/workspace。
- **两段式安装（预览→确认）**：先 pack 解析 patch 摘要给用户看「装了什么配置」，确认后才执行——高权限操作的信任建立模式。复用场景：任何「安装前需展示副作用」的功能。

## 变更记录

| 时间 | 类型 | 摘要 |
|---|---|---|
| 2026-09-21 | 变更（评审同步） | ① entryId 升级为 `name#owner` 复合键（评审实证 182 组重名装错风险）；② registry 默认源统一 awesome-dsh-plugin.com（与 snapshot 同源）；③ minDshVersion 提示链落地（preview.versionTooOld）；④ 门控字段对齐（canOperate.ok/message）；⑤ 市场列表懒加载（top-100） |

## 自检记录

- 追踪完整性：PASS（每接口可追溯至子需求/共识规则/验收）
- OpenAPI 一致性：不适用（本地 IPC）
- 示例与错误场景：PASS（请求/成功/失败示例齐；错误码表含触发与处理）
- 安全与敏感字段：PASS（URL 不经渲染层直传、白名单逐字命中、DSH_HOME 不直写）
- 链接与格式：PASS（引用路径有效）
