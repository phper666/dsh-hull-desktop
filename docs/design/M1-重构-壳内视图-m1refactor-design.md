# M1-重构 壳内视图 技术方案（m1refactor）

> 工作项：M1 增补段「M1-重构」（m1refactor，产品重构，挂原 M1 PRD）
> 状态：frozen（评审通过）+ v1.7 迭代调整（D4 修订：升级并入设置页升级区块，见 §8）
> 版本：0.2 · 2026-08-22（v1.7 迭代调整修订）
> 事实源：共识 `docs/spec/共识-Hull桌面壳-M1.md` v1.7 §14.1-R；契约 `docs/api/feishu-s6-m1-api-contract.md` v0.5 / `docs/api/feishu-s3-m1-api-contract.md` v0.4 / S8（无独立契约文件，以 S8 设计 `docs/design/S8-主窗口形态-m1-design.md` + 共识 §14.1-R 为准）；PRD `docs/prd/2026-08-14-m1-prd.md`
> 判级：复杂 + 安全敏感（共识 v1.7 已定）。理由：三个已发布子需求的 UI 载体统一重构（S6'/S3'/S8'），跨 WindowManager/preload/shell.html/main 多文件联动 + view 状态机 2→3 态扩展；涉 CON-R001（preload 桥合并白名单面扩大）、CON-R002（settings 持久化路径）、CON-R005（升级编排零改动）安全边界，必须方案评审冻结后进实现。
> 红线：CON-R001~R005 全部不破（UI 载体迁移不触碰主进程编排层；官方 view 零注入结构不变）。

---

## 1. 背景与范围

**定位**：统一壳内交互模型——把已发布的 M1 壳功能（设置页独立窗口、升级原生 dialog）收进主窗口右侧内容区，壳框架 view 状态机从 2 态扩为 3 态（official/board/settings）。对已发布期的重构，归 M1 增补段 `m1refactor`，不占新期编号（期编号决策模型：对已发布期的重构归该期增补段，需求 slug `m1refactor`）。

**范围**（共识 v1.7 §14.1-R + 契约冻结）：

- **S6' 设置页迁移**：独立 SettingsWindow → 壳内右侧整页 section（重渲染，删除独立窗口）；壳导航「设置」切换（恒最后）；settings 持久化仍走主进程 `hull:setSettings` 门面（CON-R002 不破）；双升级区块/通用设置/诊断全部可见可操作（D1 已定）
- **S3' 升级面板**：升级 UI **并入设置页升级区块**（v1.7 修订：原 D4 独立 upgrade 视图推翻）；dsh/Hull 双通道确认/进度/失败/回滚/重启安装提示收进壳内统一模式；升级原子性编排逻辑（UpgradeQueue/SwapManager/Updater）零改动（CON-R005 不破）
- **S8' view 机制扩展**：壳框架 view 状态机扩为 official/board/settings 3 态（v1.7 修订：去 placeholder:upgrade）；hull:status payload（含 hullVersion）+ nav 高亮回写；导航菜单 = dsh web / 任务看板 / 设置（去「升级」项，设置恒最后）；托盘入口聚焦主窗口 + 切对应视图（D5 已定）；官方 WebContentsView 零注入结构不变（CON-R001）

**已拍板决策**（2026-08-22 用户）：D1 设置页整页 section 收右侧 / D4 升级面板并入设置页升级区块（v1.7 修订，原独立 upgrade 视图推翻）/ D5 保留托盘补充入口（聚焦主窗口 + 切视图）。

**红线核对**：

| 红线 | 内容 | 本方案落点 |
|:-----|:-----|:-----------|
| CON-R001 | 永不 fork/patch dsh 及官方 Web UI | 官方 view 零注入结构不变（默认 session + 无 preload）；preload 桥合并只在壳页（file: partition 'shell'）侧，不触碰官方 view |
| CON-R002 | 永不重写 DSH_HOME | settings 持久化仍走 `hull:setSettings` → SettingsProvider（userData 而非 DSH_HOME）；设置 section 仅消费既有 IPC |
| CON-R003 | 双升级通道独立 | dsh（Updater）与 Hull（HullUpdater）双通道入口收进统一 upgrade 视图 UI，但编排层仍走既有互斥队列（UpgradeQueue 单槽）；仅 UI 载体变 |
| CON-R004 | 壳内功能走官方扩展点 | 壳功能（设置/升级）本就是 Electron 主进程壳层能力，不注入官方 UI，无扩展点需求 |
| CON-R005 | 升级原子性 staging→替换→验证→回滚 | UpgradeQueue/SwapManager/Updater 零改动；原生 dialog 移除，确认/进度/失败/回滚提示改为壳内视图渲染，不改变状态机与原子操作 |

**非目标**：官方 UI 内集成（M2+）；升级执行逻辑（S3/S5 提供）；任务看板功能（M2 已完成，S8' 仅 view 态扩展）；快捷键导航。

**交付验收**（契约层）：既有 471 单元 + 8 集成 + 12 e2e 全绿回归；S8 既有验收口径（E2E-01 冷启动、E2E-06 托盘）保持；新增 e2e 断言——nav 设置/升级入口切视图、设置 section 可见可操作、升级确认/进度/失败壳内呈现、升级/设置域原生 dialog 不再弹出（`dialog.showMessageBox` 调用点归零，**崩溃域 1 处保留**，见 §4.5）。

