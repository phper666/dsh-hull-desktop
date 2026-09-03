# U3 依赖图可视化（kanban-depgraph）实现记录

> ticket t100108 · 分支 feature/kanban-depgraph（worktree） · 设计 docs/design/U3-依赖图可视化-kanban-depgraph-design.md · 原型演示 3 定稿方向

## 判级

**复杂**——新弹框视图 + SVG 自绘 DAG 布局算法（拓扑分层/重心排序）+ 执行态实时联动 + 编辑表单扩展，四个子系统面。技术方案已产出并冻结（原型经用户确认 + 范围用户拍板「可视化+最小编辑」= 评审输入）。

## 工程基线三问

git ✓（worktree feature/kanban-depgraph，main 4ff76aa 起）· 测试框架 ✓（node:test 单测 + Playwright e2e）· 脚手架 ✓（Electron + TS 既有）

## 实现清单（4 commit）

| commit | 内容 |
|:-------|:-----|
| 0e5be81 | docs(design) 技术方案 |
| be53dea | feat 实现：depgraph-core.js（Kahn 分层环容错/重心排序/layout/poolState 快照优先回退/haltedSet 中止链派生，202 行）+ depgraph.js（独立弹框 900px×72vh 内联 SVG 八态着色 + 池水位 + 环警示，183 行）+ depgraph.css（--hull-* 令牌）+ kanban.js 4 集成点（详情摘要入口条/编辑表单前置依赖多选/exec 刷新幂等联动/闭包传参不反读）+ shell.html 接线 + package.json test:unit glob + .gitignore 反排除 |
| 7ff6e5b | fix 评审修复（见下） |
| ba9567d | test(e2e) 新增 tests/e2e/kanban-depgraph.spec.ts（详情摘要条/弹框节点≥4/ESC 关闭/无子任务卡不显示入口；seed=直写 boards.json，父卡+4 子任务两条依赖链） |

## 测试

- **core 单测**：23/23 绿（TDD 红→绿：分层链/并行/汇合/环容错、排序确定性、中止链闭包、池态快照优先/回退、空集、缺 maxParallel→3）
- **全量 test:unit**：828 pass / 0 fail，无回归
- **e2e**：kanban-depgraph.spec 1 例 + kanban.spec 全部回归绿（9 passed）
- **typecheck**：0 错（worktree node_modules 曾为 TS 4.3.4，已 npm install 同步 5.9.3）

## lint / Code Review / Semgrep 留痕

- **lint**：项目无 lint script（package.json 仅 build/typecheck/test）→ 跳过并记录
- **Code Review**：ocr 首跑 LLM 配额不足（opencode zen CreditsError）→ 转**团队既有机制 @oracle 独立评审**：**放行（无高）**，1 中（编辑表单可造环依赖——store 无环检测，方案假设不成立）+ 3 低（弹框异步竞态/双层弹框 ESC 双关/esc 纪律）+ 测试缺口 → 全部修复 commit 7ff6e5b（反向边守卫防环/竞态捕获 isConnected/ESC stopPropagation/esc(s.id)/补 2 边界测试）。ocr 二跑（用户重配 LLM）：0 意见但 **5/7 文件 provider 侧超时失败**（context deadline exceeded）——ocr 评审实质仍降级，gate 由 oracle 满足并在此记录
- **Semgrep**：已跑（auto config，depgraph 两 JS 文件）→ **0 发现**

## 交付核验对照（设计 §八验收标准）

| # | 标准 | 结果 |
|:--|:-----|:-----|
| 1 | 父卡详情见摘要条；无子任务不显示 | ✅ e2e 断言①③ |
| 2 | 弹框 DAG 分层正确/边方向/八态着色一致 | ✅ e2e 断言② + 单测 |
| 3 | 执行中状态实时刷新 | ✅ 集成点 c（幂等 open 推新数据）+ 手动验收项 |
| 4 | 编辑表单勾选前置依赖 → updateTask 持久化 → 图随变化 | ✅ 实现含反向边守卫；手动验收项 |
| 5 | failed 节点未执行后继显示「已中止」 | ✅ 单测（haltedSet 闭包）|
| 6 | CSP 不破 / typecheck / 单测 / e2e 绿 | ✅ 全绿 |

