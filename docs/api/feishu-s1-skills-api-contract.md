# S1 Skills 扫描/列表/搜索契约

## 契约信息

- 工作项：S1 Skills 扫描/列表/搜索（飞书 dsh-hull-desktop 清单，a639af53-ff91-478b-8cb6-e13102427069）
- 契约状态：冻结（2026-08-23）
- 版本：v0.1
- 适用版本：Skills Checker（共识 v1.2 + PRD v0.2）
- 最后更新：2026-08-23
- 说明：桌面壳只读扫描契约（无 HTTP API 面）；核心 = 5 条新增 IPC 通道（4 条 skills:* 只读 + 1 条壳导航）+ 聚合 Skill 条目 Schema + 扫描管线行为约束（注册表遍历/realpath 去重/frontmatter 解析/来源三级降级/哈希缓存/异步首屏 <2s）+ 前端行为契约（双 tab/筛选/状态栏/空态）。判级：复杂 + 安全敏感（新 fs-management 子系统，只读扫描）。交付顺序 S1 → S2（S2 消费本契约扫描结果与 SkillFsOps 抽象层）。

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| 独立视图 nav 接入 | S1 验收① | 共识 §12 | 「Skills」nav 项点击切右侧视图（复用 S8 占位区块机制，主进程驱动）；与官方 WebContentsView 互斥 | hull:showSkills | 已定义 |
| 6 目录统一扫描聚合 | S1 验收② | CON-R-skills-001 | 注册表硬编码 6 目录遍历；目录不存在跳过标「未安装」计数 0 | skills:scan / getSnapshot | 已定义 |
| 全局 vs 平台 scoped 判定 | S1 验收② | CON-R-skills-002 | 目录位置+symlink realpath：`~/.agents`=universal、`~/.claude`=claude-code+opencode、`~/.config/opencode`=opencode 专属；按 name 聚合平台徽标合并 | skills:scan（聚合逻辑） | 已定义 |
| realpath 同源去重 | S1 验收② | CON-R-skills-002 | symlink realpath 指向同目录不重复计入 | skills:scan（聚合逻辑） | 已定义 |
| 描述解析+缺失占位 | S1 验收③ | 共识 §7.2 | SKILL.md frontmatter name/description/license/compatibility/metadata 解析；缺失/解析失败 → 「无描述」占位不报错 | skills:scan（解析逻辑） | 已定义 |
| 来源三级降级+跳转 | S1 验收④ | CON-R-skills-005 | metadata.source → lock source+skillPath 构建 GitHub tree URL → 「来源未知」置灰禁点；点击经 openExternal ^https:// 白名单 | skills:scan + hull:openExternal（复用） | 已定义 |
| 本地/远程搜索双 tab | S1 验收⑤ | CON-R-skills-010 + Q-036/T-2 | 两 tab 默认本地；本地过滤已扫描列表（名称/描述/来源）；远程调 `npx skills find <q>` 展示 marketplace 结果仅浏览标注「未安装」；结果永不混合、切换清空对方 | 本地=frontend-only 过滤；远程=skills:searchRemote | 已定义 |
| 平台筛选组合 | S1 验收⑥ | PRD FR-8 | 平台下拉 + 「仅看可升级」「仅看已禁用」开关，与搜索可组合即时生效 | frontend-only 过滤（消费快照） | 已定义 |
| 异步扫描+哈希缓存+性能 | S1 验收⑦ | CON-R-skills-009 + FR-10 | 后台扫描不阻塞 UI（先骨架/部分结果）；SHA-256 缓存目录 mtime 变化才重算；200+ skill 首屏 <2s | skills:scan / getSnapshot | 已定义 |
| 升级检测态标记 | S1（S2 前置） | CON-R-skills-004 + Q-034 | 本地 vs 远端哈希对比 → latest/upgradable/unknown；远端哈希四级优先级（skills-lock→平台 lock→cc-switch→git remote clone）；均无 unknown | skills:scan（检测逻辑） | 已定义 |
| 路径安全校验 | S1 验收⑧ | CON-R-skills-007 + Q-038 | basename(realpath) 拒绝 `../`、空名、非法字符；openExternal 仅 ^https://（拒 file:/javascript:/data:） | 扫描管线前置校验 + hull:openExternal | 已定义 |
| SkillFsOps 抽象层 | S1 验收⑨ | Q-037 | fs 操作收敛抽象接口 + DI/env 注入临时目录 e2e；真实目录留冒烟；S2 复用 | 实现层约束（非 IPC） | 已定义 |

