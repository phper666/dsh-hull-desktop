# Skills 升级检测增强技术方案

> 状态：**frozen**（2026-08-27 评审通过）
> 关联：调研报告 docs/research/2026-08-27-skills管理调研.md（§四 P0 建议）· 共识-Hull桌面壳-Skills检查器.md（CON-R-skills-004 升级检测 / 010）· 需求标识 `skills-upgrade` · 分支 `feature/skills-upgrade`
> 子项：P0-1 git tree 签名接远端哈希梯子 / P0-2 SKILL.md 健康度 lint

## 1. 背景与范围

### 1.1 现状（代码级确认）

- 远端哈希梯子在 `SkillsScanner.ts:226-238`（⑥ 步）：`remoteHash = lock[name] → .arkcli 平台 lock → override`。`ponytail` 注记明确 ③cc-switch / ④git remote clone **未接入**。
- 本地哈希 `computeDirHash`（hash.ts）：SHA-256 over 排序后的 `(path\0content\0)`。localHash vs remoteHash 相等 → latest，不等 → upgradable，缺任一侧 → unknown（保守不误报）。
- `parseGithubSource`（UpgradeExecutor.ts:47）已能把 `metadata.source` 分解为 `{repoUrl, owner, repo, branch, subPath}`——tree 签名可直接消费。
- 契约限制：FR-10 首屏 <2s；`SkillsScanner` 七步管线同步执行；扫描快照原子替换。
- frontmatter 解析（frontmatter.ts）：**缺 name/description 只降级 null、不丢弃条目**（与 ZCode 两档丢弃模型不同——lint 规则须对齐 Hull 实际行为）。

### 1.2 范围

- 本方案只做「检测」侧：远端哈希来源增强 + SKILL.md 健康度标注。**不改升级执行**（UpgradeExecutor npx/git-staging 保持不动）。
- P0-1：metadata.source 为 GitHub 仓库时，用 git tree API 一次性签名替代「git remote 临时 clone」待办（Q-034 注记④），补上梯子第二档。
- P0-2：扫描时顺带产出 SKILL.md 健康度警告（只读标注，不改写）。

## 2. 架构决策

### 决策 1：远端签名算法 —— git tree blob SHA-1 签名（对齐 TokenTracker sourceSignatureFromTree）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| A. tree API 签名 | `GET /repos/{o}/{r}/git/trees/{branch}?recursive=1` 一次拿全树；对 `subPath` 下 blob 条目按 `(path, sha)` 排序 → SHA-256 整体 | ✅ 一次请求、不落盘、反映远端最新 |
| B. git remote 临时 clone | `git clone --depth 1` → computeDirHash | 网络+磁盘成本高；保留为升级执行路径 |

**选 A**。前提：source 是 GitHub 公开/可读仓库。

⚠️ **关键算法细节**：GitHub Trees API 返回的 blob `sha` 是 **git 对象 SHA-1**（git 默认对象哈希），非 SHA-256。因此：

- 远端签名 = `SHA-256( sorted([(relpath, blobSha1)]) )`，blobSha1 = `sha1("blob <len>\0" + content)`（subPath 内相对路径）。
- 本地侧须新增 `computeGitBlobSignature(dir)`：对本地 skill 目录每个文件算 git blob SHA-1 → 同规则排序哈希。**与现有 computeDirHash 算法不兼容**（后者是 path+content 的 SHA-256），需新增独立函数。
- 实现时**对照 TokenTracker `sourceSignatureFromTree`/`hashDirectory` 源码逐字节对齐**（报告 §1.1，以其 main 分支为准）。

### 决策 2：远端哈希梯子新档位

```
① 平台 lock（.arkcli 等，name→hash）——现状保留，最高优先
② metadata.source(GitHub) → tree 签名    ← 新增（本方案）
③ cc-switch content_hash                  ——保留待办注记（本机表空）
④ git remote 临时 clone                   ——保留待办注记（网络成本，被②替代）
均无/失败 → remoteHash=null → unknown「无法检测」（保守，不误报可升级）
```

- source 非 GitHub（gitlab/gitee 等）→ ②不适用 → 保持 unknown。**不**降级到④临时 clone（网络成本高，检测侧不值）。
- 平台 lock 命中 → 不进 ②（避免重复网络请求；lock 是标准位置权威）。

### 决策 3：网络请求位置 —— 后台异步预取，不进同步扫描管线

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| A. 扫描后后台预取 | 扫描同步完成（保持 <2s）→ 对有 GitHub source 的条目后台批量 fetch → 完成回调更新快照 → 事件推 UI | ✅ 打开即准确；后台网络活动可控（合并+限流） |
| B. 升级面板/详情按需 | 用户展开时才 fetch，更懒 | 打开时有 pending 状态，体验打折 |

**选 A**。约束：

- **同 repo 合并**：同一 `{owner, repo, branch}` 的所有 skill 共享一次 tree 请求（subPath 各自算签名）——16 平台场景请求数收敛到个位数。
- 并发 ≤2，失败静默降级 unknown（不重试风暴，下次扫描再试）。
- 预取完成后经既有快照事件机制推 UI（复用 `skills:scan` 快照订阅，不新增 IPC 面）。

