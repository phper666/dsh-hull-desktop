# S6 壳设置页与托盘完善契约

## 契约信息

- 工作项：S6 壳设置页 + 托盘完善（飞书 dsh-hull-desktop 清单）
- 契约状态：已冻结
- 版本：v0.5（M1-重构迭代调整）
- 适用版本：M1（共识 v1.7）
- 最后更新：2026-08-22

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| 设置页双区块 | S6 | CON-R009 | dsh/Hull 区块各自版本+检查+开关 | SettingsPage | 已定义 |
| 设置持久化 | S6 | CON-R009 | 即时生效且持久化 | SettingsStore | 已定义 |
| 版本通道入口 | S6 | CON-R008 | latest/指定版本输入 | ChannelService（S4） | 已定义 |
| 托盘完整 | S6 | CON-R009 | 状态/升级入口/升级中禁用 | TrayController | 已定义 |
| 关闭即退出 | S6 | CON-R009 | 默认隐藏，开关可改 | Settings.closeToQuit | 已定义 |

## 范围与非目标

### 范围

- 设置页 UI（**壳内右侧整页 section，重渲染，删除独立壳窗口**，M1-重构 S6'）——入口：壳左侧导航「设置」为主 + 托盘补充（双入口，共识 v1.7；**导航菜单排序 = dsh web / 任务看板 / 设置，设置恒最后，去「升级」项**；托盘入口改为聚焦主窗口 + 切到设置视图）：
  - dsh 运行时区块：版本/运行状态/检查更新/回滚/版本通道入口/升级失败提示（按钮下方）+ **dsh 升级反馈（确认/进度/失败/回滚，拆入本区块底部，v0.5 修订）**
  - Hull 应用区块：版本/检查更新/Hull 自动检查开关/失败提示 + **Hull 升级反馈（确认/进度/失败/重启安装提示，拆入本区块底部，v0.5 修订）**
  - 通用设置：npm registry（任意源）/ 关闭窗口时退出开关 / dsh 自动检查开关
  - 诊断：打开日志目录 / 打开数据目录
- settings.json 持久化（userData）
- 托盘完整：dsh 运行状态 / 打开主窗口 / Hull 设置 / 检查 dsh 更新 / 升级进行中（禁用）/ 退出（补充入口，以壳左侧导航为主，共识 v1.7）
- 关闭主窗口默认隐藏（closeToQuit=false 可改）

> 注记（A3）：托盘列表确认——仅「检查 dsh 更新」（L30 现状）；**Hull 更新入口不入托盘**（设置页 Hull 区块内，S5 托盘「检查 Hull 更新…」不启用）。
> 注记（M1-重构）：设置页 preload 桥（原 `src/preload/settings.ts` 15 方法）并入壳 preload `src/preload/index.ts`（D2 决策）；settings 持久化仍走主进程 `hull:setSettings` 门面（CON-R002 不破）；DOM modal 确认流 + 250ms 轮询在 shell.html 设置 section 内重做（D1 决策）。
> 注记（v0.5）：左下角状态区新增「Hull 版本」行（hull:status payload hullVersion = app.getVersion()）；升级确认流入口 = 设置页「检查更新」按钮（原 nav「升级」项已删除，托盘「检查 dsh 更新」仍直连 runCheck + 切设置视图）。

### 非目标

- 官方 UI 内集成（M2+）
- 升级执行逻辑（S3/S5 提供）

## 业务流程与状态

### 设置持久化流程

文本流程：
设置页修改 → 校验（registry 格式/版本号/channel 组合）→ 写入 settings.json → 广播变更
  → 消费方（RuntimeManager/Updater/ChannelService/托盘）即时生效

### settings.json Schema

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| autoCheckDsh | boolean | true | dsh 自动检查开关 |
| autoCheckHull | boolean | true | Hull 自动检查开关 |
| closeToQuit | boolean | false | 关闭窗口=退出（否则隐藏托盘） |
| registry | string | https://registry.npmjs.org | 任意 npm registry（CON-R013） |
| channel | enum | latest | latest/pinned（S4） |
| pinnedVersion | string | 空 | 锁定版本（S4） |

## 接口清单

| # | 状态 | 接口 | 用途 | 调用方 | 幂等 |
|---|---|---|---|---|---|
| 1 | NEW | SettingsStore.get() | 读全量设置 | 各消费方 | 是 |
| 2 | NEW | SettingsStore.set(patch) | 增量更新+持久化 | 设置视图（壳内 section） | 是 |
| 3 | NEW | SettingsStore.on(changed) | 变更广播 | 托盘/Updater | 无 |
| 4 | NEW | TrayController.update(status) | 托盘状态更新 | RuntimeManager/Updater | 是 |

