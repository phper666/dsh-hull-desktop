# electron-builder 产物命名含空格：更新 feed 三端静默 404

| 项 | 内容 |
|:---|:-----|
| 背景 | Hull 壳 `productName: Dsh Hull Desktop`（含空格）。0.1.2 用户点更新下载报 `404 Cannot download .../Dsh-Hull-Desktop-0.1.4-x64-mac.zip`。排查发现 0.1.1~0.1.4 三端（mac/win/linux AppImage）更新通道全坏。 |
| 决策或坑 | 产物命名含空格时，**三条命名链各走各的分叉**：① 磁盘文件名：electron-builder 按 `artifactName` 模板原样产出（`${productName}` 经 sanitize-filename 保留空格）→ `Dsh Hull Desktop-0.1.4-x64-mac.zip`；② `latest-*.yml` 的 url/path：`computeSafeArtifactNameIfNeeded` 把空格转**连字符**（GitHub 安全名）→ `Dsh-Hull-Desktop-0.1.4-x64-mac.zip`；③ GitHub 存 release 资产：文件名空格被转成**点号** → `Dsh.Hull.Desktop-0.1.4-x64-mac.zip`。②广告名 ≠ ③资产名 → electron-updater 按 yml 下载必 404。linux deb 用 `${name}`（package.json name，无空格）幸免，暴露了根因。 |
| 影响 | 不修：所有含空格 productName 的 electron-builder + GitHub Releases 更新源项目，自动更新下载 100% 404（静默，只在点更新时暴露）。 |
| 适用范围 | 任何 electron-builder 产物名含空格 + GitHub Releases 做更新源的 Electron 应用（electron-updater / 三方更新器同源）。 |
| 来源 | 出生：0.1.2→0.1.4 更新 404 实测排查（2026-08-27）；引用：CON-R-packaging-002、electron-builder.yml artifactName、electron-builder 源码 `computeSafeArtifactNameIfNeeded`（app-builder-lib/out/platformPackager.js）。 |
| 引用 | 首次引用：本 lesson 出生（2026-08-27）。自证：90 天内除本行外零新增引用 → 删除候选。 |

## 教训（可复用规则）

1. **产物命名禁用空格**：`artifactName` 显式硬编码连字符名（`Dsh-Hull-Desktop-${version}-${arch}-mac.${ext}`），不用 `${productName}`（含空格时 yml url 转连字符、GitHub 资产转点号，三处不一致）。
2. **发版后核验更新 feed**：发布后必查 `latest-mac.yml / latest.yml / latest-linux.yml` 的 `url` 与实际 release 资产名逐字一致（脚本比对，含 sha512/size）。
3. **排查更新 404**：先对比 yml 广告 url vs release 实际资产名；发现点号/连字符差异 = 空格命名链分叉，非上传丢文件。
4. **发布 glob 白名单**：上传只列安装包/元数据扩展名（zip/dmg/exe/AppImage/deb/yml/blockmap），`release/*` 会把解包 `.app`/`*-unpacked`/捆绑 node 内容全传上去（v0.1.4 混入 200+ 垃圾资产）。