### 决策 4：缓存与 TTL

- 进程内 `Map<repoKey, {signature, subPaths, at}>` + 持久化 `userData/skills/remote-sig-cache.json`（复用 hash-cache 同款原子写）。
- TTL 24h：命中缓存不请求；过期重取。扫描时若条目已含有效签名 → 直接 latest/upgradable，不触发预取。
- 避免：每次启动扫描都打 GitHub API。

### 决策 5：请求通道与失败语义

- 主进程 `net.fetch`（Electron 主进程全局 fetch），避开 renderer CSP。
- 未认证 60/hr/IP：合并请求 + TTL + 失败降级 unknown 三重兜底，不会误报可升级。
- 私仓无 token 配置 → tree API 401 → 降级 unknown（不引 token 配置复杂度，YAGNI）。

## 3. 模块划分

```
src/skills/gitTree.ts         （新）computeGitBlobSignature(本地目录→git blob SHA-1 签名)
                               + fetchTreeSignature(owner, repo, branch, subPath → 远端签名)
                               + RemoteSigCache（TTL 持久化）
src/skills/remoteHash.ts      （新）梯子实现：lock → tree 签名 → null（决策 2 顺序）
src/skills/lint.ts            （新）SKILL.md 健康度规则（决策 6）
src/skills/SkillsScanner.ts   （改）⑥ 接入梯子 + 扫描后异步预取 + 条目 lint 标注
src/skills/types.ts           （改）SkillEntry + lint 字段；StatusCounts 可选加 lintCount
src/skills/hash.ts            （不动）computeDirHash 保留（本地基础哈希仍用于无 git source 场景）
src/skills/ops/UpgradeExecutor.ts（不动）升级执行（npx/git-staging）零改动
```

依赖方向：Scanner → remoteHash → gitTree；Scanner → lint。

## 4. 关键机制实现形态

### 4.1 P0-1 异步预取流程

```
scan()（同步七步）
  └ ⑥ remoteHash = ladder(name, source)：
       lock 命中 → 用之
       source 为 GitHub → 查 RemoteSigCache 命中 → 用之；未命中 → 记 pending（不进同步请求）
       else → null
  └ 快照 ready（<2s，含 pending 条目 upgradable=unknown 待刷新）
scan 完成后（不阻塞）：
  └ preFetchRemoteSigs(pending 集合)：
       按 {owner,repo,branch} 分组 → 并发 ≤2 fetch tree
       → compute 各 subPath 签名 → 写缓存 → 更新快照条目 upgradable → 推事件
       → 失败：标记 unknown，下次扫描重试
```

### 4.2 签名计算（本地+远端一致性）

```
gitBlobSha1(content) = sha1("blob " + len(content) + "\0" + content)
signature(files: [(relpath, blobSha1)]) = sha256(sorted(files).map(f => relpath + "\0" + sha1).join("\0"))
本地：walk 目录（跳过 symlink/不可读，同 computeDirHash 语义）→ 每文件 gitBlobSha1 → signature
远端：tree entries 过滤 subPath 前缀 + type=blob → (相对 relpath, sha) → signature
```

⚠️ 远端 `sha` 是 GitHub 已算好的 git SHA-1，本地须用同一 `gitBlobSha1` 公式——**实现时以 TokenTracker 源码为对齐基准**（两者必须逐字节一致，否则永远 upgradable）。

### 4.3 P0-2 SKILL.md 健康度 lint（决策 6）

规则（**对齐 Hull 实际行为**：缺字段降级 null、不丢弃条目）：

| level | 规则 | 依据 |
|:------|:-----|:-----|
| warn | 无 frontmatter 或缺 `name` | 无法按名聚合/识别（ZCode 两档：加载即丢；Hull 保留但语义弱化） |
| warn | 缺 `description` 或为空 | 无触发描述，模型难触发 |
| warn | `description` > 1024 字符 | ZCode 硬失败阈值；超长难用 |
| info | 无 `metadata.source` | 无法升级检测（remoteHash 无来源，恒 unknown） |
| info | `metadata.source` 非 https/git 形态 | sourceResolver 降级 null 同理 |

输出：`SkillEntry.lint: { level: 'warn'|'info'|null, issues: string[] }`。只读标注，UI 检查器条目旁显示警告图标 + tooltip 列表。不触文件、不改状态机。

## 5. 工程基线

- git ✅（feature/skills-upgrade）/ 脚手架 ✅（Electron+TS）/ 测试 ✅（vitest，skills 模块既有测试）
- 技术栈：跟随存量（无新运行时依赖；`net.fetch` 为 Electron 内置）。无新依赖。
- 测试分层：
  - 单测（必选）：`computeGitBlobSignature`（对照 git 真实 blob sha 固定样例）、`signature` 排序稳定性、梯子降级（mock fetch）、缓存 TTL、lint 规则各分支
  - 集成：scanner 预取流程（注入 mock fetch + 事件断言）
  - e2e：可选（UI 警告展示冒烟）