## 范围与非目标

### 范围

- 5 条新增 IPC 通道：`hull:showSkills`（导航）+ `skills:scan` / `skills:getSnapshot` / `skills:searchRemote` / `skills:getStatus`（只读）
- 扫描管线：注册表遍历 → realpath 解析去重 → frontmatter 解析 → 来源三级降级 → 哈希计算（缓存）→ 远端哈希四级获取 → 按 name 聚合
- 聚合 Skill 条目 Schema（name/scope/platforms/description/source/paths/localHash/remoteHash/upgradable/enabled）
- 哈希缓存文件（`<userData>/skills/hash-cache.json`，mtime 键控）
- 远程搜索（npx skills find 封装，仅浏览数据面）
- SkillFsOps 抽象接口定义（S1 落地，S2 复用做破坏性操作）
- 前端行为契约：双 tab/平台筛选/状态栏/空态加载态/来源跳转白名单

### 非目标

- 一切写操作：移除/升级/禁用/启用/回收站（S2，feishu-s2-skills-api-contract.md）
- 远程安装/卸载（T-2 定案不做，远程仅浏览）
- skill 创建/编辑（不改 SKILL.md 内容）
- CC 配置修改（不改 `~/.claude/settings.json` 等）
- DSH_HOME 任何读写（CON-R002 红线）
- 多设备同步/跨平台打包（延续 M1，macOS Apple Silicon）

## 业务流程与状态

### 核心流程（扫描管线）

```text
进入 Skills 视图（hull:showSkills）→ renderer 调 skills:scan（幂等触发）
→ 主进程后台管线：
  ① 遍历注册表 6 目录（CON-R-skills-001；目录不存在 → 跳过，筛选下拉保留计数 0 标「未安装」）
  ② 逐条目 realpath 解析（symlink 循环/异常 → 跳过该项不阻塞）+ 路径校验（Q-038）
  ③ 读 SKILL.md frontmatter（缺失/解析失败 → 按目录名列出，「无描述」占位）
  ④ 来源三级降级（metadata.source → lock source+skillPath → 构建 GitHub URL → null「来源未知」）
  ⑤ 本地哈希 SHA-256（path+content 排序；hash-cache.json 按 path+mtime 命中跳过）
  ⑥ 远端哈希四级优先级（Q-034：skills-lock.json → 平台 lock → cc-switch content_hash → git remote 临时 clone；均无 unknown）
  ⑦ 按 name 聚合（跨目录合并平台徽标；realpath 同源去重）→ 快照落内存
→ renderer 轮询 skills:getSnapshot 至 status=ready → 渲染列表 + skills:getStatus 计数
用户操作：本地搜索/平台筛选/快捷开关（frontend-only 内存过滤）→ 远程 tab → skills:searchRemote
```

### 状态转换（扫描任务）

| 当前状态 | 动作 | 目标状态 | 前置条件 | 冲突行为 | 依据 |
|---|---|---|---|---|---|
| idle / ready | skills:scan | scanning | — | 进行中重复调用 → 返回当前状态不重启（幂等） | FR-10 |
| scanning | 管线完成 | ready | — | 快照原子替换（旧快照持续可读） | FR-10 |
| scanning | 单目录/单条目异常 | scanning（继续） | — | 跳过异常项，不阻塞整体 | §5.3 |
| scanning | 致命错误（如 userData 不可写） | error | — | 保留旧快照，error 字段带原因 | §5.3 |
| ready | agent 目录外部变更 | ready（陈旧） | — | 用户手动「重新扫描」；S2 写操作自带 mtime 守卫兜底 | §5.3 |

## 接口清单

