# 2026-09-04 工具类与组件变体类撞名 → 隐式样式污染

**引用编号**：LESSON-20260904-01

## 现象

设置页「运行中」与地址徽标垂直错位 8px（地址偏低）。表象极像字体光学差异（CJK vs 拉丁数字），首轮分析差点按"光学对齐"处理。

## 根因

shell.html 同时存在：

- 全局工具类：`.muted { font-size: …; color: …; margin-top: var(--space-4); }`
- 徽标语义变体：`.badge.muted { background: …; color: …; }`

`badge()` 输出 `<span class="badge muted">` → 同时命中两条规则，白吃一个 16px margin-top。flex `align-items: center` 按 **margin-box** 居中 → 徽标本体下沉 8px。同 bug 波及 3 处（settings/notifs/workflows 徽标）。

## 规则沉淀

1. **全局工具类禁止用单字通用词**（`muted`/`hidden`/`active`/`error` 这类组件变体高频词），用带前缀的语义名（如 `.u-muted`）或直接限元素选择器（`p.muted`）
2. **组件 modifier 类名选择前，先 grep 全局样式表查撞名**——撞名污染是静默的，CSS 不报错、只在特定组合下显形
3. **flex 容器里子元素"错位"先查 margin-box**：`align-items:center` 对 margin-box 居中，任何隐式 margin 都会变成位移；排查时用 DevTools 看 computed margin，别先怀疑字体渲染

## 引用

- 实现记录：`docs/lessons/2026-09-04-shell-nav-tokens-ui-fixes.md` #3
- 修复：shell.html `.muted` → `p.muted`
