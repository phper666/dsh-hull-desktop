# Hull 桌面壳（CI/CD 发布流程）共识文档

> 版本：v1.1 · 更新：2026-08-25 · 维护者：phper666（PM） · 状态：已发布
> 数据来源：Hull CI/CD PRD v0.1（docs/prd/2026-08-25-hull-cicd-prd.md）
> 关联：packaging 需求（docs/prd/2026-08-25-hull-packaging-prd.md）U-2 CI 自动化落地；需求标识 `cicd`；B1 范围

## 1. 文档元信息

- **本版本变更**：v1.1 已发布——版本策略细化（Q-057/Q-058 结论回写）：FR-2 从「version 输入」升级为「branch 输入 + patch/minor/major 三档 bump + 版本线维护 + 并发锁按分支分组」；CON-R-cicd-003 语义扩展。
- **历史变更摘要**：v1.0 首次建立——从 Hull CI/CD PRD v0.1 提取整理为业务事实源；登记 CON-R-cicd-001~008。
- **状态说明**：v1.1 已发布（基线）；扫描完成（BE/QA，Q-057~060 已落载体）；待拆解。

## 2. 文档结构总览

- **覆盖**：Hull 三端 CI/CD 发布链全部业务面——GitHub Actions 三端构建矩阵、workflow_dispatch 手动触发、CI 生成捆绑 node、electron-builder 发布 GitHub Releases、latest 更新元数据、失败隔离。
- **适用范围**：仅 Hull 壳的构建/分发 CI 链；**不覆盖** 代码签名/公证（沿用暂不签名）、tag push 自动触发（排后）、跨平台交叉编译、商店分发、测试门禁。

## 3. 领域术语表

| 术语 | 定义 | 出处 |
|:-----|:-----|:-----|
| GitHub Actions | GitHub 提供的 CI/CD 服务，workflow 用 YAML 定义（本需求载体） | PRD FR-1 |
| workflow_dispatch | GitHub Actions 手动触发事件（页面点按钮 + 输入参数） | PRD FR-2 |
| matrix | GitHub Actions 并行构建策略（同一 job 多平台并行） | PRD FR-1 |
| runner | GitHub Actions 的构建执行机（macos-latest/windows-latest/ubuntu-latest） | PRD FR-1 |
| GitHub Releases | GitHub 版本发布页（electron-updater 三端更新源，latest 元数据） | PRD FR-4 |
| latest-mac.yml / latest.yml / latest-linux.yml | electron-builder 生成的各平台更新元数据文件（electron-updater 读取） | PRD FR-5 |
| 捆绑 node | 三端包内随壳捆绑 node（fetch-node 机制），dsh 不依赖用户 node | packaging 共识 §3 |
| GH_TOKEN | 仓库 Secrets 里的 fine-grained PAT（Contents+Actions 写权限） | PRD FR-4 |

## 4. 功能需求（PRD 提取）

### 4.1 三端构建矩阵（FR-1）

- GitHub Actions matrix：`macos-latest`（dmg+zip）/ `windows-latest`（nsis+portable）/ `ubuntu-latest`（AppImage+deb）；
- 各 runner 原生构建，不做交叉编译；
- 单平台失败不阻塞其他平台（matrix 并行天然隔离，CON-R-packaging-007）。

### 4.2 workflow_dispatch 手动触发 + 版本策略（FR-2，v1.1 细化）

- `on: workflow_dispatch`，带输入：`branch`（默认 main）+ `version`（patch/minor/major 三档）+ `release_notes`（可选）；
- 发布源 = 所选 branch，bump 读**所选分支**的 package.json 当前 version，走一步递增；
- 版本一致性：发布版本永远 = bump 后 tag（打所选分支 HEAD），产物与 tag 同步，不手动输 version；
- 三档语义（自定义，贴合无外部 API 消费者）：patch=小改（bug+小功能随时发）/ minor=攒批发布（累计多版本功能发一次）/ major=破坏性重构（页面/架构重构，低频）；
- **版本线维护（backport）独立于档位**：main 走远 + 用户锁旧版 → 从旧 tag 拉 `release/x.y`，只发 patch，修复 cherry-pick 回 main；其他分支只做 bug 修复，永不发 minor/major；
- **并发锁按版本线分组**：`concurrency.group: release-${{ inputs.branch }}`——同线串行、异线并行（main 发 minor 与 release/0.1.x 发 patch 可同时跑）；
- **matrix 三端必须同 branch**：三端并行各 runner checkout 同一所选 branch，防版本漂移；
- **自动更新项目旧线 patch 只服务锁版用户**：electron-updater 永远跳最新，main 已发高版本时旧线 patch 不推给自动更新用户。

