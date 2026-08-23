# T2 startDate 字段 + schema v2 迁移 实现记录

- 契约：docs/api/feishu-t2-kanban-timeline-api-contract.md（增量契约，4 MODIFIED，无新增 IPC channel）
- 共识：docs/spec/共识-Hull桌面壳-M2看板时间线.md（CON-R-timeline-003/004/007 + Q-051/Q-052）
- 设计：docs/design/T2-startDate迁移-kanban-timeline-design.md（D1~D3 冻结）
- 判级：**复杂**（schema 数据迁移 + 契约变更）
- 交付时间：2026-08-23

## 技术方案对照（D1~D3 全落地）

| 决策 | 冻结方案 | 落地证据 |
|---|---|---|
| D1 | startDate = date-only `string \| null`（与 dueDate 同型，非 datetime/时间戳） | types.ts `Task.startDate: string \| null`；isValidDateOnly 格式正则 + Date 回读 toISOString 比对双检（拒 2026-02-30 类日历不存在日期） |
| D2 | 主进程权威归一化：写入侧非法串→null 不拒绝；读取侧脏数据归一化不阻塞加载 | normalizeStartDate（写入严格形态）+ coerceStartDate（读取宽松形态），均在 KanbanStore；renderer 仅友好预校验 |
| D3 | 既有 migrate() 链扩展 v1→v2 + 失败 backupAndRebuild 静默兜底（零新机制） | load() version 门控分支既有（version<current 进 migrate / >current 兜底），bump KANBAN_SCHEMA_VERSION 即自动激活 |

## 变更清单

| 文件 | 变更 |
|---|---|
| src/kanban/types.ts | `KANBAN_SCHEMA_VERSION` 1→2；`Task.startDate: string \| null`（dueDate 同型位，注释标 T2 契约 FR-3/Q-052） |
| src/kanban/KanbanStore.ts | `CreateTaskInput`/`UpdateTaskPatch` 增 `startDate?`；新增模块级 `isValidDateOnly`；新增 `normalizeStartDate`（写入侧权威归一化）+ `coerceStartDate`（读取侧宽松归一化）；createTask 组装补 `startDate: this.normalizeStartDate(input.startDate ?? null)`；updateTask 白名单补 `if (patch.startDate !== undefined)` 分支；`migrate()` 补 v1→v2 transform；`load()` v2 直载路径补任务级 coerce 循环（T2-9） |
| src/exec/Convergence.test.ts、src/exec/ExecutionEngineClose.test.ts、src/exec/VerifyGate.test.ts、src/exec/scheduler/Scheduler.test.ts、src/kanban/KanbanStore.b5.test.ts、src/kanban/KanbanStore.b5-roundtrip.test.ts | 手工 Task 夹具补 `startDate: null`（TS 类型完备性适配，共 6 文件） |
| src/kanban/KanbanStore.test.ts | 新增 T2 describe 共 **10 用例**（映射见下） |

preload / IPC 层 / renderer 零改动（见契约变更传播节；renderer 日历消费 startDate 归 T1 承接）。

## 关键实现

### migrate() v1→v2（CON-R-timeline-004 / Q-051）

- **三层遍历** boards[]→columns[]→tasks[]：columns 层显式不动（迁移只加任务字段），tasks 层为每任务补 startDate。
- **幂等双保险**：
  1. version 门控——load 路径仅 `version < KANBAN_SCHEMA_VERSION` 才进 migrate，v2 文件重复加载根本不触发 transform；
  2. 任务级守卫——`t.startDate === undefined ? null : this.coerceStartDate(t.startDate)`，已含 startDate 的任务原样跳过（含显式 null 不覆盖已有值）；脏值归一化 null 后再次执行仍 null。
- **只加不动**：深拷贝后仅动 startDate 与 version 两处，timeline/execution 记录零触碰（FR-4/R2）。
- **失败兜底两形态**：load 路径 migrate 抛错被捕获 → `backupAndRebuild()`（原文件 rename 为 `boards.json.corrupt-<ts>` 内容完整保留 + warn 日志 + 重建默认看板，renderer 无错误码静默恢复，与 B1 K4/K6 现行为一致）；migrate() 直调 / B5 导入校验路径抛 `store-migrate-failed` 错误码可见。version>2 同走兜底/拒绝两形态。
- **B5 复用**：importVersionOlder 校验复用同一 migrate——v1 导入包自动升 v2（P2-B5-2），导入链路行为变化由 b5/b5-roundtrip 既有用例全量回归覆盖。

