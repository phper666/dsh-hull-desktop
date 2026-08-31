# 跨平台构建脚本：平台标识 ≠ 官方归档名 + CI 静默吞失败的三重掩盖链

| 维度 | 内容 |
|:-----|:-----|
| 背景 | Hull 桌面壳三端打包（electron-builder + fetch-node 捆绑 node）——Windows 用户首装 dsh 报「打包 node 资源缺失」，v0.1.0~0.1.6 所有 win 包（portable+Setup）静默缺失捆绑 node，mac/linux 正常。 |
| 决策或坑 | ① **平台标识 ≠ 官方归档名**——本仓库平台标识 `win32-x64` 直接拼进 Node 官方 dist URL 是错的，官方命名是 `win-x64`（`node-v24.10.0-win-x64.zip`；`win32-x64.zip` 404）。darwin/linux 恰好标识=官方名（darwin-arm64/linux-x64）所以没暴露，win 命名历史包袱（win32 是旧 API 组名）。**凡是「自造平台标识拼官方下载 URL」的脚本，标识与归档名必须显式映射，不能复用同一变量。** ② **windows CI runner `run:` 默认 PowerShell**——node 脚本 exit 1 不 fail step（bash 的 -e 语义不适用），失败被静默吞掉显示 success。跨平台 workflow 里跑「必须失败即阻断」的脚本，step 要显式 `shell: bash`。③ **electron-builder 对缺失 extraResources 源只 warn 不报错**（`copyFiles()` statOrNull→null→warn→return）——打包照样成功发布坏包。④ 三者叠加成静默链：URL 404 → CI 吞掉 → 打包跳过 → 坏包发布，7 个版本无一人发现（直到真用户在 Windows 上首装）。 |
| 影响 | 不修：Windows 用户永远装不了 dsh（PATH 兜底在打包环境无效）。教训：**发布产物完整性必须有独立校验门禁**（如 afterPack 钩子断言 resources/node 存在），不能信任「CI 绿了=产物对了」。 |
| 来源 | 出生：Bug 修复（2026-08-31，docs/records/PK2-fetchnode-win404-record.md）；引用：scripts/fetch-node.mjs、.github/workflows/release.yml、CON-R-packaging-003/008 |
