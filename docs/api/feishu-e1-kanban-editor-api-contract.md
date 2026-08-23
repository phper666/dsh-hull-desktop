# E1 看板 ticket 内容编辑器契约

## 契约信息

- 工作项：E1 看板 ticket 内容编辑器升级（飞书 dsh-hull-desktop 清单，c02c95c2-56b1-41fb-85db-8ea1cb8c4852）
- 契约状态：冻结（2026-08-22，判级常规——纯 renderer 前端改造，无技术方案文档）
- 版本：v0.1
- 适用版本：M2 编辑器增量（共识 v1.2）
- 最后更新：2026-08-22
- 说明：**无接口变更契约**（无新增 IPC、无 HTTP API 面、无数据迁移）；核心 = 复用现有 IPC 的字段语义声明（description/content 从纯文本变为 Markdown 文本）+ 前端行为约束（EasyMDE/markdown-it/DOMPurify 三库接入规则）+ 测试场景。上游数据契约见 B1（docs/api/feishu-b1-m2-kanban-api-contract.md），本契约不修改其任何 Schema。

## 需求与共识追踪

| 能力 | Story | 共识规则 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|---|
| 编辑端 EasyMDE（create/edit） | E1 | CON-R-editor-001 + Q-041/Q-042/Q-045/Q-046 | 共识 §14.1 验收①⑦⑧ | FE-1/FE-3/FE-5/FE-6 | 已定义 |
| comment 框升级 EasyMDE | E1 | CON-R-editor-006（U-1 定案） | 验收①（含 comment）+③ | FE-1/FE-2 | 已定义 |
| 渲染端 markdown-it + DOMPurify | E1 | CON-R-editor-002 + Q-043 | 验收②③④⑨ | FE-2 | 已定义 |
| GFM 插件两端对齐 | E1 | CON-R-editor-005（Q-044/U-2 定案） | 验收②⑩ | FE-4 | 已定义 |
| 数据零迁移 | E1 | CON-R-editor-003 | 验收④⑤ | 无接口变更声明 | 已定义 |
| markdown-it 版本锁 | E1 | CON-R-editor-004 | 验收⑥ | vendoring 契约 | 已定义 |
| CSP/vendoring 兼容 | E1 | CON-R-editor-001 备注② + Q-042 | 验收⑥⑧ | FE-3 | 已定义 |
| 弹窗焦点/ESC | E1 | Q-046 | 交互质量（§12） | FE-6 | 已定义 |
| 暗色主题适配 | E1 | Q-045 | 视觉（kanban.css tokens） | FE-5 | 已定义 |
| 预览/渲染一致性 | E1 | Q-047 | 验收⑩ | FE-7 | 已定义 |

> 验收标准编号对应共识-Hull桌面壳-M2看板编辑器.md §14.1 E1 行①~⑩。

## 范围与非目标

### 范围

- **编辑端**：create（kanban.js:192）/ edit（:249）/ comment（:226）三处 `<textarea>` 接入 EasyMDE v2.21.0 实例（工具栏 + 侧边预览 + 内置快捷键）；保存取值 = 编辑器纯文本（Markdown 原样），空内容存 `null`
- **渲染端**：detail 只读态（:219）description 由 `esc()` 纯文本改为 markdown-it v14.1.0 渲染 → DOMPurify 消毒 → 插 DOM；评论 content（timeline 条目）同样走该管线
- **依赖 vendoring**：三库本地文件（`src/renderer/vendor/`）+ shell.html `<script src>` 引入；CSP script-src 'self' 不走 CDN
- **暗色主题**：CM5 暗色 CSS scoped `.EasyMDE`（基于 kanban.css tokens #1e2430/#2a3342）+ markdown-it 渲染样式补 kanban.css
- **数据零迁移**：`description` 保持 `string|null`（types.ts:98），boards.json 结构/schema version 不变，KanbanStore 读写逻辑不变

### 非目标

- 新增/修改任何 IPC channel 或 preload 桥（PRD §5：preload 桥不变）
- boards.json Schema 变更 / schema version 递增 / 数据迁移脚本
- 富文本 WYSIWYG；图片上传/粘贴（U-3 open，涉磁盘写入 + preload 桥新增）
- 其他模块编辑器；dsh 官方业务（CON-R001 红线）
- 执行引擎/审批流（B3/B4 域）

## 业务流程与状态

