# corepack 打包环境 127：`#!/usr/bin/env node` shebang 在无 PATH node 环境找不到解释器

| 项 | 内容 |
|:---|:-----|
| 背景 | Hull 桌面壳（Electron + 捆绑 node + corepack 托管 pnpm）首次安装 dsh 时报 `pnpm 非零退出（code=127）`。dev 模式正常，打包后必现。 |
| 决策或坑 | ① **code=127 = command not found**——pnpm 安装命令 spawn 的 corepack 可执行文件找不到。② **根因**：corepack.js 首行 `#!/usr/bin/env node`，spawn 直接执行 corepack 时系统在 PATH 找 node；**Electron 打包 app 不继承 shell PATH**（无系统 node）→ `env: node: No such file or directory` → 127。dev 模式 PATH 有系统 node（/usr/local/bin）所以正常。③ **修复**：不用 spawn(corepack) 直接执行，改用**捆绑 node 显式跑**：`spawn(nodePath, [corepackPath, 'pnpm@<ver>', ...])`——node 解释器显式指定，不依赖 PATH。④ **连带排查**：npm 实现同样用 nodePath 推导 npm-cli.js，首装时 node 未解压 → nodePath='node'（PATH 兜底）→ 包管理器路径全错；须首装前先解压捆绑 node（ensureBundledNode）。 |
| 影响 | 不修：打包后的 app 首次安装 dsh 必现 127，用户拿到坏壳（dev 测试发现不了——这是"本地正常、打包坏"的典型环境差异坑）。 |
| 适用范围 | 任何 Electron/Tauri 打包 app 内 spawn 依赖 `env node` shebang 的 CLI 工具（corepack、npm、各类 node 脚本）。打包环境无系统 node 时都中招。 |
| 来源 | 出生：cicd 首次安装实测（2026-08-26，v0.1.0 发布验证）；引用：CON-R-pkgmgr-002/005、corepack 机制、Electron 打包环境 PATH 行为。 |
| 引用 | 首次引用：本 lesson 出生（2026-08-26）。自证：90 天内除本行外零新增引用 → 删除候选。 |

## 教训（可复用规则）

1. **打包 app 内 spawn CLI 工具，必须显式指定解释器**：凡目标脚本 shebang 是 `#!/usr/bin/env node`（corepack/npm 等），打包环境（无 PATH node）直接 spawn 会 127。用捆绑 node 显式跑：`spawn(nodePath, [cliPath, ...])`，不依赖 PATH。
2. **"本地正常、打包坏" = 环境差异**：dev 有系统 node/PATH，打包没有。排查时先确认打包环境 PATH/资源差异，别只在 dev 复现。
3. **捆绑运行时解压要覆盖所有入口**：node 解压不能只绑定安装流程——就位（已装重启）、首装、重装都要先确保解压，否则 nodePath 回退 PATH 兜底 → 打包环境崩。
4. **code=127 排查链**：command not found → 确认 spawn 目标路径存在 → 确认目标 shebang 解释器在 PATH → 打包环境需显式指定。
