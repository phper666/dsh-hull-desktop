# Hull CI/CD 发布链技术方案

> 状态：frozen（评审通过·冻结，可进实现）
> 关联：共识 v1.1（docs/spec/共识-Hull桌面壳-CI发布.md）+ CON-R-cicd-001~008 + PRD（docs/prd/2026-08-25-hull-cicd-prd.md）+ 经验（docs/lessons/2026-08-25-release-versioning-strategy-cicd-lesson.md）

## 1. 背景与范围

- packaging 已交付三端打包配置（electron-builder 三平台 target + 捆绑 node + GitHub Releases 更新源），但发布链仍手动、mac-only（现有 `.github/workflows/release.yml` 38 行：tag push → macos-latest → electron-builder --publish always）
- 本需求落地三端 CI/CD 发布链：三端 matrix 并行构建 + workflow_dispatch 手动触发 + 版本 bump 策略 + CI 生成捆绑 node + 发布 GitHub Releases + 失败隔离
- 子需求：C1（三端构建矩阵 workflow）/ C2（版本 bump 策略）/ C3（CI 生成 node + 发布）/ C4（平台适配验证 + 失败隔离可观察性）
- **关键：C1~C4 全是 CI workflow 配置（YAML），无代码接口 → 无 API 契约，技术方案即设计文档**

## 2. 架构决策

### 决策 1：构建矩阵三端（C1）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. GitHub Actions matrix（选）** | macos-latest / windows-latest / ubuntu-latest 并行，各平台原生构建 | 平台隔离天然（CON-R-cicd-008），无需交叉编译，matrix 一行配多平台 |
| B. 单 workflow 串行三平台 | 一个 runner 顺序打 | 慢 + 需跨平台工具链，违背「并行」目标 |

选 A：matrix 并行 + 平台隔离，符合共识「单平台失败不阻塞其他平台」。

### 决策 2：触发 + 版本 bump（C2）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. workflow_dispatch + 三档 bump + concurrency 按分支分组（选）** | 输入 branch（默认 main）+ version（patch/minor/major）；bump 读所选分支 package.json 走一步；并发锁 `release-${{ inputs.branch }}` | 全自动 bump，发布版本=tag 同步（Q-057）；按版本线分组锁（Q-058） |
| B. tag push 自动触发 | push v* 即发 | 用户拍板手动触发（发布频率低，手动可控） |
| C. version 手动输入 | 手动输版本号 | 有版本不一致风险（Q-057 已否决） |

选 A：全自动 bump + 手动选档 + 按分支分组并发锁，完整支持版本线维护。

### 决策 3：CI 生成捆绑 node（C3）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. CI 各 runner 跑 fetch-node --platform（选）** | 每平台 runner 跑 `node scripts/fetch-node.mjs --platform <平台>` 生成 vendor node，electron-builder extraResources 内嵌 | win32-x64 本机缺失，CI 补齐（Q-059）；复用现有脚本幂等/SHA256 |
| B. 预提交三端 vendor | 仓库提交三端 node | vendor 体积大（~100MB/平台），git 膨胀 |

选 A：CI 按平台生成，仓库零 vendor 提交（现有 .gitignore 已含 vendor/）。

### 决策 4：发布 GitHub Releases（C3）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. electron-builder --publish always（选）** | 各 runner 对各自平台产物发布，electron-builder 自动生成 latest-*.yml | 复用现有 publish provider（github）+ GH_TOKEN；三端发同一 Release |
| B. gh release 手动上传 | 手动 | 违背自动化目标 |

选 A：延续 packaging PK3 已定的 GitHub Releases 源，electron-builder 原生支持。

### 决策 5：版本 bump 实现（C2，关键机制）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. 内置脚本 scripts/bump-version.mjs（选）** | 读 package.json → 按档位 bump → 写回 + 打 tag | 自包含，~30 行，无第三方依赖（贴合 fetch-node 风格） |
| B. npm version | 内置但行为杂（commit/tag 一起做） | 少控 |
| C. 第三方 action（release-please 等） | 功能多但重，含 PR 流程 | 过重，本项目手动触发不需要 |

