# Hull 桌面壳（M2 看板编辑器）共识文档

> 版本：v1.2 已发布 · 更新：2026-08-22 · 维护者：phper666（PM） · 状态：已发布
> 数据来源：看板 ticket 内容编辑器升级 PRD v0.2（docs/prd/2026-08-22-kanban-editor-prd.md，已定稿）
> 关联：父共识 M2 看板（docs/spec/共识-Hull桌面壳-M2看板.md）——共享术语见父共识 §3，本共识只引用不重复定义；增量（编辑器升级），不污染父共识 v1.4 冻结基线

## 1. 文档元信息

- **本版本变更**：v1.2 —— 扫描结论回写（PM 决策，solo 上下文）：**Q-041~Q-047 全部 closed**。① Q-041 EasyMDE 实例生命周期——弹窗关闭 `editor.destroy()` + 移除事件监听，每次打开新建实例不复用（防泄漏），内存泄漏检测进 QA；② Q-042 CSP/CodeMirror 兼容——实现前验证，CM5 主题优先 vendor 独立 CSS 文件（`<link>`，style-src 'self'），运行时强制 inline 则兜底 style 'unsafe-inline'（script 仍 'self'）；③ Q-043 DOMPurify 覆盖面——枚举 kanban.js 全部 innerHTML/insertAdjacentHTML 站点统一消毒 + 审计清单；④ Q-044 GFM 插件清单定案——markdown-it v14 默认（table+strikethrough）+ markdown-it-task-lists，**U-2 一并关闭**；⑤ Q-045 暗色主题——vendor CM5 暗色 CSS scoped `.EasyMDE` + markdown-it 渲染样式补 kanban.css；⑥ Q-046 弹窗焦点/ESC——初始化 focus、ESC modal 层优先、Tab 工具栏→编辑器→按钮；⑦ Q-047 预览/渲染一致性 e2e 用例（语义一致即可）。CON-R-editor-001/002 备注补充、CON-R-editor-005 定案生效。状态：**已发布**。
- **历史变更摘要**：v1.1 —— U-1 定案 comment 框升级 EasyMDE（推翻 v1.0 默认保持 textarea 建议）；CON-R-editor-006 生效定案；同步回写 §2/§6/§9/§12/§14.1 E1/§15.3、规则索引、PRD v0.2。v1.0 首次建立（编辑端 create/edit textarea → EasyMDE、渲染端 markdown-it + DOMPurify、三库本地 vendoring、数据零迁移、登记 CON-R-editor-001~006、未决项 U-1~U-3）。各版本变更详情见 `docs/spec/变更摘要-M2看板.md`。

## 2. 文档结构总览

- **覆盖**：看板 ticket 内容编辑器全部面——编辑端（create/edit 两处 EasyMDE 实例，工具栏 + 侧边预览 + 快捷键）、渲染端（detail 只读态 markdown-it 渲染 + DOMPurify 消毒）、依赖 vendoring（EasyMDE / markdown-it / DOMPurify 本地引入 + shell.html `<script src>`）、数据零迁移（description 语义不变）。
- **适用范围**：仅 Hull 壳内看板 ticket 内容编辑器；**不覆盖** dsh 官方业务（dsh 领域，Hull 只做容器）。
- **不做事项（本期明确排除）**：数据迁移（无——旧纯文本按 Markdown 渲染，纯文本即合法 Markdown 天然兼容）；富文本 WYSIWYG；图片上传/粘贴（TBD，见 §11 U-3）；其他模块编辑器（另行立项）。~~评论框改造默认不升级~~（**已推翻**——U-1 定案 comment 框升级 EasyMDE，见 §11/§12）。
- **红线相容**：数据零迁移 → description 结构与 boards.json 存储不变，不碰 DSH_HOME（CON-R002 相容）；走官方扩展点/壳内原生渲染（CON-R004 相容）；渲染端一律 DOMPurify 消毒（用户内容不可直接进 innerHTML）。

## 3. 领域术语表

> 看板/任务/描述/时间线等共享术语见 父共识（共识-Hull桌面壳-M2看板.md）§3，此处仅定义本增量引入的新词。

