# Hull 桌面壳（包管理器支持）共识文档

> 版本：v1.1 · 更新：2026-08-24 · 维护者：phper666（PM） · 状态：已发布
> 数据来源：Hull PkgMgr PRD v0.1（docs/prd/2026-08-24-hull-pkgmgr-prd.md）
> 关联：新增需求（Hull 模块 dsh 安装链路）；需求标识 `pkgmgr`；B1 范围

## 1. 文档元信息

- **本版本变更**：v1.1 已发布——BE 扫描结论回写（确认定案，向后兼容）：P1/P2 验收标准补 3 项 BE 发现——① 错误码解析按包管理器适配（pnpm/yarn 错误格式不同于 npm）；② 取消杀完整进程树（pnpm/yarn 有 store/worker 子进程）；③ createRequire.resolve 在 asar/打包环境解析 <userData>/dsh 入口需验证。
- **历史变更摘要**：v1.0 首次建立——从 Hull PkgMgr PRD v0.1 提取整理为业务事实源；登记 CON-R-pkgmgr-001~008。
- **历史变更摘要**：无（新需求）。
- **状态说明**：v1.1 已发布（BE 扫描结论回写）；无未决项、无扫描待确认项。

## 2. 文档结构总览

- **覆盖**：Hull dsh 安装链路全部业务面——三包管理器（npm/pnpm/yarn）支持、设置页选择 + settings 持久化、原生依赖自动 rebuild、spawn 跨平台改造（绕开 .bin shim）、取消/错误码一致。
- **适用范围**：仅 Hull 壳 dsh 安装（dsh 首次安装 + 升级共用同一安装链路）；**不覆盖** dsh 内部、官方 UI、bun 支持。

## 3. 领域术语表

| 术语 | 定义 | 出处 |
|:-----|:-----|:-----|
| 包管理器 | 安装 dsh 依赖的工具：npm / pnpm / yarn（均 node 生态） | PRD §1 |
| packageManager | HullSettings 新字段，用户选的包管理器（默认 pnpm） | PRD FR-1 |
| .bin shim | 包管理器生成的 bin 链接；POSIX 为 symlink，Windows 为 .cmd 脚本（node 跑不了） | PRD FR-4 |
| 原生依赖 | 需编译的依赖（koffi/node-pty/protobufjs 等），build scripts 需执行 | PRD FR-3 |
| reify | npm 安装时逐包解压写盘阶段（慢点所在） | PRD §1 |
| ELECTRON_RUN_AS_NODE | Electron 以 Node 模式运行（spawn CLI 用） | PRD FR-4 |

## 4. 功能需求（PRD 提取）

### 4.1 包管理器选择（FR-1）

- 设置页新增「包管理器」选择（npm/pnpm/yarn），当前高亮，切换即时生效；
- 持久化到 settings.json（HullSettings `packageManager` 字段，默认 `pnpm`）；
- 下次安装 dsh 用所选包管理器。

### 4.2 三包管理器安装（FR-2）

- npm：现状（`npm install`，兼容回退）；
- pnpm：`pnpm add` + `prefer-symlinked-executables=true`（POSIX .bin 变 symlink，Windows 忽略）；
- yarn：`yarn add`（默认 symlink）；
- 各包管理器输出逐包进度（fetch 行）落盘 + 进度条渐进（复用 onNpmLine）。

### 4.3 原生依赖自动处理（FR-3）

- pnpm/yarn 装完自动 rebuild 原生依赖（koffi/node-pty/protobufjs/@google/genai/dsh-subprocess-local）；
- pnpm：非交互 approve-builds 或 `pnpm rebuild <pkgs>`；yarn：默认跑 build scripts；
- 失败告警不阻断安装（可手动补装）。

### 4.4 spawn 跨平台改造（FR-4，三端关键）

