# Hull 桌面壳（M1）共识文档

> 版本：v1.0-草稿 · 更新：2026-08-14 · 维护者：phper666（PM） · 状态：草稿
> 数据来源：M1 PRD（docs/prd/2026-08-14-m1-prd.md，含 7 项需求决策）、交互原型 v2（docs/prototype/index.html）

## 1. 文档元信息

- **本版本变更**：首次建立——从 PRD + 原型提取整理为业务事实源；登记 3 项未决项（U-001~U-003）。
- **历史变更摘要**：（无）

## 2. 文档结构总览

- **覆盖**：Hull 桌面壳 M1 全部业务面——壳骨架（进程管理/窗口/托盘/日志）、dsh 运行时管理（捆绑 Node/overlay/首次安装）、双通道升级（dsh npm overlay + Hull electron-updater）、壳设置页、会话状态桥（FR-9）。
- **适用范围**：仅 Hull 应用自身业务；**不覆盖** dsh 官方业务（会话内容、agent 行为、官方 UI 内部），那些是 dsh 的领域，Hull 只做容器与宿主。
- **不做事项（M1 明确排除）**：任务看板（M2+）；三平台打包（仅 macOS Apple Silicon，代码跨平台友好）；Apple 公证/签名；官方 UI 内的壳集成（L1 插件桥）；多实例/多 profile 管理；dsh 内部业务逻辑的任何修改。

## 3. 模块概述

- **定位**：围绕官方 DeepSeek Harness 的桌面开发工具，纯壳——不 fork/patch/替换 dsh，官方升级自动生效。
- **业务目标**：① 装壳即用（自动装 dsh）；② 壳内完成 dsh 升级与回滚；③ 壳自身可升级；④ 用户数据全程官方化（DSH_HOME 不动）。
- **参与角色**：当前 solo（pm/be/fe/qa = phper666）；用户是唯一操作者。
- **子模块清单**：壳骨架（进程/窗口/托盘）、dsh 运行时管理、升级编排（dsh 通道）、壳自更新（Hull 通道）、壳设置页、会话状态桥插件。

## 4. 业务流程与状态机

### 4.1 启动流程

```
壳启动 → 单实例检查 → 确保 overlay（无 → FR-2 首次安装）→ spawn dsh 子进程
→ 解析就绪行（"dsh web: http://127.0.0.1:<port>"）→ 主窗口 loadURL → 可用
失败分支：就绪超时（60s）→ 失败态 + 日志 + 重试按钮；dsh 崩溃 → 提示 + 可选重启
```

### 4.2 dsh 运行时状态机

| 状态 | 含义 | 合法迁移 |
|:-----|:-----|:---------|
| idle | 未启动 | → starting |
| starting | spawn 等待就绪 | → ready / failed |
| ready | 就绪可用 | → starting（重启）/ failed |
| failed | 启动失败/崩溃 | → starting（重试） |

### 4.3 升级状态机（dsh 通道）

| 状态 | 含义 | 合法迁移 | 触发条件 |
|:-----|:-----|:---------|:---------|
| idle | 无升级动作 | → checking | 手动检查 / 自动检查发现新版 |
| checking | 查 registry | → confirm / idle | 有新版本 / 无新版本或出错 |
| confirm | 弹确认框 | → queued / idle | 用户确认 / 稍后再说 |
| queued | 等会话结束 | → installing / idle | 会话空闲（FR-9 桥）/ 用户取消 |
| installing | staging 安装 | → swapping / idle | 安装完成 / 用户取消或失败 |
| swapping | 停子进程+原子替换 | → verifying / idle | 替换完成 / 失败（回滚或保持） |
| verifying | 新版本重启验证 | → idle（成功）/ rollback | 就绪行出现 / 超时 |
| rollback | 换回 dsh-previous | → idle | 回滚完成 |

冲突行为：升级进行中用户再次触发检查 → 忽略或提示"升级进行中"；升级队列单槽，Hull 通道与 dsh 通道互斥（一个排队时另一个入口禁用）。

### 4.4 壳升级流程（Hull 通道）

检查（GitHub Releases）→ 确认（版本+变更说明）→ 下载（进度）→ 提示重启安装 → 用户确认 → 先停 dsh 子进程 → quitAndInstall。无公证限制：更新后启动可能被 Gatekeeper 拦，弹窗引导放行。

