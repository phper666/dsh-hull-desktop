# Hull Desktop（dsh-hull-desktop）M2 PRD

> 版本：v0.6 修订　|　日期：2026-08-19　|　状态：评审通过（O-1~O-11 全部定案，无未决项）
> 范围：M2 —— 任务看板（规划/跟踪 + agent 执行集成）

**遗留待办（下期承接，详见 §12 后续规划）**：

- [ ] agentSpec 任务级指定（provider/agent/model 选择 UI）——P1，触发：多 agent 平台接入
- [ ] 多 agent 平台接入（provider 抽象落地）——P1，触发：接入第二个平台
- [x] 并行增强（依赖图可视化）——P2（2026-09-02 承接完成，ticket t100108）

---

## 1. 背景与定位

**M1 已交付**（2026-08-18 验收）：壳框架窗口——左侧 Hull 导航（dsh web / 设置 / 升级 / 任务看板占位 / 状态区）+ 右侧 WebContentsView 内嵌官方 dsh Web UI；dsh 升级/回滚、Hull 自更新、设置页/托盘全部可用。

**M2 目标**：激活任务看板入口（`shell.html` 中 `aria-disabled` + "M2 规划中" 占位，S8 D6），提供**规划与跟踪开发工作**的看板，并支持**把任务交给 dsh agent 执行**、结果回写看板。

看板解决的核心问题：

- **规划**：把开发工作拆成卡片（可拆子任务），按列排布（默认 6 态模板，列可自定义）；
- **跟踪**：一眼看清每张卡在哪个阶段、谁在阻塞、哪些待验证；父卡内嵌子任务进度；
- **执行**：卡片不只是记录——任务级配置手动/自动执行模式，自动模式可直接触发 dsh agent 执行，执行状态与结果回写看板，形成"规划 → 执行 → 验证 → 完成"闭环。

**用户画像**：程序员 / 独立开发者——用 dsh 做 agent 驱动开发，需要轻量看板管理多任务，且希望任务能直接交给 agent 跑，而不是复制粘贴到 dsh 会话里。

## 2. 目标用户与场景

| 用户 | 场景 |
|---|---|
| 程序员（主力） | 用 dsh 做开发：看板规划任务 → 点「执行」交给 dsh agent → 结果回写 → 验证 → 完成 |
| 独立开发者 | 多项目/多任务并行，需要可视化跟踪进度、识别阻塞项 |
| 团队协作成员（后续） | 统一装壳即可用；M2 不做多人协作/同步（见 §12 后续规划） |

**核心用户故事**：*"我是一个用 dsh 的开发者，我希望在壳里打开看板，把任务排进列里，点一下就能让 dsh agent 去执行，执行完结果自动回到看板上，我能看到它做到哪一步、结果如何。"*

## 3. 路线决策记录（A/B/C）

> 决策日期：2026-08-19　|　状态：已定（推荐 C，评审通过）

### 3.1 三条路线对比

| 维度 | A 纯 dsh 插件 | B 纯壳内实现 | **C 混合（推荐）** |
|:-----|:-------------|:-------------|:------------------|
| 可移植性 | 高（换壳继续用） | 低（绑定 Hull） | 中（看板绑定 Hull，执行能力随 dsh 走） |
| 用户绑定 | 弱（看板不绑定 Hull） | 强（看板是 Hull 功能） | 中（看板本体绑定 Hull = 商业模式；执行能力可移植） |
| 复杂度 | 高（Cordis 插件体系学习成本、UI 组件走 dsh.client slot） | 低（壳内 Electron + 本地存储） | 中（壳内看板 + 一个官方接入通道） |
| 数据归属 | dsh 内部（DSH_HOME 或插件数据目录） | 壳 userData（绿区，不触 DSH_HOME） | 壳 userData（绿区，不触 DSH_HOME） |
| 红线相容（CON-R004） | 相容（本身就是官方扩展点） | **冲突**（agent 执行必须走 dsh 内部 → 纯壳内撞 CON-R004） | 相容（agent 执行走官方扩展点） |
| agent 执行集成 | 天然（插件在 dsh 内部） | 不可行（无官方通道） | 官方通道（ACP 协议 / 插件注册工具/命令，见 §7.4） |

### 3.2 决策：C 混合路线

**理由**：

1. **看板是壳层功能，不必要进 dsh**——规划/跟踪/持久化全部在壳内完成（userData 存储，绿区），不碰 DSH_HOME（CON-R002），不触发红线；
2. **agent 执行必须走官方通道**——调用 dsh agent 跑任务属于"需要跑在 dsh 内部的功能"，按 CON-R004 只能走官方通道（ACP 协议 / `--patch` 插件注册工具/命令，见 §7.4）；
3. **复杂度可控**——壳内看板用 Electron + 本地 JSON 存储，无 Cordis 插件体系学习成本；扩展点插件只承担"接收任务 → 调 dsh agent → 回传结果"一条窄通道；
4. **与既有规划一致**——M1 PRD L53 明示"任务看板（M2+，走官方扩展点插件）"、README L19"任何需要跑在 dsh 内部的功能走 dsh 官方插件扩展点"。

**dsh 扩展点机制（调研结论，供实现引用）**：

- `--patch` overlay：Cordis 插件树最后层，可覆盖配置；插件 = TS 模块导出 `apply` + `name`，client 侧 UI 插件走 `src/client/` + `dsh.client` manifest；
- slot 系统：插件注册 UI 组件到预定义 slot（`ctx.slots.register`），可加新页面/面板；
- 宿主插件：`ctx.on` 事件（`tools/pre-execute` 等）、`ctx.tools.register` 自定义工具、`harness.handle` / `host.call` IPC；
- 配置：`cordis.yml` 注册插件绝对路径，`dsh web --patch` 传入。

### 3.3 备选兜底（插件路线受阻时）

若官方扩展点 API 不稳定/文档缺失/能力不足（M2 实现期验证），**壳内降级方案**：

- 看板本体（P0/P1 非执行部分）不受影响，照常交付；
- agent 执行降级为**手动搬运**：全部任务视为 manual 执行模式（FR-6 天然兼容）——卡片「执行」按钮改为「复制任务描述」+ 提示"在 dsh 会话中粘贴执行"，AI 结果由用户以评论回填（FR-9），列流转手动；
- 降级不破坏任何红线（纯壳内操作），待官方扩展点成熟后升级回 C 路线；
- 触发条件与恢复路径写入实现记录，作为 M2 风险项（§10 R1）。

## 4. M2 范围

### 4.1 In Scope

**P0（M2 核心，必须交付）**