### 4.3 CI 生成捆绑 node（FR-3）

- CI 各 runner 跑 `node scripts/fetch-node.mjs` 按平台生成 node 产物（win32-x64 当前缺失，CI 补齐）；
- 三端 node 版本锁定一致（现 24.10.0），SHA256 校验 + 幂等复用。

### 4.4 electron-builder 发布 GitHub Releases（FR-4）

- `npx electron-builder --publish always`（各 runner 对各自平台产物发布）；
- GH_TOKEN 复用仓库现有 secret（Contents+Actions 写权限，S5 契约已配）；
- 产物：mac dmg+zip / win nsis+portable / linux AppImage+deb → 同一 GitHub Release。

### 4.5 latest 元数据自动生成（FR-5）

- electron-builder 自动生成 `latest-mac.yml` / `latest.yml` / `latest-linux.yml`（各平台对应）；
- electron-updater 三端读取同源，自动更新链延续（PK3 已铺）。

### 4.6 前置门禁（FR-6）

- 打包前跑 `npm run typecheck` + `npm run build`（编译失败提前止损，不进入打包）；
- （可选，本轮不强制）unit test 门禁——测试仍本地跑，CI 仅 typecheck+build。

### 4.7 失败隔离（FR-7）

- 单平台打包失败不阻塞其他平台（matrix 并行天然隔离）；
- 部分平台成功后 release 部分产物 + 失败平台在 job 输出标注，人工补打。

## 5. 状态

- **构建状态**：mac（现有 S5 单端链）→ 三端 matrix 并行（win/linux 首次实测）；
- **发布状态**：手动触发 → GitHub Releases 三端产物 + latest 元数据。

## 6. 异常分支

- 某平台打包失败（原生依赖/路径差异）→ 其余平台仍出包，release 含部分产物，失败平台标注人工补打；
- 捆绑 node 下载失败（平台无对应 node / 网络）→ 该平台构建失败，不阻塞其他平台；
- GH_TOKEN 权限不足 → 发布步骤失败，构建产物仍在（可人工上传）；
- version 输入非法（非 semver）→ 构建失败提前止损，不进入打包；
- win runner 首次构建 nsis 工具链下载慢/失败 → 重试或换 runner 镜像。

## 7. 安全与红线

- **CON-R001 不破**：官方 dsh Web UI 零注入（CI 不改官方 UI）；
- **CON-R003 不破**：dsh 升级独立通道（CI 不预置 dsh node_modules）；
- **CON-R005 不破**：升级原子性（发布链不触碰 dsh 升级逻辑）；
- **CON-R-packaging-005 沿用**：暂不签名/公证（CI 不引入签名步骤）；
- **secrets 最小化**：仅 GH_TOKEN（Contents+Actions 写权限），不落其他 secret。

## 8. 未决项登记

> 本需求无未决项（PRD 边界已定：手动触发 + 三端 matrix + 演进现有 workflow，用户已拍板）。

## 9. 扫描待确认项

> 待三角色扫描（基线发布后）。

## 10. 规则编号（CON-R-cicd-001~008）

| 编号 | 规则 | 来源 | 当前结论 | 变更状态 |
|:-----|:-----|:-----|:---------|:---------|
| CON-R-cicd-001 | 发布链载体 = GitHub Actions workflow（演进现有 release.yml 为三端 matrix） | PRD FR-1/FR-2 | 生效 | 稳定 |
| CON-R-cicd-002 | 构建矩阵 = macos-latest（dmg+zip）/ windows-latest（nsis+portable）/ ubuntu-latest（AppImage+deb） | PRD FR-1 | 生效 | 稳定 |
| CON-R-cicd-003 | 触发 = workflow_dispatch 手动，带 branch（默认 main）+ version（patch/minor/major 三档）+ release_notes 输入；bump 读所选分支 version，tag 打所选分支 HEAD | PRD FR-2 | 生效 | v1.1 扩展 |
| CON-R-cicd-004 | CI 各 runner 跑 fetch-node 按平台生成捆绑 node（win32-x64 CI 补齐） | PRD FR-3 | 生效 | 稳定 |
| CON-R-cicd-005 | 发布 = electron-builder --publish always，GH_TOKEN 复用现有 secret | PRD FR-4 | 生效 | 稳定 |
| CON-R-cicd-006 | 更新元数据 = electron-builder 自动生成 latest-mac.yml/latest.yml/latest-linux.yml | PRD FR-5 | 生效 | 稳定 |
| CON-R-cicd-007 | 前置门禁 = typecheck + build，失败提前止损不进入打包 | PRD FR-6 | 生效 | 稳定 |
| CON-R-cicd-008 | 失败隔离 = 单平台失败不阻塞其他平台（matrix 天然隔离） | PRD FR-7 | 生效 | 稳定 |