### 核心流程（两条，均复用现有 IPC）

```text
编辑：打开 create/edit/comment 弹窗 → EasyMDE 初始化（textarea 替换）→ 输入 Markdown（工具栏/快捷键辅助）
     → 保存 → editor.value().trim() || null → invoke kanban:createTask / updateTask / addComment（现有通道）
     → boards.json 原子写（B1 层，不变）

渲染：打开详情 → 读 description/timeline[].content（string）→ markdown-it 渲染 HTML
     → DOMPurify.sanitize → innerHTML 插入详情容器
```

### 状态转换（编辑器实例生命周期，Q-041）

| 当前状态 | 动作 | 目标状态 | 前置条件 | 冲突行为 | 依据 |
|---|---|---|---|---|---|
| 无实例 | 打开弹窗 | 已初始化（focus） | textarea 存在于 modal DOM | 每次新建实例，不复用 | Q-041 |
| 已初始化 | 弹窗关闭 | 已销毁 | — | `editor.destroy()` + 移除事件监听后随 modal DOM 移除 | Q-041 |
| 已初始化 | 保存成功 | 已销毁 | 取值完成 | 先取值再走 close()（close 内 destroy） | Q-041/FR-1 |
| 已销毁 | 再次打开 | 已初始化（新实例） | — | 不复用旧实例（防泄漏） | Q-041 |

## 接口清单

> **无接口变更声明**：E1 不新增、不修改、不废弃任何 IPC channel。preload 桥零改动。下表为 E1 消费的既有通道（完整请求/响应 Schema 见 B1 契约「接口清单」及「接口详情」#6/#7/#10），唯一变化是 **payload 中用户自由文本字段的字节内容语义**：纯文本 → Markdown 文本。字段类型、可空性、校验规则、存储结构全部不变。

| # | 状态 | 方法 | 路径（IPC channel） | E1 用途 | 相对 B1 变更 | 幂等 |
|---|---|---|---|---|---|---|
| 1 | 复用（零变更） | invoke | `kanban:createTask` | 创建卡片时写入 Markdown description | 无（body.description 类型 string\|null 不变，内容为 Markdown 文本） | 否（创建） |
| 2 | 复用（零变更） | invoke | `kanban:updateTask` | 编辑卡片时更新 Markdown description | 无（同上） | 是 |
| 3 | 复用（零变更） | invoke | `kanban:addComment` | 评论框提交 Markdown content | 无（body.content 类型 string 不变，内容为 Markdown 文本） | 否（创建） |

### 字段语义变更明细（唯一契约面变化）

| 字段 | 所属通道 | B1 Schema 类型 | E1 后类型 | 内容语义变化 | 校验变化 |
|---|---|---|---|---|---|
| body.description | createTask/updateTask | string \| null（可空） | string \| null（**不变**） | 纯文本 → Markdown 原样文本；空仍存 `null` | 无新增校验（Markdown 即合法文本，store 不解析） |
| body.content | addComment | string（非空） | string（**不变**） | 纯文本 → Markdown 原样文本 | 无新增校验 |

> store 层（KanbanStore.ts）对 description/content 为透明字符串存储，不做 Markdown 解析/转换——渲染责任全在 renderer（markdown-it + DOMPurify）。因此 B1 契约的公共异常集 `KANBAN_STORE_ERROR` 对 E1 全部适用且无新错误码。

## 数据契约

### description / timeline[].content 字段（引用 B1 Schema，零改动）

| 字段路径 | 类型 | 必填 | 可空 | 约束 | 敏感性 | 说明 |
|---|---|---|---|---|---|---|
| Task.description | string | 否 | 是 | Markdown 文本（原样存储，store 不解析）；空=null | 无 | types.ts:98 定义不变 |
| TimelineItem.content | string | 是 | 否 | comment 条目为 Markdown 文本；execution/system 条目不受影响 | 无 | B1 Schema 不变 |

### boards.json 兼容性承诺

- schema version 不递增；无迁移函数；旧文件直接加载。
- 旧纯文本 description = 合法 Markdown（纯文本即 Markdown），渲染天然兼容（验收④）。
- E1 写入的数据可被回退到旧版壳正常打开（降级显示纯文本）。

### vendoring 资产清单（新增静态资源，非接口）

