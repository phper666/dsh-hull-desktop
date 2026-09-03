# 变更摘要-Hull（L2 模块详情）

> Hull 模块（架构/升级/数据/平台/运行时等通用规则 + M1 子需求 S1~S8）变更详情。每条 ≤200 字，delta-only、编号驱动、取代链、反哺 Q-items。最新在前。
> L1 索引：docs/spec/变更摘要.md · 共识：docs/spec/共识-Hull桌面壳-M1.md · 规则索引：docs/spec/规则索引.md

## 2026-09-03 工作流通知优化（标注 + 失败自动通知 + 站内通知中心）

- 类型：功能需求实现（判级常规偏复杂，设计 §8 方案冻结；无共识规则变化）
- 内容：①通知标注——标题带工作流名 `工作流 · <名称>`（notification 步骤/失败通知统一）；②失败自动通知（新增行为）——run 失败即系统通知（title `…【失败】`，首条错误截断 120 字），notifyOnExceed 语义被取代（超限=失败=自动通知，UI 移除开关、字段兼容）；③通知点击跳转——聚焦主窗口切工作流视图（winMgr 晚绑定）；④壳内通知中心——侧边栏铃铛 + 未读失败角标（localStorage lastReadTs，60s 轻轮询）+ overlay 面板（全部/仅失败 chips，行点击跳工作流视图），复用 workflows:runs 零新增存储
- 核验：单测 854 绿（引擎 +4 用例）+ e2e 31 绿；review 修 2 项（notifyTitle 实例字段并发互踩→参数传递；面板定位 token 不存在→212px 硬编码注记）；通知点击/面板交互待用户 dev 验证
- 文档：设计 docs/design/工作流-workflows-design.md §8 · 记录 docs/records/工作流通知优化-workflow-notify-record.md
- commits：4bf5a42 / ea8bef6 → merge b536878

## 2026-09-03 工作流 v2（cron 定时触发 + connection-action + token-budget）

- 类型：功能需求实现（判级复杂，设计 §7 方案冻结；无共识规则变化）
- 内容：①定时触发——5 字段 cron 解析器（零依赖、本地时区、vixie DOM/DOW 或语义）+ WorkflowScheduler（超长 delay 按 2^31-1 分片、错过不补跑、与手动共用 per-workflow 互斥、before-quit 清理），workflows.json trigger 字段级扩展不 bump version；②connection-action 步骤——工作台连接联动：阿里云/腾讯云 SendSms（签名链复用参数化）+ SMTP 发信（点填充/RFC2047/CRLF 头注入防护），凭据仅 main 侧解密、运行日志收件人掩码，salesforce 明确不支持动作；③token-budget 步骤——今天/本月/全部（与 tokens 视图同日历对齐）阈值检查，超限系统通知+步骤失败中止；④IPC workflows:cronPreview + list 注入 nextRunAt；⑤编辑器触发区+两新步骤表单+列表下次运行/定时徽标；运行记录标触发来源（manual/cron）
- 顺带闭环：v1 verifySmtp 漏第二次 334 密码挑战（AUTH LOGIN 双挑战，认证路径从未真实验证）；E2E-01 navOrder 存量漂移（nav 4→7 项）；E2E-07 主题测试显式 seed（CON-R-theme-004 默认改 system 后）
- 核验：单测 851 绿（新增 35：cron 11/Actions 8/引擎 5/调度器 8/store 3）+ 集成 8 + e2e 27 全绿；Semgrep 2 条 rejectUnauthorized 为存量已接受风险（记录登记）；SMTP 状态机经本地假服务器真实 socket 集成测
- 文档：设计 docs/design/工作流-workflows-design.md §7 · 记录 docs/records/工作流v2-workflows-v2-record.md
- commits：39e6f4c（fix）/ ffba8d5（feat）/ 530db1e（test）/ 9e4e2c5（docs）→ merge 563ef72

## 2026-09-02 UI 视觉优化 P1/P2 剩余项（ticket t100109，PR #7）

