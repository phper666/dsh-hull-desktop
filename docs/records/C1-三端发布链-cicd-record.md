# cicd 三端发布链实现记录

> 关联：共识 v1.1（docs/spec/共识-Hull桌面壳-CI发布.md）+ 设计（docs/design/C1-三端发布链-cicd-design.md，frozen）
> 子需求：C1（三端构建矩阵 workflow）/ C2（版本 bump 策略）/ C3（CI 生成 node + 发布）/ C4（平台适配验证 + 失败隔离可观察性）
> 分支：feature/cicd

## 判级

- 复杂（跨平台构建矩阵 + 外部系统集成 + 版本 bump 状态机 + mac 双架构）→ 技术方案 + 完整实现纪律

## 实现清单

| 子需求 | 改动 | 文件 |
|:-------|:-----|:-----|
| C1 | workflow_dispatch + 多端 matrix（mac arm64+x64 / win / linux）+ bump job + release-body job | .github/workflows/release.yml（演进自 mac-only） |
| C2 | 三档 bump 脚本 + 单测 | scripts/bump-version.mjs（新）+ bump-version.test.mjs（新，10 用例） |
| C3 | CI 各 runner 按平台生成 node + electron-builder 发布 | workflow fetch-node step + electron-builder.yml `${arch}` 宏 + fetch-node.mjs +darwin-x64 |
| C4 | 失败隔离 fail-fast:false + release body 资产驱动标注（Q-060） | workflow release-body job |

## 实现 vs 方案偏离

| 方案 | 实现 | 处理 |
|:-----|:-----|:-----|
| §4.1 matrix status output 聚合 | 改资产驱动标注（gh release view 读真实资产按存在性）——matrix 同名 output 会被最后完成覆盖，不可靠 | 实现细化（更稳） |
| §4.1 bump 先于 build | 方案 A 三阶段修正：build（--publish never）→ release（打 tag+发布）→ bump（发布后 +1）——原实现 bump 先于 build 导致 CI 失败也 bump（污染版本线 + tag 残留）；改为发布当前分支 version，bump 是发布成功的事后动作，失败零污染 | 实现偏离修正（用户拍板 A） |
| fetch-node darwin-x64 | 方案未列；实现补注册表（mac Intel 需） | 实现补齐 |
| electron-builder extraResources | 方案 §4.3 隐式；实现用 `${arch}` 宏（经 deepwiki 确认支持） | 实现细化 |

## 验证

| 项 | 结果 |
|:---|:-----|
| bump-version 单测 | ✅ 10/10 绿（三档递增 + 边界 + 非法输入） |
| typecheck | ✅ tsc --noEmit 无错 |
| unit 全量 | ✅ 645/645 绿（既有 + fetch-node 未破坏） |
| workflow YAML | ✅ js-yaml 解析通过 |
| semgrep | ✅ 0 findings（修 3 处 shell 注入：bump/commit/release-notes env 化） |
| code review | ⚠️ ocr 401 认证失败（LLM key）→ 降级 AI 自查：修 fetch-node 注入（P1）、确认 release-body 兜底（P2） |

## 关键决策

- **mac 双架构决策 6**：双包 arm64 + x64（用户拍板 B），各包自带对应架构 node，electron-updater 按 arch 选；extraResources 用 `${arch}` 宏零 src/ 改动
- **bump 用内置脚本**（bump-version.mjs ~30 行无依赖）非 npm version（隐式行为杂）
- **release body 资产驱动**（gh release view）而非 matrix output 聚合（不可靠）
- **并发锁按版本线分组**（concurrency.group: release-${{ inputs.branch }}）解决并发发布竞态（Q-058）

## 遗留/待拍板（2026-08-27 全部闭环）

- ~~**CI 实测**~~：✅ 已实测（0.1.1~0.1.4 经 CI 发布，三端资产齐全，见下节）
- ~~**macos-13 runner 退役**~~：✅ 已落地——matrix 改 macos-latest + `--x64` 交叉编译（workflow 当前态，Intel Mac 走 ARM runner 交叉）
- ~~**Node 20 弃用警告**~~：✅ 已升级——checkout/setup-node v5 + upload/download-artifact v7（node24，用户确认发版无告警）
- **release-body 兜底**：bump 失败时 build 不跑，release-body 静默跳过（`|| echo` 兜底）——保留（低风险）

## CI 实测发现（2026-08-25，run #1/#2）

| 问题 | 根因 | 处理 |
|:-----|:-----|:-----|
| Linux deb 打包失败 | package.json 缺 author.email → deb 无 maintainer | 补 author（commit 1952c27） |
| macos-13 job 卡住 | GitHub Intel Mac runner 队列枯竭/退役，等不到 runner | matrix 改 macos-latest + --x64 交叉编译（已提交） |
| Node 20 弃用警告 | checkout/setup-node/upload-artifact 用 v4（目标 Node 20），被迫 Node 24 跑 | 已升级 v5/v7（node24） |
| 三阶段方案 A | bump 先于 build 会污染版本线 | workflow 重构 build→release→bump（commit b6bcb7c） |

## 复测发现（2026-08-27，0.1.2 用户实测更新 404）

| 问题 | 根因 | 处理 |
|:-----|:-----|:-----|
| **更新下载 404（全平台，0.1.1 起）** | `productName: Dsh Hull Desktop` 含空格 → electron-builder 写 `latest-*.yml` url 空格转连字符（`Dsh-Hull-Desktop-...`），GitHub 存资产时空格转点号（`Dsh.Hull.Desktop-...`）→ yml 广告名 ≠ 资产名 → 更新必 404。linux deb 用 package name（无空格）幸免 | 三平台显式硬编码连字符 `artifactName`（electron-builder.yml），保证文件名==yml url==资产名（PR #2，commit 7fb9281） |
| v0.1.4 release 混入 200+ 垃圾资产 | 上传 glob `release/*` 把解包 `.app`/`*-unpacked`/`node` 内容也传进 artifact | build 上传 + release 上传改扩展名白名单（PR #2，commit 7fb9281） |
| v0.1.4 缺 win/linux 安装包 | 部分发布（仅 mac 资产） | 0.1.5 完整三端发布验证 |
| **经验教训** | 产物命名含空格 = 三处命名链（磁盘文件名/yml url/GitHub 资产名）不一致，静默 404 | 沉淀 docs/lessons/2026-08-27-electron-builder-artifact-name-space-404-lesson.md |
