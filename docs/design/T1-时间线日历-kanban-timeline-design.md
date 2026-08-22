# T1 时间线/日历视图 技术方案

> 工作项：T1 时间线/日历视图（M2 看板时间线共识 §14.1，飞书 dsh-hull-desktop 清单，fd4fdf45-32be-4ff1-8174-68505e26c5a4）
> 状态：**frozen（评审通过·冻结，可进实现）**
> 评审：自查评审通过（2026-08-23，solo 自查：方案按共识 v1.2 + 冻结契约产出，无 P0/P1 残留；架构决策与契约/共识一致）
> 版本：0.1 · 2026-08-23
> 事实源：契约 `docs/api/feishu-t1-kanban-timeline-api-contract.md` v0.1（冻结）；共识 `docs/spec/共识-Hull桌面壳-M2看板时间线.md` v1.2（§14.1 子需求清单 + §12 页面交互规范 + CON-R-timeline-001~007 + Q-053/054/055）；PRD `docs/prd/2026-08-22-kanban-timeline-prd.md` v0.2（FR-1/FR-2/FR-5）；前置：T2 方案 `docs/design/T2-startDate迁移-kanban-timeline-design.md`（startDate 字段消费方，交付顺序 T2 → T1）；格式与工程基线参照 `docs/design/S1-扫描搜索-skills-design.md`
> 判级：**复杂**。理由：多视图接入（五视图状态机扩展 + 两套全新渲染面）叠加性能约束（≥1000 卡按需渲染 + 切换 <300ms，CON-R-timeline-006）与消毒面扩张（评论 Markdown 渲染站点新增，E1 管线对齐 CON-R-editor-002）——判级矩阵「多子系统交互 + 性能验收」。

---

## 1. 背景与范围

**定位**：T1 交付看板「按时间看节奏」展示层——时间线视图（本看板活动流按时间倒序）+ 日历视图（dueDate 落格 / startDate+dueDate 区间跨格条带）+ 视图持久化 + 详情面板 startDate 编辑 UI（T2 数据层消费侧）。纯 renderer 展示层增量：**零新增 IPC、零 preload 方法、零存储层变更**（T1 契约 §无接口变更声明；数据消费 renderer 已持有的 `currentBoard.tasks[]` 内存态派生）。

**规则绑定**：CON-R-timeline-001（时间线聚合/兜底链/id 稳定排序 Q-055）、CON-R-timeline-002（日历落格/区间条带/本地时区/中文本地化 Q-054）、CON-R-timeline-005（复用 viewNames 状态机 + localStorage 持久化 Q-053）、CON-R-timeline-006（≥1000 卡按需渲染 + <300ms）、CON-R-timeline-007（边界容错）+ CON-R-editor-002（评论消毒对齐 E1）。

**范围**（契约 §范围，冻结）：
- 时间线视图：活动聚合（纯读既有字段）/ 倒序 / 点击跳卡 / 空态 / 缺失兜底 / 稳定排序
- 日历视图：月/周粒度网格（默认月）/ dueDate 落格 / 区间跨格条带 / 仅 startDate 至当月末尾 / 过期标记 / 本地时区解析 / 中文月份标签 / 点击开详情 / 空态
- 视图持久化：renderer localStorage（key=`kanban:lastView`），重启保持
- 视图接入：viewNames 五视图扩展 + renderTimeline/renderCalendar 分发
- 详情面板：截止日期旁「开始日期」选择器（可空，即时生效持久化）
- 按需渲染：≥1000 卡时间线分页、日历按月过滤

**非目标**（契约 §非目标）：startDate 字段/schema v2 迁移/createTask·updateTask 扩展（T2，T1 只消费）；拖拽改期（U-4 定案不做）；跨看板时间线聚合；实时协作/共享日历、任务自动排期；duration/endDate 新增（U-3）；新 IPC/preload/HullSettings schema。

**交付验收**：契约 24 场景 TL1~TL7（排序/稳定/兜底/跳卡/空态/XSS）/ CAL1~CAL12（落格/条带/过期/时区/本地化/粒度切换/边界）/ P1~P4（持久化/重启/非法值兜底/零 schema bump）/ PERF1~PERF4（按需渲染/<300ms 计时/分页不重不漏）。