- 类型：UI 体系重构（无共识规则变化）
- 内容：3 批——①壳级组件基类（.btn/.input/.badge/.switch/.modal）+ 6 渲染文件别名收敛（按钮 6 套/输入 5 套/徽标 5 套/switch 3 套/弹窗 2 套→1）+ switch rgba 主题化 + nav-title logo；②--text-* 字阶 token + 166 处 font-size/spacing 等值迁移；③nav 7 inline SVG 图标 + connections/workflows/shell 设置页 surface ladder + 4 页空态 SVG 锚点 + 亮色 shadow 分层；含 workflows.js 存量死引用修复（`void loadList` 中断初始化致视图空白）
- 核验：CSS 级联审计（修掉 2 个特异性回归）+ fake-DOM 冒烟 4 页 + 用户亮/暗两主题走查通过（2026-09-02）
- 文档：docs/design/UI-P1P2-视觉剩余项-design.md（3 批实施，先结构后视觉）

## 2026-09-02 Token 视图筛选语义修订（t100104 追加，验证反馈闭环）

- 类型：功能语义修订（用户 dev 验证反馈两轮 + 长期数据诉求）
- 内容：①筛选从「聚合粒度」改「时间范围」——原实现粒度只作用于序列分桶，汇总/明细为全期累计不符合直觉；②窗口改日历对齐（本小时整点/今天 0 点/本月 1 号/今年 1 月 1 日，本地时区）；③加「全部」档（不过滤时间，序列按月桶，长期数据总账入口）；序列分桶按范围自动推导（10 分钟/小时/天/月桶）
- 核验：86 单测绿 + 用户 dev 验证通过（2026-09-02）
- commits：58ca844 / bca8bb1 / bdf960f / 117066a

## 2026-09-02 Token 视图平台扩展 v2（ticket t100104，PR #6）

- 类型：功能需求实现（无共识规则变化）
- 内容：Token 视图 3→16 本地可解析平台（opencode/cline/roo/gemini/kimi JSONL 型 + goose/continue/zed/warp/zcode/qoder/copilot/kiro SQLite 型，node:sqlite 只读）；codex 新 rollout 格式累计值→增量状态机修复（consumeUsageDelta）；UI 驾驶舱改造（英雄卡/构成分解/柱状趋势/平台色点，双主题）；reasoningTokens 全链路
- 核验：81 单测绿 + tsc ✓ + oracle review（H1 opencode 推理少计/M1 性能/M2 SQLite 只读列/M3 num 兼容，全修）+ 本机实测 16 平台无 ERR（opencode 1025 记录/19 模型出数）；UI demo 确认
- 文档：设计 v2 docs/design/Token消耗查看-tokens-design.md · 记录 docs/records/Token消耗查看-tokens-v2-record.md · 调研 docs/research/2026-09-02-agent-token-format-research.md

## 2026-08-30 CON-R-theme-004 修订（共识 v1.3）：默认主题 dark → system

- 类型：共识规则修订（用户决策 2026-08-30）
- 内容：默认主题 dark → system（跟随 OS 亮暗）；**仅对从未设置过主题的用户生效，已保存 theme 值的用户完全不受影响**，手动修改随时可改；非法值回退默认 system（原回退 dark）
- 实现：DEFAULT_SETTINGS.theme + 写路径回退点（SettingsProvider）；测试 T2-①③④⑤⑥ 断言同步
- 核验：typecheck ✓ 697 单测 ✓

## 2026-08-30 主题跟随系统（共识 v1.2，CON-R-theme-006）+ UI P1 令牌层第一增量

- 类型：共识规则新增（v1.2）+ 实现层令牌化
- 主题跟随系统：theme 枚举扩展 'system'（dark/light/system，默认仍 dark）；main 设 nativeTheme.themeSource（'system' 原生透传 → 渲染树 prefers-color-scheme 自动跟随），renderer matchMedia 被动解析 + change 实时切换；持久化字段级扩展不 bump schemaVersion；设置页主题 segmented 三选（暗色/亮色/跟随系统）
- 令牌层第一增量（值保持替换，不视觉变更）：--radius-xs~xl/pill、--shadow-1/2、--dur-fast/med、--ease-out、--font-mono；三渲染文件单值 border-radius/动效时长/mono 栈全部 token 化（多值简写与 3px 特例保留原样并注记）
- 判级：常规偏复杂（新依赖前景 + 主题共识变更）→ 技术方案 docs/design/UI-P1-令牌化与主题跟随-design.md
- 核验：typecheck + 单测（新增 T2-⑦/⑧ system 用例）绿；运行时 OS 切换实时跟随待用户 dev 验证
- 后续增量：WA vendor + toast/dialog 迁移、spacing token、P2 品牌个性

