# B5 实现记录与核验记录

> 判级：常规（依赖 B1 数据层已有原子写能力，扩展即可；无独立进程/状态机/跨子系统）
> 事实源：契约 `docs/api/feishu-b5-m2-kanban-api-contract.md` v0.2（冻结）、共识 v1.4、CON-R017/R024/R033

## 实现记录

### 文件清单（src 4 文件 + 2 装配点）

| 文件 | 职责 |
|---|---|
| `src/kanban/KanbanStore.ts` | B5 扩展：新增 6 方法（exportSnapshot/importData/validateImportData/remapMerge/applyData/backupPreimport）+ 2 私有校验器（validateBoardsStructure/validateImportedTask）+ snapshot()/getDataDir()（传输层依赖） |
| `src/kanban/KanbanTransfer.ts` | **新增**薄层文件 IO：导出快照序列化 → 保存对话框 → 原子写（temp+rename）；导入读文件 → JSON 解析 → 委托 store.importData；electron dialog 懒加载 + 依赖注入（可单测）；exportFileName 默认名 `<name>.kanban.json` |
| `src/kanban/KanbanIpc.ts` | **+2 通道** kanban:exportBoard / kanban:importBoard（KANBAN_IPC_CHANNELS 16→18）；registerKanbanIpcWithTransfer 支持 transfer 注入 |
| `src/shared/ipc-channels.ts` | channel 白名单常量源 +2（kanban:exportBoard/importBoard） |
| `src/preload/index.ts` | `window.kanban` 桥 +2 原语：exportBoard(boardId?)/importBoard(filePath, mode) |
| `src/main/index.ts` | 装配：registerKanbanIpc(kanbanStore) 内部构造 KanbanTransfer（默认 electron dialog + store.getDataDir()） |

### TDD：26 用例（B5 新增），核心路径全测

> 任务口径「33 用例」与实测不符——`node --test` 实测 `dist/kanban/KanbanStore.b5.test.js` = **26 pass**（文件内 26 个 `test()` 块）。

| 覆盖方向 | 用例数 | 场景（对照契约 X 场景） |
|---|---|---|
| 导出成功 | 4 | X1 全看板快照（含归档/附件引用/深拷贝）、X2 单看板 scope=board、X1b 导出文件生成 + ExportResult counts、exportFileName 清洗 |
| 导出取消/失败 | 3 | X5 取消 {cancelled:true} 无文件、X6 boardId 不存在 export-not-found + 格式非法 validation-error、X7 路径不可写 export-io-error |
| 导入损坏/版本 | 4 | X10 非法 JSON import-invalid-json、X11 缺 version/boards import-corrupt、X12 版本过新 import-version-newer、X13 版本过旧复用 B1 migrate() 成功 |
| 导入字段/结构非法 | 4 | X15 auto 缺 AC validation-error、X16 columnId 指向不存在列、X16b parentId 指向不存在任务、X18 附件超限（CON-R024） |
| 合并/替换应用 | 3 | X8 merge 追加保留原 id（ids.preserved）、X9 replace 整文件替换 + 备份生成、X20 mode 非法 import-mode-invalid |
| 合并重映射 | 2 | X17 冲突板重 id + 内部引用（parentId/dependencies/列/timeline）重映射 + ids.regenerated、X23 重映射后重申 B1 校验拒绝（P1-B5-1） |
| 跨源引用拒绝 | 2 | X22 引用现有任务 id 拒绝、X22b dependencies 指向现有任务拒绝（P0-B5-1） |
| 还原/可用性/零改动 | 4 | X3/X4 导出还原（归档/附件引用保留，二进制缺失按占位不阻塞）、X21 导入后 CRUD/归档保留、校验失败 flushSync 后 boards.json 零改动、replace 备份失败 store-io-error 原数据不破坏 |

### 质量

- `npm run typecheck`（tsc --noEmit）：干净
- `npm run test:unit`：443 pass / 0 fail（含 B5 26 + B1 31 + 存量）
- `npm run test:integration`：8 pass / 0 fail

## 实现偏离

| 偏离点 | 契约约定 | 实现实际 | 影响 |
|---|---|---|---|
| B1 无独立 schema 校验器 | 复用 B1 schema 校验（协调事项「已定」） | B1 校验逻辑内聚于 store 各写入原语，无独立可调用校验器 → B5 在 store 内实现 validateBoardsStructure（结构/引用完整性）/ validateImportedTask（字段规则对齐 types.ts + 附件上限 CON-R024） | 无漂移：字段规则与 B1 写入路径一致（同 ERR.validation），契约「单一事实源」意图保持 |
| 跨现有看板引用范围 | 契约 P0-B5-1「跨现有看板引用一律拒绝」 | 收敛为**只查任务/timeline id**（parentId/dependencies/currentExecutionId）；**columnId 不查**——结构校验已保证指向文件内列，模板列 id（c_todo 等）为全看板共享约定非跨板引用 | 与 X22 语义一致；模板列不误伤 |
| replace 备份文件名 | `boards.preimport-<ts>.json`（契约 §落盘） | `${filePath}.preimport-${ts}` = **`boards.json.preimport-<ts>`**（boards.json + 后缀，与 B1 损坏备份 boards.json.corrupt-<ts> 同前缀体系） | 仅命名差异；测试断言 `boards.json.preimport-` 前缀 |
| X14（import-version-older） | 契约 X14 联调场景 | **不可达**：B1 migrate() 对过旧版本恒成功（无操作 bump 到当前，X13 覆盖）；错误码为未来迁移链预留的防御分支（test 文件 ponytail 注记） | 无功能缺口 |
| 导出默认文件名 | 契约未指定 | `<boardName|kanban-boards>.kanban.json`（exportFileName，非法字符清洗） | 补充决策，无冲突 |

