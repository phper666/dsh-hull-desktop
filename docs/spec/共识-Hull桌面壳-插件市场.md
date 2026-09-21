# Hull 桌面壳（插件市场）共识文档

> 版本：v2.1 · 更新：2026-09-21 · 维护者：phper666（PM） · 状态：已发布（基线）
> 数据来源：Hull Plugin Market PRD（docs/prd/2026-09-07-plugin-market-prd.md）+ 调研（docs/research/2026-09-21-plugin-market调研.md，v2 含外部查证）
> 关联：新增需求；需求标识 `plugin-market`（PRD slug）；本模块不涉及多期拆分

## 1. 文档元信息

- **本版本变更**：**v2.1**——三角色扫描 Q-101~Q-117 全数闭环回写（新增 §4.9 扫描定案 + CON-R-plugin-011/012：dsh CLI 通道服务 / `--profile` 独立管理策略）。
- **历史变更摘要**：v2.0（架构级推翻 v1.0）——外部调研确认 dsh 官方插件机制（bundle/profile/`dsh plugin add`/热挂载）且 dsh 无官方市场、官方桌面壳市场 "COMING SOON"、社区 `dsh-market` 完整实现可参考 → 插件形态从「壳插件自造格式」改为「**对接 dsh 官方插件生态**」。规则 CON-R-plugin-001~010 全量重写；U-1 关闭、U-2~U-6 重登记。
- **历史变更摘要**：v1.0（2026-09-21）——壳插件形态（npm 包 + hull-plugin.json 主进程加载）；**被 v2.0 推翻**。
- **状态说明**：v2.0 已发布（基线）。**扫描/拆子需求未跑**——随实现启动补。

## 2. 文档结构总览

- **覆盖**：Hull 插件市场全部业务面——插件形态（dsh 官方 bundle/profile）、发现（plugins.json registry）、安装/更新/卸载（委托 `dsh plugin`）、安全模型（来源白名单 + 哈希 + 信任明示）、入口与 UI、互斥门控、降级与验收。
- **适用范围**：Hull 市场层（发现/编排/回显）；插件本体与数据由 **dsh 管理**（$DSH_HOME/profiles、bundles，Hull 只读回显，CON-R002 精神）。
- **不做事项**（详见 §12）：自造平行插件格式 / 自建中心化注册表后端 / 实现 dsh 侧插件能力 / 插件沙箱（dsh 侧） / 热挂载自研 / 支付评分。

## 3. 领域术语表

| 术语 | 定义 | 出处 |
|:-----|:-----|:-----|
| bundle | dsh 官方插件形态：npm 包声明 `package.json#dsh.bundle` + `cordis.patch.yml`（`--patch` overlay 结构化版本） | 调研 §一 |
| profile | `$DSH_HOME/profiles/<name>`，声明 `dsh.profile.bundles` 有序组合 | 调研 §一 |
| dsh plugin add | dsh 官方安装原语（转发 pnpm；reconcilePlugins 自动登记 bundle） | 调研 §一 |
| plugins.json registry | 市场发现列表：JSON 数组指向 GitHub repo（name/owner/url/category/install/deprecated/minDshVersion）；提交=对 registry repo 提 PR | 调研 §二/§三 |
| 热挂载 | dsh 原生能力（ctx.pluginManager）：插件安装后无需重启即生效 | 调研 §一 |
| 来源白名单 | 仅允许 registry 列表内 URL 安装插件 | 调研 §三 |

## 4. 功能需求（PRD + 调研提取）

### 4.1 插件形态（FR-1）

- 插件 = **dsh 官方插件**（bundle + profile；CON-R004 完全合规：跑在 dsh 内的功能走官方扩展点）。
- **Hull 不造平行插件格式**；`hull-plugin.json` 概念废弃（v1.0 产物）。
- 插件数据（profiles/bundles）由 dsh 管理，Hull 只读回显（CON-R002 精神）。

### 4.2 发现（FR-2）

- 市场数据源 = **plugins.json registry**（JSON 指向 GitHub repo，参照 dsh-market / Obsidian / Claude Code 同构协议）。
- 缓存策略：内存缓存（1h）+ 内置 snapshot 兜底；registry 不可达 → 降级提示 + 本地已安装管理不受影响。
- 条目字段：name / owner / url / category / install / deprecated / minDshVersion。

### 4.3 生命周期（FR-3，委托 dsh）

- **安装**：选择插件 → 二次确认（来源 + 配置变更明示）→ URL 白名单校验 → 委托 `dsh plugin add` → 验证可加载 → 回显结果（热挂载 dsh 原生，通常免重启）。
- **更新**：registry 版本检测 → 委托 dsh 更新 → 旧版由 dsh 侧处理（profile/bundle 管理）。
- **卸载**：二次确认 → 委托 `dsh plugin remove` → 回显。
- Hull 角色 = 编排 + 状态回显，不实现 dsh 侧逻辑。