| 资产 | 版本 | 全局变量 | 引入方式 | 锁定策略 |
|---|---|---|---|---|
| easyminde（EasyMDE，含捆绑 CM5） | v2.21.0 | `window.EasyMDE` | shell.html `<script src="vendor/easymde.min.js">`（先于 kanban.js） | 固定版本 vendoring |
| markdown-it | **v14.1.0** | `window.markdownit` | 同上 | **锁死 v14.1.0**（v15 起无 UMD build，CON-R-editor-004） |
| markdown-it-task-lists | 当前最新 | 注册到 markdownit.use | 同上 | 固定版本 vendoring |
| DOMPurify | 当前最新 UMD | `window.DOMPurify` | 同上 | 固定版本 vendoring |
| easymde.min.css + CM5 暗色主题 CSS | 匹配 JS 版本 | — | `<link rel="stylesheet" href="vendor/...">`（style-src 'self'） | 与 JS 同源同版本 |

> 体积预算：新增总 gzip ≤ ~160KB（EasyMDE ~105 + markdown-it ~46 + DOMPurify ~15 量级）；task-lists 极小不计口径（共识 §10）。

## 前端行为契约

> 编号 FE-1~FE-7 为 renderer 行为的可测试约束；违反任一条即契约违约。

### FE-1 编辑器实例生命周期（Q-041）

- create/edit/comment 三处弹窗每次打开新建 EasyMDE 实例（`new EasyMDE({ element, ... })`），关闭时调用 `editor.destroy()` 并移除事件监听；**不复用实例**。
- edit 打开时预填现值：`editor.value(t.description ?? '')`。
- 保存取值统一为 `editor.value().trim() || null`（create/edit 写 description；comment 写 content），与现 textarea 路径 `.value.trim() || null` 语义等价。
- 反复开关弹窗 ≥20 次，`document.EasyMDE` 相关实例数不增长、无 CodeMirror 孤儿节点（内存泄漏检测进 QA）。

### FE-2 渲染管线与消毒全覆盖（Q-043）

- detail 只读态：`DOMPurify.sanitize(markdownit().render(description))` → 插入 `.kb-detail-desc`；description 为 null 时容器不渲染（现状行为保留）。
- 评论渲染：timeline type=comment 条目 content 走同一管线；execution/system 条目维持 `esc()` 纯文本（非用户 Markdown，不在范围）。
- **凡用户输入进 HTML 的路径统一走 DOMPurify**：枚举 kanban.js 全部 innerHTML/insertAdjacentHTML 站点（board 工具栏/列表模板/卡片模板 :84/detail 模板 :217~225/timeline :222/modal 外壳 :163 等），审计清单写入实现记录；除 description/comment 两处升级为 Markdown 管线外，其余站点维持 `esc()` 或补消毒，不允许出现未消毒用户内容直插 innerHTML 的新路径。
- XSS 载荷（`<img onerror=...>` / `<script>alert(1)</script>` / `[link](javascript:alert(1))`）经管线后：事件属性移除、script 标签移除、javascript: href 清除；载荷以文本形式可见，不执行。

### FE-3 CSP 与 vendoring（Q-042）

- 三库 JS 一律本地 `<script src>`（vendor 目录），shell.html 中置于 kanban.js 之前保证全局变量就绪；**禁止 CDN**。
- CSP script-src 维持 'self'（现状含 'unsafe-inline' 为存量事实，E1 不新增放宽、不得依赖 inline script）；EasyMDE/CM5 样式优先 vendor 独立 CSS 文件 `<link>` 引入（style-src 'self'）。
- 若 CM5 运行时强制注入 inline style：当前 CSP style-src 已含 'unsafe-inline' 兜底可用；实测结论（是否需要独立 CSS、inline 是否触发）写入实现记录（Q-042 关闭证据）。
- base-uri 'none' / form-action 'none' / default-src 'none' 不动。

### FE-4 GFM 插件两端对齐（Q-044 定案）

- 渲染端：markdown-it v14 默认启用 table + strikethrough，`markdownit().use(window.markdownitTaskLists)` 启用任务列表。
- 编辑端：EasyMDE 默认支持表格/任务列表/删除线；两端对同一输入的结构化输出一致（标题/加粗/列表/表格/任务列表/删除线）。

### FE-5 暗色主题（Q-045）

