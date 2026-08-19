# 2026-08-18 M1 真实运行验证记录

> 环境：Intel x86_64 Mac（i7-9750H）——**注意：项目红线 CON-R006 目标 Apple Silicon，开发机为 Intel，运行验证用 electron x64 版**（产物差异已标注，不改变目标平台）

## 解封路径（electron 二进制）

- github.com 与 npmmirror.com 的 `install.js`（undici fetch）均失败；**curl 直下 npmmirror zip 成功**：
  `curl -sL -o /tmp/electron-v43.4.0-darwin-x64.zip "https://npmmirror.com/mirrors/electron/43.4.0/electron-v43.4.0-darwin-x64.zip"` → 解压到 `node_modules/electron/dist/` + 写 `path.txt`（`Electron.app/Contents/MacOS/Electron`）
- 首次误下 arm64（bad CPU type）——本机 x86_64，须 x64 包

## 真实运行发现（单元测试测不到的集成 bug）

### 🔴 已修复 1：`hull:checkHullUpdate` IPC 重复注册
- 症状：`Attempted to register a second handler for 'hull:checkHullUpdate'`（unhandled rejection）
- 根因：S5 切片 3 预留版（main:431）+ S6 designer 接线版（main:505）重复 `ipcMain.handle`
- 修复：删 S5 预留版（S6 完整实现替代）——`src/main/index.ts`
- 教训：**预留 IPC 通道与后续接线重复注册是跨 S 集成的典型 bug，单测不覆盖 main 装配路径，必须真实运行验证**

### 🔴 已修复 2：placeholder.html / settings.html `hull` 词法冲突
- 症状：`Uncaught SyntaxError: Identifier 'hull' has already been declared`（页面脚本整体失效，引导态 UI 不响应）
- 根因：Electron `contextBridge.exposeInMainWorld('hull', ...)` 创建的全局绑定与页面脚本 `const hull = window.hull;` 词法声明冲突（contextBridge 暴露 key 为全局词法绑定）
- 修复：页面改 `const bridge = window.hull;` + 引用替换（两文件，sed）
- 教训：**contextBridge 暴露的 key 名不能与页面脚本顶层 const 同名**——桥变量用别名（bridge/api 等）更稳

## 真实链路验证（S1/S2 行为确认）

| 链路 | 结果 |
|---|---|
| 壳启动（单实例锁/Logger/Settings/whenReady） | ✓ 稳定运行 |
| ensure 三态 → 无 overlay → 自动首装 | ✓ 触发（页面切 installing 视图） |
| npmRunner spawn npm install（PATH 兜底 node） | ✓ 真实执行 |
| `--fetch-timeout=30000` 超时 → exit 1 | ✓ 真实生效（手动 npm 无此参数会挂起） |
| 失败 → staging 清理 → 引导态 + 错误消息 | ✓ 页面显示「npm 非零退出（code=1）」 |
| UI 修复后 JS 错误 | ✓ 0 |

## 环境发现

- 真实包 `@deepseek-ai/dsh` **存在**：latest = **0.1.0-rc.7**（2026-08-18 实测；S7 契约记录的 rc.6 为 08-14 实测，**需更新**）
- npm install 网络慢（30s fetch 超时触发）——真实网络瓶颈，非代码 bug；registry 配置入口（S6）可用于换源
- `session.setPreloads` deprecated（Electron 43）——S1 零注入方案可用但标记废弃 → **已迁移 `registerPreloadScript`（2026-08-18 闭环，见待办 #3）**
- renderer 无 CSP 安全警告（Electron Security Warning）——登记待办（file: 页面可加 meta CSP）

## 待办（已登记）

1. ✅ S7 契约版本记录更新：rc.6 → rc.7（08-18 实测）——已闭环（2026-08-18：feishu-s7-api-contract.md 变更记录加 08-18 实测注记 latest = 0.1.0-rc.7）
2. main 启动早期加 logger.info 调用点（首装失败路径写日志——当前 hull.log 空是设计缺口）
3. ~~`session.setPreloads` → `registerPreloadScript`（Electron 43 废弃 API）~~ ✅ 已闭环 2026-08-18：WindowManager 迁移（固定 id `hull-placeholder`，占位页注册 / 官方 UI unregister），src/preload/index.ts 注释同步
4. renderer CSP meta（消 Electron 安全警告）
5. e2e 骨架（electron 就绪后：Playwright + E2E-01~07+）——真实环境可跑了