### 4.4 安全模型（FR-4）

- 来源白名单（仅 registry 列表内 URL）+ 安装前 bundle manifest 校验（`dsh.bundle` 存在性）+ 哈希校验（release asset SHA，若 registry 提供）+ pnpm 禁 build script（dsh 默认行为）+ **配置变更明示**（patch 层改了什么，安装前展示）+ 破坏性操作二次确认。

### 4.5 入口与 UI（FR-5）

- 壳导航新增「插件」入口（Skills 检查器之后）；两 tab：市场浏览（远程）/ 已安装管理（列表/更新/卸载/状态）；复用 skills 检查器 UI 模式。

### 4.6 互斥与门控（FR-6）

- 插件安装/更新进行中 → 禁用 dsh 升级与壳自更新入口（复用 backup 门控先例）；反之亦然。

### 4.7 降级与兼容（FR-7）

- registry 不可达 → snapshot/缓存兜底 + 远程 tab 降级提示。
- 条目 `minDshVersion`：当前 dsh 版本低于要求 → 安装前提示（不自动阻止；严格 versions.json 映射表 v2）。

### 4.8 验收口径（FR-8）

- 安装 → 插件在 dsh 侧生效（能力可见/热挂载）；更新 → 版本变化生效；卸载 → 恢复；registry 不可达 → 降级可用；白名单外 URL → 拒绝安装。

## 4.9 扫描定案补充（v2.1，Q-101~Q-117 闭环）

> 三角色扫描全数闭环（BE 8 / FE 5 / QA 4），结论回写本节 + 规则 011/012。

- **dsh CLI 通道（Q-101 → CON-R-plugin-011）**：主进程新建 dsh CLI 子进程服务——`spawnArgs.resolveNodePath` + overlay bin + DSH_HOME 环境隔离 + 120s 超时 + 统一 exit code/输出解析（JSON 优先）；与 dsh 升级/ACP 并发互斥；供 IPC。
- **`--profile` 策略（Q-102 → CON-R-plugin-012）**：独立管理 profile `hull`（不污染用户业务 profile）；创建/校验存在性；reconcile 只读该 profile 的 bundles。
- **安装事务性（Q-103）**：先校验（白名单+manifest）→ `dsh plugin add` → 验证（dsh 列表含该 bundle 且文件就位）→ 失败清理该次痕迹并回显；不做跨命令回滚。
- **registry 实现（Q-104/116）**：URL 可配（默认社区 dsh-market registry）；1h 内存缓存 + 内置 snapshot 兜底（打包 assets）+ 手动刷新；时钟可注入（测试）。
- **来源白名单实现（Q-105）**：URL 必须**逐字命中当前 registry 列表对应条目** + scheme 仅 https；不接受列表外 URL；命令参数不拼接用户输入。
- **配置变更明示（Q-106）**：安装前 `npm pack` 临时目录只读解析 `cordis.patch.yml` 展示；解析失败不阻断但提示「无法预览配置变更」。
- **reconcile（Q-107）**：进入插件页/启动 reconcile；dsh 不可达 → 已安装 tab 降级 + 市场 tab 可浏览；状态匹配 registry 出 可更新/已装/未装。
- **互斥门控（Q-108）**：复用 backup `canBackup` 式门控（in-flight 标志 + IPC 前置）；插件操作期间禁用 dsh 升级/壳自更新入口（反向同）。
- **UI（Q-109~113）**：nav「插件」态（Skills 后）+ 市场/已安装双 tab；安装 = 信任 + patch 预览确认 → 进度 → 结果；卸载二次确认；降级空态（dsh 未装引导 / registry 不可达）；错误码 kebab（`plugin-registry-unreachable` / `plugin-install-failed` / `plugin-profile-missing` / `plugin-not-whitelisted`）。
- **QA（Q-114~117）**：fake dsh 扩展 plugin 子命令 mock + 本地 registry fixture（`HULL_E2E_REGISTRY`，file:// 或临时 server）；验收 5 条断言（安装生效/更新版本/卸载恢复/白名单外拒绝/registry 降级）；缓存时钟注入；边界（manifest 损坏 / 白名单边界 / 命令超时 120s / 非零退出透传摘要）。

## 5. 流程与状态