> S1 为只读扫描契约，无 HTTP paths；"接口" = IPC 通道（主进程 SkillsScanner 暴露，preload 桥接 `window.skills`，renderer 消费）。全部为 **NEW** 通道；响应统一包裹 `{ ok:true, data } | { ok:false, code, message }`（对齐 KanbanIpcResult 形态）。通道命名须登记进 src/shared/ipc-channels.ts 白名单。

| # | 状态 | 方法 | 路径（IPC channel） | 用途 | 权限 | 幂等 |
|---|---|---|---|---|---|---|
| 1 | NEW | invoke | `hull:showSkills` | 壳导航「Skills」入口 → 主进程切 view 到 placeholder:skills（与官方 UI 互斥） | 无（壳内） | 是 |
| 2 | NEW | invoke | `skills:scan` | 触发后台扫描（幂等；进行中返回当前状态） | 无（壳内只读） | 是 |
| 3 | NEW | invoke | `skills:getSnapshot` | 获取当前扫描快照（status+entries[]；轮询增量刷新） | 无（壳内只读） | 读 |
| 4 | NEW | invoke | `skills:searchRemote` | 远程 marketplace 检索（npx skills find；仅浏览不安装） | 无（壳内只读） | 读（同 query 结果可能随远端变化） |
| 5 | NEW | invoke | `skills:getStatus` | 状态栏计数（共 N/可升级/已禁用/全局） | 无（壳内只读） | 读 |
| — | FRONTEND-ONLY | — | （无通道）`skills:searchLocal` | 本地搜索 = renderer 对快照内存过滤（名称/描述/来源关键词，大小写不敏感支持中文）；平台筛选/快捷开关同属 frontend-only | — | — |

> 本地搜索不走 IPC：快照已整体在 renderer 内存，过滤为纯展示层计算，加通道纯属绕远（Q-036 本地 tab 语义即「过滤已扫描列表」）。来源跳转复用既有 `hull:openExternal`（main 侧已有 http/https 校验，S1 补 ^https:// 收紧约定，见协调事项）。

## Schema 与枚举

### SkillEntry（聚合后列表条目，唯一权威结构）

| 字段 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| name | string | 是 | 否 | ≤200 字符；按 name 聚合键 | 无 | skill 名（SKILL.md name 或目录名兜底） |
| scope | string | 是 | 否 | global / scoped | 无 | 全局/平台限定（§判定规则） |
| platforms | array[string] | 是 | 否 | §9 平台枚举子集，≥1 | 无 | 全部生效平台（跨目录合并徽标） |
| description | string | 否 | 是 | frontmatter 全文；null=缺失 | 无 | 功能描述；null → UI「无描述」占位；截断 2 行为展示层行为不入 Schema |
| source | string | 否 | 是 | https URL 或 null | 无 | 三级降级解析结果；null=「来源未知」（跳转/升级禁用置灰） |
| paths | array[PathInfo] | 是 | 否 | ≥1；跨目录逐条 | 无 | 物理路径明细（realpath 解析后） |
| localHash | string | 否 | 是 | 64 位 hex；哈希计算完成前可空 | 无 | 本地内容哈希（SHA-256 path+content 排序） |
| remoteHash | string | 否 | 是 | 64 位 hex；四级来源均无=null | 无 | 远端内容哈希（Q-034） |
| upgradable | string | 是 | 否 | latest / upgradable / unknown | 无 | latest=哈希一致；upgradable=不一致；unknown=remoteHash 不可获取（升级入口禁用「无法检测版本」，Q-033） |
| enabled | boolean | 是 | 否 | 路径位置推导 | 无 | 聚合展示态：全部路径启用=true，任一路径已禁用=false（按路径粒度明细看 paths；S1 阶段恒 true，S2 禁用后由目录实际位置推导） |

### PathInfo（paths[] 元素）

