# Hull Desktop（dsh-hull-desktop）看板 ticket 内容编辑器升级 PRD

> 版本：v0.2 定稿　|　日期：2026-08-22　|　状态：已定稿
> 范围：看板 ticket 内容编辑器升级（EasyMDE + markdown-it + DOMPurify）
> 工作流阶段：Phase 0 需求探索（常规 task → lightweight PRD，无原型）
> v0.1 → v0.2：T1 定案——comment 框（:226）升级 EasyMDE（U-1 关闭），FR-1/FR-4/§3.1/§6/§7 回写

---

## 1. 背景与目标

**现状**：看板 ticket 的内容编辑器是纯 `<textarea>`（`src/renderer/kanban.js:192` create、`:249` edit、`:226` comment；`:219` 详情只读态为 escape 后的纯文本）。描述是 `string|null`（`src/kanban/types.ts:98`），经 `KanbanStore.ts:347/:372` 往返 `boards.json`。**全程无 Markdown**。

**目标**：给看板 ticket 换一个"好点的编辑器"，支持 Markdown 书写 + 预览；详情只读态渲染 Markdown。数据零迁移。

**核心用户故事**：*"我是用 dsh 的开发者，看板上的 ticket 描述想写得结构化一点（标题、列表、代码块），编辑时能看预览，保存后别人打开看到的是排版好的内容。"*

## 2. 技术选型记录（EasyMDE + markdown-it 组合）

| 方案 | 形态 | 与 tsc-only 构建的相容性 | 结论 |
|:-----|:-----|:------------------------|:-----|
| **EasyMDE**（v2.21.0，MIT，~105KB gzip） | 单文件 IIFE UMD，全局 `window.EasyMDE` | 兼容——`<script src>` 本地引入，无 import/打包 | **选（编辑端）** |
| **markdown-it**（v14.1.0，MIT，~46KB gzip） | UMD 全局 `window.markdownit` | 兼容——同上 | **选（渲染端）** |
| DOMPurify | UMD，消毒用户内容 | 兼容 | **选（安全）** |
| CodeMirror 6 / TipTap / Milkdown | 全 ESM-only，需打包器 | **冲突**——项目无 bundler（tsc only），ESM-only 无法直接 `<script src>` | 排除 |

**选型理由**：

1. **无 bundler 约束**（决定项）：项目是 tsc-only + 原生 JS renderer，无打包器。EasyMDE/markdown-it 提供 UMD 全局构建，可直接本地 vendoring + `<script src>` 引入，与现有架构零冲突；CodeMirror6/TipTap/Milkdown 全 ESM-only，引入即需引入打包链路，改动面远超需求本身。
2. **EasyMDE 自带工具栏 + 侧边预览**：编辑体验（加粗/标题/列表/代码/链接 + side-by-side preview）开箱即用，无需自研 preview 面板。
3. **markdown-it 渲染只读详情**：详情渲染与编辑器解耦（编辑用 EasyMDE 自带渲染，只读详情用 markdown-it），渲染可控、可消毒。
4. **DOMPurify 兜底**：用户内容是 sandboxed renderer 内的 HTML，渲染前必须消毒（XSS 安全）。

> `ponytail: 若仅需编辑端，markdown-it 也可考虑复用 EasyMDE 内部依赖，但解耦独立 vendoring 更可控；如需缩体积可后续评估（非本期）。`

## 3. 范围

### 3.1 In Scope

- **编辑端**：create / edit / comment 三处 `<textarea>` 接入 EasyMDE（工具栏 + 预览 + 快捷键）。
- **渲染端**：detail 只读态（`:219`）由 escape 纯文本改为 markdown-it 渲染 + DOMPurify 消毒。
- **依赖 vendoring**：EasyMDE / markdown-it / DOMPurify 三库本地文件 + `shell.html` `<script src>` 引入（CSP script-src 'self' 兼容，不走 CDN）。
- **数据零迁移**：`description` 保持 `string|null`，Markdown 即纯文本；`boards.json` 结构不变（schema version 不变）。

### 3.2 Out of Scope

- **数据迁移**：无。旧纯文本描述按 Markdown 渲染（纯文本即合法 Markdown，天然兼容）。
- **富文本（非 Markdown）**：不做 WYSIWYG。
- **其他模块编辑器**：本 PRD 只覆盖看板 ticket 内容编辑器；其他编辑器（如有）另行立项。
- **图片上传/粘贴**：不做（TBD，见 §6）。
- ~~评论框改造默认不升级~~（**已推翻**——T1 定案 comment 框升级 EasyMDE，见 §3.1/§6）。

## 4. 功能需求

### FR-1 编辑体验（create / edit / comment）

- create（`kanban.js:192`）、edit（`:249`）、comment（`:226`）三处 `<textarea>` 升级为 EasyMDE 实例：Markdown 工具栏（加粗/斜体/标题/链接/图片/列表/引用/代码/表格/水平线/清除格式）+ 侧边实时预览 + 常用快捷键（加粗 `Ctrl/Cmd+B`、斜体 `Ctrl/Cmd+I`、代码块、预览切换等，EasyMDE 内置默认）。
- 保存时取值 = EasyMDE 编辑器纯文本内容（Markdown 原样），写入 `description`（保持 `string|null`，空内容存 `null`）；comment 内容同样为 Markdown 原样。
- 验收：create/edit/comment 打开即见带工具栏的编辑器；输入 Markdown 保存后 `boards.json` 中 `description`/评论为对应 Markdown 字符串；工具栏操作插入对应 Markdown 语法；预览与最终渲染一致。

### FR-2 详情渲染（detail 只读）