| 流程 | 步骤 | 失败行为 |
|:-----|:-----|:---------|
| 安装 | 市场选择 → 信任/变更明示确认 → 白名单校验 → `dsh plugin add` → 验证可加载 → 回显 | dsh 侧失败 → 原样报错，零改动 |
| 更新 | 版本检测 → 委托 dsh 更新 → 回显 | 失败 → dsh 侧回滚/报告 |
| 卸载 | 二次确认 → `dsh plugin remove` → 回显 | 失败 → 报告 |
| 状态同步 | Hull 启动/进入插件页时 reconcile（读 dsh 已装插件列表） | dsh 不可达 → 降级提示 |

## 6. 异常分支

- registry 不可达 → snapshot/缓存 + 降级提示。
- dsh 未安装/不可达 → 插件页降级（引导先装 dsh）。
- bundle manifest 损坏 → 拒绝安装，报告。
- minDshVersion 不满足 → 安装前提示。
- 白名单外 URL → 拒绝 + 提示。

## 7. 安全与红线

- **CON-R004**：插件 = dsh 官方扩展点（bundle/profile），Hull 仅市场层，不旁路官方机制。
- **CON-R002 精神**：插件数据由 dsh 管理（$DSH_HOME/profiles、bundles），Hull 只读回显不写。
- **CON-R003**：插件操作与 dsh 升级/壳自更新互斥。
- 来源白名单 + 哈希 + 禁 build script + 配置变更明示（v1 安全基线；签名/沙箱 v2）。

## 8. 未决项登记

| 编号 | 问题 | 负责人 | 阻断等级 | 状态 | 结论 | 回写位置 |
|:-----|:-----|:-------|:---------|:-----|:-----|:---------|
| U-1 | dsh 官方插件协议调研 | PM | — | **closed** | v2.0 已调研（bundle/profile/plugin add/热挂载；无官方市场） | §4.1 |
| U-2 | 官方桌面壳市场（COMING SOON）未来接入 | PM | P2 | open | — | §4.2（官方 registry 上线时） |
| U-3 | 严格 versions.json 兼容映射表 | PM | P2 | open | — | §4.7（v2） |
| U-4 | 哈希校验增强（registry 提供 asset SHA） | PM | P2 | open | — | §4.4（v2） |
| U-5 | 插件签名验证 | PM | P2 | open | — | §4.4（v2） |
| U-6 | dsh 版本差异下的热挂载兼容性 | PM | P2 | open | — | §4.3（按 dsh 能力） |

## 9. 扫描待确认项

> **Q-101~Q-117 全部 closed**（2026-09-21，三角色扫描：BE 8 / FE 5 / QA 4）。结论已全数回写本共识 v2.1（§4.9 扫描定案 + CON-R-plugin-011/012）；载体：飞书 q-item 清单 `dsh-hull-desktop-q-item`。

## 10. 规则编号（CON-R-plugin-001~010）

| 编号 | 规则 | 来源 | 当前结论 | 变更状态 |
|:-----|:-----|:-----|:---------|:---------|
| CON-R-plugin-001 | 插件形态 = dsh 官方插件（npm bundle `dsh.bundle` + cordis.patch.yml + profile 组合）；Hull 不造平行格式；CON-R004 合规 | 调研 v2 §一 | 生效 | v2.0 重写 |
| CON-R-plugin-002 | 发现 = plugins.json registry（JSON 指向 GitHub repo；提交=PR）；内存缓存 1h + snapshot 兜底 | 调研 v2 §二/§三 | 生效 | v2.0 重写 |
| CON-R-plugin-003 | 分发 = npm / github:owner/repo / tgz（dsh 原生）；registry 条目声明安装源与 minDshVersion | 调研 v2 §一/§三 | 生效 | v2.0 重写 |
| CON-R-plugin-004 | 生命周期委托 `dsh plugin add/update/remove`（Hull 编排：白名单校验 → 执行 → 验证可加载 → 回显）；热挂载 dsh 原生 | 调研 v2 §一 | 生效 | v2.0 重写 |
| CON-R-plugin-005 | 安全：来源白名单（仅 registry URL）+ bundle manifest 校验 + 哈希校验 + pnpm 禁 build script + 配置变更明示 + 二次确认 | 调研 v2 §三 | 生效 | v2.0 重写 |
| CON-R-plugin-006 | 插件数据由 dsh 管理（$DSH_HOME/profiles、bundles）；Hull 只读回显，不写 DSH_HOME（CON-R002 精神） | 调研 v2 §四 | 生效 | v2.0 重写 |
| CON-R-plugin-007 | 互斥门控：插件安装/更新进行中禁用 dsh 升级与壳自更新入口（反之亦然） | 调研 v2 §四 | 生效 | v2.0 重写 |
| CON-R-plugin-008 | 入口 = 壳导航「插件」页（Skills 检查器后），市场浏览/已安装管理双 tab | 调研 v2 §三 | 生效 | v2.0 重写 |
| CON-R-plugin-009 | 降级：registry 不可达 → snapshot/缓存 + 提示；dsh 不可达 → 插件页降级引导；minDshVersion 不满足 → 安装前提示 | 调研 v2 §三 | 生效 | v2.0 重写 |
| CON-R-plugin-010 | 验收口径：安装→dsh 侧生效 / 更新→版本生效 / 卸载→恢复 / 白名单外拒绝 / registry 不可达降级 | 调研 v2 §四 | 生效 | v2.0 重写 |
| CON-R-plugin-011 | dsh CLI 通道服务：spawnArgs + overlay bin + DSH_HOME 隔离 + 120s 超时 + 统一输出解析；与 dsh 升级/ACP 互斥 | Q-101 扫描定案 | 生效 | v2.1 新增 |
| CON-R-plugin-012 | `--profile` 独立管理策略：插件装到独立 profile `hull`（不污染用户业务 profile）；reconcile 只读该 profile | Q-102 扫描定案 | 生效 | v2.1 新增 |

