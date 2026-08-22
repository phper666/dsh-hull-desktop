# S1 Skills 扫描/列表/搜索 技术方案

> 工作项：S1 Skills 扫描/列表/搜索（飞书 dsh-hull-desktop 清单，a639af53-ff91-478b-8cb6-e13102427069）
> 状态：**draft（撰写中）→ frozen（评审通过·冻结，可进实现）**
> 版本：0.1 · 2026-08-23
> 事实源：契约 `docs/api/feishu-s1-skills-api-contract.md` v0.1（冻结）；共识 `docs/spec/共识-Hull桌面壳-Skills检查器.md` v1.2（§14.1 子需求清单 + §13 后端任务规范 + CON-R-skills-001/002/005/006/007/009/010 + Q-036/037/038）；PRD `docs/prd/2026-08-22-skills-checker-prd.md` v0.2；原型 `docs/prototype/2026-08-22-skills-checker-prototype.html`；格式与工程基线参照 `docs/design/B3-看板-m2-kanban-design.md`
> 判级：**复杂 + 安全敏感**。理由：新增 fs-management 子系统（注册表遍历 / symlink realpath 解析 / frontmatter 解析 / 哈希管线 / npx 子进程集成）跨多子系统，契约含扫描管线状态机与聚合去重闭环（skill 判级矩阵「新架构 + 外部系统集成」）；叠加安全敏感行——读写用户 agent 配置目录 + openExternal 外链面：**强制安全扫描（Semgrep 或等价工具 gitleaks/trivy/依赖扫描）进实现纪律，缺工具必须换等价工具或安装，不得跳过**。

---

## 1. 背景与范围

**定位**：S1 交付 Skills 检查器只读面——统一扫描各 agent 平台 skill 目录并聚合展示。核心 = 6 目录注册表遍历 + 全局/scoped 判定与 realpath 去重聚合 + SKILL.md frontmatter 描述解析 + 来源三级降级解析 + 内容哈希计算（mtime 缓存）+ 远端哈希四级获取（升级检测态标记）+ 本地/远程双 tab 搜索 + 路径安全校验 + SkillFsOps 抽象层（S2 复用做破坏性操作）。

**规则绑定**：CON-R-skills-001（注册表硬编码）、CON-R-skills-002（全局/scoped 判定+聚合去重）、CON-R-skills-005（来源三级降级）、CON-R-skills-006（userData 归属）、CON-R-skills-007（安全校验 Q-038）、CON-R-skills-009（异步扫描+哈希缓存）、CON-R-skills-010（本地/远程搜索分开）+ Q-036/Q-037/Q-038。

**范围**（契约 §范围，冻结）：
- 5 条新增 IPC 通道：`hull:showSkills`（导航）+ `skills:scan` / `skills:getSnapshot` / `skills:searchRemote` / `skills:getStatus`（只读）
- 扫描管线：注册表遍历 → realpath 解析去重 → frontmatter 解析 → 来源三级降级 → 哈希计算（缓存）→ 远端哈希四级获取 → 按 name 聚合
- 聚合 SkillEntry Schema（name/scope/platforms/description/source/paths/localHash/remoteHash/upgradable/enabled）+ PathInfo（path/isSymlink/mtimeMs/affectedPlatforms）
- 哈希缓存文件 `<userData>/skills/hash-cache.json`（mtime 键控）
- 远程搜索封装（npx skills find 子进程，仅浏览数据面）
- SkillFsOps 抽象接口定义与只读实现（S1 落地，S2 扩展写面复用）
- 前端行为契约：双 tab 搜索 / 平台筛选 / 状态栏 / 空态加载态 / 来源跳转白名单 / nav 接入

**非目标**（契约 §非目标）：一切写操作（移除/升级/禁用/启用/回收站 → S2）；远程安装/卸载（T-2 不做）；skill 创建/编辑；CC 配置修改；DSH_HOME 任何读写（CON-R002 红线）；多设备同步/跨平台打包。

