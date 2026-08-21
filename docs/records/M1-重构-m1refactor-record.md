# M1-重构 实现记录与核验记录（m1refactor）

> 判级：复杂 + 安全敏感（三已发布子需求 UI 载体统一重构，跨 WindowManager/preload/shell.html/main 多文件联动 + view 状态机 2→4 态扩展；涉 CON-R001/R002/R005 安全边界）
> 事实源：设计 `docs/design/M1-重构-壳内视图-m1refactor-design.md`（frozen，评审通过）；契约 `docs/api/feishu-s6-m1-api-contract.md` v0.4 / `docs/api/feishu-s3-m1-api-contract.md` v0.3 / `docs/api/feishu-s5-m1-api-contract.md` v0.3（本波变更传播）；共识 v1.6 §14.1-R
> 分支：feature/m1refactor（代码 + 契约/设计/记录归本分支）

## 实现记录

### 文件清单（S8' → S6' → S3' 依赖序）

**S8' view 机制扩展（2→4 态）**
- `src/window/WindowManager.ts` — PlaceholderView 并集 +settings/+upgrade（5→7）；PlaceholderMode 同步扩展；新增 `showSettings()` / `showUpgrade()`（封装 showPlaceholder + 推送，§4.1 迁移矩阵）；hull:status payload 零改动（view 字段新取值自动透传）
- `src/preload/index.ts` — hull 桥并入 settings.ts 15 方法（D2 单一桥，白名单 12→27，全在 partition 'shell' 壳页，官方 view 无 preload CON-R001 不破）；`showSettings`/`showUpgrade` 新方法；**checkDshUpdate 收敛**（§4.3 H1：统一映射 `hull:checkDshUpdate` 无 dialog 返回结果；原 `hull:promptDshUpdate` 孤儿通道删除）
- `src/renderer/shell.html` — nav 高亮回写（§4.4：view 字段驱动 + M3 升级进行中 nav-upgrade 保持、空闲回落 nav-web）；sections 数组 +2（settings/upgrade）

**S6' 设置页迁移（独立窗口 → 壳内 section）**
- `src/renderer/shell.html` — 新增 `section#settings`（重渲染自 settings.html：通用设置 + dsh 运行时 + Hull 应用 + 诊断四卡；持久化走 `hull:setSettings` CON-R002 不破；DOM modal 确认流迁 upgrade 视图）
- `src/preload/settings.ts` — **删除**（15 方法并入 index.ts）
- `src/window/SettingsWindow.ts` — **删除**（D1 独立设置窗口移除；原 partition 'settings' session 不再创建）
- `src/renderer/settings.html` — **删除**（内容迁 shell.html section#settings）
- `src/main/index.ts` — `hull:openSettings` handler → `hull:showSettings`（切视图）；托盘「Hull 设置」→ 聚焦主窗口 + showSettings（§4.7 D5）
- `src/tray/TrayController.ts` — onOpenSettings 语义改（聚焦 + 切视图；main 装配处实现）

**S3' 升级面板（原生 dialog → 壳内 upgrade 视图）**
- `src/renderer/shell.html` — 新增 `section#upgrade`（dsh/Hull 双通道确认/进度/失败/回滚/重启安装提示统一卡片；250ms 轮询 hull:status + 双通道快照三查一循环）；`renderRestartPrompt`（H2 裁决 2：preventive-prompt 迁 upgrade 视图重启安装提示区）
- `src/main/index.ts` — 升级/设置域 `showMessageBox` **归零（8 处壳内化：runCheck×2/runUpgrade×2/runHullCheck×2/runHullDownload×2 → 切视图 + hull:status 推送）**；**crash dialog 1 处保留原生**（H2 裁决 1：紧急系统级）；runCheck 确认流（§4.5 M1：phase=confirm → hull:status → 确认卡片 → 渲染侧 hull:upgradeDsh）；自动检查 M2 不强制切 view（runCheck(true)/runHullCheck(true)）；`hull:promptDshUpdate` handler 删除；死代码 runUpgrade/runHullDownload 删除；`UPGRADE_ERRORS`/`HULL_UPDATE_ERRORS` 无用 import 清理
- **升级原子性编排逻辑（UpgradeQueue/SwapManager/Updater/HullUpdater）零改动**（CON-R005）

**测试重构**
- `tests/e2e/helpers.ts` — openSettings 改切视图定位 shell 页 + `#settings:not(.hidden)`；openUpgrade 新增；closeMainWindow/mainWindowVisible 去掉 settings.html URL 排除（无独立窗口）
- `tests/e2e/settings.spec.ts` — 独立窗口定位 → 壳内 section#settings 断言（T6-01/03/05）
- `tests/e2e/upgrade.spec.ts` — 原生 dialog 断言 → section#upgrade 确认卡片断言（E2E-03/04；`#nav-upgrade` → showUpgrade + checkDshUpdate → `#up-dsh-yes`）
- `tests/e2e/cold-start.spec.ts` — 设置开窗断言 → 壳内 section#settings；升级中禁用触发改 upgrade 视图确认

