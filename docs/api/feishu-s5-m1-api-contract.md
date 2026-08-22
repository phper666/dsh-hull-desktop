# S5 Hull 自更新契约

## 契约信息

- 工作项：S5 Hull 自更新（飞书 dsh-hull-desktop 清单）
- 契约状态：已冻结
- 版本：v0.3（M1-重构变更传播）
- 适用版本：M1（共识 v1.6）
- 最后更新：2026-08-22

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| 自更新机制 | S5 | CON-R003 | GitHub Releases 发现/下载/重启安装 | HullUpdater | 已定义 |
| 发布通道 | S5 | CON-R003 | release.yml + GH_TOKEN | CI workflow | 已定义 |
| 双通道互斥 | S5 | CON-R012 | 与 dsh 升级互斥 | UpgradeQueue（S3 复用） | 已定义 |
| 失败提示 | S5 | CON-R009 | 按钮下方提示，可重试 | 设置页 | 已定义 |
| 无公证限制 | S5 | CON-R003 | Gatekeeper 预防性提示 | 预防性提示 | 已定义 |

## 范围与非目标

### 范围

- electron-updater 接入（GitHub provider，latest-mac.yml）
- 检查/下载/重启安装（重启前先停 dsh 子进程）
- 自动检查开关（默认开）+ 手动检查
- 失败提示（升级按钮下方，可重新点击）
- 与 dsh 升级互斥（复用 S3 UpgradeQueue）
- 无公证：更新确认/下载完成时预防性提示（右键打开/重下载引导）
- CI：.github/workflows/release.yml（build → electron-builder → 发布 GitHub Releases）

> 注记（M1-重构 S3'，2026-08-22）：Hull 通道 UI 载体收进壳内统一 upgrade 视图——确认卡片/进度/失败/重启安装提示（预防性提示）迁 shell.html section#upgrade；HullUpdater 编排逻辑（download/installAndRestart/autoCheck 门控）零改动，DismissStore 分通道键保持；原 settings.html 内嵌 Hull modal 确认流移除（随设置页迁移一并收进 upgrade 视图）。托盘「检查 Hull 更新」不入托盘（维持 A3 注记）。

### 非目标

- Apple 公证/签名（后续里程碑）
- dsh 升级（S3）
- Windows/Linux 打包（后续）

## 业务流程与状态

### 更新流程

文本流程：
启动/手动 → 检查 GitHub Releases（electron-updater）→ 发现新版 → 确认（版本对比+变更说明）
→ 下载（进度）→ 提示重启安装 → 用户确认 → 停 dsh 子进程 → quitAndInstall
失败：按钮下方提示，可重新点击
Gatekeeper：更新确认/下载完成时预防性提示（右键打开/重下载引导）

### 状态转换

| 状态 | 动作 | 目标状态 | 前置条件 | 冲突行为 |
|---|---|---|---|---|
| idle | check() | checking | 无 | 与 dsh 升级互斥 |
| checking | 发现新版 | confirm | 有新版 | 无 |
| checking | 无新版/失败 | idle | 无更新或出错 | 无（A5 补行） |
| confirm | 用户确认 | downloading | 确认 | 稍后再说（当日不重复，Q-008） |
| downloading | 下载完成 | restarting | 完成 | 可取消（#5 cancel） |
| restarting | quitAndInstall | done | 先停 dsh | 无 |

> **restart-prompt 枚举注记（A4）**：HullUpdateStatus.phase 枚举含 restart-prompt（契约 schema 字段）——**预留 S6 UI 渲染态，状态机不迁移到它**（Q-012 无「稍后重启」：downloading → restarting 自动）；跨契约枚举一致性核对注记（S3 升级状态机同为「状态表 6 行 vs 枚举多值」模式）。

> Q-012（closed）：**无「稍后重启」选项**——确认即执行，下载完成后自动重启安装；延迟需求由确认框「稍后再说」覆盖（与 dsh 通道 Q-003 哲学一致）。

## 接口清单

| # | 状态 | 接口 | 用途 | 调用方 | 幂等 |
|---|---|---|---|---|---|
| 1 | NEW | HullUpdater.check() | 检查更新 | 设置页/启动自动 | 是 |
| 2 | NEW | HullUpdater.download() | 下载更新包 | 确认后 | 是 |
| 3 | NEW | HullUpdater.installAndRestart() | 停 dsh + quitAndInstall | 用户确认 | 是 |
| 4 | NEW | HullUpdater.on(status) | 状态/进度通知 | 设置页 | 无 |
| 5 | NEW | HullUpdater.cancel() | 取消下载（CancellationToken） | 用户 | 是 |
| 6 | CI | release.yml | 构建并发布 Releases | GitHub Actions | — |