## 5. 角色与权限矩阵

| 操作 | 用户 | 壳（系统） | 说明 |
|:-----|:-----|:-----------|:-----|
| 检查 dsh 更新 | ✅ 设置页按钮 | ✅ 启动自动（开关默认开） | — |
| 确认升级 | ✅ 唯一入口 | ❌ 不自动升级 | 应用前必须用户确认（CON-R009） |
| 取消排队/升级 | ✅ | — | — |
| 回滚 dsh | ✅ 设置页按钮 | ✅ 自动回滚（验证失败） | — |
| 检查 Hull 更新 | ✅ 设置页按钮 | ✅ 启动自动（开关默认开） | — |
| 重启安装 Hull | ✅ 确认后 | 执行 | — |
| 修改设置 | ✅ | — | — |

## 6. 字段业务定义

| 字段 | 语义 | 必填 | 来源 | 枚举/默认 | 敏感性 |
|:-----|:-----|:-----|:-----|:----------|:-------|
| settings.autoCheckDsh | dsh 自动检查开关 | 是 | 用户 | 默认 true | 无 |
| settings.autoCheckHull | Hull 自动检查开关 | 是 | 用户 | 默认 true | 无 |
| settings.closeToQuit | 关闭窗口时退出 | 是 | 用户 | 默认 false（隐藏托盘） | 无 |
| settings.registry | npm registry | 是 | 用户 | 默认 https://registry.npmjs.org | 无 |
| overlay 目录 | 当前 dsh 运行时 | — | 系统 | <userData>/dsh | 无 |
| DSH_HOME | dsh 用户数据 | — | 系统 | 默认 ~/.dsh（不覆盖） | 敏感（API key）——壳不读写 |
| 会话忙碌状态 | 是否有活动回合 | — | FR-9 桥 | busy/idle | 无 |

## 7. 业务规则清单

| 编号 | 规则描述 | 来源 | 当前结论 | 变更状态 |
|:-----|:---------|:-----|:---------|:---------|
| CON-R001 | 纯壳：永不 fork/patch/替换 dsh 及官方 Web UI | PRD §3.1 | 生效 | 稳定 |
| CON-R002 | 数据官方化：DSH_HOME 内容壳绝不读取改写 | PRD §3.2 | 生效 | 稳定 |
| CON-R003 | 双升级通道独立：dsh（npm overlay）与 Hull（electron-updater）互不阻塞 | PRD §3.3 | 生效 | 稳定 |
| CON-R004 | 增量层：壳内功能必须走官方扩展点（--patch / plugin add / dsh.client） | PRD §3.4 | 生效 | 稳定 |
| CON-R005 | 升级原子性：staging→原子替换→就绪验证→失败自动回滚 | PRD §3.5 | 生效 | 稳定 |
| CON-R006 | M1 平台：仅 macOS Apple Silicon，代码跨平台友好 | PRD §6 | 生效 | 稳定 |
| CON-R007 | Node 运行时：捆绑独立 Node（^22.19 || >=24），不依赖用户环境 | PRD §8 | 生效 | 稳定 |
| CON-R008 | dsh 首次获取：首次运行自动安装 @latest 到 overlay | PRD FR-2 | 生效（版本策略见 U-001） | 稳定 |
| CON-R009 | 升级触发：设置可配置；应用前必须用户确认 | PRD FR-3 | 生效 | 稳定 |
| CON-R010 | 升级/回滚/卸载不触碰 DSH_HOME | PRD §3 | 生效 | 稳定 |
| CON-R011 | 会话保护：dsh 升级须等当前活动回合结束（排队，可取消） | PRD FR-4（决策 #2） | 生效（忙碌判定见 U-003） | 稳定 |
| CON-R012 | 双通道互斥：dsh 升级与 Hull 升级同一时间只允许一个排队 | PRD FR-10 | 生效 | 稳定 |
| CON-R013 | registry 通用：支持任意 npm registry（官方/镜像/私有源） | PRD FR-3（决策） | 生效 | 稳定 |

## 8. 枚举值与常量

