# Windows 首装 pnpm：isolated 布局绝对 junction 与原子替换根本冲突——hoisted 是正解

| 维度 | 内容 |
|:-----|:-----|
| 背景 | Hull 桌面壳 Windows 首装 dsh 全链路排查：从「win 包缺捆绑 node」一路追到「dsh 启动 MODULE_NOT_FOUND」→「插件 client-ui 加载失败」。核心冲突：pnpm 默认 isolated 布局 + swap 的 staging→dsh rename 原子替换。 |
| 决策或坑 | ① **pnpm 在 Windows 普通权限（无 symlink 权限）下用绝对路径 junction 链接依赖**（POSIX 用相对 symlink，rename 后天然有效；Windows junction 不支持相对 target）——把 staging rename 成 dsh 后**全部 junction 悬空**。② 重建 junction 又撞 **Windows Defender 实时扫描窗口**（EISDIR/EPERM 3~10 分钟）——swap 后立即重建不可靠。③ **正解 = `--config.node-linker=hoisted`**：顶层依赖变成真实目录（无 junction），rename 后天然有效，从源头消灭问题——比反复修补「重建悬空 junction」高一个量级。④ 三个掩盖层教训：corepack 只认 COREPACK_NPM_REGISTRY（不认 npm_config_registry）；corepack 0.34+ bin 指向 dist/ 而非 bin/；electron-builder 对缺失 extraResources 源只 warn 不报错。 |
| 影响 | 不修：Windows 普通用户首装 dsh 必挂（无管理员权限 + 无开发者模式）。教训：**凡「打包时用 staging + 原子 rename 替换」的跨平台方案，依赖布局必须对 rename 免疫**——Windows 优先 hoisted/真实目录布局，别赌 junction/symlink 重建。 |
| 来源 | 出生：Windows 首装验证会话（2026-09-01，docs/records/PK2-fetchnode-win404-record.md）；引用：src/overlay/pkgMgr/npmRunner.ts（--config.node-linker=hoisted）、src/overlay/relinkJunctions.ts、.github/workflows/release.yml、CON-R-pkgmgr-003 |