选 A：最小自包含脚本，CI 调用，git commit + tag 由 workflow 步骤做（不用 npm version 隐式行为）。

### 决策 6：mac 双架构（arm64 + x64 双包）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. 双包 arm64 + x64（选）** | macos-latest（arm64）+ macos-13（Intel x64）各打一包，electron-updater 按 arch 选 | 各包自带对应架构 node，零 src/ 改动；纯 CI 配置 |
| B. universal 单包 | 一个 .app 双 slice | 捆绑 node 需双份+按 arch 选（动 src/overlay+runtime 架构逻辑），超出纯 CI 边界 |

选 A：双包纯 CI 配置，捆绑 node 各包自带（fetch-node --platform darwin-arm64 / darwin-x64），electron-updater 原生按用户芯片选对应包（latest-mac.yml 分 arch 条目）。覆盖 Intel + ARM Mac。

## 3. 模块划分

| 模块 | 职责 | 依赖 |
|:-----|:-----|:-----|
| .github/workflows/release.yml（演进） | workflow_dispatch 输入 + 多端 matrix（mac 双架构）+ 步骤编排 | C1 |
| scripts/bump-version.mjs（新） | 三档 bump（patch/minor/major），读 package.json | C2 |
| scripts/fetch-node.mjs（复用） | CI 各 runner 按平台生成 node（darwin-arm64/x64 + win + linux） | C3 |
| electron-builder.yml（复用） | 三平台 target + extraResources + publish provider + mac arch | C3 |

依赖方向：C1（workflow 骨架）→ C2（bump 脚本）→ C3（CI 生成 node + 发布）→ C4（实测验证）。

## 4. 关键机制实现形态

### 4.1 workflow 骨架（C1，三阶段方案 A）

```yaml
name: Release
on:
  workflow_dispatch:
    inputs:
      branch:        { description: '发布源分支', default: main, required: true }
      version:       { description: '版本档位', type: choice, options: [patch, minor, major], required: true }
      release_notes: { description: '发布说明', default: '' }
concurrency:
  group: release-${{ inputs.branch }}     # 按版本线分组（Q-058）
  cancel-in-progress: false
jobs:
  # 阶段 1：读分支当前 version，三端 matrix 打包验证（--publish never，失败零污染）
  build:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false                     # 单平台失败不阻塞（CON-R-cicd-008）
      matrix:
        include:
          - { os: macos-latest,  platform: darwin-arm64, arch: arm64 }
          - { os: macos-13,      platform: darwin-x64,   arch: x64 }   # Intel Mac
          - { os: windows-latest, platform: win32-x64,   arch: x64 }
          - { os: ubuntu-latest, platform: linux-x64,    arch: x64 }
    steps:
      - checkout ${{ inputs.branch }}      # 各端同 branch（Q-058）
      - fetch-node --platform ${{ matrix.platform }}   # C3：按平台生成 node
      - typecheck + build                  # C7：前置门禁
      - electron-builder --publish never   # 只打包验证，零污染
      - upload-artifact                    # 各平台产物跨 job 传递
  # 阶段 2：build 全成功后打 tag + 建 Release + 上传各平台产物
  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - checkout + 读当前 version（不 bump）
      - download-artifact（merge 各平台产物）
      - git tag v<当前version> + push
      - gh release create + upload dist-artifacts/*
      - release body 资产驱动标注各平台（Q-060）
  # 阶段 3：发布成功后 version +1（bump 是事后动作，失败不执行 → 版本线零污染）
  bump:
    needs: release
    runs-on: ubuntu-latest
    steps:
      - checkout branch
      - bump-version.mjs --bump <version>  # 读当前 version +1
      - git commit + push（package.json 新版本回分支）
```