- **列自定义**：默认预置 6 态模板列（Backlog/Todo/In Progress/Verify/Done/Blocked，对齐团队配置 status_map）；列可新增/删除/重命名/排序/改色/隐藏（模板列不可删，Blocked 默认显示）。
- **任务卡片 CRUD**：新建/编辑/删除卡片（标题必填，其余字段 P1 扩展）；新建时可选执行模式与父任务（子任务）。
- **状态流转**：卡片在列间移动（按钮/菜单操作，P2 升级为拖拽）；Blocked 可进可出，解除后回原列；含子任务的父卡状态由子任务聚合推导。
- **执行模式配置**：任务级 `executionMode`（manual/auto）；auto 模式验收标准（做什么/期望结果/如何验证）必填，未填不可提交执行。
- **子任务管理**：任务可拆子任务（单层），父状态聚合（全部完成 → 父完成）；多个子任务可交由多个 agent 依次执行。
- **子任务视图**：父卡内嵌子任务进度条 + 可展开子任务列表；子任务为独立卡片可流转。
- **评论与执行记录**：卡片内统一时间线（评论/执行记录/系统事件）；手动模式 AI 结果以评论回填（文本/文件引用）。
- **看板数据持久化**：`<userData>/kanban/boards.json`（JSON 单文件，schema 版本 + 原子写，复用 settings.json 模式；损坏自动备份重建）。
- **壳导航入口激活**：`shell.html` 看板占位激活（移除 `aria-disabled` + "M2" 标签），点击切换右侧内容区为看板视图。

**P1（M2 完整闭环）**

- **任务详情**：描述（Markdown）、标签、优先级（P0/P1/P2/P3）、截止日期。
- **agent 执行集成**：卡片「执行」→ 经 ExecutionProvider（§7.4：默认 ACP / 备选插件 / 兜底 CLI）执行任务 → 结果回写看板（manual 模式：回写为评论；auto 模式：写入执行记录 + 自验通过自动流转到 Verify；串行调度 + 并行上限 + 生命周期状态机 + 人工干预）。
- **执行状态视图**：卡片上显示执行状态（排队/运行中/成功/失败），可查看执行记录详情（命令、输出摘要、退出码、耗时、完整输出）。

**P2（M2 增强，视进度交付）**

- **拖拽流转**：卡片拖拽跨列移动（替代按钮操作）。
- **筛选/搜索**：按标签/优先级/负责人/关键词过滤卡片。
- **多看板**：多块看板（如按项目/里程碑分板），看板列表切换。
- **看板数据导出/导入**：JSON 导出/导入（可移植性，换机迁移；多设备同步的过渡方案）。

### 4.2 Out of Scope（明确排除）

- **不碰 DSH_HOME**：看板数据只存壳 userData，绝不读写 `~/.dsh`（CON-R002）。
- **不改官方 UI**：看板是壳内视图，官方 WebContentsView 零注入（CON-R001）。
- **不做 dsh 内部会话管理**：不管理 dsh 会话生命周期、不读取会话内容；agent 执行经 §7.4 接入通道（ACP/插件/CLI），壳不直接操作 dsh 内部。
- **多设备同步**（M2 不做，见 §12 后续规划；P2 导出/导入为过渡方案）。
- **多人协作/权限**（M2 不做）。
- **看板数据加密**（O-3 已定案：M2 不加密；同步/云协作场景重新评估，见 §12 后续规划）。
- **插件独立发布**（O-5 已定案：随壳分发；独立发布留 §12 后续规划）。

## 5. 数据模型

> 存储：`<userData>/kanban/boards.json`（JSON 单文件）。

**选型理由（O-3 定案）**：单用户本机场景、数据量小；JSON 天然可迁移（复制文件即备份/迁移）；零依赖（无 DB 引擎、无序列化库）；P2 导出/导入功能直接受益于 JSON 格式。`ponytail: 同步/云协作/多用户场景出现时再评估 SQLite（届时 JSON→SQLite 迁移 + schema 版本升级），M2 不做（YAGNI）`。

**写入与恢复**：原子写（写临时文件 `boards.json.tmp` → rename 覆盖，复用 M1 settings.json 写盘模式）；启动加载 + 变更即写（防抖 500ms）；解析失败/损坏 → 备份为 `boards.json.corrupt-<ts>` → 重建默认看板（见 §9）。

**schema 版本**：顶层 `version` 字段；不兼容演进时版本递增 + 迁移函数（见 §10 R2）。

JSON Schema（顶层 = 看板列表；任务平铺，子任务用 `parentId` 关联）：