- 不依赖 .bin shim（Windows .bin 是 .cmd，node 跑不了）；
- spawn 解析包真实 JS 入口（`createRequire.resolve('@deepseek-ai/dsh/package.json')` → bin 字段）；
- 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`；
- 剥离 NODE_OPTIONS/ELECTRON_*（VS Code 实践）；
- 三包管理器 + 三端全兼容。

### 4.5 取消/错误码（FR-5）

- 三包管理器取消（杀子进程）语义一致；
- 错误码映射一致（registry-unreachable / npm-install-failed 复用）。

## 5. 状态

- **包管理器状态**：npm / pnpm / yarn 三选一，settings.packageManager 持久化，默认 pnpm。
- **安装状态**：installing（含进度）/ not-installed / ready，复用现有 InstallPhase。

## 6. 异常分支

- settings.packageManager 非法值 → 回退 pnpm（默认）；
- pnpm/yarn 原生依赖 rebuild 失败 → 告警不阻断，提示手动补装；
- 包管理器不可用（未装）→ 回退 npm（最兼容）；
- 所选包管理器装 dsh 失败 → 提示切其他包管理器重试。

## 7. 安全与红线

- **CON-R003 不破**：dsh 升级独立通道，不预打包 node_modules；
- **CON-R001 不破**：官方 dsh Web UI 零注入；
- spawn 改造仅解析入口 + Electron node 运行，无注入 dsh 内部。

## 8. 未决项登记

- **U-1 包管理器自动探测**：P2 排后（触发：用户要求免设置）；本轮做设置页显式选择。
- **U-2 bun 支持**：P2 排后（触发：用户要求极致速度 + 接受捆绑成本）；本轮排除。
- **U-3 包管理器升级管理**：P2 排后（触发：需统一版本）；本轮不做。

## 9. 扫描待确认项

> 本需求 v1.1 扫描完成（BE/FE/QA）：无新增 Q-items（共识 P1/P2 已覆盖方向），3 项 BE 发现回写 P1/P2 验收细化（错误码解析适配/取消进程树/asar resolve）。

## 10. 规则编号（CON-R-pkgmgr-001~008）

| 编号 | 规则 | 来源 | 当前结论 | 变更状态 |
|:-----|:-----|:-----|:---------|:---------|
| CON-R-pkgmgr-001 | 三包管理器支持（npm/pnpm/yarn），默认 pnpm，设置页选择 + settings 持久化 | PRD FR-1 | 生效 | 稳定 |
| CON-R-pkgmgr-002 | pnpm 装 dsh 用 `prefer-symlinked-executables=true`（POSIX .bin 变 symlink） | PRD FR-2 | 生效 | 稳定 |
| CON-R-pkgmgr-003 | 原生依赖（koffi/node-pty 等）自动 rebuild，失败告警不阻断 | PRD FR-3 | 生效 | 稳定 |
| CON-R-pkgmgr-004 | spawn 不依赖 .bin shim，解析包真实 JS 入口（createRequire + bin 字段） | PRD FR-4 | 生效 | 稳定 |
| CON-R-pkgmgr-005 | spawn 用 process.execPath + ELECTRON_RUN_AS_NODE=1，剥离 NODE_OPTIONS/ELECTRON_* | PRD FR-4 | 生效 | 稳定 |
| CON-R-pkgmgr-006 | 三包管理器取消安装（杀子进程）语义一致 | PRD FR-5 | 生效 | 稳定 |
| CON-R-pkgmgr-007 | 错误码映射三包管理器一致（registry-unreachable/npm-install-failed 复用） | PRD FR-5 | 生效 | 稳定 |
| CON-R-pkgmgr-008 | settings.packageManager 非法值回退 pnpm；包管理器不可用回退 npm | PRD §6 | 生效 | 稳定 |

## 11. 页面交互规范

| 页面/组件 | 角色 | 功能 | 权限 | 数据范围 |
|:----------|:-----|:-----|:-----|:---------|
| 设置页「包管理器」区块 | 用户 | 三选一选择（npm/pnpm/yarn），当前高亮，切换即时生效持久化 | 全量 | 壳全局 |

## 12. 不做事项

- bun 支持；
- 包管理器自动探测/复杂降级；
- 包管理器版本管理；
- dsh 依赖预置（node_modules 打包）——违反 CON-R003。

## 13. 依赖

- **npmRunner 抽象**：从 npm 专属改为包管理器执行器（多实现）；
- **spawn 改造**：RuntimeManager/buildSpawnArgv 解析真实入口（跨平台）；
- **settings 扩展**：packageManager 字段（字段级，不 bump schema，对齐 theme/S6 先例）；
- 复用 onNpmLine 进度 + 日志落盘机制。

## 14. 子需求清单

> 已拆解（Gate B 通过 2026-08-24）：ticket 已落 dsh-hull-desktop 清单。

| # | 子需求 | 验收标准（可测试） | 规则绑定 | 依赖 | 来源 PRD | ticket |
|:--|:-------|:-------------------|:---------|:-----|:---------|:-------|
| P1 | 包管理器执行器抽象（npm/pnpm/yarn 三实现） | 三包管理器均能装 dsh 到 staging；输出进度落盘；取消杀子进程；**错误码解析按包管理器适配**（pnpm/yarn 错误格式不同于 npm 的 `npm error code`，registry-unreachable 判定需分别处理）；**取消杀完整进程树**（pnpm/yarn 可能有 store/worker 子进程） | CON-R-pkgmgr-001/002/006/007 | 无 | PRD FR-2/FR-5 | t100086 |
| P2 | spawn 跨平台改造（解析真实入口 + Electron node） | spawn 不依赖 .bin shim；三端路径覆盖单测；dsh web 可启动；**createRequire.resolve 在 asar/打包环境可解析 <userData>/dsh 包入口**（需验证打包后路径） | CON-R-pkgmgr-004/005 | P1 | PRD FR-4 | t100087 |
| P3 | settings.packageManager + 设置页选择 + 原生依赖自动 rebuild | 设置页三选一持久化重启保持；pnpm/yarn 装完自动 rebuild 原生依赖 | CON-R-pkgmgr-001/003/008 | P1 | PRD FR-1/FR-3 | t100088 |

## 15. 附录

### 15.1 关联

- PRD（docs/prd/2026-08-24-hull-pkgmgr-prd.md）、规则索引（docs/spec/规则索引.md）、M1 共识（docs/spec/共识-Hull桌面壳-M1.md，CON-R001/003/006 引用）。

### 15.2 版本记录

| 版本 | 日期 | 变更摘要条目 | 说明 |
|:-----|:-----|:-------------|:-----|
| v1.1 | 2026-08-24 | 已登记（已发布） | BE 扫描结论回写：P1/P2 验收补 3 项（错误码按包管理器适配/取消杀进程树/asar resolve 验证） |
| v1.0 | 2026-08-24 | 已登记（已发布） | 首次建立：从 Hull PkgMgr PRD v0.1 提取；登记 CON-R-pkgmgr-001~008、U-1~U-3 |

### 15.3 后续规划

> 记录本轮明确排除/未决项，供后续承接。

| 项 | 状态 | 说明 |
|:---|:-----|:-----|
| 包管理器自动探测 | 排后（U-1） | 免设置自动选，触发条件未到 |
| bun 支持 | 排后（U-2） | 需接受捆绑二进制成本 |
| 包管理器升级管理 | 排后（U-3） | 需统一版本策略 |