- vendor CM5 暗色主题 CSS，选择器 scoped 到 `.EasyMDE` 容器，色值基于 kanban.css tokens（#1e2430/#2a3342）；不污染壳内其他组件样式。
- markdown-it 渲染产物样式（h1~h6/ul/ol/code/pre/blockquote/a/task-list checkbox）补 kanban.css，暗色下可读。

### FE-6 弹窗焦点与 ESC（Q-046）

- EasyMDE 初始化后编辑器获得焦点；modal 层 ESC 关闭优先于编辑器（modal keydown 冒泡阶段处理，编辑器不拦截 ESC）。
- Tab 顺序：工具栏 → 编辑区 → 保存/取消按钮；工具栏按钮带可访问名（EasyMDE 默认 aria-label/title）；预览切换不抢占焦点。

### FE-7 预览/渲染一致性（Q-047）

- e2e 用例：同一 Markdown 样本（覆盖标题/加粗/列表/表格/任务列表/删除线/代码块/链接）分别经 EasyMDE preview 与 markdown-it+GFM 管线渲染，比对 DOM 结构语义一致；视觉差异记录不阻断。

## 联调与测试场景

| # | 场景 | 前置条件 | 请求/动作 | 预期结果 | 数据与审计结果 | 验收编号 |
|---|---|---|---|---|---|---|
| E1 | 三入口编辑器呈现 | 默认看板 | 打开 create/edit/comment | 三处均显示 EasyMDE（工具栏+侧边预览）；edit 预填现值 | — | 验收① |
| E2 | description round-trip | create 弹窗 | 输入 `# 标题\n- 列表` 保存 → 读 boards.json | description 为对应 Markdown 字符串原样落盘 | boards.json 结构/schema version 不变 | 验收①⑤ |
| E3 | 空描述存 null | create 弹窗 | 描述留空保存 | boards.json 中 description === null | 与现行为一致 | 验收① |
| E4 | detail 结构化渲染 | 含标题/加粗/列表/代码块/链接的 ticket | 打开详情 | 渲染为 h1/strong/ul/pre+code/a 对应 HTML | — | 验收② |
| E5 | 纯文本一致性 | 旧纯文本描述 ticket | 打开详情 | 渲染结果与原文一致（换行/字符不丢） | — | 验收②④ |
| E6 | XSS·img onerror | 描述注入 `<img src=x onerror=alert(1)>` | 打开详情 | alert 不执行；onerror 属性被清除，文本可见 | DOMPurify 生效 | 验收③ |
| E7 | XSS·script 标签 | 描述注入 `<script>alert(1)</script>` | 打开详情 | script 不执行、标签移除 | DOMPurify 生效 | 验收③ |
| E8 | XSS·javascript: href | 描述注入 `[link](javascript:alert(1))` | 点击渲染出的链接 | href 被清除/无效协议拦截，不执行 | DOMPurify 生效 | 验收③ |
| E9 | comment 渲染消毒 | 评论注入 XSS 载荷 | 提交评论 → 重开详情 | 评论按 Markdown 渲染且载荷不执行 | timeline content 原样存储 | 验收③+U-1 |
| E10 | 旧数据兼容 | 升级前创建的纯文本 ticket | 打开详情/编辑 | 正常渲染不报错不丢内容；edit 预填原文 | boards.json 未被改写结构 | 验收④ |
| E11 | 重启持久化 | 编辑保存后 | 重启壳 → 打开详情 | 数据完整、description 为保存的 Markdown | schema 未变 | 验收⑤ |
| E12 | 体积与加载来源 | vendor 就绪 | 冷启动抓网络请求 | 三库均 file:/本地 `<script src>`，无 CDN 请求；gzip 总量 ≤ ~160KB | 体积记录入实现记录 | 验收⑥ |
| E13 | 实例销毁无泄漏 | create/edit/comment | 反复开关 ≥20 次 | 每次 destroy()；CodeMirror 孤儿节点/实例计数不增长 | 泄漏检测记录 | 验收⑦/Q-041 |
| E14 | CSP/CM5 兼容实测 | vendor CSS 就绪 | 打开编辑器观察 console/样式 | 无 CSP 违规告警（或仅 style 'unsafe-inline' 存量兜底）；实测结论记录 | 记录入实现记录 | 验收⑧/Q-042 |
| E15 | 消毒覆盖审计 | 实现完成后 | 枚举 kanban.js 全部 innerHTML 站点 | 全部站点要么 esc() 要么 DOMPurify，无裸插用户内容 | 审计清单入实现记录 | 验收⑨/Q-043 |
| E16 | 预览/渲染一致性 e2e | 样本集（标题/加粗/列表/表格/任务列表/删除线/代码块/链接） | 双管线渲染比对 | DOM 结构语义一致；视觉差异记录不阻断 | e2e 用例入库 | 验收⑩/Q-047 |
| E17 | GFM 任务列表 | 描述含 `- [x] done / - [ ] todo` | detail 渲染 | checkbox 渲染，两端一致 | — | CON-R-editor-005 |
| E18 | 暗色主题 scoped | 暗色 tokens 生效 | 打开编辑器+详情 | 编辑器/渲染区暗色可读；壳内其他组件样式未被污染 | — | Q-045 |
| E19 | 焦点与 ESC | 编辑弹窗打开 | ESC/Tab 操作 | ESC 关弹窗（编辑器不吞）；Tab 序工具栏→编辑器→按钮；初始 focus 在编辑器 | — | Q-046 |