```jsonc
// boards.json
{
  "version": 1,                       // schema 版本，演进时递增
  "boards": [
    {
      "id": "b_<uuid>",
      "name": "默认看板",
      "createdAt": "2026-08-19T00:00:00.000Z",
      "updatedAt": "2026-08-19T00:00:00.000Z",
      "columns": [
        // 默认预置 6 态模板（首次创建自动生成）；type 仅模板列有（唯一、不可删）；自定义列无 type
        // color = 列头色带（列语义，列自定义时配置）；非卡片颜色
        { "id": "c_<uuid>", "type": "backlog",     "name": "Backlog",     "order": 0, "color": "#8b949e", "hidden": false },
        { "id": "c_<uuid>", "type": "todo",        "name": "Todo",        "order": 1, "color": "#58a6ff", "hidden": false },
        { "id": "c_<uuid>", "type": "in_progress", "name": "In Progress", "order": 2, "color": "#d29922", "hidden": false },
        { "id": "c_<uuid>", "type": "verify",      "name": "Verify",      "order": 3, "color": "#a371f7", "hidden": false },
        { "id": "c_<uuid>", "type": "done",        "name": "Done",        "order": 4, "color": "#3fb950", "hidden": false },
        { "id": "c_<uuid>", "type": "blocked",     "name": "Blocked",     "order": 5, "color": "#f85149", "hidden": false },
        // 自定义列示例（无 type）
        { "id": "c_<uuid>", "name": "需求评审", "order": 6, "color": "#6e7681", "hidden": false }
      ],
      "tasks": [
        {
          "id": "t_<uuid>",
          "parentId": null,               // 非空 = 子任务（指向父任务 id）；单层嵌套
          "columnId": "c_todo",
          "title": "实现看板拖拽流转",
          "executionMode": "manual",      // manual | auto（默认 manual，可切换）
          "acceptanceCriteria": {         // auto 模式必填（what/expected/verify 强校验）；manual 可空
            "what": "实现跨列拖拽，含边界处理",            // 做什么（强校验必填）
            "expected": "拖拽移动即时生效并持久化",        // 期望结果（强校验必填）
            "verify": "看板中手动拖拽 3 张卡，重启后位置保持", // 如何验证（强校验必填）
            "context": "repo: dsh-hull-desktop; 范围: src/renderer/kanban" // 上下文（可选，auto 提交时 UI 提示推荐填）
          },
          "agentSpec": {                  // agent 指定（M2 默认不指定 → dsh 默认会话；数据结构留位，功能排后，O-10 定案）
            "provider": "dsh",            // agent 平台（默认 'dsh'，预留其他平台）
            "agent": null,                // 具体 agent（可空）
            "model": null                 // 模型（可空）
          },
          "description": "## 目标\n卡片可拖拽跨列移动…",   // Markdown，P1
          "labels": ["ui", "p2"],                          // P1；标签 = 彩色小徽标（用户可配颜色）
          "priority": "P1",                                // P0/P1/P2/P3（可空）；卡片左侧色条：P0 红 / P1 琥珀 / P2 蓝 / 无优先级灰（枚举色板，非每卡随机色）
          "dueDate": "2026-08-30",                         // P1，可空
          "order": 0,                                      // 列内排序
          "blockedFromColumnId": null,                     // Blocked 来源列，解除时恢复
          "createdAt": "2026-08-19T00:00:00.000Z",
          "updatedAt": "2026-08-19T00:00:00.000Z",
          "timeline": [                                    // 统一时间线：评论 + 执行记录 + 系统事件
            {
              "id": "tl_<uuid>",
              "type": "comment",                           // comment | execution | system
              "content": "已完成拖拽流转，diff 见附件",      // 评论文本 / 执行摘要 / 事件描述
              "attachments": [                             // 文件引用（manual 模式 AI 结果等）
                { "name": "kanban-drag.diff", "path": "kanban/attachments/tl_<uuid>/kanban-drag.diff", "size": 2048 }
              ],
              "createdAt": "2026-08-19T01:00:00.000Z",
              "author": "dsh agent",                       // 显示名（可空）
              "source": {                                  // 来源（人工把关区分可信来源）
                "type": "agent",                           // user | agent | system
                "agentId": "a_<uuid>",                     // 具体 agent（可空）
                "provider": "dsh"                          // agent 平台（默认 'dsh'，预留其他平台）
              },
              "execution": null                            // type=execution 时携带
            },
            {
              "id": "tl_<uuid>",
              "type": "execution",
              "content": "执行成功：拖拽流转 + 边界处理完成",
              "attachments": [],
              "createdAt": "2026-08-19T01:05:32.000Z",
              "author": "dsh agent",
              "source": { "type": "agent", "provider": "dsh" }, // execution 记录恒为 agent
              "execution": {
                "status": "succeeded",                     // queued | running | succeeded | failed
                "command": "dsh run 实现看板拖拽流转…",      // 实际下发的 agent 命令
                "startedAt": "2026-08-19T01:00:00.000Z",
                "finishedAt": "2026-08-19T01:05:32.000Z",
                "exitCode": 0,
                "outputPath": "kanban/executions/e_<uuid>.log" // 完整输出落盘（可选）
              }
            },
            {
              "id": "tl_<uuid>",
              "type": "system",
              "content": "卡片从 Todo 移动到 In Progress",
              "attachments": [],
              "createdAt": "2026-08-19T00:30:00.000Z",
              "author": "system",
              "source": { "type": "system" },              // 系统事件
              "execution": null
            }
          ]
        }
      ]
    }
  ]
}
```

**字段约束**：

- `column.type` 枚举：`backlog | todo | in_progress | verify | done | blocked`；仅预置模板列有 type，同一看板内 type 唯一、模板列不可删除；自定义列无 type（可增删/改名/排序/改色）。
- 状态流转语义（对齐团队配置）：Backlog=排期池 / Todo=待办 / In Progress=进行中 / Verify=验证审查 / Done=完成；**Blocked 可进可出**——从任意列进入 Blocked（记录 `blockedFromColumnId`），解除后回原列（来源列已删除则回 Todo）。
- 删除列：仅允许删除自定义列；删除时列内卡片移入 Todo。
- `task.parentId`：非空即子任务；父任务列状态默认由子任务聚合推导（全 Done → 父 Done；任一 Blocked → 父 Blocked；否则父列 = 子任务列中 order 最大的列），人工移动父卡可覆盖（FR-4 人工拖拽语义）；子任务单层（不可再嵌套，YAGNI）。
- `executionMode`：manual = 执行无需验收标准，AI 结果以评论回填、列流转手动；auto = `acceptanceCriteria` 必填（what/expected/verify 三项强校验必填，context 可选但提交时 UI 提示推荐填），未填不可提交执行，执行成功后自动写入执行记录并流转。
- `timeline`：统一流，`type` 区分 comment/execution/system；`source` 为来源对象（type: user/agent/system + agentId/provider）——execution 记录恒为 agent、system 事件恒为 system、评论可为 user 或 agent（人工把关需区分内容可信来源）；provider 标识 agent 平台（默认 'dsh'，预留接其他平台），agentId 标识具体 agent；评论可删除（删除时附件文件一并删除）；execution/system 记录只读。
- `agentSpec`：任务级 agent 指定（provider/agent/model）——M2 默认不指定（走 dsh 默认会话），数据结构留位、功能排后（O-10 定案，UI 预留 P1/P2）。
- 颜色语义（三色分层，非每卡独立随机色）：卡片左侧色条 = 优先级（P0 红 / P1 琥珀 / P2 蓝 / 无优先级灰，枚举色板）；标签 = 彩色小徽标（用户可配颜色）；列头色带 = 列语义（列自定义时配置 `column.color`）。
- 附件上限：`maxAttachmentSizeMB` 为全局设置项（默认 10，可改，见 §7.3），单文件超限拒绝上传并提示；删除卡片级联清理其评论 + 附件（含磁盘文件）。
- 并行上限：`maxParallelTasks` 为全局设置项（默认 5，可改，见 §7.3），并行执行时并发任务数上限（O-9 定案）。
- 数据损坏兜底：解析失败 → 备份损坏文件为 `boards.json.corrupt-<ts>` → 重建默认看板（见 §9）。

## 6. 功能需求

### FR-1 看板导航入口激活（P0）

- `shell.html` 看板 nav 项：移除 `aria-disabled` + "M2" 标签，点击切换右侧内容区为看板视图（复用 S8 D6 导航切换语义——nav 点击更新 active + 触发 IPC，主进程驱动视图）。
- 看板视图为壳内页面（`file:` 协议，走壳 partition 'shell' + preload 桥），与官方 WebContentsView 互斥显示。
- 验收：点击「任务看板」→ 右侧显示看板视图（默认看板 + 6 列）；点击「dsh web」→ 切回官方 UI；看板视图不干扰官方 view 生命周期。

