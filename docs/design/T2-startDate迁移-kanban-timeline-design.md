# T2 startDate 字段 + schema v2 迁移 技术方案

> 工作项：T2 startDate 字段 + schema v2 迁移（M2 看板时间线共识 §14.1，飞书 dsh-hull-desktop 清单，bda6a7df-327c-462d-b459-c5d25ff7bc34）
> 状态：**frozen（评审通过·冻结，可进实现）**
> 评审：自查评审通过（2026-08-23，solo 自查：方案按共识 v1.2 + 冻结契约产出，无 P0/P1 残留；架构决策与契约/共识一致）
> 版本：0.1 · 2026-08-23
> 事实源：契约 `docs/api/feishu-t2-kanban-timeline-api-contract.md` v0.1（冻结，对 B1 契约的增量契约）；共识 `docs/spec/共识-Hull桌面壳-M2看板时间线.md` v1.2（§14.1 子需求清单 + §5.2 迁移流程 + §7 字段定义 + CON-R-timeline-003/004/007 + Q-051/052）；PRD `docs/prd/2026-08-22-kanban-timeline-prd.md` v0.2（FR-3/FR-4）；格式与工程基线参照 `docs/design/S1-扫描搜索-skills-design.md`
> 判级：**复杂**。理由：schema v1→v2 数据迁移（三层遍历 / 幂等 / 失败兜底）叠加 startDate 契约变更传播（B1 契约 + preload 类型 + IPC 校验三处同步，Q-052）——判级矩阵「数据迁移 + 契约变更」，跨数据层与契约面。

---

## 1. 背景与范围

**定位**：T2 交付看板数据层增量——Task 新增可空字段 `startDate`（计划开始日期，ISO YYYY-MM-DD，与 dueDate 同型）+ `KANBAN_SCHEMA_VERSION` 1→2 迁移函数 + createTask/updateTask 可选参数扩展（向后兼容）+ 契约三处同步传播。UI 层（详情面板日期选择器、日历区间消费）归 T1 承接，本工作项只约束数据层读写语义。

**规则绑定**：CON-R-timeline-003（字段新增 + 契约变更传播 Q-052）、CON-R-timeline-004（schema v2 迁移三层遍历/幂等/失败兜底 Q-051）、CON-R-timeline-007（边界容错——存储层照存 `startDate > dueDate` 不校验；非法日期串归一化置 null 不阻塞加载）。

**范围**（契约 §范围，冻结）：
- Task Schema 增量：`startDate`（string|null，ISO 日期字符串，默认 null）
- `KANBAN_SCHEMA_VERSION` 1→2 + migrate() v1→v2 transform（三层遍历 / 幂等 / 失败兜底）
- createTask/updateTask 请求增加可选 `startDate` 参数（部分更新语义：不传=不变；显式 null=清空）
- preload 类型镜像 + IPC 入参校验同步（Q-052）
- B1 契约 change-propagation 同步 + 变更摘要-M2看板 登记

**非目标**（契约 §非目标）：时间线/日历视图渲染（T1）；视图持久化 localStorage（T1）；duration/endDate 字段（U-3 定案不新增）；拖拽改期（U-4 定案不做）；HullSettings schema 变更 / 新增 IPC channel（零新增）。

**交付验收**：契约测试场景 T2-1~T2-13（迁移成功/幂等/失败兜底/version 过新/读写向后兼容/脏数据归一化/类型拒参/三处同步对照）+ 迁移验证场景 V1~V3。

**范围剪裁说明（YAGNI）**：不做 `startDate > dueDate` 存储层校验（共识定案为展示层行为，存储层照存原值——把校验放错层会拒掉合法数据）；不引日期库（手写正则 + Date 回读校验即足）；非法串「读取时置 null」而非「写入时拒绝」（兼容历史脏数据不阻塞加载，CON-R-timeline-007）。

---

## 2. 架构决策（含备选）

### D1 startDate 字段位置与类型：date-only string|null vs datetime 串 vs 数值时间戳

- **A**：Task 增可空 `startDate: string | null`（ISO YYYY-MM-DD，与 dueDate 同型同轨，types.ts dueDate 行相邻位）
- **B**：完整 ISO datetime 串（含时分秒）
- **C**：epoch 数值时间戳 → **选 A**

