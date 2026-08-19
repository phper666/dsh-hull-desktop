# S8 主窗口壳框架实现经验沉淀

> 日期：2026-08-18 · 来源：S8 主窗口形态变更（共识 v1.5）

## Lesson 1：测试 fixture 的 env 注入必须实际消费——静默忽略的 env 是最难查的 e2e 挂起根因

**现象**：Playwright e2e 在新增 nav 测试后随机挂起（macOS 原生 dialog runModal 阻塞主进程事件循环 → shell/evaluate 全部超时）。排查两轮才定位：`tests/fixtures/fake-registry.js` 头注释声明读 `FAKE_REGISTRY_LATEST` env，但 `start()` 只读 `options.latest`（恒 undefined）→ env 被静默忽略 → fake registry 恒返回默认 latest 9.9.9 → 测试种子"无更新"前提失效 → check 误判有更新 → 弹原生 modal dialog → 阻塞。

**根因模式**：fixture 声明了 env 契约但实现没消费——**声明与消费不一致**。任何"文档说支持但代码不读"的注入点都是定时炸弹。

**修复**：`options.latest || process.env.FAKE_REGISTRY_LATEST || DEFAULT_LATEST`（显式优先级链）。

**复用**：
- 测试 fixture 的 env/option 注入：写完后 grep 确认 env 名实际被消费
- e2e 挂起先查"是否有原生 modal 弹出"（macOS runModal 阻塞主进程 JS 是 Electron 平台特性）
- 规避策略：e2e 用"无更新种子 + registry hit 计数断言"而非"真弹 dialog 再点掉"

## Lesson 2：Electron 壳内嵌第三方 web 的零注入方案——WebContentsView + 双 session 结构性隔离

**背景**：Hull 壳需要左侧导航（壳 UI）+ 右侧内嵌官方 dsh web（CON-R001 零注入红线）。初版方案用 `session.registerPreloadScript` 动态挂载/卸载实现"占位页挂 preload、官方不挂"——依赖时序 unregister，且该 API 无 URL pattern 参数（session 内所有 frame 导航都执行），是脆弱方案。

**最终方案（S8 D1-D3）**：
- 壳窗口 BrowserWindow 自身加载 shell.html（左侧 nav DOM + 右侧容器），webPreferences `partition: 'shell'`（非持久）+ 静态 preload
- 官方 UI 用 `WebContentsView`（默认 session、无 preload、永不加载 file://）叠加右侧区域
- registerPreloadScript 机制整体删除——CON-R001 从"靠时序 unregister"升级为"**结构上不可能注入**"

**关键要点**：
- `registerPreloadScript`/`setPreloads` 是 session 级的——与官方 UI 同 session 的任何注入都污染官方（无 URL pattern 过滤）
- 官方 UI 数据（cookies/localStorage）在默认 session，壳 UI 数据在独立 partition——数据隔离 + 零迁移
- `'shell'` 与 `'persist:shell'` 是两个不同 session（勿混写）
- BrowserView 已 deprecated（Electron 43 d.ts 核实），WebContentsView 是现代替代
- view 边界同步：`resize/maximize/unmaximize/enter-full-screen/leave-full-screen/display-metrics-changed` 六事件统一幂等 `applyViewBounds()`

**复用**：任何"壳/宿主 UI + 内嵌第三方 web"的 Electron 应用；判断标准：第三方 web 是否零注入红线 → 是则双 session + WebContentsView 是首选。

## Lesson 3：e2e 窗口定位用 URL 而非顺序（wins[0]）——WebContentsView 破坏顺序假设

**现象**：壳框架引入 WebContentsView 后，`_electron.launch().windows()` 暴露多个 page（shell page + official view page），原有 `wins[0]` 顺序假设失效。

**方案**：helpers 集中重构为 URL 定位——`shellPage`（URL 含 shell.html）/ `officialPage`（URL 前缀 http://127.0.0.1:），所有窗口定位走唯一入口函数，spec 不直接碰 windows 数组。

**验证**：Playwright 1.62+ 对 WebContentsView 的 page 暴露可用（`app.windows()` 含 view webContents）；主进程侧兜底 `app.evaluate` 可断言 `view.webContents.getURL/isVisible`。

**复用**：Electron e2e 多窗口/多 view 场景一律 URL 定位；断言非假阳性（冷启动断言链：shell URL + view URL + HTTP body 探测三层）。