### FR-2 列自定义（P0）

- 首次进入看板：自动创建默认看板，预置 6 态模板列（Backlog/Todo/In Progress/Verify/Done/Blocked，含默认颜色）。
- 列操作：新增自定义列、重命名、排序（左右移动）、改色、隐藏/显示（Blocked 默认显示）、删除自定义列。
- 验收：新建看板即见 6 列且顺序正确；新增/重命名/排序/改色/隐藏即时生效并持久化（重启后保持）；删除自定义列时列内卡片移入 Todo；模板列不可删除、不可改 type。

### FR-3 任务卡片 CRUD（P0）

- 新建卡片：标题必填（≤200 字符），默认入 Todo 列；可选执行模式（默认 manual，FR-6）与父任务（建子任务，FR-7）。
- 编辑卡片：改标题；P1 起可改描述/标签/优先级/截止。
- 删除卡片：确认后删除（含时间线记录与附件文件）；删除父任务时级联删除子任务（二次确认）。
- **颜色语义（三色分层，非每卡独立随机色）**：卡片左侧色条 = 优先级（P0 红 / P1 琥珀 / P2 蓝 / 无优先级灰，枚举色板）；标签 = 彩色小徽标（用户可配颜色）；列头色带 = 列语义（列自定义时配置）。
- 验收：新建/编辑/删除即时生效并持久化；标题为空不可保存；删除有确认；父卡删除级联子卡有明确提示；卡片颜色随优先级/标签/列配置正确显示，且看板提供颜色图例可见。

### FR-4 状态流转（P0）

- 卡片在列间移动：卡片菜单「移动到…」列出目标列（排除当前列）。
- Blocked 语义：进入 Blocked 记录来源列（`blockedFromColumnId`）；解除 Blocked 自动回来源列；来源列已删除则回 Todo。
- 含子任务的父卡：列默认由聚合推导（FR-7）；人工移动父卡为最高优先级可覆盖（带冲突确认，见下）。
- **人工拖拽语义（人工移动 = 菜单/拖拽，最高优先级）**：
  - 人工移动直接生效，系统**不自动矫正**（永不覆盖人工状态）；
  - 冲突提示（可强制通过）：拖到 Done 但执行中/未执行 → 确认弹窗"任务未完成执行，确认跳过？"；父卡拖 Done 但子任务未完成 → 确认弹窗"子任务未全部完成，确认？"；执行中拖到其他列 → 执行不终止，结果写 timeline，列以人工为准（标注"执行完成，列由人工指定"）；
  - 聚合自动重算：子卡拖拽 → 父卡进度/状态即时重算（父卡未被人工锁定前提下；父卡人工拖拽后聚合不覆盖，除非用户再次移动）；
  - 拖拽动作写 timeline（system 记录：from→to、时间、user）。
- 验收：卡片可移动到任意列（含 Blocked）；Blocked 解除后回来源列；流转后 `updatedAt` 更新并持久化；拖拽冲突场景弹窗提示且可强制通过；人工移动后系统不自动矫正（列保持人工指定）；子卡拖拽后父卡聚合即时重算；拖拽动作在时间线可见（from→to/时间/user）。

### FR-5 看板数据持久化（P0）

- 数据落盘 `<userData>/kanban/boards.json`：JSON 单文件 + schema `version` + 原子写（临时文件 + rename，复用 settings.json 模式），写失败不破坏现有数据。
- 启动加载 + 变更即写（防抖 500ms）；解析失败 → 备份 `boards.json.corrupt-<ts>` → 重建默认看板并提示。
- 验收：任意 CRUD/流转/评论操作后重启壳，数据完整恢复；写入失败（磁盘只读等）提示错误且内存态不丢；注入损坏文件可触发备份重建。

### FR-6 执行模式配置（P0）

- 任务级 `executionMode`：manual（默认）| auto，创建时可选、详情面板可随时切换。
- auto 模式：验收标准 `acceptanceCriteria` 四项——what（做什么）/ expected（期望结果）/ verify（如何验证）三项**强校验必填**，context（上下文：仓库路径/文件范围/链接）可选但提交执行时 UI 提示推荐填写；必填项未填完整时卡片「执行」禁用并提示"请先填写验收标准"，不可提交执行。
- manual 模式：无需验收标准；AI 执行结果由用户手动放入 ticket（文本/文件引用，以评论回填，FR-9），列流转手动（FR-4）。
- 子任务默认继承父任务 executionMode，可单独覆盖。
- 验收：切换 auto 且 AC 未填 → 执行入口禁用；AC 补全 → 恢复可用；manual 模式无 AC 门槛；执行模式持久化（重启保持）。

### FR-7 子任务管理（P0）

- 任务可拆分子任务：父卡「添加子任务」→ 新建子卡（独立卡片，`parentId` 指向父卡）；子任务支持独立编辑/删除/流转。
- 父状态聚合：全部子任务在 Done 列 → 父卡自动移到 Done；任一子任务在 Blocked → 父卡 Blocked；否则父卡列 = 子任务所在列中 order 最大的列（进度最靠后）；父卡列默认由聚合推导，人工移动可覆盖（FR-4 人工拖拽语义）。
- 单层嵌套：子任务不可再拆子任务（YAGNI）。
- **双向导航**：父 ticket 详情含子 ticket 列表（点击跳转子卡）；子 ticket 详情含父引用面包屑（点击跳回父卡）。
- 验收：新增/删除子任务后父卡聚合状态即时更新并持久化；全部子任务完成 → 父卡自动入 Done；任一子任务 Blocked → 父卡 Blocked（解除后按规则重算）；父卡默认聚合推导、人工移动可覆盖且带冲突确认；父详情子列表与子详情父面包屑点击均可正确跳转。

### FR-8 子任务视图（P0）

- 父卡内嵌子任务进度条（完成数/总数，完成 = 子任务位于 Done 列）+ 可展开子任务列表（摘要行：标题/当前列/状态徽标）。
- 进度条**跨列聚合**：统计全部子卡完成数（不论所在列），展开列表逐行显示每子卡当前列。
- **子卡跨列独立显示**：子卡是独立卡片——跨列后在目标列以普通卡视觉独立显示（非常驻父卡下方），仅保留**父引用徽标**（`↳ #父编号 缩略标题`，点击跳转父卡）；父卡聚合进度 + 展开列表为跨列关联的唯一视图。
- 子任务为独立卡片：正常显示于各自列，可拖拽（P2）/菜单流转；流转后父卡聚合即时更新。
- **P2 愿景**：按父任务分组视图/泳道（同一父任务的子卡聚合展示在同一泳道）。
- 验收：父卡显示进度条且随子任务流转实时更新；展开可见全部子任务及当前列；子任务跨列后在目标列以普通卡独立显示（非常驻父卡下）且带父引用徽标；子任务独立流转后父卡聚合变化正确；父引用徽标点击跳转父卡。