理由：日历粒度够（PRD FR-3 计划开始日期无时分语义）；与 dueDate 同型 → 校验/渲染逻辑同轨复用（T1 日历解析一套 date-only 工具函数吃两个字段）；U-3 已定案不新增 duration/endDate，区间 = startDate→dueDate 两点即足。datetime 串引入时区歧义（date-only 串 `new Date()` 解析 UTC 偏移问题已在 T1 契约显式约束本地构造），徒增复杂度；数值时间戳可读性差且 boards.json 手工排查困难。

### D2 校验归属：主进程权威归一化 vs 双端强校验 vs renderer 权威

- **A**：主进程 KanbanStore 权威——写入侧（createTask/updateTask）string 但非合法 YYYY-MM-DD → 归一化存 null 不拒绝（仅非 string/null 类型拒 `validation-error` field=startDate）；加载/migrate 读取侧脏数据同样归一化置 null 不阻塞加载；renderer 仅友好预校验
- **B**：IPC 层拒绝一切非法日期串
- **C**：renderer 校验为主 → **选 A**

理由：契约复核 MEDIUM 已定案（Q-052）。历史脏数据（手工编辑 boards.json / 旧版导入）不能阻塞加载（CON-R-timeline-007）——B 方案会把「格式错的合法结构」变成整库不可用；renderer 校验可被绕过（IPC 直调），权威必须在数据层。类型错误（number/boolean 等）仍走既有 validation-error 通道（field=startDate，T2-11），与「非法串容错」分层：**类型是编程错误要拒绝，值是数据错误要容错**。

### D3 迁移策略：migrate() 链内 v1→v2 transform + 失败静默兜底 vs 独立迁移脚本 vs 读取时惰性补字段

- **A**：既有 migrate() 链扩展 v1→v2（boards[]→columns[]→tasks[] 三层遍历补 `startDate: null`，幂等）；失败走 backupAndRebuild 静默兜底（备份 `boards.json.corrupt-<ts>` + 重建默认看板，load 路径 renderer 无错误码）
- **B**：一次性独立迁移脚本/命令
- **C**：不迁移，读取时惰性补默认值（`t.startDate ?? null`）→ **选 A**

理由：CON-R-timeline-004/Q-051 冻结。KanbanStore.load() 的 version<current / version>current 分支已存在（src/kanban/KanbanStore.ts:172/:182），bump 常量即自动激活迁移与兜底两条路径，**零新机制**；C 方案内存态可用但落盘文件永远停留 v1，version 门控失效（未来 v3 迁移无法判定起点），且 B5 导入校验依赖显式版本语义；B 方案多一个维护面无收益。幂等双保险见 §4.2。失败兜底对齐 B1 实际行为（T2 契约 HIGH 复核修正）：load 路径 backupAndRebuild 静默恢复无错误码；`store-migrate-failed` 仅 migrate() 直调 / B5 导入校验路径可见。

---

## 3. 模块划分

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `src/kanban/types.ts` | `KANBAN_SCHEMA_VERSION` 1→2（现 :7）；`Task` 增 `startDate: string \| null`（dueDate :102 相邻位） | — | MODIFIED #3/#4 |
| `src/kanban/KanbanStore.ts` | `CreateTaskInput`/`UpdateTaskPatch` 增 `startDate?`（:52-64/:67-77）；`normalizeStartDate` 归一化助手（写入严格/读取宽松两形态）；createTask 组装补 `startDate`（:351 dueDate 同型位）；updateTask 白名单补 `if (patch.startDate !== undefined)`（:376 同型）；migrate() 补 v1→v2 transform（:206-214） | types | 全部 |
| `src/preload/index.ts` | window.kanban createTask/updateTask 入参类型镜像同步（:94-95 JSDoc 注释对齐契约；桥本身透传 unknown 无运行时改动） | — | MODIFIED #1/#2 |
| `src/shared/ipc-channels.ts` | **无变化**（channel 名不变，仅入参 schema 扩展；白名单纪律确认项，P2-5） | — | 零新增通道 |
| `docs/api/feishu-b1-m2-kanban-api-contract.md` | change-propagation 同步（Task Schema 加 startDate + createTask/updateTask 参数说明）+ 变更摘要-M2看板 登记 | T2 契约 | Q-052 协调事项 |