**范围剪裁说明（YAGNI）**：不引日历库/虚拟滚动库（原生 grid + 分页足够）；不做全年预渲染（切月重算）；不做无限滚动监听（分页按钮替代）；不做拖拽改期；归档区任务不进主时间线（契约实现补充约定，协调事项已登记回写共识候选）。

---

## 2. 架构决策（含备选）

### D1 视图接入：复用 viewNames 状态机 + render 函数 vs 独立页面 vs 单视图内 tab

- **A**：`viewNames`（kanban.js:23）扩至五项 `{ board, list, archive, timeline, calendar }`；`render()`（:37-42）加 timeline/calendar 两分支 → `renderTimeline()`/`renderCalendar()`；boardToolbar（:49-55）`Object.entries(viewNames)` 循环自动带出新按钮，工具栏代码零改动
- **B**：独立 section 页面 + nav 入口（镜像 skills placeholder 模式）
- **C**：时间线/日历合并为一个视图内 tab → **选 A**

理由：CON-R-timeline-005 冻结「复用多视图状态机，不新建页面/入口」；A 增量最小（两分支 + 两函数），看板切换下拉/筛选/详情弹窗/通用工具栏全复用；B 丢掉管线复用且违背冻结决策；C 违背 U-5 定案（两个独立视图）。各视图渲染独立不串扰由既有模式保证（每次 render 全量重建容器内容，M2 同款）。

### D2 时间线聚合：纯函数构建条目 + 兜底链 + id 稳定 tie-break

- **A**：`buildTimelineEntries(tasks)` 纯函数一次构建全部活动条目数组，排序后交 renderTimeline 做 DOM 映射；来源映射 = task.createdAt→创建 / timeline[] type=comment·system 条目 createdAt→评论·系统 / type=execution 的 execution.startedAt·finishedAt→执行
- **B**：渲染时内联聚合（模板字符串里现算现排）→ 不可单测，TL2 稳定性无法隔离验证 → **选 A**

理由：CON-R-timeline-001/Q-055 冻结的兜底链与稳定排序是纯数据变换，纯函数形态可直接表驱动验证。关键规则：
- **兜底链**（Q-055）：执行条目排序键 startedAt 缺 → finishedAt → 所属 task.updatedAt（此时标「时间未知」，仍参与排序）；全缺或 Date 解析 NaN → 跳出排序流固定末尾标「时间未知」，不参与时间轴分组
- **同戳 tie**：条目 id 字符串比较倒序（id 大在前，「倒序时后建在前」语义）；主键 ts desc + 次键 id desc 双键比较器，两次渲染顺序必然一致（TL2 快照 diff 为空）
- **归档排除**：archivedAt 非空任务不进主时间线（契约实现补充约定）
- 所有 ISO UTC 戳渲染时转本地时区显示（沿用 M2 `new Date(...).toLocaleString()` 语义）

### D3 日历渲染：date-only 本地时区解析 + 按日遍历区间条带

- **A**：parseDateOnly('YYYY-MM-DD') → `new Date(y, m-1, d)` 本地构造（禁止 `new Date('YYYY-MM-DD')`——ISO 串按 UTC 解析，UTC+8 西移一天落错格，CAL5 断言）；区间条带跨月/跨周边界按日遍历逐格渲染（Q-054 冻结）
- **B**：CSS grid-column span 连续铺条带 → 跨月补位行/周边界处理与月/周两套粒度逻辑分叉 → **选 A**

理由：Q-054 显式冻结「按日遍历」；A 对月视图（6×7 含前后月补位灰显）与周视图（7 格）用同一套 [start,end]×可见范围求交算法，粒度切换只是可见范围变化。关键规则：
- **落格**（契约 §2.2）：仅 dueDate→单日落格；startDate+dueDate→区间条带；仅 startDate→显示至当月末尾；皆空→不进日历；`startDate > dueDate`→以 dueDate 单日显示不报错（CON-R-timeline-007，存储层照存——T2 决策延续）
- **过期标记**：dueDate < 今日（本地时区当日 0 点比较）→ 红色系标记（复用 M2 过期语义 #f85149 系），区间条带以 dueDate 判定
- **本地化**：`Intl.DateTimeFormat('zh-CN', { year:'numeric', month:'long' })` 月标签（"2026年8月"式）；星期头中文 一~日
- **降级**：T2 未合入期间 `t.startDate` 为 undefined 按 null 处理（优雅降级单日/不显示）