## 🔴-1 修复（oracle 战略 review B5 高优）

- **问题**：B3 markSucceeded 不清 currentExecutionId（值 `e_<seq>`，Q-023 记录追溯）；旧 validateBoardsStructure 强制 currentExecutionId 指向文件内 timeline（tl_ 系）→ 任何 succeeded 任务导出再导入必失败。B5 fixture 全 `currentExecutionId: null`，round-trip 盲点。
- **修复（轨 1 宽松化）**：currentExecutionId 校验降级——null 合法；非空仅格式校验（`/^(e_|tl_)/`，与 B3 e_<seq> / B1 tl_<uuid> 对齐）；**不再要求**指向文件内 timeline 条目。同步 validateBoardsStructure + validateImportData 跨板引用检查（currentExecutionId 不再查）。remapMerge 对 e_ 值原样保留（不在 tlMap 中）。
- **修复（轨 2 测试）**：新增 `src/kanban/KanbanStore.b5-roundtrip.test.ts`（co-located，6 用例）：R1 succeeded+currentExecutionId 导出/替换导入保留、R1b merge 保留、R2 archivedAt 保留、R3 dependencies 保留且指向文件内同父 id、R4 e_ 指向不存在 timeline id 宽松化接受、R4b 格式非法仍拒绝（宽松化边界 + 零改动）。
- **修复（轨 3 文档）**：本段 + M2-交付核验.md B5 结论同步。
- **验证**：`npm run typecheck` 干净；`npm test` 全绿（unit 449 + integration 8，较基线 443+8 净增 6 round-trip 用例）。

## 核验记录

### Code Review / Semgrep

- 本轮为纯文档记录，未重跑 review/semgrep（实现已完成并经既有管道）
- Semgrep：实现落盘于既有 21 文件扫描范围，无新增风险模式

### 契约符合性（X 场景对照，P0-B5-1/P1-B5-1 落地）

| 验收点 | 契约要求 | 单元级证据 | 状态 |
|---|---|---|---|
| P0-B5-1 先校验后重映射 | 校验阶段在原始 id 空间执行；跨现有看板引用一律 validation-error | validateImportData：结构校验 → 字段校验 → 跨源引用拒绝均先于 remapMerge；X22/X22b | ✓ |
| P1-B5-1 重映射后再校验 | merge 重映射后重申 B1 完整校验 | importData merge 分支 remapMerge 后调 validateBoardsStructure；X23 | ✓ |
| 导出格式 = 裸快照 | {version, boards[]}，含归档/附件引用 | exportSnapshot + X1/X1b/X2 | ✓ |
| 校验链完整 | 文件内部引用 → 结构 → 字段 → 附件上限 | validateBoardsStructure + validateImportedTask；X15/X16/X16b/X18 | ✓ |
| 归档完整性保留 | archivedAt/archivedFromColumnId 随导入完整保留 | X3/X4/X21 | ✓ |
| 校验失败零改动 | 任何校验失败现有数据零改动 | importData 校验失败抛错不触 applyData；flushSync 落盘断言；X10/X15/X22 | ✓ |
| 原子应用 | 导入两段式，失败不破坏原数据 | applyData temp+rename（复用 flushNow）+ 失败回滚内存态；replace 备份失败拒绝 | ✓ |
| 合并幂等语义 | 非幂等，每次合并追加 | 契约既定；X8 | ✓ |
| 附件上限 | size ≤ maxAttachmentSizeMB（默认 10） | validateImportedTask；X18 | ✓ |

### 测试覆盖缺口（登记）

- X19（replace 应用写失败 → store-io-error 原数据不破坏）：错误码路径由 B1 flushNow 既有用例覆盖；B5 侧仅测了**备份失败**路径，applyData 写失败回滚无专属用例（实现存在，applyData catch 回滚 this.data=prev）
- X24（replace 失败后备份可手动还原）：备份生成已验证（X9/备份失败拒绝），手动还原流程未自动化

### 风险登记

- 🟡-C：X19/X24 应用写失败回滚与备份还原无 B5 专属单测（复用 B1 flushNow 错误路径；applyData 回滚逻辑简单，风险低）
- 🟢-D：merge 重映射对**全部内部 id**（含非冲突板外引用）重生成，性能随板规模线性；M2 规模无瓶颈
- 🟢-E：导出文件含附件/execution 引用不含二进制（契约非目标，P2 增强项）；换机还原需另行拷贝