**契约变更传播**
- `docs/api/feishu-s5-m1-api-contract.md` — 升 v0.3（Hull 通道 UI 载体收进 upgrade 视图注记，§8 归实现波）

### TDD 说明

设计 §5 明示：view 状态机迁移矩阵单测 YAGNI（WindowManager 现无单测，靠集成 + e2e，S8 §4 同策略）；preload/checkDshUpdate 收敛 / 升级确认流均为主进程 IPC 桥接（无独立纯逻辑可单测，项目既有模式 = e2e 断言验证）。本次 TDD 载体为 e2e 断言重构：
- `upgrade.spec.ts` confirmUpgrade（showUpgrade + checkDshUpdate → 确认卡片 → 立即升级）先行改 → 实现回归
- `cold-start.spec.ts` nav 入口（settings section / upgrade 检查 registry hit）先行改 → 实现回归
- `settings.spec.ts` section#settings 断言先行改 → 实现回归

### 质量
- `npm run typecheck`（tsc --noEmit）：干净
- `npm test`：467 unit + 8 integration pass / 0 fail
- `npm run build`：干净
- `npm run test:e2e`（HULL_E2E=1）：12 pass / 0 fail

## 核验记录

### Code Review
- 由 orchestrator 指定评审机制（待跑 ocr review / 团队既有机制；本次交付后执行）

### Semgrep
- 未配置（项目现有 Semgrep 扫描流程外，记录风险项：新增代码为 renderer 内联 script + preload 桥，白名单固定无透传）

### 契约符合性

| 验收项（共识 §14.1-R） | 结果 |
|:---|:---|
| S6' 设置页收进 shell.html 右侧整页 section，独立 SettingsWindow 删除 | ✅ section#settings 显示；SettingsWindow.ts/settings.html/preload settings.ts 删除 |
| S6' 壳导航「设置」切换；持久化仍走 hull:setSettings | ✅ hull:showSettings → showPlaceholder('settings')；hull:setSettings 门面零改动（CON-R002） |
| S3' 升级面板独立右侧视图，壳导航「升级」切换 | ✅ section#upgrade + nav-upgrade → showUpgrade + checkDshUpdate |
| S3' dsh/Hull 双通道确认/进度/失败/回滚/重启安装提示收进壳内统一模式 | ✅ upgrade 视图双卡片 + 重启安装提示区 |
| S3' 升级原子性逻辑零改动 | ✅ UpgradeQueue/SwapManager/Updater/HullUpdater 零改动（CON-R005） |
| S8' view 状态机 4 态 + hull:status payload + nav 高亮回写 | ✅ PlaceholderView +settings/+upgrade；view 字段驱动 nav 高亮（§4.4 + M3） |
| S8' 托盘入口聚焦主窗口 + 切视图 | ✅ 托盘「Hull 设置」/「检查 dsh 更新」→ show/focus/restore + showSettings/showUpgrade（D5） |
| S8' 官方 WebContentsView 零注入结构不变 | ✅ 官方 view 默认 session + 无 preload 结构零改动（CON-R001） |
| 升级/设置域 showMessageBox 归零，崩溃域 1 处保留 | ✅ main/index.ts showMessageBox 仅 crash 1 处（H2 裁决） |

### 偏离方案点

| # | 偏离 | 原因 | 处理 |
|:--|:-----|:-----|:-----|
| 1 | runCheck/runHullCheck 增加 `auto` 参数区分自动/手动检查 | 设计 §4.5 M2 只写明 dsh 自动检查不强制切 view；Hull 自动检查（maybeAutoCheckHull）同理，为语义一致补参数 | 与方案原则一致，扩展实现 |
| 2 | 删除死代码 runUpgrade/runHullDownload | 确认流壳内化后渲染侧直调 hull:upgradeDsh / hull:downloadHullUpdate（main handler 内已含 installAndRestart），两包装函数无调用方 | 清理死代码，编排逻辑零改动 |
| 3 | 单测保持 467（未达「约 471」） | 方案 §5 明确 view 状态机单测 YAGNI；467 为实际基线显式用例数，「471」为估算含复合 | 不新增单测，符合方案 |
| 4 | e2e openSettings helper 改切视图定位（返回 shell 页） | 独立设置窗口移除，section 无独立 page | 既有 openSettings 语义保留（切 settings 视图），返回壳页 |

### 红线核对

- **CON-R001**：官方 view 零注入结构不变（默认 session + 无 preload）；preload 桥合并只在壳页（partition 'shell' 非持久 + 静态挂载）
- **CON-R002**：settings 持久化仍走 `hull:setSettings` → SettingsProvider（userData/settings.json，非 DSH_HOME）；设置 section 仅消费既有 IPC
- **CON-R003**：dsh/Hull 双通道入口统一 upgrade 视图 UI，编排层仍走既有互斥队列（UpgradeQueue 单槽）零改动
- **CON-R004**：壳功能（设置/升级）本为主进程壳层能力，不注入官方 UI
- **CON-R005**：UpgradeQueue/SwapManager/Updater/HullUpdater 零改动；dialog 移除只改 UI 载体，状态机/原子替换/验证/回滚全在主进程编排层不动
