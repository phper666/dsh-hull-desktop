# S4 dsh 版本通道契约

## 契约信息

- 工作项：S4 dsh 版本通道（飞书 dsh-hull-desktop 清单）
- 契约状态：已冻结
- 版本：v0.2（评审修订）
- 适用版本：M1（共识 v1.4）
- 最后更新：2026-08-17

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| 版本通道 | S4 | CON-R008 | latest 跟随官方 / pinned 锁定 | ChannelService | 已定义 |
| 指定版本入口 | S4 | CON-R008 | 手输 + 版本列表选择 | ChannelService.listVersions() | 已定义 |
| 检查与 pinned 解耦 | S4 | CON-R008 | 检查照常，升级需解锁 | 设置页 | 已定义 |
| prerelease 比较 | S4 | CON-R008 | rc 序数正确比较 | VersionCompare | 已定义 |
| registry 通用 | S4 | CON-R013 | 任意 registry | Settings.registry | 已定义 |

> 注记（G5 + S6 变更传播回改）：`Settings.registry` 行——registry 配置**落地 settings.json 字段**（S6 契约 v0.2 兑现，T6-05 验收）；`HULL_REGISTRY env` 降为兜底（S2 偏离 3 修订：settings.registry 优先 + env 兜底）。
> 注记（S6 变更传播）：listVersions 消费点（registry.ts）随 settings 字段落地——读 **settings.registry 优先 + env 兜底**（代码归 S6 实现波）。

## 范围与非目标

### 范围

- channel 设置：latest（默认）/ pinned
- 指定版本入口：手输版本号 + registry 版本列表下拉
- pinnedVersion 持久化（settings.json）
- 检查与 pinned 解耦：自动检查照常执行并提示新版；升级到非 pinned 版本需显式解锁（升级后 channel 回 latest）
- prerelease 感知版本比较（0.1.0-rc.6 < 0.1.0-rc.7 < 0.1.0）
- 非法版本号校验

### 非目标

- 升级执行（S3 复用）
- 安装流程（S2 复用）
- 自建正式/开发双通道（Q-005：官方无正式版，不建假通道）

## 业务流程与状态

### 版本解析流程

文本流程：
设置页版本通道 → 输入/选择目标版本 → 校验（prerelease 感知比较 + registry 存在性）→ 持久化
   → 升级时：channel=latest → 取 registry latest；channel=pinned → 用 pinnedVersion
检查时：无论 channel，检查照常执行；发现新版 → 提示（pinned 时标注"已锁定"）
升级确认：目标 ≠ pinnedVersion → 弹窗说明"将解锁并升级"，确认后升级且 channel 回 latest

### 状态与枚举

| 项 | 值 |
|---|---|
| channel | latest / pinned |
| 比较规则 | prerelease 感知：同 pre 段按序数，pre 版本小于正式版 |
| 校验规则 | 版本号必须存在于 registry 版本列表（手输时） |

## 接口清单

| # | 状态 | 接口 | 用途 | 调用方 | 幂等 |
|---|---|---|---|---|---|
| 1 | NEW | ChannelService.get() | 读取当前通道 | 设置页 | 是 |
| 2 | NEW | ChannelService.set(channel, version?) | 设置通道/锁定版本 | 设置页 | 是 |
| 3 | NEW | ChannelService.resolveTarget() | 解析升级目标版本 | Updater（S3） | 是 |
| 4 | NEW | ChannelService.listVersions() | registry 版本列表 | 设置页下拉 | 是 |
| 5 | NEW | VersionCompare.compare(a, b) | prerelease 感知比较 | 各模块 | 是 |

> 时序注记（G6）：#1/#2/#4 调用方设置页——S4 先行 main 侧 ChannelService 接口，S6 接线设置页 UI。
> IPC 预留注记（G7）：`hull:getChannel` / `hull:setChannel` / `hull:listVersions` 三通道，S6 启用。

## Schema 与枚举

### settings.channel / settings.pinnedVersion

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| channel | enum | 是 | latest/pinned | 默认 latest |
| pinnedVersion | string | 否 | 存在于 registry 版本列表 | channel=pinned 时必填 |

