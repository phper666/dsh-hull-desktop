# Bug 修复记录：Windows 包缺捆绑 node（fetch-node win 归档名 404 + CI 静默吞失败）

> 日期：2026-08-31 · 类型：Bug（散任务，轻量管道） · 关联规则：CON-R-packaging-003/007/008（语义不变）

## 判级

- **常规**（单文件脚本修复 + CI step 加 shell 标注；无架构/契约变更；非安全敏感）→ 轻量实现管道（lint 跳过——项目无 lint 脚本）

## 现象

Windows（portable/Setup 均复现）首装 dsh 报错：

```
[warn] 捆绑 node 解压失败（PATH 兜底）: 打包 node 资源缺失: C:\Users\<user>\AppData\Local\Temp\<random>\resources\node
```

dsh 无法安装（打包环境无 PATH node 兜底可用）。

## 根因（双 bug 链）

1. **fetch-node.mjs 归档名写错**：平台标识 `win32-x64` 直接拼进官方 dist URL → `node-v24.10.0-win32-x64.zip` → **HTTP 404**。Node 官方命名是 `win-x64`（`win32-x64` 是本仓库平台标识，非官方归档名；实测 curl 404 vs `win-x64` 200）。
2. **CI 静默吞失败（掩盖层）**：windows runner `run:` 默认 PowerShell，node 脚本 exit 1 **不 fail step** → fetch-node 404 被吞，step 显示 success。
3. **electron-builder 静默跳过（第三层）**：extraResources 源缺失时 `copyFiles()` 仅 `log.warn('file source doesn't exist')` 后 return，不报错 → 打包照样成功。

## 影响

- **v0.1.0 ~ v0.1.6 全部 win 包（portable + Setup）均无捆绑 node**（实测下载 v0.1.6 两包解析 7z payload：78 条目、0 node 条目、resources/ 仅 app-update.yml+app.asar+elevate.exe；mac/linux 包正常含 node）
- 已装 ≤0.1.6 的 Windows 用户无法装 dsh；需升级到修复版

## 修复（2 文件）

| 文件 | 变更 |
|:-----|:-----|
| scripts/fetch-node.mjs | 平台注册表加 `dist` 字段（官方 dist 名：win=`win-x64`）；下载 URL + 解压内层目录用 `spec.dist`；vendor 目录名保持 `win32-x64`（electron-builder.yml 引用零改动）；补 `mv` status 检查（此前无检查，残缺产物会蒙混） |
| .github/workflows/release.yml | Fetch bundled Node step 加 `shell: bash`——windows 默认 PowerShell 不 fail 非零退出，此为掩盖层，不修下次又静默发坏包 |

## 验证

| 项 | 结果 |
|:---|:-----|
| fetch-node win32 端到端（mac 本地） | ✅ 下载+SHA256 校验通过，产出 vendor/node-24.10.0-win32-x64/node.exe + node-version.txt |
| electron-builder extraResources 源解析 | ✅ 源存在 + node.exe + node-version.txt（electron-builder copyFiles 不再静默跳过） |
| typecheck | ✅ tsc --noEmit 无错 |
| unit/integration | ✅ 全绿（8/8 runtime + 既有 645） |
| lint | ⚠️ 项目无 lint 脚本，跳过（风险项记录） |
| 本地 win 打包 | ⚠️ electron 下载 ETIMEDOUT（网络，非修复问题）；CI 有网络会正常走 |
| CI 端到端 | ⏳ 待下次发布验证（发布后抽查 win 包 payload 含 resources/node） |

## 遗留/跟进

1. **v0.1.7 发布前**：直接发 CI 版本即可（修复已合入则 win 包带 node）；发布后抽查产物确认
2. 已发布 v0.1.0~0.1.6 win 包永久损坏，release notes 建议标注
3. 防复发候选（未做，待拍板）：electron-builder afterPack 钩子校验 win 包 resources/node 存在性（打包门禁）

## 连带修复：Windows 验证会话（2026-08-31 同日）

Windows 实测连带发现并修复 **pkgMgr 跨平台缺陷**（另一独立 bug，非本 bug 部分）：

