# 变更摘要-Hull（L2 模块详情）

> Hull 模块（架构/升级/数据/平台/运行时等通用规则 + M1 子需求 S1~S8）变更详情。每条 ≤200 字，delta-only、编号驱动、取代链、反哺 Q-items。最新在前。
> L1 索引：docs/spec/变更摘要.md · 共识：docs/spec/共识-Hull桌面壳-M1.md · 规则索引：docs/spec/规则索引.md

## 2026-08-24 Hull 包管理器支持共识发布 v1.0（新需求 pkgmgr）

- 类型：共识基线发布（新需求建立）+ 登记 CON-R-pkgmgr-001~008
- 内容：**三包管理器支持（npm/pnpm/yarn）**——dsh 安装链路改造；默认 pnpm（冷装 28s vs npm 28min 实测）、设置页选择 + settings 持久化；原生依赖自动 rebuild；spawn 跨平台改造（解析真实 JS 入口 + ELECTRON_RUN_AS_NODE，绕开 .bin shim，适配三端 macOS/Windows/Linux）；取消/错误码三包管理器一致；3 子需求 P1（执行器抽象）/P2（spawn 改造）/P3（settings+设置页+rebuild）；未决项 U-1 自动探测/U-2 bun/U-3 包管理器升级
- 影响：npmRunner 抽象为包管理器执行器；RuntimeManager/buildSpawnArgv spawn 改造（跨平台）；HullSettings 加 packageManager 字段（字段级不 bump schema）；settings 页加选择 UI
- 状态：已发布（2026-08-24，PM）

## 2026-08-24 首装流程需求变更（共识 v1.8）——不再自动触发安装，进引导态手动装

- 类型：需求变更（用户拍板，向后兼容语义调整），升共识 v1.8
- 内容：**首开不再自动触发 InstallFlow 安装 dsh**，改为进「未安装」引导态（`showPlaceholder('not-installed')`）→ 用户点「安装 dsh」→ 手动触发（同一 runInstallFlow 入口）；取消语义保留（Q-011：取消→引导态→重装）；CON-R016 语义扩展（首装取消保留 + 新增「首装需手动确认」）
- 影响：main/index.ts:656 `void runInstallFlow('latest')` → `showPlaceholder('not-installed')`；S2 契约 4 处「自动触发」同步改手动；M1 共识 S2 业务目标/子需求同步；install.spec.ts e2e 首装断言改「进引导态→点装→取消→重装」
- 状态：已实现（2026-08-24，unit 596 + e2e 27 全绿含取消重装路径）

## 2026-08-24 Hull 主题切换共识发布 v1.0（新需求 theme）

- 类型：共识基线发布（新需求建立）+ 登记 CON-R-theme-001~005
- 内容：**壳 UI 主题切换**——仅壳 UI（nav/看板/Skills/设置/编辑器/时间线），官方 dsh Web UI 零注入（CON-R001 不破）；机制 = 硬编码色值抽 CSS 变量（--hull-*）+ 壳根节点 data-theme="dark|light" 切换；本轮暗/亮 2 款，默认 dark 保持现状；设置页主题区块切换即时生效；持久化 settings.json（HullSettings.theme + schemaVersion bump 3→4）；EasyMDE 亮色配套；3 子需求 T1（变量抽取）/T2（持久化+设置页）/T3（编辑器配套）；未决项 U-1 跟随系统/U-2 3+色系/U-3 自定义（P2 排后）
- 影响：SettingsProvider theme 字段级扩展不 bump schemaVersion（BE 扫描修正：对齐 S6 registry 先例，schemaVersion 保持 3，migrate() `<3` 补齐兜底）；kanban.css/skills.css/easymde-dark.css/shell.html 硬编码色值重构；复用 hull:setSettings 无新 IPC 风险面
- 状态：已发布（2026-08-24，PM）

## 2026-08-22 M1-重构迭代调整（共识 v1.7）

