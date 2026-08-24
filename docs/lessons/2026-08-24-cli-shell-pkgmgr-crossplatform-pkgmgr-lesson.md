# 套壳 CLI agent：包管理器选型 + spawn 跨平台（npm reify 慢 / .bin shim）

| 项 | 内容 |
|:---|:-----|
| 背景 | Hull 桌面壳内嵌 DeepSeek dsh（npm CLI agent），首装 npm install 453 包耗时 28 分钟；用户终端装快，壳慢。需提升首装体验 + 适配三端（macOS/Windows/Linux）。 |
| 决策或坑 | ① **npm 慢是机制性**（reify 逐包串行解压写盘），冷装 28min、热 cache（2.7G）+ `--no-audit --no-fund --prefer-offline` 也 >5min——优化参数救不了，换包管理器才是本质提速。实测冷装：pnpm 28s / yarn 44s / bun 11s（都靠 store/cache 复用或并行，快数十倍）。② **套壳 spawn CLI 跨平台不能依赖 .bin shim**——npm/yarn 默认生成 symlink→JS（node 能跑），pnpm 默认 bash shim（node 报 SyntaxError），Windows 全生成 .cmd（node 跑不了）。正解：createRequire.resolve 包 package.json → bin 字段解析真实 JS 入口 + process.execPath/捆绑 node + ELECTRON_RUN_AS_NODE=1 + 剥离 NODE_OPTIONS/ELECTRON_* env。 |
| 影响 | 不换包管理器：首装 28 分钟劝退用户。不绕 .bin：pnpm 装出的 dsh 壳 spawn 直接挂（SyntaxError），Windows 全平台不可用。 |
| 适用范围 | 任何 Electron 壳内嵌 npm CLI agent / CLI 工具的产品；首装慢 + 跨平台打包的场景。不适用纯库、无 spawn CLI 的项目。 |
| 来源 | 出生：pkgmgr 需求（2026-08-24，docs/spec/共识-Hull桌面壳-包管理器.md + docs/design/P1-包管理器-pkgmgr-design.md）；引用：CON-R-pkgmgr-001~008、spawnArgs.dshEntryPath、pkgMgr/ 三实现；社区验证（claude_status_dashboard PR#66 / lobehub / VS Code 跑 Claude Code）。 |
| 引用 | 首次引用：本 lesson 出生（2026-08-24）。自证：90 天内除本行外零新增引用 → 删除候选。 |

## 教训（可复用规则）

1. **npm install 慢先测冷热 cache**：若热 cache 也慢（>5min 对几百包）→ 是 reify 机制问题，优化参数无效，换 pnpm/yarn/bun 才是根治。
2. **套壳 spawn CLI 一律解析真实 JS 入口**（createRequire.resolve + bin 字段），不碰 `.bin` shim——一次解决 npm/pnpm/yarn + Windows/Linux/macOS 全兼容。
3. **spawn 子进程 env 必须剥离 NODE_OPTIONS/ELECTRON_***（Electron 环境变量会 break 子进程），注入 ELECTRON_RUN_AS_NODE=1。
4. **pnpm 默认 .bin 是 bash shim**（POSIX），需 `prefer-symlinked-executables=true`；yarn/npm 默认 symlink。跨平台判断以实测为准。
5. **pnpm/yarn 装 CLI 的原生依赖**（node-pty/koffi 等）可能被跳过 build scripts（pnpm 11 ERR_PNPM_IGNORED_BUILDS）——需显式 rebuild，否则功能缺失。