| 字段 | 类型 | 必填 | 可空 | 约束 | 说明 |
|---|---|---|---|---|---|
| path | string | 是 | 否 | 注册表目录内绝对路径 | 展示与 S2 操作目标 |
| isSymlink | boolean | 是 | 否 | — | symlink 来源判定（S2 禁用移指针 vs rename 的依据，Q-032） |
| mtimeMs | number | 是 | 否 | — | 目录 mtime 快照（S2 写前冲突检查依据，§5.3） |
| affectedPlatforms | array[string] | 是 | 否 | ≥1 | 该物理路径受影响平台（S2 移除确认弹窗展示依据） |

> 偏差说明：共识 §7.1 paths 为纯字符串数组；本契约升格为 PathInfo[]——S2 的 mtime 守卫与 symlink 判定需要结构化信息，避免 S2 重新 stat 二次扫描。展示层取 `.path`。

### RemoteSkillEntry（searchRemote 结果，marketplace 条目）

| 字段 | 类型 | 必填 | 可空 | 约束 | 说明 |
|---|---|---|---|---|---|
| name | string | 是 | 否 | — | skill 名 |
| description | string | 否 | 是 | — | 描述 |
| source | string | 否 | 是 | https URL 或 null | 来源（可跳转） |
| installs | integer | 否 | 是 | — | 安装数（远端提供则展示） |
| installed | boolean | 是 | 否 | 恒 false | 标注「未安装」；远程结果仅浏览，无 enable/disable/升级操作（Q-036） |

### ScanSnapshot（getSnapshot 响应）

| 字段 | 类型 | 必填 | 可空 | 说明 |
|---|---|---|---|---|
| status | string | 是 | 否 | idle / scanning / ready / error |
| entries | array[SkillEntry] | 是 | 否 | 当前快照（scanning 时为上次 ready 快照或 []） |
| lastScanAt | string | 否 | 是 | ISO 8601 UTC；从未扫描=null |
| error | string | 否 | 是 | status=error 时原因 |

### StatusCounts（getStatus 响应）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| total | integer | 是 | 已扫描 skill 总数（聚合后） |
| upgradable | integer | 是 | upgradable 条目数 |
| disabled | integer | 是 | enabled=false 条目数 |
| global | integer | 是 | scope=global 条目数 |

### 哈希缓存（`<userData>/skills/hash-cache.json`）

| 字段 | 类型 | 说明 |
|---|---|---|
| version | integer | schema 版本，默认 1 |
| entries | map<path, { mtimeMs, hash }> | 键=path；mtime 一致命中，否则重算回写 |

### 枚举与状态

| 类型 | 值 | 含义 | 可用于请求 | 可出现在响应 |
|---|---|---|---|---|
| scope | global/scoped | 全局/平台限定 | 否（系统判定） | 是 |
| upgradable | latest/upgradable/unknown | 升级检测态 | 否（系统计算） | 是 |
| 平台 | claude-code/opencode/codex/gemini-cli/cursor/shared | 生效平台 | 是（筛选入参，frontend-only） | 是 |
| snapshot.status | idle/scanning/ready/error | 扫描任务态 | 否（系统流转） | 是 |
| installed | false（恒） | 远程条目未安装标注 | 否 | 是 |

## 行为契约（只读扫描安全约束）

### 主进程侧（扫描管线）

- **注册表白名单**（CON-R-skills-001）：仅遍历 6 个硬编码目录；`~/.cc-switch/` 只读参考不依赖。任何路径先过 Q-038 校验：basename(realpath(path)) 拒绝 `../`、空名、非法字符；校验失败跳过该条目并记日志，不静默崩溃。
- **realpath 去重**（CON-R-skills-002）：symlink 解析后同源目录只计一次；symlink 循环检测到即跳过该项。
- **解析降级**：SKILL.md 缺失/frontmatter 解析失败 → 条目保留（按目录名），description=null、「来源未知」；不报错不丢条目。
- **哈希缓存**（CON-R-skills-009）：mtime 未变命中缓存；哈希计算后台分批，不卡 UI；200+ skill 首屏 <2s。
- **远端哈希**（Q-034）：四级优先级按 name 匹配、skills-lock 优先覆盖；git remote 临时 clone 只写 `<userData>/skills/staging/`（或临时目录），不污染用户仓库；网络失败降级 unknown，不影响本地列表。
- **DSH_HOME 零接触**（CON-R002）：只读限于注册表目录 + `~/.cc-switch/` 参考；写仅限 `<userData>/skills/hash-cache.json`。
- **SkillFsOps 抽象**（Q-037）：全部 fs 访问（readdir/stat/readFile/realpath）收敛抽象接口，测试经 DI/env 注入临时目录模拟 agent 目录；真实目录操作留冒烟。

