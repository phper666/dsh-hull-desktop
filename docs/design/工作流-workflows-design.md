# 工作流（Workflows）技术方案

> 判级：**复杂**（新子系统：执行引擎 + 持久化 + 视图 + 菜单）→ 本文档
> 需求（用户 2026-08-31）：壳新增「工作流」菜单（设置之前），壳可配置工作流实现业务；**dsh + 面板（看板）加入工作流**。先调研后实现。

## 一、市场调研结论

- **n8n**：trigger → 顺序 action 节点（400+ connectors），节点式画布；sequential processing 简化数据流
- **Dify**：AI 原生编排（LLM pipeline），节点式
- **Zapier/Make**：trigger → action 模板化，连接器生态
- **共性提炼**：①触发器启动流 ②动作节点顺序执行 ③连接器承载集成 ④运行日志/重试
- 对 Hull 的取舍：不做可视化画布（体量过大），v1 采用 **「顺序步骤列表」编辑器**（GitHub Actions steps 同构）——够用、可控、留画布演进空间

## 二、v1 范围与模型

```
WorkflowDef { id, name, enabled, steps: WorkflowStep[] }
WorkflowStep { id, type, config }
WorkflowRun { id, workflowId, startedAt, finishedAt, status: running|success|failed, log[] }
```

- **触发**：v1 手动运行（工作流列表「运行」按钮）；定时（cron）/事件触发（dsh 事件）排 v2
- **步骤类型 v1**（WORKFLOW_STEP_TYPES 注册表，加类型 = 加处理器）：
  | type | 说明 | 依赖 |
  |:-----|:-----|:-----|
  | dsh-card | 看板建卡 + 可选立即派发执行（**dsh+面板联动**） | KanbanStore + ExecutionEngine |
  | http | 任意 webhook/API 调用（通用集成底座） | fetch |
  | notification | 系统通知 | Electron Notification |
  | delay | 延时 N 秒 | — |
- **执行语义**：顺序执行、单步失败即中止（fail-fast）、每步独立日志（ok/message/耗时）、运行记录 upsert 持久化（最近 50 条）
- **dsh+面板联动**：`dsh-card` 步骤 = KanbanStore.createTask（可带 labels/priority）→ `execute=true` 时 ExecutionEngine.executeTask 派发——工作流产出的任务直接进看板并由 dsh 执行

## 三、架构

```
src/workflows/
  types.ts            # 类型与步骤注册表
  WorkflowStore.ts    # workflows.json + runs.json（upsert，≤50 环形裁剪）
  WorkflowEngine.ts   # 顺序执行器（依赖 DI：store/kanban/exec/notify）
  WorkflowIpc.ts      # workflows:list/get/save/delete/run/runs
```

- 引擎 DI 最小接口（WorkflowStoreShape）避免与 KanbanStore 双向耦合；notify 注入 Electron Notification
- IPC：`workflows:*` 六原语；preload `window.workflows` 桥 + `hull.showWorkflows`

## 四、UI

- 导航「工作流」在工作台连接之后、设置之前
- 列表：卡片（名称/启用开关/步骤数/最近运行状态 + 运行/编辑/删除）
- 编辑器：名称 + 步骤列表（类型下拉 → 按 type 渲染配置表单；上移/下移/删除）+ 保存；运行结果 toast + 运行记录段
- 步骤配置表单按 type 渲染（dsh-card 的看板下拉复用 window.kanban.getBoards）

## 五、风险与回退

| 风险 | 缓解 |
|:-----|:-----|
| 步骤执行阻塞 UI | 引擎在 main 异步执行；渲染层轮询/最终结果返回 |
| dsh 未就绪时派发失败 | executeTask 返回 ok:false → 步骤 fail-fast 记录 |
| 运行日志膨胀 | ≤50 条环形裁剪 |

## 六、v2 规划

定时触发（cron）、事件触发（dsh 生命周期事件）、步骤间变量模板（`{{steps.1.output}}`）、工作台连接联动步骤（发短信/邮件）、可视化画布。
