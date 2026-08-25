# Electron 桌面壳三端打包：electron-builder + 捆绑 node + GitHub 更新源

| 项 | 内容 |
|:---|:-----|
| 背景 | Hull 桌面壳（Electron 43 + 内嵌 dsh npm CLI）从 macOS-only 扩展三端（macOS/Windows/Linux）。需 electron-builder 三平台打包 + 三端捆绑 node（dsh 运行时不依赖用户 node）+ 自动更新。 |
| 决策或坑 | ① **三端捆绑 node 用 electron-builder `extraResources`**（per-platform 映射，因为 `${os}`=mac/win/linux 与 node.org darwin/win32 命名不同，需显式分平台写）；fetch-node.mjs 参数化平台下载（darwin tar.gz / linux tar.xz / **win zip 且 node.exe 在根无 bin/**——三平台 tarball 格式与目录布局全不同）。② **electron-updater owner/repo 必须与 electron-builder publish 一致**——adapter 曾写 `dsh-hull-desktop/dsh-hull-desktop`，实际 repo 是 `phper666/dsh-hull-desktop`，owner 错误会查错更新源（静默失败）。③ electron-builder 三平台 target 里 **mac 需 zip（更新专用）+ win nsis / linux AppImage**——electron-updater 各平台更新机制不同。 |
| 影响 | 不捆绑 node：dsh 首装依赖用户 node（全新环境装不了）。owner 错误：自动更新查错源静默失败。漏 zip target：mac 无法 electron-updater 更新。 |
| 适用范围 | 任何 Electron 桌面壳内嵌 CLI/服务 + 三端打包 + 自动更新的项目。不适用纯 Web、无自动更新需求的项目。 |
| 来源 | 出生：packaging 需求（2026-08-25，docs/spec/共识-Hull桌面壳-三端打包.md + docs/design/PK1-三端打包-packaging-design.md）；引用：CON-R-packaging-001~008、electron-builder.yml、extractNode.ts、fetch-node.mjs。 |
| 引用 | 首次引用：本 lesson 出生（2026-08-25）。自证：90 天内除本行外零新增引用 → 删除候选。 |

## 教训（可复用规则）

1. **三端捆绑运行时**：electron-builder `extraResources` per-platform 映射（注意 electron-builder `${os}` 与供应商 tarball 命名差异）+ 构建脚本参数化平台（各平台格式/布局不同：mac/linux tar、win zip + node.exe 根布局）。
2. **electron-updater 配置一致性**：adapter 的 `owner/repo` 必须与 electron-builder.yml `publish` 严格一致——写错会查错更新源静默失败，难排查。GitHub provider 需 package.json `repository` 字段。
3. **三平台更新 target**：mac 必须含 zip（dmg 不能用于 electron-updater）、win nsis、linux AppImage——builder 自动生成 latest 元数据。
4. **Win/Linux 打包需对应平台环境**（nsis/AppImage 不能交叉）——单平台配置先行 + 对应平台实测，不阻塞其他平台。
5. **未签名打包**（mac.identity null）Gatekeeper/SmartScreen 会警告——正式分发需签名，暂接受。