### FR-9 评论与执行记录（P0）

- 卡片内统一时间线（按时间正序）：`comment`（用户/AI 文本 + 附件引用）、`execution`（执行记录，P1 起自动写入）、`system`（创建/移动/删除等系统事件，只读）。
- **来源区分**：每条记录带 `source` 对象（type: user/agent/system + agentId/provider）——execution 记录恒为 agent、system 事件恒为 system、评论可为 user 或 agent；provider 标识 agent 平台（默认 'dsh'，预留接其他平台），agentId 标识具体 agent；UI 按来源区分样式（人工把关需区分内容可信来源）。
- manual 模式：AI 执行结果（文本/文件引用）以评论追加（通道回传自动追加；通道不可用时用户手动粘贴/拖文件）。
- 附件：文件引用落盘 `<userData>/kanban/attachments/`；单文件上限 = 设置项 `maxAttachmentSizeMB`（默认 10，可改，见 §7.3），超限拒绝并提示；评论可删除（附件一并删除）。
- 删除卡片：级联清理其全部评论 + 附件（含磁盘文件）。
- 验收：时间线按时间排序展示且持久化；手动模式可粘贴文本 + 添加文件引用作为评论；评论与执行记录来源样式可区分；删除评论后重启不复活、附件文件已清理；删除卡片后其附件磁盘文件一并清理；超限附件上传被拒绝并提示。

### FR-10 任务详情（P1）

- 卡片详情面板：描述（Markdown 渲染 + 编辑）、标签（多选/自定义）、优先级（P0/P1/P2/P3，默认 P2）、截止日期（日期选择，可空）。
- 验收：详情编辑即时生效并持久化；Markdown 描述渲染正确；截止日期过期卡片在列内视觉标记。

### FR-11 agent 执行集成（P1）

- 卡片「执行」→ 经 ExecutionProvider（§7.4：默认 ACP host，备选 --patch 插件，兜底 CLI headless）执行任务（任务描述 + AC 作为执行输入）；执行前确认（任务内容 + 目标 agent 会话）；执行中卡片标记运行态，禁止重复触发（单卡单执行）。
- 执行门控：auto 模式 AC 必填项未填完整 → 执行禁用（FR-6）；manual 模式无门槛。
- **agentSpec（O-10 定案）**：任务级 `agentSpec`（provider/agent/model）M2 默认不指定 → 走 dsh 默认会话；数据结构已入 schema 留位，任务级指定 agent/模型为未来迭代（UI 预留，标注 P1/P2）。
- 结果回写：manual 模式 → 结果以评论追加（FR-9）；auto 模式 → 写入 execution 记录 + 自验通过自动流转（目标列 = Verify，O-6 已定案）。
- **串行调度（O-7 定案）**：父任务执行 = 子任务默认**串行**依次执行，各自回写；理由——逐步验证哲学（每步验证后再进下一步）、子任务依赖天然满足、失败定位准确。
- **并行执行（O-9 定案）**：显式声明"无依赖"的子任务才可并行；并发任务数上限 = 设置项 `maxParallelTasks`（默认 5，可改）；并行执行属 P2 增强，M2 默认串行。
- **执行生命周期状态机**：

```
idle → queued → running → succeeded → Verify（人工把关）→ Done
                ├──→ paused ──→ running（恢复）/ cancelled
                ├──→ cancelled
                └──→ failed ──→ queued（重试）
```

- **干预动作表**（全部写入 timeline：type: system, source.type: user）：

| 动作 | 触发条件 | 结果 |
|:-----|:---------|:-----|
| 暂停 | running 中 | 标记 paused（ACP 无暂停语义，降级为"标记暂停 + 结果丢弃保留现场"，O-11 定案）；可恢复或取消 |
| 取消 | running/paused 中 | 经 ACP `session/cancel` 中断；结果丢弃，保留现场 |
| 重试 | failed/cancelled 后 | 重新入队 queued → running |
| 手动完成 | 结果可疑时人工复核通过 | 卡片流转 Verify → Done（仍走 Verify 把关主流程，不绕过） |
| 改状态/编辑结果 | 结果可疑 | 手动改列/编辑 execution 记录内容；干预后仍走 Verify 把关 |

- **执行中修订（AC amendment）**：running 中用户编辑 AC 的完整流程——
  - 编辑触发弹窗警示"将中断当前执行"；
  - 当前执行标记 `interrupted`（原因：AC 修订），partial 结果保留进 timeline 并标注"已废弃（AC 修订）"；
  - AC diff 写入 timeline（system 记录：变更前后对照、时间、操作人）；
  - 用户三选：① 以新 AC 重新执行（重新入队，现场结果可参考）② 手动完成（不重跑）③ 仅记录修订继续原执行（不推荐，agent 仍按旧 AC）；
  - 验证以最新 AC 为准；重跑后新执行记录追加。
- **执行通道接口定义**（见 §7.4 ExecutionProvider）。
- 验收：点「执行」→ dsh agent 实际运行任务 → 结果回写（manual 评论 / auto 记录+流转到 Verify）；执行中卡片显示运行态且「执行」按钮禁用；dsh 未就绪时「执行」禁用并提示；auto 模式 AC 必填项缺失时不可执行；父任务子任务按声明顺序串行执行、前序失败则中止后续；显式声明无依赖的子任务可并行且并发数 ≤ maxParallelTasks；暂停/取消/重试/手动完成/改状态均生效、干预后仍走 Verify 把关、干预动作在时间线可见（system, user）；执行中修订 AC：中断警示、interrupted 标记 + 已废弃标注、AC diff 留痕（前后对照/时间/操作人）、三选一动作生效、验证以最新 AC 为准、重跑后新执行记录追加。

### FR-12 执行状态视图（P1）

- 卡片显示最近一次执行状态徽标（排队/运行中/成功/失败；auto 模式成功后父卡聚合联动）。
- 执行记录列表（时间线内 execution 条目）：命令、状态、退出码、耗时、输出摘要；可展开查看完整输出（`outputPath` 落盘文件）。
- 验收：执行状态徽标随执行进度实时更新；执行记录完整可查；失败记录可见退出码与输出摘要。

