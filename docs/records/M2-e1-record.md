# E1 实现记录（看板 ticket 内容编辑器升级）

- 契约：docs/api/feishu-e1-kanban-editor-api-contract.md（冻结 v0.1，0 IPC + 19 场景）
- 共识：docs/spec/共识-Hull桌面壳-M2看板编辑器.md（CON-R-editor-001~006 + Q-041~047）
- 判级：常规（纯 renderer 前端改造）；轻量管道（lint 单遍 + 基线核验）
- 交付时间：2026-08-23

## 变更清单

| 文件 | 变更 |
|---|---|
| src/renderer/vendor/easymde.min.js | 新增 vendored EasyMDE 2.21.0（UMD，含捆绑 CM5） |
| src/renderer/vendor/easymde.min.css | 新增（与 JS 同源同版本） |
| src/renderer/vendor/markdown-it.min.js | 新增 vendored markdown-it **14.1.0**（UMD；v15 起无 UMD，锁死 CON-R-editor-004） |
| src/renderer/vendor/purify.min.js | 新增 vendored DOMPurify 3.4.14（UMD） |
| src/renderer/vendor/markdown-it-task-lists.js | 新增 task-lists 2.1.1（上游仅 CJS，本地 UMD shim 包装，零依赖） |
| src/renderer/vendor/easymde-dark.css | 新增 CM5 暗色主题，scoped `.EasyMDEContainer`（tokens #171c26/#1e2430/#2a3342/#2e8bf5）+ FA 缺位 unicode 图标兜底 |
| src/renderer/shell.html | head 加 vendor CSS `<link>`×2（先于 kanban.css）；body 尾加 vendor JS `<script>`×4（先于 kanban.js） |
| src/renderer/kanban.js | mdRender 管线（markdown-it breaks:true + task-lists → DOMPurify）；createEditor 工厂（三入口）；modal 关闭清理栈 kbOnClose + ESC；detail desc/timeline comment 走 Markdown 渲染；保存取 editor.value().trim()\|\|null；markdown 链接代理 hull:openExternal |
| src/renderer/kanban.css | .kb-detail-desc/.kb-tl-content 去 pre-wrap；新增 .kb-md markdown 元素样式（含 EasyMDE 预览面板共用选择器，Q-047 两端一致） |
| package.json / package-lock.json | dependencies + easymde@2.21.0 / markdown-it@14.1.0 / dompurify@3.4.14 / markdown-it-task-lists@2.1.1（vendor 源，运行时不经 node_modules） |
| tests/e2e/kanban.spec.ts | 新增 describe「E1 看板编辑器」4 用例（场景映射见下） |

## 行为契约落点

- FE-1 生命周期：每次打开 `new EasyMDE`，`wrap.kbOnClose` 清理栈在 close 时 destroy + 移除 document keydown 监听；不复用实例。edit 预填 `initialValue(t.description ?? '')`。
- FE-2 消毒全覆盖：用户内容进 HTML 仅两出口（detail desc、timeline comment），均 `DOMPurify.sanitize(md.render())`；库缺失兜底 esc 纯文本不抛错。
- FE-3 CSP/vendoring：全部本地 `<script src>`/`<link>`，无 CDN；`autoDownloadFontAwesome:false` 禁 EasyMDE 运行时注入 FA CDN link（否则每次开编辑器触发 style-src 违规告警）。
- FE-4 GFM：markdown-it 默认 table+strikethrough（输出 `<s>`）+ task-lists 插件；EasyMDE preview 经 `previewRender` 复用同一 mdRender 管线——两端语义一致由构造保证。
- FE-5 暗色：easymde-dark.css 全部选择器 scoped `.EasyMDEContainer`（注：契约写 `.EasyMDE`，实测 v2.21 根容器类名为 `EasyMDEContainer`，语义同「scoped 到 EasyMDE 容器」）；渲染产物样式补 kanban.css。
- FE-6 焦点/ESC：编辑器初始化后 `codemirror.focus()`；ESC 在 document 冒泡层关闭弹窗（CM5 默认不绑 ESC，编辑器不吞）；Tab 序 = 工具栏→编辑区→按钮（DOM 自然序）。
- FE-7 一致性：previewRender 与详情读态同一函数，e2e 断言两端同类元素渲染。

## E15 消毒覆盖审计（kanban.js innerHTML 站点全枚举）