- 类型：产品决策修订（用户目验反馈）+ 共识修订 v1.6→v1.7
- 内容：**D4 决策修订**——升级 UI 从独立 upgrade 视图并入设置页，再拆到 **dsh 运行时/Hull 应用区块各自底部**（删独立升级卡）；view 机制 4→3 态（去 placeholder:upgrade）；导航菜单去掉「升级」项，排序 = dsh web / 任务看板 / 设置（设置恒最后）；左下角状态区新增「Hull 版本」行（hull:status payload 加 hullVersion = app.getVersion()）；去任务看板 M2 tag（M2 已交付，历史遗留误导）
- 决策：D4 修订（升级并入设置再拆分到各自区块）/ nav 排序（去升级，设置最后）/ Hull 版本号显示 / M2 tag 清理（2026-08-22 用户目验反馈）
- 红线：CON-R001~R005 全部不破（升级编排层零改动；官方 view 零注入不变；settings 走 hull:setSettings）
- 影响：契约 S3（v0.3→v0.4 UI 载体并入设置）/ S6（v0.4→v0.5 设置含升级区块+nav 排序）/ 方案 §4.1/§4.5/§6/§8 修订
- 状态：代码已实现（commit e825ef1 + 39342a1，测试 467+8+12 全绿），文档同步中

## 2026-08-22 M1-重构登记（共识 v1.6）

- 类型：产品重构登记（挂原 M1 PRD，需求标识 m1refactor）+ 共识修订 v1.5→v1.6
- 内容：M1 增补段「M1-重构」——统一壳内交互模型，壳功能收进主窗口右侧内容区：① S6' 设置页迁移（独立 SettingsWindow → 壳内右侧整页 section，删除独立窗口）；② S3' 升级面板（原生 dialog → 独立 upgrade 右侧视图，dsh/Hull 双通道确认/进度/失败提示收进壳内统一模式，升级原子性逻辑零改动）；③ S8' view 机制 2→4 态（official/board/settings/upgrade，hull:status payload + nav 高亮回写）；④ 托盘保留补充入口（聚焦主窗口 + 切视图，D5）
- 决策：D1 整页 section 收右侧 / D4 独立 upgrade 视图 / D5 保留托盘补充入口（2026-08-22 用户拍板）
- 红线：CON-R001~R005 全部不破（UI 载体迁移不触碰主进程编排层；官方 view 零注入结构不变）
- 判级：复杂+安全敏感（跨模块 S6/S3/S8 + view 状态机 + preload 拓扑安全面）
- 影响：契约 S6/S3/S8 波及（变更传播待跑）；子需求 S6'/S3'/S8' 已登记 §14.1-R，走 feature/m1refactor 分支
- 状态：共识已登记，待拆契约 + 技术方案

## 2026-08-18 S8 主窗口壳框架实现完成（共识 v1.5）

- 类型：实现完成 + 影响闭环
- 内容：壳框架窗口（左 Hull 导航 + 右 WebContentsView 内嵌官方 UI）实现完成——WindowManager 重构（partition 'shell' + 官方默认 session 隔离、registerPreloadScript 机制删除、hull:status 推送）、shell.html 新增、preload 9 方法、升级/设置入口接线、placeholder.html 删除
- 验证：222 单测 + 8 集成 + 8 e2e 全绿（冷启动 1853ms）；Semgrep 0 findings；Code Review 修复闭环
- 影响：影响清单-S8.md 全部闭环；契约 S1 v0.3/S2 v0.4/S6 v0.3/S7 v0.3 已同步
- 状态：完成

## 2026-08-18 主窗口形态变更（共识 v1.5）

- 类型：产品决策变更（用户拍板）+ 共识修订 v1.4→v1.5
- 内容：主窗口从"全屏渲染官方 UI"改为"壳框架窗口：左侧 Hull 导航 + 右侧 WebContentsView 内嵌官方 UI"；壳层功能入口（设置/升级）以壳导航为主、托盘为补充；官方 UI 零注入原则不变（CON-R001 解释扩展，非规则变更）
- 影响清单：docs/spec/影响清单-S8.md
- 状态：共识 v1.5 已修订，影响已闭环（S8 实现完成）