### 前端行为契约（renderer）

- **nav 接入**（FR-1）：左侧导航新增「Skills」→ `hull:showSkills` → 主进程切右侧内容区为 Skills Checker 视图（复用 S8 占位区块切换机制，同 hull:showBoard 模式）；与官方 WebContentsView 互斥显示；点「dsh web」切回。
- **双 tab 搜索**（Q-036）：「本地」（默认选中）/「远程」两 tab；本地=内存过滤（名称/描述/来源，大小写不敏感支持中文）；远程=调 searchRemote 展示 marketplace 结果（名称/描述/来源/安装数），每条标注「未安装」，仅来源跳转无任何管理操作；两 tab 结果永不混合，切换清空对方结果。
- **平台筛选**（FR-8）：下拉（全部/6 平台）+「仅看可升级」「仅看已禁用」开关；与搜索组合即时生效；全部 frontend-only 过滤。
- **状态栏**：共 N 个 skill / 可升级 / 已禁用 / 全局（getStatus 或快照派生）；操作后（S2）刷新。
- **空态/加载态**：扫描中骨架屏/部分结果不阻塞；搜索/筛选无匹配 → 「未找到匹配的 skill，试试调整搜索词或筛选条件」，清除恢复全量；目录未装 → 下拉保留计数 0 标「未安装」。
- **描述截断**：列表截断 2 行，展开/悬浮看全文（CSS/展示层，不改数据）。
- **来源跳转**：source 非空可点 → `hull:openExternal(source)`，仅接受 `^https://`（main 侧白名单拒 file:/javascript:/data:，Q-038）；source=null 置灰不可点。
- **远程失败**：提示「远程不可用」，本地列表不受影响。

## 公共异常集

#### SKILL_SCAN_ERROR（只读扫描层）

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---:|
| scan-error | 扫描管线致命失败（userData 不可写/缓存损坏不可重建） | code+msg | 提示错误；旧快照保留可读；可重试扫描 | 是 |
| remote-search-failed | npx skills find 失败/超时/远端不可用 | code+msg | 远程 tab 提示「远程不可用」；本地列表不受影响 | 是 |
| validation-error | searchRemote query 空；openExternal URL 非 ^https:// | code+msg(+field) | 提示具体原因 | 否 |

> 单目录不存在/单条目 SKILL.md 解析失败/symlink 循环均为**降级而非错误**（跳过或占位，见行为契约），不产生错误码。快照内条目无 not-found 语义（读全量）；S2 写操作的 skills-not-found 归 S2 契约。

## 接口详情

### 1. showSkills

`invoke hull:showSkills`

#### 用途与依据

- 使用场景：壳导航「Skills」入口点击
- 共识：§12 页面交互规范；PRD FR-1
- 验收：点击「Skills」→ 右侧显示检查器视图；与官方 WebContentsView 互斥不干扰

#### 请求

无请求体。

#### 成功响应

- `{ switched: true }`（主进程已完成视图切换；视图挂载后 renderer 自行发起 scan/getSnapshot）。

#### 失败响应

- 复用 hull 导航既有错误形态（视图切换失败极罕见，msg 带原因）。

#### 幂等与并发

- 幂等：是（已在 Skills 视图重复调用无副作用）。

### 2. scan

`invoke skills:scan`

#### 用途与依据

- 使用场景：进入视图首扫 + 工具条「重新扫描」按钮
- 共识：CON-R-skills-001/002/005/009；FR-10
- 验收：异步后台不阻塞；先骨架/部分结果；目录未变化二次扫描哈希命中缓存

#### 请求

无请求体（重扫语义固定：目录结构重遍历，哈希走 mtime 缓存）。

#### 成功响应