| 术语 | 定义 | 出处 |
|:-----|:-----|:-----|
| Markdown 编辑器 | 支持 Markdown 语法书写 + 实时预览的富书写控件；本增量选用 EasyMDE（编辑端）+ markdown-it（渲染端）组合 | PRD §2 |
| EasyMDE | 轻量 Markdown 编辑器（v2.21.0，MIT，~105KB gzip）；单文件 IIFE UMD 全局 `window.EasyMDE`，自带工具栏 + 侧边预览 + 快捷键；本地 vendoring `<script src>` 引入 | PRD §2 |
| markdown-it | Markdown 渲染器（v14.1.0，MIT，~46KB gzip）；UMD 全局 `window.markdownit`；只读详情渲染用；**锁 v14.1.0（v15 起无 UMD build）** | PRD §2/§8 |
| DOMPurify | HTML 消毒库（UMD）；用户内容进 HTML 前一律消毒（XSS 兜底） | PRD §2/§5 |
| vendoring | 第三方库以本地文件形式随壳分发（`src/renderer/vendor/` 或等价目录），不依赖 CDN/网络 | PRD §5 |
| GFM | GitHub Flavored Markdown 扩展（表格/任务列表/删除线）；编辑端 EasyMDE 默认支持，渲染端需对应开启才能一致 | PRD §6 T2 |
| 数据零迁移 | description 字段类型/存储不变（string\|null，Markdown 即纯文本），boards.json 结构与 schema version 零改动，KanbanStore 读写逻辑不变 | PRD FR-3 |

## 4. 模块概述

- **定位**：看板 ticket 内容编辑器升级——把纯 `<textarea>` 换为支持 Markdown 书写 + 预览的编辑器，详情只读态渲染 Markdown，让 ticket 描述结构化（标题/列表/代码块）。数据零迁移的增量改造，不触碰看板数据模型。
- **业务目标**：① 编辑体验（create/edit 工具栏 + 预览 + 快捷键）；② 详情只读态 Markdown 渲染；③ 安全（用户内容进 HTML 一律 DOMPurify 消毒）；④ 数据零迁移（boards.json 结构不变）。
- **参与角色**：当前 solo（pm/be/fe/qa = phper666）；用户是唯一操作者；agent（dsh）为执行方（非操作者，本增量不涉）。
- **子模块清单**：编辑端（create/edit EasyMDE 实例）、渲染端（detail 只读 markdown-it + DOMPurify）、依赖层（三库 vendoring + shell.html script 引入）、接入点四处（create/edit/comment/detail，见 §12）。

## 5. 业务流程与状态机

本增量不引入状态机（编辑器无生命周期状态）。核心流程两条：

### 5.1 编辑流程（create / edit / comment）

```
打开 create/edit 弹窗或 comment 框 → EasyMDE 初始化（textarea → 编辑器）→ 用户输入 Markdown（工具栏/快捷键辅助）→ 保存 → 取编辑器纯文本内容 → 写入 description（string|null，空存 null）→ boards.json 原子写
```

- create/edit 保存时取值 = EasyMDE 编辑器纯文本内容（Markdown 原样），空内容存 `null`。
- **comment 框（kanban.js:226）同样升级 EasyMDE**（U-1 定案）：评论内容 = 编辑器纯文本（Markdown 原样）；评论渲染时同样走 markdown-it + DOMPurify 消毒（CON-R-editor-002，评论是用户内容）。

### 5.2 渲染流程（detail 只读）

```
打开详情 → 读 description（string|null）→ markdown-it 渲染为 HTML → DOMPurify 消毒 → 插入 DOM
```

- **凡用户输入进 HTML 的路径统一走 DOMPurify**（含 history/邮件地址等其余只读文本）；纯文本描述渲染结果与原文一致（Markdown 天然兼容）。

## 6. 角色与权限矩阵

| 操作 | 用户 | 壳（系统） | 说明 |
|:-----|:-----|:-----------|:-----|
| 创建/编辑 ticket 描述（Markdown） | ✅ | — | create/edit 走 EasyMDE |
| 评论（comment 框） | ✅ | — | 走 EasyMDE（U-1 定案），渲染消毒见 CON-R-editor-002 |
| 查看详情（渲染 Markdown） | ✅ | — | markdown-it 渲染 + DOMPurify 消毒 |
| 消毒（用户内容进 HTML） | — | ✅ DOMPurify | 渲染端强制；review 重点核查 |

## 7. 字段业务定义

> 本增量仅涉及 `description` 字段；其余字段（title/columnId/executionMode 等）见 父共识 §7.1，零改动。

| 字段 | 语义 | 必填 | 来源 | 枚举/默认 | 敏感性 |
|:-----|:-----|:-----|:-----|:----------|:-------|
| description | 任务描述（Markdown 文本）；保持 string\|null，Markdown 即纯文本，空内容存 null | 否 | 用户 | string \| null（**类型/存储不变**） | 无 |