**变更传播面**（本设计必列，归实现波）：
- ① S6 契约 v0.4 已注记（preload 桥并入壳 preload、DOM modal 确认流 + 250ms 轮询在 shell.html 设置 section 内重做）
- ② S3 契约 v0.3 已注记（原生 dialog 移除，确认/进度/失败/回滚/重启安装提示收进壳内 upgrade 视图）
- ③ S8 设计/实现记录：`hull:promptDshUpdate` 独立通道与 `hull:checkDshUpdate` 占用关系在 S8' 收敛（见 §4.3）；S8 实现偏离 1「原生 modal dialog 阻塞主进程」随 S3' dialog 移除一并解决
- ④ e2e 断言破坏面：settings.spec / upgrade.spec 原生 dialog 与独立窗口定位假设（见 §7）
- ⑤ 托盘：Hull 设置菜单 → 聚焦主窗口 + 切 settings 视图；检查 dsh 更新 → 聚焦主窗口 + 切 upgrade 视图（D5）

---

## 2. 架构决策（含备选）

### D2 设置页 preload 桥：并入壳 preload index.ts（单一桥）

- **方案 A（选中）：并入壳 preload `src/preload/index.ts`**——settings.ts 的 15 方法全部并入 hull 命名空间，删除 `src/preload/settings.ts` 与 `SettingsWindow.ts`。壳页（partition 'shell' + 静态 preload 已挂载）直接调用。
- **方案 B（否决）：子 view 独立 preload**——为 settings section 单独挂 preload。壳页是单页（shell.html），section 是 DOM 区块而非独立 webContents，无法按 section 挂不同 preload；且设置与升级视图都要消费 `hull:getSettings`/双通道 IPC，分开挂载只会产生「同一页面两套 hull 对象」的命名冲突。
- **选 A 理由**：
  - 安全面（白名单/CSP）：单一桥 = 单一白名单面。15 方法并入后，壳页白名单从 12 方法扩到 27 方法，但都挂在 `partition:'shell'`（非持久、file: 协议、静态挂载）的壳页上；官方 view 仍无 preload——CON-R001 结构性零注入保持。CSP 维持现状（`script-src 'unsafe-inline' 'self'`），壳页内联 script 与 kanban.js 不受影响。
  - shell.html 设置 section 直接调：单页内联 script 消费 `window.hull.*`，无需新 webPreferences 装配，零加载时序问题（现 SettingsWindow 独立窗口有独立加载生命周期，迁移后由壳页 hull:status 驱动渲染）。
  - 方法冲突核对：并入后 hull 命名空间将含 `getSettings`/`setSettings`（settings 持久化）+ `checkDshUpdate`/`upgradeDsh`/`cancelDshUpgrade`/`dismissDshUpdate`/`rollbackDsh`/`getChannel`/`setChannel`/`listVersions`（S4 通道）+ `checkHullUpdate`/`getHullUpdateStatus`/`downloadHullUpdate`/`cancelHullUpdate`/`dismissHullUpdate`/`getSettings` 等 + 既有壳桥（retry/openLogs/install/cancelInstall/installStatus/getDshStatus/onStatus/openSettings/checkDshUpdate/showBoard/showWeb）。**注意**：壳桥已有 `checkDshUpdate`（现在映射 `hull:promptDshUpdate`，S8 实现偏离 1），settings 桥的 `checkDshUpdate` 映射 `hull:checkDshUpdate`（无 dialog 返回 {hasUpdate,...}）。S8' 必须收敛该命名冲突（见 §4.3 D3'）。
- **影响**：`src/preload/settings.ts` 删除；`SettingsWindow.ts` 删除；`SettingsProvider`/`ChannelService` 等主进程侧零改动。

### D3 view 状态机形态：扩占位并集（PlaceholderView 并集），不引入独立 ViewState 变体

- **方案 A（选中）：扩占位并集**——`PlaceholderView` 从 5 个并到 7 个：`placeholder:starting | installing | failed | not-installed | board | settings | upgrade`。`ViewState = 'official' | PlaceholderView` 类型不变。
- **方案 B（否决）：独立 ViewState 变体**——`ViewState = 'official' | 'board' | 'settings' | 'upgrade' | PlaceholderView`，把 board/settings/upgrade 提为独立枚举。虽「语义更清晰」，但需要改 hull:status payload 契约（view 字段取值集）、shell.html setView() 映射、nav 高亮回写、以及主进程 showPlaceholder 调用点全部新增分派——改动面大且与既有「占位视图 = 内容区 section 显示」模型同构（board 已是先例）。
- **选 A 理由**：
  - board 先例：`placeholder:board` 已是占位并集成员，nav「任务看板」→ `showPlaceholder('board')` → section#board 显示。settings 完全同构，无新机制。
  - 契约零破坏：hull:status payload 的 `view` 字段仍是 `official | placeholder:*` 字符串并集，S8 设计的 `setView(payload.view)`（`view.startsWith('placeholder:')` → 显示对应 section）继续工作，只是 sections 数组扩一个。
  - renderer 无 view 控制通道不变式保持：section 显示仍完全由主进程 view 字段驱动。
  - 高亮回写依赖 view 字段：`placeholder:settings` → nav-settings active，映射集中一处（§4.4；v1.7 修订：去 placeholder:upgrade，无独立升级视图）。