**交付验收**：契约测试场景 T1~T20（六目录聚合/缺目录跳过/全局判定/realpath 去重/frontmatter 解析/来源三级/双 tab 分离/筛选组合/首屏 <2s/缓存命中/异常路径跳过/openExternal 白名单/DSH_HOME 零接触）。

**范围剪裁说明（YAGNI）**：不引 YAML 库/frontmatter 库（字段平面 + 一个嵌套 metadata map，手写最小解析器）；不引 fs 监听（chokidar/watch——外部变更靠手动重扫 + S2 mtime 守卫兜底）；不做增量扫描（全量重遍历，哈希走 mtime 缓存已满足 <2s）；远端哈希 git remote clone 仅在四级来源前三层全部缺失时触发（罕见路径，不预优化）。

---

## 2. 架构决策（含备选）

### D1 目录注册表：硬编码常量集中维护 vs 配置文件 vs 运行时探测

- **A**：`REGISTRY` 硬编码常量单点维护（agent → { dir, platforms }），目录约定变化只改一处
- **B**：settings.json 可配置注册表
- **C**：运行时探测各平台文档/默认路径 → **选 A**

理由：CON-R-skills-001 冻结「硬编码单点集中维护」；目录约定是 agent 平台事实（非用户偏好），进设置页制造误配风险；运行时探测不可靠且无官方统一标准可探。代价：约定变化需发版——接受（共识 §5.1 明示此取舍）。opencode 多目录读取特殊处理在同一常量内表达：`~/.claude/skills/` 与 `~/.agents/skills/` 的 affectedPlatforms 含 opencode（数据驱动，无 if 分支散落）。

```ts
// src/skills/registry.ts（唯一事实源）
interface RegistryEntry { platform: string; dir: string; affectedPlatforms: string[] }
// claude-code → ~/.claude/skills/   affectedPlatforms=[claude-code, opencode]
// opencode    → ~/.config/opencode/skills/  affectedPlatforms=[opencode]
// codex       → ~/.codex/skills/    [codex]
// gemini-cli  → ~/.gemini/skills/   [gemini-cli]
// cursor      → ~/.cursor/skills/   [cursor]
// shared      → ~/.agents/skills/   affectedPlatforms=全部平台（universal）
```

### D2 全局/scoped 判定与聚合去重：目录位置+realpath vs 只看目录位置 vs 读平台配置

- **A**：判定 = 注册表目录位置（静态映射）+ symlink realpath 解析（同源去重）；按 name 聚合、platforms 取并集
- **B**：只看目录位置，不解 symlink → 同一 skill 经 symlink 出现在两目录会重复计数
- **C**：读各平台自身配置文件判定生效集 → 无官方统一 schema，脆弱且越权解析平台内部 → **选 A**

理由：CON-R-skills-002 冻结「目录位置 + symlink realpath」；realpath 同源去重解决 T4 场景（`~/.claude/skills/x` → symlink → `~/.agents/skills/x` 只计一条，platforms 合并不重复）。scope 判定纯派生：任一路径位于 `~/.agents/skills/`（或 realpath 落于其中）→ global，否则 scoped。symlink 循环检测：realpath 抛错/解析深度超限 → 跳过该项记日志，不阻塞整体（§5.3）。

### D3 SkillFsOps 抽象层：接口 DI vs 直接 fs 调用

- **A**：定义 `SkillFsOps` 接口（S1 只读面：readdir/stat/readFile/realpath；构造入参注入根目录映射），扫描器/解析器只依赖接口
- **B**：模块内直接调 node:fs，测试 mock 模块 → **选 A**

理由：Q-037 冻结抽象层 + 临时目录注入 e2e；直接 fs 调用使 e2e 必须碰真实 `~/.claude` 等用户目录（不可接受——破坏性前置）。DI 形态对齐 M1/M2 先例（KanbanStore 构造注入、SettingsProvider userDataPath 注入）：`new SkillsScanner(ops)` 其中 `ops = createSkillFsOps({ roots })`，生产装配传真实 HOME，测试传临时目录树。S2 在同一接口扩展写面（move/unlink/rm/mkdir），S1 定义接口形状时预留命名空间但不实现（YAGNI：写方法签名留 S2 补）。

