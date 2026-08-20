# S2 dsh 运行时管理契约

## 契约信息

- 工作项：S2 dsh 运行时管理（飞书 dsh-hull-desktop 清单）
- 契约状态：已冻结
- 版本：v0.4（变更传播）
- 适用版本：M1（共识 v1.5）
- 最后更新：2026-08-18

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| 捆绑 Node | S2 | CON-R007 | Node 24 LTS，构建锁定小版本 | 构建脚本 fetch-node | 已定义 |
| overlay 管理 | S2 | CON-R008 | dsh/staging/previous 布局 | OverlayManager | 已定义 |
| 首次安装 | S2 | CON-R008/016 | 全新机器首开自动装 dsh | OverlayManager.install() | 已定义 |
| 取消引导态 | S2 | CON-R016 | 取消→未安装引导态→重装 | InstallFlow.cancel() | 已定义 |
| 数据零接触 | S2 | CON-R002/010 | DSH_HOME 不读不改 | 环境变量传递 | 已定义 |

## 范围与非目标

### 范围

- 捆绑 Node 24 LTS（构建时下载，锁定小版本，跟随官方 engines ^22.19 或 >=24）
- overlay 目录布局：userData/dsh（当前）、userData/dsh-staging（安装中）、userData/dsh-previous（上一版）
- 首次安装流程：npm install @deepseek-ai/dsh@目标版本 到 staging → 原子替换 → 启动
- 取消安装 → 未安装引导态（壳框架右侧内容区显示安装按钮）
- DSH_HOME 默认 ~/.dsh（环境变量透传，壳零读写）

### 非目标

- 升级编排（S3，复用 overlay 与安装逻辑）
- 版本通道选择（S4；S2 安装时用默认 latest）
- 多 profile / 多实例数据管理

## 业务流程与状态

### 核心流程

文本流程：
启动 → OverlayManager.ensure()
  有 overlay → S1 启动
  无 overlay → **自动触发** InstallFlow 安装（进度可观察、可取消）→ 原子替换 → 就绪 → S1 启动
  用户取消 → 清理 staging → 未安装引导态（壳框架右侧内容区安装 dsh 按钮 → 手动重装重新走本流程）

### 状态转换（安装流程）

| 当前状态 | 动作 | 目标状态 | 前置条件 | 冲突行为 | 依据 |
|---|---|---|---|---|---|
| not-installed | install() | installing | 无 | 自动触发 + 手动重装均可（重复 install 忽略） | 共识 §4.1 |
| installing | 安装成功 | ready | staging 就绪+替换成功 | 无 | 无 |
| installing | 取消/失败 | not-installed | 用户取消或错误 | 清理 staging | Q-011 |
| not-installed | 引导态重装 | installing | 用户点安装按钮 | 无 | Q-011 |

## 接口清单

| # | 状态 | 接口 | 用途 | 调用方 | 幂等 |
|---|---|---|---|---|---|
| 1 | NEW | OverlayManager.ensure() | 检查/创建 overlay | 启动流程 | 是 |
| 2 | NEW | OverlayManager.install(targetVersion) | 仅安装到 staging（含校验） | InstallFlow | 是（失败清 staging） |
| 3 | NEW | OverlayManager.cancelInstall() | 取消安装 | 用户 | 是 |
| 4 | NEW | InstallFlow.on(progress) | 安装进度（main 侧事件） | 设置页/首启页 | 无 |
| 5 | NEW | OverlayManager.currentVersion() | 读取当前版本 | 设置页 | 是 |
| 6 | NEW | OverlayManager.installStatus() | 轮询安装进度（phase+pct） | 首启页/设置页 | 是 |
| 7 | NEW | hull:install（IPC 通道） | 触发首装 | 首启页 | 是 |
| 8 | NEW | hull:cancelInstall（IPC 通道） | 取消安装 | 首启页 | 是 |
| 9 | NEW | OverlayManager.swap() | 原子替换 staging→dsh + 版本校验 + post-swap bin symlink | InstallFlow / S3 SwapManager | 是 |
| 10 | NEW | OverlayManager.swapBack() | 回滚反向原语：rename dsh→dsh-staging（保留现场）+ rename dsh-previous→dsh | S3 Updater.rollback | 是（无 previous → 错误语义） |

> 进度通道 = `installStatus()` 轮询（非事件推送；preload 不透传回调，与 S1 #7 桥同约束）。

## Schema 与枚举

### overlay 目录布局

| 路径 | 用途 | 生命周期 |
|---|---|---|
| userData/dsh/ | 当前生效运行时（node_modules + package.json） | 常驻 |
| userData/dsh-staging/ | 安装中的新版本 | 安装后删除/改名 |
| userData/dsh-previous/ | 上一版本（回滚素材） | 下次成功升级时覆盖 |

### 安装事件

| 事件 | 载荷 | 说明 |
|---|---|---|
| installing | phase(download/npm-install/swap) + pct | 进度 |
| success | version | 完成 |
| cancelled | 无 | 用户取消 |
| failed | code + message | 失败（错误码见下） |

### 错误集 INSTALL_ERRORS