- **影响**：hull:status payload 契约扩展（不破坏既有取值，只加 1 个新值）；`sections` 数组 +1；showPlaceholder 调用点新增一处。

### D6 双通道确认流收收范围：含 Hull 自更新（S5 面），联动 S5

- **方案 A（选中）：含 Hull 通道**——设置页升级区块统一承载 dsh + Hull 双通道确认/进度/失败/回滚/重启安装提示。
- **方案 B（否决）：只收 dsh 通道**——Hull 确认流仍走设置页内嵌 modal（S6 现状）。
- **选 A 理由**：
  - 契约 S3 v0.4 已明示「dsh/Hull 双通道确认/进度/失败/回滚/重启安装提示收进壳内统一模式」（§范围）；共识 §14.1-R S3' 验收同样写「dsh/Hull 双通道」。只收 dsh 违反冻结契约。
  - 一致性：native dialog 全部移除（main/index.ts 约 10 处 `dialog.showMessageBox` 调用归零），Hull 通道若留在设置页 modal 会出现「两种确认 UI 并存」，违背统一壳内交互模型目标。
  - 边界（不越权）：Hull 通道只收 UI 载体（确认/进度/失败/重启安装提示），HullUpdater 编排逻辑（download/installAndRestart/autoCheck 门控）零改动；DismissStore 分通道键 `{ dsh?, hull? }`（S5 已实现）保持——升级区块「稍后再说」分别调 `dismissDshUpdate` / `dismissHullUpdate`。
  - 联动 S5 成本低：Hull 通道 UI 已存在于 settings.html（DOM modal 确认流 + `getHullUpdateStatus` 250ms 轮询），迁移到 shell.html settings 升级区块是搬移 + 合并，无新编排。
- **影响**：S5 面（Hull 自更新 UI 载体）本方案一并覆盖；S5 契约（feishu-s5-m1-api-contract.md）补变更传播注记；设置页 Hull 区块「检查 Hull 更新」按钮语义保留（在 settings section 内），确认/进度流统一走设置页升级区块（见 §3 职责划分）。

### 已定决策确认（D1/D4/D5）

| 决策 | 定案 | 落点 |
|:-----|:-----|:-----|
| D1 | 设置页整页 section 收右侧 | shell.html 新增 `section#settings`（重渲染，删除独立 SettingsWindow） |
| D4 | 升级面板并入设置页升级区块（v1.7 修订，原「独立 upgrade 视图」推翻） | shell.html `section#settings` 内升级区块（双通道确认/进度/失败/回滚/重启安装提示）；删独立 upgrade 视图与 nav「升级」项 |
| D5 | 保留托盘补充入口 | 托盘「Hull 设置」→ 聚焦主窗口 + 切 settings 视图；「检查 dsh 更新」→ 聚焦主窗口 + 切设置视图；升级中禁用（S5 busy 数据源不变） |

---

## 3. 模块划分

| 文件 | 动作 | 职责 |
|:-----|:-----|:-----|
| `src/window/WindowManager.ts` | 重构 | view 状态机扩占位并集（PlaceholderView + settings；v1.7 去 upgrade）；`showSettings()` 便捷方法（封装 `showPlaceholder` + 推送）；hull:status payload 加 hullVersion（v1.7，app.getVersion()） |
| `src/preload/index.ts` | 扩展 | hull 桥并入 settings.ts 15 方法（getSettings/setSettings + 双通道升级全套 + S4 通道 + Hull 全套 + 诊断）；**收敛 checkDshUpdate 命名冲突**（§4.3）；删 showUpgrade（v1.7） |
| `src/preload/settings.ts` | 删除 | 方法并入 index.ts，文件移除 |
| `src/window/SettingsWindow.ts` | 删除 | 独立设置窗口移除（D1），壳导航/托盘入口改切 view |
| `src/renderer/shell.html` | 重构 | nav 高亮回写（view 字段驱动）；新增 `section#settings`（重渲染自 settings.html，四卡 + DOM modal 确认流 + 250ms 轮询 + **升级区块**：dsh/Hull 双通道确认/进度/失败/回滚/重启安装提示，v1.7 并入）；nav-items = dsh web/任务看板/设置（去升级，设置恒最后）；`sections` 数组扩 1 |
| `src/renderer/settings.html` | 删除 | 内容迁 shell.html `section#settings`（视觉 token 沿用：背景 `#f6f6f4`/卡片 `#fff`/强调 `#4c6ef5`） |
| `src/main/index.ts` | 重构 | 升级/设置域 `showMessageBox` 调用归零（9 处：runCheck×2/runUpgrade×2/runHullCheck×2/runHullDownload×2/preventive-prompt → 推送 view + payload 由 shell.html 渲染）；**crash dialog 保留原生**（紧急系统级，不属升级/设置域，见 §4.5）；托盘菜单改切视图（D5）；`hull:promptDshUpdate` 语义与去留见 §4.3（H1 修订：托盘走 runCheck 直连，不经 promptDshUpdate；v1.7 删 hull:showUpgrade handler）；确认流确认/取消/稍后再说调既有 IPC（upgradeDsh/cancelDshUpgrade/dismissDshUpdate/rollbackDsh/checkHullUpdate/downloadHullUpdate/cancelHullUpdate/dismissHullUpdate） |
| `src/tray/TrayController.ts` | 小改 | 设置菜单 → 聚焦主窗口 + 切 settings 视图；检查 dsh 更新 → 聚焦主窗口 + 切设置视图（D5，v1.7 改 settings 视图）；升级中禁用不变 |
| `tests/e2e/settings.spec.ts` | 重构 | 独立窗口定位 → 壳内 `section#settings` 断言（含升级区块） |
| `tests/e2e/upgrade.spec.ts` | 重构 | 原生 dialog 断言 → 设置页内升级区块确认/进度/失败断言（v1.7 不再有 section#upgrade） |
| `tests/e2e/cold-start.spec.ts` / `helpers.ts` | 小改 | helpers 定位（nav 三入口 + Hull 版本断言，v1.7）；cold-start 不受影响 |
| `tests/e2e/kanban.spec.ts` | 不变 | board 视图语义不变 |
| 契约 S6/S3 | 已更新 | v0.5 / v0.4（v1.7 迭代调整） |
| 契约 S5 | 变更传播 | Hull 通道 UI 载体收进设置页升级区块注记 |

