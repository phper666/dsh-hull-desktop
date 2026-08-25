# Hull CI/CD 发布流程 PRD

> 版本：v0.1 · 日期：2026-08-25 · 状态：待评审
> 需求标识：`cicd` · 归属：Hull 模块（构建/分发/CI）
> 上游：packaging 需求（docs/prd/2026-08-25-hull-packaging-prd.md）U-2 CI 自动化落地

## 1. 背景

packaging 需求已交付三端打包配置（electron-builder 三平台 target）+ 三端捆绑 node + GitHub Releases 更新源，但**发布链仍手动**——现有 `.github/workflows/release.yml` 仅 mac 单端、tag push 触发，win/linux 打包从未实测。packaging 共识 U-2「CI 自动化」登记为 P2 排后（触发条件：发布频率提升），现触发条件达成。本需求落地三端 CI/CD 发布链，把「手动打包」升级为「一键三端打包发布」。

## 2. 目标

- 三端（macOS/Windows/Linux）在 GitHub Actions 并行构建打包
- 发布到 GitHub Releases（electron-updater 三端更新源，latest 元数据自动生成）
- workflow_dispatch 手动触发（用户拍板：发布频率低，手动可控 + 不浪费 runner 额度）
- 演进现有 release.yml 为三端 matrix（复用 GH_TOKEN/secrets，不重配）
- win/linux 打包首次实测（此前从未在对应平台验证）

## 3. 非目标（本轮不做）

- 代码签名/公证（macOS Developer ID / Windows EV 证书）——沿用 CON-R-packaging-005 暂不签名
- tag push 自动触发（用户拍板选手动触发；可后续加）
- 跨平台交叉编译（各平台原生 runner 打包）
- 商店分发（App Store / MS Store / Snap）
- 自动化测试门禁（本轮仅构建+发布，测试仍本地跑）

## 4. 需求详述

### FR-1 三端构建矩阵
- GitHub Actions matrix：`macos-latest`（dmg+zip）/ `windows-latest`（nsis+portable）/ `ubuntu-latest`（AppImage+deb）
- 各 runner 原生构建，不做交叉编译（CON-R-packaging-007：单平台失败不阻塞其他平台）

### FR-2 workflow_dispatch 手动触发 + 版本策略
- `on: workflow_dispatch`，带输入：`branch`（默认 main）+ `version`（patch/minor/major 三档）+ `release_notes`（可选）
- 发布源 = 所选 branch，bump 读所选分支 package.json 当前 version 走一步递增，tag 打所选分支 HEAD
- 版本一致性：发布版本 = bump 后 tag，产物与 tag 同步
- 三档语义：patch=小改（bug+小功能）/ minor=攒批发布 / major=破坏性重构
- 版本线维护：main 走远 + 用户锁旧版 → 从旧 tag 拉 release/x.y 只发 patch，cherry-pick 回 main
- 并发锁按版本线分组（concurrency.group: release-${{ inputs.branch }}）
- matrix 三端 checkout 同一 branch

### FR-3 CI 上生成捆绑 node（三端）
- CI 各 runner 跑 `node scripts/fetch-node.mjs` 按平台生成 node 产物（win32-x64 当前缺失，CI 补齐）
- 三端 node 版本锁定一致（现 24.10.0），SHA256 校验 + 幂等复用（沿用现有脚本）

### FR-4 electron-builder 发布到 GitHub Releases
- `npx electron-builder --publish always`（各 runner 对各自平台产物发布）
- GH_TOKEN 复用仓库现有 secret（Contents+Actions 写权限，S5 契约已配）
- 产物：mac dmg+zip / win nsis+portable / linux AppImage+deb → 同一 GitHub Release

### FR-5 latest 元数据自动生成
- electron-builder 自动生成 `latest-mac.yml` / `latest.yml` / `latest-linux.yml`（各平台对应）
- electron-updater 三端读取同源，自动更新链延续（PK3 已铺）

### FR-6 前置门禁
- 打包前跑 `npm run typecheck` + `npm run build`（编译失败提前止损，不进入打包）
- （可选，本轮不强制）unit test 门禁——测试仍本地跑，CI 仅 typecheck+build

### FR-7 失败隔离
- 单平台打包失败不阻塞其他平台（matrix 并行天然隔离，CON-R-packaging-007）
- 部分平台成功后 release 部分产物 + 失败平台在 job 输出标注，人工补打

## 5. 验收标准（可测试）

1. 手动触发 workflow（带/不带 version 输入）能跑通三端 matrix 构建
2. mac dmg+zip / win nsis+portable / linux AppImage+deb 三端产物都上传到同一 GitHub Release
3. GitHub Release 含 latest-mac.yml + latest.yml + latest-linux.yml 更新元数据
4. win32-x64 node 产物由 CI 自动生成并打进 win 包（不依赖本机 vendor）
5. typecheck/build 失败时 workflow 提前失败，不浪费打包步骤
6. 单平台失败时其余平台仍出包，release 含部分产物
7. 打出的 tag 与 version 输入一致（缺省 = package.json version）

## 6. 不做事项

- 代码签名/公证（沿用暂不签名）
- tag push 自动触发（手动触发先行，可后续加）
- 跨平台交叉编译
- 商店分发
- 测试门禁（本地跑）

## 7. 风险

- **win/linux 首次实测**：electron-builder nsis/AppImage/deb 在对应 runner 首次构建可能踩路径/权限坑 → CI 上跑真实构建暴露，本地无法预演
- **runner 额度**：每次触发消耗 mac+win+linux 3 个 runner（mac runner 有额度限制）→ 手动触发缓解
- **GH_TOKEN 权限**：fine-grained PAT 需 Contents+Actions 写权限（S5 已配，验收时确认）
- **win 打包工具链**：nsis 打包需下载 nsis 工具链（electron-builder 自动），首次可能慢/需代理
