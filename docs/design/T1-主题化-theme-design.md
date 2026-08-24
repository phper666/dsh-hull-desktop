# Hull 主题切换技术方案

> 状态：draft（撰写中）→ 评审通过后 frozen
> 关联：共识 v1.1（docs/spec/共识-Hull桌面壳-主题.md）+ CON-R-theme-001~005 + PRD（docs/prd/2026-08-24-hull-theme-prd.md）

## 1. 背景与范围

- Hull 壳 UI（nav/看板/Skills/设置/编辑器/时间线）配色硬编码暗色，需支持暗/亮 2 款主题切换
- 仅壳 UI，官方 dsh Web UI 零注入（CON-R001 不破，CON-R-theme-001）
- 设置页主题区块切换，settings.json 持久化（CON-R-theme-003），默认 dark（CON-R-theme-004）
- 子需求：T1 变量抽取 + 亮色集、T2 持久化 + 设置页、T3 编辑器配套

## 2. 架构决策

### 决策 1：主题载体 = CSS 变量 + `[data-theme]` 属性（CON-R-theme-002）

| 方案 | 说明 | 取舍 |
|:-----|:-----|:-----|
| **A. CSS 变量 + data-theme（选）** | 硬编码色值抽 `--hull-*`，壳根节点 `data-theme="dark\|light"`，`[data-theme="light"]` 下覆写变量集 | 单一事实源，运行时切换零重载，CSP 友好（无动态 style 注入），易测 |
| B. CSS 文件替换 | 亮/暗各一个 css 文件，link 切换 | 需动态换 link（CSP style-src 'self' 可行但多文件维护），变量化不彻底 |
| C. WebContentsView 注入 | 主进程向 view 注入样式 | 违反壳 UI 自身结构，复杂，放弃 |

选 A：CSS 变量是原生机制，主题切换 = 属性切换，无新依赖、无 IPC 风险。

### 决策 2：主题应用点 = shell.html 根节点（单点）

- 壳是单 shell.html（BrowserWindow 加载），看板/Skills/设置是 shell.html 内占位区块（非独立 HTML）
- 根节点 `data-theme` 一处切换 → 全部壳 UI 变量生效，无多视图广播问题
- shell.html 内嵌 `<style>`（nav/占位/设置区块样式）同步变量化（FR-2：全部壳 UI）

### 决策 3：持久化 = SettingsProvider 字段级扩展（不 bump schemaVersion）

| 方案 | 取舍 |
|:-----|:-----|
| **A. 字段级扩展（选，S6 registry 先例）** | 读路径防御解析 `theme` 字段，无 theme → 默认 dark；非法值 → dark；**不 bump schemaVersion（保持 3）**——S6 加 registry 已证明字段扩展不需 bump，migrate() `<3` 补齐兜底旧数据 |
| B. bump schemaVersion 3→4 | 过度：theme 无破坏性迁移，bump 无消费方，增加迁移复杂度 |

选 A：BE 扫描已确认（共识 §4.5 回写）。

### 决策 4：切换通道 = 复用 hull:setSettings

- 设置页主题选择 → 主进程 `hull:setSettings({ theme })` 持久化 + 广播
- 渲染侧监听 settings changed → 更新根节点 data-theme
- 无新 IPC 通道（复用 S6 既有，零风险面新增）

## 3. 模块划分

| 模块 | 职责 | 依赖 |
|:-----|:-----|:-----|
| shell.html + 内嵌样式 | 根节点 data-theme 应用；nav/占位/设置区块变量化 | 无 |
| kanban.css | 看板/时间线/日历/编辑器渲染色值变量化 | T1 |
| skills.css | Skills 检查器色值变量化 | T1 |
| easymde-dark.css + 亮色变体 | 编辑器暗/亮主题（Q-045 配套） | T3 |
| SettingsProvider | theme 字段读/写/校验（字段级） | T2 |
| 设置页区块（shell.html） | 主题选择 UI + 即时切换 | T2 |