**依赖方向**（单向，无环）：`WindowManager → {RuntimeManager, preload}`；`preload/index.ts` 依赖主进程全部 `hull:*` handler（已有）；`main/index.ts → {WindowManager, Updater, HullUpdater, SettingsProvider, TrayController}`；`shell.html → preload（window.hull）`。

**S6'→S3'→S8' 依赖**：S8'（view 状态机）是 S6'/S3' 的结构性前提（settings/upgrade section 需 view 态才能切换显示）；实现顺序 S8' 先行 → S6' → S3'。

---

## 4. 关键机制实现形态

### 4.1 view 状态机 3 态迁移矩阵（S8'，v1.7 修订：去 placeholder:upgrade）

`ViewState = 'official' | PlaceholderView`，`PlaceholderView = 'placeholder:starting' | 'placeholder:installing' | 'placeholder:failed' | 'placeholder:not-installed' | 'placeholder:board' | 'placeholder:settings'`。

| 触发 | 动作 | 迁移 |
|:-----|:-----|:-----|
| runtime Ready + url | `loadOfficialUrl(url)` | 任意 → `official`（officialDirty 则重载，否则复用） |
| runtime starting/idle 过渡 | `showPlaceholder('starting')` | 任意 → `placeholder:starting`（升级/回滚/重试过渡态） |
| runtime Failed | `showPlaceholder('failed', msg)` | 任意 → `placeholder:failed` |
| install 流程 | `showPlaceholder('installing')` | 任意 → `placeholder:installing` |
| 未安装引导态 | `showPlaceholder('not-installed')` | 任意 → `placeholder:not-installed` |
| nav 看板 | `showPlaceholder('board')` | 任意 → `placeholder:board`（已有） |
| nav 设置 / 托盘 Hull 设置 / 托盘检查 dsh 更新 | `showSettings()` → `showPlaceholder('settings')` | 任意 → `placeholder:settings`（新；v1.7 托盘检查更新也切 settings 视图） |
| 离开 official | showPlaceholder 任意模式 | `official` → `placeholder:*` 时置 `officialDirty=true`（既有语义，settings 同走） |

**迁移不变量**（S8 既有，S8' 保持）：离开 `official` 会置 `officialDirty`，下次 Ready 同 view 再 loadURL；`placeholder:board/settings` 是用户主动切视图，不改变 official 加载状态（离开官方 UI 后待机，不销毁 officialView）。**主进程单一事实源**：右侧内容区显示完全由 hull:status 的 `view` 字段驱动，renderer 无 view 控制通道不变式保持。

### 4.2 官方 view 零注入边界保持（CON-R001）

- 官方 WebContentsView：默认 session + 无 preload + 只 loadURL 官方地址 + 永不 file://——**结构不变**。
- preload 桥合并只发生在壳页（`partition:'shell'` 非持久 + `webPreferences.preload` 静态挂载）。壳页白名单从 12 → 27 方法，但全在壳自有页，不扩散到官方 view。
- CSP：shell.html 保持 `script-src 'unsafe-inline' 'self'`；settings section 迁入后与 kanban.js 同源内联，无需放宽。
- 设置/升级 section 是壳页 DOM，不涉及官方 view。

### 4.3 preload 桥合并 + checkDshUpdate 命名收敛（D2 + S8 偏离 1 收口）

**目标形态**：`window.hull` 单一对象，方法集 = 既有壳桥 12 + settings 桥 15 - 冲突去重 ≈ 26 方法。settings.ts 删除。

**checkDshUpdate 命名冲突（S8 实现偏离 1 遗留，S8' 必须收敛）**：