## 11. 页面交互规范

| 页面/组件 | 角色 | 功能 | 权限 | 数据范围 |
|:----------|:-----|:-----|:-----|:---------|
| 导航「插件」入口 | 用户 | 进入插件页（Skills 检查器后） | 全量 | — |
| 市场 tab | 用户 | registry 搜索/浏览（名称/描述/版本/分类/安装数），安装入口 + 信任/变更明示 | 全量 | plugins.json registry |
| 已安装 tab | 用户 | 列表/更新/卸载/状态（reconcile dsh 实际状态） | 全量 | dsh 已装插件（只读回显） |
| 卸载确认弹窗 | 用户 | 二次确认 + 影响提示 | 全量 | — |

## 12. 不做事项

- 自造平行插件格式（v1.0 壳插件方案废弃）；
- 自建中心化注册表后端（registry = JSON 文件 + PR 提交）；
- 实现 dsh 侧插件能力（委托 `dsh plugin`）；
- 插件签名验证 / 沙箱（v2，U-4/U-5）；
- 严格 versions.json 映射表（v2，U-3）；
- 收费/支付/评分体系；
- 插件间依赖与冲突解决。

## 13. 依赖与复用

- **dsh 官方能力**：`dsh plugin add/update/remove`、热挂载、profile/bundle 管理（只调用，不实现）；
- **外部参考实现**：社区 dsh-market（registry 协议 + 白名单 + 校验脚本，直接参照）；
- **进程调用**：pkgmgr/spawnArgs（复用子进程调用 dsh CLI 的既有通道）；
- **UI 模式**：skills 检查器双 tab + 空态引导；
- **互斥门控**：backup `canBackup` 门控先例。

## 14. 子需求清单

> **待拆解**——随实现启动补：扫描 → 拆解（Gate B）→ 契约。

## 15. 附录

### 15.1 关联

- PRD（docs/prd/2026-09-07-plugin-market-prd.md）、调研（docs/research/2026-09-21-plugin-market调研.md，v2）、规则索引（docs/spec/规则索引.md）、M1 共识（CON-R002/R003/R004）、外部：deepseek-harness 官方插件文档 / dsh-market / Obsidian / Claude Code（调研 §二）。

### 15.2 版本记录

| 版本 | 日期 | 变更摘要条目 | 说明 |
|:-----|:-----|:-------------|:-----|
| v2.1 | 2026-09-21 | 已登记（已发布） | 三角色扫描 Q-101~Q-117 全数闭环：dsh CLI 通道服务（011）/ `--profile` 独立管理策略（012）+ §4.9 扫描定案（事务性/registry/白名单/变更明示/reconcile/门控/UI/QA 隔离与验收断言） |
| v2.0 | 2026-09-21 | 已登记（已发布） | 架构级推翻 v1.0：外部调研确认 dsh 官方插件机制且无官方市场 → 形态改对接 dsh 生态；规则全重写 |
| v1.0 | 2026-09-21 | 已登记（已发布） | 壳插件自造格式（npm 包 + hull-plugin.json + 主进程加载）——**已废弃**（v2.0 推翻） |

### 15.3 后续规划

| 项 | 状态 | 说明 |
|:---|:-----|:-----|
| 扫描 + 拆子需求 | 待实现启动 | 顺序：扫描 → Gate B → 契约 → 判级确认 → 技术方案（复杂必产）→ 实现管道 |
| 官方桌面壳市场接入 | 排后（U-2） | 官方 COMING SOON，上线时评估接入 |
| versions.json / 哈希 / 签名 | 排后（U-3~U-5） | v2 |
