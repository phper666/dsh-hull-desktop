# Hull 桌面壳（主题切换）共识文档

> 版本：v1.1 · 更新：2026-08-24 · 维护者：phper666（PM） · 状态：已发布
> 数据来源：Hull Theme PRD v0.1（docs/prd/2026-08-24-hull-theme-prd.md）
> 关联：新增需求（Hull 模块壳 UI 增强）；需求标识 `theme`；B1 范围

## 1. 文档元信息

- **本版本变更**：v1.1 已发布——BE 扫描修正（确认定案，向后兼容）：CON-R-theme-003 主题持久化改「字段级扩展不 bump schemaVersion」（对齐 S6 registry 先例，schemaVersion 保持 3，migrate() `<3` 补齐兜底）；新增 §4.5 schema 处理。
- **历史变更摘要**：v1.0 首次建立——从 Hull Theme PRD v0.1 提取整理为业务事实源；登记 CON-R-theme-001~005。
- **状态说明**：v1.1 已发布；BE/FE/QA 扫描完成，无新增 Q-items（全部被共识 §6/FR-2/验收5 覆盖，1 项 BE 修正回写 v1.1）；无未决项。

## 2. 文档结构总览

- **覆盖**：Hull 壳 UI 主题切换全部业务面——主题预设（暗/亮）、切换入口（设置页）、作用域（全部壳 UI）、持久化（settings.json）、机制（CSS 变量 + data-theme）、编辑器主题配套。
- **适用范围**：仅 Hull 壳 UI（nav/看板/Skills/设置/编辑器/时间线）；**不覆盖** 官方 dsh Web UI（CON-R001 零注入红线）、用户自定义主题、3+ 色系。

## 3. 领域术语表

| 术语 | 定义 | 出处 |
|:-----|:-----|:-----|
| 壳 UI | Hull 自有的全部界面：壳导航 + 看板 + Skills 检查器 + 设置页 + 编辑器 + 时间线/日历；区别于官方 dsh Web UI（WebContentsView 内嵌） | PRD §2 |
| 主题（theme） | 壳 UI 的一组配色变量集，决定背景/面板/边框/文字/主色 | PRD §4 |
| 暗色主题 | 默认主题，对应现有硬编码配色（kanban.css `#1e2430/#2a3342`） | PRD FR-3 |
| 亮色主题 | 新增主题，基于暗色 tokens 反相的浅色变体 | PRD FR-3 |
| CSS 变量（tokens） | 主题化的载体：硬编码色值抽取为 `--hull-*` 变量，按 `[data-theme]` 属性切换 | PRD FR-3/FR-4 |
| 壳根节点 | shell 根元素，挂 `data-theme="dark\|light"` 驱动主题 | PRD FR-4 |

## 4. 功能需求（PRD 提取）

### 4.1 主题选择（FR-1）

- 设置页新增「主题」区块，提供预设主题选择（本轮 2 款：暗色 / 亮色）；
- 当前主题高亮显示，切换即时生效（不重启）；
- 持久化到 settings.json（HullSettings 新增 `theme` 字段，默认 `dark` 保持现状）。

### 4.2 主题作用域（FR-2）

- 主题变量作用于**全部壳 UI**：看板（kanban.css）、Skills（skills.css）、设置页、编辑器（easymde-dark.css）、时间线/日历；
- 官方 dsh Web UI（WebContentsView 内嵌）不受影响（CON-R001）。

### 4.3 亮色主题（FR-3）

- 基于现有暗色 tokens 反相设计亮色变体（背景 `#1e2430→#f5f7fa`、文字 `#e8ecf3→#1a2233`、面板、边框、主色 `#2e8bf5` 保留或调暗对比）；
- 所有硬编码色值抽取为 CSS 变量（`--hull-bg` / `--hull-panel` / `--hull-border` / `--hull-text` / `--hull-text-dim` / `--hull-accent` 等），主题切换 = 切换 `[data-theme]` 属性下的变量集。

### 4.4 切换机制（FR-4）

- 壳根节点 `data-theme="dark|light"` 属性驱动（CSS 变量按属性选择器切换）；
- 设置页选择 → hull:setSettings 持久化 + 根节点 data-theme 更新 → 全 UI 即时生效；
- 重启后从 settings.json 读 theme 应用。

### 4.5 schema 处理（BE 扫描修正，2026-08-24）

- theme 为**字段级扩展**（对齐 S6 registry 先例）：SettingsProvider 读路径字段级防御解析，旧 settings 无 theme → 回退默认 dark；非法值（非 dark/light）→ 回退 dark 并归一化；
- **不 bump schemaVersion**（保持 3）——S6 加 registry 字段即不 bump，schemaVersion 仅记录破坏性迁移（S4/S5 合并定 3）；migrate() 的 `< 3` 补齐逻辑已兜底旧数据。

### 4.5 编辑器主题（FR-5）

- EasyMDE 暗色主题（easymde-dark.css）同样抽变量，亮色有对应亮色变体（Q-045 遗留的暗色 vendor CSS 需配套亮色）。

## 5. 状态

- **主题状态**：dark（默认，保持现状）/ light（新增）。
- **持久化状态**：theme 字段持久化于 settings.json（HullSettings），**字段级扩展不 bump schemaVersion**（保持 3，对齐 S6 registry 先例；migrate() `< 3` 补齐已兜底旧数据）。

## 6. 异常分支

- settings.json 无 theme 字段（旧数据）→ 默认 dark，不报错；
- theme 值非法（既非 dark 也非 light）→ 回退 dark 并归一化；
- 切换即时失败（设置持久化失败）→ 回退原主题，不残留半应用状态。

## 7. 安全与红线