### D4 扫描异步形态：主进程后台任务 + renderer 轮询快照 vs 同步一次返回 vs worker_threads

- **A**：main 侧后台 async 管线（事件循环分批 yield），快照落内存原子替换；renderer 轮询 `skills:getSnapshot`（250~500ms）至 ready
- **B**：scan invoke 同步扫完再返回 → 200+ skill 首屏阻塞 IPC，违背 FR-10
- **C**：worker_threads 跑扫描 → fs 密集型任务收益低，跨线程传快照序列化复杂度不值 → **选 A**

理由：FR-10/CON-R-skills-009 冻结「后台任务 + 骨架屏 + 部分结果」；轮询快照模式壳内已有先例（installStatus 250ms 轮询、getHullUpdateStatus），不引入新机制。管线逐条目 await 后让出事件循环（setImmediate 分批），哈希计算分批执行不卡 UI；快照对象整体替换（旧快照持续可读，scanning 中 getSnapshot 返回上次 ready 结果）。

### D5 来源三级降级：独立纯函数解析器 vs 分散在扫描器内联

- **A**：`resolveSource(entry) → url|null` 纯函数：① frontmatter `metadata.source` → ② lock 文件 source+skillPath 构建 `https://github.com/<owner>/<repo>/tree/<branch>/<skillPath>` → ③ null「来源未知」
- **B**：三级逻辑内联扫描主循环 → 不可单测、T8/T9/T10 场景无法隔离验证 → **选 A**

理由：CON-R-skills-005 三级降级是明确优先级链，纯函数可直接对 T8/T9/T10 表驱动单测；lock 文件读取（skills-lock.json / 平台 lock）作为解析器的可选输入注入（测试无需真实 lock）。null 语义贯穿：source=null → UI 置灰禁点 + 升级入口禁用（S2 主进程侧同样拒绝，双层防御）。

### D6 搜索：本地 frontend-only 内存过滤 + 远程 main 侧 npx 子进程 vs 全走 IPC

- **A**：本地 tab = renderer 对快照内存过滤（名称/描述/来源，大小写不敏感支持中文）；远程 tab = `skills:searchRemote` IPC → main spawn `npx skills find <q>`（超时 30s）
- **B**：本地搜索也加 IPC 通道 → 快照已整体在 renderer，绕远零收益 → **选 A**

理由：契约 §接口清单明注定案——本地过滤为纯展示层计算（frontend-only，无通道）；npx 子进程只能在 main 侧跑（renderer sandbox 无进程能力），远程结果仅浏览（installed 恒 false，无管理操作）。子进程约束：spawn 时 PATH 继承、stdout 收集 + 30s 超时 kill、输出结构实测对齐（开放问题 O-1，缺字段置 null 不阻塞）；失败 → remote-search-failed，「远程不可用」，本地列表不受影响。双 tab 结果永不混合、切换清空对方（前端状态机保证）。

### D7 路径安全校验：basename(realpath)+白名单域 vs 正则黑名单

- **A**：所有 skill 目录名经 `basename(realpath(path))` 校验（拒 `../`、空名、非法字符）+ path 必须落在注册表白名单域内；openExternal 收紧为 `^https://`
- **B**：正则黑名单过滤字符串 → 可被编码/规范化绕过，不防 symlink 指向域外 → **选 A**

理由：Q-038/CON-R-skills-007 冻结；realpath 先规范化再取 basename，天然消解 `..` 与符号链接逃逸；白名单域校验（前缀匹配注册表目录 + resolved path 不逃逸出该目录）保证即使 renderer 被注入也只能触达注册表内路径。openExternal：main 侧既有 `/^https?:\/\//` 校验收紧为 `^https://`（拒 http/file:/javascript:/data:，S1 协调事项落地项）；校验失败 validation-error，不静默。renderer 输入一律不可信——校验在 main 侧强制，UI 禁用仅为体验层。

---