## 2026-08-18 M1 验收实测修复（变更传播）

- 类型：M1 验收实测修复变更传播（3 个实现 bug；代码已改、测试已同步）
- 内容：① spawn 参数去 `--profile web`——真实 dsh CLI（0.1.0-rc.7）实测 `web` 子命令即 `--profile web` 别名，`--profile` 是顶层选项不能跟在 web 后；DSH_CLI_SIGNATURE 同步 ② npm install 超时 120s→600s——实测冷装 dsh 234s（254 包/301MB）；NPM_INSTALL_TIMEOUT_MS 同步 ③ npm-cli 相对路径解析——npmRunner 构造时 resolveExecutablePath() 将相对 nodePath 解析为绝对路径（PATH 查找）
- 影响：S1 契约/设计（spawn 参数修正）、S2 契约/设计（超时 120s→600s）、S7-测试验收-m1-design + S7-m1-record（fake-dsh 参数同步）、代码已改、测试 219 单元 + 8 集成全绿
- 状态：实测验收通过

## 2026-08-17 S7 v0.2（评审修订 + 变更传播）

- 类型：S7 契约 v0.2 + 设计 0.2 评审修订（封口 6 项 + 修订后冻结）+ 变更传播（S1 [timing] 埋点对齐核验 + 指针）
- 内容：契约——指针升共识 v1.4；U3-02 修订（idle→rollback 归合法，S3 D7 W3 手动回滚承载）；vitest 裁决（沿用 node:test）；E2E 场景补全（E2E-06 托盘 + E2E-07+ 设置页）；verify-acceptance 表述修正（不启动 electron）；封口声明。设计——验收口径 E2E-01 权威；[timing] 埋点格式锁定（t3 名为 ready）；集成 spawn 双路（spawnFn DI 主路 + symlink 补验）；verify-acceptance 失败处理；e2e userData 隔离（--user-data-dir，CON-R002 精神）；e2e 骨架推迟注记
- 影响：S1 [timing] 埋点对齐核验（已实现：RuntimeManager t0/t1/t2/t3 + WindowManager t4，零改动）；代码零改动声明；共识指针 v1.4
- 状态：复评通过，已冻结；无 P0/P1 残留

## 2026-08-17 S6 v0.2（评审修订 + 变更传播）

- 类型：S6 契约 v0.2 + 设计 0.2 评审修订（封口 5 项 + 修订后冻结）+ 变更传播（S4 L21 回改 / S2 偏离 3 修订 / S3/S4 registry 消费注记 / 指针）
- 内容：契约——SETTINGS_ERRORS persist-failed ≡ settings-write-failed 别名；托盘仅「检查 dsh 更新」Hull 入口不入托盘；registry 字段落地三消费点「settings 优先 env 兜底」；封口声明。设计——设置窗口独立 partition 'settings' + preload 独立挂载；250ms 轮询 getSettings + 删页面订阅；maybeAutoCheck 补 autoCheckDsh 门控 + maybeAutoCheckHull；schemaVersion 迁移（<3 字段补齐 + 损坏备份）；双入口并发 queue-busy 注记；UI 四卡 + token 表 + 560×640 + a11y
- 影响：S4 契约 L21 回改（env 承载 → settings 字段落地 + listVersions 消费注记）；S2 设计偏离 3 修订（settings 优先 env 兜底）；S3 契约 check 消费点注记；代码零改动声明；共识指针 v1.4
- 状态：复评通过，已冻结；无 P0/P1 残留

## 2026-08-17 S5 v0.2（评审修订 + 变更传播）