| 现状 | 通道 | 语义 |
|:-----|:-----|:-----|
| 壳桥 `checkDshUpdate` | `hull:promptDshUpdate` | 触发 main runCheck → 原生 dialog（待移除） |
| settings 桥 `checkDshUpdate` | `hull:checkDshUpdate` | 返回 {hasUpdate, current, latest, phase} 无 dialog，DOM modal 确认流 |

S8' 定案：**统一为一个 `checkDshUpdate` 方法，映射 `hull:checkDshUpdate`**（无 dialog 返回结果）。两条路由的 view 切换归属（H1 修订，评审证据：`TrayController.ts:100` + `main/index.ts:217` 托盘走 `runCheck()` 直连；`preload/index.ts:42` 壳导航走 `hull:promptDshUpdate`）：

- **设置页「检查更新」**（v1.7 修订：原壳导航「升级」项已删除）：点击 → 切 settings 视图（已在则不动）→ `checkDshUpdate()`（渲染侧触发检查渲染确认 UI）——两段职责分离：主进程切视图（view 单一事实源），渲染侧触发检查并渲染确认卡片。
- **托盘「检查 dsh 更新」**：`runCheck()` 内新增「若发现新版本 → `winMgr.showSettings()` + 推送」（v1.7 修订：原 showUpgrade 改 showSettings），托盘**不经 promptDshUpdate**。
- **`hull:promptDshUpdate` 去留**：壳导航升级入口删除 + 设置页改 `checkDshUpdate` 后，promptDshUpdate 成为孤儿通道 → **删除**（不保留给托盘）。`runCheck()` 三处调用方（托盘 / 启动 maybeAutoCheck `index.ts:431` / 崩溃后重查 `index.ts:375`）在 dialog 移除后统一走「发现新版 → 切设置视图 + 推送」，详见 §4.5。
- **`hull:showUpgrade`**：v1.7 删除（无独立 upgrade 视图）。

`hull:checkDshUpdate` handler 已返回 `{ok, phase, latest, current}`（S3 契约 #1），无需新增通道。

### 4.4 nav 高亮回写（S8'，从「本地假象」升级为「view 字段驱动回写」）

现状：`setActive(id)` 仅 nav 点击时本地置 active，与主进程 view 无关联（假象——用户切到官方 view 后 nav 仍是上次点击态）。

S8' 定案：**高亮由 hull:status payload 的 `view` 字段派生**，`renderStatus(payload)` 内集中映射：

```js
const navActiveByView = {
  'placeholder:board': 'nav-board',
  'placeholder:settings': 'nav-settings',
};
// renderStatus 内：official / starting / installing / failed / not-installed → nav-web 高亮
```

- 主进程 view 字段是唯一事实源：nav 点击只触发 IPC（showBoard/showSettings/切官方），渲染侧收到新 hull:status 后按 view 置 active。
- `official`（含各占位过渡态）→ nav-web active（dsh web 是默认主视图）。
- **升级进行中（v1.7 修订）**：升级在设置页内进行（settings 视图），`placeholder:settings` 且 upgrade.phase ∈ {checking/confirm/installing/swapping/verifying} → **保持 nav-settings 高亮**（用户在设置页升级区块看进度，不应闪回 nav-web）；仅 upgrade.phase=idle 时按默认规则回落 nav-web。
- nav 点击后立即本地置 active 保留（响应即时性），但随后的 hull:status 推送会校正——最终态一致（主进程事实源兜底，防连点竞态）。

### 4.5 升级确认流壳内化（dialog → DOM）（S3' + S6 面）

**main/index.ts `showMessageBox` 归零清单（9 处 → 升级/设置域 8 处删除或改推送 + crash 1 处保留）**（L2 修正：实为 9 处，非"约 10 处"）：

| 调用点 | 现状 | S8' 后（v1.7：落点 = 设置页升级区块，非独立视图） |
|:-----|:-----|:-----|
| runCheck 发现新版本确认 | `showMessageBox [立即升级/稍后再说]` | 切设置视图（若不在）+ 渲染确认卡片（版本/变更/「立即升级/稍后再说」）；稍后再说 → `dismissDshUpdate` + `dismissStore.dismissToday('dsh')` |
| runCheck checkFailed | dialog 错误框 | 设置页升级区块失败卡片（按钮下方红字，S3 契约 T3-05 语义） |
| runUpgrade 失败 | dialog 错误框 [重新检查/关闭] | 设置页升级区块失败卡片 + 重新检查按钮（`updater.snapshot().error` 渲染） |
| runUpgrade 自动回滚成功 | dialog「已回滚」 | 设置页升级区块回滚结果卡片（非失败语义） |
| crash 提示 | dialog [重启/忽略] | **保留原生 dialog**（H2 裁决：崩溃是紧急系统级提示，官方 view 已坏、壳内 section 载体未必可用；不在「设置/升级/视图机制」三子需求范围；保留符合 Electron 标准崩溃弹窗模式。此保留与 §1 验收「升级/设置域 showMessageBox 归零」口径一致——崩溃域不在归零范围） |
| preventive-prompt（Hull 更新后打开引导） | dialog 提示 | **迁设置页升级区块重启安装提示区**（H2 裁决 2：对齐 S3 契约 v0.4「重启安装提示收进壳内统一模式」；`main/index.ts:455` 改推送设置页升级区块提示卡片，`showMessageBox` 移除） |
| runHullCheck 确认 | dialog [立即下载/稍后再说] | 设置页升级区块 Hull 确认卡片；稍后再说 → `dismissHullUpdate` + `dismissToday('hull')` |
| runHullCheck checkFailed | dialog 错误框 | 设置页升级区块 Hull 失败卡片 |
| runHullDownload 失败 | dialog 错误框 | 设置页升级区块 Hull 失败卡片 |