### FR-13 拖拽流转（P2）

- 卡片拖拽跨列移动（替代/补充 FR-4 菜单操作；子任务独立卡片同样可拖拽）。
- 拖拽遵循 FR-4 人工拖拽语义：冲突提示（可强制通过）、系统不自动矫正、子卡拖拽触发父卡聚合重算、拖拽动作写 timeline。
- 验收：拖拽移动即时生效并持久化；拖拽中列高亮目标；与 FR-4 菜单操作行为一致（含冲突提示与不矫正语义）。

### FR-14 筛选/搜索（P2）

- 按标签/优先级/关键词过滤卡片；支持多条件组合。
- 验收：过滤即时生效；无匹配时显示空态提示。

### FR-15 多看板（P2）

- 看板列表（新建/切换/重命名/删除）；每板独立 6 态列与卡片。
- 验收：多板切换数据隔离；删除看板有确认（含其全部卡片）。

### FR-16 看板数据导出/导入（P2）

- 导出：当前看板（或全部）→ JSON 文件（用户选路径）。
- 导入：选择 JSON 文件 → 校验 schema → 合并/替换。
- 验收：导出文件可被导入还原（同机/异机）；导入非法文件报错且不破坏现有数据。

## 7. 接口点

### 7.1 壳导航入口（shell.html 占位激活）

- 现状（S8 D6）：`<button id="nav-board" class="nav-item" aria-disabled="true" title="M2 规划中">任务看板<span class="tag">M2</span></button>`，点击无操作。
- 激活：移除 `aria-disabled` + `title` + `<span class="tag">`；点击 → `setActive('nav-board')` + `bridge.openKanban()`（新增 IPC，主进程切换右侧内容区为看板视图）。
- 看板视图渲染：壳内页面（`file:` 协议，partition 'shell' + preload），与官方 view 互斥（复用 S8 D4 占位区块切换机制，新增 `placeholder:kanban` 视图态或独立页面）。

### 7.2 preload 桥新增方法（看板 CRUD IPC）

> 挂载于壳页 preload（`src/preload/index.ts` 扩展），sandbox 兼容 + 固定白名单（沿用 S8 安全基线）。

| 方法 | 方向 | 说明 |
|:-----|:-----|:-----|
| `openKanban()` | invoke | 主进程切换看板视图 |
| `kanban:getBoard(boardId?)` | invoke | 读默认/当前看板全量数据 |
| `kanban:createTask(input)` | invoke | 新建卡片/子任务（input 含 parentId/executionMode/acceptanceCriteria） |
| `kanban:updateTask(id, patch)` | invoke | 编辑卡片（标题/描述/标签/优先级/截止/验收标准） |
| `kanban:deleteTask(id)` | invoke | 删除卡片（父卡级联删子任务） |
| `kanban:moveTask(id, targetColumnId)` | invoke | 状态流转（含 Blocked 进出；父卡默认聚合推导，人工移动可覆盖，冲突弹窗可强制通过） |
| `kanban:updateColumn(boardId, columnId, patch)` | invoke | 列配置（新增/重命名/排序/改色/隐藏/删除） |
| `kanban:setExecutionMode(taskId, { mode, acceptanceCriteria })` | invoke | 执行模式配置（auto 门控校验在主进程） |
| `kanban:addComment(taskId, { content, attachments[] })` | invoke | 追加评论（manual 模式结果回填） |
| `kanban:deleteComment(taskId, commentId)` | invoke | 删除评论（附件一并删除） |
| `kanban:executeTask(id)` | invoke | 触发 agent 执行（受 executionMode 门控；P1） |
| `kanban:pauseExecution(id) / kanban:cancelExecution(id) / kanban:retryExecution(id)` | invoke | 执行干预（暂停/取消/重试，P1；干预动作写 timeline） |
| `kanban:onExecutionUpdate(cb)` | 事件 | 执行状态推送（P1，主进程单向） |
| `kanban:exportBoard() / kanban:importBoard()` | invoke | 导出/导入（P2） |

### 7.3 userData 存储路径

- 看板数据：`<userData>/kanban/boards.json`（JSON 单文件，原子写）。
- 执行输出：`<userData>/kanban/executions/e_<uuid>.log`（完整输出，可选落盘）。
- 评论附件：`<userData>/kanban/attachments/<timelineId>/<file>`。
- **附件上限设置项**：`maxAttachmentSizeMB`（默认 10，可改）进 SettingsProvider（`<userData>/settings.json`，沿用 M1 设置页模式），看板附件上传时读取校验。
- **并行上限设置项**：`maxParallelTasks`（默认 5，可改）进 SettingsProvider，并行执行时并发任务数上限（O-9 定案）。
- 与 M1 既有目录（`logs/`、`settings.json`、`dsh/` overlay）平级，互不干扰；**不触碰 DSH_HOME**（CON-R002）。

### 7.4 ExecutionProvider 抽象层（定案）与 dsh agent 接入实现链

> 依据 deepseek-harness 官方能力：ACP 协议（7.1）、Goals/Todos/Workflows（7.3）、`ctx.tools.register` 自定义工具、`harness.handle` / `host.call` IPC。实现期以官方 API 实测为准（风险 R1）。

**ExecutionProvider 接口（TS 契约，壳内抽象层）**——看板数据模型与执行协议解耦，换实现零数据改动：

```ts
// 执行提供方抽象：默认 ACP host / 备选 --patch 插件 / 兜底 CLI headless 均实现此接口
interface ExecutionProvider {
  execute(
    task: {
      taskId: string;
      ac: { what: string; expected: string; verify: string; context?: string };
      agentSpec?: { provider?: string; agent?: string; model?: string }; // M2 默认不指定
    },
    handlers: {
      onEvent: (ev: ExecutionEvent) => void;   // 流式事件（进度/工具调用/文本块）
      onStatus: (s: ExecutionStatus) => void;  // 状态变更（queued/running/paused/cancelled/failed/succeeded）
      onResult: (r: ExecutionResult) => void;  // 最终结果（exitCode/摘要/输出引用）
    },
  ): { cancel(): Promise<void> };
}

type ExecutionStatus = 'queued' | 'running' | 'paused' | 'cancelled' | 'failed' | 'succeeded';
type ExecutionEvent =
  | { kind: 'text_chunk'; text: string }          // agent_message_chunk（仅已提交文本）
  | { kind: 'tool_call'; name: string; args: unknown }
  | { kind: 'permission_request'; id: string; message: string }; // session/request_permission 机器审批
```

**实现链（优先级定案）**：