## 2026-08-30 UI P0 视觉快赢：主题令牌值修正 + 新增 UI 微动效约定（判级：简单，纯 CSS 无逻辑）

- 类型：实现层调整（无共识规则变化，CON-R-theme-001~005 机制不变；主题共识未钉死被改值，主色 #2e8bf5 保留 ✓）
- 内容：①双强调色收敛（--hull-primary #4c6ef5 靛蓝 → #2e8bf5 accent，消灭双主色竞争）②暗色文字阶梯修正（dim/muted/sub/note 重排，消灭 note>sub 倒挂，sub 对比度提至 ~4.6:1）③新增 UI 约定：按钮/输入 120ms 微动效 + focus-visible ring + prefers-reduced-motion 守卫 + nav active 轻量化（soft 底+左指示条）+ 列表行/卡片 hover 反馈
- 判级：简单（纯 CSS 视觉层，零 JS/IPC 改动，跳过技术方案）；依据调研 docs/research/2026-08-30-ui视觉调研.md + 原型 docs/prototype/2026-08-30-ui-p0-prototype.html（用户视觉确认后实施）
- 核验：typecheck+695 单测绿；视觉走查（亮暗两套 × 各视图）待用户 dev/发版确认
- 后续：P1 token 化重构 + Web Awesome 行为组件引入时，主题共识拟升 v1.1（将微动效/focus ring/表面阶梯写成正式规则）

## 2026-08-28 CON-R-packaging-005 二次修正：ad-hoc 签名不可行 → 自签名证书方案

- 类型：共识规则再修正（0.1.2→0.1.3 实测 ad-hoc 仍失败，2026-08-28）
- 内容：**ad-hoc 签名路线废弃，改自签名证书**——实测 0.1.2（ad-hoc 签名）升级 0.1.3 仍报 `Could not get code signature`。根因（Squirrel.Mac 源码级）：安装时提取**运行中 app 的 designated requirement** 并要求更新包满足；ad-hoc 的 DR=`cdhash H"..."` **钉死二进制哈希**，任何新版本二进制必变 → 校验数学上必失败。**自签名证书的 DR=`identifier + certificate leaf 指纹`（可移植），同证书跨版本校验通过**（本地实验证实，不需要 Apple 信任链）
- 实现：钥匙串创建自签名代码签名证书「Dsh Hull Code Signing」（openssl + security import + add-trusted-cert）；electron-builder `identity: "Dsh Hull Code Signing"`；CI 走 `CSC_LINK`/`CSC_KEY_PASSWORD` secrets（p12 + 密码，electron-builder 原生支持）；**所有版本必须同证书签名**（DR 钉证书指纹）；删除 afterPack ad-hoc 钩子
- 限制：新用户首次安装 dmg 需 Gatekeeper 手动放行（无公证）；已装 0.1.0~0.1.2（未签名/ad-hoc）的用户无法自动更新（DR 不匹配），需手动安装 0.1.4+ 一次
- 状态：已实现（2026-08-28，证书签名本地验证通过：真实证书身份非 adhoc）

## 2026-08-28 mac 签名策略修订：暂不签名 → ad-hoc 签名（CON-R-packaging-005）

- 类型：共识规则修订（mac 自动更新实测发现，2026-08-28）
- 内容：**mac 从「暂不签名」改为「ad-hoc 签名」**——Squirrel.Mac（electron-updater mac 安装器）要求运行中的应用有代码签名才能安装更新，未签名报 `Could not get code signature for running application`，mac 自动更新安装被彻底阻断。ad-hoc（`codesign --sign -`，Signature=adhoc）无开发者证书的自分发方案，Squirrel 可识别，解锁 mac 更新安装。公证仍不做（U-1 排后），Gatekeeper 警告接受。
- 实现：**afterPack 钩子**（scripts/adhoc-sign.mjs，打包后 zip 前 adhoc 签名）——afterSign 仅在发生签名时调用（未签名被跳过），故用 afterPack；electron-builder.yml `afterPack` + `identity: null` 保持
- 影响：electron-builder.yml + scripts/adhoc-sign.mjs（新）；mac 自动更新安装解锁；已用本地 mock 更新源实测：下载/进度/校验态/取消全部正常，签名错误为 Squirrel 对未签名 app 的硬性要求
- 状态：已实现（2026-08-28，ad-hoc 签名 codesign 验证通过：Signature=adhoc）

## 2026-08-26 pkgmgr 共识升 v1.3——pnpm peer deps 需显式 fixup（cicd 首次实测）