**依赖方向**：单向 `KanbanStore → types`；preload 仅类型镜像；无环。

**接入点（既有代码改动面，最小化）**：
- 无新 IPC channel、无 WindowManager/shell.html/renderer 改动（T2 纯数据层 + 契约面）
- KanbanIpc 入参校验：随 store 归一化语义自然生效（channel/handler 注册不动）

---

## 4. 关键机制实现形态

### 4.1 migrate() 链扩展形态

```ts
// KanbanStore.migrate()（现 :206-214 占位形态 → v1→v2 落地）
migrate(data: KanbanData): KanbanData {
  // 既有浅拷贝保留（boards/tasks 一层拷贝，迁移只写拷贝不动原对象）
  const current = { ...data, boards: data.boards.map((b) => ({ ...b, tasks: b.tasks.map((t) => ({ ...t })) })) };
  if (current.version < 2) {
    for (const b of current.boards) {          // 第 1 层：boards[]
      // 第 2 层 columns[] 不动（迁移只加任务字段）
      for (const t of b.tasks) {               // 第 3 层：tasks[]
        t.startDate = t.startDate === undefined ? null : this.coerceStartDate(t.startDate);
      }
    }
    current.version = 2;
  }
  if (current.version > KANBAN_SCHEMA_VERSION) {
    throw new HullError(ERR.migrateFailed, `boards.json version ${current.version} 高于当前 schema`);
  }
  current.version = KANBAN_SCHEMA_VERSION;
  return current;
}
```

- 三层遍历语义：columns 层无需写操作，遍历表达层级完整性（未来列级迁移有挂载点）；全量覆盖无任务遗漏（V1 场景断言任务数/timeline 条目数与注入一致）
- coerceStartDate（读取宽松形态）：非 YYYY-MM-DD 或 Date 回读 NaN → null，永不抛错（T2-9 脏数据不阻塞加载）

### 4.2 幂等设计（双保险）

1. **version 门控**：load 路径 `version < KANBAN_SCHEMA_VERSION` 才进 migrate（:172）——v2 文件重复加载根本不触发 transform（V2/T2-2）
2. **任务级守卫**：transform 内 `t.startDate === undefined ? null : coerce(...)`——已含 startDate 的任务原样跳过（含显式 null，不覆盖已有值）；脏值归一化幂等（非法串 → null 后再次执行仍 null）

重复执行结果 = 数据无 diff（T2-2 断言），不报错不重复加。

### 4.3 原子性（只加不动 + 失败兜底）

- **只加字段不动存量**：除新增 startDate 与 version 外，任何字段（含 timeline/execution 记录/columns/order）一律不改（契约行为点「只加不动」，R2）
- **成功路径**：load 路径迁移成功后既有 `this.flushNow()` 立即原子落盘 v2（temp+rename，:176）——不等防抖，防迁移后崩溃丢版本号
- **失败路径**（load）：migrate 抛错被 load 捕获（:178-180）→ `backupAndRebuild()`：原文件 rename 为 `boards.json.corrupt-<ts>`（内容完整保留于备份）+ warn 日志 + 重建默认看板；**renderer 收到默认看板数据 + 壳层状态提示，无 IPC 错误码返回**（静默恢复，与 B1 K4/K6 现行为一致，T2-3/T2-4/V3 断言口径）
- **直调路径**：migrate() 直调 / B5 importVersionOlder 校验路径抛 `store-migrate-failed`（:209-211 既有分支，bump 后自动覆盖 version>2 情形）

### 4.4 写入侧接线（createTask/updateTask）

