# Hull 三端打包 PRD

> 版本：v0.1 · 日期：2026-08-25 · 状态：待评审
> 需求标识：`packaging` · 归属：Hull 模块（构建/分发）

## 1. 背景

Hull 现仅支持 macOS Apple Silicon（CON-R006），无打包配置。用户明确下一步做三端（macOS/Windows/Linux）。pkgmgr 已把 spawn/依赖安装跨平台铺垫好（dshEntryPath 绕 .bin shim + ELECTRON_RUN_AS_NODE + 三端兼容），本需求落地三端打包/分发/更新。

## 2. 目标

- 三端（macOS/Windows/Linux）可打包分发安装包
- 三端自动更新（electron-updater 延续）
- 三端捆绑 node（dsh 运行时不依赖用户 node）
- 暂不签名/公证（Gatekeeper/SmartScreen 会警告，接受）

## 3. 非目标（本轮不做）

- 代码签名/公证（macOS Developer ID / Windows EV 证书）——排后
- 三端 CI 自动化——本轮手动打包验证，CI 排后
- 跨平台交叉编译（各平台原生编译）——本轮各平台原生打包

## 4. 需求详述

### FR-1 打包工具 electron-builder
- 引入 electron-builder，配置 `electron-builder.yml`（三平台 target：mac dmg/zip、win nsis/portable、linux AppImage/deb）
- 产物：dist/ 编译 + src/renderer 静态资源 + node_modules 依赖 → 各平台安装包

### FR-2 三端 target
- macOS：dmg + zip（Apple Silicon + 可选 x64 universal）
- Windows：nsis（安装）+ portable（便携）
- Linux：AppImage + deb

### FR-3 捆绑 node（dsh 运行时）
- 三端包内随壳捆绑 node（复用 fetch-node.mjs 机制，按平台下载对应 node）
- 打包时把 node 放进 app 资源目录，首装 dsh 时解压到 `<userData>/node`（现有 InstallFlow.extractNode 承接）
- dsh 安装/运行不依赖用户 node

### FR-4 自动更新（electron-updater 延续）
- 三端 build 发布到同一更新源（GitHub Releases 或私有源），electron-updater 检测下载
- 现有 HullUpdater 逻辑保持，适配三端（mac zip 更新 / win nsis / linux AppImage）

### FR-5 平台适配检查
- 三端 spawn（已由 pkgmgr P2 铺垫：dshEntryPath + ELECTRON_RUN_AS_NODE + 剥离 env）
- 三端路径/托盘/窗口差异检查（mac 菜单/win 任务栏/linux 托盘）

## 5. 验收标准（可测试）

1. macOS 打包成功（dmg + zip），安装运行正常，dsh 首装可用
2. Windows 打包成功（nsis + portable），安装运行正常，dsh 首装可用
3. Linux 打包成功（AppImage + deb），运行正常，dsh 首装可用
4. 三端捆绑 node：dsh 安装不依赖用户 node（全新环境可装）
5. 三端自动更新：新版本检测/下载/安装（electron-updater）
6. 三端 spawn dsh 正常（pkgmgr 铺垫验证）

## 6. 不做事项

- 代码签名/公证（排后）
- CI 自动化（排后）
- 跨平台交叉编译（各平台原生打包）
- 商店分发（App Store / MS Store / Snap）