| 语义错误码 | 触发条件 | 客户端处理 | 可重试 |
|---|---|---|---|
| registry-unreachable | registry 不可达/超时（npm 错误码 ECONNREFUSED/EAI_AGAIN/ETIMEDOUT/ENOTFOUND/ECONNRESET，或 --fetch-timeout=30000 触发） | 提示 + registry 配置入口 | 是 |
| npm-install-failed | npm install 非零退出（非网络类错误码） | 按钮下方失败提示 | 是 |
| disk-insufficient | 安装前预检磁盘不足 | 明确提示 | 否（清磁盘后是） |
| cancelled | 用户取消 | 进入未安装引导态 | 是 |
| version-invalid | 目标版本号非法/不存在/staging 门禁不通过 | 校验拦截（S4 提供列表） | 否 |
| runtime-unavailable | 捆绑 node 解压失败/缺失（prod 装配失败） | 提示（修复后重试） | 是 |

## 接口详情

### 1. OverlayManager.install(targetVersion)

- 使用场景：首次安装、S3 升级复用（同一套 staging 逻辑）
- 共识：CON-R008/016
- 输入：targetVersion（默认 latest，S4 决定）
- 行为：npm install @deepseek-ai/dsh@targetVersion（捆绑 npm，registry 可配置）到 staging，含 staging 校验（`node_modules/.bin/dsh` 存在 + 包 package.json bin 字段合法）
- 注记（S6 变更传播）：registry 字段落地 settings.json（settings.registry 优先 + HULL_REGISTRY env 兜底）——S2 安装消费点（npmRunner）随字段落地调整读取顺序；代码归 S6 实现波
- 输出：Promise(version)
- 异常：INSTALL_ERRORS 全集（swap 阶段错误归 #9）
- 超时：安装总上限 600s（到期 → npm-install-failed）；npm `--fetch-timeout=30000`

### 2. OverlayManager.swap()

- 使用场景：首次安装提交、S3 升级提交（对齐 S3 契约 #6 SwapManager.swap()，升级流程复用）
- 行为：rm -rf dsh-previous → rename dsh → dsh-previous → rename staging → dsh → 失败回滚（rename dsh-previous → dsh）→ post-swap 建 symlink `<dsh>/bin/dsh` → `<dsh>/node_modules/.bin/dsh`（S1 spawnArgs 零改动）→ 版本校验（latest 时读实际）
- 输出：Promise(version)
- 异常：npm-install-failed（替换失败）/ version-invalid
- 取消边界：swap 起始后 cancel 忽略（仅 installing 阶段可取消）

### 3. 取消语义（Q-011）

- 取消点：installing 任意阶段（npm 子进程 kill + staging 清理；cancelled 标志防 npm 非零退出误映射）
- 取消后：未安装引导态（壳框架右侧内容区安装按钮），不提供永久跳过
- 首装回滚失败（无 previous）→ 回 not-installed，cancelled 语义（非 npm-install-failed）

## 联调与测试场景

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| T2-01 | 全新机器首装 | 清空 userData，启动 | 自动安装 dsh，进入官方 UI |
| T2-02 | 取消安装 | 安装中取消 | 未安装引导态；重装成功 |
| T2-03 | 数据复用 | 预置 ~/.dsh（会话/API key） | 安装后直接可用，数据零改动 |
| T2-04 | registry 不可达 | 配错 registry | 失败提示 + 配置入口，重试成功 |
| T2-05 | 断网启动（已有 overlay） | 断网启动 | 正常使用，不检查更新 |
| T2-06 | Node 版本验证 | 构建产物检查 | 捆绑 Node = 24 LTS 锁定版本 |

## 开放问题

- W2（P2，实现时处理）：磁盘预检的包大小估算来源未定义。非阻断。

## 协调事项

- 构建脚本需网络下载 Node（nodejs.org 或镜像），CI 与本机构建需可达

## 完成记录

- 契约草案生成（2026-08-14），待评审

## 决策与踩坑

- Node 选 24 LTS 最新（官方 engines ^22.19 或 >=24；不赌奇数版/最新大版本）
- 安装与升级共用同一套 staging+替换逻辑（CON-R008）
- @deepseek-ai/dsh 包存在性：npm dist-tag latest = 0.1.0-rc.6（2026-08-14 实测，来源共识 §8 枚举值；验证时间点已标注，实现期需重验）

## 变更记录

- 2026-08-18：变更传播（主窗口形态变更，共识 v1.5）：未安装引导态显示位置表述同步——壳框架右侧内容区（原「主窗口」指针性描述，接口语义不变，仅表述微调，共 3 处：范围/核心流程/取消语义）。升 v0.4
- 2026-08-17：变更传播（S3 评审波）：补 #10 `OverlayManager.swapBack()`（回滚反向原语——rename dsh→staging 保留现场 + previous→dsh；调用方 S3 Updater.rollback；幂等，无 previous → 错误语义）。升 v0.3
- 2026-08-17：评审修订（终审裁决）：接口清单补 #6 installStatus（轮询）/ #7 hull:install / #8 hull:cancelInstall / #9 swap；首装自动触发语义（A2）；install/swap 拆分对齐 S3 #6（A3）；错误集复核——原五码 → 加 runtime-unavailable 后 **六码**，registry-unreachable 判定规则注明（A4）；包版本重核引用共识 §8 实测（A5）。升 v0.2
- 2026-08-14：新建契约（草案）

## 自检记录

- 追踪矩阵完整；错误集覆盖 registry/网络/磁盘/取消/运行时装配（六码）；无 TBD
