# SK-1 升级检测增强实现记录

> 关联：设计 docs/design/SK-1-升级检测增强-skills-upgrade-design.md（frozen 2026-08-27）+ 调研 docs/research/2026-08-27-skills管理调研.md + 共识-Hull桌面壳-Skills检查器.md（CON-R-skills-004/010）
> 需求标识：`skills-upgrade` · 分支：feature/skills-upgrade

## 判级

- 复杂（外部系统集成 GitHub API + 异步预取 + 哈希算法一致性 + 扫描 <2s 红线）→ 技术方案 + 完整实现纪律

## 实现清单

| 子项 | 改动 | 文件 |
|:-----|:-----|:-----|
| P0-1 | git tree 签名：gitBlobSha1 / computeGitBlobSignature（本地）/ fetchGitTreeImpl + signatureFromTreeEntries（远端）/ parseGithubSourceForTree / RemoteSigCache（TTL 24h 持久化） | src/skills/gitTree.ts（新） |
| P0-1 | 远端哈希梯子：lock ① → GitHub tree 签名 ②（缓存命中/拉取/pending）→ null | src/skills/remoteHash.ts（新） |
| P0-1 | scanner ⑥ 接入梯子；扫描后后台预取（同 repo 合并一次 tree、并发≤2、失败降级 unknown、refreshing 标志） | src/skills/SkillsScanner.ts |
| P0-2 | SKILL.md 健康度 lint（warn 3 条 + info 2 条） | src/skills/lint.ts（新） |
| P0-2 | SkillEntry.lint 字段 + 条目标注；ScanSnapshot.refreshing | src/skills/types.ts |
| P0-2 UI | lint 徽标（warn/info）+ 详情健康度列表 + refreshing 状态栏 | src/renderer/skills.js/.css |

## 验证

| 项 | 结果 |
|:---|:-----|
| typecheck | ✅ tsc --noEmit 干净 |
| 单测 | ✅ **682/682 绿**（新增 gitTree 11 + lint 9 + remoteHash 7 + SkillsScanner +7） |
| Semgrep | ✅ 1.172.0，210 rules / 5 文件，**0 findings** |
| Code Review | ⚠️ ocr 401（opencode.ai 余额不足，同 C1 先例）→ **降级 AI 自查**：gitTree/remoteHash/lint/scanner 集成逐文件审查通过 |
| 算法对齐 | ✅ 主线程拉 TokenTracker main 实际源码复核（见偏离 D4）：本实现两端内部一致 = 正确性保证；gitBlobSha1 = git 规范对象哈希（git hash-object 固定样例验证） |

## 实现 vs 方案偏离清单

| # | 方案 | 实现 | 处理 |
|:--|:-----|:-----|:-----|
| D1 | 复用「skills:scan 快照订阅」推 UI | 实际无事件通道 → ScanSnapshot.refreshing + 既有 polling 推 UI | 最小平移，不新增 IPC 面 |
| D2 | RemoteSigCache value 含 subPaths | 实现 {sig, at}，键 owner/repo#branch#subPath 消歧 | 任务规格优先 |
| D3 | StatusCounts 可选加 lintCount | 未做 | 方案措辞「可选」，手术式最小改动 |
| D4 | TokenTracker 算法逐字节对齐 | TokenTracker 实际 = `sha256(sorted("path:sha").join("\n"))`（远端）/ `sha256(rel\0execBit\0content...)`（本地，**自身两算法不兼容**）；本实现 = `sha256(sorted(rel,gitBlobSha1) \0 分隔)` **两端共用同一函数** → 内部一致 | 接受：内部一致即正确（同内容必同签名，单测锁定）；与 TT 格式差异无互操作需求，无害 |

## 核验结论

- 检测侧（tree 签名 + lint）按冻结设计实现，关键正确性点（tree 轨本地对照用 git-blob 签名、缓存/预取/降级、lint 规则）全部落地并有测试锁定
- 执行侧（UpgradeExecutor npx/git-staging）零改动 ✓
- 范围外：P1-3 用量分析、P1-4 effective 展示、P1-5 curated 源（挂后续规划）