- 响应 Schema：`ScanSnapshot`（触发后的即时状态，通常 status=scanning + 上次快照）。

#### 失败响应

- 适用公共异常集：SKILL_SCAN_ERROR（仅致命场景同步抛出；常规异常走快照 status=error）。

#### 幂等与并发

- 幂等：是（scanning 中重复调用返回当前状态，不重启管线）。

### 3. getSnapshot

`invoke skills:getSnapshot`

#### 用途与依据

- 使用场景：renderer 轮询扫描进度/结果；操作后刷新列表
- 共识：FR-10（异步+部分结果）

#### 请求

无请求体。

#### 成功响应

- 响应 Schema：`ScanSnapshot`（含 entries: SkillEntry[]，结构见 Schema 章）。

#### 失败响应

- 仅 skills-io-error 级意外（快照读取为内存操作，正常不失败）。

#### 幂等与并发

- 读操作；轮询频率 renderer 自定（建议 250~500ms，scanning 期间）。

### 4. searchRemote

`invoke skills:searchRemote { query }`

#### 用途与依据

- 使用场景：远程 tab 搜索 marketplace
- 共识：CON-R-skills-010 + Q-036/T-2；PRD FR-7
- 验收：返回 marketplace 条目仅浏览标注「未安装」；失败提示「远程不可用」不影响本地

#### 请求

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| body | query | string | 是 | 非空 | 检索关键词 |

#### 成功响应

- 响应 Schema：`{ entries: RemoteSkillEntry[] }`（installed 恒 false；空数组合法）。

#### 失败响应

| 语义错误码 | 触发条件 | 响应字段要求 | 客户端处理 | 可重试 |
|---|---:|---:|---|---:|
| remote-search-failed | npx 失败/超时（上限 30s）/远端不可用 | code+msg | 提示「远程不可用」 | 是 |
| validation-error | query 空 | code+msg+field | 提示输入 | 否 |

#### 幂等与并发

- 读语义；同 query 结果随远端变化；进行中重复调用允许并行（tab 切换清空由前端保证）。

### 5. getStatus

`invoke skills:getStatus`

#### 用途与依据

- 使用场景：顶部状态栏计数（共 N/可升级/已禁用/全局）
- 共识：PRD FR-2（顶部状态）；共识 §12

#### 请求

无请求体。

#### 成功响应

- 响应 Schema：`StatusCounts`（从当前快照派生；快照未就绪时全 0）。

#### 失败响应

- 正常不失败（内存派生）。

#### 幂等与并发

- 读操作；与 getSnapshot 数据同源一致。

## 数据库与外部系统影响

> 无数据库。读：注册表 6 目录 + lock 文件（skills-lock.json/平台 lock）+ cc-switch db（只读参考）。写：仅 `<userData>/skills/hash-cache.json`。外部进程：npx skills find（远程搜索）、git（远端哈希临时 clone，只写临时区）。不触 DSH_HOME（CON-R002）。

## 联调与测试场景

> e2e 经 SkillFsOps 注入临时目录模拟 agent 目录（Q-037）；真实目录操作留冒烟。编号 T1~T20。