- 类型：共识结论变更（cicd 首次实测发现 dsh 启动失败，2026-08-26）
- 内容：**pnpm 装 dsh 后 dsh-app-boot 的 9 个 peer 不链接顶层 → dsh 启动 ERR_MODULE_NOT_FOUND**。与 yarn 同因（peer 不自动装）但机制不同：pnpm `auto-install-peers=true` 对**传递依赖的 peer**（dsh-app-boot 是 dsh 的依赖非顶层）不生效，须装后显式 `pnpm add <peer>@<versionRange>`（peer fixup）。CON-R-pkgmgr-002/003 补充 peer fixup 语义
- 影响：PnpmRunner 加 peer fixup（读 dsh-app-boot peerDependencies → 顶层缺失显式 add）；buildArgs 写 .npmrc auto-install-peers 兜底；TDD 4 测试 + 手动验证 dsh 启动成功；产出 lesson（docs/lessons/2026-08-26-pnpm-peer-deps-dsh-startup-lesson.md）
- 状态：已发布（2026-08-26，PM）

## 2026-08-25 packaging 共识升 v1.2——mac 双架构（cicd 决策 6 传播）

- 类型：跨需求规则变更（cicd 决策 6 传播到 packaging，2026-08-25）
- 内容：**CON-R-packaging-002 mac 架构扩展**——从「dmg+zip（Apple Silicon）」扩展为「dmg+zip 双架构（arm64 + x64）」，覆盖 Intel + Apple Silicon Mac。触发：cicd 技术方案决策 6（用户拍板 B 双包，各包捆绑对应架构 node，electron-updater 按 arch 选）
- 影响：mac 打包从单架构（arm64）→ 双架构（arm64 + x64）；CI 矩阵 mac 拆 macos-latest（arm64）+ macos-13（Intel x64）；fetch-node 新增 darwin-x64；electron-builder.yml mac 加 arch
- 状态：已发布（2026-08-25，PM，cicd 决策 6 回写）

## 2026-08-25 Hull CI/CD 共识升 v1.1——版本策略细化（Q-057/Q-058 回写）

- 类型：共识结论变更（Q-057/Q-058 定案回写，2026-08-25）
- 内容：**FR-2 版本策略从「version 输入」升级为「branch 输入 + patch/minor/major 三档 bump + 版本线维护」**——workflow_dispatch 带 branch（默认 main）+ version（三档）+ release_notes；bump 读所选分支 package.json 走一步，tag 打所选分支 HEAD，发布版本永远 = bump 后 tag（Q-057 定案：CI 全自动 bump，版本一致性天然解决）；三档自定义语义（patch=bug+小功能 / minor=攒批 / major=重构）；版本线维护独立于档位（main 走远 + 用户锁旧版 → 从旧 tag 拉 release/x.y 只发 patch + cherry-pick 回 main）；并发锁按版本线分组 `concurrency.group: release-${{ inputs.branch }}`（Q-058 定案：同线串行异线并行，解决并发发布竞态）；matrix 三端 checkout 同一 branch 防漂移；自动更新项目旧线 patch 只服务锁版用户
- 影响：CON-R-cicd-003 语义扩展（version→branch+三档）；PRD FR-2 同步；产出经验文档 docs/lessons/2026-08-25-release-versioning-strategy-cicd-lesson.md（跨项目可复用）
- 状态：已发布（2026-08-25，PM，Q-057/058 已回写）

## 2026-08-25 Hull CI/CD 发布流程共识发布 v1.0（新需求 cicd，packaging U-2 落地）

- 类型：共识基线发布（新需求建立）+ 登记 CON-R-cicd-001~008
- 内容：**三端 CI/CD 发布链（macOS/Windows/Linux）**——GitHub Actions 三端 matrix 并行构建（macos-latest/windows-latest/ubuntu-latest）；workflow_dispatch 手动触发（version 默认 package.json + release_notes 输入）；CI 各 runner 跑 fetch-node 生成捆绑 node（win32-x64 CI 补齐）；electron-builder --publish always 发布 GitHub Releases（复用 GH_TOKEN）；latest-mac.yml/latest.yml/latest-linux.yml 更新元数据自动生成；前置门禁 typecheck+build；单平台失败不阻塞（matrix 天然隔离）。演进现有 mac-only release.yml 为三端；packaging 共识 U-2「CI 自动化」从排后转本轮
- 影响：.github/workflows/release.yml 演进（mac-only → 三端 matrix + workflow_dispatch）；CI 首次实测 win/linux 打包；无新 UI、无代码层改动（纯 CI 层）
- 状态：已发布（2026-08-25，PM）

