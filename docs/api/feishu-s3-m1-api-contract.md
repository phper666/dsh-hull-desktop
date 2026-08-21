# S3 dsh 升级编排契约

## 契约信息

- 工作项：S3 dsh 升级编排（飞书 dsh-hull-desktop 清单）
- 契约状态：已冻结
- 版本：v0.3（M1-重构变更传播）
- 适用版本：M1（共识 v1.6）
- 最后更新：2026-08-22

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| 升级状态机 | S3 | CON-R005 | 全链路状态迁移合法 | Updater | 已定义 |
| 原子替换 | S3 | CON-R005/014 | 崩溃残留检测恢复 | SwapManager | 已定义 |
| 自动回滚 | S3 | CON-R005 | 坏版本注入→回滚成功 | Updater.rollback() | 已定义 |
| 失败提示 | S3 | CON-R009 | 按钮下方提示，可重试 | 设置页 | 已定义 |
| 当日不重复 | S3 | CON-R009 | 稍后再说当日不再提示 | DismissStore | 已定义 |
| 双通道互斥 | S3 | CON-R012 | 同一时间仅一个排队 | UpgradeQueue | 已定义 |

## 范围与非目标

### 范围

- 升级状态机：checking → confirm → installing → swapping → verifying → rollback
- staging 安装（可取消）、原子替换（dsh→previous，staging→dsh）
- 崩溃残留检测恢复（Q-004：dsh 缺失+staging 存在→续替；dsh 缺失+previous 存在→回滚）
- 自动回滚（就绪验证失败）；手动回滚（升级视图按钮）
- 失败提示（按钮下方）；稍后再说当日不重复
- 双通道互斥队列（S5 复用）
- 升级时机：确认后立即升级（Q-003，无排队、无会话状态桥）
- **UI 载体（M1-重构 S3'）**：升级确认/进度/失败提示/回滚/重启安装提示从原生 dialog/DOM modal 收进壳内统一模式——独立 upgrade 右侧视图，壳导航「升级」切换（D4 决策）；升级原子性编排逻辑（UpgradeQueue/SwapManager/Updater）零改动（CON-R005 不破）

### 非目标

- 版本通道（S4）
- Hull 自更新（S5，仅复用互斥队列）
- 首次安装（S2，复用 OverlayManager.install）

## 业务流程与状态

### 升级状态机

| 状态 | 含义 | 合法迁移 | 触发条件 |
|---|---|---|---|
| idle | 无升级动作 | → checking | 手动检查 / 自动检查发现新版 |
| checking | 查 registry | → confirm / idle | 有新版本 / 无新版本或出错 |
| confirm | 弹确认框 | → installing / idle | 用户确认 / 稍后再说（当日不再提示，Q-008） |
| installing | staging 安装 | → swapping / idle | 安装完成 / 用户取消或失败（按钮下方失败提示，可重试） |
| swapping | 停子进程+原子替换 | → verifying / idle | 替换完成 / 失败（残留检测恢复，Q-004） |
| verifying | 新版本重启验证 | → idle（成功）/ rollback | 就绪行+HTTP 探测 / 超时 |
| rollback | 换回 dsh-previous | → idle | 回滚完成 |

冲突行为：升级进行中再次触发检查 → 忽略或提示"升级进行中"；互斥队列单槽（dsh/Hull 互斥）。

### 崩溃恢复规则（Q-004）

| 启动时磁盘状态 | 处理 |
|---|---|
| dsh 存在 | 正常启动 |
| dsh 缺失 + staging 存在 | 继续完成替换（staging→dsh） |
| dsh 缺失 + previous 存在 | 回滚恢复（previous→dsh） |

## 接口清单

| # | 状态 | 接口 | 用途 | 调用方 | 幂等 |
|---|---|---|---|---|---|
| 1 | NEW | Updater.check() | 版本检查 | 升级视图/启动自动 | 是 |
| 2 | NEW | Updater.upgrade(target) | 执行升级 | 确认后（升级视图） | 是（先停后起） |
| 3 | NEW | Updater.cancel() | 取消安装 | 用户（升级视图） | 是 |
| 4 | NEW | Updater.rollback() | 手动回滚 | 升级视图 | 是 |
| 5 | NEW | UpgradeQueue.acquire(channel) | 互斥排队 | Updater/HullUpdater | 是 |

> 注记（S5 变更传播）：#5 调用方 HullUpdater 同队列（S5 全流程占槽语义与 S3 check 同族——单次 acquire 连续持有至终态）；DismissStore 分通道键 `{ dsh?, hull? }`——S3 调用点传 `'dsh'`（代码归 S5 实现波，本波仅注记）。
| 6 | NEW | SwapManager.swap() | 原子替换+残留恢复 | upgrading | 是 |
| 7 | NEW | Updater.on(status) | 状态/进度通知 | 设置页/托盘 | 无 |
| 8 | NEW | Updater.canRollback() | 手动回滚可用条件（previous 存在性） | 设置页/S6 | 是 |

> 时序注记（A2）：#1/#4 调用方设置页归 S6 接线——S3 先行 main/托盘入口 + 原生 dialog 交付；**M1-重构 S3' 后**升级确认/进度/失败提示收进壳内独立 upgrade 视图（D4 决策），原生 dialog 移除；按钮禁用态 = canRollback() 数据源不变。

## Schema 与枚举

### UpgradeStatus

| 字段 | 类型 | 说明 |
|---|---|---|
| phase | enum | idle/checking/confirm/installing/swapping/verifying/rollback |
| currentVersion | string | 当前 dsh 版本 |
| targetVersion | string | 目标版本（confirm 后） |
| error | string | 失败语义码（见错误集） |
| pct | number | 安装进度 0-100 |

### 错误集 UPGRADE_ERRORS