| # | 场景 | 前置条件 | 请求/动作 | 预期结果 | 数据与审计结果 | 验收编号 |
|---|---|---|---|---|---|---|
| T1 | 六目录扫描聚合+缺目录跳过 | 临时目录模拟 6 目录，其一不存在 | skills:scan → getSnapshot | 5 目录条目聚合成列表；缺目录计 0 标「未安装」 | 筛选下拉保留该平台 | S1②/FR-2 |
| T2 | 全局判定 universal | skill 在 ~/.agents/skills/ | 扫描 | scope=global；platforms 含全部平台 | — | S1②/CON-R-skills-002 |
| T3 | scoped 判定 | 同名 skill 分别在 ~/.claude 与 ~/.config/opencode | 扫描 | ~/.claude 条目 platforms=[claude-code,opencode]；~/.config/opencode 条目=[opencode] | — | S1② |
| T4 | realpath 同源去重 | ~/.claude/skills/x 为 symlink → ~/.agents/skills/x | 扫描 | 只计一条；platforms 合并不重复计数 | paths 含两条 PathInfo 或合并单条 | S1② |
| T5 | 按 name 聚合徽标合并 | 同 skill 名分布 3 目录 | 扫描 | 单条目 platforms 并集完整 | — | S1②/FR-2 |
| T6 | frontmatter 全字段解析 | 标准 SKILL.md | 扫描 | name/description/license/compatibility/metadata 正确读出 | metadata.source 进入来源解析 | S1③/FR-3 |
| T7 | 描述缺失占位 | SKILL.md 缺失/坏 YAML | 扫描 | 条目保留（目录名兜底），description=null → 「无描述」 | 不报错不丢条目 | S1③ |
| T8 | 来源一级 metadata.source | frontmatter 含 source | 扫描 | source=该 URL，可点击跳转 | — | S1④/CON-R-skills-005 |
| T9 | 来源二级 lock 构建 | 无 metadata.source，lock 有 source+skillPath | 扫描 | source=构建的 GitHub tree URL | — | S1④ |
| T10 | 来源三级均无 | 无任何来源信息 | 扫描 | source=null；链接置灰；升级入口禁用 | — | S1④ |
| T11 | 本地搜索过滤 | 快照就绪 | 本地 tab 输入关键词（含中文/大小写混合） | 名称/描述/来源命中即时过滤；清空恢复全量 | frontend-only，无 IPC | S1⑤/Q-036 |
| T12 | 双 tab 分离 | 本地有结果 | 切远程 tab 搜词条 | 远程结果独立展示标「未安装」；切回本地清空远程结果；两列表永不混合 | — | S1⑤/Q-036 |
| T13 | 远程搜索失败 | 断网/npx 失败 | searchRemote | **remote-search-failed**；提示「远程不可用」；本地列表不变 | — | S1⑤/FR-7 |
| T14 | 筛选组合 | 快照含多平台/可升级/禁用态 | 平台下拉+「仅看可升级」+关键词 | 三条件 AND 组合即时生效 | frontend-only | S1⑥/FR-8 |
| T15 | 状态栏计数 | 已知构成快照 | getStatus | total/upgradable/disabled/global 与快照一致 | — | FR-2 |
| T16 | 首屏性能 | 构造 200+ skill 临时目录 | 冷进视图计时 | 骨架先行，首屏渲染 <2s；哈希后台分批不卡 UI | 计时达标 | S1⑦/FR-10 |
| T17 | 哈希缓存命中 | 首扫后不动目录 | 二次 scan | mtime 未变条目零重算（缓存命中）；改动条目重算 | hash-cache.json 更新仅变动项 | S1⑦/CON-R-skills-009 |
| T18 | 异常路径跳过 | 注入 symlink 循环+非法目录名 | 扫描 | 异常项跳过并记日志；其余条目正常出列 | 不阻塞整体 | §5.3/Q-038 |
| T19 | openExternal 白名单 | source=https 正常条目 | 点跳转 file:/javascript: 构造 URL | ^https:// 放行；非 https 拒绝 **validation-error** | main 侧拦截 | S1⑧/Q-038 |
| T20 | DSH_HOME 零接触 | — | 全部扫描/搜索操作 | 不读写 DSH_HOME | 变更仅 hash-cache.json | CON-R002 |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| O-1 | `npx skills find` 输出结构（JSON/stdout 文本）与字段映射（installs 等） | skills:searchRemote 响应字段 | 实现期实测定映射；缺字段置 null 不阻塞 | open（实现期关闭） |
| O-2 | opencode 多目录读取生效集合展示褶皱（T-5） | SkillEntry.platforms 聚合口径 | §5.1 初版（聚合+realpath 去重）已落地本契约；评审确认 | open（沿用共识 T-5） |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| IPC channel 白名单登记 | SKILLS_IPC_CHANNELS（skills:scan/getSnapshot/searchRemote/getStatus）+ hull:showSkills 加入 src/shared/ipc-channels.ts（ALL_IPC_CHANNELS 共面）+ preload window.skills 桥 | phper666 | S1 实现 | 待定 |
| SkillFsOps 抽象归属 | S1 定义并落地（只读面：readdir/stat/readFile/realpath + DI 注入）；S2 扩展写面（move/unlink/rm）复用同一接口（Q-037） | phper666 | S1 设计文档 | 待定（S1 设计冻结前置） |
| S2 依赖接口 | 本契约向 S2 供给：SkillEntry.paths（PathInfo 含 mtimeMs/isSymlink/affectedPlatforms）+ source/upgradable/enabled 态 + mtime 快照（写前冲突检查） | phper666 | S2 实现 | 已定（本契约 Schema 章） |
| openExternal 白名单收紧 | 复用 hull:openExisting 通道；main 侧校验由 http/https 收紧为 ^https://（CON-R-skills-007/Q-038） | phper666 | S1 实现 | 待定 |
| 响应包裹形态统一 | `{ ok:true, data } \| { ok:false, code, message }` 对齐 KanbanIpcResult；错误码 kebab-case | phper666 | S1 实现 | 已定（本契约） |
| 远端哈希口径 | 与 skills-lock.json / cc-switch content_hash 口径实测对齐（同 S2 协调项，检测侧归 S1） | phper666 | S1 实现期 | 待定 |