### D4 视图持久化：renderer localStorage vs HullSettings schema bump vs IPC 存储面

- **A**：localStorage key=`kanban:lastView`；init 读作初始 view（替换 :17 硬编码 `'board'`）；切换 handler（:106）即时写入
- **B**：HullSettings 加 lastView 字段（schemaVersion bump）
- **C**：新 IPC channel 存主进程 → **选 A**

理由：Q-053 冻结。纯 UI 偏好不值得动 M1 settings schema（bump 牵连 settings.json 版本演进与迁移面）；C 为存一个字符串加通道纯属绕远；localStorage 同步读写零 IPC，重启天然保持。兜底：值不在枚举 {'board','list','archive','timeline','calendar'} 或 localStorage 抛异常（隐私模式）→ 回退 'board' 不报错（P3 断言）；HullSettings schemaVersion 不变、无新 IPC 调用（P4 IPC spy 零新增断言）。

### D5 性能：时间线分页 + 日历当月过滤 vs 虚拟滚动 vs 全量渲染

- **A**：时间线分页（每页固定条数 + 「加载更多」追加渲染）；日历先过滤当月命中任务再建 DOM（切月重算，不做全年预渲染）
- **B**：时间线虚拟滚动（滚动容器测量 + 行高估算）
- **C**：全量渲染赌任务量小 → **选 A**（本方案定案契约协调事项「分页 vs 虚拟滚动二选一」）

理由：PERF4 场景即按分页语义编写（第二页不重不漏断言）；虚拟滚动的测量/估算复杂度对回顾型信息流收益低；C 在 ≥1000 卡阈值下直接违约 CON-R-timeline-006。聚合排序 O(n log n) 千级毫秒内完成，瓶颈在 DOM 数量——首屏 DOM 封顶分页大小即满足切换 <300ms（PERF3 performance.now() 计时验收）。升级路径预留：分页改虚拟滚动只动 renderTimeline 内部，buildTimelineEntries 纯函数不变。分页大小常量化 `TIMELINE_PAGE_SIZE = 100` 并留注释标注升级路径。

### D6 消毒：评论 markdown-it+DOMPurify 同 E1 管线 vs esc() 全量 vs 双实现

- **A**：评论条目 content 走 E1 detail **同一** Markdown 渲染函数（markdown-it+DOMPurify，单一实现点复用不分叉）；execution/system 条目 content、command 摘要、任务标题/标签等结构化字段一律 `esc()` 纯文本
- **B**：时间线自建一套 Markdown 渲染 → 管线分叉，XSS 面双份维护
- **C**：评论也 esc() 纯文本 → 与 E1 detail 评论展示不一致（E1 升级后评论为 Markdown）→ **选 A**

理由：T1 契约复核 MEDIUM 已定案（§6 消毒条款，违反即契约违约）。新增 renderTimeline/renderCalendar 是新的用户内容进 DOM 表面：评论 content 是唯一 Markdown 面（E1 同管线，CON-R-editor-002），其余全部结构化字段走既有 esc()（kanban.js:27）。禁止裸插：新增渲染站点不允许未消毒用户内容直插 innerHTML，站点清单并入 E1 Q-043 审计清单维护（TL7 XSS 场景断言 onerror 移除/javascript: href 清除）。协调依赖：管线实现以 E1 契约 FE-2 为准、E1 先行交付；若 T1 实现时 E1 管线未就绪，评论条目暂以 esc() 渲染并留显式 TODO 标记，E1 合入时替换为同管线函数（保持单一实现点）。

---

## 3. 模块划分

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `src/renderer/kanban.js` | viewNames 五视图扩展（:23）+ render() 分发两分支（:37-42）+ buildTimelineEntries 纯函数（D2 聚合/兜底/tie-break）+ renderTimeline（分页 DOM 映射）+ 日历工具（parseDateOnly/monthMatrix/rangeSegments，D3）+ renderCalendar（月/周网格/条带/导航）+ lastView 读写（D4）+ 详情面板 startDate 选择器（openDetail meta 展示 + editTask 编辑，T2 消费侧 UI） | window.kanban 桥（既有） | TL/CAL/P 全场景 |
| `src/renderer/kanban.css` | kb-tl-* 时间线样式（轴/徽标/条目/加载更多）+ kb-cal-* 日历样式（网格/格/条带/补位灰显/过期标记/导航/空态），沿用深色主题设计语言 | — | — |