## 3. 模块划分

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `src/skills/registry.ts` | 注册表常量（D1 六目录 + affectedPlatforms 映射），单点维护 | —（纯常量） | CON-R-skills-001 |
| `src/skills/SkillFsOps.ts` | fs 抽象接口 + 生产/测试工厂（D3）：只读面 readdir/stat/readFile/realpath + 根目录注入 | —（node:fs 类型） | Q-037 |
| `src/skills/frontmatter.ts` | SKILL.md frontmatter 最小解析器：name/description/license/compatibility/metadata；缺失/坏 YAML → null 字段不抛错 | — | 共识 §7.2 |
| `src/skills/sourceResolver.ts` | 来源三级降级纯函数（D5）+ lock 文件输入注入 | frontmatter 输出类型 | CON-R-skills-005 |
| `src/skills/hash.ts` | SHA-256 内容哈希（path+content 排序）+ hash-cache.json 读写（mtime 键控失效） | SkillFsOps | CON-R-skills-009 |
| `src/skills/remoteHash.ts` | 远端哈希四级优先级获取（skills-lock → 平台 lock → cc-switch content_hash → git remote 临时 clone）；均无 unknown | SkillFsOps | Q-034 |
| `src/skills/SkillsScanner.ts` | 扫描管线门面：状态机编排（idle/scanning/ready/error）+ 七步管线 + 按 name 聚合去重 + 快照内存持有 | registry、SkillFsOps、frontmatter、sourceResolver、hash、remoteHash | skills:scan/getSnapshot/getStatus |
| `src/skills/pathGuard.ts` | 路径安全校验（D7）：basename(realpath) + 白名单域断言；S1/S2 共用 | SkillFsOps | Q-038 |
| `src/skills/searchRemote.ts` | npx skills find 封装：spawn/stdout 收集/30s 超时/输出映射（O-1 实测定） | —（child_process） | skills:searchRemote |
| `src/skills/errors.ts` | SKILL_SCAN_ERROR 具名错误（scan-error/remote-search-failed/validation-error，kebab 对齐 B1） | shared/errors HullError | 公共异常集 |
| `src/skills/ipc/SkillsIpc.ts` | 5 channel 注册 + KanbanIpcResult 包裹形态（registerSkillsIpc(scanner)，对齐 registerKanbanIpc 模式） | SkillsScanner | 全部 IPC |
| `src/renderer/skills.js` | Skills 视图 UI：工具条（双 tab/筛选/开关/重扫/回收站占位）+ 状态栏 + 列表 + 确认弹窗骨架（S2 填充动作） | window.skills 桥 | 前端行为契约 |

**依赖方向**（单向，无环）：`SkillsIpc → SkillsScanner → {registry, SkillFsOps, frontmatter, sourceResolver, hash, remoteHash, pathGuard}`；`searchRemote` 独立（仅 SkillsIpc 消费）；`pathGuard` 被 Scanner 与（S2 的）Ops 层共用，不反向依赖 Scanner。

**接入点（既有代码改动面，最小化）**：
- `src/shared/ipc-channels.ts`：新增 `SKILLS_IPC_CHANNELS`（5 条）并入 `ALL_IPC_CHANNELS`（P2-5 白名单纪律：新增 channel 必须更新清单）
- `src/preload/index.ts`：新增 `contextBridge.exposeInMainWorld('skills', {...})` 桥（4 invoke；本地搜索无通道不暴露）
- `src/window/WindowManager.ts`：`PlaceholderView` 联合类型加 `'placeholder:skills'` + `showSkills()` 方法（镜像 showSettings，封装 showPlaceholder + 推送）
- `src/main/index.ts`：`ipcMain.handle('hull:showSkills')`（镜像 hull:showBoard：quitting 检查 + winMgr.showPlaceholder('skills','')）+ 装配 `registerSkillsIpc`；`hull:openExternal` 校验收紧 `^https://`
- `src/renderer/shell.html`：nav 加 `#nav-skills` 按钮 + `<section id="skills">` 区块 + VIEW_TO_NAV 映射补一行（'placeholder:skills': 'nav-skills'）

---

## 4. 关键机制实现形态

### 4.1 扫描管线状态机（idle → scanning → ready/error）

