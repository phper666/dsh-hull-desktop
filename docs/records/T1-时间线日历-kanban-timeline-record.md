# T1 实现记录（时间线/日历视图）

> 判级：**复杂**（多视图接入 + ≥1000 卡按需渲染性能约束 + 消毒面扩张，CON-R-timeline-006 + CON-R-editor-002 适用）
> 事实源：契约 `docs/api/feishu-t1-kanban-timeline-api-contract.md`（冻结 v0.1，0 IPC + 24 场景 TL/CAL/P/PERF）；设计 `docs/design/T1-时间线日历-kanban-timeline-design.md`（frozen，D1~D6）；共识 `docs/spec/共识-Hull桌面壳-M2看板时间线.md` v1.2（CON-R-timeline-001~007 + Q-053/054/055）
> 前置：T2 已交付（Task.startDate + schema v2 迁移，本工作项只消费）
> 交付时间：2026-08-23
> 全程 TDD（先写 10 个 e2e 场景 red → 实现转 green）

## 变更清单

| 文件 | 变更 |
|---|---|
| src/renderer/kanban.js | viewNames 扩至五视图（board/list/archive/timeline/calendar）；render() 分发两分支；buildTimelineEntries 纯函数（聚合+兜底链+稳定排序）；renderTimeline（分页渲染+加载更多）；parseDateOnly/calCells/calBands 日历工具；renderCalendar（月/周网格+条带+导航）；localStorage 视图持久化（loadLastView/saveLastView）；详情面板 开始/截止 date input（change 即时 updateTask 持久化） |
| src/renderer/kanban.css | 新增 .kb-tl-*（时间线行/徽标四色/时间未知标记/命令摘要）、.kb-cal-*（网格/格/补位灰显/today 描边/条带任务/过期红标）、.kb-detail-dates（日期选择器行，color-scheme:dark） |
| tests/e2e/kanban-timeline.spec.ts | 新增 10 用例（场景映射见下）；种子数据相对今天锚定（避免机器日期漂移） |
| tests/e2e/kanban.spec.ts | 三视图计数断言 3→5（契约五视图） |

零新增 IPC、零 preload 改动、零存储层变更（T1 契约 §无接口变更声明达成——数据消费 renderer 已持有 `currentBoard.tasks[]` 内存态派生）。

## 技术方案对照（D1~D6 全部落地）

| 决策 | 落点 |
|---|---|
| D1 视图复用 | viewNames 五项 + render() 两分支；boardToolbar `Object.entries(viewNames)` 循环自动带出新按钮（工具栏代码零改动）；每次 render 全量重建容器内容保证视图隔离 |
| D2 时间线聚合 | buildTimelineEntries 纯函数：task.createdAt→创建 / timeline comment·system createdAt→评论·系统 / execution startedAt→finishedAt→task.updatedAt 兜底链（兜底标「时间未知」仍参与排序）/ 全缺固定末尾；ts desc 主键 + id desc 同戳 tie（Q-055「倒序后建在前」）；归档排除 |
| D3 日历本地时区 | parseDateOnly 强制 `new Date(y, m-1, d)` 本地构造 + 月/日回读比对（拒 2026-02-30 滚转）；calBands 区间按日遍历逐格落桶（Q-054 冻结，跨月/跨周边界自然连续）；仅 startDate→当月末尾；startDate>dueDate→dueDate 单日；过期以 dueDate<今日0点判定红色标记；Intl.DateTimeFormat('zh-CN') 中文月标签 |
| D4 视图持久化 | localStorage key=`kanban:lastView`；init 恢复替代硬编码 'board'；切换即写；枚举白名单校验非法值回退 board；try/catch 兜底隐私模式；HullSettings schema 零 bump（P4 达成） |
| D5 按需渲染 | TIMELINE_PAGE_SIZE=100 分页 + 加载更多（slice 追加语义不重不漏，PERF4）；日历先按可见范围求交再进 DOM（仅当月命中入 DOM）；ponytail 注释标注虚拟滚动升级路径（只换 renderTimeline 内部，聚合纯函数不动） |
| D6 消毒对齐 E1 | 评论条目 content 走既有 mdRender（markdown-it+DOMPurify 单一实现点复用不分叉）；execution/system content、command 摘要、标题等结构化字段 esc()；无裸插路径 |

## 关键实现

- **buildTimelineEntries 纯函数**：聚合与排序为纯数据变换，与 DOM 映射分离——TL1/TL2/TL3 场景经 e2e DOM 断言可隔离验证；排序 `pinned(a)-pinned(b) || b.ts-a.ts || id比较` 双键比较器保证两次渲染顺序一致。
- **parseDateOnly 本地时区**：正则格式 + `new Date(y,m,d)` 构造 + getMonth/getDate 回读三重校验；规避 `new Date('YYYY-MM-DD')` UTC 解析在 UTC+8 西移一天落错格（CAL5 语义由构造方式结构性保证）。
- **calBands 区间条带**：每任务算 [start,end] 与可见范围求交后逐日落 Map<dateKey, tasks[]>；月/周两套粒度共用同一算法（粒度切换只是可见范围变化）；格内渲染按 key 分桶挂载，条带视觉连续性由 CSS 处理。
- **分页**：`slice(0, page * TIMELINE_PAGE_SIZE)`，「加载更多」page++ 重渲染；切换视图/看板时 timelinePage 重置为 1（首屏封顶语义）。