- **CON-R001 不破**：官方 dsh Web UI 零注入，主题变量仅作用于壳 UI；
- 主题为纯展示层，不涉及用户数据写入（DSH_HOME 不碰，CON-R002 不破）；
- CSS 变量仅前端，无 IPC 新增风险面（复用 hull:setSettings）。

## 8. 未决项登记

- **U-1 跟随系统外观自动切换**：P2 排后（触发：用户需求）；本轮不做。
- **U-2 3+ 色系主题**：P2 排后（触发：品牌色需求）；本轮仅暗/亮。
- **U-3 用户自定义主题**：P2 排后（YAGNI，配色编辑器复杂度高）；本轮不做。

## 9. 扫描待确认项

> 本需求 v1.1 扫描完成（BE/FE/QA）：无新增 Q-items（持久化失败回退=§6、设置页纳入主题化=FR-2、亮色对比度=验收5 均已覆盖）；BE 发现 1 项修正（schemaVersion bump 非必要，对齐 S6 先例）→ 已回写 §4.5/CON-R-theme-003（v1.1）。

## 10. 规则编号（CON-R-theme-001~005）

| 编号 | 规则 | 来源 | 当前结论 | 变更状态 |
|:-----|:-----|:-----|:---------|:---------|
| CON-R-theme-001 | 主题范围 = 仅壳 UI，官方 dsh Web UI 零注入 | PRD §2/FR-2 | 生效 | 稳定 |
| CON-R-theme-002 | 主题载体 = CSS 变量（`--hull-*`）+ 壳根节点 `data-theme` 属性 | PRD FR-3/FR-4 | 生效 | 稳定 |
| CON-R-theme-003 | 主题持久化 = settings.json（HullSettings `theme` 字段），字段级扩展不 bump schemaVersion（保持 3，对齐 S6 registry 先例；旧数据/非法值读时回退 dark） | PRD FR-1/§5 | 生效 | 稳定 |
| CON-R-theme-004 | 默认主题 = dark（保持现状），非法值回退 dark | PRD FR-1/§6 | 生效 | 稳定 |
| CON-R-theme-005 | 硬编码色值全部抽取为 CSS 变量，无残留（除变量定义处） | PRD FR-3/验收6 | 生效 | 稳定 |

## 11. 页面交互规范

| 页面/组件 | 角色 | 功能 | 权限 | 数据范围 |
|:----------|:-----|:-----|:-----|:---------|
| 设置页「主题」区块 | 用户 | 主题选择（暗色/亮色），当前高亮，切换即时生效 | 全量 | 壳 UI 全局 |
| 壳根节点 | 壳 | 应用 `data-theme` 属性，驱动 CSS 变量切换 | 系统 | 全部壳 UI |

## 12. 不做事项

- 官方 dsh Web UI 主题（CON-R001 不破）；
- 用户自定义主题 / 配色编辑器（YAGNI，排后）；
- 3+ 色系主题（本轮仅暗/亮）；
- 跟随系统外观自动切换（排后）。

## 13. 依赖

- **HullSettings schema bump 3→4**（SettingsProvider.ts，S5/S6 迁移判据）；
- **现有硬编码配色重构**（kanban.css/skills.css/easymde-dark.css）；
- 复用 hull:setSettings 通道（无新 IPC 风险面）。

## 14. 子需求清单

> 已拆解（Gate B 通过 2026-08-24）：ticket 已落 dsh-hull-desktop 清单（编号/验收标准/规则绑定/依赖/来源 PRD）。

| # | 子需求 | 验收标准（可测试） | 规则绑定 | 依赖 | 来源 PRD | ticket |
|:--|:-------|:-------------------|:---------|:-----|:---------|:-------|
| T1 | 主题化重构（CSS 变量抽取 + 亮色变量集） | 硬编码色值全抽为 `--hull-*` 变量（验收6）；亮色/暗色两套变量集，data-theme 切换生效 | CON-R-theme-002/005 | 无 | hull-theme PRD FR-3 | t100083 |
| T2 | 主题持久化 + 设置页切换（settings.theme 字段级扩展） | 设置页主题区块可切换暗/亮；即时生效；重启保持；非法值回退 dark；旧 settings 无 theme 不报错 | CON-R-theme-003/004 | T1 | hull-theme PRD FR-1/FR-4 | t100084 |
| T3 | 编辑器主题配套 | EasyMDE 亮色变体；编辑/预览/详情在亮色下可读 | CON-R-theme-002/005 | T1 | hull-theme PRD FR-5 | t100085 |

## 15. 附录

### 15.1 关联

- PRD（docs/prd/2026-08-24-hull-theme-prd.md）、规则索引（docs/spec/规则索引.md）、M1 共识（docs/spec/共识-Hull桌面壳-M1.md，CON-R001 引用）。

### 15.2 版本记录

| 版本 | 日期 | 变更摘要条目 | 说明 |
|:-----|:-----|:-------------|:-----|
| v1.1 | 2026-08-24 | 已登记（已发布） | BE 扫描修正：CON-R-theme-003 主题持久化改字段级扩展不 bump schemaVersion（对齐 S6 registry 先例）；新增 §4.5 |
| v1.0 | 2026-08-24 | 已登记（已发布） | 首次建立：从 Hull Theme PRD v0.1 提取；登记 CON-R-theme-001~005、U-1~U-3 |

### 15.3 后续规划

> 记录本轮明确排除/未决项，供后续承接。

| 项 | 状态 | 说明 |
|:---|:-----|:-----|
| 跟随系统外观自动切换 | 排后（U-1） | 需监听系统外观变化，触发条件未到 |
| 3+ 色系主题 | 排后（U-2） | 需品牌色需求 |
| 用户自定义主题 | 排后（U-3） | YAGNI，配色编辑器复杂度高 |