- **数据零迁移（FR-3）**：`boards.json` 结构不变、schema version 不变、`KanbanStore.ts` 读写逻辑不变；旧纯文本描述按 Markdown 渲染（纯文本即合法 Markdown，天然兼容）。

## 8. 业务规则清单

> 独立编号域 CON-R-editor-xxx（不占用存量 CON-R001~R033）；登记于 `docs/spec/规则索引.md`。

| 编号 | 规则描述 | 来源 | 当前结论 | 变更状态 |
|:-----|:---------|:-----|:---------|:---------|
| CON-R-editor-001 | 编辑端用 EasyMDE（create/edit 两处 textarea → EasyMDE 实例，工具栏 + 侧边预览 + 快捷键）；本地 vendoring（`src/renderer/vendor/`），shell.html `<script src>` 引入，CSP script-src 'self' 不走 CDN。**备注（Q-041/Q-042/Q-045）**：① 实例生命周期——create/edit/comment 弹窗关闭时调用 `editor.destroy()` + 移除事件监听；同一弹窗每次打开新建实例、关闭销毁（不复用，防内存泄漏），泄漏检测进 QA；② CSP/CM5 兼容——实现前验证，CM5 主题优先 vendor 为独立 CSS 文件（`<link>` 引入，style-src 'self'）避免 inline，若 CM5 运行时强制 inline style 则 shell.html CSP 仅对 style 加 'unsafe-inline'（script 仍 'self'），实测决定并记录；③ 暗色主题——vendor CM5 暗色主题 CSS（基于 kanban.css tokens #1e2430/#2a3342）scoped 到 `.EasyMDE` 容器 | PRD FR-1/§5 + 扫描 Q-041/Q-042/Q-045 | 生效 | 稳定 |
| CON-R-editor-002 | 渲染端 markdown-it + DOMPurify 消毒：detail 只读态 markdown-it 渲染 → DOMPurify 消毒 → 插 DOM；**凡用户内容进 HTML 的路径统一走 DOMPurify**（含 history/邮件等其余只读文本）。**备注（Q-043 覆盖面审计）**：枚举 kanban.js 所有 innerHTML/insertAdjacentHTML 站点（description 详情/comment 渲染/timeline 条目/附件名/assignee/labels/card 标题预览等），全部走 `DOMPurify.sanitize`；审计清单写入实现记录，Review 核查漏消毒路径 | PRD FR-2/§5 + 扫描 Q-043 | 生效 | 稳定 |
| CON-R-editor-003 | 数据零迁移：description 保持 string\|null（Markdown 即文本，空存 null），boards.json 结构/schema version 不变，KanbanStore 读写逻辑不变，不碰 DSH_HOME（CON-R002 相容） | PRD FR-3 | 生效 | 稳定 |
| CON-R-editor-004 | markdown-it 锁 v14.1.0：v15 起无 UMD build（构建失效），vendoring 固定版本，不随 @latest 升级 | PRD §8 风险表 | 生效 | 稳定 |
| CON-R-editor-005 | GFM 扩展清单（Q-044 定案）：markdown-it v14 默认启用（table 表格 + strikethrough 删除线）+ markdown-it-task-lists 插件（任务列表）；两端对齐 EasyMDE 默认（表格/任务列表/删除线） | PRD §6 T2 + 扫描 Q-044 | **定案（生效）** | 稳定 |
| CON-R-editor-006 | comment 框（:226）升级 EasyMDE：create/edit/comment 三处 textarea 均接 EasyMDE（工具栏 + 预览 + 快捷键）；comment 内容为 Markdown 原样，渲染评论时同样走 markdown-it + DOMPurify 消毒（CON-R-editor-002 适用） | PRD §6 T1（U-1 定案） | **comment 升级 EasyMDE（生效，定案）** | 稳定 |

> 005 已定案（Q-044，v1.2 回写规则索引；U-2 一并关闭）。006 已定案（U-1 关闭）。

## 9. 枚举值与常量

