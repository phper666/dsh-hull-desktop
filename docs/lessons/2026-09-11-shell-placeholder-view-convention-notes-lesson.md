# shell 视图 section 容器约定：`:not(.hidden)` 覆盖 + `-root` 撑满

| 项 | 内容 |
|:---|:-----|
| 背景 | 笔记视图首次集成后整体缩成居中一小团（布局「完全乱了」），用户截图反馈 |
| 决策或坑 | shell.html 的 `.placeholder` 是「绝对定位 + 居中 flex」的占位样式；新视图 section 若只加 `class="placeholder hidden"` 而不在自己的模块 CSS 里写两条规则，内容会被居中容器挤压：① `#x:not(.hidden) { position:absolute; inset:0; z-index:10; display:block }`（顶掉占位居中 + 压过官方 UI 容器）② `#x-root { width:100%; height:100%; ... }`（撑满内容区）。`#board`/`#skills`/`#notifs` 都遵守此约定，笔记漏抄即中招 |
| 影响 | 漏写则该视图渲染成一团居中内容（结构没坏但完全不可用），且只有运行时可见——DOM-stub 单测抓不到 |
| 适用范围 | 所有在 shell.html 中新增/修改视图 section 的模块（本壳所有 nav 视图） |
| 来源 | 出生：来源子需求 N2 + 来源 PRD `2026-09-07-notes-prd.md`；引用：代码 `src/renderer/notes.css`（`#notes:not(.hidden)` + `#notes-root`）；提交 `c6e4b15`（修复） |
| 引用 | 首次引用：N2 集成修复（2026-09-11）；后续复用 +1 |
