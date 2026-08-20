# S1 壳骨架与进程管理契约

## 契约信息

- 工作项：S1 壳骨架与进程管理（飞书 dsh-hull-desktop 清单）
- 契约状态：已冻结
- 版本：v0.3（变更传播）
- 适用版本：M1（共识 v1.5）
- 最后更新：2026-08-18
- 说明：桌面壳内部模块契约（无 HTTP API 面）；接口清单 = 模块调用面与进程协议

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| 启动编排 | S1 | CON-R001/006/015 | 冷启动到 UI 可交互总时长 ≤10s | RuntimeManager.start() | 已定义 |
| 子进程守护 | S1 | CON-R001 | 崩溃提示+重启；退出零残留 | RuntimeManager.on(status) | 已定义 |
| 就绪判定 | S1 | CON-R015 | 就绪行+HTTP 探测；探测目标可注入 | ReadinessProbe | 已定义 |
| 单实例 | S1 | CON-R006 | 第二实例唤醒第一个 | 启动锁 | 已定义 |
| 托盘基础 | S1 | CON-R009 | 打开主窗口/设置入口/退出 | TrayController | 已定义 |

## 范围与非目标

### 范围

- Electron 主进程骨架（窗口/生命周期/单实例锁）
- dsh 子进程 spawn/守护/崩溃重启
- 主窗口 = 壳框架窗口：左侧 Hull 导航（壳层 UI）+ 右侧内嵌官方 UI（WebContentsView，零注入，CON-R001）——实现形态以技术方案为准，契约层只定义行为：右侧显示官方 UI 零注入，左侧导航提供设置/升级入口
- 就绪判定协议（就绪行 + HTTP 探测）
- 托盘基础（打开主窗口/设置入口/退出）

### 非目标

- 设置页内容（S6）
- 升级编排（S3）、版本通道（S4）、Hull 自更新（S5）
- 首次安装（S2）
- 官方 UI 的任何修改

## 业务流程与状态

### 核心流程

文本流程：
用户启动壳 → 单实例检查 → 无 overlay 则走 S2 首装 → spawn dsh 子进程
→ 就绪行出现 → HTTP 探测 200 → 壳框架就绪 → WebContentsView 嵌入官方 UI（右侧内容区）→ 可用
dsh 崩溃 → 提示 + 可选重启
用户退出 → 先停 dsh 子进程 → 退出壳

### 状态转换（dsh 运行时状态机）

| 当前状态 | 动作 | 目标状态 | 前置条件 | 冲突行为 | 依据 |
|---|---|---|---|---|---|
| idle | start() | starting | overlay 存在 | 无 | 共识 §4.2 |
| starting | 就绪判定成功 | ready | 就绪行+HTTP 200 | 重复 start 忽略 | §4.2 |
| starting | 超时（60s） | failed | 超时 | 提示重试 | §4.2 |
| starting | 子进程非预期退出 | failed | 子进程在 starting 中退出 | 立即 failed，不等超时 | §4.2 |
| ready | 崩溃事件 | failed | 子进程退出非预期 | 提示+可选重启 | §4.2 |
| ready | restart() | starting | 用户/升级触发 | 停旧起新 | §4.2 |
| failed | start()（重试） | starting | 用户点重试 | 无 | §4.2 |
| 任意状态 | stop() | idle | starting 中 stop = 杀进程组+清理，不等就绪 | 幂等（重复 stop 忽略） | #2 |

## 接口清单

| # | 状态 | 接口 | 用途 | 调用方 | 幂等 |
|---|---|---|---|---|---|
| 1 | NEW | RuntimeManager.start() | 启动/重启 dsh 子进程 | 主进程/Updater | 是（starting 中重复 start 忽略；ready 中先停后起=restart；failed 中直接起） |
| 2 | NEW | RuntimeManager.stop() | 停止子进程 | 退出流程/Updater | 是 |
| 3 | NEW | RuntimeManager.snapshot() | 读取运行快照 | 设置页/托盘 | 是 |
| 4 | NEW | RuntimeManager.on(status) | 状态变更通知 | 托盘/壳框架标题栏 | 无 |
| 5 | NEW | ReadinessProbe(target?, timeout?, interval?) → probe() | 就绪判定 | start() | 是 |
| 6 | NEW | SingleInstance.lock() | 单实例锁 | 启动入口 | 是 |
| 7 | NEW | hull.retry() / hull.openLogs()（preload 桥） | 失败态重试 / 打开日志目录 | 壳框架占位页（右侧内容区） | 是 |

## Schema 与枚举

### RuntimeSnapshot

| 字段 | 类型 | 必填 | 可空 | 约束 | 说明 |
|---|---|---|---|---|---|
| phase | enum | 是 | 否 | idle/starting/ready/failed | 运行阶段 |
| message | string | 是 | 否 | ≤200 字符 | 状态说明（用户可见） |
| launchDirectory | string | 否 | 是 | 绝对路径 | 启动工作目录 |
| url | string | 否 | 是 | http://127.0.0.1:端口 | 就绪后的 Web 地址 |

### 就绪行协议（dsh ↔ 壳）

