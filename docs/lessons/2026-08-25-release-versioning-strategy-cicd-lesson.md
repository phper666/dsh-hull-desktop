# 发版版本策略：分支模型 + semver 三档 + workflow_dispatch 手动触发

| 项 | 内容 |
|:---|:-----|
| 背景 | Hull 桌面壳（Electron + electron-builder + electron-updater）要落地 CI/CD 发布链。设计发布流程时对「patch/minor/major 三档怎么用」「旧版本线怎么维护」「分支模型怎么走」反复拉扯，最终定稿一套跨项目可复用的发版版本策略。 |
| 决策或坑 | ① **patch/minor/major 不是三条并行发布线，是同一个 version 字段的三种递增幅度**——每次发布只走一步，共用 main，不存在三档写 version 冲突。② **自定义语义（贴合单人/小团队）**：patch=小改（bug+小功能随时发）、minor=攒批发布（累计多版本功能发一次，常规节奏非稀有）、major=破坏性重构（页面/架构重构，低频稀有）。③ **版本线维护（backport）独立于档位**：「放弃维护旧版本」是独立 EOL 决策，不绑 minor；main 走远 + 有用户锁旧版 → 从旧 tag 拉 `release/x.y` 只发 patch，修复 cherry-pick 回 main。④ **发布 = 当前分支 version，bump 是发布成功的事后动作（三阶段）**：workflow 加 `branch` 输入（默认 main）；发布读**所选分支** package.json 当前 version（不先 +1），构建验证（--publish never）→ 全成功后打 tag + 发布 → 成功后 bump 版本（下个迭代基线）。bump 先于发布 = CI 失败也 bump（污染版本线 + tag 残留），必须避免。⑤ **并发锁按版本线分组**：`concurrency.group: release-${{ inputs.branch }}`——同线串行、异线并行（main 发 minor 与 release/0.1.x 发 patch 可同时跑）。⑥ **matrix 多端必须同 branch**：多端并行各 runner checkout 同一 branch，否则 mac 发 0.1.1、win 发 0.1.2 乱套。⑦ **自动更新项目旧线 patch 只对锁版用户有效**：electron-updater 永远跳最新，main 已发 0.2.0 时旧线 0.1.1 不会推给自动更新用户。⑧ **workflow 回写分支需分支保护豁免**：bump job 用 `github-actions[bot]` 直接 commit+push 回 main——若 main 加规则集/分支保护（强制 PR 合并/状态检查），GITHUB_TOKEN 直接 push 会被拒，发布链断；需在规则集 Bypass list 加 `github-actions[bot]`（CI 发布是自动化流程应豁免），或 workflow 改用 PAT（repo secret）。⑨ **macos-13 runner 已退役/不可用**：GitHub Actions 的 Intel Mac（macos-13）runner 分配不可靠（队列枯竭/退役），打 mac x64 需改用 macos-15（ARM runner）+ electron-builder `--x64` 交叉编译，或接受 macOS 仅 arm64。 |
| 影响 | 不按此策略：三档语义混乱（把 minor 当大版本、把 EOL 绑进档位）、旧线维护无从下手（main 走远不知道 patch 从哪发）、并发发布竞态（tag 冲突 / 版本不一致）、matrix 三端版本漂移、加分支保护后发布链断（bump push 被拒）。 |
| 适用范围 | 任何 git + 版本号（semver）+ 自动更新（electron-updater 等）的桌面应用/服务发布。尤其单 main 线起步、将来可能要维护旧版本线的项目。不适用无版本号/无多端发布的项目。 |
| 来源 | 出生：cicd 需求（2026-08-25，docs/spec/共识-Hull桌面壳-CI发布.md）；引用：CON-R-cicd-003、phper666-git-worktree（维护线）、electron-builder/electron-updater 行为、GitHub 分支保护/规则集。 |
| 引用 | 首次引用：本 lesson 出生（2026-08-25）。自证：90 天内除本行外零新增引用 → 删除候选。 |

## 教训（可复用规则）

1. **semver 三档 = 幅度不是通道**：patch/minor/major 共用同一 version 字段、都从 main 发，每次只走一步。自定义语义（patch=bug+小功能 / minor=攒批 / major=重构）对无外部 API 消费者项目成立，但要文档写清。
2. **版本线维护独立于档位**：EOL 是独立决策不绑 minor；main 走远 + 用户锁旧版 → 从旧 tag 拉 `release/x.y`，只发 patch，cherry-pick 回 main。其他分支只做 bug 修复，永不发 minor/major。
3. **发布 = 当前分支 version，bump 是发布成功的事后动作（三阶段）**：workflow `branch` 输入（默认 main）；发布读所选分支 package.json 当前 version（不先 +1），构建验证（--publish never）→ 全成功后打 tag + 发布 → 成功后 bump 版本留作下个迭代基线。**bump 必须先于发布**是常见错误——CI 失败也 bump（污染版本线 + tag 残留），三阶段保证失败零污染可无限重试。
4. **并发锁按版本线分组**：`concurrency.group: release-${{ inputs.branch }}`，同线串行异线并行。
5. **matrix 必须同 branch**：多端并行 checkout 同一 branch，防止版本漂移。
6. **自动更新项目的旧线 patch 只服务锁版用户**：electron-updater 永远跳最新，旧线 patch 不推给自动更新用户。
7. **workflow 回写分支需分支保护豁免**：CI 发布 workflow 直接 push 回 main 时，若 main 有规则集/分支保护（强制 PR/状态检查），必须把 `github-actions[bot]` 加进规则集 Bypass list（或 workflow 用 PAT）——否则 GITHUB_TOKEN push 被拒，发布链断。加分支保护前先配置豁免。
8. **macos-13（Intel Mac）runner 不可靠**：GitHub Actions 的 macos-13 runner 分配不稳定（队列枯竭/退役），需打 mac x64 时改用 macos-15（ARM）+ `--x64` 交叉编译，或接受 macOS 仅 arm64。
