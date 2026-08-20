# S8 主窗口形态变更（壳框架 + WebContentsView 内嵌）技术方案

> 变更源：共识 v1.5（2026-08-18 用户拍板）；前置：`docs/spec/影响清单-S8.md`
> 状态：frozen（评审通过·冻结，可进实现）
> 版本：0.1 · 2026-08-18
> 事实源：共识 `docs/spec/共识-Hull桌面壳-M1.md` v1.5；契约 S1 v0.3 / S2 v0.4 / S6 v0.3 / S7 v0.3（均已更新）；影响清单 `docs/spec/影响清单-S8.md`
> 判级：复杂。理由：主窗口从单 webContents 全屏渲染改为壳框架 + WebContentsView 双层结构，涉及 session 隔离拓扑、preload 挂载机制整体拆除（安全面 CON-R001/R002）、窗口生命周期/边界同步重写，e2e 窗口定位假设破坏需联动改造

---

## 1. 背景与范围

**定位**：主窗口形态变更——从"全屏渲染官方 dsh Web UI"改为"壳框架窗口：左侧 Hull 导航（壳层 UI）+ 右侧 WebContentsView 内嵌官方 UI（零注入不变，CON-R001）"。

**规则绑定**：CON-R001（永不 patch 官方 Web UI——零注入从"靠时序 unregister"升级为"结构上不可能注入"）、CON-R002（永不重写 DSH_HOME 用户数据——官方 UI 数据零迁移）、CON-R005（升级原子性不受窗口形态影响）。

**范围**：壳框架窗口（shell.html 左侧导航 + 右侧内容区 + 占位四视图区块）；官方 UI WebContentsView 内嵌（独立 webContents、默认 session、无 preload）；session 隔离（壳 partition 'shell' + 官方默认 session）；状态推送（hull:status）；导航切换（dsh web / 设置 / dsh 升级 / 任务看板占位 / 状态区）；布局边界同步；删除 placeholder.html 与 registerPreloadScript 机制。

**非目标**：任务看板路由实现（M2 规划中，占位）；快捷键导航（R7 接受，后续再议）；官方 UI 外链收紧（默认保持，发现逃逸再处理，R8）。

**交付验收**：既有验收体系回归——node:test 219 + 集成 8 + Playwright e2e 7 全绿；E2E-01 冷启动（新增开销 <500ms）；E2E-06 托盘；手动验证 R3（全屏/最大化边界）、R4（内嵌布局）、R8（外链）。

**变更传播面**：
- ① S1 契约 v0.3（loadURL 语义迁移、占位页位置、托盘补充定位）
- ② S2 契约 v0.4（引导态位置表述 3 处同步：壳框架右侧内容区）
- ③ S6 契约 v0.3（设置入口双入口注记：壳导航为主、托盘补充）
- ④ S7 契约 v0.3（E2E-01/06 注记，断言更新归实现波）
- ⑤ tests/e2e/helpers.ts 与各 spec（窗口定位重构，改动收敛在 helpers）

---

## 2. 架构决策（含备选）

### D1 嵌入技术：WebContentsView

- **iframe：否决**——与父页强制同 session → session 级 preload 污染（CON-R001 破）；官方 UI 迁独立 partition 则 dsh cookies/localStorage 离开默认 session（CON-R002 精神破，用户数据与登录态迁移）
- **BrowserView：否决**——electron 43 d.ts 已标 `@deprecated`
- **WebContentsView：选中**——独立 webContents → session 拓扑自由；`BrowserWindow.contentView.addChildView` 直接可用；官方 view 只 loadURL 官方地址，永不加载 file://

### D2 窗口结构：BrowserWindow 壳页 + 官方 view 叠加