## 6. 目录/工程结构

仅新增 3 文件 + 改 3 文件（见 §3），无新目录。

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|:-----|:-----|:-----|
| git blob SHA-1 公式与 TokenTracker 算法不一致 → 恒 upgradable 误报 | 高 | 实现时对照 TokenTracker 源码逐字节对齐 + 固定样例单测（本地/远端同源签名相等） |
| tree API 大 repo 响应体 / rate limit | 中 | 同 repo 合并 + TTL 缓存 + 并发≤2 + 失败降级 unknown |
| 私仓 source 无 token | 低 | tree API 401 → unknown（不引 token 配置） |
| 预取异步更新与 UI 快照竞争 | 中 | 复用快照原子替换 + 事件机制；pending→刷新仅改 upgradable 字段 |
| lint 规则与 Hull 解析行为漂移（如未来丢弃语义变化） | 低 | 规则表注释标注依据 + 单测锁行为 |

## 8. 核验记录

（交付核验时填写）

### 实现核验（2026-08-28，feature/skills-upgrade）

**实现 vs 方案偏离清单**：

| # | 方案 | 实现 | 理由 |
|:--|:-----|:-----|:-----|
| D1 | 设计假设存在「skills:scan 快照订阅」事件通道 | 实际无 skills 事件通道——renderer 靠 `getSnapshot` 300ms polling。实现：`ScanSnapshot` 新增可选 `refreshing?: boolean`，预取期间置 true，renderer polling 条件扩为 `scanning \|\| refreshing`（复用既有 polling 机制，不新增 IPC 面） | 设计决策 3 约束「复用既有快照通知机制、不新增 IPC 面」的最小平移；`refreshing` 可选字段向后兼容（旧 renderer 忽略） |
| D2 | `RemoteSigCache` value 含 `subPaths` 列表（决策 4） | 按任务规格实现为 `{sig, at}`，键 = `owner/repo#branch#subPath`（owner/repo 消歧防跨仓碰撞） | 任务规格（Map<repoKey(branch+subPath)→{sig,at}>）优先；预取按 group 共享 tree 后逐 subPath 写独立键，无需 subPaths 列表 |
| D3 | 设计 §3「StatusCounts 可选加 lintCount」 | 未实现 | 任务 P0-2 规格未要求（4-7 项均无）；`可选`措辞，保持手术式最小改动。需要时一行可加 |
| D4 | TokenTracker `sourceSignatureFromTree`/`hashDirectory` 源码逐字节核对 | 实现期网络不可达，按设计 §4.2 公式实现；**主线程复核已拉到 TokenTracker main 实际源码**（`xiufengsun/TokenTracker/src/lib/skills-manager.js`）：`sourceSignatureFromTree = sha256(sorted(["path:sha",...]).join("\\n"))`，`hashDirectory = sha256(rel\\0execBit\\0<content>\\0...)` —— TokenTracker 自身两端算法即不兼容（本地含 execBit+content、远端是 git blob SHA-1）。本实现两端共用同一 `signatureFromFiles`（`sha256(sorted((rel,blobSha1)).map(rel+"\\0"+sha).join("\\0"))`），**内部一致 = 正确性保证**（同内容必同签名，由「两端签名一致」单测锁定）；与 TokenTracker 格式差异仅影响跨工具哈希互认，不影响 Hull 本地↔远端升级判定。git blob SHA-1 公式（`sha1("blob <len>\\0"+content)`）已用 `git hash-object` 固定样例验证 = git 规范对象哈希，与 GitHub tree sha 同源 | 接受偏离：内部一致性满足正确性；格式不对齐 TokenTracker 无害（无互操作需求）。gitBlobSha1 已单测锁定 |

**TokenTracker 算法对齐确认**：本实现引用了设计 §4.2 公式（`gitBlobSha1(content) = sha1("blob " + len + "\0" + content)`；`signature = sha256(sorted((relpath, blobSha1)).map(f => relpath + "\0" + sha1).join("\0"))`）——即调研报告 §1.1「hashDirectory（SHA-256 全文件 path+content 排序）/ sourceSignatureFromTree（子目录内 path+sha 排序后哈希）」的精确化。TokenTracker main 分支源码行号未能复核（网络不可达，见 D4）。

**验证结果**：`npm run typecheck` ✅；`node --test dist/skills/**/*.test.js` 136 用例全绿（新增 gitTree 11 + lint 9 + remoteHash 7 + scanner P0-1/P0-2 7）；`npm run test:unit` 682 用例全绿。


## 评审记录

| 评审人 | 机制 | 日期 | 结论 |
|:---|:---|:---|:---|
| 用户（phper666） | review | 2026-08-27 | **通过（A）**——4 决策点无异议，冻结可进实现。附带同期完成：注册表 affectedPlatforms 官方校验修正（CON-R-skills-001/002）+ UX 归属透明化（已入变更摘要） |
