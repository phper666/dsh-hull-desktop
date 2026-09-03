# 复制视图脚本残留跨文件内部引用 → IIFE 顶层 ReferenceError 整视图死（渲染层无单测盲区）

| 项 | 内容 |
|:---|:-----|
| 背景 | workflows 视图（src/renderer/workflows.js）新建时从 connections.js 复制 IIFE 骨架，残留一行 `void loadList;`——`loadList` 是 connections.js 的**内部函数**，workflows.js 里不存在。IIFE 求值到未声明标识符直接抛 ReferenceError → `renderList()` 永不执行、`window.__workflowsRefresh` 永不挂载 → 导航「工作流」空转、视图完全不可用。用户侧表现「完全不能用」。引入时 721 单测全绿（单测只覆盖主进程引擎/存储，渲染层 JS 零覆盖）。 |
| 决策或坑 | 渲染层 IIFE 顶层引用未定义标识符 = 整脚本死，且**单测测不到**——只靠运行时暴露。复制视图脚本骨架时，其他视图的内部函数名（loadList 等）是最隐蔽的残留源。检测法：grep 新视图脚本里是否有他视图专属函数名（`grep -n "loadList\|renderList\|..." workflows.js` 对照）。修复 = 删残留行，1 行。 |
| 影响 | 不这样做：渲染层 bug 单测盲区，只有用户上线后「完全不能用」才暴露，排查成本高。这样做：跨视图复制骨架时对照内部函数引用，渲染层脚本顶层做一次「未定义标识符」扫描（或至少 grep 他视图函数名），成本近乎零。 |
| 适用范围 | 任何「复制已有视图脚本骨架建新视图」的场景；渲染层无单测覆盖的项目尤甚。也适用于任何 IIFE 顶层初始化代码引用未定义变量的排查。 |
| 来源 | 出生：需求 workflows（2026-08-31，commit da3208f 引入）；修复：src/renderer/workflows.js 删 `void loadList;`（2026-09-02）；引用：docs/design/工作流-workflows-design.md |
| 引用 | 首次引用：本 lesson 出生（2026-09-02） |
