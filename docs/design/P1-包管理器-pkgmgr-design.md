# Hull 包管理器支持技术方案

> 状态：draft（撰写中）→ 评审通过后 frozen
> 关联：共识 v1.1（docs/spec/共识-Hull桌面壳-包管理器.md）+ CON-R-pkgmgr-001~008 + PRD（docs/prd/2026-08-24-hull-pkgmgr-prd.md）

## 1. 背景与范围

- dsh 安装链路现用 npm install，冷装 453 包 28 分钟（npm reify 机制性慢，冷热都慢，已验证热 cache 也 >5min）
- 实测：pnpm 冷装 28s、yarn 冷装 44s（均快数十倍）
- 需支持三包管理器（npm/pnpm/yarn）+ 适配三端（macOS/Windows/Linux，用户下一步做三端打包）
- 子需求：P1 执行器抽象 / P2 spawn 跨平台改造 / P3 settings+设置页+rebuild

## 2. 架构决策

### 决策 1：包管理器执行器抽象（P1）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. 接口 + 三实现（选）** | `PkgMgrRunner` 接口（install/cancel/onLine 回调），npm/pnpm/yarn 三实现 | 单一注入点，main 按 settings.packageManager 选实现；现有 npmRunner 重构为 npm 实现 |
| B. 参数化单实现 | 一个 runner 用不同参数跑 | 命令/错误解析/原生依赖差异大，参数化耦合严重 |

选 A：三包管理器命令、错误格式、原生依赖处理差异显著，接口抽象最清晰。

### 决策 2：spawn 跨平台改造（P2，三端关键）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. 解析真实 JS 入口（选）** | `createRequire.resolve('@deepseek-ai/dsh/package.json')` → bin 字段 → 真实入口；`process.execPath` + `ELECTRON_RUN_AS_NODE=1` 运行；剥离 NODE_OPTIONS/ELECTRON_* | 不依赖 .bin shim（Windows .cmd 跑不了），三包管理器 + 三端全兼容（lib-3 调研：claude_status_dashboard PR#66/lobehub/VS Code 验证） |
| B. prefer-symlinked-executables | pnpm 配置让 .bin 变 symlink | 仅 POSIX 有效，Windows 仍 shim，跨平台不彻底 |

选 A：lib-3 调研确认的社区标准做法，一次性解决 Windows 问题。

### 决策 3：原生依赖自动 rebuild（P3）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. 装后自动 rebuild（选）** | pnpm：`pnpm rebuild <pkgs>`；yarn：默认跑 build scripts；npm：现状；失败告警不阻断 | 零用户干预，功能完整（koffi/node-pty 是 dsh 真实功能） |
| B. 用户确认 | 装完提示 | 额外交互，且用户不懂选什么 |

选 A：PRD FR-3 定案（自动 rebuild），失败降级提示。

### 决策 4：settings.packageManager（P3）

- 字段级扩展（对齐 theme/S6 先例）：`packageManager: 'npm' | 'pnpm' | 'yarn'`，默认 `'pnpm'`，非法值回退 pnpm
- **不 bump schemaVersion**（字段级，无破坏性迁移）
- 设置页三选一，复用 hull:setSettings + 即时生效

## 3. 模块划分

| 模块 | 职责 | 依赖 |
|:-----|:-----|:-----|
| `src/overlay/pkgMgr/`（新） | PkgMgrRunner 接口 + npm/pnpm/yarn 三实现（install 命令/错误解析/原生依赖 rebuild） | P1 |
| `src/overlay/npmRunner.ts`（重构） | 收敛为 npm 实现（或迁移到 pkgMgr/） | P1 |
| `src/runtime/spawnArgs.ts` | spawn 改造：解析真实入口（createRequire + bin 字段） | P2 |
| `src/runtime/RuntimeManager.ts` | spawn 用 process.execPath + ELECTRON_RUN_AS_NODE=1 + 剥离环境变量 | P2 |
| `src/settings/SettingsProvider.ts` | packageManager 字段（读/写/校验） | P3 |
| `src/renderer/shell.html` | 设置页包管理器三选一 UI | P3 |