> 注（L1 澄清）：`showSaveDialog`/`showOpenDialog`（KanbanTransfer.ts:72 看板导出/导入文件对话框）属 CON-R004 壳内功能，**保留**；归零仅限升级/设置域的 `showMessageBox`。

**runCheck 确认流机制（M1 修订，契约 S3 #2 UpgradeStatus.phase 承载）**：`runCheck()` → `Updater.check()` → phase=confirm → `hull:status` 推送（payload.upgrade.phase=confirm + latest/current）→ renderer 设置页升级区块收到后渲染确认卡片 → 用户点「立即升级」→ 渲染侧调 `hull:upgradeDsh` → 主进程 runUpgrade。全程无原生 dialog，确认卡片由 hull:status 驱动渲染。

**自动检查确认流（M2 修订）**：启动 `maybeAutoCheck`（index.ts:431）自动检查发现新版 → **不强制切设置视图**（v1.7：nav 无「升级」项，nav 状态区升级列打标提示）；手动触发（托盘/设置区块检查）→ 切设置视图渲染确认。理由：自动检查不应把用户从 dsh web 强制导航走。

**升级反馈形态（v1.7 修订：拆到各自区块底部）**：`section#settings` 内 **dsh 升级反馈拆入 dsh 运行时区块底部、Hull 升级反馈拆入 Hull 应用区块底部**（删独立升级卡，操作入口所在区块内联自己的确认/进度/失败/回滚/重启提示，语义内聚无视线断层）；双通道各自独立状态（dsh 用 `hull:getDshStatus` 的 `upgrade` 字段，Hull 用 `getHullUpdateStatus`）；250ms 轮询保留（dsh 进度 + Hull 进度）；确认/进度/失败/回滚/重启安装提示统一卡片样式（视觉 token 沿用 settings 卡 + 状态色：成功 `#2f9e44` / 警告 `#f08c00` / 错误 `#e03131`）。

**设置 section 职责分工（D6 边界，v1.7 修订：无独立升级视图/升级卡）**：
- `section#settings` dsh 区块「检查更新」→ 调 `checkDshUpdate`，发现新版 → 本区块底部升级反馈渲染确认（停留在 settings 视图，无跨视图跳转）。
- 设置区块保留：registry / closeToQuit / autoCheckDsh / autoCheckHull / channel / pinnedVersion / 诊断 / 版本信息 / Hull 自动检查开关 / rollback 按钮（canRollback 禁用态不变）。
- dsh 区块承载：dsh 升级确认 / 进度 / 失败 / 回滚结果；Hull 区块承载：Hull 升级确认 / 进度 / 失败 / 重启安装提示。
- **回滚按钮双入口**：dsh 区块升级反馈（canRollback 禁用态）+ dsh 区块版本区均可触发 `rollbackDsh`——冲突由 **queue 互斥 + phase 门控兜底**（非 idle 时 upgrade 忽略，L3 修订：非 rollback 本身幂等，依据 S3 契约 #4 + queue 互斥），无冲突。

### 4.6 设置持久化与 settings 轮询（S6'，CON-R002 不破）

- 持久化路径不变：`hull:setSettings` → SettingsProvider（userData/settings.json）→ 消费方动态读（closeToQuit/autoCheck 门控/registry 三消费点，S6 已实现）。**零改动**。
- 250ms 轮询：settings section 内联 `tick()` 与 upgrade 视图共享 hull:status + 双通道快照轮询；`getSettings`/`getDshStatus`/`getHullUpdateStatus` 三查一循环（settings.html 既有 `Promise.all` 模式搬移）。
- `SettingsWindow.ts` 删除后，原 partition 'settings' session 不再创建——壳页恒用 `partition:'shell'`。

### 4.7 托盘补充入口（D5）

- 「Hull 设置」→ `winMgr.show() + focus() + restore()` + `showSettings()`（切 settings 视图）。
- 「检查 dsh 更新」→ 聚焦主窗口 + `showSettings()` + 触发 check（v1.7 修订：原 showUpgrade 改 showSettings，无独立升级视图）。
- 升级中禁用（queue.inFlight busy）不变（S5 已实现）。

---

## 5. 工程基线

**判级**：复杂 + 安全敏感（共识 v1.6 已定，见头部）。