## 完成记录

> 交付后填写，结果必须有证据。

| 项 | 结果 |
|:---|:-----|
| 交付时间 | — |
| 验证结果 | — |
| 构建/发布 | — |
| 偏差处理 | — |

## 决策与踩坑

- 契约形态沿用 B1/S2 先例：IPC 通道表达接口面，响应包裹对齐 KanbanIpcResult，白名单集中登记 ipc-channels.ts。
- 本地搜索定为 frontend-only（不加通道）：快照已整体在 renderer，内存过滤零成本；远程搜索必须走 IPC（npx 子进程只能在 main 侧跑）。
- paths 由共识的 string[] 升格 PathInfo[]（+isSymlink/mtimeMs/affectedPlatforms）：S2 的写前 mtime 守卫、symlink 移指针判定、移除确认弹窗平台清单都依赖这些信息，S1 一次扫描产出避免 S2 二次 stat。
- getStatus 独立成通道虽可由快照派生：显式计数接口让状态栏与列表解耦刷新（S2 操作后单刷计数），且口径集中在 main 侧一处。
- 导航复用 hull:* 域（hull:showSkills 对齐 hull:showBoard 既有模式），不新开 skills: 域——视图切换是壳框架职责。

## 变更记录

| 时间 | 类型 | 摘要 |
|---|---|---|
| 2026-08-23 | 初次生成 | 基于 S1（飞书 a639af53）+ 共识 v1.2 §14.1/§13/CON-R-skills-001/002/005/006/007/009/010 + Q-036/037/038 生成契约草案；5 条 NEW IPC 通道（含 hull:showSkills）+ 本地搜索 frontend-only 定案 + SkillEntry/PathInfo Schema + 20 测试场景 |
| 2026-08-23 | 复核登记 | CON-R-skills-007 openExternal 口径复核结论：实现未一刀切 ^https://——http 仅回环放行（localhost/127.0.0.1，dsh web 地址依赖此通道打开浏览器），file:/javascript:/data:/任意 host http 全拒；skill 来源跳转渲染侧额外强制 ^https://（双层防御）；处理：登记在案，建议共识规则修订时回写「http 仅回环」口径 |

## 自检记录

- 追踪完整性：PASS（S1 验收①~⑨→CON-R-skills-001/002/005/006/007/009/010 + Q-036/037/038，追踪矩阵全覆盖）
- OpenAPI 一致性：不适用（本地只读扫描契约，无 OpenAPI yaml；SkillEntry Schema 即字段唯一事实源）
- 示例与错误场景：PASS（20 个联调场景 T1~T20 含成功/失败/边界/性能/安全 + 公共异常集 3 错误码 + 降级语义单列）
- 安全与敏感字段：PASS（Q-038 路径校验、^https:// 白名单、注册表只读边界、DSH_HOME 零接触声明）
- 链接与格式：PASS
