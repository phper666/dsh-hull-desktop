# Hull 桌面壳（三端打包）共识文档

> 版本：v1.1 · 更新：2026-08-25 · 维护者：phper666（PM） · 状态：已发布
> 数据来源：Hull Packaging PRD v0.1（docs/prd/2026-08-25-hull-packaging-prd.md）
> 关联：新增需求（Hull 模块构建/分发）；需求标识 `packaging`；B1 范围

## 1. 文档元信息

- **本版本变更**：v1.1 已发布——BE 扫描结论回写（确认定案，向后兼容）：PK1/PK2/PK3 验收补 3 项 BE 发现——① Windows 打包需 Windows 环境（nsis 不能 mac 交叉）；② fetch-node.mjs 扩展按平台下载 node（现只 darwin-arm64，win 需 zip/exe、linux 需 tar.xz，格式不同）；③ electron-updater 三端更新机制差异（mac zip / win nsis 配置不同）。
- **历史变更摘要**：v1.0 首次建立——从 Hull Packaging PRD v0.1 提取整理为业务事实源；登记 CON-R-packaging-001~008。
- **历史变更摘要**：无（新需求）。
- **状态说明**：v1.1 已发布（BE 扫描结论回写）；无未决项、无扫描待确认项。

## 2. 文档结构总览

- **覆盖**：Hull 三端打包全部业务面——electron-builder 打包、三平台 target（mac dmg/zip、win nsis/portable、linux AppImage/deb）、捆绑 node（dsh 运行时）、自动更新（electron-updater 延续）、平台适配（spawn/路径/托盘）。
- **适用范围**：仅 Hull 壳的构建/分发；**不覆盖** 代码签名/公证（排后）、CI 自动化（排后）、商店分发、dsh 内部。

## 3. 领域术语表

| 术语 | 定义 | 出处 |
|:-----|:-----|:-----|
| electron-builder | 跨平台打包工具（三平台 target/签名/发布配置） | PRD FR-1 |
| dmg / zip | macOS 安装包格式（dmg 分发 + zip 更新） | PRD FR-2 |
| nsis / portable | Windows 安装包（nsis 安装 + portable 便携） | PRD FR-2 |
| AppImage / deb | Linux 包（AppImage 免安装 + deb 发行版） | PRD FR-2 |
| 捆绑 node | 三端包内随壳捆绑 node（fetch-node 机制），dsh 不依赖用户 node | PRD FR-3 |
| electron-updater | 自动更新库（三端 build 发到同一更新源） | PRD FR-4 |

## 4. 功能需求（PRD 提取）

### 4.1 打包工具 electron-builder（FR-1）

- 引入 electron-builder，配置 `electron-builder.yml`（三平台 target）；
- 产物：dist/ 编译 + src/renderer 静态资源 + node_modules 依赖 → 各平台安装包。

### 4.2 三端 target（FR-2）

- macOS：dmg + zip（Apple Silicon，可选 universal）；
- Windows：nsis（安装）+ portable（便携）；
- Linux：AppImage + deb。

### 4.3 捆绑 node（FR-3，dsh 运行时）

- 三端包内随壳捆绑 node（复用 fetch-node.mjs 机制，按平台下载对应 node）；
- 打包时 node 放 app 资源目录，首装 dsh 时解压到 `<userData>/node`（InstallFlow.extractNode 承接）；
- dsh 安装/运行不依赖用户 node。

### 4.4 自动更新（FR-4，electron-updater 延续）

- 三端 build 发布到同一更新源（GitHub Releases 或私有源），electron-updater 检测下载；
- 现有 HullUpdater 逻辑保持，适配三端（mac zip / win nsis / linux AppImage）。

### 4.5 平台适配检查（FR-5）

- 三端 spawn（pkgmgr P2 已铺垫：dshEntryPath + ELECTRON_RUN_AS_NODE + 剥离 env）；
- 三端路径/托盘/窗口差异检查（mac 菜单 / win 任务栏 / linux 托盘）。

## 5. 状态

- **平台状态**：macOS（现有）→ Windows / Linux 新增，三端目标均出包。
- **打包状态**：electron-builder 三平台 target 配置 + 捆绑 node + 自动更新。

## 6. 异常分支

- 某平台打包失败（原生依赖/路径差异）→ 单独平台可出包，不阻塞其他平台；
- 捆绑 node 下载失败（平台无对应 node）→ 回退用户 node（PATH 兜底，现有 resolveNodePath 逻辑）；
- 自动更新源不可达 → 手动安装兜底（不阻塞）。

## 7. 安全与红线

- **CON-R001 不破**：官方 dsh Web UI 零注入（打包不改官方 UI）；
- **CON-R003 不破**：dsh 升级独立通道（打包不预置 dsh node_modules）；
- **CON-R006 修订**：平台范围从「仅 macOS」扩展为「三端」（本需求核心变更，升 CON-R006 语义）。

## 8. 未决项登记

- **U-1 代码签名/公证**：P2 排后（触发：正式分发需求 + 证书成本）；本轮暂不签名。
- **U-2 CI 自动化**：P2 排后（触发：发布频率提升）；本轮手动打包。
- **U-3 商店分发**：P2 排后（触发：商店渠道需求）；本轮自有渠道。

## 9. 扫描待确认项

