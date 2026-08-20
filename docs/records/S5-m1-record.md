# S5 实现记录与核验记录

> 判级：复杂+安全敏感（自更新=安装软件安全面 + 双通道互斥 + 退出编排交互 + GitHub Releases 外部集成 + CI 发布链）
> 事实源：契约 `docs/api/feishu-s5-m1-api-contract.md` v0.2（冻结 2026-08-17）、设计 `docs/design/S5-Hull自更新-m1-design.md` 0.2（冻结 2026-08-17）

## 实现记录

### 文件清单
- `src/updater/HullUpdater.ts` + 测试 — 6 态状态机（idle/checking/confirm/downloading/restarting/done + restart-prompt 枚举保留）+ check（全占槽 B2）/download（CancellationToken 可取消）/cancel（仅 downloading）/installAndRestart（B3 stop 失败中止 + quitAndInstallMode 衔接 + 🟡-3 复位）/dismiss（🔴-1 稍后再说释放槽）/adapter error 订阅（🟡-2）/预防性提示事件（仅 download-complete，🟡-1）/下载进度 pct 透传
- `src/updater/electronUpdaterAdapter.ts` + 测试（经 HullUpdater.test）— ElectronUpdaterAdapter 接口 + createElectronUpdaterAdapter 默认实现（electron-updater autoUpdater，GitHub provider）
- `src/updater/DismissStore.ts` + 测试 — 双键改造（S3 变更传播）：{ dsh?, hull? } + dismissToday(channel)/isDismissedToday(channel) + 旧单键 { date } 兼容视作 dsh
- `src/settings/SettingsProvider.ts` + 测试 — autoCheckDsh/autoCheckHull（默认 true）+ schemaVersion 3（S4 协同）
- `src/main/index.ts` — S5 集成：HullUpdater 装配 + 启动自动检查（autoCheckHull + DismissStore('hull') 门控）+ 预防性提示 dialog + quitAndInstallMode before-quit 放行分支 + runHullCheck/runHullDownload + IPC 预留（hull:checkHullUpdate/hullUpdateStatus）
- `src/tray/TrayController.ts` — 菜单五项（+「检查 Hull 更新…」）+ busy 禁用（queue.inFlight() 数据源）+ tooltip 三级合并（Hull 自更新 → dsh 升级 → runtime）
- `electron-builder.yml` — mac zip+dmg + GitHub provider + extraResources vendor/node-*（S2 extractNode 定案 a）+ mac.identity: null
- `.github/workflows/release.yml` — tag push → npm ci → fetch-node → build → electron-builder --publish always；actions pin 完整 SHA（Semgrep 修复）

### TDD：22 新用例（HullUpdater 17〔14 + 3 修复〕/ DismissStore 7 重写〔净 +1〕/ SettingsProvider 4），S1-S4 179 回归 → 201 全绿

> 注：骨架预估 17 新用例 + 184 回归，实测 22 新（HullUpdater 17 = 14 + 评审修复 3；DismissStore 重写 7 净 +1；SettingsProvider 4）+ S1-S4 回归 179，总数 201 一致。

核心路径全测：6 态迁移/非法迁移 dev throw/check 占槽与终态释放/dismiss 释放槽（dsh 升级可恢复）/download 完成与失败/cancel（token.cancel）/installAndRestart 全链路（stop 前置 + quitAndInstallMode）/stop 失败中止/quitAndInstall 抛错复位/adapter error 事件映射/预防性提示单次/queue-busy/currentVersion 注入/DismissStore 分通道隔离与旧单键兼容/写失败降级/SettingsProvider autoCheck 读写与 schemaVersion 3

### 质量
- `npm run typecheck`（tsc --noEmit）：干净
- `npm test`：201 pass / 0 fail，~0.8s
- `npm run build`：dist/ 全量产出

## 核验记录