- 忙碌判定事件：turn/start、turn/end（官方 session/event 订阅面；边界见 U-003）
- 就绪超时：60s；启动编排目标 <1s 开销
- 日志保留：滚动最近 3 个 dsh 日志
- 升级确认信息：版本对比 + 变更说明（npm registry / GitHub Releases 获取，缺失降级为纯版本对比）
- dsh 版本语义：npm dist-tag latest = 0.1.0-rc.6（2026-08-14 实测）

## 9. 第三方对接

| 外部系统 | 用途 | 关键点 |
|:---------|:-----|:-------|
| npm registry（官方/镜像/私有源） | dsh 版本检查（npm view）+ 安装/升级（npm install） | 地址可配置（CON-R013）；断网优雅降级 |
| GitHub Releases | Hull 自更新分发 | electron-builder latest-mac.yml；需 repo release workflow + GH_TOKEN（开工前准备项） |
| nodejs.org（或镜像） | 构建时下载捆绑 Node | 构建期依赖，非运行期 |
| dsh 进程（loopback） | FR-9 会话状态桥 + ready 行解析 | 只读；插件走官方 --patch 挂载 |

## 10. 未决项登记

| 编号 | 问题 | 负责人 | 阻断等级 | 状态 | 结论 | 回写位置 |
|:-----|:-----|:-------|:---------|:-----|:-----|:---------|
| U-001 | 首次安装/升级的 dsh 版本策略：@latest 随 rc 漂移（可能升到破坏性版本）vs 固定已验证版本+手动解锁 | PM | P1 | open | — | §7 CON-R008 |
| U-002 | 升级失败重试策略：自动重试一次 vs 纯手动（当前回滚后即结束） | PM | P2 | open | — | §4.3 rollback |
| U-003 | "忙碌"语义边界：仅活动 turn（turn/start→turn/end）vs 含 pending work/inbox/后台 jobs | PM | P1 | open | — | §8 忙碌判定 |

## 11. 页面交互规范

| 页面 | 角色 | 功能 | 权限 | 数据范围 |
|:-----|:-----|:-----|:-----|:---------|
| 主窗口 | 用户 | 渲染官方 UI（壳零注入）；标题栏显示 dsh 版本/状态 | 全量 | 官方数据 |
| Hull 设置 | 用户 | dsh 运行时区块（版本/检查/回滚）+ Hull 应用区块（版本/检查/自动开关）+ 通用设置（registry/关闭即退出）+ 诊断（日志/数据目录） | 全量 | 壳数据 |
| 托盘 | 用户 | 打开主窗口/设置/检查 dsh 更新/退出 | 全量 | — |
| 弹窗 | 用户 | 升级确认（版本+变更）、进度（可取消）、排队提示、回滚提示、重启安装提示 | 确认类 | — |

## 12. 后端任务规范

- **DshRuntimeManager**：spawn（捆绑 Node + --expose-internals + --profile web + --host 127.0.0.1 + --port 0）→ 解析就绪行 → 守护 → 退出清理（进程组/启动兜底）。
- **Updater（dsh 通道）**：checking → staging 安装（npm install 到 dsh-staging，可取消）→ 停子进程 → 原子替换（dsh→dsh-previous，staging→dsh）→ 重启验证 → 失败自动回滚。
- **Updater（Hull 通道）**：electron-updater 检查/下载/quitAndInstall；重启前停 dsh。
- **FR-9 状态桥插件**：随壳分发，--patch 挂载；订阅 ctx.on('session/event') 跟踪 turn/start·turn/end，loopback 暴露 busy/idle 给壳；只读，可摘除（CON-R004）。
- **单实例**：启动锁，第二个实例唤醒第一个。

## 13. 端差异汇总

| 项 | macOS（M1） | Windows/Linux（非 M1，代码预留） |
|:---|:------------|:-------------------------------|
| 打包 | dmg（无公证，Gatekeeper 引导） | 后续里程碑 |
| 进程树清理 | 进程组 | 需 taskkill /T /F 分支 |
| 路径 | path.join | win32 分支预留 |
| dsh patch 参数 | 无 | Windows 目录选择器 patch（社区经验） |

## 14. 附录与版本记录

- **关联**：PRD（docs/prd/2026-08-14-m1-prd.md）、原型（docs/prototype/index.html）、规则索引（docs/spec/规则索引.md）、团队配置（docs/spec/团队配置.md）
- **版本记录**：v1.0-草稿（2026-08-14）：首次建立。