- **方案 a（双 WebContentsView：nav view + content view）：否决**——两个 view 边界簿记/焦点管理复杂，壳 UI 本身无独立 webContents 需求
- **方案 b（选中）**：BrowserWindow 加载 `shell.html`（左侧导航 DOM + 右侧内容区 + 占位四视图区块），官方 UI 用 WebContentsView 叠加右侧（`setBounds` x = `NAV_WIDTH` = 200）
- **选 b 理由**：
  - 结构性零注入：官方 view 只 loadURL 官方地址，preload 无处可挂，registerPreloadScript 动态挂载机制整体删除——CON-R001 从"靠时序 unregister"升级为"结构上不可能注入"
  - 占位态零额外成本：右侧 DOM 区块（placeholder 四视图迁移），复用现有 preload 桥与轮询
  - 窗口级语义零改动：hide-to-tray / close / quit / title 照旧
- **布局同步**：resize / maximize / unmaximize / enter-full-screen / leave-full-screen / `screen.on('display-metrics-changed')`（多显示器拔插/DPI 切换）统一走幂等 `applyViewBounds()`；`ready-to-show` 补一次；z-order 无冲突（view 恒在壳页之上，nav 与 view 无重叠）。注记：窗口 move 跨屏无需处理（内容坐标已正确）

### D3 session 隔离：壳 partition 'shell' + 官方默认 session

- **壳框架页**：`partition: 'shell'`（非持久）+ `webPreferences.preload` 静态挂载（SettingsWindow 模式）
- **官方 view**：默认 session（不传 partition）+ 无 preload（webPreferences 不挂、session 不注册）
- **效果**：preload 污染结构性消除；`PRELOAD_SCRIPT_ID` / `registerPreloadScript` / `unregisterPreloadScript` / `getPreloadScripts` 全部删除
- **注记 ①（非持久取舍）**：壳页无持久数据需求（无 cookies/localStorage 承载物），`partition: 'shell'` 非持久——退出即清零磁盘，无需清理路径；**实现陷阱**：'shell' 与 'persist:shell' 是两个不同 session，勿混写
- **注记 ②（官方 session 等价性）**：官方 view 默认 session 与现主窗口完全等价（cookies / localStorage / websocket / SSE 同域访问一致），dsh 会话数据零迁移——CON-R002

### D4 占位态：shell.html 右侧 DOM（placeholder.html 删除）

- 四视图迁移为内容区四个 section；preload 桥不变（retry / openLogs / install / cancelInstall / installStatus 复用）；installStatus 250ms 轮询保留
- **就绪时序（顺序固化防闪错位）**：官方 view 就绪前 `setVisible(false)` → 就绪后 `setBounds` → `setVisible(true)` → `loadURL`

### D5 状态推送：主进程单一事实源 + 事件推送

- 新增 `win.webContents.send('hull:status', payload)`：现有 `getDshStatus` 形状 + `view` 字段（`official` | `placeholder:starting` | `placeholder:installing` | `placeholder:failed` | `placeholder:not-installed`）
- 壳页首载 `invoke('hull:getDshStatus')` 取初值，之后事件驱动
- **否决纯轮询**：视图切换必须与主进程状态原子一致（轮询无法保证切换时刻一致）
- 安装进度保持轮询（B6 不变，进度渲染与视图切换解耦）
- **注记（评审确认点）**：S1 lesson"无事件订阅"纪律系针对任意通道透传；此处为固定单通道受控扩展（`hull:status` 主进程单向推送），不违背纪律精神
- **注记 ③（托盘隐藏态推送）**：窗口 hide（托盘）不销毁 webContents，`webContents.send` 无问题；发送前沿用 `isDestroyed()` 检查（窗口已销毁时的兜底）

### D6 导航切换

| 入口 | 行为 | 备注 |
|:-----|:-----|:-----|
| dsh web（默认） | view 隐藏/显示 + 复用不重建 | 升级/回滚后同 view 再 loadURL |
| 设置 | 新增 IPC `hull:openSettings` → settingsWindow.show() | S6 零改动，仅入口变化 |
| dsh 升级 | 复用 `hull:checkDshUpdate`（main runCheck → 原生 dialog） | 无新通道 |
| 任务看板 | `aria-disabled` + "M2 规划中" | YAGNI，无路由实现 |
| 状态区 | `hull:status` 推送渲染 | D5 |

