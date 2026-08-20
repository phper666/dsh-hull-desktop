# S1 经验沉淀：electron preload 挂载机制 与 node:test/tsc 工具链坑

> 三硬标准：可复用 / 非显而易见 / 有代价（均通过）
> 来源-出生：S1 壳骨架（dsh-hull-desktop）· 来源 PRD：2026-08-14-m1-prd.md
> 来源-引用：实现期

---

## Lesson 1：Electron 43 `LoadURLOptions` 无 `preload` 字段——零注入方案的正确落点

### 现象
设计（S1-壳骨架-m1-design.md D6）写「preload 仅随占位页 loadURL 显式传入：`loadURL(url, { preload })`」。实现期核对 `node_modules/electron/electron.d.ts`（43.x）：`LoadURLOptions` 只有 httpReferrer/userAgent/extraHeaders/postData/baseURLForDataURL——**没有 preload 字段**。设计假设的机制在 API 层面不存在。

### 根因
Electron 的 preload 挂载点是 `BrowserWindow` 构造的 `webPreferences.preload`（窗口级、创建后不可变），以及 `session.setPreloads(preloads)`（session 级、可动态改）。`loadURL` 只控制页面加载目标，不控制 preload。

### 对策
用 `session.setPreloads` 实现设计同语义的「按加载目标动态挂载」：
- 占位页加载前：`win.webContents.session.setPreloads([preloadPath])`
- 官方 UI 加载前：`win.webContents.session.setPreloads([])`（零注入，CON-R001）
- 窗口 webPreferences **不挂** preload（保持默认无注入）

语义与设计一致：preload 仅占位页存在、官方 UI 零注入；代价是改动点从一次 loadURL 调用变成两次 setPreloads 调用（WindowManager 内收敛，单点）。

### 代价与注意
- `setPreloads` 是 **session 级共享**：同一 session 的所有页面继承。S1 单窗口无碍；S6 设置窗口若复用默认 session，会继承占位页 preload——需独立 `partition` 或显式管理（已登记 🟢-4）
- 快速连续导航时 setPreloads 与 loadURL 的时序要序列化（WindowManager 已保证先清后载）

---

## Lesson 2：node:test 目录参数与 tsc 版本——工具链假设要先实测

### 现象 1：`node --test dist` 在 node 24 下报错
```
Error: Cannot find module '/path/dist'
```
node 24 把裸目录参数当模块 require（MODULE_NOT_FOUND），不递归发现测试。改 glob 形式：
```json
"test": "tsc && node --test \"dist/**/*.test.js\""
```
node ≥ 21 的目录递归发现语义与预期不符，glob 显式、跨版本稳定。

### 现象 2：全局 tsc 4.3.4 不支持 ES2022 target
```
tsconfig.json(3,15): error TS6046: Argument for '--target' option must be: ... 'es2021', 'esnext'.
```
以及 inline type import（`import { type X }`）报 TS1005。ES2022 target 需 TS ≥ 4.5（实际 4.6+ 才完整）。机器上的 `tsc` 是 yarn 全局 4.3.4，`--version` 没看出问题，编译才炸。

### 根因
- 工具链「默认可用」假设不成立：node --test 的目录参数语义随版本变化；全局 tsc 版本老旧
- 项目 tsconfig 的 target 声明（ES2022）比编译器能力超前

### 对策
- 先 `tsc --version` + 最小编译探针实测，再写 tsconfig/scripts
- 编译用项目内 typescript 5.x（`npm i -D typescript@^5.4.0`），不依赖全局 tsc
- 测试运行一律 glob 形式，不传目录

### 代价
- 版本检查是每次脚手架的一小步，但能省一次「工具报错原文来回」的调试周期