```ts
// createTask 组装（:351 dueDate 同型位）
dueDate: input.dueDate ?? null,
startDate: this.normalizeStartDate(input.startDate ?? null),

// updateTask 白名单（:376 同型）
if (patch.startDate !== undefined) task.startDate = this.normalizeStartDate(patch.startDate);

// normalizeStartDate（写入严格形态）
normalizeStartDate(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new HullError(ERR.validation, 'startDate 类型非法'); // field=startDate（T2-11）
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00`).getTime()) ? v : null; // 非法串归一化 null（T2-13）
}
```

- 部分更新语义：不传（undefined）= 不变（T2-8）；显式 null = 清空（T2-7）——与 dueDate 完全同轨
- `startDate > dueDate` 存储层照存原值不报错（T2-10），展示层以 dueDate 为准单日显示（T1 渲染行为）
- startDate 编辑不追加 system 时间线事件（纯字段编辑，契约 updateTask 成功响应注记）

---

## 5. 工程基线

**判级**：复杂（头部一致）。

| 项 | 现状 | T2 动作 |
|---|---|---|
| git | ✅（M1/M2 全程使用） | 直接复用 |
| 脚手架 | ✅（package.json：tsc 构建 dist/main + preload） | 直接复用，`src/kanban/` 内扩展 |
| 测试框架 | ✅（node:test 单测 co-located，KanbanStore.test.ts / b5.test.ts 已有大量用例） | 复用框架，**新增**：迁移幂等（V1/V2/T2-1/T2-2）/ 失败兜底（T2-3/T2-4：corrupt-<ts> 生成 + 默认看板重建 + 无错误码）/ startDate 读写（T2-5~T2-8 含向后兼容）/ 非法值归一化（T2-9/T2-13）+ 类型拒参（T2-11）/ version 过新（V3） |

**技术栈决策**：跟随 M2 既有栈——TypeScript（tsc）+ node:test，**不引入新依赖**（不引日期库，手写正则 + Date 回读校验）。测试走 KanbanStore 构造注入临时目录先例（userDataPath 注入），flushSync() 断言落盘。

---

## 6. 目录/工程结构

```
src/kanban/                           # T2 全部改动收敛于此（+ 契约/preload 两处镜像）
├── types.ts                          # KANBAN_SCHEMA_VERSION 1→2；Task.startDate
├── KanbanStore.ts                    # CreateTaskInput/UpdateTaskPatch + normalizeStartDate
│                                     #   + createTask/updateTask 接线 + migrate() v1→v2
├── KanbanIpc.ts                      # 无 channel 变化（入参经 store 归一化语义自然生效）
└── KanbanStore.test.ts               # +迁移/幂等/兜底/读写/归一化 用例（node:test co-located）
src/preload/index.ts                  # createTask/updateTask 入参类型注释镜像（:94-95）
docs/api/feishu-b1-m2-kanban-api-contract.md  # change-propagation 同步 + 变更摘要登记
```

> userData 写面不变（仍 `<userData>/kanban/boards.json` 单文件）；`.corrupt-<ts>` 备份沿用既有机制，无新增文件类型。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| 契约变更传播漏改（B1 契约 / preload 类型 / IPC 校验三处不同步） | 双事实源漂移，后续模块按旧 Schema 实现回归 | T2-12 对照检查场景固化进测试清单；change-propagation 登记变更摘要-M2看板；字段唯一事实源仍在 B1 契约（T2 契约只登记增量） | T2 |
| B5 导入回归破坏（importVersionOlder 复用 migrate，v1 导入自动升 v2） | 导入链路行为变化未被发现 | B5 既有导入用例全量回归（b5.test.ts/b5-roundtrip.test.ts）；新增 v1 导入升 v2 断言；导入校验路径 store-migrate-failed 语义不变 | T2 |
| 用户降级旧版 Hull 读 v2 文件 | 旧代码 version>1 → backupAndRebuild，用户看到空看板（数据实际完整保留于 .corrupt-<ts> 备份） | 与任意 schema bump 同语义（不支持降级）；备份文件可手工恢复；发布说明标注；不做双向兼容迁移（YAGNI） | T2 |
| 迁移中途崩溃（flushNow 前） | 文件停留 v1 但内存已迁移 | flushNow 原子写（temp+rename）保证落盘要么 v1 要么 v2 无中间态；下次启动重新迁移（幂等保证无损） | T2 |
| 非法日期串误拒导致加载阻塞 | 整库不可用 | 读取侧宽松归一化永不抛错（coerceStartDate）；仅类型错误走 validation-error；T2-9/T2-13 断言 | T2 |

---

## 8. 核验记录（交付核验时填写）

| 项 | 结果 |
|:---|:-----|
| 状态 | draft（评审通过后置 frozen，评审记录在此留痕：评审人/机制 + 日期 + 结论） |
| 实现偏离 | —（实现 vs 方案，交付核验时填；有意偏离更新本方案+记录理由，架构级偏离回 draft 重评） |
