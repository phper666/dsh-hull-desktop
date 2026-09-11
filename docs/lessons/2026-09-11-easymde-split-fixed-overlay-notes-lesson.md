# EasyMDE 分屏（side-by-side）嵌入面板的定位陷阱

| 项 | 内容 |
|:---|:-----|
| 背景 | 笔记视图把 EasyMDE 嵌入右侧面板（非全页编辑器），启用 `分屏` 模式后用户报告「无法返回上一层，只能关闭应用」 |
| 决策或坑 | vendored EasyMDE 的 `.editor-preview-side` 是 `position: fixed; top: 50px; right: 0; width: 50%; z-index: 9`——它假定编辑器占满整页；嵌入面板时该固定层盖住窗口右半屏（含模式切换按钮），点击全被拦截。修复两层：① `sideBySideFullscreen: false`（容器持 `sided--no-fullscreen`，分屏改为行内布局）② CSS 兜底把预览层囚回容器内（容器 `position: relative`，预览层绝对定位于容器） |
| 影响 | 不修则分屏是「单向门」——用户被困只能重启应用（实测发生） |
| 适用范围 | 任何把 EasyMDE/CodeMirror 系编辑器嵌入局部容器（面板/抽屉/弹窗）并启用 side-by-side 的场景；全页编辑器不受影响 |
| 来源 | 出生：来源子需求 N2 + 来源 PRD `2026-09-07-notes-prd.md`；引用：共识 v1.1（CON-R-notes-008 编辑链路）；代码 `src/renderer/notes.js`（sideBySideFullscreen:false）+ `notes.css`（预览层 absolute 覆盖）；提交 `eb78be1` |
| 引用 | 首次引用：N2 实现（2026-09-11，功能缺陷修复）；后续复用 +1 |