**依赖方向**：kanban.js 单文件内聚（IIFE 模式延续），无新模块间依赖；数据面只读 `currentBoard.tasks[]`（经既有 kanban:getTasks 加载），写面仅详情面板 startDate 经既有 updateTask。

**接入点（既有代码改动面，最小化）**：
- `src/renderer/kanban.js`：viewNames 一行 + render 两分支 + view 初始化一行（lastView 读）+ 切换 handler 一行（lastView 写）+ 三个新函数簇 + editTask/openDetail 各一小段
- `src/renderer/shell.html`：无改动（boardRoot 容器复用，无 nav/section 变更）
- `src/preload/index.ts` / `src/shared/ipc-channels.ts`：**零改动**（无接口变更声明）

---

## 4. 关键机制实现形态

### 4.1 渲染管线（五视图分发）

```
loadBoard() → currentBoard = { ...board, tasks }
                    │
render() ──┬─ board    → renderBoard()      （既有）
           ├─ list      → renderList()       （既有）
           ├─ archive   → renderArchive()    （既有）
           ├─ timeline  → buildTimelineEntries(activeTasks()) → 截取当前页 → renderTimeline()
           └─ calendar  → 当月命中过滤 → monthMatrix(年,月) → renderCalendar()
```

- 每次切换全量重建 boardRoot 内容（M2 既有模式）→ 视图隔离天然成立，无残留监听器
- 工具栏按钮 active 态由 `view === k` 判断自动覆盖五视图（boardToolbar 零改动）

### 4.2 时间线聚合与排序（buildTimelineEntries）

```
for task of activeTasks():                     // 归档排除
  push { id: task.id, taskId, type: '创建', ts: task.createdAt, ... }
  for item of task.timeline:
    comment/system → push { type, ts: item.createdAt, content: item.content }
    execution      → ts = item.execution.startedAt ?? item.execution.finishedAt ?? task.updatedAt
                     unknown = (前两级均缺)        // updatedAt 兜底仍标「时间未知」参与排序
sort: ts 有效者按 ts desc；ts 无效(NaN)/全缺 → unknownEnd[] 固定末尾
tie: ts 相等 → id 字符串 desc（倒序后建在前）
```

- 「时间未知」两种形态区分：updatedAt 兜底（有排序位置，标未知）/ 终极兜底（末尾固定，标未知且不入分组）——TL3/TL4 分别断言
- 点击条目 → `openDetail(taskId)` 复用 M2 详情弹窗（TL5）；空态文案「暂无活动，创建任务后这里会显示时间线」（TL6）

### 4.3 区间条带跨月/跨周（rangeSegments）

```
segment(task, visibleStart, visibleEnd):
  start = parseDateOnly(task.startDate)          // new Date(y, m-1, d) 本地构造
  end   = parseDateOnly(task.dueDate)
  仅 startDate            → end = 可见范围月末尾   （CAL3）
  startDate > dueDate     → start = end = dueDate （CAL8 单日）
  与 [visibleStart, visibleEnd] 求交 → 无交返回空
  逐日迭代交集 → 每日一格内片段 { dateKey, taskId }  （跨月/跨周边界自然连续，CAL2/CAL12）
```

- 格内渲染按 dateKey 分桶挂载；条带视觉连续性由 CSS（首尾圆角/中间平直）处理，数据层不感知边界
- 过期判定在 segment 内做一次：`parseDateOnly(task.dueDate) < 今日0点` → 条目加过期 class（CAL4）

### 4.4 空态三处

| 场景 | 文案/行为 | 断言 |
|---|---|---|
| 时间线无活动 | 「暂无活动，创建任务后这里会显示时间线」 | TL6 |
| 日历当月（周）无到期任务 | 「本月无到期任务」 | CAL10 |
| lastView 非法/存储异常 | 回退 board 视图静默 | P3 |

### 4.5 按需渲染（CON-R-timeline-006）

