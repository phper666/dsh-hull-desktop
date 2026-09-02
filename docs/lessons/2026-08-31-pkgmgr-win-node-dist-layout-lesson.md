# pkgMgr 跨平台：node 发行版两平台布局差异——corepack/npm-cli 入口与 PATH 解析

| 维度 | 内容 |
|:-----|:-----|
| 背景 | Hull 桌面壳 pkgMgr 执行器（npm/pnpm）在 Windows dev 环境（PATH 兜底系统 node）装 dsh 报 `Cannot find module '<staging>\corepack'`——pnpm 链路 corepack 路径解析全错。mac dev 一直正常（有 vendor 捆绑 node 绝对路径）。 |
| 决策或坑 | ① **node 发行版两平台目录布局不同**：POSIX tarball 是 `bin/node` + `bin/corepack`(symlink→JS) + `lib/node_modules/`；Windows zip 是根下 `node.exe` + `node_modules/` 直挂（无 bin/lib 层）。**无扩展名的 `corepack` 在 Windows 是 sh 脚本，node 当 JS 跑不了**——真实 JS 入口在 `node_modules/corepack/bin/corepack.js`。凡「从 nodePath 推导同目录工具链路径」的逻辑必须按平台分支，不能共用一个 join。② **PATH 解析跨平台**：分隔符 win 是 `;` POSIX 是 `:`（用 `path.delimiter`）；win 下可执行文件有 `.exe` 后缀，`existsSync(join(dir,'node'))` 永远匹配不到。解析失败 → 裸 `'node'` 非绝对 → 下游 `dirname('node')='.'` → 路径相对化 → 落到 cwd 下解析（MODULE_NOT_FOUND 的真正形态）。③ **修在源头**：corepackBin 被 buildArgs/rebuild/peerFixup 三处复用，改 `corepackBinFor(nodePath, platform)` 纯函数（platform 可注入）一处修全量覆盖。 |
| 影响 | 不修：Windows 用户 dev 或打包环境装 dsh 必挂 pnpm 链路。教训：**「dev 在 mac、首发即三端」的项目，所有路径推导从第一天就该带平台参数**——mac 上绿 ≠ 跨平台对。 |
| 来源 | 出生：Windows 验证会话（2026-08-31，PK2 fetch-node 修复连带发现）；引用：src/overlay/pkgMgr/npmRunner.ts（corepackBinFor/npmCliPathFor/resolveExecutablePath）、winpaths.test.ts、CON-R-pkgmgr-002/003 |