- **导航切换语义（消除实现歧义）**：右侧内容区显示完全由主进程 `hull:status` 的 `view` 字段驱动（主进程单一事实源）；nav 点击仅：更新本地 active 高亮 + 触发对应 IPC（设置 → openSettings、升级 → checkDshUpdate、看板 → 无操作）；**无 view 控制通道**（壳页 renderer 无法操作 WebContentsView）。自洽性：dsh 未就绪时点"dsh web"看到的占位区块恰是主进程当前推送
- 官方 view 外链：保持默认（与现状一致）；发现逃逸再收紧 deny + openExternal（R8）

### D7 其余不动

托盘、SettingsWindow、退出编排、单实例、崩溃 dialog、e2e 测试钩子全部照旧。

---

## 3. 模块划分

| 文件 | 动作 | 职责 |
|:-----|:-----|:-----|
| src/window/WindowManager.ts | 重构 | 壳窗口（partition 'shell' + preload + loadFile shell.html）；official view 管理（创建/隐藏/显示/loadURL/applyViewBounds/销毁）；状态→视图决策 + hull:status 推送；did-fail-load / did-finish-load 迁到 official view（t4 计时语义不变）；删 registerPreloadScript 机制；`getViewBounds` 抽纯函数（见 §4 单测策略） |
| src/window/getViewBounds.test.ts | 新增 | `getViewBounds(contentBounds, navWidth)` 纯函数单测（边界：窗口窄于 nav、0 尺寸、负数兜底） |
| src/renderer/shell.html | 新增 | 左侧导航（4 入口 + 状态区）+ 右侧内容区（official 容器 + 四占位区块）；CSP meta |
| src/preload/index.ts | 扩展 | 原 5 方法（retry / openLogs / install / cancelInstall / installStatus）+ getDshStatus + onStatus(cb) + openSettings + checkDshUpdate（D6 升级入口复用）；sandbox 兼容 + 固定白名单 |
| src/renderer/placeholder.html | 删除 | 占位态迁 shell.html 右侧 DOM（D4） |
| src/main/index.ts | 小改 | hull:openSettings handler；crash/installFlow 调用点改视图状态推送 |
| src/preload/settings.ts | 不变 | — |
| src/window/SettingsWindow.ts | 不变 | — |
| src/tray/TrayController.ts | 不变 | — |
| tests/e2e/helpers.ts | 重构 | URL 定位（shellPage / officialPage） |
| tests/e2e/*.spec.ts | 更新 | 经 helpers 适配（改动收敛在 helpers） |
| 契约 S1/S2/S6/S7 | 已更新 | v0.3 / v0.4 / v0.3 / v0.3 |

---

## 4. 关键机制实现形态

- **session 隔离**：壳 partition 'shell'（非持久）；官方 view 默认 session；dsh 数据零迁移
- **preload**：壳页 `webPreferences { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'shell', preload: SHELL_PRELOAD }`；official view 同安全基线但**无 preload**
- **导航切换**：主进程持 officialView；`setView('official')` → applyBounds + setVisible(true) + loadURL（未加载过才 load）；`setView('placeholder:x')` → setVisible(false) + 推送；renderer 无 view 控制通道（D6）
- **状态推送**：`runtime.on('status')` 扩展 → `sendViewState()`（hull:status）；发送前 `isDestroyed()` 检查（D5 注记 ③）
- **边界同步**：`applyViewBounds()` 用 `win.getContentBounds()`；监听 resize / maximize / unmaximize / enter-full-screen / leave-full-screen / `screen.on('display-metrics-changed')`（幂等，D2）
- **单测策略**：`getViewBounds(contentBounds, navWidth)` 抽纯函数 + 单测（边界：窗口窄于 nav、0 尺寸、负数兜底）；view 生命周期与推送链路接受集成/e2e 覆盖——WindowManager 现无单测，靠集成 + e2e；重构后不引入 view 状态机单测（YAGNI）

---

## 5. 工程基线

- **git**：main 分支干净，HEAD 25864b7 ✓
- **脚手架**：tsc 双配置 ✓
- **测试**：node:test 219 + 集成 8 + Playwright e2e 7 ✓
- **依赖**：无新增（WebContentsView 内置）

---

## 6. 风险与对策

| # | 风险 | 级别 | 对策 |
|:--|:-----|:-----|:-----|
| R1 | e2e 窗口定位假设破坏（主窗口 = 单 page 全屏 UI） | 高，确定 | helpers 集中重构 + URL 定位（shellPage / officialPage） |
| R2 | Playwright 对 WebContentsView page 支持 | 需验证 | 首跑 cold-start e2e；兜底 app.evaluate 主进程侧断言 + HTTP 探测 |
| R3 | macOS 全屏/最大化 view 边界 | 需验证 | 事件统一重算（D2）；手动 + 截图验证 |
| R4 | 官方 UI 内嵌布局适应性 | 需验证 | 零注入观察；兜底 nav 最小宽 120px |
| R5 | 冷启动预算（新增双 webContents 开销） | 低 | 新增开销 <500ms；E2E-01 回归兜底 |
| R6 | 升级/回滚期间 view 状态错乱 | 中 | 状态机已有过渡；推送 installing/starting 区块；waitForOkPage 不变 |
| R7 | 跨 view 键盘焦点 | 已知限制，接受 | 鼠标导航；快捷键后续再议 |
| R8 | dsh UI 外链逃逸 | 待观察 | 保持默认；发现后收紧 deny + openExternal |
| R9 | 崩溃 dialog 后 failed 视图链路 | 低 | 推送路径等价迁移 |

---

## 7. 建议实现顺序

1. **契约先行**（已完成：S1/S2/S6/S7）
2. **壳骨架**：shell.html（nav + 内容区 + **四占位区块**）+ preload 扩展 + WindowManager 重构（双 session + view 嵌入 + 边界同步）——占位四区块是壳骨架的结构性前提（官方 view 永不加载 file://）
3. **helpers 适配**：URL 定位重构 + cold-start 更新 → 跑通既有 e2e（R2 验证点；注记：此时占位已迁 shell.html，断言口径自洽）
4. **状态接线**：hull:status 推送接线 + nav 状态区渲染 + **删除 placeholder.html 与 registerPreloadScript 机制**（机制拆除独立成步）
5. **入口接线**：hull:openSettings + 升级入口 + 看板占位
6. **全量回归**：219 + 8 + 7 + 手动验证 R3/R4/R8；e2e 新增断言细项——nav 入口点击（设置开窗/升级触发 dialog）、占位区块切换（install 流程 installing 区块可见）、状态区版本渲染、隐藏窗口下状态推送仍更新
7. **文档收尾**：设计冻结 + 影响清单勾销 + 变更摘要 + 沉淀

---

## 8. 核验记录

- 状态：已实现（核验通过）
- 实现 vs 方案偏离清单：
  1. **hull:promptDshUpdate 独立通道**（D6"无新通道"表述）——S6 设置页占用 `hull:checkDshUpdate`（DOM modal 确认流），壳导航升级入口走独立通道；桥方法名保持 checkDshUpdate（D6 命名）。有意偏离，记录理由
  2. **fake-registry env bug 存量修复**（tests/fixtures/fake-registry.js）——`options.latest` 未被消费，env `FAKE_REGISTRY_LATEST` 被忽略 → latest 恒默认值；修复 `options.latest || env || default`
  3. **原生 modal dialog 阻塞主进程**——S3 既有行为（非 S8 引入），e2e 用"无更新种子 + registry hit 计数"规避
  4. **WindowManager onUpgradeStatus 订阅入口**（P1-1 修复）——updater 状态 → sendViewState 仅刷新 payload 不改 view，两源职责分离

---

## 9. 评审记录

- 评审人/机制：ora-1（oracle 独立评审）
- 日期：2026-08-18
- 结论：有条件通过（4 项 P1 + 2 项 P2 修订后冻结）；修订完成，无 P0/P1 残留