- 步骤顺序：**build → release → bump**（发布当前分支 version，成功后 bump；失败不 bump，main 版本线零污染可无限重试）
- **发布 = 当前分支 version**（读 package.json，不先 +1）；bump = 发布成功的事后动作（"下个迭代基线"）
- **失败语义**：build/release 任一失败 → bump 不执行 → 无 tag 无 release 残留，main 零污染
- 各端 matrix 各 job 独立 checkout 同一 branch
- **permissions**：build=contents: read（仅打包验证）；release/bump=contents: write（打 tag + 建 Release + 推版本）——最小化

### 4.2 bump-version.mjs（C2）

- 读 `package.json` version → 按 `--bump patch|minor|major` 递增 → 写回 → 输出新版本
- semver 递增：patch 末位+1 / minor 中位+1 末位归零 / major 首位+1 后位归零
- 纯函数 + 可单测（node --test）
- 由 workflow bump job 调用，git commit + tag 在 workflow 步骤（不用 npm version 隐式行为）

### 4.3 CI 生成 node（C3）

- 每 runner 跑 `node scripts/fetch-node.mjs --platform <平台>`：
  - macos-latest → `--platform darwin-arm64`
  - macos-13 → `--platform darwin-x64`（Intel Mac，新增）
  - windows-latest → `--platform win32-x64`（Q-059 实测：node.exe 布局根目录无 bin/）
  - ubuntu-latest → `--platform linux-x64`
- 产物落 vendor/（gitignore 已含），electron-builder extraResources 自动内嵌
- SHA256 校验 + 幂等复用（现有脚本）
- **mac 双包各捆绑对应架构 node**（darwin-arm64 / darwin-x64），electron-updater 按用户芯片选对应包

### 4.4 发布 + 失败隔离（C3/C4）

- 各 runner `npx electron-builder --publish always`（GH_TOKEN env）
- 三端产物 → 同一 GitHub Release（不同平台资产不冲突）
- latest-mac.yml / latest.yml / latest-linux.yml 由 electron-builder 自动生成
- 失败隔离：`fail-fast: false` + matrix 天然隔离；部分平台成功后 release 含部分产物
- release-body job 标注各平台成功/失败（Q-060 双通道可观察）

## 5. 工程基线

- git ✅ / 脚手架 ✅（package.json）/ 测试框架 ✅（node --test + Playwright）
- 技术栈：纯 GitHub Actions YAML + Node 脚本（bump-version.mjs），无新增依赖
- bump-version.mjs 单测：node --test 覆盖三档递增边界

## 6. 目录/工程结构

```
.github/workflows/
  release.yml               ← 演进（mac-only → 三端 matrix + workflow_dispatch）
scripts/
  bump-version.mjs          ← 新增（C2 三档 bump）
  fetch-node.mjs            ← 复用（C3 按平台生成 node）
```

## 7. 风险与对策

| 风险 | 缓解 |
|:-----|:-----|
| Win/Linux 首次 CI 实测踩坑（nsis/AppImage/deb） | CI 真实构建暴露（Q-059）；失败隔离 fail-fast:false |
| win32-x64 node 生成布局差异 | fetch-node --platform win32-x64 实测（Q-059） |
| mac Intel（darwin-x64）runner 可用性/配额 | macos-13 为 Intel runner；失败隔离 + 手动触发缓解 |
| mac x64 node 下载/布局 | fetch-node --platform darwin-x64 实测 |
| bump 后 tag 冲突（并发 dispatch） | concurrency 按分支分组（Q-058） |
| 各端 checkout 分支漂移 | matrix 各 job 显式 checkout inputs.branch |
| GH_TOKEN 权限不足 | 复用现有 secret（S5 已配 Contents+Actions 写权限） |
| mac runner 额度 | 手动触发缓解（用户拍板） |

## 8. 核验记录

> 交付核验时填写。

## 评审记录

> 评审通过（2026-08-25，用户确认整体方案 + mac 双架构决策 6 拍板）。方案冻结，可进实现。