- **接入点四处**：create（kanban.js:192）/ edit（:249）/ comment（:226，EasyMDE，U-1 定案）/ detail 只读（:219）。
- **版本锁**：EasyMDE v2.21.0；markdown-it **v14.1.0**（v15 丢 UMD）；DOMPurify（当前最新 UMD）。
- **体积预算**：新增总 gzip ≤ ~160KB（EasyMDE ~105 + markdown-it ~46 + DOMPurify ~15 量级）；三库均本地 `<script src>` 加载，无 CDN 请求。
- **性能常量**：详情打开渲染 < 100ms（本地小文本，markdown-it 即时）；EasyMDE 初始化对 create/edit 弹层无感知延迟。
- **无障碍基础**：工具栏按钮带可访问名（EasyMDE 默认 aria-label/title）；编辑器可键盘聚焦与 Tab 进出；预览不抢占焦点。

## 10. 第三方对接

| 外部库 | 用途 | 关键点 |
|:-------|:-----|:-------|
| EasyMDE v2.21.0 | 编辑端编辑器（create/edit） | 单文件 IIFE UMD 全局 `window.EasyMDE`；自带 CodeMirror 5（捆绑）——样式需 scoped 到编辑器容器防冲突；本地 vendoring `<script src>` |
| markdown-it v14.1.0 | 渲染端只读详情渲染 | UMD 全局 `window.markdownit`；**锁版本**（v15 无 UMD）；GFM 插件清单已定案（Q-044：table + strikethrough 默认 + markdown-it-task-lists，见 CON-R-editor-005）；配套插件 markdown-it-task-lists 同目录 vendoring（体积极小，不破三库体积预算口径） |
| DOMPurify | 用户内容 HTML 消毒 | UMD；渲染端强制；所有用户内容进 HTML 路径统一走消毒（含其余只读文本） |

- **引入方式**：三库本地文件（`src/renderer/vendor/` 或等价目录）+ shell.html `<script src>` 顺序引入；CSP script-src 'self' 兼容，不走 CDN。
- **CSP/CodeMirror 兼容（Q-042，实现前验证）**：CM5 需要 style 注入——优先 vendor CM5 主题为独立 CSS 文件（`<link>` 引入，CSP style-src 'self'）避免 inline；若 CM5 运行时强制 inline style → shell.html CSP 仅对 style 加 'unsafe-inline'（script 仍 'self'），实现时实测决定并记录。
- **暗色主题（Q-045）**：vendor CM5 暗色主题 CSS（基于 kanban.css tokens #1e2430/#2a3342），scoped 到 `.EasyMDE` 容器；markdown-it 渲染详情样式（标题/列表/代码块）补 kanban.css。

## 11. 未决项登记

> 对应 PRD §6 T1~T3，评审定案后回写相应章节/规则。

| 编号 | 问题 | 负责人 | 阻断等级 | 状态 | 结论 | 回写位置 |
|:-----|:-----|:-------|:---------|:-----|:-----|:---------|
| U-1 | comment 框（:226）是否升级 EasyMDE？ | PM | P2 | **closed** | **升级 EasyMDE**（用户定案 2026-08-22）：comment 也升级，与 create/edit 同规格（工具栏+预览+快捷键）；渲染评论时同样走 DOMPurify 消毒（CON-R-editor-002） | §8 CON-R-editor-006/§12 |
| U-2 | markdown-it 是否启用 GFM 扩展（表格/任务列表/删除线）？ | PM | P1 | **closed** | **启用，清单定案**（Q-044，v1.2）：markdown-it v14 默认（table + strikethrough）+ markdown-it-task-lists（任务列表）；两端对齐 EasyMDE 默认 | §8 CON-R-editor-005/§9/§10 |
| U-3 | 是否支持图片粘贴/上传？ | PM | P2 | open | 建议本期不做（附件机制未到 P2，图片上传涉磁盘写入 + preload 桥新增） | §2 不做事项 |

### 11.1 扫描发现回写（Q-041~Q-047，v1.2 全部 closed）

> 来源：M2 看板编辑器三角色扫描；PM 决策（solo 上下文）逐项定案，2026-08-22 回写。