- 现象：dev 环境（PATH 兜底系统 node）装 dsh 报 `Cannot find module '<staging>\corepack'`
- 根因三连：① `resolveExecutablePath` 按 `:` 切 PATH（win 是 `;`）且不补 `.exe` → nodePath 保持裸 `'node'`；② 连锁致 `corepackBin()` 相对化 → cwd 下解析 MODULE_NOT_FOUND；③ corepack/npm-cli 的 JS 入口在 win 布局（node.exe 同级直挂 `node_modules/`，无 bin/lib 层）下路径不同——无扩展名 `corepack` 是 sh 脚本，node 跑不了
- 修复：`corepackBinFor`/`npmCliPathFor` 平台分支 + `resolveExecutablePath` 用 `path.delimiter` + `.exe` 候选（导出可注入）；新增 `winpaths.test.ts` 10 用例（含 POSIX 回归守卫）；yarn 已移除（v1.2），npm/pnpm 两执行器全部覆盖（rebuild/peerFixup 复用 corepackBin 源头修复）
- 验证：731/731 全绿 + typecheck 干净；Windows 端实测待用户复测
- 详见 docs/lessons/2026-08-31-pkgmgr-win-node-dist-layout-lesson.md

同会话环境排障（非代码 bug，已入 README）：Windows dev `npx electron --version` 报 extract-zip 绑定 `ERR_DLOPEN_FAILED`——真实根因 **VC++ 运行库缺失**（装 vc_redist.x64 即愈），npm#4828（删 node_modules 重装）为文件缺失时次选。

## 后续 Windows 首装全链路修复（2026-09-01，Windows 实测通过后合并入本记录）

会话从「win 包缺 node」一路追到 Windows 首装全链路，累计修复：

### 二阶段：pnpm 安装链路（dev/打包共用）

| commit | 问题 | 修复 |
|---|---|---|
| 7e219c8 | corepack 下载 pnpm 本体恒走 npmjs（国内 ConnectTimeout）——corepack 只认 COREPACK_NPM_REGISTRY 不认 npm_config_registry | install/rebuild/peerFixup 三阶段双变量透传 |
| 40201d6 | corepack 0.34+ bin 字段是 ./dist/corepack.js，bin/ 目录为空——win 入口取错 | corepackBinFor win 分支改 dist/ |
| a514aed（另会话） | registry 尾斜杠 → corepack 拼 //pnpm/ 404；**pnpm isolated 布局普通权限下用绝对 junction，swap rename 后悬空是首装必挂根因** | normalizeRegistry 剥尾斜杠；**--config.node-linker=hoisted**——hoisted 顶层依赖为真实目录，swap 后天然有效（根治，不再依赖 junction 重建） |

### 三阶段：swap/启动链路

| commit | 问题 | 修复 |
|---|---|---|
| 7c7ac59 | win32 post-swap bin symlink EPERM（无管理员/开发者模式）→ 回滚 → 安装必败 | win32 降级告警不回滚（spawn 走 dshEntryPath 真实入口不依赖 symlink） |
| 56067b7~9535115 | pnpm junction 绝对路径 → swap rename 后悬空 → dshEntryPath/插件解析 MODULE_NOT_FOUND | relinkStaleJunctions 重建（前缀改写 + 分隔符归一化 + 覆盖 .pnpm/node_modules 虚拟 store）；后续被 a514aed hoisted 根治替代为主防线 |
| fbf7cca（另会话） | swap 后重建撞 Defender 扫描窗口（EISDIR/EPERM 3~10 分钟）| swap 前预改写（target 前缀 staging→dsh）+ 指数退避 + ensureJunctions 轮询兜底 |
| e7b9dc2（另会话） | 首装快速连点并发 swap 空 staging → 空 dsh；启动失败 junction 未完成 | installRunning 防重入锁 + 启动轮询 ensureJunctions（30s×最长 6 分钟）|
| 698d1d2 | 冷启动超 60s 误判失败（Defender 拖慢）+ process.kill(-pid) Windows 无效残留进程 | ready 超时 60→180s + taskkill /T /F |

### 四阶段：UI/进度（dev/打包共用）

| commit | 问题 | 修复 |
|---|---|---|
| 695f5c6 | toast setAttribute('closable') 单参数 → 新 Chromium 抛错 | 补空串参数 |
| 6a99076 | pnpm 首装进度恒 20%（只解析 npm http fetch 行）| 双格式解析（Progress: resolved/added）|

### 最终验证

- **Windows 全新环境开箱即用：✅ 通过（2026-09-01，用户实测）**
- 738/738 单测 + typecheck 干净 + runtime/overlay 专项全绿
- 关键教训：**Windows 首装 pnpm 必须 hoisted 布局**（普通权限无 symlink/junction 安全语义），isolated 布局的绝对 junction 与 swap rename 原子替换根本冲突
