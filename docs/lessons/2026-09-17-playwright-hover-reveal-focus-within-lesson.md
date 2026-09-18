# e2e 点「hover 显形按钮」：用 focus-within 显形，别用 force / 别裸 click

> 日期：2026-09-17 · 场景：kanban-bugfix BUG-2 · 状态：已采用（根因非 UI 回归）

## 背景

`.kb-card-ops`（卡片操作区）设计为 hover 显形：`opacity:0; pointer-events:none`，仅 `.kb-card:hover / :focus-within` 时 `pointer-events:auto`。真鼠标悬停即可点（设计意图），但 **Playwright 合成悬停不触发 CSS `:hover`** → 命中测试恒报「`.kb-card` intercepts pointer events」，`click()` 超时（58 次重试一致）。

排查结论：无遮挡元素、无 z-index 问题、与卡片角标无关——是测试与「pointer-events:none + hover 显形」模式不兼容，非产品回归。

## 决策

```ts
const verifyBtn = shell.locator('[data-verify="t_vfy"]');
await verifyBtn.focus();   // 触发应用的 :focus-within 显形（与悬停同源）
await verifyBtn.click();   // 显形后正常命中
```

不用的方案：
- `click({ force: true })`：绕过命中测试，掩盖「按钮当前是否可点」，且未走真实可点路径；
- 裸 `click()`：对 `pointer-events:none` 的 hover 显形按钮恒失败。

## 可复用

任何「hover 才可点的控件」写 e2e：**优先 `focus()`**（键盘可达性本身就是该模式的配套保证，`:focus-within` 与 `:hover` 同源显形）；`force` 只作最后手段并注释原因。

真回归判断：若 `:hover` 显形在**真实浏览器**失效（而非仅 Playwright 合成事件下），才属于产品 CSS 问题——先这样区分，避免把测试环境问题当 UI 回归修、或反之。
