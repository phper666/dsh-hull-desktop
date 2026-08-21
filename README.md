中文 | [English](README.en.md)

# Hull Desktop（`dsh-hull-desktop`）

**围绕 DeepSeek Harness 的桌面开发工具——永远不碰它本身。**

Hull 是一个开源的 Electron 桌面壳，包住官方的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）。它作为子进程启动并守护 dsh，通过 npm overlay 原位升级，渲染官方 Web UI——官方每次升级都会自动生效，没有任何 fork、patch 或替换。

Hull 面向程序员，在官方之上叠加自己的层：任务看板、原生托盘与通知集成、以及通过 dsh 官方扩展点提供的插件扩展——全部是增量的、可摘除的，绝不挡 dsh 的路。

> **状态：** M1 已交付（M2 已完成验收，467+8+3 e2e 全绿）——桌面壳、dsh 升级、Hull 自更新、设置页/托盘、主窗口壳框架（左侧导航 + 官方 UI 内嵌）全部完成并通过测试验收；M2 任务看板（B1~B5）与多 agent 注册表 + 审批流（dsh ACP 集成）已完成。

> **AI 工作流声明：** 本项目使用 [ai-workflow-skills](https://github.com/phper666/ai-workflow-skills)（团队 AI 研发工作流 skills 套件）驱动开发——共识文档 → 三角色扫描 → 待确认闭环 → 接口契约 → 技术方案（判级）→ 实现纪律（TDD/lint/Review/Semgrep）→ 交付核验 → 变更传播 → 经验沉淀。工作流产物见 `docs/`（spec/共识、api/契约、design/技术方案、prd/需求、prototype/原型、records/实现记录、lessons/经验）。

## 设计原则

- **纯壳。** Hull 永不 fork、patch 或替换 dsh 及其 Web UI。官方每个版本发布当天即可在 Hull 中使用。
- **两条独立的升级通道。** dsh 通过壳内 npm overlay 升级（手动触发、原子替换、失败回滚）；Hull 本身作为独立应用自更新。互不阻塞。
- **功能都是增量层。** 壳原生功能住在 Electron 主进程；任何需要跑在 dsh 内部的功能走 dsh 官方插件扩展点（`--patch` overlay / bundle）。坏掉的特性层可随时禁用，不影响 dsh。
- **用户数据保持官方。** 会话、设置、凭据都在 `DSH_HOME` 里，Hull 绝不重新实现或改写。

## 功能状态

### ✅ M1 已完成（2026-08-18 验收）

- [x] 桌面壳：启动 / 守护 / 重启 dsh 子进程（S1/S2）
- [x] 主窗口壳框架：左侧 Hull 导航 + 右侧官方 Web UI 内嵌（S8）
- [x] 壳内 dsh 升级：npm overlay、原子替换、一键回滚（S3/S4）
- [x] Hull 自更新：独立升级通道（S5）
- [x] 设置页 + 系统托盘（S6）
- [x] 测试验收：467 单元 + 8 集成 + 3 e2e 全绿（S7）

### ✅ M2 已完成（2026-08-21 验收）

- [x] 任务看板：B1~B5（数据模型/UI/执行引擎/审批集成/导出导入）+ 全量 e2e
- [x] 多 agent 注册表 + 审批流（dsh ACP 集成）

## 架构

```
┌─ Hull（Electron 主进程）──────────────────────────────┐
│  托盘 · 窗口 · 自启 · 升级管理器                        │
│  spawn dsh 子进程 → loadURL → 重启编排                  │
│  ── M2 实现层 ──                                      │
│  · 执行引擎：Scheduler 单飞 + 原子结算段                │
│  · 审批流：ApprovalManager + ProviderRegistry          │
│  · 导出导入：KanbanTransfer                            │
│  （壳内层：看板 / 导出 / 执行控制）                     │
└──────────────────────┬───────────────────────────────┘
                       │ 子进程（Node）
┌─ dsh（官方 npm 包，不修改）───────────────────────────┐
│  宿主插件 · API 网关 · 官方 Web UI                     │
│  └─ Hull 的增量层（可选插件）────────────────────┐    │
└──────────────────────────────────────────────────────┘
```

## 开发者快速开始

### 环境要求

- **Node.js** `^22.19 || >=24`（CON-R007 捆绑独立 node）
- **macOS Apple Silicon**（M1 平台范围，M1 已通过 CON-R006）；代码跨平台友好
- **npm** 9+

### 首次拉取

```bash
git clone <repo>
cd dsh-hull-desktop
npm install
npm run typecheck    # tsc 检查
npm test             # 单测 + 集成（467+8 全绿）
npm run dev          # tsc + electron . (启动壳)
```

### 命令矩阵

| 命令 | 作用 |
|---|---|
| `npm run build` | tsc 编译到 dist/ |
| `npm run typecheck` | tsc --noEmit 干净检查 |
| `npm test` | unit + integration |
| `npm run test:unit` | `tsc && node --test "dist/**/*.test.js"` |
| `npm run test:integration` | `tsc -p tsconfig.tests.json && node --test "dist-tests/**/*.test.js"` |
| `npm run test:e2e` | `tsc && playwright test` |
| `npm run dev` | 启动 Electron 壳（需 dsh 已安装或 fake 模式） |
| `npm run verify:acceptance` | 验收脚本（`scripts/verify-acceptance.mjs`） |

### 目录结构

```
src/
├── main/          # Electron 主进程编排（启动流/单实例/双升级/看板装配）
├── preload/       # contextBridge 白名单桥（window.hull/kanban/exec）
├── renderer/      # 渲染层（shell.html 壳框架 + settings.html + kanban UI 原生 JS）
├── window/        # 主窗口/WebContentsView 编排（壳框架占位视图机制）
├── tray/          # 系统托盘控制器
├── settings/      # 设置持久化（settings.json schemaVersion=3）
├── kanban/        # 看板数据层（M2 B1/B5：boards.json + 18 IPC）
├── exec/          # 执行引擎（M2 B3/B4：Scheduler/StateMachine/ACPProvider/ApprovalManager）
├── updater/       # dsh 升级（npm overlay + 原子 staging/替换/回滚）
├── runtime/       # dsh 子进程管理（spawn/就绪探测/单实例）
├── overlay/       # dsh overlay 安装流
├── channel/       # 主↔渲染 IPC 通道
├── log/           # 日志（hull.log + dsh-pid.log 轮转）
└── shared/        # 共享类型+错误+IPC channel 白名单

tests/
├── unit/          # （隐式：src/**/*.test.ts co-located，467 用例）
├── integration/   # tests/integration/（8 用例：实时性集成如 ReadinessProbe）
├── e2e/           # Playwright e2e（11 用例：cold-start/upgrade/install/settings/kanban）
└── fixtures/      # fake-dsh.js + fake-registry.js（隔离外部依赖）

docs/
├── spec/          # 共识文档（基线 + 变更摘要 L1/L2）
├── api/           # 契约（feishu-<story>-m<n>-api-contract.md）
├── design/        # 技术方案（frozen doc）
├── records/       # 实现/核验记录（M*/S* 命名）
└── lessons/       # 经验沉淀
```

### 模块一句话

- **main**: 启动编排 + IPC 装配 + 退出清理
- **preload**: 白名单桥（沙箱兼容，仅随壳页挂载）
- **renderer/shell.html**: 壳框架（左侧 nav + 占位视图机制 + 状态区）
- **renderer/kanban.js**: 看板 UI 三视图 + 拖拽 + 详情 + 审批弹窗
- **window/WindowManager**: 主窗口 + WebContentsView 视图切换
- **kanban/KanbanStore**: boards.json 单文件原子写 + 16 IPC + CON-R017 守住
- **exec/ExecutionEngine**: 执行引擎门面（Scheduler + Heartbeat + Convergence + VerifyGate）
- **exec/scheduler/Scheduler**: 单飞循环 + 原子结算段（CON-R023 并行≤3）
- **exec/provider/ACPProvider**: dsh ACP 子进程 JSON-RPC 客户端
- **exec/approval/ApprovalManager**: FIFO + deadlineAt 主进程计时 + 30s 超时 deny

### 测试纪律 + e2e 钩子

```
HULL_USER_DATA=/tmp/test-userdata  # 隔离 userData（CON-R002 精神）
HULL_E2E=1                        # 暴露 __hullTest 钩子（Playwright 兜底）
FAKE_DSH_MODE=ready               # fake dsh 即时进入 ready 态，跳过真实 download
HULL_REGISTRY=https://registry.npmjs.org
npm run test:e2e                  # 全部 Playwright 用例
```

### 开发流程

团队 AI 研发工作流（ai-workflow-skills 模板）驱动——共识 → 三角色扫描 → 待确认闭环 → 契约 → 判级 → 实现管道（TDD/lint/Review/Semgrep）→ 交付核验 → 变更传播 → 经验沉淀。详见 `docs/spec/共识-Hull桌面壳-M*.md`。

### 约束

CON-R001~R005 红线 → 永不 fork dsh / 不重写 DSH_HOME / 双升级通道独立 / 壳内功能住主进程 / 升级原子 staging→替换→回滚。

## 许可证

[MIT](LICENSE)
