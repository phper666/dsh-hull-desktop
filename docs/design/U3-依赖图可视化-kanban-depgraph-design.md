# U3 依赖图可视化（kanban-depgraph）技术方案

> 判级：**复杂**（新弹框视图 + SVG 自绘 DAG 布局算法 + 执行态实时联动 + 编辑表单扩展）→ 本文档
> 来源：M2 共识 §12/§15.3 U-003 + PRD §12 遗留待办；原型 docs/prototype/2026-09-02-kanban-dependency-graph-prototype.html（演示 3 定稿方向，用户确认）；ticket t100108
> 范围定案（用户拍板 2026-09-02）：可视化 + 最小编辑（编辑表单「前置依赖」多选）

## 一、目标与非目标

- 目标：①父卡详情弹窗依赖图**摘要入口条**（实时计数）→ 点击开**独立大弹框**（SVG 自绘分层 DAG，八态着色 + 失败中止链 + 并行池槽位）；②编辑表单新增「前置依赖」多选（同父兄弟），写回 updateTask dependencies——让依赖图有数据来源
- 非目标：图内拖拽编辑依赖（后续）；跨树/父级依赖（store 已禁，KanbanStore.ts:656-666）；甘特式时间轴；依赖图作为独立导航视图

## 二、代码事实基础（explorer 调研 2026-09-02）

| 事实 | 位置 |
|:-----|:-----|
| Task.dependencies: string[]（同父兄弟 task id）；parentId 单层；executionStatus 8 态（idle/queued/running/paused/interrupted/cancelled/failed/succeeded） | src/kanban/types.ts:16-24,86-115 |
| 子任务派生 childrenOf(t.parentId===id)；详情弹窗 openDetail(:480)、子任务列表 kb-sub-list(:491) | src/renderer/kanban.js:48-52,480-526 |
| 可复用 modal helper（createElement 建 .kb-modal + ESC/遮罩关闭 + kbOnClose 清理栈） | kanban.js:415-435 |
| 编辑表单仅 title/desc/priority，**dependencies/parentId 零 UI**（依赖数据只能 IPC/导入产生——本方案补最小编辑） | kanban.js:528-545 |
| CSP：script-src 'self' 'unsafe-inline'；**img-src 仅 data:**（图必须内联 SVG/DOM，禁外链图） | shell.html:5 |
| 池态：maxParallel 默认 3（内存 Scheduler.ts:78-80）；store 镜像 running/queued 但有滞后窗口、queued 阻塞/就绪不可分；**window.exec.getExecutionSnapshot 已暴露**（{running,queued,maxParallel}）——零新 IPC | preload/index.ts:189,197; ExecIpc.ts:121 |
| execNames 8 态中文映射 | kanban.js:14 |

## 三、架构

```
src/renderer/
  depgraph-core.js   # 纯函数：拓扑分层 + 重心排序 + 边坐标 + 池态计算 + 中止链派生（UMD 导出，node:test 直测）
  depgraph.js        # 渲染层：摘要入口条渲染 + 独立弹框 + SVG 绘制 + 状态联动（IIFE，window.depgraph）
  depgraph-core.test.js  # node:test 单测（纯函数向量）
  depgraph.css       # 弹框/摘要条/节点样式（--hull-* 令牌）
```

- **模块边界**：kanban.js 持有数据（闭包 boards/currentBoard），在详情弹窗与编辑表单调 `window.depgraph` API 传参——depgraph 不反读 kanban 状态，单向依赖
- **集成点**（kanban.js，4 处小改）：
  1. `openDetail(:480)` 详情 body 增摘要条：有子任务时渲染「依赖图 · N 依赖 · 池 x/y · 六态计数 + 查看依赖图 ↗」，点击 `depgraph.open(task, childrenOf(task.id))`
  2. 编辑表单(:528-545)增「前置依赖」checkbox 组（同父兄弟列表，排除自身）；保存时 `updateTask(..., { dependencies })`（契约 feishu-b1 已含 dependencies 参数，零 IPC 新增）
  3. 执行刷新回调(:610-612)后若弹框开着 → 调 `depgraph.refresh()` 重绘
  4. shell.html(:1372 后)加 `<script src="depgraph-core.js">`、`<script src="depgraph.js">` + shell.html `<link>` depgraph.css