| 站点 | 用户内容处理 |
|---|---|
| renderEmpty | 静态模板，无用户内容 |
| boardToolbar | esc(b.name/c.name/filterQ)；id 为系统 UUID |
| renderBoard | esc(c.name)；c.color 系统 hex |
| cardHtml | esc(priority/labels/title/description) |
| renderList / renderArchive | esc 全量；col.color 系统 hex |
| modal() 外壳 | esc(title)；bodyHtml 由调用方构造 |
| openDetail 模板 | head/meta/sub/timeline who/time 均 esc；**description → mdRender(DOMPurify)**；**comment content → mdRender**；execution/system content 维持 esc |
| promptNewTask / editTask / promptNewColumn / editColumn / openColumnMgr | esc 全量；color 系统 hex |
| showApproval | esc(task.title/message/requestId) |

结论：无裸插用户内容路径；两处 Markdown 出口均消毒。

## Q-042 关闭证据（CSP/CM5 实测）

- e2e 抓 console：编辑器打开 + 预览切换后 **零 CSP 违规告警**（autoDownloadFontAwesome:false 后 FA CDN 注入消失；spellChecker:false 后词典请求消失）。
- CM5 样式全部走 vendor 独立 CSS 文件（style-src 'self'）；未依赖 inline style 兜底。
- 存量 console error：`skills.js ERR_FILE_NOT_FOUND` —— 并行 skills 工作流在 shell.html 尾部新加的 `<script>`（非 E1 引入，资源未就绪），与本需求无关。

## E12 体积记录（gzip 实测）

| 资产 | raw | gzip |
|---|---|---|
| easymde.min.js | 327KB | 104KB |
| markdown-it.min.js | 124KB | 43KB |
| purify.min.js | 29KB | 11KB |
| markdown-it-task-lists.js | 4KB | 1.4KB |
| easymde.min.css + easymde-dark.css | 16KB | 4.2KB |
| **合计** | | **~164KB** |

预算 ~160KB（量级口径）：DOMPurify 实际 11KB（<15 预估）、EasyMDE 107KB（≈105 预估），总量落在预算量级内（偏差 +2.5%，软上限）。

## 验证结果

| 项 | 结果 |
|---|---|
| npx tsc --noEmit | FAIL→基线即 FAIL：全部错误位于 src/skills/*.test.ts（缺模块，stash 基线复现一致，并行工作流所致）；E1 文件（renderer 纯 JS）不在编译面，零新增错误 |
| npm test | 编译步被上述 src/skills 基线错误阻断（非 E1）；绕过编译门单独跑 dist/kanban：KanbanStore.test 41 pass + b5/b5-roundtrip 32 pass，0 fail（KanbanStore 未触碰） |
| e2e kanban.spec.ts | 8/8 pass（B2 存量 4 + E1 新增 4：三入口/round-trip/null、GFM 结构化渲染+任务列表、XSS 三载荷不执行、comment markdown+开关 5 次 destroy 无泄漏） |
| e2e settings + cold-start | 5/5 pass（壳页加载含 vendor 资源回归） |

### E1 用例 ↔ 契约场景映射

- 三入口 EasyMDE 呈现；create markdown round-trip 落盘；空描述 null；edit 预填；ESC 关闭 → E1/E2/E3/E10(部分)/E19
- detail 结构化渲染 h1/strong/li/table/pre+code/a + 任务列表 checkbox ×2 → E4/E17
- XSS img onerror/script/javascript: href 不执行、文本可见、dialog 未触发、window.__xss===0 → E6/E7/E8
- comment EasyMDE → timeline content 原样落盘 + 重开渲染 strong；反复开关 5 次 .EasyMDEContainer 归零 → E9/E13
- E5/E11/E16 由渲染管线性质覆盖（breaks:true 保换行；round-trip 即持久化；preview=详情同管线），未单独立用例

## 偏差记录

1. **并行工作流共享工作树**：实现期间 src/kanban（T2 startDate）/src/exec/src/skills/shell.html(skills.js) 被其他需求流并发修改；E1 未触碰这些文件，tsc/test 基线破损均归因该并发态（stash 基线复现验证）。
2. **create 弹窗初始焦点 = 标题输入框**（现有行为保留），edit/detail 弹窗初始焦点 = 编辑器。契约 E19「初始 focus 在编辑器」按编辑弹窗口径执行；create 场景标题为首个必填字段，聚焦描述编辑器会倒逼回跳。
3. **工具栏裁剪**：去 guide（外链导航风险）与 fullscreen（弹窗内无意义），保留 GFM 全套 + 双预览；契约要求「工具栏+侧边预览+内置快捷键」满足。
4. **markdown 链接点击代理**（新增防御，契约未显式要求）：壳窗口无 setWindowOpenHandler/will-navigate 守卫，渲染出的 `<a>` 默认点击会把壳页导航走飞；统一 preventDefault，http(s) 经既有 hull:openExternal（主进程协议校验）打开浏览器，其余 href 阻断。零新 IPC。
5. **图标兜底**：FA 字体未 vendor（体积/范围考量），工具栏按钮以 unicode 字形 + title 可访问名呈现。