### 归一化双形态（D2 主进程权威）

- `normalizeStartDate`（写入侧，createTask/updateTask）：null 合法直通；非 string/null 类型 → `validation-error` 拒绝（编程错误要拒，field=startDate 经 message 标识）；string 但非合法 YYYY-MM-DD → 归一化 null 不拒绝（数据错误要容错，CON-R-timeline-007）。
- `coerceStartDate`（读取侧，load v2 直载 + migrate 两路径共用）：任何非法输入置 null，永不抛错不阻塞加载（T2-9）。
- `isValidDateOnly`：`^\d{4}-\d{2}-\d{2}$` 格式 + `new Date(s+'T00:00:00Z')` 回读 toISOString 比对，拒格式对但日历不存在的滚转日期。

## 契约变更传播（Q-052 三处核验）

| 处 | 结论 |
|---|---|
| B1 契约 | 增量以 T2 契约登记（4 MODIFIED：createTask/updateTask 请求 + Task Schema + version）；B1 文件同步编辑经 change-propagation 登记（变更摘要-M2看板 Q-052 条目「本条即登记」），文件级落地待传播执行（见偏差 2） |
| preload | **零改动**——bridge createTask/updateTask 入参声明 `unknown` 透传（src/preload/index.ts:126-127），无逐字段类型镜像需同步 |
| IPC 校验 | **零改动**——KanbanIpc handler 类型化直传 store（CreateTaskInput/UpdateTaskPatch），权威校验落 KanbanStore.normalizeStartDate，IPC 层无逐字段校验面 |

## 测试

### KanbanStore.test.ts T2 describe 10 用例 ↔ 契约场景映射

| 用例 | 覆盖 |
|---|---|
| T2-1 v1 数据迁移成功：全任务补 startDate=null、version 升 2、落盘 v2、零丢失 | V1 / 验收① |
| T2-2 迁移幂等：重复 migrate 无 diff，已有 startDate 原样跳过 | V2 / 验收① |
| T2-3 迁移失败兜底：备份 corrupt-\<ts\> + 重建默认看板（load 路径静默恢复） | 失败兜底 |
| T2-4 version 过新：corrupt 备份保留原数据 + 默认看板重建，无错误码返回 | V3 |
| T2-5/6 createTask startDate：带值持久化重启保持 + 不传向后兼容 null | 验收②③ |
| T2-7/8 updateTask startDate：设/清生效 + 不传保持 + updatedAt 刷新 | 验收②③ |
| T2-9 脏数据读取归一化：startDate:"not-a-date" 加载置 null，其余任务正常 | CON-R-timeline-007 / T2-9 |
| T2-10 startDate>dueDate 照存：存储层不校验不报错 | 契约字段说明（展示层以 dueDate 为准归 T1） |
| T2-11 类型错误拒参：createTask/updateTask startDate 非 string\|null → validation-error | 异常表 |
| T2-13 非法日期串归一化：createTask/updateTask 非法串 → 响应与落盘均 null | D2 写入容错 |

（编号无 T2-12：契约场景表无对应项，未虚设用例。）

### 验证结果

| 项 | 结果 |
|---|---|
| T2 单测 | KanbanStore.test.ts T2 describe **10 用例全绿** |
| 全量单测 `npm run test:unit` | **573/573 pass，0 fail**（本记录交付时实测复核） |
| integration `npm run test:integration` | **8/8 pass** |

## 偏差记录

1. **validation-error field 形态**：契约异常表写「field=startDate」，HullError 无 field 属性——field 经 message 标识（`startDate 类型非法（须为 string|null）`），与既有 validation-error 抛错形态对齐，语义等价。
2. **B1 契约文件尚未实际写入 startDate**：Q-052 传播已在变更摘要-M2看板登记（「本条即登记」），但 feishu-b1-m2-kanban-api-contract.md 文件级同步编辑待 change-propagation 落地执行；当前字段事实源 = T2 增量契约。

## 核验记录

（留空待核验）
