# Hull 主题切换 PRD

> 版本：v0.1 · 日期：2026-08-24 · 状态：待评审
> 需求标识：`theme` · 归属：Hull 模块（壳 UI）

## 1. 背景

Hull 壳界面（看板/Skills/设置/编辑器/时间线）配色为硬编码暗色（kanban.css/skills.css 内十六进制如 `#1e2430/#2a3342`），用户无法切换外观。新增多款主题支持。

## 2. 目标

- 壳 UI 支持切换多款预设主题（本轮：暗/亮 2 款）
- 切换入口在设置页，即时生效 + 重启保持
- **仅作用于壳 UI**，官方 dsh Web UI 零注入（CON-R001 红线不破）

## 3. 非目标（本轮不做）

- 官方 dsh Web UI 主题（不碰 CON-R001）
- 用户自定义主题/配色编辑器（YAGNI，排后）
- 3+ 色系主题（本轮仅暗/亮）

## 4. 需求详述

### FR-1 主题选择
- 设置页新增「主题」区块，提供预设主题选择（本轮 2 款：暗色 / 亮色）
- 当前主题高亮显示，切换即时生效（不重启）
- 持久化到 settings.json（HullSettings 新增 `theme` 字段，默认 `dark` 保持现状）

### FR-2 主题作用域
- 主题变量作用于**全部壳 UI**：看板（kanban.css）、Skills（skills.css）、设置页、编辑器（easymde-dark.css）、时间线/日历
- 官方 dsh Web UI（WebContentsView 内嵌）不受影响（CON-R001）

### FR-3 亮色主题
- 基于现有暗色 tokens 反相设计亮色变体（背景 `#1e2430→#f5f7fa`、文字 `#e8ecf3→#1a2233`、面板、边框、主色 `#2e8bf5` 保留或调暗对比）
- 所有硬编码色值抽取为 CSS 变量（`--hull-bg` / `--hull-panel` / `--hull-border` / `--hull-text` / `--hull-text-dim` / `--hull-accent` 等），主题切换 = 切换 `[data-theme]` 属性下的变量集

### FR-4 切换机制
- 壳根节点 `data-theme="dark|light"` 属性驱动（CSS 变量按属性选择器切换）
- 设置页选择 → hull:setSettings 持久化 + 根节点 data-theme 更新 → 全 UI 即时生效
- 重启后从 settings.json 读 theme 应用

### FR-5 编辑器主题
- EasyMDE 暗色主题（easymde-dark.css）同样抽变量，亮色有对应亮色变体（Q-045 遗留的暗色 vendor CSS 需配套亮色）

## 5. 验收标准（可测试）

1. 设置页主题区块出现，当前主题高亮，暗/亮可切换
2. 切换后看板/Skills/设置/编辑器/时间线即时变色，不重启
3. 重启后主题保持（settings.json 持久化验证）
4. 官方 dsh Web UI 颜色不变（CON-R001 不破）
5. 亮色主题下文字/边框对比度可读（无不可读的浅色文字/深色背景残留）
6. 无硬编码色值残留（除 CSS 变量定义处）

## 6. 不做事项

- 官方 UI 主题
- 自定义主题/配色编辑器
- 3+ 色系主题
- 跟随系统外观自动切换（排后）
