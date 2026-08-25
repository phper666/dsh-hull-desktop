# pnpm 装 dsh 缺 peer deps：传递依赖的 peer 不自动装，dsh 启动 ERR_MODULE_NOT_FOUND

| 项 | 内容 |
|:---|:-----|
| 背景 | Hull 桌面壳用 pnpm 装 dsh（@deepseek-ai/dsh）。装完后壳启动 dsh 报 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis-plugin-group'`，dsh web 起不来。 |
| 决策或坑 | ① **pnpm 默认不装 peer deps**（`auto-install-peers=false`）——直接依赖的 peer 也只在配置后才装。② **传递依赖的 peer 更坑**：`dsh-app-boot`（是 dsh 的依赖，非顶层）声明 9 个 peer（cordis-plugin-group / cordis-plugin-loader / dsh-launch-environment / dsh-invariants / cordis-plugin-hmr / cordis-plugin-include / dsh-home-paths / dsh-system-prompt / cordis），这些 peer 需要链接到顶层 `node_modules/@deepseek-ai/` 才能被 import 到——**pnpm 的 `auto-install-peers=true` 对传递依赖的 peer 不生效**（实测：即使 .npmrc 配了 + 清 lockfile 重装，9 个 peer 顶层仍无链接）。③ **根治 = 显式 add**：读 dsh-app-boot 的 peerDependencies，顶层缺失的显式 `pnpm add <name>@<versionRange>`——实测全部链接 + dsh 启动成功。 |
| 影响 | 不修：pnpm 装的 dsh 永远启动失败（ERR_MODULE_NOT_FOUND），用户拿到的是坏壳。auto-install-peers 单独不足以解决传递依赖 peer。 |
| 适用范围 | 任何用 pnpm 安装"含 peer deps 的传递依赖包"的桌面壳/CLI 环境。尤其包装官方 CLI（peer 由依赖声明但不自动装）的项目。 |
| 来源 | 出生：cicd 首次实测（2026-08-26，dsh 启动错误排查）；引用：CON-R-pkgmgr-002/003、pnpm auto-install-peers 文档、dsh-app-boot package.json peerDependencies。 |
| 引用 | 首次引用：本 lesson 出生（2026-08-26）。自证：90 天内除本行外零新增引用 → 删除候选。 |

## 教训（可复用规则）

1. **pnpm 装含 peer 的包 → 装后显式校验 peer**：读被装包依赖的 peerDependencies，检查顶层 node_modules 存在性，缺则 `pnpm add <name>@<range>` 显式补装。
2. **auto-install-peers 对传递依赖 peer 无效**：.npmrc 配 `auto-install-peers=true` 只对直接依赖的 peer 生效；传递依赖（A 依赖 B，B 的 peer）仍需显式 add。
3. **peer 缺失症状**：包启动报 `ERR_MODULE_NOT_FOUND: Cannot find package '<peer>'`——先查是 peer 而非普通依赖（看报错包的 peerDependencies）。
4. **peer fixup 要按版本锁**：显式 add 用包声明的 versionRange（^1.0.1 等），不装 latest（可能不匹配）。