- 时间线：entries 排序后 `slice(0, page * TIMELINE_PAGE_SIZE)` 渲染，「加载更多」page+1 重渲染（追加语义由 slice 保证不重不漏，PERF4）；页大小常量 + ponytail 注释（升级路径：虚拟滚动只换此函数内部）
- 日历：`tasks.filter(segment 与当月有交)` 先过滤再进 DOM（PERF2 仅当月命中入 DOM）；切月上/下月按钮重算 monthMatrix + 过滤
- 切换计时：PERF3 五视图两两切换 performance.now() <300ms 断言（e2e）

---

## 5. 工程基线

**判级**：复杂（头部一致）。

| 项 | 现状 | T1 动作 |
|---|---|---|
| git | ✅（M1/M2 全程使用） | 直接复用 |
| 脚手架 | ✅（原生 JS renderer，无构建步骤） | 直接复用，kanban.js/kanban.css 内扩展 |
| 测试框架 | ✅（node:test 单测 + Playwright e2e，HULL_E2E 钩子已有） | 复用框架，**新增 e2e**：`tests/e2e/` 时间线/日历用例——视图切换五视图链路 + <300ms 计时（PERF3）/ 日历渲染落格·条带·时区·本地化（CAL1~CAL12）/ 时间线排序·兜底·稳定性（TL1~TL4）/ 一致性（TL2 两次渲染快照 diff 空 + P1~P4 持久化）；聚合/日期工具为纯函数，经 e2e DOM 断言覆盖（不另设 harness，YAGNI） |

**技术栈决策**：跟随 M2 既有栈——原生 JS + Playwright，**不引入新框架/新依赖**（不引日历库/虚拟滚动库/markdown-it 以外依赖；markdown-it+DOMPurify 由 E1 管线提供，非 T1 新增）。注入先例沿用（HULL_E2E 测试钩子注入 ≥1000 卡样例数据供 PERF 场景）。

---

## 6. 目录/工程结构

```
src/renderer/
├── kanban.js                         # viewNames 五视图 + render 分发 + buildTimelineEntries
│                                     #   + renderTimeline + 日历工具/renderCalendar
│                                     #   + lastView 读写 + 详情面板 startDate 选择器
└── kanban.css                        # +kb-tl-*（时间线）+kb-cal-*（日历）样式段
tests/e2e/
└── kanban-timeline.e2e.js            # TL/CAL/P/PERF 场景（Playwright，HULL_E2E 数据钩子）
```

> userData 写面不变；localStorage 仅 `kanban:lastView` 一个 key（renderer 侧，非壳数据目录）。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| 大任务量（≥1000 卡）切换超 300ms | CON-R-timeline-006 违约 | 分页封顶首屏 DOM + 日历当月预过滤；PERF3 计时验收；超标再议虚拟滚动（升级路径已预留，只动 renderTimeline 内部） | T1 |
| E1×T1 评论渲染管线分叉 | XSS 面双份维护 / 展示不一致违约 CON-R-editor-002 | 单一实现点复用 E1 detail 同一函数（D6）；E1 未就绪期 esc() 占位 + TODO 标记；TL7 XSS 断言；站点清单并入 Q-043 审计 | T1+E1 |
| 时区边界落错格（UTC 偏移西移一天） | 任务落前一天格，规划失真 | parseDateOnly 强制 `new Date(y,m,d)` 本地构造，禁字符串直传 Date；CAL5 断言；月末/闰年边界纳入 e2e 样例 | T1 |
| localStorage 不可用（隐私模式/禁用） | 初始化抛错白屏 | try/catch 包裹读写，异常回退 board 不报错（P3） | T1 |
| T2 未合入先行开发 | t.startDate undefined | 按 null 优雅降级（单日/不显示），契约明示；合入后自动生效区间条带 | T1 |
| 归档排除为契约补充约定未回写共识 | 共识 §12 与实现口径漂移 | 协调事项已登记，随下次共识修订回写留痕 | T1 |

---

## 8. 核验记录（交付核验时填写）

| 项 | 结果 |
|:---|:-----|
| 状态 | draft（评审通过后置 frozen，评审记录在此留痕：评审人/机制 + 日期 + 结论） |
| 实现偏离 | —（实现 vs 方案，交付核验时填；有意偏离更新本方案+记录理由，架构级偏离回 draft 重评） |