```
idle ──skills:scan──▶ scanning ──七步管线完成──▶ ready
  ▲                     │                          │
  │                     ├─单目录/单条目异常─▶ scanning（继续，跳过该项记日志）
  │                     └─致命错误(userData 不可写)─▶ error（保留旧快照，error 带原因）
  └──────────────重新扫描（ready → scanning，幂等重启语义见下）──────────────┘
```

- **幂等触发**：scanning 中重复 `skills:scan` → 返回当前快照不重启（防重复管线并发跑）；ready 后再 scan → 重启管线（重扫语义固定：目录结构重遍历，哈希走 mtime 缓存）
- **原子快照替换**：管线产出完整 entries 数组后一次性替换内存快照对象（`this.snapshot = next`），scanning 期间 getSnapshot 返回上次 ready 快照（或首次为 []）——读者永远看到一致快照，无半成品态
- **异常分级**：单目录不存在 → 跳过（筛选下拉保留计数 0 标「未安装」，降级非错误）；单条目 SKILL.md 解析失败/symlink 循环/非法路径 → 跳过该项记日志；仅 userData 不可写/缓存损坏不可重建 → status=error（旧快照保留可读，可重试）
- **状态推进通知**：无推送通道（v1 轮询），renderer 250~500ms 轮询 getSnapshot 至 status=ready——与 installStatus 轮询先例一致，避免新增 event 通道

### 4.2 聚合去重（按 name 键 + realpath 同源）

```
for 每个注册表目录（存在者）:
  for 每个子目录 entry:
    real = realpath(entry.path)；循环/异常 → 跳过记日志
    pathGuard 校验 basename(real) → 失败跳过记日志（Q-038）
    seenRealpath.has(real)？
      是 → 仅把本目录 affectedPlatforms 并入已有条目对应 path 记录（同源不重复计）
      否 → 新建条目草稿 {name, paths:[PathInfo], ...}，seenRealpath.add(real)
聚合收尾：
  按 name 二次分组（跨目录同名合并）：platforms = 各路径 affectedPlatforms 并集
  scope = 任一路径 realpath 落于 ~/.agents/skills/ → global，否则 scoped
  description/source 取首个解析成功者（同名冲突以 shared/global 路径优先，§5.3）
  enabled = true（S1 恒真；S2 起由 disabled.json 映射推导）
```

- realpath 集合为**单次扫描内局部变量**（不持久化）——去重语义只在一次扫描内成立，跨次扫描靠全量重建天然正确
- 同 skill 多处版本不同（内容不同 → realpath 不同 → 各自成条目再按 name 合并）：以 global 路径为准标记 upgradable，平台徽标注明各路径，升级按目录逐处处理（S2 消费）

### 4.3 哈希缓存失效（mtime 键控）

- `hash-cache.json`：`{ version: 1, entries: { [absPath]: { mtimeMs, hash } } }`；写入走 temp+rename 原子写（SettingsProvider.set 先例）
- 命中判据：`cache[path].mtimeMs === stat.mtimeMs` → 直接用缓存 hash；不一致 → 重算并回写该条目（部分更新，非整文件重写全量）
- 失效兜底：JSON 损坏 → 告警 + 视为空缓存重建（哈希重算，不影响正确性只影响性能）；schema version 不符 → 整体废弃重建
- mtime 粒度说明：目录 mtime 只反映直接子项增删改名，深层文件改动可能不触发——**已知天花板**，标记 `ponytail:` 注释；升级检测场景下 S2 写操作自带 mtime 守卫 + 升级前后强制重算该路径哈希（不走缓存），正确性由 S2 兜底，S1 缓存只服务展示性能
- 性能预算：200+ skill 冷扫 = stat 全量 + 哈希分批（每批 16 个条目间 setImmediate 让出）；热扫（缓存命中）≈ 纯 stat 遍历，<2s 达标（T16/T17 验证）

### 4.4 远端哈希四级优先级（Q-034，检测侧归 S1）