> 注记（S5 变更传播）：schema 同批扩展 `autoCheckDsh`/`autoCheckHull`（S3 启动自动检查开关 + S5 自更新开关，均默认 true）——**schemaVersion 定 3**（S4 扩展波 channel/pinnedVersion + S5 两字段 = 最终版本号 3，单次迁移，S6 迁移以 3 为判据）；代码归 S5 实现波。

### 错误集 CHANNEL_ERRORS

| 语义错误码 | 触发条件 | 客户端处理 | 可重试 |
|---|---|---|---|
| version-invalid | 版本号格式非法 | 输入框校验提示 | 否 |
| version-not-found | registry 无该版本 | 提示并从列表选择 | 是 |
| registry-unreachable | 列表拉取失败 | 提示稍后重试 | 是 |

## 接口详情

### 1. ChannelService.resolveTarget()

- 使用场景：**Updater.upgrade 前（默认目标）**（G3：check 恒查 registry latest 与 channel 无关；解锁升级显式传参绕过 resolveTarget）；Updater.check 无需 resolveTarget
- 共识：CON-R008/013
- 行为：channel=latest → registry dist-tags.latest；channel=pinned → 校验 pinnedVersion 存在性后返回
- 输出：Promise(targetVersion)
- 异常：CHANNEL_ERRORS
- 注记（G4）：version-not-found（pinned 版本被 registry 下架）；解锁升级失败 channel 不动（成功才回写 latest）；离线 set('pinned') 边界——pinned 锁定须 registry 存在性校验，离线无法锁定（UI 禁用 + 提示，非缺陷）

### 2. 解锁升级语义

- pinned 模式下检查发现新版 Y：提示"最新 Y，当前锁定 X"（可保持锁定 / 解锁并升级）
- 解锁升级：升级到 Y 后 channel 自动回 latest
- 注记（G4）：升级成功才回写 latest；失败 channel 保持 pinned

### 5. VersionCompare

- **映射注记（G4）**：不新建模块——契约 #5 ≡ S3 `semver.compareVersions(a, b)`（prerelease 感知：rc 序数、pre < 正式版），由 S3 semver.ts 承载

## 联调与测试场景

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| T4-01 | latest 跟随 | channel=latest，registry 有新 rc | 检查提示新版，升级到最新 |
| T4-02 | pinned 锁定 | 锁定 rc.5，registry 有 rc.7 | 检查照常提示，升级被守卫 |
| T4-03 | 解锁升级 | pinned 下确认解锁 | 升级到 rc.7，channel 回 latest |
| T4-04 | 非法版本 | 手输 abc | 校验拦截 |
| T4-05 | prerelease 比较 | rc.6 vs rc.7 vs 0.1.0 | 顺序正确 |
| T4-06 | 版本列表 | registry 不可达 | 列表加载失败提示 |

## 开放问题

- W4（P2，实现时处理）：listVersions 上限/分页未定义。非阻断。

## 协调事项

- 无跨团队协调（solo）

## 完成记录

- 契约草案生成（2026-08-14），待评审

## 决策与踩坑

- Q-001/Q-005：默认 latest + 指定版本入口（手输/列表），不自建正式/开发双通道
- 检查与 pinned 解耦：用户选择检查就检查，pinned 只守卫升级目标

## 变更记录

- 2026-08-17：评审修订封口 8 项：适用版本升共识 v1.4（G1）；变更记录格式统一（G2）；#3 resolveTarget 使用场景改「Updater.upgrade 前（默认目标），解锁升级显式传参绕过」（G3）；#5 VersionCompare 映射注记（≡ S3 semver.compareVersions）+ version-not-found/解锁失败 channel 不动/离线锁定边界注记（G4）；需求追踪表 Settings.registry 行删改 + HULL_REGISTRY env 承载注记（G5）；#1/#2/#4 调用方时序注记（S4 先行 main 接口 + IPC 预留，S6 接线设置页）（G6）；IPC 预留注记（hull:getChannel/setChannel/listVersions 三通道，S6 启用）（G7）；未升版本注记——本轮仅指针 + 行为注记，S3 #1/#2 同步对齐（G8）。升 v0.2
- 2026-08-14：新建契约（草案）

## 自检记录

- 追踪矩阵完整；pinned/解锁语义明确；校验与错误集齐备；无 TBD