| 项 | 现状 | M1-重构动作 |
|:---|:-----|:-----------|
| git | feature/m1refactor 分支（共识 v1.6 + 契约 S6 v0.4/S3 v0.3 已提交，HEAD 8e19975） | 设计/实现/记录归本分支，共识归主分支（分支模型） |
| 脚手架 | TS + Electron 43 + tsc 双配置（`npm run build` / `typecheck`） | 跟随；**零新依赖**（原生 HTML/CSS/JS，不引框架，YAGNI） |
| 测试框架 | node:test 单元（39 文件 / 约 467 显式用例 + 复合 ≈ 471）+ 集成 8 + Playwright e2e 12，全绿基线 | 沿用；新增/更新：view 状态机迁移矩阵单测（WindowManager 现无单测，靠集成+e2e——重构后不引入 view 状态机单测，YAGNI，S8 §4 同策略）、settings/upgrade e2e 断言改造 |
| 脚本 | build / typecheck / test / test:e2e / verify:acceptance | 无新增 |

**S1~S8 复用清单**：WindowManager 安全 webPreferences（S1/S8）、preload 桥模式（不透传回调，S1/S2）、hull:status 推送链路（S8 D5）、showPlaceholder 机制（S8 + B2）、DOM modal 确认流（S6 settings.html）、SettingsProvider 持久化/广播（S4/S6）、双通道互斥队列（S3/S5）、e2e helpers 定位（S8/S7）。

---

## 6. 目录/工程结构（变更文件清单）

```
dsh-hull-desktop/
├── src/
│   ├── window/
│   │   ├── WindowManager.ts          # 改：view 状态机扩 1 态（settings，v1.7 去 upgrade）+ showSettings + hull:status 加 hullVersion
│   │   └── SettingsWindow.ts         # 删（D1：独立设置窗口移除）
│   ├── preload/
│   │   ├── index.ts                  # 改：hull 桥并入 settings 15 方法 + checkDshUpdate 收敛 + 删 showUpgrade
│   │   └── settings.ts               # 删（并入 index.ts）
│   ├── renderer/
│   │   ├── shell.html                # 改：nav 高亮回写 + section#settings（含升级区块，v1.7 并入）+ nav 排序 dsh/看板/设置
│   │   └── settings.html             # 删（内容迁 shell.html section#settings）
│   ├── main/
│   │   └── index.ts                  # 改：升级/设置域 showMessageBox 归零（8 处壳内化）+ crash 1 处保留 + 托盘切设置视图
│   │                                  #     + `hull:checkDshUpdate` handler（line 619）语义：切设置视图 + 触发 check（H1 修订，v1.7 切 settings）
│   │                                  #     + `hull:promptDshUpdate` handler（line 587）删除（设置页改 checkDshUpdate，孤儿通道）（H1 修订）
│   │                                  #     + `hull:showUpgrade` handler 删除（v1.7，无独立升级视图）
│   │                                  #     + runCheck 三调用方（托盘/启动 maybeAutoCheck/崩溃后重查）统一「发现新版→切设置视图+推送」（§4.5）
│   └── tray/
│       └── TrayController.ts         # 小改：入口改聚焦主窗口 + 切设置视图（D5）
└── tests/
    ├── e2e/
    │   ├── helpers.ts                # 小改：定位适配 + hullVersion 断言
    │   ├── settings.spec.ts          # 改：独立窗口 → section#settings 断言（含升级区块）
    │   ├── upgrade.spec.ts           # 改：原生 dialog → 设置页内升级区块断言（v1.7 无 section#upgrade）
    │   └── cold-start.spec.ts / kanban.spec.ts  # 不变/极小
```

删除文件：`src/window/SettingsWindow.ts`、`src/preload/settings.ts`、`src/renderer/settings.html`。

---

## 7. 风险与对策

| # | 风险 | 级别 | 对策 |
|:--|:-----|:-----|:-----|
| R1 | **preload 白名单面扩大（12→27 方法）** | 中，可控 | 全在 `partition:'shell'` 非持久壳页；官方 view 无 preload 结构不变（CON-R001）；CSP 不放宽；方法清单集中在 hull 命名空间可审计 |
| R2 | **settings 持久化路径破坏（CON-R002）** | 高，确定 | `hull:setSettings` 主进程门面零改动，仅 UI 载体迁壳页；SettingsProvider 不触碰 DSH_HOME |
| R3 | **升级原子性破坏（CON-R005）** | 高，确定 | UpgradeQueue/SwapManager/Updater 零改动；dialog 移除只改 UI 载体，状态机/原子替换/验证/回滚全在主进程编排层不动 |
| R4 | **e2e 断言破坏面** | 高，确定 | settings.spec（独立窗口定位）、upgrade.spec（原生 dialog 断言）重构；helpers 集中收敛；cold-start 断言（官方 view + 占位区块）不受影响 |
| R5 | **checkDshUpdate 命名冲突残留** | 中，确定 | §4.3 收敛：统一映射 `hull:checkDshUpdate`，`promptDshUpdate` 语义改（切视图+触发 check）；S8 实现偏离 1 记录一并关闭 |
| R6 | **nav 高亮回写竞态（本地假象 → view 驱动）** | 低 | 本地立即置 active + hull:status 推送校正，最终态主进程事实源一致；连点兜底 |
| R7 | **崩溃 dialog 保留/迁移边界** | 中，待评审 | 倾向保留原生（紧急系统级提示）；upgrade 视图不承载崩溃重启；评审定案后写 §8 |
| R8 | **Hull 通道 UI 载体迁移（S5 面）** | 低 | HullUpdater 编排零改动，仅确认/进度/失败/重启提示 UI 迁 upgrade 视图；DismissStore 分通道键保持 |
| R9 | **壳页变重（设置+升级+看板三 section 单页）** | 低 | sections 数组 +2 保持切换语义；250ms 轮询合并为单一 tick 循环（settings.html 既有 Promise.all 模式）；kanban.js 单文件 IIFE 不受影响 |
| R10 | **e2e 对原生 dialog 阻塞主进程依赖** | 中（消除） | S8 偏离 1 曾用「无更新种子 + registry hit 计数」规避 dialog 阻塞；S3' dialog 移除后该规避可简化，断言直接面向 upgrade 视图 |