- 类型：S5 契约 v0.2 + 设计 0.2 评审修订（封口 6 项 + 修订后冻结）+ 变更传播（S3 DismissStore/autoCheckDsh + S4 schema 协同 + S1 勘误 + S2-record C3 关闭）
- 内容：契约——T5-05 改「安装前预防提示 + README 引导」删安装后检测/flag；接口补 #5 HullUpdater.cancel()（CancellationToken，仅 downloading 可取消）；restart-prompt 枚举保留 + 语义注记；状态表补 checking→idle；封口声明。设计——删 Gatekeeper flag 改预防性提示；互斥 check/download/installAndRestart 全占槽 + 单次 acquire 连续持有至终态；installAndRestart 补 stop 失败分支；electron-updater 改 dependencies；extractNode 打包接线定案 a（extraResources + runtime seam）；cancel() 设计；DismissStore 双键 { dsh?, hull? }
- 影响：S3 契约/设计（DismissStore 分通道 + autoCheckDsh 落地注记）；S4 契约（schema 协同：autoCheck* 同批，schemaVersion 定 3）；S1 设计（§5.1 dismiss.json 双键勘误）；S2-record（C3 关闭：打包专项并入 S5）；代码零改动声明；共识指针 v1.4
- 状态：复评通过，已冻结；无 P0/P1 残留

## 2026-08-17 S4 v0.2（评审修订 + 变更传播）

- 类型：S4 契约 v0.2 + 设计 0.2 评审修订（终审裁决封口 8 项 + 修订后冻结）+ 变更传播（S1 勘误 / S3 注记 / 三契约指针）
- 内容：契约——#3 resolveTarget 使用场景改「Updater.upgrade 前（默认目标），解锁升级显式传参绕过」；#5 VersionCompare ≡ S3 semver.compareVersions + 离线锁定边界注记；Settings.registry 行删改 + HULL_REGISTRY env 承载注记；IPC 预留（hull:getChannel/setChannel/listVersions 三通道，S6 启用）；#1/#2/#4 调用方时序注记。设计——check 恒 latest 字面化 + upgrade 默认 resolveTarget/显式绕过；upgrade guard「目标 == 当前版本 → 拒绝」；set('latest') 显式清 pinnedVersion 同事务原子写；写失败内存态丢弃 + get() 恒读磁盘权威；schemaVersion bump 策略；离线 set('pinned') 边界注记
- 影响：S1 设计勘误（§5.1 schema 表扩展 + 写路径修订）；S1 契约（SettingsProvider 描述行注记）；S3 契约（#1/#2 行为注记）；代码零改动声明；共识指针 v1.4
- 状态：复评通过，已冻结；无 P0/P1 残留

## 2026-08-17 S3 v0.2（评审修订 + 变更传播）

- 类型：S3 契约 v0.2 + 设计 0.2 评审修订 + S2/S1 文档勘误变更传播（终审裁决 14 项 + 修订后冻结）
- 内容：契约——补 #8 Updater.canRollback()、#1/#4 调用方时序注记（S3 先行 main/托盘 + dialog，S6 接线设置页）、T3-05 分期标注、version-invalid 双触发点。设计——upgrade 伪码 swap 后 phase 校验；verify 合并进 start()；HULL_PROBE_TARGET 注入生命周期两段；手动回滚 ready 态三步；swapBack 新原语（非复用 S2 rollbackSwap）；swap-broken 先读 phase 映射；registry URL 编码 + CHECK_TIMEOUT_MS=10s + abort；changeNotes 可空不建 GitHub 拉取；回滚后 currentVersion 回写；SwapManager 收敛纯映射薄层
- 影响：S2 契约 v0.3（#10 swapBack）；S2 设计勘误（swapBack 列模块表/§4）；S2-record 登记；S1 设计勘误（§5.1 补 dismiss.json，S1 代码零改动）；S1/S2 代码零改动声明；共识指针 v1.4
- 状态：复评通过，已冻结；无 P0/P1 残留

## 2026-08-17 S2 v0.2（评审修订）