```
resolveRemoteHash(name):
  ① ~/AI/skills-lock.json 按 name 匹配 → 命中即权威（覆盖后续所有层级）
  ② 各平台 lock（.arkcli-managed-skills.json 等）按 name 匹配
  ③ ~/.cc-switch/cc-switch.db content_hash（只读参考，数据自管不依赖其运行）
  ④ source 为 GitHub URL → 临时 clone 到 <userData>/skills/staging/（浅克隆）算哈希后清理
  均无 → remoteHash=null → upgradable=unknown「无法检测版本」（升级入口禁用，S2 主进程同样拒绝）
```

- 按 name 匹配、①优先覆盖；网络失败/超时 → 降级 unknown，**不影响本地列表**（§5.3）
- ④ 仅在前三层全缺失且有可解析 GitHub source 时触发（罕见路径）；clone 只写 staging 临时区，不污染用户仓库
- 口径实测对齐为协调事项（与 skills-lock.json / cc-switch content_hash 哈希算法一致性，实现期关闭；不一致则④自算口径并在方案偏离记录中显式登记）

### 4.5 远程搜索子进程（searchRemote）

- `spawn('npx', ['skills', 'find', query])`：query 经参数数组传递（不经 shell 拼接，杜绝注入）；空 query → validation-error 不 spawn
- stdout 全量收集 → 结束后一次性解析（O-1：输出 JSON 则直 parse，文本则行级映射；缺字段置 null）；30s 超时 kill → remote-search-failed
- 进行中重复调用允许并行（tab 切换清空由前端保证）；结果不缓存（同 query 随远端变化，读语义）

### 4.6 IPC 与白名单登记（P2-5 纪律）

| channel | handler 形态 | 返回包裹 |
|---|---|---|
| `hull:showSkills` | quitting 检查 + `winMgr.showPlaceholder('skills','')`（镜像 hull:showBoard） | `{ ok:true }` |
| `skills:scan` | scanner.scan() 幂等触发 | ScanSnapshot |
| `skills:getSnapshot` | scanner.snapshot() 内存读 | ScanSnapshot |
| `skills:searchRemote` | query 校验 + searchRemote() | `{ entries: RemoteSkillEntry[] }` |
| `skills:getStatus` | 快照派生计数（total/upgradable/disabled/global） | StatusCounts |

- 统一 `{ ok:true, data } | { ok:false, code, message }`（KanbanIpcResult 形态，toResult 包装器复用模式）；错误码 kebab-case（errors.ts 具名）
- preload `window.skills` 桥四方法，白名单固定不透传任意通道（D5 纪律延续）；SKILLS_IPC_CHANNELS 进 ALL_IPC_CHANNELS 共面

---

## 5. 工程基线

**判级**：复杂 + 安全敏感（头部一致）。

| 项 | 现状 | S1 动作 |
|---|---|---|
| git | ✅（M1 全程使用） | 直接复用 |
| 脚手架 | ✅（package.json：tsc 构建 dist/main + preload） | 直接复用，`src/skills/` 新增模块 |
| 测试框架 | ✅（node:test 单测 co-located + Playwright e2e，M1/M2 已有大量用例） | 复用框架，**新增**：`src/skills/*.test.ts`（registry/frontmatter/sourceResolver/hash/pathGuard/Scanner 聚合，SkillFsOps 注入临时目录）+ `tests/e2e/` Skills 视图用例（nav 切换/双 tab/筛选/空态，HULL_E2E 钩子扩展） |
| 安全扫描 | Semgrep 待确认安装 | **实现纪律强制项**：Semgrep 或等价工具（gitleaks/trivy）扫描通过方可交付；缺工具必须安装或换等价，不得跳过（判级安全敏感行） |

**技术栈决策**：跟随 M1/M2 既有栈——Electron + TypeScript（tsc）+ node:test + Playwright，**不引入新框架/新依赖**（不引 YAML 库/fs 监听库/队列库，YAGNI；frontmatter 手写最小解析器）。env 注入先例沿用（HULL_E2E 测试钩子扩展 skills 入口）。

---

## 6. 目录/工程结构

