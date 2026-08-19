# S8 实现记录与核验记录

> 判级：复杂（主窗口结构重构 + session 拓扑变更 + preload 机制替换 + e2e 破坏面）
> 事实源：契约 S1 v0.3 / S2 v0.4 / S6 v0.3 / S7 v0.3（已更新）；设计 `docs/design/S8-主窗口形态-design.md`（frozen 2026-08-18，ora-1 评审有条件通过 → 修订后冻结）

## 实现记录

### 文件清单

- `src/window/WindowManager.ts` — 重构：壳窗口（partition 'shell' + preload + loadFile shell.html）+ 官方 WebContentsView 管理（创建/隐藏/显示/loadURL/applyViewBounds/销毁）；`hull:status` 推送（`win.webContents.send`）+ 首载 `hull:getDshStatus` invoke；`did-fail-load` / `did-finish-load` 迁 official view（t4 计时语义不变）；`registerPreloadScript` / `unregisterPreloadScript` / `getPreloadScripts` / `PRELOAD_SCRIPT_ID` 整体删除；`onUpgradeStatus` 订阅接线（P1-1，见核验记录）
- `src/renderer/shell.html` — 新增：左侧 Hull 导航（dsh web / 设置 / dsh 升级 / 任务看板占位 + 状态区）+ 右侧内容区（official 容器 + 占位四区块：starting / installing / failed / not-installed）；CSP meta
- `src/preload/index.ts` — 扩展至 9 方法：原 5 方法（retry / openLogs / install / cancelInstall / installStatus）+ getDshStatus + onStatus(cb) + openSettings + checkDshUpdate；sandbox 兼容 + 固定白名单
- `src/main/index.ts` — 小改：`hull:openSettings` handler（→ SettingsWindow.show()）；`hull:promptDshUpdate` handler（→ Updater 检查 + 原生 dialog）；crash / installFlow 调用点改视图状态推送
- `src/window/getViewBounds.ts` + `getViewBounds.test.ts` — 新增：`getViewBounds(contentBounds, navWidth)` 纯函数（边界计算抽离，D2 布局同步核心）
- `src/renderer/placeholder.html` — 删除（占位态迁 shell.html 右侧 DOM，D4）
- `tests/e2e/helpers.ts` — 重构：URL 定位（shellPage / officialPage），窗口结构断言适配
- `tests/e2e/cold-start.spec.ts` — 更新：窗口结构断言适配（经 helpers）
- `tests/fixtures/fake-registry.js` — 适配：存量 env bug 修复（见偏离 2）

### TDD

`getViewBounds` 3 用例先红后绿（新增 222 - 219 = 3）：窗口窄于 nav（兜底最小宽）/ 0 尺寸（返回零宽兜底）/ 负数兜底（contentBounds 非正时边界钳制）。view 生命周期与推送链路接受集成/e2e 覆盖（WindowManager 现无单测，YAGNI——S8 设计 §4 单测策略）。

### 关键实现点（D1-D7 落实摘要）

- **D1 嵌入技术**：WebContentsView 落地——独立 webContents + `BrowserWindow.contentView.addChildView`；官方 view 只 loadURL 官方地址，永不加载 file://
- **D2 窗口结构**：BrowserWindow 壳页 + 官方 view 叠加右侧（setBounds x = NAV_WIDTH = 200）；`applyViewBounds()` 幂等边界同步，监听 resize / maximize / unmaximize / enter-full-screen / leave-full-screen / `screen.on('display-metrics-changed')`；`ready-to-show` 补一次
- **D3 session 隔离**：壳 partition 'shell'（非持久）+ 静态 preload 挂载；官方 view 默认 session + 无 preload；preload 污染结构性消除（机制整体删除）；'shell' 与 'persist:shell' 不混写
- **D4 占位态**：四视图迁 shell.html 右侧四 section；preload 桥与 installStatus 250ms 轮询复用；就绪时序固化（就绪前 setVisible(false) → setBounds → setVisible(true) → loadURL）
- **D5 状态推送**：`hull:status` 单通道主进程推送（getDshStatus 形状 + view 字段：official / placeholder:starting / placeholder:installing / placeholder:failed / placeholder:not-installed）；发送前 isDestroyed() 检查（托盘隐藏态）
- **D6 导航切换**：dsh web 复用不重建；设置 → hull:openSettings（S6 零改动）；升级 → hull:promptDshUpdate（偏离 1：独立通道）；看板 aria-disabled 占位；状态区 hull:status 渲染；renderer 无 view 控制通道
- **D7 其余不动**：托盘 / SettingsWindow / 退出编排 / 单实例 / 崩溃 dialog / e2e 测试钩子照旧

## 核验记录

### Code Review

- ora-1 独立评审：**有条件通过** → 修订冻结（4 项 P1 + 2 项 P2 已修订，见设计文档 §9）
- 实现期 **P1-1 修复**：`updater.on('status')` → `sendViewState()` 推送接线（升级状态事件未驱动视图状态刷新）——已修复 + 验证全绿
- P2 四项清理（注记级）已落实 → 复验全绿，无 P0/P1 残留

### Semgrep

- 224 rules：**0 findings**

### 四层验证

| 层 | 命令 | 结果 |
|:---|:-----|:-----|
| typecheck | `npm run typecheck`（tsc --noEmit 双配置） | 干净 |
| 单元 | `npm test` | 222 pass（219 回归 + 3 getViewBounds 新增） |
| 集成 | `npm test` | 8 pass（含既有 spawn/readiness 链路回归） |
| e2e | `npm run test:e2e` | 8/8 全绿（冷启动 1853ms ≤ 10s 预算） |
| 扫描 | Semgrep 224 rules | 0 findings |

e2e 8/8 覆盖：R2 验证点（Playwright 对 WebContentsView page 支持——helpers URL 定位落地即验证通过）；E2E-01 冷启动（1853ms）；E2E-06 托盘（壳框架窗口结构下回归）；install / upgrade / settings 场景组全绿。

### 契约符合性

- **S1 v0.3**（loadURL 语义迁移、占位页位置、托盘补充定位）：已实现
- **S2 v0.4**（引导态位置：壳框架右侧内容区 3 处）：已实现（占位区块）
- **S6 v0.3**（设置入口双入口注记：壳导航为主）：已实现（hull:openSettings）
- **S7 v0.3**（E2E-01/06 注记，断言更新）：已实现（8/8 全绿）

### 风险/注记（实现偏离，已回填设计 §8）

1. **hull:promptDshUpdate 独立通道**（D6"无新通道"表述偏离）——S6 设置页占用 `hull:checkDshUpdate`（DOM modal 确认流），壳导航升级入口走独立通道；桥方法名保持 checkDshUpdate（D6 命名）。有意偏离，理由记录
2. **fake-registry env bug 存量修复**——`options.latest` 未被消费，env `FAKE_REGISTRY_LATEST` 被忽略 → latest 恒默认值；修复 `options.latest || env || default`
3. **原生 modal dialog 阻塞主进程**——S3 既有行为（非 S8 引入），e2e 用"无更新种子 + registry hit 计数"规避
4. **WindowManager onUpgradeStatus 订阅入口**（P1-1 修复）——updater 状态 → sendViewState 仅刷新 payload 不改 view，两源职责分离

- 手动验证项（R3 全屏/最大化边界、R4 内嵌布局、R8 外链逃逸观察）不在本次记录范围，归交付核验/后续观察