| 编号 | 问题 | 负责人 | 阻断等级 | 状态 | 结论 | 回写位置 |
|:-----|:-----|:-------|:---------|:-----|:-----|:---------|
| Q-041 | EasyMDE 实例生命周期（弹窗反复开关是否泄漏？） | PM | P1 | **closed** | create/edit/comment 弹窗关闭时调用 `editor.destroy()` + 移除事件监听；同一弹窗每次打开新建实例、关闭销毁（不复用，防泄漏）；内存泄漏检测进 QA | §8 CON-R-editor-001/§13 |
| Q-042 | CSP 与 CodeMirror 5 样式注入兼容？ | PM | P1 | **closed** | 实现前验证：CM5 主题优先 vendor 为独立 CSS 文件（`<link>` 引入，style-src 'self'）避免 inline；若 CM5 运行时强制 inline style → shell.html CSP 仅对 style 加 'unsafe-inline'（script 仍 'self'），实现时实测决定并记录 | §8 CON-R-editor-001/§10 |
| Q-043 | DOMPurify 覆盖面是否完整（漏消毒路径）？ | PM | P0 | **closed** | 枚举 kanban.js 所有 innerHTML/insertAdjacentHTML 站点（description 详情/comment 渲染/timeline 条目/附件名/assignee/labels/card 标题预览），全部走 `DOMPurify.sanitize`；审计清单写入实现记录，Review 核查 | §8 CON-R-editor-002/§13 |
| Q-044 | 渲染端 GFM 插件清单？ | PM | P1 | **closed** | markdown-it v14 默认（table + strikethrough）+ markdown-it-task-lists（任务列表）；两端对齐 EasyMDE 默认（表格/任务列表/删除线）；U-2 一并关闭 | §8 CON-R-editor-005/§9/§10 |
| Q-045 | 编辑器/渲染详情暗色主题适配？ | PM | P2 | **closed** | vendor CM5 暗色主题 CSS（基于 kanban.css tokens #1e2430/#2a3342），scoped 到 `.EasyMDE` 容器；markdown-it 渲染详情样式（标题/列表/代码块）补 kanban.css | §8 CON-R-editor-001/§10 |
| Q-046 | 弹窗内焦点管理与 ESC 关闭冲突？ | PM | P2 | **closed** | EasyMDE 初始化后 focus；modal ESC 关闭优先于编辑器（modal 层 keydown 冒泡阶段处理，编辑器不拦截）；Tab 顺序：工具栏→编辑器→保存/取消按钮 | §12 |
| Q-047 | EasyMDE preview 与 markdown-it+GFM 渲染一致性？ | PM | P1 | **closed** | e2e 用例比对两者渲染同一 Markdown 的结构（标题/加粗/列表/表格/任务列表）；语义一致即可，视觉差异记录不阻断 | §13/§14.1 E1 |

## 12. 页面交互规范

| 接入点 | 位置 | 功能 | 权限 | 数据范围 |
|:-------|:-----|:-----|:-----|:---------|
| create | kanban.js:192 | textarea → EasyMDE：Markdown 工具栏（加粗/斜体/标题/链接/图片/列表/引用/代码/表格/水平线/清除格式）+ 侧边实时预览 + 常用快捷键（Ctrl/Cmd+B/I、代码块、预览切换等内置默认）；保存取值 = 编辑器纯文本（Markdown 原样）写 description | 全量 | 单卡片 |
| edit | kanban.js:249 | 同上（编辑已有 description，EasyMDE 预填现值） | 全量 | 单卡片 |
| comment | kanban.js:226 | textarea → EasyMDE（U-1 定案）：同 create/edit 规格（工具栏 + 预览 + 快捷键），保存取值 = 编辑器纯文本（Markdown 原样）；评论内容渲染时走 markdown-it + DOMPurify 消毒 | 评论可写 | 单卡片 |
| detail 只读 | kanban.js:219 | escape 纯文本 → markdown-it 渲染 + DOMPurify 消毒 → 插 DOM | 只读 | 单卡片 |

- **弹窗焦点/ESC（Q-046）**：EasyMDE 初始化后 focus；modal ESC 关闭优先于编辑器（modal 层 keydown 冒泡阶段处理，编辑器不拦截 ESC）；Tab 顺序：工具栏→编辑器→保存/取消按钮。
- **实例生命周期（Q-041）**：create/edit/comment 弹窗每次打开新建 EasyMDE 实例、关闭时 `editor.destroy()` + 移除事件监听（不复用，防泄漏）。

## 13. 后端任务规范

本增量无后端任务（纯 renderer 前端改造）。关联约束：

- **消毒强制**：渲染端所有用户内容进 HTML 路径统一走 DOMPurify（FR-2 强制）；Review 重点核查漏消毒路径。**覆盖面审计（Q-043）**：枚举 kanban.js 所有 innerHTML/insertAdjacentHTML 站点，全部走 `DOMPurify.sanitize`；审计清单写入实现记录。
- **版本锁定**：markdown-it 固定 v14.1.0（vendoring 固定版本，升级需人工评估 UMD 可用性）。
- **数据零迁移**：不新增 IPC、不新增字段、不迁移 boards.json（preload 桥不变，无新增 IPC，PRD §5）。
- **实例生命周期（Q-041）**：create/edit/comment 弹窗关闭时 `editor.destroy()` + 移除事件监听，每次打开新建实例不复用；内存泄漏检测进 QA。
- **预览/渲染一致性（Q-047）**：e2e 用例比对 EasyMDE preview 渲染 vs markdown-it+GFM 渲染同一 Markdown 的结构（标题/加粗/列表/表格/任务列表）；语义一致即可，视觉差异记录不阻断。