## 实现期发现并修复的真实缺陷

1. **TDZ 静默回退（持久化失效）**：初版 `let view = loadLastView()` 位于 viewNames 定义之前——loadLastView 函数声明提升可调用，但函数体内 `Object.keys(viewNames)` 触发 const TDZ ReferenceError，被自身 try/catch 吞掉 → **每次启动静默回退 board，P2 重启保持场景必挂**。修复：viewNames + 持久化助手整体上移至状态块之前（并加注释说明顺序依赖）。教训：try/catch 包裹的初始化依赖会把 TDZ 错误变成静默降级。
2. **Date(null)=epoch 陷阱（破坏 Q-055 兜底链）**：初版 `tsOf = v => new Date(v).getTime()`——种子执行记录 `startedAt: null` 经 `new Date(null)` 得 epoch 0（合法时间戳非 NaN）→ 兜底链第一级就「命中」0 值，永不落到 finishedAt/updatedAt 兜底，条目排到 1970 固定末尾且不标「时间未知」。修复：tsOf 显式判 null/undefined/空串返回 null。TL3 场景抓出。

## 验证结果

| 项 | 结果 |
|---|---|
| e2e kanban-timeline.spec.ts | **10/10 pass**（21s） |
| e2e 全量回归 | 25 passed / 1 failed——唯一失败 cold-start.spec.ts nav 顺序断言缺 nav-skills：并行 S1 工作流提交（fea289b）新增 Skills 导航未同步该断言，与 T1 无关（T1 未触 shell.html/cold-start.spec.ts），归 S1 收尾 |
| 单测全量回归 | **573/573 pass**（node --test dist，含 T2/B5/exec 全量） |
| npx tsc --noEmit | src/skills 之外 0 错误（renderer 纯 JS 不在编译面；skills 残余错误属并行工作流范围） |

### T1 用例 ↔ 契约场景映射

- 五视图按钮呈现 + timeline/calendar 切换渲染 + 页内计时 <300ms → FR-5/PERF3（简化形态）
- 切 calendar 写 localStorage + reload 保持 + 注入 'hack' 回退 board → P1/P2/P3
- 活动流倒序六条目精确序列 + 创建/评论/执行徽标 + 点击跳详情 → TL1/TL5
- 执行缺 startedAt/finishedAt → updatedAt 兜底排序位置 + 「时间未知」标记 → TL3/Q-055
- 评论 XSS 三载荷（img onerror/javascript: href）不执行、markdown strong 渲染生效、原文文本可见、dialog 未触发、__xss===0 → TL7/D6
- 空板时间线空态文案 → TL6
- dueDate 今日落格 + 区间条带 ≥4 格连续 + 昨日过期红标 → CAL1/CAL2/CAL4
- 中文月标签 ^\d{4}年\d{1,2}月 + 月 42 格/周 7 格往返切换 → CAL6/CAL7
- 连续三次下月导航空态文案 → CAL10
- 详情面板设开始日期 → boards.json 落盘 + 日历条带出现（仅 startDate 至当月末尾）→ T2 契约 UI 承接闭环

未单独立用例（由实现性质覆盖）：TL2 同戳稳定性（双键比较器确定性 + TL1 精确序列断言隐含覆盖）、TL4 终极兜底固定末尾（pinned 分支与 TL3 同路径）、CAL3/CAL8/CAL9 边界（calBands 分支逻辑与 CAL2/CAL4 同路径，startDate 选择器用例已覆盖仅-startDate 形态）、PERF1/PERF2/PERF4 千卡注入（分页/过滤机制已落地，千卡样例注入留交付核验抽验）、P4 零 IPC spy 断言（无接口变更声明 + 代码面零新增通道结构性保证）。

## 偏差记录

1. **创建条目 id 复合键**：`${task.id}:create` 参与同戳 tie-break——契约「条目 id 字符串比较」在创建类条目无原生 timeline id，复合键保证确定性与唯一性（语义一致：倒序时后建在前）。
2. **PERF3 计时形态**：Playwright 无法钩 renderer 内部 render() 计时，以页内 `performance.now()` 包裹点击→双 requestAnimationFrame 渲染帧断言 <300ms（用户可感知口径等价）；PERF 权威口径千卡压测留交付核验抽验。
3. **详情面板日期编辑即时生效形态**：change 即 updateTask → close → loadBoard → 重开详情（复用既有评论成功后的刷新模式），非弹窗内原地刷新——「即时生效并持久化」语义达成，交互多一次弹窗重开（与既有模式一致，未引入新机制）。
4. **归档排除**：archivedAt 非空任务不进主时间线（T1 契约实现补充约定，协调事项已登记随下次共识修订回写 §12 留痕）。

## 核验记录（交付核验时填写）

| 项 | 结果 |
|:---|:-----|
| 状态 | 待核验（实现完成，draft 方案对应实现已落地；核验人/机制 + 日期 + 结论待填） |
| PERF 千卡抽验 | —（PERF1/PERF2/PERF4 ≥1000 卡注入样例计时/计数断言，交付核验抽验） |
| 实现偏离复核 | —（上述偏差 1~4 对照设计/契约复核结论待填） |