1. **默认实现：ACP host（定案默认）**——壳 spawn dsh ACP 子进程（JSON-RPC over stdio）：
   - 发起：`newSession(cwd)` + `prompt`（文本 + 资源引用）携带 taskId + AC；取消：`session/cancel`；流式：`agent_message_chunk`（仅已提交文本）；机器审批：`session/request_permission`。
   - 局限（deepwiki 官方事实）：无会话加载/恢复/列表、无图片/音频、无推理/工具实时视图。
   - 暂停：ACP 无暂停语义 → 降级为"标记暂停 + 结果丢弃保留现场"（O-11 定案）；取消走 `session/cancel`。
2. **备选实现：--patch 插件工具**——插件随壳分发（O-5 定案），注册 `hull.kanban.execute` 工具（`ctx.tools.register`），agent 执行中可查/回写看板（`harness.handle` / `host.call` IPC）；职责窄：接收任务 → 调 dsh agent → 回传结果。
3. **兜底实现：dsh CLI headless**——壳 spawn `dsh run <prompt>`，解析 stdout/退出码回写；无事件流（仅开始/结束），暂停/取消降级为 kill 进程。

```ts
// 备选实现插件契约（dsh 侧，TS 模块导出 apply + name）
export const name = 'hull-kanban-executor';
export function apply(ctx: Context) {
  ctx.tools.register('hull.kanban.execute', {
    description: '执行看板任务',
    input: {
      taskId: 'string',
      prompt: 'string',
      acceptanceCriteria: 'object?',   // auto 模式附带（what/expected/verify/context），供 agent 执行后自验
    },
    async run(input, session) {
      const result = await runAgentTask(input.prompt, input.acceptanceCriteria);
      await ctx.host.call('hull:executionResult', {
        taskId: input.taskId,
        status: result.ok ? 'succeeded' : 'failed',
        exitCode: result.exitCode,
        resultSummary: summarize(result.output),
      });
      return result;
    },
  });
}
```

**壳侧统一流程**：`kanban:executeTask` → 主进程按 executionMode 校验（auto 需 AC 必填项完整）→ 经 ExecutionProvider 下发（默认 ACP → 备选插件 → 兜底 CLI）→ 事件/状态/结果回传 → 壳写时间线（manual 追加评论 / auto 写 execution 记录 + 自动流转到 Verify）→ 推送 `kanban:onExecutionUpdate`。

**独立成插件影响分析（结论）**：

- ACP 与独立插件**不冲突**：ACP 是壳侧直连通道，独立插件是 dsh 内部实现——两者可并存，按可用性切换。
- 独立发布时：ExecutionProvider 换为**进程内 `ctx.agents` 实现**（事件全量），接口与数据模型**零改动**（解耦收益）。
- 数据迁移：独立插件场景下看板数据仍在壳 userData，迁移靠 FR-16 导出/导入兜底。
- **当前最优方案**：壳内看板 + ExecutionProvider 抽象 + ACP 默认实现 + 数据模型与执行协议解耦；独立插件发布留 §12 后续规划（O-5 定案）。

- 失败路径：通道不可用/执行超时 → 卡片时间线追加 failed 记录 + 错误信息；看板本体不受影响。

## 8. 非功能需求

| 项 | 要求 |
|---|---|
| 平台 | 仅打包 macOS Apple Silicon（延续 M1）；代码跨平台友好 |
| 性能 | 看板视图切换 < 300ms；boards.json ≤ 5MB 时加载 < 500ms；CRUD 操作即时响应（本地写，防抖 500ms） |
| 安全 | 看板数据仅存 userData（不触 DSH_HOME）；preload 桥固定白名单；执行通道经 §7.4 ExecutionProvider（ACP/插件/CLI），壳不直接操作 dsh 内部 |
| 稳定性 | 数据原子写，任何写失败不破坏现有数据；损坏文件自动备份重建；schema 版本 + 迁移 |
| 交互语义 | 人工移动（菜单/拖拽）最高优先级、直接生效，系统不自动矫正（永不覆盖人工状态）；冲突场景弹窗确认可强制通过 |
| 兼容 | 与 dsh 升级/回滚正交——看板数据不依赖 dsh 版本；dsh 升级期间看板可用（执行功能禁用） |

## 9. 异常与边界

| 场景 | 行为 |
|---|---|
| boards.json 损坏/解析失败 | 备份为 `boards.json.corrupt-<ts>` → 重建默认看板 → 提示用户 |
| schema version 不兼容 | 跑迁移函数；迁移失败 → 备份 + 重建（同损坏兜底） |
| 磁盘写失败（只读/满） | 提示错误；内存态保留，下次成功写重试 |
| 附件文件缺失 | 评论显示"附件缺失"占位，不阻塞看板 |
| 附件超限（> maxAttachmentSizeMB） | 拒绝上传并提示（设置项可调） |
| 执行中用户暂停/取消 | 经通道中断（ACP `session/cancel` / CLI kill）；中断动作写入 timeline（type: system, source.type: user） |
| 拖拽与执行状态冲突（拖到 Done 但执行中/未执行；父卡拖 Done 但子任务未完成） | 确认弹窗（可强制通过）；执行不终止，列以人工为准（标注"执行完成，列由人工指定"） |
| 删除含时间线的卡片 | 确认提示（时间线记录 + 附件文件一并删除） |
| dsh 未就绪时点「执行」 | 按钮禁用 + 提示"dsh 未就绪" |
| 执行中 dsh 升级/重启 | 执行记录标记 failed（"dsh 已重启"）；看板数据不受影响 |
| 执行超时 | 插件侧超时（默认 30min）→ 标记 failed + 超时信息 |
| 双实例 | 沿用 M1 单实例锁，无新增 |
| 看板视图与官方 view 切换 | 复用 S8 D6 主进程驱动语义，renderer 无 view 控制通道 |

## 10. 依赖与风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| R1 dsh 接入通道能力不足（ACP/插件 API 不稳定，M2 实现期验证） | agent 执行集成受阻 | 实现链降级（§7.4：ACP → 插件 → CLI → 手动搬运）；看板本体不受影响 |
| R2 看板数据迁移（M2 内 schema 演进） | 旧数据不兼容 | `version` 字段 + 迁移函数；损坏备份重建（§9） |
| R3 dsh 升级/回滚与执行通道兼容 | 插件随 dsh 版本失效 | 插件随壳分发（--patch 注入，O-5 定案）；升级后回归验证执行通道 |
| R4 执行输出过大 | 磁盘占用/内存 | 输出摘要截断（默认 4KB）+ 完整输出落盘可选；滚动清理旧执行日志 |
| R5 看板数据无加密（本地明文 JSON） | 敏感任务描述泄露（本机） | 已定案（O-3）：M2 接受（本地单用户场景）；同步/云协作场景重新评估 + SQLite |
| R6 子任务聚合规则边界（Blocked 与自定义列交互） | 父卡状态推导错误 | 聚合收敛为单一函数 + 状态推导单测覆盖（FR-7 验收） |