**待用户人工验收项**：真实执行中观察弹框实时刷新（标准 3）、编辑表单勾选体验（标准 4）、视觉走查（暗色/亮色）。

## 验收修复轮（2026-09-02，用户首轮验收 4 条反馈 → commit 443669b）

| # | 反馈 | 修复 |
|:--|:-----|:-----|
| 1 | 不像原型好看 | 对照原型逐项校准：节点 178×56 标题为主（两行截断+hover 全文）、id 缩 meta 小字、补八态中文徽标+优先级色条、状态框边色+hover 浮起 |
| 2 | 高度太小要下拉 | 弹框 72vh→78vh + `.dg-vp`/`.dg-scale` 等比缩放适配（s<0.5 不缩放保可读交滚动）；顺带修真 bug（清 canvas 销毁 scale 容器致图不可见） |
| 3 | 节点都是 id 看不懂 | 信息层级反转：标题主视觉+状态徽标+优先级色条，id 仅 tooltip/小字 |
| 4 | 子任务列表没了 | 结论 b：详情内 .kb-sub-list 实际仍渲染（e2e 补锁断言）；**弹框新增左栏子任务列表**（八态徽标、点行滚动高亮节点、hover 双向联动、▤ 折叠） |

验证：unit 23/23 · e2e 1/1（含新列表断言）· tsc --noEmit 干净 · CSP 未破。待用户二轮验收。

## 验收修复轮 2（2026-09-02，用户二轮截图反馈 → @observer 提取差异 → commit 37b2fbe）

| 优先级 | 问题 | 修复 |
|:-------|:-----|:-----|
| 🔴 | 画布利用率 ~50%（原型 ~85%），图挤在角落 | 缩放封顶 1 移除：`s=min(vpW/W,vpH/H)` 上限 1.6——小图等比放大撑满 |
| 🔴 | 节点重叠/边缘半截 | 层距 220→260、同层间隙 30→44、画布 padding 28→40 |
| 🟡 | 节点文字截断 | 节点 178×56→190×60，标题 13px/600 两行完整 |
| 🟡 | 头部+图例吃掉近半高度 | head/foot 单行紧凑，图区占比提升 |
| 🟢 | 亮色主题边线/文字对比度不足 | 新增 light 覆盖块（置于状态着色前）：边线 #a0a0a0/.85、节点边框 #c2c7cf、文字实色；壳主题跟随保留（不强制暗色） |

验证：unit 23/23 · e2e 1/1 · tsc 干净。待用户三轮验收。

## 验收修复轮 3（2026-09-02，用户三轮反馈「拉高+没有放大」→ commit 17e7d91）

| # | 反馈 | 修复 |
|:--|:-----|:-----|
| 1 | 图区再拉高 | 弹框 `min(88vh, calc(100vh - 64px))`，图区吃满剩余空间 |
| 2 | 只能整图适配，无法放大 | 加交互缩放：滚轮缩放（鼠标锚点，0.4~3.0）+ 空白拖拽平移（pointer capture，节点 hover 保留）+ 头部工具条 −/倍率/＋/适配（适配=重置 fit）；事件随弹框关闭清理（防泄漏）；core 布局不动 |

验证：unit 23/23 · e2e 1/1（新增滚轮放大+适配复位断言）· tsc 干净。待用户四轮验收。

## 风险项记录

- 环依赖防护在 UI 层（checkbox 过滤反向边）；store 仍无环检测——手改 JSON 造环会触发图的 cycle 警示（不崩），调度层面环内任务不可调度。如需硬防护，后续可在 store 加环检测（登记为候选改进）
- ocr LLM provider 超时问题未解（非本需求范围），下需求 review 前建议先验证 ocr 连通性
