# 调研：插件市场（plugin-market）

> 日期：2026-09-21 · 需求：docs/prd/2026-09-07-plugin-market-prd.md（未启动）· 来源：代码事实 + 共识规则（CON-R004/R002/skills 系/pkgmgr 系）
> 结论：可行；**判级：复杂**（新扩展机制 + 主进程代码加载=安全敏感 + 外部集成 npm registry + 新导航视图）

## 一、调研结论（对应 PRD 5 项待调研）

### 1. 插件形态与边界 → **壳插件（Electron 主进程扩展）**

- Hull **当前无插件/扩展机制**（代码实证：仅 IPC/preload 桥的"受控扩展"，非插件系统）——需新定义。
- **壳插件** = npm 包 + `hull-plugin.json` manifest（id/name/version/entry），加载进 Hull 主进程扩展点（预定义 IPC 注册 + 渲染层挂载点）。
- **红线合规**：CON-R004 要求"跑在 dsh 内部的功能走官方扩展点"——壳插件住在 Electron 主进程 = 壳原生功能层（CON-R004 第一句），不违反；与 dsh 插件（`--patch`/`dsh plugin add`，跑在 dsh 内）是两条渠道，互不冲突。
- **dsh 插件渠道**（`--patch`）留 v2：需调研 dsh 官方插件协议（ExecutionProvider 注释实证存在），v1 不做。

### 2. 分发渠道 → **npm registry（主）**

- Hull 已有完整 npm 安装链（pkgmgr/InstallFlow，CON-R-pkgmgr 系）：插件 = npm 包 `hull-plugin-<id>`，版本管理复用 dsh 通道模式（latest/pinned）。
- GitHub Releases 分发 = v2 备选（electron-updater 基建可借）；自建注册表 = **不做**（重）。

### 3. 生命周期（安装/更新/卸载）→ 复用 skills 机制族

- 安装：`npm install` 到 `<userData>/plugins/staging/<id>` → manifest 校验 → 原子换入 `<userData>/plugins/<id>`（复用 `UpgradeExecutor` staging→替换→验证→回滚模式）。
- 更新：registry 版本检测 → staging 下载 → 替换 → 旧版备份（复用 TrashManager 回收站语义）。
- 卸载：二次确认 → 移回收站（可恢复，复用 CON-R-skills-003 回收站模式）。
- **生效需重启 Hull**（v1 启动时加载插件；热加载 v2）。

### 4. 安全（核心风险面）

- 插件代码在主进程运行 = **高权限** → v1 安全模型：① 来源白名单（registry 前缀 + 包名规范 `hull-plugin-` 校验）；② 安装前 manifest 校验（schema/入口存在性）；③ 安装时**显式信任声明**（提示"插件将获得主进程权限"）；④ 破坏性操作二次确认（复用 CON-R-skills-003/007 模式）。
- 真正沙箱（utilityProcess 隔离）→ v2。
- 不写 DSH_HOME（CON-R002）；插件目录在 userData。

### 5. UI 位置 → 壳导航「插件」页（Skills 检查器后）

- 两 tab：市场浏览（远程 registry 搜索）/ 已安装管理（列表/更新/卸载），复用 skills 检查器 UI 模式（本地/远程两 tab 先例，CON-R-skills-010）。
- 安装/更新/卸载与 dsh 升级、壳自更新**互斥**（复用 backup 门控先例：插件操作进行中禁用更新入口）。

## 二、判级

**复杂**：新扩展机制（greenfield）+ 主进程代码加载（安全敏感，红线区）+ 外部系统集成（npm registry）+ 新导航视图 → 实现前必产技术方案（docs/design/）并评审冻结。

## 三、下一阶段

建共识（本调研为输入）→ 规则编号 CON-R-plugin-xxx → 扫描 → 拆子需求（Gate B）→ 契约 → 判级确认 → 技术方案 → 实现管道。