## 11. 开放问题

### 11.1 已定案（O-1~O-11，用户评审确认）

| 编号 | 问题 | 结论 |
|:-----|:-----|:-----|
| O-1 | agent 执行的任务粒度：整卡执行 vs 卡片内拆子任务/步骤执行？ | **定案：子任务拆解**——任务可拆分子任务，多个子 agent 协调完成（串行执行，见 O-7）；数据模型 `task.parentId` + 父状态聚合（FR-7/FR-8） |
| O-2 | 执行结果回写方式：自动流转列 vs 仅记录结果、列流转手动？ | **定案：执行模式开关（manual/auto）**——manual：结果以评论回填、列流转手动；auto：验收标准必填、验证通过自动写执行记录 + 流转（FR-6/FR-9/FR-11） |
| O-3 | 看板数据是否加密？ | **定案：不加密 + JSON 存储**——单文件 boards.json + schema 版本 + 原子写 + 损坏备份重建；选型理由见 §5；SQLite 待同步/云协作场景再评估 |
| O-4 | 多设备同步（看板数据跨设备）？ | **定案：M2 不做**——移入 §12 后续规划；P2 导出/导入（FR-16）为过渡方案 |
| O-5 | 插件发布渠道：随壳分发 vs 独立发布？ | **定案：随壳分发**——`--patch` 注入零配置；独立发布留 §12 后续规划 |
| O-6 | auto 模式验证通过后的流转目标：Verify vs Done？ | **定案：Verify（人工复核）**——与 O-2 人工把关一致；Done 需人工确认（FR-11） |
| O-7 | 父任务执行策略：子任务串行 vs 并行？ | **定案：默认串行**——逐步验证哲学 + 依赖天然满足 + 失败定位准；并行需显式声明无依赖才可（P2，FR-11） |
| O-8 | 评论附件存储：大小上限与保留策略？ | **定案：配置化**——设置项 `maxAttachmentSizeMB` 默认 10 可改；随评论/卡片删除级联清理磁盘文件（FR-9/§7.3） |
| O-9 | 并行执行（P2）的依赖声明方式与并发上限？ | **定案：配置化**——显式声明"无依赖"才可并行；并发上限 = 设置项 `maxParallelTasks`（默认 5，可改）；并行属 P2 增强，M2 默认串行（FR-11/§7.3） |
| O-10 | ACP headless 任务的会话/模型选择？ | **定案：agentSpec 进 schema，功能排后**——M2 默认不指定（走 dsh 默认会话）；任务级指定 agent/模型为未来迭代（UI 预留，标注 P1/P2）；数据结构留位、功能排后（§5/FR-11） |
| O-11 | ACP 协议对暂停/取消/中断的支持程度？ | **定案：支持 session/cancel**——取消走 `session/cancel`；暂停无原生语义 → 降级为"标记暂停 + 结果丢弃保留现场"（FR-11/§7.4） |

### 11.2 未决项

无未决项——O-1~O-11 全部定案（见 11.1）。

## 12. 后续规划（M2 不做）

> 优先级：P1 = 下期优先承接；P2 = 增强。触发条件明确后启动。文档头"遗留待办"清单引用本节。

| 项 | 优先级 | 说明 | 触发条件 |
|:---|:-------|:-----|:---------|
| agentSpec 任务级指定（provider/agent/model 选择 UI） | P1 | 数据结构已入 schema 留位（O-10 定案），补 UI 与执行层透传 | 多 agent 平台接入 |
| 多 agent 平台接入（provider 抽象落地） | P1 | ExecutionProvider 已抽象（§7.4），provider 字段预留 | 接入第二个平台 |
| 并行增强（依赖图可视化） | P2 | 并行执行基础已定（O-9：显式声明无依赖 + maxParallelTasks=5） | ~~并行执行实际使用后~~ 已完成（2026-09-02 承接，t100108） |
| 多设备同步 | P2 | 看板数据跨设备（O-4 定案） | P2 导出/导入（FR-16）为过渡方案 |
| 数据加密 / SQLite 迁移 | P2 | 云协作或多用户场景（O-3 定案） | 出现同步/云协作需求时评估 SQLite + 加密 |
| 插件独立发布 | P2 | 用户自装插件、脱离壳分发（O-5 定案） | ExecutionProvider 换进程内 ctx.agents 实现（§7.4 影响分析）；插件 API 稳定后提供独立安装包/发布渠道 |
| 多人协作/权限 | P2 | 团队共享看板 | 依赖同步方案 |

## 13. M2 完成定义（Done of Done）

- [ ] 看板导航入口激活：点击进入看板视图，与官方 UI 切换正常（FR-1）
- [ ] 看板核心可用：6 态模板列 + 列自定义 + 卡片 CRUD + 状态流转（含人工拖拽语义）+ 持久化（FR-2~FR-5）
- [ ] 执行模式可用：manual 默认 + auto 验收标准门控（what/expected/verify 强校验 + context 提示）+ 持久化（FR-6）
- [ ] 子任务闭环：子任务管理 + 双向导航 + 父卡聚合视图（跨列进度条/展开列表/父引用徽标/子卡跨列独立显示）（FR-7/FR-8）
- [ ] 评论与执行记录：统一时间线 + source 来源区分（agentId/provider）+ manual 结果回填 + 附件（上限配置化）（FR-9）
- [ ] 任务详情可用：描述/标签/优先级/截止（FR-10）
- [ ] agent 执行闭环：执行 → 状态视图 → 结果回写（manual 评论 / auto 记录+流转到 Verify；串行调度 + 并行上限 + 生命周期状态机 + 人工干预 + 执行中 AC 修订，经 §7.4 ExecutionProvider）（FR-11/FR-12）
- [ ] P2 项按进度交付（拖拽/筛选/多看板/导出导入，FR-13~FR-16）
- [ ] 数据安全：JSON 单文件 + 原子写 + 损坏备份重建 + schema 版本；不触 DSH_HOME
- [ ] 开放问题 O-1~O-11 全部定案并回写 PRD（无未决项）
- [ ] 文档头"遗留待办"清单与 §12 后续规划一致（agentSpec 指定 / 多平台接入 / 并行增强）
- [ ] README 更新「功能状态」；PRD 各验收项有对应测试用例