| 语义错误码 | 触发条件 | 客户端处理 | 可重试 |
|---|---|---|---|
| check-failed | registry 检查失败 | 提示稍后重试 | 是 |
| version-invalid | 目标版本非法 | 校验拦截 | 否 |
| install-failed | npm install 失败 | 按钮下方提示，可重新点击 | 是 |
| verify-failed | 就绪验证超时 | 自动回滚 + 提示 | 否（自动回滚） |
| swap-broken | 替换中断 | 启动残留恢复 | 否 |
| queue-busy | 另一通道升级中 | 禁用入口/提示 | 是 |

> 注记（A4）：version-invalid 双触发点——① S2 install pre-swap 门禁 / ② S2 swap 版本校验 + semver.ts 目标版本合法性校验（三处，实现期单测各覆盖；注记置于表后，P1 渲染修复）

## 接口详情

### 1. Updater.check()

- 使用场景：设置页手动检查 / 启动自动检查（开关默认开）
- 共识：CON-R009
- 行为：registry 查询 @deepseek-ai/dsh 最新版（或 pinned 目标，S4）→ 与当前版本比较（prerelease 感知）→ 有新版进入 confirm
- 输出：{ hasUpdate, current, latest, changeNotes? }
- 异常：check-failed（网络/registry）
- 注记（S4 v0.2 对齐）：check 恒查 registry latest（与 channel 无关——「检查与 pinned 解耦」字面化）；「或 pinned 目标」不适用（pinned 守卫只作用于 upgrade 目标）
- 注记（S6 变更传播）：registry 来源随 settings.json 字段落地——check 消费点（registry.ts）读 **settings.registry 优先 + HULL_REGISTRY env 兜底**（代码归 S6 实现波）

### 2. Updater.upgrade(target)

- 使用场景：用户确认后（Q-003：立即升级，不等待会话）
- 共识：CON-R005/011(已删除)/012
- 行为：acquire 互斥队列 → OverlayManager.install(target)（staging）→ 停子进程 → SwapManager.swap() → 启动验证 → 成功 idle / 失败自动 rollback
- 输出：Promise(UpgradeStatus)
- 异常：UPGRADE_ERRORS 全集
- 注记（S4 v0.2 对齐）：target 缺省 → ChannelService.resolveTarget()（默认目标，channel 驱动）；显式传参（解锁升级）绕过 resolveTarget；目标 == 当前运行版本 → 拒绝「已在该版本」

### 3. SwapManager.swap()

- 原子替换：dsh → dsh-previous，staging → dsh（同卷 rename）
- 崩溃窗口恢复：见状态转换章节（Q-004）

### 4. 失败提示与当日不重复（Q-002/Q-008）

- 失败提示：显示在升级按钮下方（红字 + 重新升级入口）
- 当日不重复：稍后再说后记录日期，当日不再自动提示，次日/下次启动再检查
- 注记（S5 变更传播）：DismissStore 分通道键 `{ dsh?, hull? }`——dsh 通道调用 `dismissToday('dsh')`/`isDismissedToday('dsh')`，旧单键 `{ date }` 读兼容视作 dsh 侧（代码归 S5 实现波）

## 联调与测试场景

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| T3-01 | 正常升级 | 检查→确认→安装→替换→验证 | 版本号变化，官方 UI 为新版，数据无损 |
| T3-02 | 坏版本注入 | 探测目标指向坏地址（Q-010） | 验证失败→自动回滚→可用 |
| T3-03 | 崩溃恢复 | 替换两步间 kill 壳 | 重启后残留检测自愈 |
| T3-04 | 取消升级 | installing 中取消 | 保持原版本，staging 清理 |
| T3-05 | 失败重试 | 注入 install-failed | 升级视图内按钮下方提示，重点后成功（M1-重构后壳内提示替代原生 dialog；设置页按钮下方形态原归 S6 分期，S3' 起统一收进升级视图） |
| T3-06 | 当日不重复 | 稍后再说后重启 | 当日不提示，次日提示 |
| T3-07 | 互斥 | dsh 升级中触发 Hull 检查 | Hull 入口禁用/提示 |

## 开放问题

- W3（P2，实现时处理）：手动回滚按钮可用条件（previous 存在）需明确禁用态。非阻断。

## 协调事项

- 无跨团队协调（solo）

## 完成记录

- 契约草案生成（2026-08-14），待评审

## 决策与踩坑

- Q-003：确认后立即升级（会话中断可接受），无排队逻辑
- Q-004：崩溃残留检测恢复规则（staging 续替 / previous 回滚）
- Q-010：就绪探测目标/超时可注入，坏版本注入无需改业务代码
- prerelease 版本比较参考社区实现（myYangyunfan/updater.js）

## 变更记录

- 2026-08-22：M1-重构变更传播（S3'，共识 v1.6）：升级 UI 载体从原生 dialog 收进壳内统一模式——独立 upgrade 右侧视图（D4 决策），壳导航「升级」切换；确认/进度/失败/回滚/重启安装提示壳内呈现，原生 dialog 移除；升级原子性编排逻辑（UpgradeQueue/SwapManager/Updater）零改动（CON-R005 不破）；#1~#4 调用方改升级视图。升 v0.3
- 2026-08-17：评审修订：接口清单补 #8 Updater.canRollback()（A1）；#1/#4 调用方时序注记（S3 先行 main/托盘 + dialog，S6 接线设置页）+ T3-05 分期标注（A2）；适用版本升共识 v1.4（A3）；version-invalid 双触发点注记（A4）。升 v0.2
- 2026-08-14：新建契约（草案）

## 自检记录

- 状态机含冲突行为；崩溃恢复覆盖全部窗口；错误集完整；测试场景覆盖正常/故障/并发；无 TBD