依赖方向：P1（执行器抽象）→ P2（spawn 改造）→ P3（settings+设置页+rebuild）。

## 4. 关键机制

### 4.1 PkgMgrRunner 接口

```ts
interface PkgMgrRunner {
  install(stagingDir: string, targetVersion: string, opts: { onLine?: (line: string) => void; registry: string }): Promise<PkgMgrResult>;
  cancel(): void;
}
interface PkgMgrResult { ok: boolean; code?: InstallErrorCode; error?: string; }
```

- 三实现各自：spawn 命令（npm install / pnpm add / yarn add）+ 错误输出解析 + 取消杀进程树
- 错误码映射统一（registry-unreachable / npm-install-failed / cancelled 复用 InstallErrorCode）
- BE 扫描项：pnpm/yarn 错误格式不同于 npm 的 `npm error code` → 各实现自行解析网络错误码

### 4.2 取消杀进程树（BE 扫描项）

- npm：杀 spawn 的 child（现状）
- pnpm：可能 spawn store 服务子进程 → 杀进程组（`process.kill(-pid)` 或逐子进程）
- yarn：同 npm 类
- 统一：PkgMgrRunner.cancel() 各实现保证杀完整树

### 4.3 spawn 真实入口解析（P2）

```ts
// 替代 dshBinPath(overlayDir) 的 .bin 路径
const pkgJson = createRequire(join(overlayDir, 'package.json')).resolve('@deepseek-ai/dsh/package.json');
const binEntry = JSON.parse(readFileSync(pkgJson)).bin?.dsh; // → lib/bin.js
// spawn: process.execPath, [binEntry, 'web', '--no-open', ...], ELECTRON_RUN_AS_NODE=1
```

- asar 验证：打包后 `<userData>/dsh` 在 userData（非 asar），createRequire 解析外部绝对路径可行（BE 扫描项需实测验证）

### 4.4 原生依赖 rebuild（P3）

- pnpm：`pnpm rebuild koffi node-pty protobufjs @google/genai @deepseek-ai/dsh-subprocess-local`（已实测可用）
- yarn：yarn 默认跑 build scripts（无需显式 rebuild）
- npm：现状（npm 自动跑）
- 失败：告警 + 提示手动补装，不阻断安装

## 5. 工程基线

- git ✅ / 脚手架 ✅（package.json）/ 测试框架 ✅（node --test + Playwright）
- 技术栈：跟随既有 Electron + Node；pnpm/yarn 需确认生产捆绑策略（pnpm/yarn 是 node 包可随捆绑 node 分发；但需用户机器有或随壳捆绑）

## 6. 目录/工程结构

```
src/
  overlay/
    pkgMgr/           ← 新增（P1）
      types.ts        ← PkgMgrRunner 接口 + 结果类型
      npmRunner.ts    ← npm 实现（现有 npmRunner 迁移）
      pnpmRunner.ts   ← pnpm 实现
      yarnRunner.ts   ← yarn 实现
    InstallFlow.ts    ← 用 PkgMgrRunner（按 settings.packageManager 选）
  runtime/
    spawnArgs.ts      ← 解析真实入口（P2）
    RuntimeManager.ts ← ELECTRON_RUN_AS_NODE + 剥离环境变量（P2）
  settings/
    SettingsProvider.ts ← packageManager 字段（P3）
  renderer/
    shell.html          ← 设置页包管理器三选一（P3）
```

## 7. 风险与对策

| 风险 | 缓解 |
|:-----|:-----|
| pnpm/yarn 错误格式解析遗漏 | 各实现测试覆盖网络错误码场景 |
| 取消杀进程树不完整（pnpm store） | 进程组杀 + 测试验证 |
| createRequire.resolve 在 asar 打包后解析失败 | P2 单测模拟 asar 路径 + 打包实测 |
| pnpm/yarn 生产未捆绑 | 确认生产捆绑策略（随 node 目录带 pnpm/yarn） |
| 原生依赖 rebuild 失败 | 告警 + 手动补装提示，不阻断 |

## 8. 核验记录

> 交付核验时填写。

## 评审记录

> 评审通过后填。