## Schema 与枚举

### 错误集 SETTINGS_ERRORS

| 语义错误码 | 触发条件 | 客户端处理 | 可重试 |
|---|---|---|---|
| registry-invalid | registry 地址格式非法 | 输入框提示 | 否 |
| version-invalid | pinnedVersion 非法 | 提示从列表选择 | 否 |
| persist-failed | settings.json 写失败 | 提示重试 | 是 |

> 注记（A2）：`persist-failed ≡ settings-write-failed`（别名——S4 已实现错误码，S6 沿用不新建）。

## 接口详情

### 1. SettingsStore.set(patch)

- 使用场景：设置页任何修改
- 共识：CON-R009
- 行为：校验 → 原子写 settings.json → 广播 changed 事件
- 输出：Promise(settings)
- 异常：SETTINGS_ERRORS

### 2. 托盘状态

- 常规：dsh 运行中（版本/地址）、打开主窗口、Hull 设置、检查 dsh 更新（有新版标记）、退出（托盘为补充入口，以壳左侧导航为主）
- 升级进行中：升级相关项禁用

## 联调与测试场景

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| T6-01 | 设置持久化 | 改 registry + 重启 | 重启后设置保留 |
| T6-02 | 双区块 | 各自检查更新 | 独立弹窗与进度 |
| T6-03 | 关闭即退出 | 开/关开关 | 关窗口行为变化 |
| T6-04 | 托盘禁用 | 升级进行中 | 升级项禁用 |
| T6-05 | registry 校验 | 非法地址 | 输入框提示 |
| T6-06 | 日志入口 | 点打开日志目录 | 打开 Finder 对应目录 |

## 开放问题

无

## 协调事项

- 无跨团队协调（solo）

## 完成记录

- 契约草案生成（2026-08-14），待评审

## 决策与踩坑

- 设置页**壳内右侧整页 section**（M1-重构 D1 决策），删除独立壳窗口（替代原「独立壳窗口」决策 #4）——统一壳内交互模型
- 设置页 preload 桥并入壳 preload（D2 决策），官方 view 零注入结构不变（CON-R001）
- registry 任意源（CON-R013），不是仅国内镜像

## 变更记录

- 2026-08-22：M1-重构迭代调整（S6'，共识 v1.7）：设置页升级 UI 从独立 upgrade 视图并入设置页，再**拆分到 dsh 运行时/Hull 应用区块各自底部**（删独立升级卡，dsh/Hull 各自内联自己的确认/进度/失败/回滚/重启提示）；导航菜单排序 = dsh web / 任务看板 / 设置（去「升级」项 + M2 tag，设置恒最后）；左下角状态区新增「Hull 版本」行（hull:status payload hullVersion）；升级确认流入口 = 设置页「检查更新」按钮（托盘仍直连 runCheck + 切设置视图）。升 v0.5
- 2026-08-22：M1-重构变更传播（S6'，共识 v1.6）：设置页独立壳窗口 → 壳内右侧整页 section（重渲染，删除 SettingsWindow）；preload 桥并入壳 preload（D2）；托盘入口改为聚焦主窗口 + 切设置视图（D5）；持久化仍走 hull:setSettings（R002 不破）。升 v0.4
- 2026-08-18：变更传播（主窗口形态变更，共识 v1.5）：设置入口调整为双入口——壳左侧导航为主 + 托盘补充（独立窗口形态保留）；托盘定位为补充入口（范围/托盘状态两处注记）；partition 'settings' 隔离语义保留，隔离实现表述归 S6 设计文档。升 v0.3
- 2026-08-17：评审修订封口 5 项：适用版本升共识 v1.4 + 变更记录格式统一（A1）；SETTINGS_ERRORS persist-failed ≡ settings-write-failed 别名注记（A2）；托盘列表确认注记——仅「检查 dsh 更新」，Hull 入口不入托盘（A3）；变更传播附注——registry 字段落地 + 三消费点（S2 安装/S3 check/S4 listVersions）优先级统一「settings 优先 env 兜底」（A4）；封口声明——清单外冻结项不动（A5）。升 v0.2
- 2026-08-14：新建契约（草案）

## 自检记录

- 字段/默认值/校验齐备；持久化与广播明确；无 TBD
