# 开发者文档：搭建与环境架构（setup-and-architecture）

> 面向开发者的项目深入指南，比 README「开发者快速开始」区块更详尽。状态：M1 + M2 已完成，467+8+3 e2e 全绿。

## 1. 快速搭建（极简路径）

**环境要求：**

- **Node.js** `^22.19 || >=24`（CON-R007 捆绑独立 node）
- **npm** 9+
- **macOS Apple Silicon**（M1 平台范围，已通过 CON-R006）；代码跨平台友好

**三步跑通：**

```bash
git clone <repo>
cd dsh-hull-desktop
npm install
```

**首次跑通验证（三者依次）：**

```bash
npm run typecheck    # 1. tsc --noEmit 干净通过
npm test             # 2. 单测 + 集成全绿（467+8）
npm run dev          # 3. 启动 Electron 壳（需 dsh 已安装，或设 FAKE_DSH_MODE=ready 走 fake 模式）
```

## 2. 运行命令矩阵

全部来自 `package.json` scripts：

| 命令 | 做什么 | 何时用 |
|---|---|---|
| `npm run build` | `tsc` 编译到 `dist/` | 产出编译产物 |
| `npm run typecheck` | `tsc --noEmit` 干净检查 | 日常改代码后快速校验类型 |
| `npm test` | `test:unit` + `test:integration` | 提交前全量单测+集成 |
| `npm run test:unit` | `tsc && node --test "dist/**/*.test.js"` | 单测（编译到 dist 再跑，含 co-located 用例） |
| `npm run test:integration` | `tsc -p tsconfig.tests.json && node --test "dist-tests/**/*.test.js"` | 集成测试（实时性如 ReadinessProbe） |
| `npm run test:e2e` | `tsc && playwright test` | 全量 Playwright e2e |
| `npm run dev` | `tsc && electron .` | 启动 Electron 壳开发 |
| `npm run verify:acceptance` | `node scripts/verify-acceptance.mjs` | 验收脚本（M 交付核验） |

**入口说明：** `main` 指向 `dist/main/index.js`，`npm run dev` 会先 `tsc` 编译再启动 electron。

## 3. 项目目录结构（深入版）

```
dsh-hull-desktop/
├── src/
│   ├── main/                 # Electron 主进程
│   │   ├── index.ts          # 启动编排（单实例→清理→overlay→窗口→IPC→双升级）
│   │   └── ipc/              # (隐式)
│   ├── preload/              # contextBridge 桥
│   │   ├── index.ts          # 三桥：window.hull / window.kanban / window.exec
│   │   └── settings.ts       # 设置页独立桥（settingsWindow 独占）
│   ├── renderer/             # 渲染层
│   │   ├── shell.html        # 壳框架（左 nav + 占位视图 + 状态区）
│   │   ├── settings.html     # 设置页（独立 window）
│   │   ├── kanban.js         # 看板 UI（M2 原生 JS）
│   │   └── kanban.css        # 看板主题样式
│   ├── window/               # 窗口与 WebContentsView
│   │   ├── WindowManager.ts  # 主窗口 + 官方 UI view + 占位视图切换
│   │   └── getViewBounds.ts  # view 边界计算
│   ├── kanban/               # M2 看板数据层
│   │   ├── KanbanStore.ts    # boards.json 原子写 + 16 IPC + CON-R017
│   │   ├── KanbanTransfer.ts # B5 导出导入薄层（文件 IO + 对话框）
│   │   ├── KanbanIpc.ts      # main 侧 IPC 注册
│   │   ├── types.ts          # Board/Task/Column/Comment JSON Schema 镜像
│   │   └── *.test.ts         # co-located 单测
│   ├── exec/                 # M2 执行引擎
│   │   ├── ExecutionEngine.ts    # 门面（编排 Scheduler/Heartbeat/Convergence/VerifyGate）
│   │   ├── scheduler/            # Scheduler（单飞循环 + 原子结算段 + 并行≤3）
│   │   ├── state-machine/        # 8 态执行态 + Verify/Done 双轨
│   │   ├── heartbeat/            # 活动心跳（CON-R032 30min 超时）
│   │   ├── Convergence.ts        # 壳重启收敛（running/paused/interrupted→failed）
│   │   ├── VerifyGate.ts         # confirmVerify/manualComplete/selfCheck
│   │   ├── approval/             # ApprovalManager + AcEditor（CON-R018 AC 修订 + P1-B4-1 主进程计时）
│   │   ├── provider/             # ExecutionProvider 抽象 + MockProvider + ACPProvider + JsonRpcClient + ProviderManager + ProviderRegistry
│   │   ├── ipc/ExecIpc.ts        # 10 执行控制 IPC + 推送链
│   │   ├── errors.ts             # KANBAN_EXEC_ERROR kebab 集合
│   │   └── *.test.ts             # co-located 单测
│   ├── updater/              # dsh 升级（npm overlay + 原子 staging/替换/回滚）
│   ├── runtime/              # dsh 子进程管理（spawnArgs/单实例/ReadinessProbe）
│   ├── overlay/              # dsh overlay 安装流
│   ├── channel/              # IPC 桥
│   ├── tray/                 # 系统托盘
│   ├── settings/             # 设置持久化（settings.json schemaVersion=3）
│   ├── log/                  # 日志（hull.log + dsh-pid.log 轮转）
│   └── shared/               # 共享类型 + 错误 + IPC channel 白名单
├── tests/
│   ├── unit/                 # 隐式 co-located src/**/*.test.ts（共 467 用例）
│   ├── integration/          # tests/integration/（8 用例）
│   ├── e2e/                  # Playwright e2e（11 用例：cold-start/upgrade/install/settings/kanban）
│   └── fixtures/             # fake-dsh.js + fake-registry.js（隔离外部依赖）
├── scripts/                  # verify-acceptance.mjs / fetch-node.mjs
├── docs/                     # 共识/契约/设计/记录/经验
│   ├── spec/                 # 共识 + 变更摘要
│   ├── api/                  # 契约（feishu-<story>-m<n>-api-contract.md）
│   ├── design/               # 技术方案（frozen doc）
│   ├── records/              # 实现/核验记录
│   └── lessons/              # 经验沉淀
├── package.json
├── tsconfig.json
├── tsconfig.tests.json
├── playwright.config.ts
├── electron-builder.yml
├── .github/workflows/release.yml
└── README.md / README.en.md
```