- **渲染**：createElementNS 内联 SVG（CSP img-src data: 相容）；节点 <g>（rect+text），边 bezier path + marker 箭头

## 四、算法（depgraph-core.js，全部纯函数可单测）

1. **分层**：Kahn 拓扑分层（入度剥离），层 = 最长路径深度；环（异常数据）→ 剩余节点压最后层并标 `cycle` 警示
2. **层内排序**：重心法（barycenter，邻层前驱均序）2 轮扫描，减边交叉
3. **坐标**：层距 220px、节点 178×48（弹框大图模式）；给出节点 (x,y) 与边 path 控制点
4. **池态**：优先 `window.exec.getExecutionSnapshot`（真实 {running,queued,maxParallel}）；不可用时回退自算 runningCount（标注降级）——**不消费队列内部结构**
5. **中止链派生**（视觉语义，非数据）：failed/cancelled/interrupted 节点 → 沿依赖边正向闭包找后继，凡 queued/idle 状态者标「已中止」（虚线+删除线）；数据零改动

## 五、八态视觉映射（对齐 execNames + 原型）

| status | 名 | 视觉 |
|:-------|:---|:-----|
| succeeded | 已成功 | 绿左条 + 勾 |
| running | 执行中 | 蓝左条 + 脉冲 + 底部进度条 |
| queued | 排队中 | 琥珀左条（池满/等待共用） |
| idle | 未执行 | 灰 |
| paused | 已暂停 | 黄左条 |
| interrupted / cancelled | 已中断/已取消 | 橙左条 |
| failed | 失败 | 红左条 |
| （派生）被中止 | — | 红虚线框 + 删除线 |

## 六、测试策略（TDD 核心路径）

- **depgraph-core.test.js**（node:test，纯函数向量）：拓扑分层（链/并行/汇合/环容错）、重心排序确定性、中止链闭包（failed→后继 queued 标中止、succeeded 不标）、池态计算（快照优先/回退）
- **接线**：package.json test:unit glob 增 `src/renderer/*.test.js`（纯 JS 直跑，无需编译）
- e2e 增 1 例（详情摘要条可见 + 弹框可开）；编辑表单 checkbox 手动验证
- 渲染层弹框/入口条为 UI 胶水——走 e2e + 人工，不强行单测

## 七、风险与回退

| 风险 | 缓解 |
|:-----|:-----|
| 环依赖脏数据（手改 JSON） | 分层算法环容错 + cycle 警示徽标，不崩 |
| snapshot IPC 未初始化（无执行过） | try/catch 回退自算 running 计数 |
| 大规模子任务（≥20） | 弹框横滚 + 后续再议缩卡（YAGNI，原型已验证 10 任务 OK） |
| 8 态里 paused/interrupted 执行中语义混叠 | 按上表映射，仅取色区分，不加交互 |
| updateTask 依赖校验失败（环/跨父） | store 已校验（656-666），UI checkbox 只供同父兄弟，保存失败 toast 报错 |

## 八、验收标准

1. 父卡（有子任务）详情弹窗见摘要条；无子任务卡不显示
2. 点摘要条开独立弹框：DAG 分层正确、边指向前驱→后继、八态着色与列表徽标一致
3. 执行中单步推进（真实执行/或 manual 推进）弹框状态实时刷新
4. 编辑表单可勾选同父兄弟为前置依赖，保存后 updateTask 持久化、图随之变化
5. failed 节点的未执行后继在图中显示「已中止」
6. CSP 不破（无外链图/CDN）；typecheck + 全量单测 + e2e 绿

## 九、排期

1. depgraph-core.js TDD（分层/排序/池/中止链）
2. depgraph.js + depgraph.css（弹框 + 摘要条 + SVG）
3. kanban.js 4 集成点 + 编辑表单依赖多选
4. e2e 1 例 + 全量回归