## 11. 页面交互规范

> 本需求为 CI/构建层，无新增用户可见 UI（workflow_dispatch 在 GitHub 页面触发，安装包交互沿用现有壳）。

## 12. 不做事项

- 代码签名/公证（沿用 CON-R-packaging-005 暂不签名）；
- tag push 自动触发（手动触发先行，可后续加）；
- 跨平台交叉编译（各平台原生 runner 打包）；
- 商店分发（App Store / MS Store / Snap）；
- 测试门禁（unit test 仍本地跑，CI 仅 typecheck+build）；
- dsh 依赖预置（node_modules 打包）——违反 CON-R003。

## 13. 依赖

- **packaging 铺垫**：electron-builder.yml 三平台 target + publish github provider + GH_TOKEN secret 已就绪；
- **fetch-node.mjs**：三平台参数支持（darwin-arm64 默认/win32-x64/linux-x64）已就绪；
- **electron-builder / electron-updater**：已依赖（PK1/PK3 引入）；
- **现有 release.yml**：演进基底（mac-only → 三端 matrix）。

## 14. 子需求清单

> 已拆解（Gate B 通过 2026-08-25）：ticket 已落 dsh-hull-desktop 清单（编号/验收标准/规则绑定/依赖/来源 PRD）。

| # | 子需求 | 验收标准（可测试） | 规则绑定 | 依赖 | 来源 PRD | ticket |
|:--|:-------|:-------------------|:---------|:-----|:---------|:-------|
| C1 | 三端构建矩阵 workflow（演进 release.yml 为 matrix + workflow_dispatch） | 手动触发三端 matrix 并行构建（macos/windows/ubuntu）；typecheck+build 前置门禁失败提前止损；单平台失败不阻塞其他平台；三端 checkout 同一所选 branch | CON-R-cicd-001/002/007/008 | 无 | PRD FR-1/FR-6/FR-7 | t100096 |
| C2 | 版本 bump 策略（三档 + 并发锁 + 版本线维护） | workflow_dispatch 带 branch+version（patch/minor/major）输入；bump 读所选分支 version 走一步；tag 打所选分支 HEAD；并发锁按版本线分组；发布版本=tag 同步 | CON-R-cicd-003 | C1 | PRD FR-2 | t100097 |
| C3 | CI 生成捆绑 node（win32 补齐）+ 发布 GitHub Releases | CI 各 runner 跑 fetch-node --platform 生成 node（win32-x64 CI 补齐）；electron-builder --publish always 发布三端产物到同一 GitHub Release；latest-*.yml 元数据自动生成 | CON-R-cicd-004/005/006 | C1/C2 | PRD FR-3/FR-4/FR-5 | t100098 |
| C4 | 平台适配验证 + 失败隔离可观察性 | win/linux 首次 CI 实测打包通过；单平台失败时 release 含部分产物 + job 红绿标注；release 描述标注各平台成功/失败 | CON-R-cicd-002/008 | C1/C2/C3 | PRD FR-5/FR-7 | t100099 |

## 15. 附录

### 15.1 关联

- PRD（docs/prd/2026-08-25-hull-cicd-prd.md）、packaging 共识（docs/spec/共识-Hull桌面壳-三端打包.md，U-2 落地）、规则索引（docs/spec/规则索引.md）、packaging PRD（docs/prd/2026-08-25-hull-packaging-prd.md）。

### 15.2 版本记录

| 版本 | 日期 | 变更摘要条目 | 说明 |
|:-----|:-----|:-------------|:-----|
| v1.1 | 2026-08-25 | 已登记（已发布） | 版本策略细化（Q-057/058 回写）：FR-2 升级 branch+三档 bump+版本线维护+并发锁；CON-R-cicd-003 扩展 |
| v1.0 | 2026-08-25 | 已登记（已发布） | 首次建立：从 Hull CI/CD PRD v0.1 提取；登记 CON-R-cicd-001~008 |

### 15.3 后续规划

> 记录本轮明确排除/未决项，供后续承接。

| 项 | 状态 | 说明 |
|:---|:-----|:-----|
| tag push 自动触发 | 排后 | 手动触发先行，发布频率再提升时加 |
| 测试门禁 | 排后 | 测试仍本地跑，CI 稳定后加 unit/e2e 门禁 |
| 代码签名/公证 | 排后（U-1 沿用） | 需证书 + 正式分发需求 |