## 4. 模块职责深入

### 核心里 4 个模块（深入版）

#### src/main/index.ts — 启动编排

**M1 启动流（顺序）：**

1. 单实例锁（防多开）
2. `cleanupStaleDsh`（清理残留 dsh 子进程）
3. overlay 安装（如缺 dsh）
4. 窗口创建（WindowManager → 壳框架 + 官方 UI view）
5. IPC 装配
6. 双升级（dsh npm overlay 升级 + Hull 自更新两条独立通道）

**M2 增量装配：**

- `KanbanStore` 装配（看板数据层）
- `registerKanbanIpc`（16 看板原语）
- `ExecIpc` 装配（10 执行控制通道 + 推送链）
- `ExecutionEngine` + `ApprovalManager` + `ProviderRegistry` 装配
- **ACP → ApprovalManager 桥**：dsh ACP 子进程把审批请求桥接到主进程 ApprovalManager

**退出编排：** 双 flag —— `quitting`（开始退出）/ `quitProceeding`（退出流程进行中），防止重复触发清理。

#### src/exec/ExecutionEngine.ts — M2 核心门面

实现组合（都实现对应 Mutations 接口）：

- **SchedulerMutations** — 调度写操作
- **Heartbeat** — 活动心跳（CON-R032 30min 超时）
- **Convergence** — 壳重启收敛
- **VerifyGateMutations** — 核验门

**公开入口：** `executeTask` / `cancel` / `pause` / `resume` / `manualComplete` / `confirmVerify` / `getExecutionSnapshot`。

**桥接口：** `extend`（延期）/ `respondApproval`（审批响应）/ `interruptExecution`（打断执行）——把外部触发（ACP 桥、审批结果、UI）转进执行引擎。

**执行态写直接 flush**：状态变更立即落盘，不攒批。

#### src/kanban/KanbanStore.ts — M1+M2 数据层

- **boards.json**：`schemaVersion=1`，单文件原子写，守住 CON-R017（用户数据在 DSH_HOME，壳只写自己的文件）
- **公开 16 IPC**：覆盖 CON-R017~R033 全套看板原语（CRUD board/task/column/comment 等）
- **B5 扩展**：`exportSnapshot` / `importData`（导出导入，文件 IO + 对话框）
- **B3 系统字段直写接口**：执行引擎状态（pending/running/done 等）直接写入任务系统字段

#### src/preload/index.ts — contextBridge 三桥

- **window.hull / window.kanban / window.exec** 三桥，沙箱兼容
- **D5 注记**：白名单固定，不透传任意通道（安全边界）
- **S8 壳框架桥**：壳页导航/状态访问
- **M2 增量**：B1 看板 16 原语 + B5 2 原语（export/import）+ B3 执行控制 10 通道 + 4 订阅（状态推送）

### 其他模块（简略）

