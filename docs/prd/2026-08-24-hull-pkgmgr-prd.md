# Hull 包管理器支持 PRD

> 版本：v0.1 · 日期：2026-08-24 · 状态：待评审
> 需求标识：`pkgmgr` · 归属：Hull 模块（dsh 安装链路）

## 1. 背景

壳安装 dsh 目前用 npm install，冷装 453 包耗时 28 分钟（npm 串行 reify 机制性慢，冷热都慢）。实测 pnpm 冷装 28s。需支持两包管理器（npm/pnpm）提升首装体验，并适配三端（macOS/Windows/Linux）。

## 2. 目标

- 壳支持 npm / pnpm 两种包管理器安装 dsh
- 默认 pnpm（冷装最快），设置页可切换，持久化 settings
- 三端（macOS/Windows/Linux）均可用（spawn 绕开 .bin shim）
- 原生依赖（koffi/node-pty 等）自动处理 build scripts

## 3. 非目标（本轮不做）

- bun（非 node 生态，需捆绑二进制，本轮排除）
- 包管理器自身的升级管理
- 自动探测/降级复杂策略（本轮做设置页显式选择）

## 4. 需求详述

### FR-1 包管理器选择
- 设置页新增「包管理器」选择（npm / pnpm），当前高亮，切换即时生效
- 持久化到 settings.json（HullSettings 新增 `packageManager` 字段，默认 `pnpm`）
- 下次安装 dsh 时用所选包管理器

### FR-2 两包管理器安装
- npm：现状逻辑（`npm install`，保留为兼容回退）
- pnpm：`pnpm add` + `prefer-symlinked-executables=true`（POSIX 下 .bin 变 symlink，Windows 忽略）
- 各包管理器输出逐包进度（fetch 行）落盘 + 进度条渐进（复用现有 onNpmLine 机制）

### FR-3 原生依赖自动处理
- pnpm 装完自动 rebuild 原生依赖（koffi/node-pty/protobufjs/@google/genai/dsh-subprocess-local）
- pnpm：非交互 `pnpm rebuild <pkgs>`
- 失败告警不阻断安装（降级提示，可手动补装）

### FR-4 spawn 跨平台改造（三端关键）
- 不依赖 `.bin` shim（Windows 下 .bin 是 .cmd，node 跑不了）
- spawn 时解析包真实 JS 入口（`createRequire.resolve('@deepseek-ai/dsh/package.json')` → bin 字段）
- 用 `process.execPath`（Electron 自带 node）+ `ELECTRON_RUN_AS_NODE=1`
- 剥离 NODE_OPTIONS/ELECTRON_* 环境变量（VS Code 实践）
- 两包管理器 + 三端全兼容

### FR-5 取消/错误码
- 两包管理器取消安装（杀子进程）语义一致
- 错误码映射一致（registry-unreachable / npm-install-failed 等复用）

## 5. 验收标准（可测试）

1. 设置页包管理器选择出现，默认 pnpm 高亮，可切 npm，持久化重启保持
2. pnpm 装 dsh 冷装成功（~30s），dsh web 可启动
3. npm 装 dsh 兼容回退（保留现状能力）
5. 原生依赖（koffi/node-pty）装后编译可用（rebuild 自动执行）
6. 三端 spawn：不依赖 .bin shim，解析真实入口；单测覆盖路径
7. 取消安装三包管理器都生效（杀子进程）
8. 错误码映射三包管理器一致

## 6. 不做事项

- bun 支持
- 包管理器自动探测/复杂降级
- 包管理器版本管理
- dsh 依赖预置（node_modules 打包）——违反 CON-R003 独立升级红线
