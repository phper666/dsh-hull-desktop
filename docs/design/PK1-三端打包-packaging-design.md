# Hull 三端打包技术方案

> 状态：draft（撰写中）→ 评审通过后 frozen
> 关联：共识 v1.1（docs/spec/共识-Hull桌面壳-三端打包.md）+ CON-R-packaging-001~008 + PRD（docs/prd/2026-08-25-hull-packaging-prd.md）

## 1. 背景与范围

- Hull 现仅 macOS Apple Silicon（CON-R006），无打包配置；用户下一步做三端（macOS/Windows/Linux）
- pkgmgr 已铺垫 spawn 跨平台（dshEntryPath 绕 .bin shim + ELECTRON_RUN_AS_NODE + 剥离 env，平台无关）
- 需落地：electron-builder 三平台 target + 三端捆绑 node + 自动更新三端
- 子需求：PK1（electron-builder 配置+打包）/ PK2（捆绑 node）/ PK3（自动更新+平台适配）

## 2. 架构决策

### 决策 1：打包工具 electron-builder（PK1）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. electron-builder（选）** | 三平台 target 配置成熟，electron-updater 已集成，发布/签名支持全 | 社区主流，配置声明式，跨平台 target 单文件 |
| B. Electron Forge | 官方但 target/发布生态弱于 builder | 多写配置 |

选 A：electron-updater 已依赖，builder 与其深度集成（自动生成 latest.yml）。

### 决策 2：捆绑 node 按平台（PK2）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. fetch-node.mjs 扩展按平台（选）** | 现硬编码 darwin-arm64；扩展为参数化平台（darwin-arm64 / win32-x64 / linux-x64），各平台 tarball 格式不同（mac/linux tar.gz、win zip/exe） | 构建期脚本，打包时按目标平台下载对应 node |
| B. electron-builder 内置 node 下载 | 不成熟，无现成机制 | 自写 |

选 A：复用现有 fetch-node.mjs 校验/解压逻辑，参数化平台。注意 win node 是 zip/exe（非 tar.gz），解压方式需分平台。

### 决策 3：node 放包内位置（PK2）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. app 资源目录（选）** | node 打包进 app.asar 旁（extraResources），首装 extractNode 从资源解压到 userData | 随壳分发，`extraResources` 不进 asar（避免解压限制） |
| B. 首次联网下载 | 三端首装时下载 node | 慢 + 依赖网络，违背「三端捆绑」 |

选 A：`extraResources` 放 node，InstallFlow.extractNode 现有逻辑从资源解压（需确认资源路径三端一致）。

### 决策 4：自动更新三端（PK3）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. electron-updater 延续（选）** | 三端 build 发同一更新源（GitHub Releases/私有），electron-updater 自动生成三平台 metadata | 现有 HullUpdater 逻辑保持，适配三端 target |
| B. 手动更新 | 仅安装包 | 失去自动更新 |

选 A：延续现有 HullUpdater；mac 用 zip（更新专用）、win 用 nsis、linux 用 AppImage（builder 自动配置）。

## 3. 模块划分

| 模块 | 职责 | 依赖 |
|:-----|:-----|:-----|
| electron-builder.yml（新） | 三平台 target / extraResources（node）/ 更新源配置 | PK1 |
| scripts/fetch-node.mjs | 参数化平台下载 node（darwin/win/linux） | PK2 |
| src/overlay/InstallFlow.ts | extractNode 从包资源解压 node（路径三端适配） | PK2 |
| src/main/index.ts | 平台差异检查（托盘/路径/菜单） | PK3 |
| electron-updater 配置 | 三端更新 target / 更新源 | PK3 |

依赖方向：PK1（electron-builder 配置）→ PK2（捆绑 node）→ PK3（自动更新+平台适配）。

## 4. 关键机制

### 4.1 electron-builder.yml 三平台（PK1）

```yaml
appId: com.dsh.hull
mac:
  target: [dmg, zip]   # zip 供 electron-updater 更新
  category: public.app-category.developer-tools
win:
  target: [nsis, portable]
nsis:
  oneClick: false
linux:
  target: [AppImage, deb]
  category: Development
extraResources:
  - from: vendor/node-<version>-<platform>   # 捆绑 node（PK2）
    to: node
publish:
  provider: generic
  url: <更新源>
```

- mac zip + win nsis + linux AppImage 为 electron-updater 更新专用 target（builder 自动生成 latest.yml）

### 4.2 fetch-node.mjs 平台参数化（PK2）

- `PLATFORM` 硬编码 → 参数（`--platform darwin-arm64|win32-x64|linux-x64`）
- 各平台 tarball：
  - darwin-arm64：`node-v<v>-darwin-arm64.tar.gz`（tar 解压）
  - linux-x64：`node-v<v>-linux-x64.tar.xz`（tar 解压）
  - win32-x64：`node-v<v>-win-x64.zip`（unzip，node.exe）
- SHASUMS256.txt 校验各平台行；解压方式按平台分支

### 4.3 extractNode 三端路径（PK2）

- node 在包内 `resources/node`（extraResources）
- InstallFlow.extractNode 从 resources 复制到 `<userData>/node`（现从 app 资源读取，需确认三端路径一致——打包后 resources 路径）
- dev 模式无打包 node → PATH 兜底（现有 resolveNodePath 已处理）

### 4.4 electron-updater 三端（PK3）

- mac：zip 更新（dmg 不用于更新）
- win：nsis（安装模式更新）
- linux：AppImage
- 更新源：GitHub Releases 或私有 generic 源；现有 HullUpdater 逻辑（check/download/install）保持，仅 target 差异

## 5. 工程基线

- git ✅ / 脚手架 ✅（package.json）/ 测试框架 ✅（node --test + Playwright）
- 技术栈：electron-builder 引入（devDependency）；node 版本锁定（fetch-node 已有 Node 24 LTS）

## 6. 目录/工程结构

```
electron-builder.yml          ← 新增（PK1 三平台 target + node 资源 + 更新源）
scripts/
  fetch-node.mjs              ← 平台参数化（PK2）
vendor/
  node-<version>-darwin-arm64/  ← mac 构建产物（现有）
  node-<version>-win-x64/       ← win 构建产物（PK2）
  node-<version>-linux-x64/     ← linux 构建产物（PK2）
src/
  overlay/InstallFlow.ts      ← extractNode 三端路径（PK2）
  main/index.ts               ← 平台差异检查（PK3）
```

## 7. 风险与对策

| 风险 | 缓解 |
|:-----|:-----|
| Windows/Linux 打包需对应环境（BE 扫描） | 各平台原生打包；单平台失败不阻塞（CON-R-packaging-007） |
| win node 是 zip/exe 非 tar.gz | fetch-node 按平台分支解压 |
| 打包后 resources 路径三端差异 | PK2 实测三端 extractNode 路径 |
| electron-updater 三端 target 配置错误 | PK3 各平台实测检测/下载/安装 |
| 未签名 Gatekeeper/SmartScreen 警告 | 接受（CON-R-packaging-005），文档提示用户 |

## 8. 核验记录

> 交付核验时填写。

## 评审记录

> 评审通过后填。