```
src/
├── skills/                          # S1 Skills 扫描子系统（新增）
│   ├── registry.ts                  # 六目录注册表常量（CON-R-skills-001 单点）
│   ├── SkillFsOps.ts                # fs 抽象接口 + 工厂（Q-037 DI；S2 扩展写面）
│   ├── frontmatter.ts               # SKILL.md 最小解析器（缺失降级不抛错）
│   ├── sourceResolver.ts            # 来源三级降级纯函数（CON-R-skills-005）
│   ├── hash.ts                      # SHA-256 + hash-cache.json（mtime 键控）
│   ├── remoteHash.ts                # 远端哈希四级优先级（Q-034）
│   ├── pathGuard.ts                 # basename(realpath)+白名单域校验（Q-038）
│   ├── searchRemote.ts              # npx skills find 封装（30s 超时）
│   ├── SkillsScanner.ts             # 管线门面：状态机+聚合+快照持有
│   ├── errors.ts                    # SKILL_SCAN_ERROR（kebab 错误码）
│   ├── ipc/
│   │   └── SkillsIpc.ts             # 5 channel 注册（KanbanIpcResult 包裹）
│   └── *.test.ts                    # node:test co-located（临时目录注入）
├── shared/ipc-channels.ts           # +SKILLS_IPC_CHANNELS（5 条）入 ALL_IPC_CHANNELS
├── window/WindowManager.ts          # PlaceholderView +'placeholder:skills'；showSkills()
├── preload/index.ts                 # +window.skills 桥（4 方法）
├── main/index.ts                    # +hull:showSkills handler + registerSkillsIpc 装配；openExternal 收紧 ^https://
└── renderer/
    ├── shell.html                   # +nav-skills 按钮 + section#skills + VIEW_TO_NAV 行
    └── skills.js                    # Skills 视图 UI（双 tab/筛选/状态栏/列表/弹窗骨架）
tests/e2e/                           # +skills-view.e2e.js（视图链路）
```

> userData 写面仅 `<userData>/skills/hash-cache.json`（S1）；disabled/trash/staging/log 由 S2 引入（见 S2 方案）。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| 目录约定无官方统一标准，各平台版本可能变化 | 扫描漏目/误判归属 | 注册表单点维护（改一处发版）；目录不存在降级「未安装」不报错；实测冒烟覆盖真实环境 | S1 |
| symlink 循环/悬空链接 | 扫描卡死/崩溃 | realpath 异常即跳过该项记日志，不阻塞整体（T18）；无递归下钻（只扫一层目录），循环天然有界 | S1 |
| 200+ skill 首屏超 2s | FR-10 验收不过 | mtime 缓存命中跳过哈希；管线分批让出事件循环；T16 构造 200+ 临时目录计时验收；超标再议 worker_threads（预留升级路径，不预做） | S1 |
| 深层文件改动不触发目录 mtime | 缓存陈旧哈希误标 latest | 已知天花板（ponytail 注释标记）；S2 升级路径强制重算兜底；「重新扫描」按钮提供强制入口（v1 缓存仅 mtime 键，不做内容比对） | S1+S2 |
| npx skills find 输出结构未知（O-1） | searchRemote 字段映射错 | 实现期实测定映射；缺字段置 null 不阻塞；解析失败 → remote-search-failed 降级，本地不受影响 | S1 |
| 远端哈希口径与 lock 文件不一致 | 误标 upgradable/漏标 | 协调事项实测对齐；不一致时④自算口径显式登记偏离；unknown 语义保守（宁可不提示不误报） | S1 |
| renderer 注入恶意 path/URL | 路径穿越/任意协议外链 | pathGuard 主进程强制（basename(realpath)+白名单域）；openExternal ^https:// 收紧；renderer 输入一律不可信（T19/O19/O20 验证） | S1 |
| 用户目录权限异常（部分目录不可读） | 扫描中断 | 单目录 readdir 失败 → 跳过该目录记日志（等同不存在），其余目录正常出列 | S1 |

---

## 8. 核验记录（交付核验时填写）

| 项 | 结果 |
|:---|:-----|
| 状态 | draft（评审通过后置 frozen，评审记录在此留痕：评审人/机制 + 日期 + 结论） |
| 实现偏离 | —（实现 vs 方案，交付核验时填；有意偏离更新本方案+记录理由，架构级偏离回 draft 重评） |