## 14. 端差异汇总

本模块不涉及（单端桌面应用，无多端差异）。

### 14.1 子需求清单（E1，单子需求）

> 需求标识 kanban-editor；负责人 phper666。判级：**常规**（无需技术方案文档）。待评审定案后转实现。

| # | 子需求 | 验收标准（可测试） | 规则绑定 | 依赖 | 来源 PRD | 飞书 ticket |
|:--|:-------|:-------------------|:---------|:-----|:---------|:------------|
| E1 | 看板 ticket 内容编辑器升级（EasyMDE + markdown-it + DOMPurify） | ① create/edit/comment 打开显示 EasyMDE（工具栏+预览）；输入 Markdown 保存后 boards.json description 为对应 Markdown 字符串（空为 null）；② detail 只读渲染 markdown（标题/加粗/列表/代码块/链接→HTML），纯文本描述渲染与原文一致；③ XSS 载荷（`<img onerror=...>` / `<script>alert(1)</script>` / `[link](javascript:alert(1))`）注入后打开详情**不执行**（DOMPurify 拦截）；④ 旧 ticket 纯文本正常渲染，不报错不丢内容；⑤ 编辑保存后重启壳 boards.json 数据完整、description 为保存的 Markdown（schema 未变）；⑥ 新增依赖体积 ≤ ~160KB gzip 总量，三库均本地 `<script src>` 加载无 CDN 请求；⑦ EasyMDE 弹窗关闭 `editor.destroy()` + 移除事件监听（Q-041）；⑧ CSP/CM5 兼容实测记录（Q-042）；⑨ innerHTML 站点全消毒审计清单入实现记录（Q-043）；⑩ 预览/渲染一致性 e2e：EasyMDE preview vs markdown-it+GFM 同一 Markdown 结构语义一致，视觉差异记录不阻断（Q-047） | CON-R-editor-001~006 | 无（renderer 独立） | 2026-08-22-kanban-editor-prd.md | E1（待 ticket 化） |

## 15. 附录与版本记录

### 15.1 文档关联

- **关联**：PRD（docs/prd/2026-08-22-kanban-editor-prd.md）、父共识（docs/spec/共识-Hull桌面壳-M2看板.md）、规则索引（docs/spec/规则索引.md）。

### 15.2 版本记录

| 版本 | 日期 | 变更摘要条目 | 说明 |
|:-----|:-----|:-------------|:-----|
| v1.2 已发布 | 2026-08-22 | 变更摘要-M2看板.md（2026-08-22 kanban-editor 扫描回写） | 扫描 Q-041~Q-047 全部 closed 回写（实例生命周期/CSP 兼容/DOMPurify 覆盖面/GFM 插件清单/暗色主题/焦点 ESC/预览一致性）；U-2 一并关闭；CON-R-editor-005 定案；§14.1 E1 子需求清单补全（对齐父共识 7 列格式 + 判级常规） |
| v1.1 已发布 | 2026-08-22 | 变更摘要-M2看板.md（2026-08-22 kanban-editor） | U-1 定案：comment 框升级 EasyMDE；CON-R-editor-006 生效；PRD v0.2；规则索引已回写 |
| v1.0 草稿 | 2026-08-22 | 变更摘要-M2看板.md | 首次建立：EasyMDE + markdown-it + DOMPurify 编辑器升级；CON-R-editor-001~006；U-1~U-3（PRD T1~T3） |

### 15.3 后续规划

| 项 | 阶段 | 说明 |
|:---|:-----|:-----|
| ~~comment 框升级~~ | ~~未决（U-1）~~ | **已完成**——U-1 定案升级 EasyMDE（v1.1），随 E1 一并实现 |
| 图片粘贴/上传 | 未决（U-3） | 涉及磁盘写入 + preload 桥新增，附件机制到 P2 再评估 |
| 体积优化 | M2+（非本期） | 评估复用 EasyMDE 内部 markdown 依赖缩体积（ponytail 备注） |