> 注记（A3）：#5 cancel()——**仅 downloading 阶段可取消**（CancellationToken 接线）；installAndRestart 阶段不可取消（停 dsh + quitAndInstall 一旦开始即执行完）。原 #5 CI 顺延为 #6。

## Schema 与枚举

### HullUpdateStatus

| 字段 | 类型 | 说明 |
|---|---|---|
| phase | enum | idle/checking/confirm/downloading/restart-prompt/restarting/done |
| currentVersion | string | 当前 Hull 版本 |
| targetVersion | string | 新版本 |
| changeNotes | string | GitHub Releases 变更说明（缺失降级为纯版本对比） |
| error | string | 语义错误码 |

### 错误集 HULL_UPDATE_ERRORS

| 语义错误码 | 触发条件 | 客户端处理 | 可重试 |
|---|---|---|---|
| check-failed | Releases 检查失败 | 提示稍后重试 | 是 |
| download-failed | 下载失败 | 按钮下方提示，可重试 | 是 |
| install-failed | 安装失败 | 按钮下方提示 | 是 |
| gatekeeper-blocked | 无公证更新（预防性提示） | 提示（右键打开/重下载引导） | 否 |
| queue-busy | dsh 升级进行中 | 入口禁用 | 是 |

## 接口详情

### 1. HullUpdater.installAndRestart()

- 使用场景：用户确认重启安装
- 共识：CON-R003/012
- 行为：acquire 互斥队列 → RuntimeManager.stop()（停 dsh）→ electron-updater quitAndInstall
- 输出：无（应用重启）
- 异常：HULL_UPDATE_ERRORS

### 2. 发布通道前置准备（协调事项）

- GitHub PAT（fine-grained）：Contents write + Actions write → 仓库 Secrets 命名 GH_TOKEN
- 已就绪（用户已完成）后 release.yml 生效

## 联调与测试场景

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| T5-01 | 发现新版本 | Releases 发 0.2.0 | 检查提示，含变更说明 |
| T5-02 | 完整更新 | 确认→下载→重启 | 壳版本变化，dsh 数据无损 |
| T5-03 | 互斥 | dsh 升级中触发 Hull | 入口禁用/提示 |
| T5-04 | 下载失败 | 断网下载 | 按钮下方提示，重试成功 |
| T5-05 | 无公证拦截 | 未公证包安装 | Gatekeeper 引导提示（**预防性口径（A2）**：更新确认/下载完成时提示「更新后若无法打开：① 右键 → 打开（隔离/未公证）② 若仍无法打开请重新下载安装包」+ README 引导章节；删「安装后检测/flag」描述） |
| T5-06 | 自动检查开关 | 关闭后启动 | 无网络检查请求 |

## 开放问题

- ~~Q-012~~ 已关闭：删除「稍后重启」选项（确认框「稍后再说」已覆盖延迟需求）。

## 协调事项

- 用户已完成：GH_TOKEN 配置（fine-grained PAT，Contents+Actions 写权限）
- 待办：release.yml 编写（本契约完成后随 S5 实现）

## 完成记录

- 契约草案生成（2026-08-14），待评审

## 决策与踩坑

- 重启前必须先停 dsh 子进程（避免孤儿进程）
- 无公证下更新可用性受限（Gatekeeper），引导放行；正式发布前补公证

## 变更记录

- 2026-08-22：M1-重构变更传播（S3'，共识 v1.6）：Hull 通道 UI 载体（确认/进度/失败/预防性提示）收进壳内统一 upgrade 视图（shell.html section#upgrade）；HullUpdater 编排逻辑零改动；设置页 Hull modal 确认流移除。升 v0.3
- 2026-08-17：评审修订封口 6 项：适用版本升共识 v1.4 + 变更记录格式统一（A1）；T5-05 口径改「安装前预防提示 + README 引导」（删安装后检测/flag 描述）（A2）；接口清单补 #5 HullUpdater.cancel()（CancellationToken，仅 downloading 可取消），原 #5 CI 顺延 #6（A3）；restart-prompt 枚举保留 + 语义注记（A4）；状态表补 checking→idle 行（A5）；封口声明——清单外冻结项不动（A6）。升 v0.2
- 2026-08-14：复核通过并冻结；按 Q-012 结论删除「稍后重启」选项
- 2026-08-14：新建契约（草案）

## 自检记录

- 追踪矩阵完整；互斥与 Gatekeeper 明确；测试场景覆盖成功/失败/并发；无 TBD