- 类型：S2 契约 v0.2 + 设计 0.2 评审修订（终审裁决 8 项 + 修订后冻结）
- 内容：接口补 #6 installStatus（轮询进度）/ #7 hull:install / #8 hull:cancelInstall / #9 swap（install/swap 拆分，对齐 S3 契约 #6）；首装自动触发语义（无 overlay 自动安装，取消后才进引导态）；post-swap bin symlink（`<dsh>/bin/dsh` → node_modules/.bin/dsh，S1 spawnArgs 零改动）；取消仅 installing 可取消 + cancelled 标志；npm 超时 120s 常量 + `--fetch-timeout=30000`；错误集五码→六码（+runtime-unavailable）；ensure() 三态（Q-004/CON-R014，T3-03 对齐）；registry env 化（HULL_REGISTRY，settings schema 不动）；spawn 非 detached + npmRunner 内联 kill；fetch-node SHA256 校验
- 影响：S1 零改动声明（symlink 方案保证 spawnArgs 不用改）；S3 零改动协调注记（install/swap 拆分后对齐契约 #6）；共识指针 v1.4
- 状态：复评通过，已冻结；无 P0/P1

## 2026-08-14 v1.4

- 类型：S1 契约 v0.2 + 共识 v1.4 评审修订
- 内容：7 项契约封口（状态表补 starting 子进程退出→failed / stop()→idle 两行迁移、探测语义改固定 15s 窗口周期重试、Node 来源注记、start 幂等澄清、ReadinessProbe 复合签名、preload 桥 #7、web 子命令入参）+ 3 项共识回写（Q-009 探测语义、§4.2 迁移补充、preload 注入边界声明）+ PRD FR-1 勘误（≤10s 口径统一为含 dsh）
- 影响：S1 契约/共识已更新；S3/S5 契约已核兼容无需改；设计 S1-壳骨架-m1-design 待 0.2 修订；PRD 勘误已登记
- 状态：复评通过，已冻结；无 P0/P1

## 2026-08-14 v1.3

- Gate B 定稿：M1 子需求清单（S1~S7）写入共识 §14.1 并 ticket 化（飞书 dsh-hull-desktop，负责人 phper666，交付顺序 S1→S2→S3→S4→S5→S6，S7 贯穿）。规则无变化。
- Q-012 结论回写 §4.4：Hull 升级删除「稍后重启」选项——确认即执行（确认框「稍后再说」已覆盖延迟需求，Q-008）；下载完成后自动重启安装。来源：契约复核（feishu-s5-m1-api-contract.md）→ Q-012 闭环。

## 2026-08-14 v1.2

- Q-items 全部闭环（飞书 Done 列）；Gate A 评审就绪检查通过。规则无变化。

## 2026-08-14 v1.1

- 修订 CON-R008：dsh 版本策略——默认 @latest（信任官方测试）；设置页提供"指定版本"入口（手输版本号或从版本列表选择，不写死）。来源：Q-001/Q-005 结论。
- 新增 CON-R009：升级触发——设置页可配置（手动「检查更新」按钮 + 自动检查开关默认开）；应用前必须用户确认；「稍后再说」当日不再提示。来源：Q-008 结论。
- ~~CON-R011 升级会话保护~~ 已下线：确认后立即升级，会话中断可接受；queued 状态与 FR-9 状态桥一并删除。来源：Q-003 结论。
- 新增 CON-R014：升级原子性补充——启动残留检测恢复（staging 存在续替 / previous 存在回滚）。来源：Q-004 结论。
- 新增 CON-R015：就绪判定——就绪行 + HTTP 探测（GET 200）后再 loadURL；探测目标/超时可注入（测试用）。来源：Q-009/Q-010 结论。
- 新增 CON-R016：首装可取消 → "未安装"引导态 + 安装按钮（点击重新走安装流程）；不提供永久跳过。来源：Q-011 结论。
- 语义回写（不新增编号）：升级失败不自动重试、按钮下方失败提示（Q-002）；启动失败主窗口提示+重试+日志入口（Q-007）；Hull 升级失败提示在按钮下方（Q-006）。

## 2026-08-14 v1.0

- 发布基线（用户确认）：CON-R001~R013 注册（见规则索引）；修正 §11 排队可见性与会话状态栏。
- 注：v1.0-草稿（首次建立）→ v1.0 基线发布，规则编号体系同期建立（CON-R001 起，来源 PRD 2026-08-14）。