> 本需求 v1.1 扫描完成（BE/FE/QA）：无新增 Q-items（共识 PK1~PK3 已覆盖方向），3 项 BE 发现回写 PK1~PK3 验收细化（Windows 打包环境/fetch-node 按平台/electron-updater 三端差异）。

## 10. 规则编号（CON-R-packaging-001~008）

| 编号 | 规则 | 来源 | 当前结论 | 变更状态 |
|:-----|:-----|:-----|:---------|:---------|
| CON-R-packaging-001 | 打包工具 = electron-builder，配置 electron-builder.yml 三平台 target | PRD FR-1 | 生效 | 稳定 |
| CON-R-packaging-002 | macOS = dmg+zip（Apple Silicon）；Windows = nsis+portable；Linux = AppImage+deb | PRD FR-2 | 生效 | 稳定 |
| CON-R-packaging-003 | 三端捆绑 node（fetch-node 机制按平台），dsh 不依赖用户 node | PRD FR-3 | 生效 | 稳定 |
| CON-R-packaging-004 | 自动更新 = electron-updater 延续，三端发同一更新源 | PRD FR-4 | 生效 | 稳定 |
| CON-R-packaging-005 | 暂不签名/公证（Gatekeeper/SmartScreen 警告接受） | PRD §3 | 生效 | 稳定 |
| CON-R-packaging-006 | CON-R006 平台范围扩展：macOS → 三端 | PRD §7 | 生效 | 稳定 |
| CON-R-packaging-007 | 单平台打包失败不阻塞其他平台 | PRD §6 | 生效 | 稳定 |
| CON-R-packaging-008 | 捆绑 node 失败回退用户 node（PATH 兜底） | PRD §6 | 生效 | 稳定 |

## 11. 页面交互规范

> 本需求为构建/分发层，无新增用户可见 UI（打包配置 + 分发通道）。安装包安装后交互沿用现有壳。

## 12. 不做事项

- 代码签名/公证（U-1 排后）；
- CI 自动化（U-2 排后）；
- 跨平台交叉编译（各平台原生打包）；
- 商店分发（App Store / MS Store / Snap）；
- dsh 依赖预置（node_modules 打包）——违反 CON-R003。

## 13. 依赖

- **electron-builder** 引入（devDependency + 配置）；
- **fetch-node.mjs 扩展**：按平台下载 node（win/linux 新增）；
- **pkgmgr 铺垫**：spawn 跨平台（dshEntryPath + ELECTRON_RUN_AS_NODE）已就绪；
- **electron-updater** 已依赖（现有 HullUpdater）。

## 14. 子需求清单

> 已拆解（Gate B 通过 2026-08-25）：ticket 已落 dsh-hull-desktop 清单。

| # | 子需求 | 验收标准（可测试） | 规则绑定 | 依赖 | 来源 PRD | ticket |
|:--|:-------|:-------------------|:---------|:-----|:---------|:-------|
| PK1 | electron-builder 配置 + 三平台 target 打包 | mac dmg+zip / win nsis+portable / linux AppImage+deb 出包成功；**Windows 打包需 Windows 环境**（nsis 不能 mac 交叉，BE 扫描发现） | CON-R-packaging-001/002/007 | 无 | PRD FR-1/FR-2 | t100089 |
| PK2 | 三端捆绑 node（fetch-node 按平台 + extractNode 承接） | 三端包内 node 就位；全新环境 dsh 首装不依赖用户 node；**fetch-node.mjs 扩展按平台下载**（现只 darwin-arm64，win 需 zip/exe、linux 需 tar.xz，格式不同，BE 扫描发现） | CON-R-packaging-003/008 | PK1 | PRD FR-3 | t100090 |
| PK3 | 三端自动更新 + 平台适配验证 | electron-updater 三端检测/下载/安装；spawn/托盘/路径三端验证；**electron-updater 三端更新机制差异**（mac zip / win nsis 配置不同，BE 扫描发现） | CON-R-packaging-004/005/006 | PK1/PK2 | PRD FR-4/FR-5 | t100091 |

## 15. 附录

### 15.1 关联

- PRD（docs/prd/2026-08-25-hull-packaging-prd.md）、规则索引（docs/spec/规则索引.md）、M1 共识（docs/spec/共识-Hull桌面壳-M1.md，CON-R006 引用）、pkgmgr 共识（spawn 跨平台铺垫）。

### 15.2 版本记录

| 版本 | 日期 | 变更摘要条目 | 说明 |
|:-----|:-----|:-------------|:-----|
| v1.1 | 2026-08-25 | 已登记（已发布） | BE 扫描结论回写：PK1/PK2/PK3 验收补 3 项（Windows 打包环境/fetch-node 按平台/electron-updater 三端差异） |
| v1.0 | 2026-08-25 | 已登记（已发布） | 首次建立：从 Hull Packaging PRD v0.1 提取；登记 CON-R-packaging-001~008、U-1~U-3 |

### 15.3 后续规划

> 记录本轮明确排除/未决项，供后续承接。

| 项 | 状态 | 说明 |
|:---|:-----|:-----|
| 代码签名/公证 | 排后（U-1） | 需证书 + 正式分发需求 |
| CI 自动化 | 排后（U-2） | 发布频率提升时做 |
| 商店分发 | 排后（U-3） | 需商店渠道需求 |