## 2026-08-25 packaging 实现完成——三端打包落地（PK1/PK2/PK3）

- 类型：实现完成（共识 v1.1 落地，CON-R-packaging-001~008 全生效）
- 内容：**PK1 electron-builder 三平台配置**（mac dmg+zip / win nsis+portable / linux AppImage+deb + extraResources 捆绑 node）；**PK2 fetch-node 平台参数化 + extractNode 解压**（win node.exe/linux bin/node 分支 + 幂等 + 版本文件）；**PK3 自动更新 GitHub Releases**（用户拍板 A，publish 统一 + adapter owner 修正 phper666/dsh-hull-desktop）
- 影响：electron-builder.yml/package.json（devDep+脚本+repository）；fetch-node.mjs 参数化；extractNode.ts 新建；CON-R006 平台扩展 macOS→三端
- 状态：已实现（2026-08-25，unit 645 绿 + mac 打包验证 dmg+zip+node 捆绑；win/linux 配置就绪待对应平台实测）

## 2026-08-25 Hull 三端打包共识发布 v1.0（新需求 packaging）

- 类型：共识基线发布（新需求建立）+ 登记 CON-R-packaging-001~008
- 内容：**三端打包（macOS/Windows/Linux）**——electron-builder 三平台 target（mac dmg+zip / win nsis+portable / linux AppImage+deb）；三端捆绑 node（fetch-node 按平台，dsh 不依赖用户 node）；自动更新 electron-updater 延续（三端同一更新源）；暂不签名/公证；CON-R006 平台范围 macOS→三端扩展；3 子需求 PK1（electron-builder 配置+打包）/PK2（捆绑 node）/PK3（自动更新+平台适配）
- 影响：引入 electron-builder；fetch-node.mjs 扩展按平台下载 node；CON-R006 语义扩展；pkgmgr spawn 跨平台铺垫承接
- 状态：已发布（2026-08-25，PM）

## 2026-08-25 pkgmgr 去 yarn（共识 v1.2）——只留 npm/pnpm

- 类型：需求变更（用户拍板，2026-08-25），升共识 v1.2
- 内容：**去掉 yarn 支持**——yarn 4 默认不自动装 peerDependencies → dsh 启动 `ERR_MODULE_NOT_FOUND`（dsh-app-boot 的 `cordis-plugin-group` 缺失），与 dsh 生态不兼容；CON-R-pkgmgr-001 从「三包管理器」改「两包管理器（npm/pnpm）」；corepack 托管保留（pnpm 固定 11.23.0）
- 影响：删 YarnRunner + COREPACK_YARN_VERSION + yarn4 .yarnrc.yml 逻辑 + yarn 测试；PkgMgrName/校验/设置页/工厂收敛二选一；npm/pnpm 零改动；PRD/规则索引/共识同步
- 状态：已实现（2026-08-25，unit 640 绿）

## 2026-08-24 pkgmgr 实现完成——三包管理器支持落地（P1/P2/P3）

- 类型：实现完成（共识 v1.1 落地，CON-R-pkgmgr-001~008 全生效）
- 内容：**P1 执行器抽象**（src/overlay/pkgMgr/ 新建，PkgMgrRunner 接口 + npm/pnpm/yarn 三实现，错误解析/取消按管理器适配）；**P2 spawn 跨平台改造**（dshEntryPath 解析真实 JS 入口绕开 .bin shim + ELECTRON_RUN_AS_NODE=1 + 剥离 NODE_OPTIONS/ELECTRON_*，适配三端）；**P3 settings.packageManager**（默认 pnpm 字段级扩展不 bump schema）+ 设置页三选一 + pnpm 装完自动 rebuild 原生依赖（失败告警不阻断）；e2e 假 registry 场景显式 npm
- 影响：npmRunner 迁移 pkgMgr/；RuntimeManager spawn 改 entryPath；S2 契约安装链路更新；HullSettings +packageManager；settings 页 +选择 UI；验证 unit 644 + int 8 + e2e 27 全绿 + semgrep 干净
- 状态：已实现（2026-08-24，feature/pkgmgr 分支）

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