| 模块 | 职责 |
|---|---|
| `preload/settings.ts` | 设置页独立桥，仅 settingsWindow 挂载 |
| `window/` | 主窗口 + WebContentsView 编排（壳框架占位视图切换、view 边界计算） |
| `updater/` | dsh npm overlay 升级 + 原子 staging/替换/回滚 |
| `runtime/` | dsh 子进程 spawn/就绪探测（ReadinessProbe）/单实例 |
| `overlay/` | dsh overlay 安装流 |
| `channel/` | 主↔渲染 IPC 通道 |
| `tray/` | 系统托盘控制器 |
| `settings/` | settings.json 持久化（schemaVersion=3） |
| `log/` | hull.log + dsh-pid.log 轮转 |
| `shared/` | 共享类型 + 错误 + IPC channel 白名单 |

## 5. 测试纪律

| 层级 | 框架 | 位置 / 编译目标 | 数量 |
|---|---|---|---|
| 单测 | `node:test` | co-located `src/**/*.test.ts` → `dist/` | 467 |
| 集成 | `node:test` | `tests/integration/` → `tsconfig.tests.json` → `dist-tests/` | 8 |
| e2e | Playwright | `tests/e2e/` → `playwright.config.ts`（workers=1 串行） | 11 |

**TDD 要求：** 先测试后实现。状态机、调度、心跳、收敛、核验门等非平凡逻辑必须测试先行。

**实现纪律管道：** TDD 核心路径 → lint → code review → Semgrep → 留痕（`docs/records/`）→ 交付核验。

## 6. e2e 测试钩子与环境变量

```
HULL_USER_DATA=/tmp/test-userdata   # 隔离临时 userData（CON-R002 精神）
HULL_E2E=1                         # 暴露 globalThis.__hullTest 钩子
FAKE_DSH_MODE=ready                # fake dsh 跳过真实安装直接 ready
HULL_REGISTRY=https://...         # 自定义 npm registry
```

**e2e 隔离模式：**

- `src/preload/index.ts` + `tests/fixtures/fake-dsh.js` 隔离真实 dsh（fake overlay 结构对齐真实 npm 安装）
- `HULL_USER_DATA` 指向临时目录，避免污染真实 userData
- `HULL_E2E` 生产空载、测试专用（Playwright 兜底断言）
- `FAKE_DSH_MODE=ready` 跳过真实 npm install，即时 ready
- **workers=1 串行**（共享 npm 缓存 + 端口，避免冲突）

## 7. 调试技巧

- **类型检查：** `npm run typecheck`（tsc --noEmit 干净检查）
- **端口/缓存冲突清理：** `rm -rf node_modules dist*`
- **e2e 失败定位：** 看 `test-results/` + `trace.zip`
- **主进程日志：** `$HULL_USER_DATA/logs/hull.log` + `dsh-<pid>.log`
- **Playwright 主窗口定位：** S8 重构后官方 UI 在 WebContentsView（独立 webContents），壳页按 `shell.html` URL 定位，官方 UI 按 `http://127.0.0.1:` 前缀定位
- **e2e R2 兜底：** `globalThis.__hullTest.officialView()` 直接拿 view 状态（url/visible）断言，绕过 Playwright 对 WebContentsView 的探测限制

## 8. 团队工作流入口

项目已接入 [ai-workflow-skills](https://github.com/phper666/ai-workflow-skills) 团队研发工作流：

| 产物 | 路径 |
|---|---|
| 共识文档 | `docs/spec/共识-Hull桌面壳-M*.md` |
| 规则索引 | `docs/spec/规则索引.md`（CON-R001~R033） |
| 变更摘要 | `docs/spec/变更摘要*.md`（L1/L2/L3 三层） |
| 契约 | `docs/api/feishu-*.md` |
| 设计 | `docs/design/<id>-<module>-design.md`（frozen 后才进实现） |
| 记录 | `docs/records/M*/S*-record.md`（实现/核验） |
| 经验 | `docs/lessons/*.md`（沉淀） |

## 9. 项目红线（CON-R001~R005）

| # | 红线 | 一句话 |
|---|---|---|
| CON-R001 | 永不 fork/patch/替换 dsh 及官方 Web UI | 官方每次升级当天自动生效 |
| CON-R002 | 永不重写 DSH_HOME 用户数据 | 壳只写自己的文件（如 boards.json） |
| CON-R003 | dsh 升级与壳自更新两条独立通道 | 互不阻塞 |
| CON-R004 | 壳内功能走官方扩展点（`--patch` / dsh.client） | 壳原生功能住主进程，dsh 内功能走官方扩展点 |
| CON-R005 | 升级原子性 staging→替换→回滚 | 失败可回滚，不破坏 dsh |