| 项 | 值 |
|---|---|
| 格式 | 正则 ^dsh web: (http://127.0.0.1:[0-9]+)（与社区实现一致，转义写法按实现约定） |
| 来源 | 子进程 stdout/stderr |
| 超时 | 60s（可注入，CON-R015/Q-010） |
| 二次确认 | 就绪行出现后，探测在固定 15s 窗口内周期重试（成功即 ready）；窗口耗尽 → failed（15s 为常量，不注入配置） |

> 语义固化：注入目标仅作用于探测；WebContentsView 嵌入目标恒用就绪行提取的 URL（原 loadURL 语义随主窗口形态变更迁移，共识 v1.5）。就绪行超时预算（60s）与探测预算（15s）分离。

## 接口详情

### 1. RuntimeManager.start()

- 使用场景：应用启动、崩溃重启、升级后重启
- 共识：CON-R001/015
- 输入：无（配置取自 SettingsProvider）
- 注记（S4 变更传播）：SettingsProvider 由 S1 只读扩展为 S4 写——字段清单：closeToQuit/schemaVersion（S1）+ channel/pinnedVersion（S4，v0.2 契约）；本接口输入语义不变（配置仍经 SettingsProvider 读取，RuntimeManager 零改动）
- 行为：spawn（`node --expose-internals <dsh> web --host 127.0.0.1 --port 0`；--expose-internals 为 node flag，须在脚本名之前）→ 解析就绪行 → HTTP 探测 → 状态 ready
- 注记（2026-08-18 M1 验收实测修复）：dsh CLI 的 `web` 子命令即 `--profile web` 别名，`--profile` 是顶层选项，不能跟在 web 后（实测 dsh 0.1.0-rc.7 报 unknown option '--profile'）——spawn 参数不含 `--profile web`
- 输出：Promise(RuntimeSnapshot)
- 异常：start-timeout（超时）、spawn-failed（子进程启动失败）、dsh-missing（overlay 不存在，交 S2）、child-exited（子进程在 starting 中退出，立即 failed）
- 注：S1 阶段解析器按注入顺序解析：`HULL_NODE_PATH` env → `<userData>/node/bin/node` 捆绑路径探测 → PATH 兜底；S2 交付捆绑 Node 后收口为捆绑路径。属交付分期，终态行为一致。

### 2. 托盘基础（TrayController）

- 菜单项：打开主窗口 / Hull 设置… / 退出（先停 dsh）
- 关闭主窗口：默认隐藏到托盘（closeToQuit=false）
- 注记（共识 v1.5 主窗口形态）：托盘为补充入口，以壳左侧导航为主——设置/升级入口主位在壳框架导航

### 5. ReadinessProbe

- 形态：复合探测器——构造注入 + 探测方法（与设计 §3 形态一致）
- 构造参数：target（探测目标，env 注入 `HULL_PROBE_TARGET`）、timeout（就绪行超时预算，env 注入 `HULL_READY_TIMEOUT_MS`）、interval（探测周期）
- 探测方法：probe()——就绪行出现后，在固定 15s 窗口内周期重试（成功即 ready）；窗口耗尽 → failed
- 解析：双流（stdout/stderr）就绪行解析
- 幂等：是

### 7. Preload 桥

- hull.retry()：失败态重试（等价调用 start()）
- hull.openLogs()：打开日志目录
- 注：preload 仅挂载壳自有占位页（file: 协议，显示于壳框架右侧内容区）；官方 UI（WebContentsView 内嵌）加载时不挂 preload（零注入，CON-R001）

## 联调与测试场景

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| T1-01 | 冷启动验收 | 已有 overlay，计时从启动到 UI 可交互 | 总时长 ≤10s（含 dsh 启动，Q-009） |
| T1-02 | 退出零残留 | 退出壳后 ps 检查 | 无 dsh/node 残留进程 |
| T1-03 | 单实例 | 启动第二个实例 | 唤醒第一个并退出 |
| T1-04 | dsh 崩溃 | kill 子进程 | 提示 + 可选重启 |
| T1-05 | 就绪注入 | 探测目标指向坏地址 | 走超时→failed 路径（Q-010） |
| T1-06 | 关闭隐藏 | 点关闭按钮 | 窗口隐藏、dsh 继续运行 |

## 开放问题

- W1（P2，实现时处理）：错误语义码建议抽成具名错误集，与 S2/S3 命名风格统一。非阻断。

## 协调事项

- 无跨团队协调（solo）

## 完成记录

- 契约草案生成（2026-08-14），待评审

## 决策与踩坑

- 就绪判定用"就绪行+HTTP 探测"双确认（Q-009），避免白屏
- 探测目标/超时可注入（Q-010），测试无需改业务代码

## 变更记录

- 2026-08-18：变更传播（主窗口形态变更，共识 v1.5）：主窗口改壳框架窗口——左侧 Hull 导航 + 右侧内嵌官方 UI（WebContentsView 零注入；实现形态以技术方案为准，契约层只定义行为）；loadURL 语义迁移为 WebContentsView 嵌入（恒用就绪行 URL）；占位页（starting/installing/failed/not-installed）显示于壳框架右侧内容区；托盘定位为补充入口（壳导航为主）。升 v0.3
- 2026-08-14：评审修订（7 项封口：状态迁移补全、探测语义 15s 窗口、Node 来源注记、start 幂等澄清、Probe 复合签名、preload 桥、web 子命令入参），升 v0.2
- 2026-08-14：新建契约（草案）

## 自检记录

- 追踪矩阵完整；状态机含冲突行为；异常/测试场景齐备；无 TBD