- detail 只读态（`:219`）由 escape 纯文本改为：markdown-it 渲染 → DOMPurify 消毒 → 插入 DOM（user content 一律消毒，含 history/邮件地址等其余只读文本——**凡用户输入进 HTML 的路径统一走 DOMPurify**）。**评论内容渲染同样走 markdown-it + DOMPurify 消毒**（comment 升级后评论即用户输入的 Markdown）。
- 验收：含 `# 标题`、`**加粗**`、`- 列表`、`\`\`\` 代码块 \`\`\`` 的描述渲染为对应 HTML；纯文本描述渲染结果与原文一致（Markdown 天然兼容）。

### FR-3 数据零迁移

- `description` 字段类型/存储不变（`string|null`，`boards.json` 零改动，`KanbanStore.ts` 读写逻辑不变）。
- 验收：旧版创建的 ticket 打开详情正常渲染；新建/编辑后重启壳数据完整恢复（结构未变）。

### FR-4 接入点（四处）

| 接入点 | 位置 | 改动 |
|:-------|:-----|:-----|
| create | `src/renderer/kanban.js:192` | textarea → EasyMDE |
| edit | `src/renderer/kanban.js:249` | textarea → EasyMDE |
| comment | `src/renderer/kanban.js:226` | textarea → EasyMDE（T1 定案，见 §6）；渲染评论时走 markdown-it + DOMPurify |
| detail 只读 | `src/renderer/kanban.js:219` | escape 纯文本 → markdown-it 渲染 + DOMPurify |

- 验收：create/edit/comment 均走 EasyMDE；detail 渲染 Markdown；评论渲染走 DOMPurify 消毒。

## 5. 非功能需求

| 项 | 要求 |
|:---|:-----|
| 依赖引入 | 三库本地 vendoring（`src/renderer/vendor/` 或等价目录），`shell.html` `<script src>` 引入；**CSP script-src 'self' 不走 CDN**（红线相容） |
| 体积 | 新增总 gzip 约 ~150KB（EasyMDE ~105 + markdown-it ~46 + DOMPurify ~15 量级）；无构建体积压力（本地 file: 加载） |
| 安全 | 渲染端一律 DOMPurify 消毒（sandboxed renderer，用户内容不可直接进 innerHTML）；preload 桥不变，无新增 IPC |
| 性能 | 详情打开渲染 < 100ms（本地小文本，markdown-it 即时）；EasyMDE 初始化对 create/edit 弹层无感知延迟 |
| 无障碍基础 | 工具栏按钮带可访问名（EasyMDE 默认 aria-label/title）；编辑器可键盘聚焦与 Tab 进出；预览不抢占焦点 |

## 6. 未决项（TBD，评审定案）

| 编号 | 问题 | 建议 | 触发 |
|:-----|:-----|:-----|:-----|
| T1 | comment 框（`:226`）是否升级？ | **已定案：升级 EasyMDE**（2026-08-22 用户裁决）——comment 与 create/edit 同规格（工具栏+预览+快捷键）；渲染评论时同样走 DOMPurify 消毒 | 已关闭 |
| T2 | markdown-it 是否启用 GFM 扩展（表格/任务列表/删除线）？ | 建议启用 GFM——编辑端 EasyMDE 默认支持表格/任务列表，渲染端需对应开启才能一致 | 评审确认 |
| T3 | 是否支持图片粘贴/上传？ | 建议本期不做——看板附件机制（M2 FR-9）尚未到 P2 阶段，图片上传涉及磁盘写入 + preload 桥新增 | 后续迭代 |

## 7. 验收标准（testable）

- [ ] create/edit/comment 打开显示 EasyMDE（带工具栏 + 预览）；输入 Markdown 保存后 `boards.json` 中 `description` 为对应 Markdown 字符串（含空内容为 `null`）；评论保存为对应 Markdown 字符串
- [ ] 含标题/加粗/列表/代码块/链接的描述在 detail 渲染为对应 HTML；纯文本描述渲染与原文一致
- [ ] XSS 载荷（如 `<img onerror=...>`、`<script>alert(1)</script>`、`[link](javascript:alert(1))`）注入描述后打开详情**不执行**（DOMPurify 拦截），且以文本形式显示
- [ ] 旧 ticket（纯文本描述）打开详情正常渲染，不报错、不丢内容
- [ ] 编辑保存后重启壳，`boards.json` 数据完整、`description` 为保存的 Markdown 字符串（schema 未变）
- [ ] 新增依赖体积 ≤ ~160KB gzip 总量；三库均由本地 `<script src>` 加载，无 CDN 请求
- [ ] comment 框行为符合 T1 定案结论（升级 EasyMDE；评论渲染走 DOMPurify 消毒，XSS 载荷不执行）

## 8. 依赖与风险

| 风险 | 影响 | 缓解 |
|:-----|:-----|:-----|
| EasyMDE 依赖 CodeMirror 5（捆绑），体积与样式冲突 | 体积增加、与现有样式打架 | 本地引入单文件；样式 scoped 到编辑器容器；体积已计（§5） |
| markdown-it 版本升级丢 UMD | 构建失效 | **锁 v14.1.0**（v15 起无 UMD build），vendoring 固定版本 |
| 渲染端漏消毒 | XSS（sandboxed renderer 内，风险可控但必须消除） | 所有用户内容进 HTML 路径统一走 DOMPurify（FR-2 强制）；Review 重点核查 |
| 预览/渲染与保存内容不一致 | 用户困惑 | FR-1/FR-2 验收统一校验一致；T2 定案 GFM 后编辑/渲染两端对齐 |