依赖方向：T1（CSS 变量层）→ T2（持久化 + 设置页）→ T3（编辑器配套，依赖 T1 变量层）。

## 4. 关键机制

### 4.1 CSS 变量集（亮/暗两套）

```css
/* 暗色（默认，现值） */
:root, [data-theme="dark"] {
  --hull-bg: #1e2430;
  --hull-panel: #171c26;
  --hull-border: #2a3342;
  --hull-text: #e8ecf3;
  --hull-text-dim: #c6d0dd;
  --hull-accent: #2e8bf5;
  --hull-accent-hover: #3f97fb;
  --hull-hover: #33405a;
}
/* 亮色 */
[data-theme="light"] {
  --hull-bg: #f5f7fa;
  --hull-panel: #ffffff;
  --hull-border: #d5dbe4;
  --hull-text: #1a2233;
  --hull-text-dim: #5a6472;
  --hull-accent: #2e8bf5;
  --hull-accent-hover: #1f6fd0;
  --hull-hover: #e8edf5;
}
```

- 全部硬编码色值替换为 var(--hull-*)，无残留（CON-R-theme-005，验收6）
- 主色 accent 两套保持一致（品牌色），hover 调暗保证对比

### 4.2 根节点 data-theme 应用

- shell.html `<body>` 挂 `data-theme`（默认 dark）
- 启动时读 settings.theme → 应用；设置页切换 → hull:setSettings → changed 广播 → 更新 body data-theme

### 4.3 持久化读写

- SettingsProvider 读：`typeof obj.theme === 'string' && (obj.theme === 'dark' || obj.theme === 'light') ? obj.theme : 'dark'`
- set：合并写盘（复用既有 temp+rename 原子写）
- 旧 settings 无 theme → 回退 dark（CON-R-theme-004）

### 4.4 编辑器主题（T3）

- easymde-dark.css 色值变量化（当前暗色 = --hull-* 暗色集）
- 新增亮色：EasyMDE 容器 scoped `[data-theme="light"] .EasyMDE { ... }` 亮色变量
- markdown-it 渲染详情样式（kanban.css）已随 T1 变量化

## 5. 工程基线

- git ✅ / 脚手架 ✅（package.json）/ 测试框架 ✅（node --test 单测 + Playwright e2e）
- 技术栈：跟随既有 Electron + 原生 HTML/CSS/JS，无新依赖（主题 = 原生 CSS 变量）

## 6. 目录/工程结构

```
src/
  renderer/
    shell.html        ← body data-theme + 内嵌样式变量化 + 设置页主题区块
    kanban.css        ← 色值变量化（看板/时间线/编辑器渲染）
    skills.css        ← 色值变量化
    kanban.js         ← 主题切换监听（settings changed → data-theme）【T2】
    skills.js         ← 同上（或集中 shell 入口）
    vendor/
      easymde-dark.css ← 变量化（T3）
      easymde-light.css ← 新增亮色变体（T3）
  settings/
    SettingsProvider.ts ← theme 字段读/写/校验（T2）
```

## 7. 风险与对策

| 风险 | 缓解 |
|:-----|:-----|
| 色值抽取遗漏（硬编码残留） | 验收6 grep 断言（`grep -rn "#[0-9a-fA-F]\{3,6\}" src/renderer/` 除变量定义处）；单测覆盖 |
| 亮色对比度不足 | 亮色集基于暗色反相 + 主色调暗；验收5 目测 + 截图断言 |
| 设置页即时切换闪烁 | data-theme 切换原子（单属性），无重载 |
| EasyMDE 亮色不完整 | vendor 亮色 CSS scoped，e2e 断言编辑器在亮色下可读 |

## 8. 核验记录

> 交付核验时填写（实现 vs 方案偏离清单）。

## 评审记录

> 评审通过后填（评审人/机制 + 日期 + 结论），未 frozen 不进实现。