## 开放问题

| 编号 | 问题 | 阻塞接口/字段 | 临时处理 | 状态 |
|---|---|---|---|---|
| 无 | — | — | — | — |

## 协调事项

| 事项 | 跨模块/第三方 | 责任人 | 截止时间 | 状态 |
|---|---|---|---|---|
| IPC 零变更确认 | B1 契约（feishu-b1-m2-kanban-api-contract.md）为本契约接口面唯一上游，E1 不触发其变更 | phper666 | 已闭环（本契约） | 已闭环 |
| markdown-it 版本锁传播 | v14.1.0 锁定写入 vendoring 契约；升级需人工评估 UMD 可用性（CON-R-editor-004） | phper666 | 长期有效 | 已定 |
| U-3 图片粘贴/上传 | 若未来启用，将新增磁盘写入 + preload 桥通道，届时另立契约修订 | phper666 | M2+ | open（不阻塞本期） |

## 完成记录

> 交付后填写，结果必须有证据。

| 项 | 结果 |
|:---|:-----|
| 交付时间 | — |
| 验证结果 | — |
| 构建/发布 | — |
| 偏差处理 | — |

## 决策与踩坑

- 前端-only 改造的契约形态：无接口变更时，契约价值在「字段内容语义变化声明 + 行为约束 + 测试场景」，而非接口定义；复用 B1 异常集，不另造错误码。
- store 不解析 Markdown 是零迁移成立的前提：description/content 保持透明字符串，渲染责任收敛在 renderer 单层（markdown-it + DOMPurify），主进程零感知。
- CSP 现状备注：shell.html 现 style-src 已含 'unsafe-inline'（存量），Q-042 的兜底路径天然可用；但仍要求实测记录 + 优先独立 CSS 文件方案，避免加深对 unsafe-inline 的依赖。

## 变更记录

| 时间 | 类型 | 摘要 |
|---|---|---|
| 2026-08-22 | 初次生成 | 基于 E1（c02c95c2-56b1-41fb-85db-8ea1cb8c4852）、共识 v1.2 §14.1/Q-041~047、PRD v0.2 生成契约；无接口变更声明 + FE-1~FE-7 行为契约 + 测试场景 E1~E19 |
| 2026-08-23 | 复核登记 | E19 焦点口径复核结论：create 弹窗初始焦点=标题输入框（首个必填字段，聚焦编辑器会倒逼回跳），edit/detail 弹窗=编辑器——FE-6/E19「初始 focus 在编辑器」按编辑弹窗口径执行；处理：登记在案，FE-6 条文不改 |

## 自检记录

- 追踪完整性：PASS（E1→CON-R-editor-001~006 + Q-041~Q-047 + U-1/U-2→验收①~⑩，追踪矩阵全覆盖）
- OpenAPI 一致性：不适用（无新增接口面；复用 B1 IPC，字段 Schema 以 B1 契约为唯一事实源）
- 示例与错误场景：PASS（19 个测试场景 E1~E19 含成功/XSS 安全/兼容/泄漏/CSP/一致性边界；异常面引用 B1 公共异常集 KANBAN_STORE_ERROR，无新错误码）
- 安全与敏感字段：PASS（XSS 三类载荷场景显式覆盖；DOMPurify 全覆盖审计入验收；无敏感字段；DSH_HOME 零接触）
- 链接与格式：PASS