---

## 8. 状态

**状态：frozen（评审通过，可进实现）**

**评审记录**：
- 评审人/机制：oracle（独立评审，ora-1）
- 日期：2026-08-22
- 结论：有条件通过（H1/H2/M2 修订后冻结）；修订完成，无 P0，已冻结
- 修订闭环：
  - **H1**（§4.3 + §6）：promptDshUpdate 调用方修正——托盘走 runCheck 直连不经 promptDshUpdate；壳导航改 showUpgrade+checkDshUpdate；promptDshUpdate 孤儿通道删除（§4.3 + §6 handler 两行）
  - **H2**（§4.5 + §1）：crash dialog 归零/保留矛盾统一——升级/设置域 8 处壳内化，崩溃域 1 处保留原生（紧急系统级）；验收口径同步「升级/设置域 showMessageBox 归零」
  - **M1**（§4.5）：runCheck 确认流机制写明（UpgradeStatus.phase=confirm → hull:status → 确认卡片 → hull:upgradeDsh）
  - **M2**（§4.5）：自动检查不强制切 view（nav 打标），手动才切
  - **M3**（§4.4）：升级进行中 nav-upgrade 保持高亮，空闲回落 nav-web（v1.7 修订：无独立 upgrade 视图，改为设置页升级区块进行中 nav-settings 保持高亮，见 §4.4）
  - **L1~L3**（§4.5）：dialog 限定 showMessageBox（KanbanTransfer 文件对话框保留）、计数 9 处、回滚幂等改「queue 互斥 + phase 门控」

**R7 定案（评审裁决）**：
1. dsh 崩溃 dialog：**保留原生**——崩溃时官方 view 已坏、壳内 section 载体未必可用；系统级紧急事件不在三子需求范围；Electron 标准崩溃弹窗模式（YAGNI）。
2. preventive-prompt：**迁设置页升级区块**（v1.7 修订：原迁 upgrade 视图，因独立视图已删）——对齐 S3 契约 v0.4「重启安装提示收进壳内统一模式」；`main/index.ts:455` 改推送提示卡片。

**实现顺序**：S8' → S6' → S3'（§3 依赖：view 状态机是 settings section 的结构性前提）。

**S5 契约变更传播**：Hull 通道 UI 载体收进设置页升级区块——归实现波补 S5 契约注记。

**核验记录**（交付核验时填写）：_预留——实现 vs 方案偏离清单 + 处理结论_

> 2026-08-22 实现完成：偏离清单与红线核对见 `docs/records/M1-重构-m1refactor-record.md` §核验记录（4 偏离点：runCheck auto 参数扩展 / 死代码 runUpgrade+runHullDownload 删除 / 单测 467 保持（方案 YAGNI）/ openSettings helper 定位适配；红线 R001/R002/R003/R004/R005 全部不破）。测试：467 unit + 8 集成 + 12 e2e 全绿；typecheck + build 干净。

**v1.7 迭代调整（用户目验反馈 2026-08-22，共识 v1.7）**：
- 触发：用户手动验证 M1-重构 UI 后反馈三处——① 左下角需显示 Hull 版本号 ② 升级菜单并入设置更好 ③ 菜单排序不合理（设置应恒最后、去升级菜单、dsh/看板/设置）；随后进一步反馈——④ 升级区块拆分到 dsh 运行时/Hull 应用各自区块内（语义内聚）⑤ 去任务看板 M2 tag（M2 已交付，历史遗留误导）
- 决策修订：**D4 推翻**（独立 upgrade 视图 → 升级并入设置页 → 拆到 dsh/Hull 区块各自底部）；view 4→3 态（去 placeholder:upgrade）；nav 菜单去「升级」项排序 dsh web/任务看板/设置（设置恒最后）+ 去 M2 tag；hull:status payload 加 hullVersion = app.getVersion()
- 实现：commit e825ef1（Hull 版本 + 升级并入设置 + nav 排序）+ 39342a1（升级拆到各自区块 + 去 M2 tag）；main/preload/WindowManager/shell.html 改动 + e2e 适配（cold-start nav 三入口 + 排序 + Hull 版本断言；upgrade.spec 改设置页内升级反馈断言）
- 测试：467 unit + 8 集成 + 12 e2e 全绿；typecheck + build 干净；编排层零改动（CON-R005）
- 文档同步：共识 v1.7 / 契约 S3 v0.4 / S6 v0.5 / record §偏离 #6（迭代调整）
- 偏离记录：此迭代调整 = 对已冻结方案的**有向修订**（用户目验反馈，非实现漂移），正文已按 v1.7 形态更新，历史决策见本 §