### Code Review
- 双席 AI review（oracle 有条件通过 🔴 稍后再说锁死互斥槽 / gamma 通过）→ 修复 4 项（🔴-1 dismiss() 释放槽 / 🟡-1 preventive 分流仅 download-complete / 🟡-2 adapter error 订阅 / 🟡-3 quitAndInstallMode 复位）→ ora-1 复评「通过」
- 修复全程 TDD：先补/改测试（🔴-1/🟡-2/🟡-3 新增 + ⑬ 改）再修实现

### Semgrep
- 1.172.0 自动配置 261 规则、46 文件扫描：**2 findings 已修复**——release.yml mutable action tag（actions/checkout@v4 等）→ pin 完整 40 字符 commit SHA（CWE-1357 供应链防护；SHA 经 api.github.com 实取）→ 复扫 0 findings

### 契约符合性（T5 场景对照）

| 场景 | 契约要求 | 单元级证据 | 状态 |
|---|---|---|---|
| T5-01 发现新版本 | Releases 发新版 → 检查提示含变更说明 | HullUpdater ③（confirm + targetVersion/changeNotes） | 单元级 ✓，集成待打包环境 |
| T5-02 完整更新 | 版本变化 + dsh 数据无损 | HullUpdater ⑩（installAndRestart 全链路）+ 壳升级不触碰 userData/dsh | 单元级 ✓，集成待 electron + 打包环境 |
| T5-03 互斥 | dsh 升级中触发 Hull 入口禁用 | HullUpdater ⑫（queue-busy）+ 🔴-1（dismiss 后 dsh 可恢复）+ TrayController busy 禁用 | 单元级 ✓，集成待 electron |
| T5-04 下载失败 | 断网下载 → 提示 + 重试 | HullUpdater ⑧（download-failed）+ 🟡-2（error 事件映射） | 单元级 ✓，集成待打包环境 |
| T5-05 无公证拦截 | Gatekeeper 引导 | 预防性提示（⑬ download-complete 事件 → main dialog）+ README 章节注记 | 单元级 ✓（事件），dialog 集成待 electron |
| T5-06 自动检查开关 | 关闭后无网络请求 | SettingsProvider autoCheckHull 读（S5-②）+ main maybeAutoCheckHull 门控 | 单元级 ✓，集成待 electron |

### 变更传播闭环
- S3 DismissStore 双键（旧单键 { date } 兼容视作 dsh 侧，hull 不受污染）+ S3 契约 #5 调用方注记
- S4 schema 协同（autoCheckDsh/autoCheckHull 同批 + schemaVersion 3 单次迁移）
- S1 设计 §5.1 dismiss.json 双键勘误
- S2-m1-record C3 关闭（打包专项取消并入 S5：extractNode 接线 + electron-builder.yml 定案 a）
- 代码零改动声明：S1~S4 代码未触碰（DismissStore/SettingsProvider 扩展为 S5 实现波内变更传播落地）

### 环境阻塞
- electron 二进制未下载（github.com 主站不可达，api.github.com 可达——SHA 拉取成功）；恢复命令：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`
- 真实 electron-updater 检查/下载/重启安装端到端待打包环境 + 网络恢复（T5-01/02/04/05 集成段）
- release.yml 语法验证：CI 生效后由 workflow 运行验证（actionlint 未装）

### 风险登记
- **🟢-A**：error 事件与 promise reject 双路径——error 事件先处理（transition idle）后 promise reject 走 catch 的 phase 守卫（`!isDownloading()` 返回）避免 Idle→Idle 非法迁移 dev throw；注记随 S6 补强（双路径统一为单一失败源）
- **gatekeeper-blocked 码保留不发射**：预防性提示替代（B1 删 flag 机制后该码无触发路径，保留枚举供 S6 渲染）
- **S6 承载点**：hull:checkHullUpdate / hull:hullUpdateStatus IPC + autoCheckHull 开关 UI + 失败提示按钮下方 + 下载进度条 + README 引导章节 + owner/repo 发布链核对
